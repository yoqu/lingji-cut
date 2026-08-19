import fs from 'node:fs/promises';
import path from 'node:path';
import type { SrtEntry } from '../../src/types';
import type { AISettings, PromptBindingMap } from '../../src/types/ai';
import type { DirectorPlan, ProjectProductionState } from '../../src/types/director';
import type { PromptTemplate } from '../../src/lib/prompts';
import type { TelemetryHook } from '../../src/lib/telemetry/auto-run';
import { resolvePromptBinding } from '../../src/lib/llm/binding-resolver';
import { loadProjectFile, mutateProjectProduction } from '../project-file';
import {
  ensurePiAgentRoles,
  loadPiAgentRole,
  type PiAgentRole,
} from '../agent-runtime/pi-agents-seed';
import {
  ensurePiHeadlessConfig,
  PiHeadlessSession,
  type PiHeadlessCreateInput,
  type PiHeadlessStreamEvent,
} from '../agent-runtime/pi-headless';
import { piModelRef } from '../agent-runtime/pi-provider-projection';
import { createShowDirectorTools, SHOW_DIRECTOR_TOOL_NAMES } from './tools';

const DIRECTOR_AGENT_BUDGET = {
  completionPrompts: 4,
  durationMs: 12 * 60 * 1_000,
  toolCalls: 120,
  modelRounds: 100,
} as const;

export interface RunShowDirectorAgentOptions {
  userDataPath: string;
  projectDir: string;
  resourcesRoot: string;
  entries: SrtEntry[];
  settings: AISettings;
  revision: number;
  globalPrompt?: string;
  directorTemplate?: PromptTemplate;
  projectBindings?: PromptBindingMap | null;
  bgmEnabled?: boolean;
  ffmpegPath?: string | null;
  signal?: AbortSignal;
  telemetry?: TelemetryHook;
  onProgress?: (phase: 'planning' | 'motion-bible', percent: number) => void;
  deps?: {
    createSession?: (input: PiHeadlessCreateInput) => Promise<Pick<PiHeadlessSession, 'prompt' | 'dispose' | 'abort'>>;
    ensureConfig?: () => Promise<unknown>;
    ensureRoles?: () => Promise<void>;
    loadRole?: () => Promise<PiAgentRole>;
  };
}

interface WorkflowPackage {
  version: string;
  prompt: string;
}

function frontmatterVersion(raw: string): string {
  return raw.match(/^---\n[\s\S]*?\nversion:\s*([^\n]+)[\s\S]*?\n---/)?.[1]?.trim() ?? '0';
}

async function loadWorkflowPackage(resourcesRoot: string): Promise<WorkflowPackage> {
  const root = path.join(resourcesRoot, 'skills', 'show-director-workflow');
  const files = [
    'SKILL.md',
    'references/agent-composite-strategy.md',
    'references/draft-contract.md',
    'references/tool-contract.md',
  ];
  const contents = await Promise.all(files.map(async (relative) => ({
    relative,
    raw: await fs.readFile(path.join(root, relative), 'utf-8'),
  })));
  const skill = contents[0].raw;
  return {
    version: frontmatterVersion(skill),
    prompt: contents.map(({ relative, raw }) => `\n===== ${relative} =====\n${raw.trim()}`).join('\n'),
  };
}

function hasTextBinding(
  binding: PromptBindingMap[string] | undefined,
): boolean {
  return Boolean(
    (typeof binding?.providerId === 'string' && binding.providerId.trim())
    || (typeof binding?.model === 'string' && binding.model.trim()),
  );
}

export function resolveShowDirectorModel(
  settings: AISettings,
  projectBindings: PromptBindingMap | null | undefined,
): string | undefined {
  return resolveShowDirectorModelCandidates(settings, projectBindings)[0];
}

export function resolveShowDirectorModelCandidates(
  settings: AISettings,
  projectBindings: PromptBindingMap | null | undefined,
): string[] {
  const candidates: string[] = [];
  const addBinding = (kind: 'production.director' | 'planning.segment') => {
    try {
      const { provider, model } = resolvePromptBinding(kind, settings, projectBindings ?? null);
      const ref = piModelRef(provider, model);
      if (ref && !candidates.includes(ref)) candidates.push(ref);
    } catch {
      // Try the next explicit or compatibility candidate.
    }
  };
  const directorIsExplicit = hasTextBinding(projectBindings?.['production.director'])
    || hasTextBinding(settings.promptBindings?.['production.director']);
  if (directorIsExplicit) addBinding('production.director');
  addBinding('planning.segment');
  const defaultProvider = settings.llmProviders?.find((provider) => provider.id === settings.defaultProviderId);
  const defaultModel = defaultProvider?.models.includes(defaultProvider.defaultModel ?? '')
    ? defaultProvider.defaultModel
    : settings.defaultModel;
  if (defaultProvider && defaultModel) {
    const ref = piModelRef(defaultProvider, defaultModel);
    if (ref && !candidates.includes(ref)) candidates.push(ref);
  }
  return candidates;
}

function snapshot(production: ProjectProductionState | undefined) {
  return {
    draftRevision: production?.draftPlan?.revision ?? null,
    approvedRevision: production?.approvedPlan?.revision ?? null,
    productionUpdatedAt: production?.updatedAt ?? null,
  };
}

function assertSnapshot(current: ProjectProductionState | undefined, expected: ReturnType<typeof snapshot>): void {
  if (
    (current?.draftPlan?.revision ?? null) !== expected.draftRevision
    || (current?.approvedPlan?.revision ?? null) !== expected.approvedRevision
    || (current?.updatedAt ?? null) !== expected.productionUpdatedAt
  ) {
    const error = new Error('导演方案版本已变化，本轮 Pi 规划结果不会覆盖用户的新修改。') as Error & { code?: string };
    error.code = 'director_revision_conflict';
    throw error;
  }
}

function initialPrompt(options: RunShowDirectorAgentOptions): string {
  const template = options.directorTemplate;
  return [
    `开始 revision=${options.revision} 的全片导演规划。`,
    '先调用 director_get_context 获取事实真源；之后按照已打包角色、工作流和工具契约自主导航。框架不指定第二、第三个工具动作，只在提交前检查草案覆盖、校验状态与版本一致性。',
    '素材检索不理想时自主改写 query、比较并检视候选，不要把方向选择抛给用户，也不要把全片退回 Motion 当默认答案。工作草案检查点只用于恢复规划，不代表画面已经生成。',
    options.globalPrompt?.trim() ? `用户本期补充要求：\n${options.globalPrompt.trim()}` : '',
    template?.system?.trim() ? `项目导演提示词 system：\n${template.system.trim()}` : '',
    template?.user?.trim() ? `项目导演提示词 user：\n${template.user.trim()}` : '',
    `声音开关：背景音乐 ${options.bgmEnabled === false ? '关闭' : '开启'}；音效由导演按内容判断。`,
  ].filter(Boolean).join('\n\n');
}

interface WorkingDraftStatus {
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
}

const DIRECTOR_TOOL_OUTCOMES = new Set([
  'candidates',
  'empty',
  'partial',
  'invalid-input',
  'retryable-error',
  'fatal-error',
]);

function toolResultTelemetry(
  event: Extract<PiHeadlessStreamEvent, { type: 'tool_result' }>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: event.name,
    ok: !event.isError,
  };
  if (event.isError) return result;
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(event.content) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    return result;
  }
  if (!payload) return result;
  if (typeof payload.ok === 'boolean') result.ok = payload.ok;
  if (typeof payload.outcome === 'string' && DIRECTOR_TOOL_OUTCOMES.has(payload.outcome)) {
    result.outcome = payload.outcome;
  }
  for (const key of ['candidateCount', 'errorCount', 'durationMs'] as const) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  return result;
}

export function buildShowDirectorCompletionPrompt(
  status: WorkingDraftStatus,
  expectedLastEntryIndex: number,
): string {
  const snapshot = `当前服务端状态：initialized=${status.initialized}，workingVersion=${status.workingVersion}，segments=${status.segmentCount}，coverage=${status.firstEntryIndex ?? 'none'}..${status.lastEntryIndex ?? 'none'}，expectedLastEntryIndex=${expectedLastEntryIndex}，validated=${status.validated}，candidates=${status.candidateCount}，inspected=${status.inspectedCandidateCount}，searches=${status.materialSearchAttempts ?? 0}，searchFailures=${status.materialSearchFailures ?? 0}。`;
  if (!status.initialized) {
    return [
      '你尚未建立工作草案检查点。下一步立即调用 director_initialize_working_draft；在初始化成功前停止新增素材搜索。',
      '初始化后立刻调用 director_patch_working_segments 保存首批 1-8 个语义镜头，再继续归因搜材。不要重新向用户提问，也不要用普通文本假装已保存。',
      snapshot,
    ].join('\n');
  }
  if (status.segmentCount === 0) {
    return [
      '工作草案头部已保存，但还没有镜头。下一步立即调用 director_patch_working_segments 保存首批 1-8 个语义镜头；先不要继续批量搜索。',
      '尚待搜材的镜头可暂记 blocked，后续按原 key 更新。不要从头重做标题或向用户提问。',
      snapshot,
    ].join('\n');
  }
  if (status.lastEntryIndex !== expectedLastEntryIndex) {
    return [
      '工作草案已有检查点但字幕覆盖尚未完成。继续从当前 workingVersion 分批补齐后续镜头，不要重吐或重建已保存部分。',
      '每完成一批就继续；搜索必须带 shotKey + narrativeNeed，且每轮只精检 1-2 个粗筛候选。覆盖完整后分页复核、校验并提交。',
      snapshot,
    ].join('\n');
  }
  if (!status.validated) {
    return [
      '工作草案已覆盖到最后一条字幕，但当前版本尚未通过校验。现在分页复核当前草案，调用 director_validate_working_draft，并按 issue 定点修复；修改后重新校验。',
      '不要从头重做，不要新增与修复无关的广泛搜索。校验通过后立即调用 director_submit_working_draft。',
      snapshot,
    ].join('\n');
  }
  return [
    '当前 workingVersion 已通过校验但尚未提交。立即调用 director_submit_working_draft，expectedRevision 使用本轮 context 的 revision；不要再重做或改写草案。',
    snapshot,
  ].join('\n');
}

function progressForTool(name: string): { phase: 'planning' | 'motion-bible'; percent: number } {
  switch (name) {
    case 'director_get_context': return { phase: 'planning', percent: 10 };
    case 'director_search_materials': return { phase: 'planning', percent: 45 };
    case 'director_inspect_material': return { phase: 'planning', percent: 65 };
    case 'director_initialize_working_draft': return { phase: 'planning', percent: 25 };
    case 'director_patch_working_segments': return { phase: 'planning', percent: 55 };
    case 'director_read_working_draft': return { phase: 'planning', percent: 70 };
    case 'director_validate_working_draft':
    case 'director_validate_draft': return { phase: 'motion-bible', percent: 75 };
    case 'director_submit_working_draft':
    case 'director_submit_draft': return { phase: 'motion-bible', percent: 95 };
    default: return { phase: 'planning', percent: 20 };
  }
}

export async function runShowDirectorAgent(
  options: RunShowDirectorAgentOptions,
): Promise<DirectorPlan> {
  if (options.entries.length === 0) throw new Error('没有可用于生成导演方案的字幕内容');
  const project = await loadProjectFile(options.projectDir);
  const baseSnapshot = snapshot(project.production);
  const roleSeedDir = path.join(options.resourcesRoot, 'agents');
  const [workflow] = await Promise.all([
    loadWorkflowPackage(options.resourcesRoot),
    (options.deps?.ensureConfig ?? (() => ensurePiHeadlessConfig(options.userDataPath)))(),
    (options.deps?.ensureRoles ?? (() => ensurePiAgentRoles(roleSeedDir)))(),
  ]);
  const role = await (options.deps?.loadRole
    ?? (() => loadPiAgentRole('show-director', { seedRoot: roleSeedDir })))();
  const unknownTools = role.tools.filter((name) => !(SHOW_DIRECTOR_TOOL_NAMES as readonly string[]).includes(name));
  if (unknownTools.length > 0) throw new Error(`show-director 角色声明了未注册工具：${unknownTools.join('、')}`);
  const existingPlan = project.production?.draftPlan ?? project.production?.approvedPlan ?? null;
  const runtime = await createShowDirectorTools({
    entries: options.entries,
    settings: options.settings,
    project,
    projectDir: options.projectDir,
    revision: options.revision,
    globalPrompt: options.globalPrompt,
    existingPlan,
    ffmpegPath: options.ffmpegPath,
    roleVersion: role.version,
    workflowVersion: workflow.version,
    snapshot: baseSnapshot,
    loadProduction: async () => (await loadProjectFile(options.projectDir)).production,
    persistDraft: async (plan, expected) => {
      await mutateProjectProduction(
        options.projectDir,
        { kind: 'replace-draft', plan },
        (current) => assertSnapshot(current.production, expected),
      );
    },
    onToolCall: (name, detail) => {
      const progress = progressForTool(name);
      options.onProgress?.(progress.phase, progress.percent);
      options.telemetry?.emit('director.agent.tool', { name, ...detail });
    },
  });
  const createSession = options.deps?.createSession ?? PiHeadlessSession.create.bind(PiHeadlessSession);
  let session: Pick<PiHeadlessSession, 'prompt' | 'dispose' | 'abort'> | null = null;
  let completionTurn = 0;
  let modelRound = 0;
  const startedAt = Date.now();
  options.onProgress?.('planning', 0);
  options.telemetry?.emit('director.agent.start', {
    revision: options.revision,
    roleVersion: role.version,
    workflowVersion: workflow.version,
  });
  try {
    const modelCandidates = resolveShowDirectorModelCandidates(options.settings, options.projectBindings);
    session = await createSession({
      systemPrompt: `${role.systemPrompt}\n\n===== 已打包工作流 =====\n${workflow.prompt}`,
      tools: role.tools,
      customTools: runtime.tools,
      cwd: options.projectDir,
      agentDir: undefined,
      signal: options.signal,
      model: modelCandidates[0],
      modelCandidates,
      requireImageInput: true,
      onEvent: (event) => {
        if (event.type === 'tool_use') {
          options.telemetry?.emit('director.agent.tool-use', { name: event.name });
        } else if (event.type === 'tool_result') {
          options.telemetry?.emit('director.agent.tool-result', toolResultTelemetry(event));
        } else if (event.type === 'turn_end') {
          modelRound += 1;
          options.telemetry?.emit('director.agent.turn', {
            completionTurn,
            modelRound,
            stopReason: event.stopReason,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheReadTokens: event.cacheReadTokens,
            cacheWriteTokens: event.cacheWriteTokens,
            reasoningTokens: event.reasoningTokens,
            contextTokens: event.contextTokens,
            assistantChars: event.assistantChars,
            thinkingChars: event.thinkingChars,
          });
        }
      },
    });
    let prompt = initialPrompt(options);
    for (let turn = 0; turn < DIRECTOR_AGENT_BUDGET.completionPrompts; turn += 1) {
      completionTurn = turn + 1;
      await session.prompt(prompt);
      const submitted = runtime.getSubmittedPlan();
      if (submitted) {
        options.onProgress?.('motion-bible', 100);
        options.telemetry?.emit('director.agent.end', {
          ok: true,
          revision: submitted.revision,
          durationMs: Date.now() - startedAt,
          toolCalls: runtime.getToolCallCount(),
          repairRounds: runtime.getRepairRounds(),
          composites: submitted.segments.filter((segment) => segment.renderStrategy === 'agent-composite' && segment.strategyStatus !== 'blocked').length,
        });
        return submitted;
      }
      if (
        Date.now() - startedAt >= DIRECTOR_AGENT_BUDGET.durationMs
        || runtime.getToolCallCount() >= DIRECTOR_AGENT_BUDGET.toolCalls
        || modelRound >= DIRECTOR_AGENT_BUDGET.modelRounds
      ) break;
      const workingStatus = runtime.getWorkingDraftStatus();
      options.telemetry?.emit('director.agent.checkpoint', {
        completionTurn,
        workingVersion: workingStatus.workingVersion,
        segmentCount: workingStatus.segmentCount,
        firstEntryIndex: workingStatus.firstEntryIndex ?? -1,
        lastEntryIndex: workingStatus.lastEntryIndex ?? -1,
        expectedEntryCount: workingStatus.expectedEntryCount,
        candidateCount: workingStatus.candidateCount,
        inspectedCandidateCount: workingStatus.inspectedCandidateCount,
        materialSearchAttempts: workingStatus.materialSearchAttempts ?? 0,
        materialSearchFailures: workingStatus.materialSearchFailures ?? 0,
        initialized: workingStatus.initialized,
        validated: workingStatus.validated,
      });
      prompt = buildShowDirectorCompletionPrompt(
        workingStatus,
        options.entries[options.entries.length - 1].index,
      );
    }
    throw new Error('Pi 总导演在当前时间、工具或上下文预算内未提交有效草案；已保留工作草案检查点，可继续恢复。');
  } catch (error) {
    options.telemetry?.emit('director.agent.end', {
      ok: false,
      durationMs: Date.now() - startedAt,
      toolCalls: runtime.getToolCallCount(),
      repairRounds: runtime.getRepairRounds(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    session?.dispose();
    await runtime.dispose();
  }
}
