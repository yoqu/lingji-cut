import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runShowDirectorAgent } from '../../director-agent/show-director-run';
import { parseSrt } from '../../../src/lib/srt-parser';
import type { DirectorPlan, ProjectProductionState } from '../../../src/types/director';
import { loadEffectivePromptTemplate } from '../../prompts-io';
import { loadProjectFile, mutateProjectProduction } from '../../project-file';
import { loadFullHeadlessAISettings, loadHeadlessProjectBindings } from '../headless-settings';
import { GenerationError } from '../generation-error';
import type { GenerationRunCtx } from '../headless-generation';
import { makeMainTelemetry } from '../../telemetry/main-telemetry';

const SAFE_AGENT_STRING_FIELDS = new Set([
  'name',
  'materialKind',
  'roleVersion',
  'workflowVersion',
  'stopReason',
  'outcome',
]);
const SAFE_AGENT_NUMBER_FIELDS = new Set([
  'revision',
  'durationMs',
  'toolCalls',
  'repairRounds',
  'composites',
  'queryChars',
  'count',
  'expectedRevision',
  'shotKeyChars',
  'narrativeNeedChars',
  'completionTurn',
  'modelRound',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'contextTokens',
  'assistantChars',
  'thinkingChars',
  'workingVersion',
  'segmentCount',
  'firstEntryIndex',
  'lastEntryIndex',
  'expectedEntryCount',
  'candidateCount',
  'errorCount',
  'inspectedCandidateCount',
  'materialSearchAttempts',
  'materialSearchFailures',
]);
const SAFE_AGENT_BOOLEAN_FIELDS = new Set(['ok', 'initialized', 'validated']);

type DirectorTelemetry = ReturnType<typeof makeMainTelemetry>;

function safeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9_.-]{1,80}$/.test(trimmed) ? trimmed : undefined;
}

function createSafeAgentTelemetry(telemetry: DirectorTelemetry): DirectorTelemetry {
  return {
    emit(kind, extra = {}) {
      const safe: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(extra)) {
        const safeKey = key === 'kind' ? 'materialKind' : key;
        if (SAFE_AGENT_STRING_FIELDS.has(safeKey)) {
          const token = safeToken(value);
          if (token) safe[safeKey] = token;
        } else if (SAFE_AGENT_NUMBER_FIELDS.has(key) && typeof value === 'number' && Number.isFinite(value)) {
          safe[key] = value;
        } else if (SAFE_AGENT_BOOLEAN_FIELDS.has(key) && typeof value === 'boolean') {
          safe[key] = value;
        }
      }
      telemetry.emit(kind, safe);
    },
  };
}

function safeErrorMetadata(error: unknown): { errorName: string; errorCode?: string } {
  const errorName = safeToken(error instanceof Error ? error.name : typeof error) ?? 'UnknownError';
  const rawCode = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  const errorCode = safeToken(rawCode);
  return { errorName, ...(errorCode ? { errorCode } : {}) };
}

function nextRevision(production: ProjectProductionState | undefined): number {
  if (production?.draftPlan) return production.draftPlan.revision;
  return (production?.approvedPlan?.revision ?? 0) + 1;
}

async function readSubtitleEntries(projectPath: string) {
  let source: string;
  try {
    source = await readFile(join(projectPath, 'podcast-subtitles.srt'), 'utf-8');
  } catch {
    throw new GenerationError(
      'no_subtitles',
      '未找到 podcast-subtitles.srt，请先生成音频/字幕。',
    );
  }
  const entries = parseSrt(source);
  if (entries.length === 0) throw new GenerationError('empty_subtitles', '字幕为空。');
  return entries;
}

function reportPlanProgress(
  report: (update: { phase: string; percent: number }) => void,
  phase: 'planning' | 'motion-bible',
  percent: number,
): void {
  const base = phase === 'planning' ? 15 : 70;
  const scale = phase === 'planning' ? 0.55 : 0.25;
  report({
    phase: phase === 'planning' ? '规划镜头并检索素材' : '复核镜头与媒介策略',
    percent: Math.round(base + percent * scale),
  });
}

function createMonotonicProgressReporter(handle: GenerationRunCtx['handle']) {
  let lastPercent = 0;
  return (update: { phase: string; percent: number }): void => {
    const bounded = Number.isFinite(update.percent)
      ? Math.max(0, Math.min(100, Math.round(update.percent)))
      : lastPercent;
    lastPercent = Math.max(lastPercent, bounded);
    handle.update({ ...update, percent: lastPercent });
  };
}

async function loadPlanDependencies(userDataPath: string, projectPath: string) {
  return Promise.all([
    loadFullHeadlessAISettings(userDataPath),
    loadHeadlessProjectBindings(projectPath),
    loadEffectivePromptTemplate('production.director', { userDataPath, projectDir: projectPath }),
  ]);
}

export async function runDirectorPlanHeadless(ctx: GenerationRunCtx): Promise<DirectorPlan> {
  const { projectPath, userDataPath, handle } = ctx;
  const mode = ctx.params?.mode === 'auto' ? 'auto' : 'director';
  const telemetry = makeMainTelemetry(`director-${Date.now()}-${handle.taskId.slice(0, 8)}`);
  const agentTelemetry = createSafeAgentTelemetry(telemetry);
  const reportProgress = createMonotonicProgressReporter(handle);
  const startedAt = Date.now();
  let revision: number | undefined;
  telemetry.emit('run.start', { stage: 'director.plan', source: 'headless', mode });
  try {
    const project = await loadProjectFile(projectPath);
    revision = nextRevision(project.production);
    await mutateProjectProduction(projectPath, {
      kind: 'set-workflow',
      stage: 'director-planning',
      mode,
      taskId: handle.taskId,
    });
    reportProgress({ phase: '读取字幕', percent: 5 });
    const entries = await readSubtitleEntries(projectPath);
    const [settings, projectBindings, directorTemplate] =
      await loadPlanDependencies(userDataPath, projectPath);
    const [{ app }, { resolveFfmpegPath }] = await Promise.all([
      import('electron'),
      import('../../runtime-binaries'),
    ]);
    reportProgress({ phase: '制定导演方案', percent: 15 });
    const plan = await runShowDirectorAgent({
      userDataPath,
      projectDir: projectPath,
      resourcesRoot: join(app.getAppPath(), 'resources', 'pi-agents'),
      entries,
      settings,
      revision,
      globalPrompt:
        typeof ctx.params?.globalPrompt === 'string' ? ctx.params.globalPrompt.trim() : undefined,
      directorTemplate,
      projectBindings,
      ffmpegPath: resolveFfmpegPath({
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        cwd: process.cwd(),
        moduleDir: __dirname,
      }),
      signal: handle.signal,
      telemetry: agentTelemetry,
      onProgress: (phase, percent) => reportPlanProgress(reportProgress, phase, percent),
    });
    reportProgress({ phase: '等待导演批准', percent: 100 });
    telemetry.emit('run.end', {
      stage: 'director.plan',
      source: 'headless',
      mode,
      durationMs: Date.now() - startedAt,
      ok: true,
      revision: plan.revision,
      segmentCount: plan.segments.length,
      compositeCount: plan.segments.filter((segment) => segment.renderStrategy === 'agent-composite').length,
      blockedCount: plan.segments.filter((segment) => segment.strategyStatus === 'blocked').length,
    });
    return plan;
  } catch (error) {
    telemetry.emit('run.end', {
      stage: 'director.plan',
      source: 'headless',
      mode,
      durationMs: Date.now() - startedAt,
      ok: false,
      ...(revision == null ? {} : { revision }),
      ...safeErrorMetadata(error),
    });
    const message = error instanceof Error ? error.message : String(error);
    await mutateProjectProduction(projectPath, {
      kind: 'set-workflow',
      stage: 'error',
      error: message,
    });
    throw error;
  }
}

export async function runDirectorApproveHeadless(
  ctx: GenerationRunCtx,
): Promise<ProjectProductionState> {
  const { projectPath, handle } = ctx;
  const project = await loadProjectFile(projectPath);
  const draft = project.production?.draftPlan;
  if (!draft) {
    throw new GenerationError('director_plan_required', '没有待批准的导演方案，请先运行 director plan。');
  }
  const requested = ctx.params?.revision;
  const revision = typeof requested === 'number' ? requested : draft.revision;
  handle.update({ phase: '批准导演方案', percent: 30 });
  const production = await mutateProjectProduction(projectPath, {
    kind: 'approve-draft',
    expectedRevision: revision,
    taskId: handle.taskId,
  });
  handle.update({ phase: '制作已启动', percent: 100 });
  return production;
}
