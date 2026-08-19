import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { AISettings, PromptBindingMap } from '../../src/types/ai';
import type { PublishAccount } from '../publish/types';
import type { PromptTemplate } from '../../src/lib/prompts';
import type { ResolvedBinding } from '../../src/lib/llm/binding-resolver';
import { generatePublishMetadata, type PublishMetadata } from '../../src/lib/publish-metadata';
import { recommendBilibiliPartition } from '../../src/lib/publish-partition-recommend';
import { regenerateCoverPrompt } from '../../src/lib/ai-analysis';
import type { TelemetryHook } from '../../src/lib/telemetry/auto-run';
import {
  emptyHubJobState,
  formatPublishMaterialsMarkdown,
  type HubJobState,
} from '../../src/lib/publish/hub-state';
import { PUBLISH_INGEST_TOOL_LABELS } from '../../src/lib/publish/ingest-trace';
import {
  ingestDraftToPublishDraft,
  isPathInside,
  validatePublishIngestDraft,
  type PublishIngestDraft,
} from './contract';
import {
  coverPathsFromScan,
  scanWorkdirMedia,
  type WorkdirMediaScan,
} from './workdir-scan';

export const PUBLISH_INGEST_TOOL_NAMES = [
  'publish_get_context',
  'publish_read_text',
  'publish_generate_metadata',
  'publish_generate_cover_prompt',
  'publish_recommend_partition',
  'publish_validate_draft',
  'publish_submit_draft',
] as const;

export { PUBLISH_INGEST_TOOL_LABELS };

const MAX_TEXT_CHARS = 32_000;
const TEXT_EXTS = new Set(['.md', '.txt', '.json', '.srt', '.csv', '.yaml', '.yml']);

const draftSchema = Type.Object({
  filePath: Type.Optional(Type.String()),
  title: Type.String(),
  desc: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  covers: Type.Optional(Type.Object({
    '16:9': Type.Optional(Type.String()),
    '4:3': Type.Optional(Type.String()),
    '3:4': Type.Optional(Type.String()),
  })),
  thumbnail: Type.Optional(Type.String()),
  bilibiliTid: Type.Optional(Type.String()),
  coverPrompt: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

export interface PublishIngestToolRuntimeOptions {
  workDir: string;
  settings: AISettings;
  userDataPath: string;
  accounts: Array<Pick<PublishAccount, 'id' | 'platform' | 'accountName' | 'status'>>;
  existingState: HubJobState;
  metadataTemplate: PromptTemplate;
  metadataBinding?: ResolvedBinding;
  partitionTemplate: PromptTemplate;
  partitionBinding?: ResolvedBinding;
  coverTemplate: PromptTemplate;
  /** 识别阶段封面提示词使用的 LLM，与发布文案 / 识别模型选择器一致。 */
  coverBinding?: ResolvedBinding;
  projectBindings?: PromptBindingMap | null;
  ffprobePath?: string | null;
  scan?: WorkdirMediaScan;
  persistDraft: (state: HubJobState) => Promise<void>;
  onToolCall?: (name: string, detail?: Record<string, unknown>) => void;
  telemetry?: TelemetryHook;
  deps?: {
    generateMetadata?: typeof generatePublishMetadata;
    recommendPartition?: typeof recommendBilibiliPartition;
    regenerateCoverPrompt?: typeof regenerateCoverPrompt;
    fileExists?: (absPath: string) => boolean;
  };
}

export interface PublishIngestToolRuntime {
  tools: ToolDefinition[];
  getSubmittedDraft: () => HubJobState | null;
  getToolCallCount: () => number;
  getValidated: () => boolean;
  dispose: () => Promise<void>;
}

function textResult(value: unknown, terminate = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    details: value,
    ...(terminate ? { terminate: true } : {}),
  };
}

function resolveInside(workDir: string, target: string): string | null {
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(workDir, target);
  return isPathInside(abs, workDir) ? abs : null;
}

async function syncMaterialsIfPresent(workDir: string, state: HubJobState): Promise<void> {
  const filePath = path.join(workDir, '发布物料.md');
  try {
    await fs.access(filePath);
  } catch {
    return;
  }
  await fs.writeFile(filePath, formatPublishMaterialsMarkdown(state.draft), 'utf-8');
}

export type IngestCoverPromptSkipReason = 'existing-prompt' | 'covers-present';

export function shouldSkipIngestCoverPrompt(input: {
  existingCoverPrompt?: string;
  hasCovers: boolean;
}): { skip: true; reason: IngestCoverPromptSkipReason; coverPrompt?: string } | { skip: false } {
  const existing = input.existingCoverPrompt?.trim();
  if (existing) return { skip: true, reason: 'existing-prompt', coverPrompt: existing };
  if (input.hasCovers) return { skip: true, reason: 'covers-present' };
  return { skip: false };
}

function scanHasCovers(scan: WorkdirMediaScan): boolean {
  return Object.values(scan.covers).some(Boolean);
}

function applyScanToDraft(draft: PublishIngestDraft, scan: WorkdirMediaScan): PublishIngestDraft {
  const covers = coverPathsFromScan(scan);
  return {
    ...draft,
    filePath: scan.video?.absPath ?? draft.filePath,
    covers,
    thumbnail: covers['3:4'] || covers['16:9'] || covers['4:3'] || draft.thumbnail,
  };
}

export async function createPublishIngestTools(
  options: PublishIngestToolRuntimeOptions,
): Promise<PublishIngestToolRuntime> {
  const { defineTool } = await import('@earendil-works/pi-coding-agent');
  let toolCallCount = 0;
  let validated = false;
  let lastValidated: PublishIngestDraft | null = null;
  let submitted: HubJobState | null = null;
  let scan = options.scan ?? null;

  const call = (name: string, detail?: Record<string, unknown>) => {
    toolCallCount += 1;
    options.onToolCall?.(name, detail);
  };

  const fileExists = options.deps?.fileExists ?? ((absPath: string) => existsSync(absPath));

  const ensureScan = async (): Promise<WorkdirMediaScan> => {
    if (!scan) {
      scan = await scanWorkdirMedia(options.workDir, { ffprobePath: options.ffprobePath });
    }
    return scan;
  };

  const getContext = defineTool({
    name: 'publish_get_context',
    label: '读取发布上下文',
    description: '读取程序已选定的成片/封面、文本摘录、已有草稿和已登录账号。识别开始时必须先调用。不要再用工具挑选视频或封面。',
    parameters: Type.Object({}),
    async execute() {
      call('publish_get_context');
      const detected = await ensureScan();
      const skipCover = shouldSkipIngestCoverPrompt({
        existingCoverPrompt: options.existingState.coverPrompt,
        hasCovers: scanHasCovers(detected),
      });
      return textResult({
        workDir: options.workDir,
        existingDraft: options.existingState.draft.title
          ? {
              title: options.existingState.draft.title,
              desc: options.existingState.draft.desc,
              tagsInput: options.existingState.draft.tagsInput,
              coverPrompt: options.existingState.coverPrompt,
              notes: options.existingState.notes,
              bilibiliTid: options.existingState.draft.bilibiliTid,
            }
          : null,
        accounts: options.accounts.map((acc) => ({
          platform: acc.platform,
          accountName: acc.accountName,
          status: acc.status,
        })),
        detected: {
          video: detected.video
            ? {
                path: detected.video.relativePath,
                size: detected.video.size,
                durationMs: detected.video.durationMs,
              }
            : null,
          covers: Object.fromEntries(
            Object.entries(detected.covers).map(([ratio, cover]) => [
              ratio,
              cover
                ? { path: cover.relativePath, width: cover.width, height: cover.height }
                : undefined,
            ]),
          ),
          excerpts: detected.excerpts,
          videoCount: detected.videoCount,
          imageCount: detected.imageCount,
          skipCoverPrompt: skipCover.skip,
          skipCoverPromptReason: skipCover.skip ? skipCover.reason : null,
        },
        rule: skipCover.skip
          ? '成片和封面已由程序选定。不要填写 filePath/covers。不要调用 publish_generate_cover_prompt。封面提示词失败或跳过时仍须校验提交。不要生成封面图，不要上传。'
          : '成片和封面已由程序选定。不要填写 filePath/covers。仅在没有可用封面且没有现成提示词时才生成封面提示词；生成失败仍须校验提交。不要生成封面图，不要上传。',
      });
    },
  });

  const readText = defineTool({
    name: 'publish_read_text',
    label: '读取文本',
    description: '读取工作目录内被截断的文本文件。上下文摘录已够用时不要再读。',
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: '相对或绝对路径，必须在工作目录内' }),
    }),
    async execute(_id, params: { path: string }) {
      call('publish_read_text', { path: params.path });
      const abs = resolveInside(options.workDir, params.path);
      if (!abs) return textResult({ ok: false, error: '路径越出工作目录' });
      const ext = path.extname(abs).toLowerCase();
      if (!TEXT_EXTS.has(ext)) {
        return textResult({ ok: false, error: `不支持的文本类型：${ext || '(无扩展名)'}` });
      }
      try {
        const raw = await fs.readFile(abs, 'utf-8');
        const truncated = raw.length > MAX_TEXT_CHARS;
        return textResult({
          ok: true,
          path: path.relative(options.workDir, abs),
          truncated,
          text: truncated ? raw.slice(0, MAX_TEXT_CHARS) : raw,
        });
      } catch (error) {
        return textResult({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  const generateMetadata = defineTool({
    name: 'publish_generate_metadata',
    label: '生成发布文案',
    description: '根据摘录或读到的内容生成标题、简介和标签。已有现成文案时不要调用。',
    parameters: Type.Object({
      sourceText: Type.String({ minLength: 1, description: '从文稿/字幕/物料中摘录的内容素材' }),
      currentTitle: Type.Optional(Type.String()),
    }),
    async execute(_id, params: { sourceText: string; currentTitle?: string }) {
      call('publish_generate_metadata');
      const generate = options.deps?.generateMetadata ?? generatePublishMetadata;
      try {
        const md: PublishMetadata = await generate(
          options.settings,
          { sourceText: params.sourceText, currentTitle: params.currentTitle },
          { template: options.metadataTemplate, binding: options.metadataBinding },
        );
        return textResult({ ok: true, ...md });
      } catch (error) {
        return textResult({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  const generateCoverPrompt = defineTool({
    name: 'publish_generate_cover_prompt',
    label: '生成封面提示词',
    description: '仅当上下文 skipCoverPrompt 为 false 时调用。已有封面或已有提示词时不要调用。失败可忽略，不得因此中止提交。只产出提示词，不生成图片。',
    parameters: Type.Object({
      sourceText: Type.Optional(Type.String({ description: '用于生成提示词的内容素材' })),
      currentTitle: Type.Optional(Type.String()),
    }),
    async execute(_id, params: { sourceText?: string; currentTitle?: string }) {
      call('publish_generate_cover_prompt');
      try {
        const detected = await ensureScan();
        const skip = shouldSkipIngestCoverPrompt({
          existingCoverPrompt: options.existingState.coverPrompt,
          hasCovers: scanHasCovers(detected),
        });
        if (skip.skip) {
          return textResult({
            ok: true,
            skipped: true,
            reason: skip.reason,
            coverPrompt: skip.coverPrompt,
          });
        }
        const source = params.sourceText?.trim()
          || [params.currentTitle, options.existingState.draft.title, options.existingState.draft.desc]
            .filter((item) => typeof item === 'string' && item.trim())
            .join('\n');
        if (!source) throw new Error('缺少标题、简介或内容素材，无法生成封面提示词');
        const regen = options.deps?.regenerateCoverPrompt ?? regenerateCoverPrompt;
        const prompts = await regen(
          [{ index: 1, startMs: 0, endMs: 0, text: source }],
          options.settings,
          {
            coverTemplate: options.coverTemplate,
            projectBindings: options.projectBindings ?? null,
            binding: options.coverBinding ?? options.metadataBinding,
            workTitle: params.currentTitle || options.existingState.draft.title || undefined,
            telemetry: options.telemetry,
          },
        );
        const prompt = prompts[0]?.trim() ?? '';
        if (!prompt) throw new Error('未能生成封面提示词');
        return textResult({ ok: true, coverPrompt: prompt });
      } catch (error) {
        return textResult({
          ok: false,
          skipped: true,
          error: error instanceof Error ? error.message : String(error),
          hint: '封面提示词失败可忽略，继续校验并提交草案。',
        });
      }
    },
  });

  const recommendPartition = defineTool({
    name: 'publish_recommend_partition',
    label: '推荐 B站分区',
    description: '根据标题和简介推荐 B站投稿分区 tid。没有 B站账号或已有分区时可跳过。',
    parameters: Type.Object({
      title: Type.String(),
      desc: Type.Optional(Type.String()),
    }),
    async execute(_id, params: { title: string; desc?: string }) {
      call('publish_recommend_partition');
      const recommend = options.deps?.recommendPartition ?? recommendBilibiliPartition;
      try {
        const result = await recommend(
          options.settings,
          { title: params.title, desc: params.desc ?? '' },
          { template: options.partitionTemplate, binding: options.partitionBinding },
        );
        return textResult({ ok: true, tid: result.tid });
      } catch (error) {
        return textResult({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  const validateDraft = defineTool({
    name: 'publish_validate_draft',
    label: '校验发布草案',
    description: '校验标题等文案。成片和封面由程序填入。提交前必须通过。',
    parameters: Type.Object({ draft: draftSchema }),
    async execute(_id, params: { draft: PublishIngestDraft }) {
      call('publish_validate_draft');
      const detected = await ensureScan();
      const result = validatePublishIngestDraft(
        applyScanToDraft(params.draft, detected),
        options.workDir,
        fileExists,
      );
      if (!result.ok) {
        validated = false;
        lastValidated = null;
        return textResult({ ok: false, issues: result.issues });
      }
      validated = true;
      lastValidated = result.draft;
      return textResult({ ok: true, draft: {
        title: result.draft.title,
        desc: result.draft.desc,
        tags: result.draft.tags,
        coverPrompt: result.draft.coverPrompt,
        notes: result.draft.notes,
      } });
    },
  });

  const submitDraft = defineTool({
    name: 'publish_submit_draft',
    label: '提交发布草案',
    description: '校验通过后提交文案。成片和封面由程序写入。提交后不会上传。',
    parameters: Type.Object({ draft: draftSchema }),
    async execute(_id, params: { draft: PublishIngestDraft }) {
      call('publish_submit_draft');
      const detected = await ensureScan();
      const result = validatePublishIngestDraft(
        applyScanToDraft(params.draft, detected),
        options.workDir,
        fileExists,
      );
      if (!result.ok) {
        validated = false;
        lastValidated = null;
        return textResult({ ok: false, issues: result.issues });
      }
      const publishDraft = ingestDraftToPublishDraft(result.draft);
      const state: HubJobState = {
        ...emptyHubJobState(),
        ...options.existingState,
        draft: publishDraft,
        coverPrompt: result.draft.coverPrompt ?? options.existingState.coverPrompt,
        notes: result.draft.notes ?? '',
        ingestedAt: Date.now(),
      };
      await options.persistDraft(state);
      await syncMaterialsIfPresent(options.workDir, state);
      validated = true;
      lastValidated = result.draft;
      submitted = state;
      return textResult({
        ok: true,
        title: state.draft.title,
        notes: state.notes,
        message: '发布草案已写入工作目录，等待用户核对后手动发布。',
      }, true);
    },
  });

  return {
    tools: [
      getContext,
      readText,
      generateMetadata,
      generateCoverPrompt,
      recommendPartition,
      validateDraft,
      submitDraft,
    ],
    getSubmittedDraft: () => submitted,
    getToolCallCount: () => toolCallCount,
    getValidated: () => validated && lastValidated != null,
    dispose: async () => undefined,
  };
}

export { syncMaterialsIfPresent };
