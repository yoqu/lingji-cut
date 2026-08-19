import fs from 'node:fs/promises';
import path from 'node:path';
import type { AISettings, PromptBindingMap } from '../../src/types/ai';
import type { PromptTemplate } from '../../src/lib/prompts';
import type { TelemetryHook } from '../../src/lib/telemetry/auto-run';
import type { HubJobState } from '../../src/lib/publish/hub-state';
import { resolvePromptBinding } from '../../src/lib/llm/binding-resolver';
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
import type { PublishAccount } from '../publish/types';
import {
  ingestToolLabel,
  summarizeIngestToolResult,
  type PublishIngestTraceEvent,
} from '../../src/lib/publish/ingest-trace';
import { createPublishIngestTools, PUBLISH_INGEST_TOOL_NAMES } from './tools';
import { formatWorkdirScanSummary, scanWorkdirMedia } from './workdir-scan';

const INGEST_AGENT_BUDGET = {
  completionPrompts: 3,
  durationMs: 4 * 60 * 1_000,
  toolCalls: 16,
  modelRounds: 16,
} as const;

export interface RunPublishIngestAgentOptions {
  userDataPath: string;
  workDir: string;
  resourcesRoot: string;
  settings: AISettings;
  accounts: Array<Pick<PublishAccount, 'id' | 'platform' | 'accountName' | 'status'>>;
  existingState: HubJobState;
  metadataTemplate: PromptTemplate;
  partitionTemplate: PromptTemplate;
  coverTemplate: PromptTemplate;
  projectBindings?: PromptBindingMap | null;
  ffprobePath?: string | null;
  signal?: AbortSignal;
  telemetry?: TelemetryHook;
  onProgress?: (phase: string, percent: number, toolName?: string) => void;
  onTrace?: (event: PublishIngestTraceEvent) => void;
  persistDraft: (state: HubJobState) => Promise<void>;
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
  const root = path.join(resourcesRoot, 'skills', 'publish-ingest-workflow');
  const files = [
    'SKILL.md',
    'references/draft-contract.md',
    'references/tool-contract.md',
  ];
  const contents = await Promise.all(files.map(async (relative) => ({
    relative,
    raw: await fs.readFile(path.join(root, relative), 'utf-8'),
  })));
  return {
    version: frontmatterVersion(contents[0].raw),
    prompt: contents.map(({ relative, raw }) => `\n===== ${relative} =====\n${raw.trim()}`).join('\n'),
  };
}

function hasTextBinding(binding: PromptBindingMap[string] | undefined): boolean {
  return Boolean(
    (typeof binding?.providerId === 'string' && binding.providerId.trim())
    || (typeof binding?.model === 'string' && binding.model.trim()),
  );
}

export function resolvePublishIngestModelCandidates(
  settings: AISettings,
  projectBindings: PromptBindingMap | null | undefined,
): string[] {
  const candidates: string[] = [];
  const addBinding = (kind: 'publish.metadata' | 'planning.segment') => {
    try {
      const { provider, model } = resolvePromptBinding(kind, settings, projectBindings ?? null);
      const ref = piModelRef(provider, model);
      if (ref && !candidates.includes(ref)) candidates.push(ref);
    } catch {
      // Try the next candidate.
    }
  };
  const metadataIsExplicit = hasTextBinding(projectBindings?.['publish.metadata'])
    || hasTextBinding(settings.promptBindings?.['publish.metadata']);
  if (metadataIsExplicit) addBinding('publish.metadata');
  const defaultProvider = settings.llmProviders?.find((provider) => provider.id === settings.defaultProviderId);
  const defaultModel = defaultProvider?.models.includes(defaultProvider.defaultModel ?? '')
    ? defaultProvider.defaultModel
    : settings.defaultModel;
  if (defaultProvider && defaultModel) {
    const ref = piModelRef(defaultProvider, defaultModel);
    if (ref && !candidates.includes(ref)) candidates.push(ref);
  }
  addBinding('planning.segment');
  return candidates;
}

function progressForTool(name: string): number {
  switch (name) {
    case 'publish_get_context': return 18;
    case 'publish_read_text': return 32;
    case 'publish_generate_metadata': return 58;
    case 'publish_generate_cover_prompt': return 76;
    case 'publish_recommend_partition': return 84;
    case 'publish_validate_draft': return 90;
    case 'publish_submit_draft': return 96;
    default: return 24;
  }
}

export function buildPublishIngestCompletionPrompt(validated: boolean): string {
  if (!validated) {
    return [
      '你还没有提交通过校验的发布草案。',
      '成片和封面已由程序选定，不要再扫描媒体。补全文案后校验，通过后立即调用 publish_submit_draft。',
      '不要上传，不要生成封面图，不要向用户提问选择题。',
    ].join('\n');
  }
  return '当前草案已通过校验但尚未提交。立即调用 publish_submit_draft；不要再重做识别。';
}

function initialPrompt(workDir: string): string {
  return [
    `开始识别工作目录：${workDir}`,
    '先调用 publish_get_context。成片和封面已扫描完成，只处理标题、简介、标签、封面提示词。',
    '已有现成文案就采用。提交前必须校验。不要上传，不要生成封面图。',
  ].join('\n');
}

export async function runPublishIngestAgent(
  options: RunPublishIngestAgentOptions,
): Promise<HubJobState> {
  const roleSeedDir = path.join(options.resourcesRoot, 'agents');
  const [workflow] = await Promise.all([
    loadWorkflowPackage(options.resourcesRoot),
    (options.deps?.ensureConfig ?? (() => ensurePiHeadlessConfig(options.userDataPath)))(),
    (options.deps?.ensureRoles ?? (() => ensurePiAgentRoles(roleSeedDir)))(),
  ]);
  const role = await (options.deps?.loadRole
    ?? (() => loadPiAgentRole('publish-ingest', { seedRoot: roleSeedDir })))();
  const unknownTools = role.tools.filter((name) => !(PUBLISH_INGEST_TOOL_NAMES as readonly string[]).includes(name));
  if (unknownTools.length > 0) {
    throw new Error(`publish-ingest 角色声明了未注册工具：${unknownTools.join('、')}`);
  }
  const metadataBinding = (() => {
    try {
      return resolvePromptBinding('publish.metadata', options.settings, options.projectBindings ?? null);
    } catch {
      return undefined;
    }
  })();
  const partitionBinding = (() => {
    try {
      return resolvePromptBinding('publish.partition', options.settings, options.projectBindings ?? null);
    } catch {
      return undefined;
    }
  })();
  options.onProgress?.('scan', 4);
  const scan = await scanWorkdirMedia(options.workDir, { ffprobePath: options.ffprobePath });
  options.onTrace?.({ type: 'scan', summary: formatWorkdirScanSummary(scan) });
  options.onProgress?.('scan', 10);
  if (!scan.video) {
    const message = '工作目录里没有找到视频成片。请放入 mp4 / mov / webm 后再识别。';
    options.onTrace?.({ type: 'error', message });
    throw new Error(message);
  }
  const runtime = await createPublishIngestTools({
    workDir: options.workDir,
    settings: options.settings,
    userDataPath: options.userDataPath,
    accounts: options.accounts,
    existingState: options.existingState,
    metadataTemplate: options.metadataTemplate,
    metadataBinding,
    partitionTemplate: options.partitionTemplate,
    partitionBinding,
    coverTemplate: options.coverTemplate,
    coverBinding: metadataBinding,
    projectBindings: options.projectBindings ?? null,
    ffprobePath: options.ffprobePath,
    scan,
    telemetry: options.telemetry,
    persistDraft: options.persistDraft,
    onToolCall: (name) => {
      options.onProgress?.('ingest', progressForTool(name), name);
      options.telemetry?.emit('publish.ingest.tool', { name });
    },
  });
  const createSession = options.deps?.createSession ?? PiHeadlessSession.create.bind(PiHeadlessSession);
  let session: Pick<PiHeadlessSession, 'prompt' | 'dispose' | 'abort'> | null = null;
  let modelRound = 0;
  const startedAt = Date.now();
  options.onProgress?.('ingest', 0);
  const modelCandidates = resolvePublishIngestModelCandidates(options.settings, options.projectBindings);
  options.telemetry?.emit('stage.start', { stage: 'publish.ingest' });
  options.telemetry?.emit('publish.ingest.start', {
    roleVersion: role.version,
    workflowVersion: workflow.version,
    model: modelCandidates[0] ?? null,
  });
  try {
    session = await createSession({
      systemPrompt: `${role.systemPrompt}\n\n===== 已打包工作流 =====\n${workflow.prompt}`,
      tools: role.tools,
      customTools: runtime.tools,
      cwd: options.workDir,
      agentDir: undefined,
      signal: options.signal,
      model: modelCandidates[0],
      modelCandidates,
      requireImageInput: false,
      onEvent: (event: PiHeadlessStreamEvent) => {
        if (event.type === 'thinking_delta') {
          options.onTrace?.({ type: 'thinking_delta', delta: event.delta });
        } else if (event.type === 'text_delta') {
          options.onTrace?.({ type: 'text_delta', delta: event.delta });
        } else if (event.type === 'tool_use') {
          options.onTrace?.({
            type: 'tool_use',
            id: event.id,
            name: event.name,
            label: ingestToolLabel(event.name),
          });
          options.telemetry?.emit('publish.ingest.tool-use', { name: event.name });
        } else if (event.type === 'tool_result') {
          options.onTrace?.({
            type: 'tool_result',
            id: event.toolUseId,
            name: event.name,
            ok: !event.isError,
            summary: summarizeIngestToolResult(event.content),
          });
          options.telemetry?.emit('publish.ingest.tool-result', {
            name: event.name,
            ok: !event.isError,
          });
        } else if (event.type === 'turn_end') {
          modelRound += 1;
        }
      },
    });
    let prompt = initialPrompt(options.workDir);
    for (let turn = 0; turn < INGEST_AGENT_BUDGET.completionPrompts; turn += 1) {
      await session.prompt(prompt);
      const submitted = runtime.getSubmittedDraft();
      if (submitted) {
        options.onProgress?.('ingest', 100, 'publish_submit_draft');
        options.telemetry?.emit('stage.end', {
          stage: 'publish.ingest',
          ok: true,
          durationMs: Date.now() - startedAt,
        });
        options.telemetry?.emit('publish.ingest.end', {
          ok: true,
          durationMs: Date.now() - startedAt,
          toolCalls: runtime.getToolCallCount(),
        });
        options.onTrace?.({ type: 'done' });
        return submitted;
      }
      if (
        Date.now() - startedAt >= INGEST_AGENT_BUDGET.durationMs
        || runtime.getToolCallCount() >= INGEST_AGENT_BUDGET.toolCalls
        || modelRound >= INGEST_AGENT_BUDGET.modelRounds
      ) break;
      prompt = buildPublishIngestCompletionPrompt(runtime.getValidated());
    }
    throw new Error('识别工作目录超时或未提交有效发布草案，请重试。');
  } catch (error) {
    options.telemetry?.emit('stage.end', {
      stage: 'publish.ingest',
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    options.telemetry?.emit('publish.ingest.end', {
      ok: false,
      durationMs: Date.now() - startedAt,
      toolCalls: runtime.getToolCallCount(),
      error: error instanceof Error ? error.message : String(error),
    });
    options.onTrace?.({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    session?.dispose();
    await runtime.dispose();
  }
}
