import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { SrtEntry } from '../../src/types';
import type { AISettings } from '../../src/types/ai';
import type { DirectorPlan, ProjectProductionState } from '../../src/types/director';
import type { KacutClip, KacutLibraryDigest } from '../../src/types/footage';
import type { ProjectData } from '../../src/lib/project-persistence';
import {
  getKacutLibraryDigest,
  isRetryableKacutError,
  searchKacutClips,
} from '../footage/kacut-client';
import {
  buildDirectorPlanFromAgentDraft,
  validateShowDirectorDraft,
  type DirectorAgentCandidate,
  type DirectorDraftIssue,
  type DirectorMaterialSearchAudit,
  type ShowDirectorDraft,
  type ShowDirectorSegmentDraft,
} from './contract';

export const SHOW_DIRECTOR_TOOL_NAMES = [
  'director_get_context',
  'director_search_materials',
  'director_inspect_material',
  'director_initialize_working_draft',
  'director_patch_working_segments',
  'director_read_working_draft',
  'director_validate_working_draft',
  'director_submit_working_draft',
  'director_validate_draft',
  'director_submit_draft',
] as const;

const WORKING_SEGMENT_BATCH_SIZE = 8;
const WORKING_SEGMENT_PAGE_SIZE = 8;
const WORKING_SEGMENT_MAX_PAGE_SIZE = 16;
const WORKING_DRAFT_CHECKPOINT_VERSION = 3;
const WORKING_DRAFT_CHECKPOINT_FILE = 'director-working-draft.json';

const RenderStrategySchema = Type.Union([
  Type.Literal('motion-card'),
  Type.Literal('standalone-media'),
  Type.Literal('agent-composite'),
]);
const TransitionSchema = Type.Union([
  Type.Literal('crossfade'),
  Type.Literal('hard-cut'),
  Type.Literal('push'),
  Type.Literal('wipe'),
  Type.Literal('match-cut'),
]);
const FallbackPolicySchema = Type.Union([
  Type.Literal('standalone-media'),
  Type.Literal('motion'),
  Type.Literal('block'),
]);
const AssetChoiceSchema = Type.Object({
  candidateId: Type.String({ description: 'search_materials 返回的 candidateId' }),
  usage: Type.Union([Type.Literal('required'), Type.Literal('optional')]),
  trimStartMs: Type.Optional(Type.Number({ minimum: 0 })),
  reason: Type.String({ minLength: 1, description: '结合代表帧说明可见内容、媒介角色与非误导边界' }),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});
const RejectedAssetSchema = Type.Object({
  candidateId: Type.String(),
  reason: Type.String({ minLength: 1 }),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});
const CompositionIntentSchema = Type.Object({
  narrativeGoal: Type.String({ minLength: 1 }),
  focalPriority: Type.String({ minLength: 1 }),
  temporalRelationship: Type.String({ minLength: 1 }),
  mustShow: Type.Array(Type.String()),
  avoid: Type.Array(Type.String()),
});
const FallbackDecisionSchema = Type.Object({
  from: Type.Union([Type.Literal('agent-composite'), Type.Literal('standalone-media')]),
  to: Type.Union([Type.Literal('motion-card'), Type.Literal('standalone-media')]),
  reason: Type.String({ minLength: 1 }),
  explicit: Type.Literal(true),
});
const SegmentSchema = Type.Object({
  key: Type.String({ minLength: 1, description: '草案内唯一镜头 key' }),
  firstEntryIndex: Type.Integer({ description: '首条字幕 entry.index' }),
  lastEntryIndex: Type.Integer({ description: '末条字幕 entry.index，必须连续覆盖且不得重叠' }),
  title: Type.String({ minLength: 1 }),
  summary: Type.String({ minLength: 1 }),
  semanticType: Type.Union([
    Type.Literal('data'), Type.Literal('explanation'), Type.Literal('chapter-transition'),
    Type.Literal('quote'), Type.Literal('narration'),
  ]),
  complexityLevel: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
  visualizationScore: Type.Number({ minimum: 0, maximum: 100 }),
  pacingNeed: Type.Union([Type.Literal('steady'), Type.Literal('accent'), Type.Literal('transition')]),
  keywords: Type.Array(Type.String()),
  entities: Type.Array(Type.String()),
  enabled: Type.Boolean(),
  purpose: Type.Union([
    Type.Literal('context'), Type.Literal('explain'), Type.Literal('compare'), Type.Literal('evidence'),
    Type.Literal('emphasis'), Type.Literal('transition'), Type.Literal('breath'),
  ]),
  carrier: Type.String({ minLength: 1 }),
  intensity: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
  renderStrategy: RenderStrategySchema,
  visualType: Type.Optional(Type.Union([Type.Literal('motion'), Type.Literal('image'), Type.Literal('footage')])),
  composition: Type.Optional(Type.Union([
    Type.Literal('graphic'), Type.Literal('full-bleed'), Type.Literal('media-window'), Type.Literal('split'),
  ])),
  cameraMove: Type.Optional(Type.Union([
    Type.Literal('static'), Type.Literal('push-in'), Type.Literal('pull-out'), Type.Literal('pan-left'),
    Type.Literal('pan-right'), Type.Literal('tracking'),
  ])),
  mediaRole: Type.Optional(Type.Union([
    Type.Literal('evidence'), Type.Literal('context'), Type.Literal('emotion'), Type.Literal('demonstration'),
  ])),
  transition: Type.Optional(TransitionSchema),
  footageQuery: Type.Optional(Type.String()),
  fallbackPolicy: Type.Optional(FallbackPolicySchema),
  compositionIntent: Type.Optional(CompositionIntentSchema),
  selectedAssets: Type.Optional(Type.Array(AssetChoiceSchema)),
  rejectedAssets: Type.Optional(Type.Array(RejectedAssetSchema)),
  strategyReason: Type.String({ minLength: 1 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  mediaIndispensability: Type.Optional(Type.String()),
  graphicsIndispensability: Type.Optional(Type.String()),
  strategyStatus: Type.Optional(Type.Union([
    Type.Literal('ready'), Type.Literal('blocked'), Type.Literal('fallback'),
  ])),
  blockedReason: Type.Optional(Type.String()),
  fallbackDecision: Type.Optional(FallbackDecisionSchema),
});
const DirectorDraftHeaderProperties = {
  title: Type.String({ minLength: 1, description: '作品标题；封面标题必须逐字一致' }),
  summary: Type.String({ minLength: 1, description: '作品简介' }),
  keywords: Type.Array(Type.String(), { minItems: 1 }),
  globalPrompt: Type.Optional(Type.String()),
  coverDirection: Type.Object({
    prompt: Type.String({ minLength: 1 }),
    composition: Type.String({ minLength: 1 }),
    mood: Type.Optional(Type.String()),
    typography: Type.Optional(Type.String()),
    negativeConstraints: Type.Optional(Type.String()),
  }),
  audioDirection: Type.Object({
    bgmEnabled: Type.Optional(Type.Boolean()),
    soundEffectsEnabled: Type.Optional(Type.Boolean()),
    bgmStyle: Type.String({ minLength: 1 }),
    energy: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    soundDensity: Type.Union([Type.Literal('quiet'), Type.Literal('balanced'), Type.Literal('active')]),
  }),
  visualThesis: Type.String({ minLength: 1 }),
  rhythmDensity: Type.Union([Type.Literal('quiet'), Type.Literal('balanced'), Type.Literal('dense')]),
  styleRules: Type.Object({
    paletteUse: Type.String({ minLength: 1 }),
    typographyUse: Type.String({ minLength: 1 }),
    recurringMotif: Type.Optional(Type.String()),
  }),
  defaultTransition: TransitionSchema,
  matchCuts: Type.Array(Type.Object({
    fromKey: Type.String(),
    toKey: Type.String(),
    motif: Type.String({ minLength: 1 }),
  })),
  zeroCompositeReason: Type.Optional(Type.String()),
  warnings: Type.Optional(Type.Array(Type.String())),
} as const;
const DirectorDraftHeaderSchema = Type.Object(DirectorDraftHeaderProperties);
const DirectorDraftSchema = Type.Object({
  ...DirectorDraftHeaderProperties,
  segments: Type.Array(SegmentSchema, { minItems: 1 }),
});

interface PlanningRevisionSnapshot {
  draftRevision: number | null;
  approvedRevision: number | null;
  productionUpdatedAt: number | null;
}

interface WorkingDraftCheckpoint {
  version: number;
  revision: number;
  transcriptFingerprint: string;
  existingPlanRevision: number | null;
  existingPlanUpdatedAt: number | null;
  workingHeader: Omit<ShowDirectorDraft, 'segments'> | null;
  workingSegments: ShowDirectorSegmentDraft[];
  candidates: DirectorAgentCandidate[];
  materialSearches: DirectorMaterialSearchAudit[];
  workingVersion: number;
  updatedAt: number;
}

export interface ShowDirectorToolRuntimeOptions {
  entries: SrtEntry[];
  settings: AISettings;
  project: ProjectData;
  projectDir: string;
  revision: number;
  globalPrompt?: string;
  existingPlan?: DirectorPlan | null;
  ffmpegPath?: string | null;
  roleVersion: string;
  workflowVersion: string;
  snapshot: PlanningRevisionSnapshot;
  loadProduction: () => Promise<ProjectProductionState | undefined>;
  persistDraft: (plan: DirectorPlan, snapshot: PlanningRevisionSnapshot) => Promise<void>;
  onToolCall?: (name: string, detail?: Record<string, unknown>) => void;
}

export interface ShowDirectorToolRuntime {
  tools: ToolDefinition[];
  candidates: Map<string, DirectorAgentCandidate>;
  getSubmittedPlan: () => DirectorPlan | null;
  getToolCallCount: () => number;
  getRepairRounds: () => number;
  getWorkingDraftStatus: () => {
    initialized: boolean;
    workingVersion: number;
    validated: boolean;
    segmentCount: number;
    firstEntryIndex: number | null;
    lastEntryIndex: number | null;
    expectedEntryCount: number;
    candidateCount: number;
    inspectedCandidateCount: number;
    materialSearchAttempts?: number;
    materialSearchFailures?: number;
  };
  dispose: () => Promise<void>;
}

function textResult(value: unknown, terminate = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    details: value,
    ...(terminate ? { terminate: true } : {}),
  };
}

function checkpointPath(projectDir: string): string {
  return path.join(projectDir, '.lingji', WORKING_DRAFT_CHECKPOINT_FILE);
}

function transcriptFingerprint(entries: SrtEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(`${entry.index}\u0000${entry.startMs}\u0000${entry.endMs}\u0000${entry.text}\u0001`);
  }
  return hash.digest('hex');
}

function checkpointMatches(
  value: WorkingDraftCheckpoint,
  options: Pick<ShowDirectorToolRuntimeOptions, 'revision' | 'entries' | 'existingPlan'>,
): boolean {
  return value.version === WORKING_DRAFT_CHECKPOINT_VERSION
    && value.revision === options.revision
    && value.transcriptFingerprint === transcriptFingerprint(options.entries)
    && value.existingPlanRevision === (options.existingPlan?.revision ?? null)
    && value.existingPlanUpdatedAt === (options.existingPlan?.updatedAt ?? null);
}

async function readWorkingDraftCheckpoint(
  projectDir: string,
  options: Pick<ShowDirectorToolRuntimeOptions, 'revision' | 'entries' | 'existingPlan'>,
): Promise<WorkingDraftCheckpoint | null> {
  const filePath = checkpointPath(projectDir);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8')) as WorkingDraftCheckpoint;
    if (
      !parsed
      || typeof parsed !== 'object'
      || !Array.isArray(parsed.workingSegments)
      || !Array.isArray(parsed.candidates)
      || !Array.isArray(parsed.materialSearches)
      || !checkpointMatches(parsed, options)
    ) {
      await fs.rm(filePath, { force: true });
      return null;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await fs.rm(filePath, { force: true }).catch(() => undefined);
    }
    return null;
  }
}

function imageMime(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  return 'image/png';
}

async function readImage(filePath: string): Promise<{ type: 'image'; data: string; mimeType: string } | null> {
  try {
    const bytes = await fs.readFile(filePath);
    if (bytes.length === 0 || bytes.length > 16 * 1024 * 1024) return null;
    return { type: 'image', data: bytes.toString('base64'), mimeType: imageMime(filePath) };
  } catch {
    return null;
  }
}

async function extractFrame(
  ffmpegPath: string,
  sourcePath: string,
  outputPath: string,
  positionSec: number,
  signal?: AbortSignal,
): Promise<boolean> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  return new Promise<boolean>((resolve) => {
    const child = spawn(ffmpegPath, [
      '-y', '-v', 'error', '-ss', Math.max(0, positionSec).toFixed(3), '-i', sourcePath,
      '-frames:v', '1', '-vf', 'scale=960:-2:force_original_aspect_ratio=decrease', '-q:v', '3', outputPath,
    ], { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(code === 0);
    });
  });
}

export function scopedDirectorCandidateId(shotKey: string, clipId: string): string {
  const scope = createHash('sha256').update(`${shotKey}\u0000${clipId}`).digest('hex').slice(0, 12);
  return `${clipId}--${scope}`;
}

function normalizeMaterialQuery(query: string): string {
  return query.trim().replace(/[，、；;|/]+/gu, ' ').replace(/\s+/gu, ' ');
}

function normalizeDirectorMaterialQueries(query: string, relatedQueries: readonly string[] = []): string[] {
  const queries: string[] = [];
  for (const value of [query, ...relatedQueries]) {
    const normalized = normalizeMaterialQuery(value);
    if (normalized && !queries.includes(normalized)) queries.push(normalized);
  }
  return queries.slice(0, 5);
}

function normalizeDirectorMaterialTags(tags: readonly string[] = []): string[] {
  const normalized: string[] = [];
  for (const value of tags) {
    const tag = value.trim().toLowerCase();
    if (tag && !normalized.includes(tag)) normalized.push(tag);
  }
  return normalized.slice(0, 6);
}

function publicCandidate(candidate: DirectorAgentCandidate) {
  const { clip } = candidate;
  return {
    candidateId: candidate.candidateId ?? clip.id,
    filename: clip.filename,
    kind: clip.kind,
    score: clip.score,
    reason: clip.reason,
    durationSec: clip.durationSec,
    matchedSegmentStart: clip.matchedSegmentStart,
    pixelWidth: clip.pixelWidth,
    pixelHeight: clip.pixelHeight,
    query: candidate.query,
    shotKey: candidate.shotKey,
    narrativeNeed: candidate.narrativeNeed,
    inspected: candidate.inspected,
  };
}

function existingPlanContext(plan: DirectorPlan | null | undefined) {
  if (!plan) return null;
  return {
    revision: plan.revision,
    title: plan.title,
    summary: plan.summary,
    zeroCompositeReason: plan.zeroCompositeReason,
    userLocks: plan.userLocks,
    coverDirection: plan.coverDirection,
    audioDirection: plan.audioDirection,
    segments: plan.segments.map((segment) => {
      const selectedAssets = segment.compositionAssets?.length
        ? segment.compositionAssets.map((item) => ({
            candidateId: item.asset.id,
            filename: item.asset.filename,
            kind: item.asset.kind,
            usage: item.usage,
          }))
        : segment.selectedFootage
          ? [{
              candidateId: segment.selectedFootage.id,
              filename: segment.selectedFootage.filename,
              kind: segment.selectedFootage.kind,
              usage: 'required' as const,
            }]
          : [];
      return {
        id: segment.id,
        title: segment.title,
        startMs: segment.startMs,
        endMs: segment.endMs,
        renderStrategy: segment.renderStrategy,
        selectedAssets,
        compositionIntent: segment.compositionIntent,
        rationale: segment.rationale,
        userLocks: segment.userLocks,
      };
    }),
  };
}

function revisionChanged(
  current: ProjectProductionState | undefined,
  snapshot: PlanningRevisionSnapshot,
): boolean {
  return (current?.draftPlan?.revision ?? null) !== snapshot.draftRevision
    || (current?.approvedPlan?.revision ?? null) !== snapshot.approvedRevision
    || (current?.updatedAt ?? null) !== snapshot.productionUpdatedAt;
}

function validationPayload(result: ReturnType<typeof validateShowDirectorDraft>) {
  return result.ok
    ? { ok: true, issueCount: 0 }
    : { ok: false, issueCount: result.issues.length, issues: result.issues };
}

export async function createShowDirectorTools(
  options: ShowDirectorToolRuntimeOptions,
): Promise<ShowDirectorToolRuntime> {
  // pi-coding-agent is ESM-only. Keep this runtime import dynamic so Electron's CJS main bundle
  // does not attempt to require the package during application startup.
  const { defineTool } = await import('@earendil-works/pi-coding-agent');
  const restoredCheckpoint = await readWorkingDraftCheckpoint(options.projectDir, options);
  const candidates = new Map<string, DirectorAgentCandidate>();
  for (const candidate of restoredCheckpoint?.candidates ?? []) {
    if (!candidate?.clip?.id || !candidate.clip.path) continue;
    const available = await fs.stat(candidate.clip.path).then((stat) => stat.isFile()).catch(() => false);
    if (!available) continue;
    const candidateId = candidate.candidateId
      ?? (candidate.shotKey ? scopedDirectorCandidateId(candidate.shotKey, candidate.clip.id) : candidate.clip.id);
    candidates.set(candidateId, { ...candidate, candidateId, inspected: false });
  }
  for (const segment of options.existingPlan?.segments ?? []) {
    const lockedAssets = segment.compositionAssets?.map((item) => item.asset)
      ?? (segment.selectedFootage ? [segment.selectedFootage] : []);
    for (const asset of lockedAssets) {
      candidates.set(asset.id, {
        candidateId: asset.id,
        clip: { ...asset, score: asset.score, path: asset.path },
        query: 'user-locked',
        inspected: true,
      });
    }
  }
  const previewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingji-show-director-'));
  let submittedPlan: DirectorPlan | null = null;
  let toolCallCount = 0;
  let repairRounds = 0;
  const materialSearches = [...(restoredCheckpoint?.materialSearches ?? [])];
  let materialSearchAttempts = materialSearches.length;
  let materialSearchFailures = materialSearches.filter((search) => search.errorCount > 0).length;
  let materialSearchQueue: Promise<void> = Promise.resolve();
  let checkpointWriteQueue: Promise<void> = Promise.resolve();
  let checkpointWriteSequence = 0;
  let digest: KacutLibraryDigest | null | undefined;
  let workingHeader: Omit<ShowDirectorDraft, 'segments'> | null = restoredCheckpoint?.workingHeader ?? null;
  const workingSegments = new Map<string, ShowDirectorSegmentDraft>(
    (restoredCheckpoint?.workingSegments ?? []).map((segment) => [segment.key, { ...segment }]),
  );
  let workingVersion = Math.max(0, restoredCheckpoint?.workingVersion ?? 0);
  let validatedWorkingVersion: number | null = null;
  const restoredFromCheckpoint = restoredCheckpoint !== null;
  const entryOrder = new Map(options.entries.map((entry, index) => [entry.index, index]));
  const call = (name: string, detail?: Record<string, unknown>) => {
    toolCallCount += 1;
    options.onToolCall?.(name, detail);
  };
  const enqueueMaterialSearch = <T>(task: () => Promise<T>): Promise<T> => {
    const result = materialSearchQueue.then(task, task);
    materialSearchQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const enqueueCheckpointWrite = <T>(task: () => Promise<T>): Promise<T> => {
    const result = checkpointWriteQueue.then(task, task);
    checkpointWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const draftValidationOptions = (): Parameters<typeof validateShowDirectorDraft>[1] => ({
    entries: options.entries,
    candidates,
    existingPlan: options.existingPlan,
    materialReview: {
      enabled: options.settings.kacut?.enabled === true,
      searchAttempts: materialSearchAttempts,
      searchFailures: materialSearchFailures,
      searches: materialSearches,
    },
  });
  const invalidateWorkingValidation = () => {
    workingVersion += 1;
    validatedWorkingVersion = null;
  };
  const orderedWorkingSegments = () => [...workingSegments.values()].sort((left, right) => {
    const leftStart = entryOrder.get(left.firstEntryIndex) ?? Number.MAX_SAFE_INTEGER;
    const rightStart = entryOrder.get(right.firstEntryIndex) ?? Number.MAX_SAFE_INTEGER;
    if (leftStart !== rightStart) return leftStart - rightStart;
    const leftEnd = entryOrder.get(left.lastEntryIndex) ?? Number.MAX_SAFE_INTEGER;
    const rightEnd = entryOrder.get(right.lastEntryIndex) ?? Number.MAX_SAFE_INTEGER;
    if (leftEnd !== rightEnd) return leftEnd - rightEnd;
    return left.key.localeCompare(right.key);
  });
  const assembleWorkingDraft = (): ShowDirectorDraft | null => workingHeader
    ? { ...workingHeader, segments: orderedWorkingSegments() }
    : null;
  const persistWorkingCheckpoint = async () => {
    const filePath = checkpointPath(options.projectDir);
    const checkpoint: WorkingDraftCheckpoint = {
      version: WORKING_DRAFT_CHECKPOINT_VERSION,
      revision: options.revision,
      transcriptFingerprint: transcriptFingerprint(options.entries),
      existingPlanRevision: options.existingPlan?.revision ?? null,
      existingPlanUpdatedAt: options.existingPlan?.updatedAt ?? null,
      workingHeader,
      workingSegments: orderedWorkingSegments(),
      candidates: [...candidates.values()],
      materialSearches,
      workingVersion,
      updatedAt: Date.now(),
    };
    const sequence = ++checkpointWriteSequence;
    return enqueueCheckpointWrite(async () => {
      const tempPath = `${filePath}.${process.pid}.${sequence}.tmp`;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      try {
        await fs.writeFile(tempPath, JSON.stringify(checkpoint), 'utf-8');
        try {
          await fs.rename(tempPath, filePath);
        } catch {
          await fs.rm(filePath, { force: true });
          await fs.rename(tempPath, filePath);
        }
      } finally {
        await fs.rm(tempPath, { force: true });
      }
    });
  };
  const clearWorkingCheckpoint = () => enqueueCheckpointWrite(
    () => fs.rm(checkpointPath(options.projectDir), { force: true }),
  );
  const persistValidatedDraft = async (draft: ShowDirectorDraft) => {
    const plan = buildDirectorPlanFromAgentDraft(draft, {
      entries: options.entries,
      revision: options.revision,
      globalPrompt: options.globalPrompt,
      stylePresetId: options.project.stylePresetId,
      candidates,
      existingPlan: options.existingPlan,
    });
    plan.agentPlanning = {
      roleVersion: options.roleVersion,
      workflowVersion: options.workflowVersion,
      completedAt: Date.now(),
      toolCalls: toolCallCount,
      repairRounds,
      materialSearches: materialSearchAttempts,
      materialSearchFailures,
      candidateCount: candidates.size,
      inspectedCandidateCount: [...candidates.values()].filter((candidate) => candidate.inspected).length,
    };
    await options.persistDraft(plan, options.snapshot);
    await clearWorkingCheckpoint();
    submittedPlan = plan;
    return textResult({
      ok: true,
      revision: plan.revision,
      title: plan.title,
      segmentCount: plan.segments.length,
      strategyCounts: plan.segments.reduce<Record<string, number>>((counts, segment) => {
        const strategy = segment.renderStrategy ?? 'motion-card';
        counts[strategy] = (counts[strategy] ?? 0) + 1;
        return counts;
      }, {}),
      blockedCount: plan.segments.filter((segment) => segment.strategyStatus === 'blocked').length,
      message: '导演草案已原子提交（尚未生成画面），等待用户批准后才能进入制作。',
    }, true);
  };

  const getContext = defineTool({
    name: 'director_get_context',
    label: '读取导演上下文',
    description: '读取本轮完整字幕、项目元信息、素材库摘要、现有导演方案与用户锁定项。规划开始时必须先调用。',
    parameters: Type.Object({}),
    async execute() {
      call('director_get_context');
      if (digest === undefined) {
        digest = options.settings.kacut?.enabled
          ? await getKacutLibraryDigest(options.settings.kacut.baseUrl).catch(() => null)
          : null;
      }
      return textResult({
        revision: options.revision,
        project: {
          title: options.project.meta?.title ?? options.project.publish?.title ?? '',
          publishDescription: options.project.publish?.desc ?? '',
          stylePresetId: options.project.stylePresetId,
        },
        globalPrompt: options.globalPrompt ?? '',
        transcript: options.entries.map((entry) => ({
          index: entry.index,
          startMs: entry.startMs,
          endMs: entry.endMs,
          text: entry.text,
        })),
        materialLibrary: digest,
        existingDraft: existingPlanContext(options.project.production?.draftPlan),
        approvedPlan: existingPlanContext(options.project.production?.approvedPlan),
        workingDraftCheckpoint: restoredFromCheckpoint ? {
          restored: true,
          workingVersion,
          segmentCount: workingSegments.size,
          validated: false,
          message: '已恢复未提交的工作草案。初始化头部时默认保留这些镜头，随后先分页读取并从当前版本继续，不要从头重做。',
        } : null,
        userLockRule: 'userLocks.strategy/assets/direction 为 true 的字段必须原样保留；不得以重新编排为由覆盖。',
      });
    },
  });

  const searchMaterials = defineTool({
    name: 'director_search_materials',
    label: '检索可信素材',
    description: '为指定镜头与叙事需求使用本机 KaCut MCP 素材库检索中文关键词。总导演 AI 从完整标签目录选择真实标签，再结合当前字幕实时提供查询；工具只负责标准化、去重、串行执行和审计。检索分只用于候选排序；采用必须基于后续画面检视。返回不含绝对路径的候选。',
    parameters: Type.Object({
      shotKey: Type.String({ minLength: 1, description: '工作草案中的镜头 key，用于追溯本次搜索服务哪个镜头' }),
      narrativeNeed: Type.String({ minLength: 1, description: '素材需要具体证明或呈现什么，不能只重复 query' }),
      selectedTags: Type.Optional(Type.Array(
        Type.String({ minLength: 1 }),
        {
          minItems: 1,
          maxItems: 6,
          description: 'AI 从 materialLibrary.sceneTagCatalog 选择的真实标签；旧素材服务回退使用 topSceneTags。不得编造目录外标签',
        },
      )),
      query: Type.String({ minLength: 1, description: 'AI 结合所选真实标签、当前字幕和镜头需求生成的首选中文检索词' }),
      relatedQueries: Type.Optional(Type.Array(
        Type.String({ minLength: 1 }),
        {
          minItems: 1,
          maxItems: 4,
          description: 'AI 根据当前字幕、实体、叙事需求和素材库场景标签实时生成的关联查询；不得使用程序预设词典',
        },
      )),
      kind: Type.Optional(Type.Union([Type.Literal('video'), Type.Literal('image'), Type.Literal('any')])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
    }),
    async execute(_toolCallId, params) {
      const selectedTags = normalizeDirectorMaterialTags(params.selectedTags);
      call('director_search_materials', {
        shotKeyChars: params.shotKey.length,
        narrativeNeedChars: params.narrativeNeed.length,
        queryChars: params.query.length,
        materialKind: params.kind ?? 'any',
        selectedTagCount: selectedTags.length,
        queryVariantCount: normalizeDirectorMaterialQueries(params.query, params.relatedQueries).length,
      });
      const kacut = options.settings.kacut;
      if (!kacut?.enabled) {
        return textResult({
          ok: false,
          outcome: 'fatal-error',
          code: 'kacut_disabled',
          candidateCount: 0,
          errorCount: 1,
          durationMs: 0,
          message: '本项目未启用 KaCut 素材库。不要伪造素材；对适合组合但缺素材的镜头使用 blocked 或显式 fallback。',
        });
      }
      const catalog = digest?.sceneTagCatalog?.length
        ? digest.sceneTagCatalog
        : digest?.topSceneTags ?? [];
      if (catalog.length > 0 && selectedTags.length === 0) {
        return textResult({
          ok: false,
          outcome: 'invalid-input',
          code: 'selected_tags_required',
          selectedTags,
          tagSource: digest?.sceneTagCatalog?.length ? 'sceneTagCatalog' : 'topSceneTags',
          candidateCount: 0,
          errorCount: 0,
          durationMs: 0,
          next: '先从 director_get_context 返回的真实标签目录选择 1-6 个 selectedTags，再生成并提交本镜头查询。',
        });
      }
      if (selectedTags.length > 0 && catalog.length > 0) {
        const availableTags = new Set(catalog.map((item) => item.tag.trim().toLowerCase()));
        const unknownTags = selectedTags.filter((tag) => !availableTags.has(tag));
        if (unknownTags.length > 0) {
          return textResult({
            ok: false,
            outcome: 'invalid-input',
            code: 'selected_tags_not_in_catalog',
            selectedTags,
            unknownTags,
            tagSource: digest?.sceneTagCatalog?.length ? 'sceneTagCatalog' : 'topSceneTags',
            candidateCount: 0,
            errorCount: 0,
            durationMs: 0,
            next: '从 director_get_context 返回的真实标签目录重新选择 selectedTags；不要编造标签，也不要让程序补同义词。',
          });
        }
      }
      return enqueueMaterialSearch(async () => {
        const startedAt = Date.now();
        materialSearchAttempts += 1;
        const kinds = params.kind && params.kind !== 'any' ? [params.kind] : ['video', 'image'] as const;
        const queriesTried: string[] = [];
        const completedKinds = new Set<'video' | 'image'>();
        const failures: Array<{
          query: string;
          kind: 'video' | 'image';
          message: string;
          retryable: boolean;
        }> = [];
        const unique = new Map<string, { clip: KacutClip; query: string }>();
        for (const query of normalizeDirectorMaterialQueries(params.query, params.relatedQueries)) {
          queriesTried.push(query);
          for (const kind of kinds) {
            try {
              const clips = await searchKacutClips(kacut.baseUrl, {
                query,
                kind,
                limit: params.limit ?? 8,
              });
              completedKinds.add(kind);
              for (const clip of clips) {
                if (clip.kind !== 'video' && clip.kind !== 'image') continue;
                const previous = unique.get(clip.id);
                if (!previous || clip.score > previous.clip.score) unique.set(clip.id, { clip, query });
              }
            } catch (reason) {
              failures.push({
                query,
                kind,
                message: reason instanceof Error ? reason.message : String(reason),
                retryable: isRetryableKacutError(reason),
              });
            }
          }
          if (failures.length > 0 || unique.size >= 4) break;
        }
        if (failures.length > 0) materialSearchFailures += 1;
        const ordered = [...unique.values()].sort((left, right) => right.clip.score - left.clip.score);
        for (const { clip, query } of ordered) {
          const candidateId = scopedDirectorCandidateId(params.shotKey, clip.id);
          const previous = candidates.get(candidateId);
          candidates.set(candidateId, {
            candidateId,
            clip,
            query,
            shotKey: params.shotKey,
            narrativeNeed: params.narrativeNeed,
            inspected: previous?.inspected ?? false,
          });
        }
        const successCount = completedKinds.size;
        const outcome = ordered.length > 0
          ? failures.length > 0 ? 'partial' : 'candidates'
          : failures.length === 0
            ? 'empty'
            : successCount > 0
              ? 'partial'
              : failures.every((failure) => failure.retryable)
                ? 'retryable-error'
                : 'fatal-error';
        const next = outcome === 'candidates'
          ? '按叙事相关性粗筛候选并调用 director_inspect_material 查看代表帧；分数高低都不能替代检视与采用理由。'
          : outcome === 'empty'
            ? '本次检索已成功完成但没有语义候选。请改用更具体的中文主体+动作+场景标签继续搜索。'
            : outcome === 'partial' && ordered.length > 0
              ? '部分媒介检索失败，但已有候选可用。先检视候选；仍缺关键媒介时，稍后串行重试失败的媒介。'
              : outcome === 'partial'
                ? '仅部分媒介完成且没有候选，不能据此判定素材为空或退回 Motion。稍后串行重试失败的媒介。'
                : outcome === 'retryable-error'
                  ? '素材服务暂时不可用，不能把本结果当成零候选。保留当前镜头的素材需求，完成其它工作后再串行重试同一 query 一次；重复失败则标记 blocked。'
                  : '素材服务返回不可恢复错误，不能把本结果当成零候选。保留镜头为 blocked，并在 blockedReason 记录错误与恢复条件。';
        materialSearches.push({
          shotKey: params.shotKey,
          query: params.query,
          ...(selectedTags.length > 0 ? { selectedTags } : {}),
          queriesTried,
          kinds: [...completedKinds],
          outcome,
          candidateCount: ordered.length,
          errorCount: failures.length,
        });
        await persistWorkingCheckpoint();
        return textResult({
          ok: outcome !== 'retryable-error' && outcome !== 'fatal-error',
          outcome,
          shotKey: params.shotKey,
          narrativeNeed: params.narrativeNeed,
          selectedTags,
          query: params.query,
          queriesTried,
          kinds: [...completedKinds],
          scoreUse: 'ranking-only',
          candidateCount: ordered.length,
          errorCount: failures.length,
          durationMs: Date.now() - startedAt,
          candidates: ordered.map(({ clip }) => publicCandidate(
            candidates.get(scopedDirectorCandidateId(params.shotKey, clip.id))!,
          )),
          errors: failures.map((failure) => failure.message),
          failures,
          next,
        });
      });
    },
  });

  const inspectMaterials = defineTool({
    name: 'director_inspect_material',
    label: '检视素材代表帧',
    description: '读取已搜索候选的真实图片或视频代表帧。选择任何素材前必须调用；仅凭文件名或分数不可采用。',
    parameters: Type.Object({
      candidateIds: Type.Array(Type.String(), { minItems: 1, maxItems: 2 }),
    }),
    async execute(_toolCallId, params, signal) {
      call('director_inspect_material', { count: params.candidateIds.length });
      const textItems: Array<Record<string, unknown>> = [];
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'image'; data: string; mimeType: string }
      > = [];
      for (const candidateId of params.candidateIds) {
        const candidate = candidates.get(candidateId);
        if (!candidate) {
          const item = { candidateId, ok: false, error: '候选不存在；请先调用 director_search_materials' };
          textItems.push(item);
          content.push({ type: 'text', text: JSON.stringify(item, null, 2) });
          continue;
        }
        const { clip } = candidate;
        const labels: string[] = [];
        const candidateImages: Array<{ type: 'image'; data: string; mimeType: string }> = [];
        if (clip.kind === 'image') {
          const image = await readImage(clip.path);
          if (image) {
            candidateImages.push(image);
            labels.push('图片原图');
          }
        } else if (clip.kind === 'video') {
          const positions = [
            Math.max(0, clip.matchedSegmentStart ?? 0),
            Math.max(0, (clip.matchedSegmentStart ?? 0) + Math.min(2, Math.max(0.5, (clip.durationSec ?? 4) / 2))),
          ];
          if (options.ffmpegPath) {
            for (let index = 0; index < positions.length; index += 1) {
              const output = path.join(previewDir, `${candidateId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${index}.jpg`);
              if (await extractFrame(options.ffmpegPath, clip.path, output, positions[index], signal)) {
                const image = await readImage(output);
                if (image) {
                  candidateImages.push(image);
                  labels.push(`视频代表帧 ${index + 1}/${positions.length} @ ${positions[index].toFixed(2)}s`);
                }
              }
            }
          }
          if (labels.length === 0 && clip.thumbnailFile) {
            const thumbnail = await readImage(clip.thumbnailFile);
            if (thumbnail) {
              candidateImages.push(thumbnail);
              labels.push('视频缩略帧');
            }
          }
        }
        candidate.inspected = labels.length > 0;
        const item = {
          ...publicCandidate(candidate),
          ok: candidate.inspected,
          imageLabels: labels,
          attachmentOrder: labels.map((label, index) => ({ attachment: index + 1, label })),
          instruction: candidate.inspected
            ? '下方图片附件只属于当前 candidateId，并与 attachmentOrder 顺序一致。请据此判断主体、构图、清晰度、真实性与叙事适配；在草案中写具体采用或淘汰理由。'
            : '无法取得可验证画面，禁止选择该素材。',
        };
        textItems.push(item);
        content.push({ type: 'text', text: JSON.stringify(item, null, 2) }, ...candidateImages);
      }
      await persistWorkingCheckpoint();
      return {
        content,
        details: {
          candidates: textItems,
          imageCount: content.filter((item) => item.type === 'image').length,
        },
      };
    },
  });

  const initializeWorkingDraft = defineTool({
    name: 'director_initialize_working_draft',
    label: '初始化工作草案',
    description: '写入不含 segments 的全片标题、简介、封面、声音和风格方向。长片默认先调用；再次调用可更新头部，除非 resetSegments=true，否则保留已分批写入的镜头。',
    parameters: Type.Object({
      header: DirectorDraftHeaderSchema,
      resetSegments: Type.Optional(Type.Boolean({ description: '明确重做分镜时才设为 true' })),
    }),
    async execute(_toolCallId, params) {
      call('director_initialize_working_draft', { resetSegments: params.resetSegments === true });
      const previousSegmentCount = workingSegments.size;
      if (params.resetSegments === true) workingSegments.clear();
      workingHeader = { ...params.header } as Omit<ShowDirectorDraft, 'segments'>;
      invalidateWorkingValidation();
      await persistWorkingCheckpoint();
      return textResult({
        ok: true,
        workingVersion,
        segmentCount: workingSegments.size,
        resetSegmentCount: params.resetSegments === true ? previousSegmentCount : 0,
        validationRequired: true,
        message: '分镜规划头部检查点已记录（仅草案，尚未生成画面）。请继续分批写入镜头，不要停下来向用户确认。',
      });
    },
  });

  const patchWorkingSegments = defineTool({
    name: 'director_patch_working_segments',
    label: '分批写入工作镜头',
    description: `按 key 新增或替换工作草案镜头，每批最多 ${WORKING_SEGMENT_BATCH_SIZE} 个。重分段遗留项用 deleteKeys 显式删除；记录分镜规划检查点后继续当前工作，不要输出整片 JSON。`,
    parameters: Type.Object({
      segments: Type.Optional(Type.Array(SegmentSchema, {
        minItems: 1,
        maxItems: WORKING_SEGMENT_BATCH_SIZE,
        description: '本批完整镜头；相同 key 会替换已有镜头',
      })),
      deleteKeys: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 32,
        description: '需要从工作草案移除的旧镜头 key',
      })),
    }),
    async execute(_toolCallId, params) {
      call('director_patch_working_segments', {
        segmentCount: params.segments?.length ?? 0,
        deleteCount: params.deleteKeys?.length ?? 0,
      });
      if (!workingHeader) {
        repairRounds += 1;
        return textResult({
          ok: false,
          code: 'working_draft_not_initialized',
          message: '请先调用 director_initialize_working_draft 写入草案头部。',
        });
      }
      const segments = params.segments ?? [];
      const deleteKeys = [...new Set(params.deleteKeys ?? [])];
      if (segments.length === 0 && deleteKeys.length === 0) {
        repairRounds += 1;
        return textResult({
          ok: false,
          code: 'working_draft_patch_empty',
          message: 'segments 与 deleteKeys 至少提供一项。',
        });
      }
      if (segments.length > WORKING_SEGMENT_BATCH_SIZE) {
        repairRounds += 1;
        return textResult({
          ok: false,
          code: 'working_draft_batch_too_large',
          maximum: WORKING_SEGMENT_BATCH_SIZE,
          received: segments.length,
          message: `请拆成每批最多 ${WORKING_SEGMENT_BATCH_SIZE} 个镜头继续写入。`,
        });
      }
      const existingKeys = new Set(workingSegments.keys());
      const deletedKeys = deleteKeys.filter((key) => workingSegments.delete(key));
      const incoming = new Map<string, ShowDirectorSegmentDraft>();
      for (const segment of segments) {
        incoming.set(segment.key, segment as ShowDirectorSegmentDraft);
      }
      let insertedCount = 0;
      let updatedCount = 0;
      for (const [key, segment] of incoming) {
        if (existingKeys.has(key)) updatedCount += 1;
        else insertedCount += 1;
        workingSegments.set(key, { ...segment });
      }
      invalidateWorkingValidation();
      await persistWorkingCheckpoint();
      return textResult({
        ok: true,
        workingVersion,
        insertedCount,
        updatedCount,
        deletedKeys,
        segmentCount: workingSegments.size,
        validationRequired: true,
        message: '本批分镜规划检查点已记录（仅草案，尚未生成画面）。请继续下一批或分页复核，不要停下来向用户确认。',
      });
    },
  });

  const readWorkingDraft = defineTool({
    name: 'director_read_working_draft',
    label: '分页复核工作草案',
    description: '按字幕顺序分页读取服务端工作草案，只返回当前页镜头；用于长片复核与定点修订，避免重新传输整片对象。',
    parameters: Type.Object({
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: WORKING_SEGMENT_MAX_PAGE_SIZE })),
      includeHeader: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      call('director_read_working_draft', {
        offset: params.offset ?? 0,
        limit: params.limit ?? WORKING_SEGMENT_PAGE_SIZE,
        includeHeader: params.includeHeader === true,
      });
      if (!workingHeader) {
        return textResult({
          ok: false,
          code: 'working_draft_not_initialized',
          message: '工作草案尚未初始化。',
        });
      }
      const ordered = orderedWorkingSegments();
      const offset = Math.min(params.offset ?? 0, ordered.length);
      const limit = params.limit ?? WORKING_SEGMENT_PAGE_SIZE;
      const segments = ordered.slice(offset, offset + limit);
      const nextOffset = offset + segments.length < ordered.length
        ? offset + segments.length
        : null;
      return textResult({
        ok: true,
        workingVersion,
        validated: validatedWorkingVersion === workingVersion,
        segmentCount: ordered.length,
        offset,
        limit,
        nextOffset,
        ...(params.includeHeader === true ? { header: workingHeader } : {}),
        segments,
      });
    },
  });

  const validateWorkingDraft = defineTool({
    name: 'director_validate_working_draft',
    label: '校验工作草案',
    description: '由服务端组合头部与全部已缓存镜头，再校验字幕覆盖、策略、素材门槛、fallback/blocked、标题与封面一致性。长片提交前必须调用。',
    parameters: Type.Object({}),
    async execute() {
      call('director_validate_working_draft');
      const draft = assembleWorkingDraft();
      if (!draft) {
        repairRounds += 1;
        return textResult({
          ok: false,
          code: 'working_draft_not_initialized',
          message: '请先初始化工作草案并分批写入镜头。',
        });
      }
      const result = validateShowDirectorDraft(draft, draftValidationOptions());
      if (result.ok) validatedWorkingVersion = workingVersion;
      else {
        validatedWorkingVersion = null;
        repairRounds += 1;
      }
      await persistWorkingCheckpoint();
      return textResult({
        ...validationPayload(result),
        workingVersion,
        segmentCount: draft.segments.length,
      });
    },
  });

  const submitWorkingDraft = defineTool({
    name: 'director_submit_working_draft',
    label: '提交工作草案',
    description: '提交服务端已组装且在当前版本通过校验的工作草案。只需提供上下文 revision；修改头部或任一镜头后必须重新校验。',
    parameters: Type.Object({
      expectedRevision: Type.Integer({ minimum: 1 }),
    }),
    async execute(_toolCallId, params) {
      call('director_submit_working_draft', { expectedRevision: params.expectedRevision });
      if (params.expectedRevision !== options.revision) {
        repairRounds += 1;
        return textResult({
          ok: false,
          code: 'director_revision_mismatch',
          expected: options.revision,
          received: params.expectedRevision,
          message: `请使用本轮上下文 revision=${options.revision} 重新提交。`,
        });
      }
      const draft = assembleWorkingDraft();
      if (!draft) {
        repairRounds += 1;
        return textResult({
          ok: false,
          code: 'working_draft_not_initialized',
          message: '请先初始化工作草案并分批写入镜头。',
        });
      }
      if (validatedWorkingVersion !== workingVersion) {
        repairRounds += 1;
        return textResult({
          ok: false,
          code: 'working_draft_validation_required',
          workingVersion,
          validatedWorkingVersion,
          message: '工作草案自上次校验后已变化，请调用 director_validate_working_draft。',
        });
      }
      const validated = validateShowDirectorDraft(draft, draftValidationOptions());
      if (!validated.ok) {
        validatedWorkingVersion = null;
        repairRounds += 1;
        return textResult({
          ...validationPayload(validated),
          code: 'working_draft_no_longer_valid',
          workingVersion,
        });
      }
      const current = await options.loadProduction();
      if (revisionChanged(current, options.snapshot)) {
        return textResult({
          ok: false,
          code: 'director_revision_conflict',
          message: '导演方案在本轮规划期间已被用户或另一任务修改。本轮结果不会覆盖新状态。',
        }, true);
      }
      return persistValidatedDraft(validated.draft);
    },
  });

  const validateDraft = defineTool({
    name: 'director_validate_draft',
    label: '校验导演草案',
    description: '短片兼容路径：一次传入完整草案并校验。长片请使用 working draft 分批工具，避免重复传输整片对象。',
    parameters: Type.Object({ draft: DirectorDraftSchema }),
    async execute(_toolCallId, params) {
      call('director_validate_draft');
      const result = validateShowDirectorDraft(params.draft, draftValidationOptions());
      if (!result.ok) repairRounds += 1;
      return textResult(validationPayload(result));
    },
  });

  const submitDraft = defineTool({
    name: 'director_submit_draft',
    label: '提交导演草案',
    description: '短片兼容路径：以乐观版本锁一次传入并提交完整导演方案。长片请使用 director_submit_working_draft。',
    parameters: Type.Object({
      expectedRevision: Type.Integer({ minimum: 1 }),
      draft: DirectorDraftSchema,
    }),
    async execute(_toolCallId, params) {
      call('director_submit_draft', { expectedRevision: params.expectedRevision });
      if (params.expectedRevision !== options.revision) {
        repairRounds += 1;
        return textResult({
          ok: false,
          code: 'director_revision_mismatch',
          expected: options.revision,
          received: params.expectedRevision,
          message: `请使用本轮上下文 revision=${options.revision} 重新提交。`,
        });
      }
      const current = await options.loadProduction();
      if (revisionChanged(current, options.snapshot)) {
        return textResult({
          ok: false,
          code: 'director_revision_conflict',
          message: '导演方案在本轮规划期间已被用户或另一任务修改。本轮结果不会覆盖新状态。',
        }, true);
      }
      const validated = validateShowDirectorDraft(params.draft, draftValidationOptions());
      if (!validated.ok) {
        repairRounds += 1;
        return textResult(validationPayload(validated));
      }
      return persistValidatedDraft(validated.draft);
    },
  });

  return {
    tools: [
      getContext,
      searchMaterials,
      inspectMaterials,
      initializeWorkingDraft,
      patchWorkingSegments,
      readWorkingDraft,
      validateWorkingDraft,
      submitWorkingDraft,
      validateDraft,
      submitDraft,
    ],
    candidates,
    getSubmittedPlan: () => submittedPlan,
    getToolCallCount: () => toolCallCount,
    getRepairRounds: () => repairRounds,
    getWorkingDraftStatus: () => {
      const ordered = orderedWorkingSegments();
      return {
        initialized: workingHeader !== null,
        workingVersion,
        validated: validatedWorkingVersion === workingVersion,
        segmentCount: ordered.length,
        firstEntryIndex: ordered[0]?.firstEntryIndex ?? null,
        lastEntryIndex: ordered.length > 0 ? ordered[ordered.length - 1].lastEntryIndex : null,
        expectedEntryCount: options.entries.length,
        candidateCount: candidates.size,
        inspectedCandidateCount: [...candidates.values()].filter((candidate) => candidate.inspected).length,
        materialSearchAttempts,
        materialSearchFailures,
      };
    },
    dispose: async () => {
      await Promise.allSettled([materialSearchQueue, checkpointWriteQueue]);
      await fs.rm(previewDir, { recursive: true, force: true });
    },
  };
}

export function formatDirectorDraftIssues(issues: DirectorDraftIssue[]): string {
  return issues.map((item) => `${item.path} [${item.code}] ${item.message}；修复：${item.repairHint}`).join('\n');
}
