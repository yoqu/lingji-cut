import { app, ipcMain, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  analyzeSrt,
  generateAnimationDirection,
  generateCardForSegment,
  generateSingleCardFromSubtitles,
  materializeImageCard,
  regenerateAICard,
  regenerateCoverPrompt,
  type MotionCardAgentProvider,
  type ResolveCardAssetsFn,
  type SegmentPlanningResult,
  type SubtitleCardDraftInput,
} from '../src/lib/ai-analysis';
import { resolveStylePresetId } from '../src/lib/card-style';
import { assertCardRenders } from './remotion/smoke-render';
import {
  createMotionCardAgentProvider,
  resolveMotionCardModels,
  resolveMotionCardVisualModelCandidates,
} from './pipeline/motion-agent-run';
import { buildHybridSelectionFromPlan, type HybridSegmentDecision } from './pipeline/motion-hybrid';
import { makeAgentFeedCallback } from './pipeline/agent-feed';
import { generateCoverCandidates } from '../src/lib/cover-generation';
import {
  buildMetadataSource,
  buildWorkTitlePatch,
  generatePublishMetadata,
} from '../src/lib/publish-metadata';
import { recommendBilibiliPartition } from '../src/lib/publish-partition-recommend';
import { resolvePromptBinding } from '../src/lib/llm/binding-resolver';
import { getImageProvider } from '../src/lib/image-gen/registry';
import {
  handleGenerateCardImage,
  handleGenerateCardVideo,
  type GenerateCardImageArgs,
  type GenerateCardVideoArgs,
} from './card-media-handlers';
import { parseSrt } from '../src/lib/srt-parser';
import type { SrtEntry } from '../src/types';
import type {
  AICard,
  AIAnalysisResult,
  AISegment,
  AISegmentVisualType,
  AISettings,
  ImageAspectRatio,
  PromptBindingMap,
} from '../src/types/ai';
import { loadCardTemplates, loadEffectivePromptTemplate } from './prompts-io';
import { loadProjectFile, mutateProjectProduction, saveProjectSection } from './project-file';
import { resolveWorkTitle } from '../src/lib/project-persistence';
import { emitProjectUpdated } from './pipeline/headless-generation';
import { makeMainTelemetry } from './telemetry/main-telemetry';
import {
  resolveAssetRequestsForProject,
  type GenerateMissingAssetFileFn,
} from './asset-library';
import type { AssetGenerationRequest } from '../src/types/assets';
import type { TelemetryHook } from '../src/lib/telemetry/auto-run';
import type {
  DirectorCompositionIntent,
  DirectorFallbackPolicy,
  DirectorRenderStrategy,
} from '../src/types/director';
import type { FootageCompositionInput } from '../src/types/footage';
import { runShowDirectorAgent } from './director-agent/show-director-run';
import { makeKacutDigestProvider } from './footage/kacut-client';
import {
  DirectorApprovalRequiredError,
  generateCardsFromDirectorPlan,
} from '../src/lib/director-production';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import {
  ApprovedDirectorSegmentMismatchError,
  requireApprovedAnimationDirectionContext,
  requireApprovedCardRegenerationContext,
  requireExactApprovedDirectorSegment,
} from '../src/lib/director-regeneration-context';
import { resolveFfmpegPath } from './runtime-binaries';

export interface AiGenerationIpcContext {
  getMainWindow: () => BrowserWindow | null;
  writeAppLog: (level: 'info' | 'warn' | 'error', scope: string, message: string, details?: string) => void;
}

/**
 * 读取项目级默认风格预设 id（项目 → 全局 → 内置默认 优先级中的"项目"层）。
 * 旧工程缺该字段时返回 undefined，由下游 resolveStylePresetId 回退到全局/内置默认。
 * 无 projectDir（如纯渲染态调用）时同样返回 undefined。
 */
async function loadProjectStylePresetId(projectDir?: string): Promise<string | undefined> {
  if (!projectDir) return undefined;
  try {
    const data = await loadProjectFile(projectDir);
    return data.stylePresetId;
  } catch {
    return undefined;
  }
}

/** 读取作品标题（meta.title → publish.title 回退）；无 projectDir 或读取失败返回 undefined。 */
async function loadProjectWorkTitle(projectDir?: string): Promise<string | undefined> {
  if (!projectDir) return undefined;
  try {
    return resolveWorkTitle(await loadProjectFile(projectDir)) || undefined;
  } catch {
    return undefined;
  }
}

async function requireApprovedDirector(projectDir?: string) {
  if (!projectDir) throw new DirectorApprovalRequiredError();
  const project = await loadProjectFile(projectDir);
  if (!project.production?.approvedPlan?.approvedAt) {
    throw new DirectorApprovalRequiredError();
  }
  return project;
}

/**
 * Motion TSX 生成唯一路径：pi 多 agent（导演→雕刻→审查）provider 工厂。
 * 所有 motion 卡生成入口（analyze / regenerate / segment 补生成 / 手选字幕 / pipeline）
 * 都注入本 provider；ai-analysis 不再有直连 LLM 回退。
 */
function makeMotionCardProvider(
  projectDir?: string,
  settings?: AISettings,
  projectBindings?: PromptBindingMap | null,
  onPhase?: (phase: string) => void,
  feedId?: string,
): ReturnType<typeof createMotionCardAgentProvider> {
  // 会话级模型：从 cards.animation / cards.segment 提示词绑定解析；无 settings 时跟随 pi 默认。
  const models = settings ? resolveMotionCardModels(settings, projectBindings ?? null) : {};
  const visualModelCandidates = settings
    ? resolveMotionCardVisualModelCandidates(settings, projectBindings ?? null)
    : [];
  return createMotionCardAgentProvider({
    userDataPath: app.getPath('userData'),
    projectPath: projectDir ?? process.cwd(),
    rolesSeedDir: path.join(app.getAppPath(), 'resources', 'pi-agents', 'agents'),
    contactSheetCacheDir: path.join(app.getPath('userData'), 'motion-contact-sheets'),
    ffmpegPath: resolveFfmpegPath({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      cwd: process.cwd(),
      moduleDir: __dirname,
    }),
    onPhase,
    onAgentEvent: makeAgentFeedCallback(feedId),
    ...models,
    visualModelCandidates,
  });
}

/**
 * hybrid 批量预选注入：按段把决议塞进 ctx.hybridDecision（含每期上限截断结果），
 * 保留 ctx.motionCardMode='hybrid' 让编排器遥测 / 里程碑带上分流原因（motionPathReason）。
 * 段不在预选表内（如方案外补生成）时原样透传，由编排器按单卡规则兜底。
 */
function wrapWithHybridSelection(
  provider: MotionCardAgentProvider,
  selection: Map<string, HybridSegmentDecision>,
): MotionCardAgentProvider {
  return async (mctx) => {
    const decision = selection.get(mctx.segmentId);
    return provider(decision ? { ...mctx, hybridDecision: decision } : mctx);
  };
}

async function imageToBuffer(img: {
  url?: string;
  base64?: string;
  mimeType?: string;
}): Promise<Buffer> {
  if (img.base64) return Buffer.from(img.base64, 'base64');
  if (img.url) {
    const res = await fetch(img.url);
    if (!res.ok) throw new Error(`下载资产生成图片失败 HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('image provider 未返回可下载图片');
}

function imageExt(mimeType?: string): string {
  if (mimeType?.includes('jpeg') || mimeType?.includes('jpg')) return '.jpg';
  if (mimeType?.includes('webp')) return '.webp';
  return '.png';
}

function makeAssetImageGenerator(params: {
  projectDir: string;
  settings: AISettings;
  projectBindings: PromptBindingMap | null;
  writeAppLog: AiGenerationIpcContext['writeAppLog'];
  telemetry?: TelemetryHook;
}): GenerateMissingAssetFileFn {
  return async (request: AssetGenerationRequest, context: { signal?: AbortSignal }) => {
    const binding = resolvePromptBinding('card.image', params.settings, params.projectBindings);
    const providerId = binding.imageProvider?.id ?? null;
    const model = binding.imageModel ?? null;
    const provider = providerId
      ? params.settings.imageProviders.find((item) => item.id === providerId) ?? null
      : null;
    if (!provider) {
      throw new Error('card.image 未绑定 ImageProvider，无法自动生成缺失资产');
    }
    if (!model) {
      throw new Error('card.image 未指定模型，无法自动生成缺失资产');
    }

    params.writeAppLog(
      'info',
      'asset-library',
      '开始自动生成 Motion Card 缺失资产',
      `request=${request.id}, query=${request.query}, provider=${provider.id}, model=${model}`,
    );
    const generationStartedAt = Date.now();
    params.telemetry?.emit('asset.generate.start', {
      requestId: request.id,
      role: request.role,
      provider: provider.id,
      model,
    });
    const adapter = getImageProvider(provider.type);
    try {
      const result = await adapter.generate(
      {
        prompt: request.prompt,
        model,
        aspectRatio: request.role === 'background' || request.role === 'texture' ? '16:9' : '1:1',
        n: 1,
      },
      { baseUrl: provider.baseUrl, apiKey: provider.apiKey, extras: provider.extras },
      {
        taskId: `asset-image-${request.id}`,
        signal: context.signal ?? new AbortController().signal,
        onProgress: () => {
          // 资产生成目前随卡片分析运行，细粒度进度先写入 manifest 状态。
        },
      },
    );
      const img = result.images[0];
      if (!img) throw new Error('image provider 未返回图片');
      const buf = await imageToBuffer(img);
      const dir = path.join(params.projectDir, 'assets', 'generated');
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${request.id}${imageExt(img.mimeType)}`);
      await fs.writeFile(filePath, buf);
      const durationMs = Date.now() - generationStartedAt;
      params.telemetry?.emit('asset.generate.end', {
        requestId: request.id,
        provider: provider.id,
        model,
        durationMs,
        ok: true,
      });
      params.writeAppLog(
        'info',
        'asset-library',
        'Motion Card 缺失资产生成完成',
        `request=${request.id}, provider=${provider.id}, model=${model}, durationMs=${durationMs}`,
      );
      return { filePath };
    } catch (error) {
      params.telemetry?.emit('asset.generate.end', {
        requestId: request.id,
        provider: provider.id,
        model,
        durationMs: Date.now() - generationStartedAt,
        ok: false,
        cancelled: context.signal?.aborted === true,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

function makeAssetResolver(params: {
  projectDir?: string;
  settings: AISettings;
  projectBindings: PromptBindingMap | null;
  writeAppLog: AiGenerationIpcContext['writeAppLog'];
  telemetry?: TelemetryHook;
}): ResolveCardAssetsFn | undefined {
  const { projectDir } = params;
  if (!projectDir) return undefined;
  return ({ requests, sourceCardId, signal, layout }) =>
    resolveAssetRequestsForProject({
      projectDir,
      requests,
      sourceCardId,
      signal,
      layout,
      generateMissing: makeAssetImageGenerator({
        projectDir,
        settings: params.settings,
        projectBindings: params.projectBindings,
        writeAppLog: params.writeAppLog,
        telemetry: params.telemetry,
      }),
    });
}

// AI 卡片媒体生成共享的 AbortController 注册表（image / video / cancel 复用）
const cardMediaAbortMap = new Map<string, AbortController>();

export function registerAiGenerationIpc(ctx: AiGenerationIpcContext): void {
  const { getMainWindow, writeAppLog } = ctx;

  // 统一的失败日志（各 handler catch 里 log-and-rethrow 共用）
  const logAiError = (message: string, error: unknown): void => {
    writeAppLog(
      'error',
      'ai-analysis',
      message,
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
  };

  ipcMain.handle(
    'analyze-srt',
    async (
      _event,
      args: {
        entries?: SrtEntry[];
        srtContent?: string;
        settings: AISettings;
        globalPrompt?: string;
        projectDir?: string;
        projectBindings?: PromptBindingMap | null;
        /** 一键流水线传过来的运行 ID；用于把内部耗时事件写进 auto-run jsonl */
        telemetryRunId?: string | null;
        /** 观测面板关联键（渲染端任务 id）；缺省不上报 agent 观测事件。 */
        feedId?: string;
      },
    ) => {
      writeAppLog(
        'info',
        'ai-analysis',
        '收到字幕分析请求',
        `entries=${args.entries?.length ?? 0}, hasSrtContent=${Boolean(args.srtContent)}`,
      );
      const entries = Array.isArray(args.entries) && args.entries.length > 0
        ? args.entries
        : parseSrt(args.srtContent ?? '');
      try {
        const userDataPath = app.getPath('userData');
        const directorTemplate = await loadEffectivePromptTemplate('production.director', {
          userDataPath,
          projectDir: args.projectDir,
        });
        const planningTemplate = await loadEffectivePromptTemplate('planning.segment', {
          userDataPath,
          projectDir: args.projectDir,
        });
        const { cardTemplate, imageTemplate, animationTemplate } = await loadCardTemplates({
          userDataPath,
          projectDir: args.projectDir,
        });
        const coverTemplate = await loadEffectivePromptTemplate('cover.regeneration', {
          userDataPath,
          projectDir: args.projectDir,
        });
        const motionBibleTemplate = await loadEffectivePromptTemplate('motion.bible', {
          userDataPath,
          projectDir: args.projectDir,
        });
        const publishTemplate = await loadEffectivePromptTemplate('publish.metadata', {
          userDataPath,
          projectDir: args.projectDir,
        });
        // 作品标题：planning 完成后生成（fill-if-empty），落盘 meta + publish（title 镜像）。
        const generateWorkTitle = args.projectDir
          ? async (planning: SegmentPlanningResult): Promise<string | null> => {
              const projectDir = args.projectDir!;
              try {
                const existing = await loadProjectWorkTitle(projectDir);
                if (existing) return existing;
                const sourceText = buildMetadataSource(planning, '');
                if (!sourceText.trim()) return null;
                const binding = resolvePromptBinding(
                  'publish.metadata',
                  args.settings,
                  args.projectBindings ?? null,
                );
                const md = await generatePublishMetadata(
                  args.settings,
                  { sourceText },
                  { template: publishTemplate, binding },
                );
                const data = await loadProjectFile(projectDir);
                const patch = buildWorkTitlePatch(data, md);
                await saveProjectSection(projectDir, 'meta', patch.meta);
                await saveProjectSection(projectDir, 'publish', patch.publish);
                emitProjectUpdated(getMainWindow, projectDir, ['meta', 'publish']);
                writeAppLog('info', 'publish', '作品标题已生成', md.title);
                return md.title;
              } catch (error) {
                writeAppLog(
                  'warn',
                  'publish',
                  '作品标题生成失败（封面将无标题继续）',
                  error instanceof Error ? error.message : String(error),
                );
                return null;
              }
            }
          : undefined;
        const projectStylePresetId = await loadProjectStylePresetId(args.projectDir);
        // 仅当 renderer 提供了 projectDir 时，才把 image 卡片物化能力注入；
        // 否则 LLM 仍可吐出 image 类型 prompt，但保留 generationStatus='pending'，
        // 用户后续可在 Inspector 手动触发 generate-card-image 完成。
        const generateCardImage = args.projectDir
          ? async (invoke: {
              cardId: string;
              prompt: string;
              aspectRatio: ImageAspectRatio;
              segmentId: string;
            }) => {
              return handleGenerateCardImage(
                {
                  projectDir: args.projectDir!,
                  cardId: invoke.cardId,
                  prompt: invoke.prompt,
                  aspectRatio: invoke.aspectRatio,
                },
                {
                  settings: args.settings,
                  projectBindings: args.projectBindings ?? null,
                  onProgress: () => {
                    // analyze-srt 主进度由 onProgress 已覆盖；图像生成内部进度暂不上报
                  },
                },
              );
            }
          : undefined;
        const telemetry = makeMainTelemetry(args.telemetryRunId);
        const resolveCardAssets = makeAssetResolver({
          projectDir: args.projectDir,
          settings: args.settings,
          projectBindings: args.projectBindings ?? null,
          writeAppLog,
          telemetry,
        });
        const baseMotionCardProvider = makeMotionCardProvider(
          args.projectDir,
          args.settings,
          args.projectBindings ?? null,
          undefined,
          args.feedId,
        );
        // hybrid 模式：批量预选（含每期上限）依赖批准后的导演方案全量段 + Motion Bible，
        // 这里按调用时读取的引用懒注入，与 headless analyze-run 的装配同款；
        // 非 hybrid 或方案未就绪时原样透传，由编排器按单卡规则兜底。
        let hybridSelection: Map<string, HybridSegmentDecision> | null = null;
        const generateMotionCard: MotionCardAgentProvider = async (mctx) => {
          const decision = hybridSelection?.get(mctx.segmentId);
          return baseMotionCardProvider(decision ? { ...mctx, hybridDecision: decision } : mctx);
        };
        const commonCardOptions = {
          stylePresetId: resolveStylePresetId({
            project: projectStylePresetId,
            global: args.settings.defaultStylePresetId,
          }),
          cardTemplate,
          imageTemplate,
          animationTemplate,
          projectBindings: args.projectBindings ?? null,
          resolveCardAssets,
          generateMotionCard,
          validateMotionSource: assertCardRenders,
          telemetry,
        };
        let result: AIAnalysisResult;
        if (args.projectDir) {
          const taskId = args.feedId ?? `analyze-srt-${Date.now()}`;
          const project = await loadProjectFile(args.projectDir);
          const production = project.production ?? createEmptyProductionState();
          const revision = production.draftPlan?.revision
            ?? (production.approvedPlan?.revision ?? 0) + 1;
          await mutateProjectProduction(args.projectDir, {
            kind: 'set-workflow', stage: 'director-planning', mode: 'auto', taskId,
          });
          const draft = await runShowDirectorAgent({
            userDataPath: app.getPath('userData'),
            projectDir: args.projectDir,
            resourcesRoot: path.join(app.getAppPath(), 'resources', 'pi-agents'),
            entries,
            settings: args.settings,
            revision,
            globalPrompt: args.globalPrompt,
            directorTemplate,
            projectBindings: args.projectBindings ?? null,
            telemetry,
            ffmpegPath: resolveFfmpegPath({
              appPath: app.getAppPath(),
              resourcesPath: process.resourcesPath,
              cwd: process.cwd(),
              moduleDir: __dirname,
            }),
            onProgress: (phase, percent) => {
              getMainWindow()?.webContents.send('analyze-progress', {
                phase,
                percent: phase === 'planning' ? Math.round(percent * 0.6) : 60 + Math.round(percent * 0.2),
              });
            },
          });
          emitProjectUpdated(getMainWindow, args.projectDir, ['production', 'meta', 'publish']);
          const approved = await mutateProjectProduction(args.projectDir, {
            kind: 'approve-draft', expectedRevision: revision, taskId,
          });
          const approvedPlan = approved.approvedPlan!;
          if (args.settings.motionCardMode === 'hybrid') {
            // hybrid 预选：与 headless analyze-run 共用同一构建（规则 + 每期上限截断）。
            hybridSelection = buildHybridSelectionFromPlan(approvedPlan);
          }
          await generateWorkTitle?.({
            segments: approvedPlan.segments,
            coverPrompts: approvedPlan.coverDirection.prompt ? [approvedPlan.coverDirection.prompt] : [],
            summary: approvedPlan.summary,
            keywords: approvedPlan.keywords,
            globalPrompt: approvedPlan.globalPrompt,
          });
          result = await generateCardsFromDirectorPlan(entries, approvedPlan, args.settings, {
            existingCards: project.aiAnalysis.analysisResult?.cards ?? [],
            generateCardImage,
            cardOptions: commonCardOptions,
            onProgress: (progress) => getMainWindow()?.webContents.send('analyze-progress', progress),
            onCardGenerated: (card, index) => {
              getMainWindow()?.webContents.send('analyze-card-completed', { card, index });
            },
          });
          await mutateProjectProduction(args.projectDir, {
            kind: 'set-output', output: 'cards',
            state: {
              status: result.cardErrors?.length ? 'failed' : 'current',
              directorRevision: revision,
              updatedAt: Date.now(),
              error: result.cardErrors?.length ? `${result.cardErrors.length} 个镜头生成失败` : undefined,
            },
            expectedDirectorRevision: revision,
            expectedTaskId: taskId,
          });
        } else result = await analyzeSrt(entries, args.settings, {
          globalPrompt: args.globalPrompt,
          // 项目级默认风格：从 project.json 读取，缺省时为 undefined（下游回退全局/内置默认）。
          projectStylePresetId,
          defaultStylePresetId: args.settings.defaultStylePresetId,
          planningTemplate,
          directorTemplate,
          cardTemplate,
          imageTemplate,
          animationTemplate,
          coverTemplate,
          motionBibleTemplate,
          projectBindings: args.projectBindings ?? null,
          generateCardImage,
          resolveCardAssets,
          generateMotionCard,
          validateMotionSource: assertCardRenders,
          generateWorkTitle,
          kacutDigestProvider: makeKacutDigestProvider(args.settings),
          onProgress: (progress) => {
            getMainWindow()?.webContents.send('analyze-progress', progress);
          },
          telemetry,
          // 规划完成后立刻把 segments / summary 等回吐给 renderer，
          // 卡片生成与"独立的 cover.regeneration LLM 调用"由 lib 层并行触发。
          // 注意：这里的 coverPrompts 是 planning.segment 模板顺带的 fallback，
          // 真正的封面提示词以 'analyze-cover-prompts-ready' 事件为准。
          onPlanningDone: (planning) => {
            getMainWindow()?.webContents.send('analyze-planning-done', {
              segments: planning.segments,
              coverPrompts: planning.coverPrompts,
              summary: planning.summary,
              keywords: planning.keywords,
              globalPrompt: planning.globalPrompt,
            });
          },
          // 独立 cover.regeneration 调用完成（COVER_REGENERATION 视觉系统）。
          // Track C 收到此事件后才发起 generate-cover-images。
          onCoverPromptsReady: (prompts) => {
            getMainWindow()?.webContents.send('analyze-cover-prompts-ready', { prompts });
          },
          // 单卡生成成功即流式回吐给 renderer（卡片逐张落地），无需等待整批完成。
          onCardGenerated: (card, index) => {
            getMainWindow()?.webContents.send('analyze-card-completed', { card, index });
          },
        });
        writeAppLog(
          'info',
          'ai-analysis',
          '字幕分析完成',
          [
            `cards=${result.cards.length}, coverPrompts=${result.coverPrompts.length}`,
            result.cardErrors?.length
              ? `cardErrors=${result.cardErrors.length}; sample=${result.cardErrors
                  .slice(0, 3)
                  .map((item) => `${item.segmentTitle ?? item.segmentId}: ${item.message}`)
                  .join(' | ')}`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
        return result;
      } catch (error) {
        logAiError('字幕分析失败', error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    'regenerate-ai-card',
    async (
      _event,
      args: {
        entries: SrtEntry[];
        card: AICard;
        segment: AISegment;
        settings: AISettings;
        globalPrompt?: string;
        cardPrompt?: string;
          programSummary?: string;
          keywords?: string[];
          motionBible?: import('../src/types/motion').MotionBible;
          projectDir?: string;
          projectBindings?: PromptBindingMap | null;
          feedId?: string;
          refineExistingMotion?: boolean;
      },
    ) => {
      const project = await requireApprovedDirector(args.projectDir);
      writeAppLog(
        'info',
        'ai-analysis',
        '收到单卡重生成请求',
        `cardId=${args.card.id}, entries=${args.entries.length}`,
      );

      try {
        const userDataPath = app.getPath('userData');
        const { cardTemplate, imageTemplate, animationTemplate } = await loadCardTemplates({
          userDataPath,
          projectDir: args.projectDir,
        });
        const projectStylePresetId = await loadProjectStylePresetId(args.projectDir);
        const approvedSegment = requireExactApprovedDirectorSegment(project.production, args.segment);
        if (args.card.segmentId !== approvedSegment.id) {
          throw new ApprovedDirectorSegmentMismatchError(
            approvedSegment.id,
            `卡片属于镜头 ${args.card.segmentId}`,
          );
        }
        const directorContext = requireApprovedCardRegenerationContext(
          project.production,
          approvedSegment.id,
        );
        return await regenerateAICard(args.entries, args.card, approvedSegment, args.settings, {
          globalPrompt: args.globalPrompt,
          // 单卡覆盖来自 args.card.stylePresetId（lib 层 resolve 时合并）；项目级从 project.json 读取。
          projectStylePresetId,
          defaultStylePresetId: args.settings.defaultStylePresetId,
          cardPrompt: args.cardPrompt,
          programSummary: args.programSummary,
          keywords: args.keywords,
          motionBible: args.motionBible,
          cardTemplate,
          imageTemplate,
          animationTemplate,
          ...directorContext,
          reuseStoryboardDraft: args.refineExistingMotion === true,
          refineExistingMotion: args.refineExistingMotion === true,
          projectBindings: args.projectBindings ?? null,
          resolveCardAssets: makeAssetResolver({
            projectDir: args.projectDir,
            settings: args.settings,
            projectBindings: args.projectBindings ?? null,
            writeAppLog,
          }),
          generateMotionCard: makeMotionCardProvider(
            args.projectDir,
            args.settings,
            args.projectBindings ?? null,
            undefined,
            args.feedId,
          ),
          validateMotionSource: assertCardRenders,
        });
      } catch (error) {
        logAiError('单卡重生成失败', error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    'generate-animation-direction',
    async (
      _event,
      args: {
        entries: SrtEntry[];
        segment: AISegment;
        settings: AISettings;
        globalPrompt?: string;
        programSummary?: string;
        keywords?: string[];
        cardPrompt?: string;
        motionBible?: import('../src/types/motion').MotionBible;
        projectDir?: string;
        projectBindings?: PromptBindingMap | null;
      },
    ) => {
      const project = await requireApprovedDirector(args.projectDir);
      writeAppLog(
        'info',
        'ai-analysis',
        '收到动画指导生成请求',
        `entries=${args.entries.length}`,
      );

      try {
        const userDataPath = app.getPath('userData');
        const animationTemplate = await loadEffectivePromptTemplate('cards.animation', {
          userDataPath,
          projectDir: args.projectDir,
        });
        const stylePresetId = resolveStylePresetId({
          project: await loadProjectStylePresetId(args.projectDir),
          global: args.settings.defaultStylePresetId,
        });
        const { segment: approvedSegment, context: directorContext } = requireApprovedAnimationDirectionContext(
          project.production,
          args.segment,
        );
        return await generateAnimationDirection(
          args.entries,
          {
            summary: args.programSummary ?? '',
            keywords: args.keywords ?? [],
            globalPrompt: args.globalPrompt?.trim() || undefined,
          },
          approvedSegment,
          args.settings,
          {
            cardPrompt: args.cardPrompt,
            animationTemplate,
            motionBible: args.motionBible,
            stylePresetId,
            ...directorContext,
            projectBindings: args.projectBindings ?? null,
          },
        );
      } catch (error) {
        logAiError('动画指导生成失败', error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    'generate-ai-card-for-segment',
    async (
      _event,
      args: {
        entries: SrtEntry[];
        segment: AISegment;
        settings: AISettings;
        globalPrompt?: string;
        cardPrompt?: string;
        programSummary?: string;
        keywords?: string[];
        motionBible?: import('../src/types/motion').MotionBible;
        projectDir?: string;
        projectBindings?: PromptBindingMap | null;
        segmentIndex?: number;
        totalSegments?: number;
        prevSegment?: AISegment;
        nextSegment?: AISegment;
        visualType?: AISegmentVisualType;
        renderStrategy?: DirectorRenderStrategy;
        compositionIntent?: DirectorCompositionIntent;
        compositionInputs?: FootageCompositionInput[];
        fallbackPolicy?: DirectorFallbackPolicy;
        approvedFallbackExecution?: 'motion';
        qualityMode?: 'auto' | 'director';
        feedId?: string;
        /** 可选 auto-run jsonl runId；传入后为该段卡片生成写遥测事件。 */
        telemetryRunId?: string | null;
      },
    ) => {
      const project = await requireApprovedDirector(args.projectDir);
      writeAppLog(
        'info',
        'ai-analysis',
        '收到失败段卡片补生成请求',
        `segmentId=${args.segment.id}, entries=${args.entries.length}`,
      );

      try {
        const userDataPath = app.getPath('userData');
        const telemetry = makeMainTelemetry(args.telemetryRunId);
        const { cardTemplate, imageTemplate, animationTemplate } = await loadCardTemplates({
          userDataPath,
          projectDir: args.projectDir,
        });
        const projectStylePresetId = await loadProjectStylePresetId(args.projectDir);
        const approvedSegment = requireExactApprovedDirectorSegment(project.production, args.segment);
        const approvedSegmentIndex = project.production!.approvedPlan!.segments.findIndex(
          (segment) => segment.id === approvedSegment.id,
        );
        const directorContext = requireApprovedCardRegenerationContext(
          project.production,
          approvedSegment.id,
          {
            renderStrategy: args.renderStrategy,
            compositionIntent: args.compositionIntent,
            compositionInputs: args.compositionInputs,
            fallbackPolicy: args.fallbackPolicy,
            approvedFallbackExecution: args.approvedFallbackExecution,
          },
        );
        // hybrid 模式：一键 / 导演四轨的逐段生成走这里——从项目 approvedPlan 做批量预选
        //（与 analyze-run 同一构建，含每期上限），把本段决议注入编排器；
        // 方案缺失或本段不在方案内时原样透传，由编排器按单卡规则兜底。
        const segmentHybridSelection = args.settings.motionCardMode === 'hybrid' && args.projectDir
          ? await loadProjectFile(args.projectDir)
              .then((project) => project.production?.approvedPlan ?? null)
              .then((plan) => (plan ? buildHybridSelectionFromPlan(plan) : null))
              .catch(() => null)
          : null;
        const baseSegmentProvider = makeMotionCardProvider(
          args.projectDir,
          args.settings,
          args.projectBindings ?? null,
          undefined,
          args.feedId,
        );
        let card = await generateCardForSegment(
          args.entries,
          {
            summary: args.programSummary ?? '',
            keywords: args.keywords ?? [],
            globalPrompt: args.globalPrompt?.trim() || undefined,
          },
          approvedSegment,
          args.settings,
          {
            globalPrompt: args.globalPrompt,
            // 失败段补生成无单卡覆盖；按 项目 → 全局 → 内置默认 解析。
            // generateCardForSegment 只接受预解析的 stylePresetId，故在此就地合并 project/global 层。
            stylePresetId: resolveStylePresetId({
              project: projectStylePresetId,
              global: args.settings.defaultStylePresetId,
            }),
            cardPrompt: args.cardPrompt,
            cardTemplate,
            imageTemplate,
            animationTemplate,
            projectBindings: args.projectBindings ?? null,
            resolveCardAssets: makeAssetResolver({
              projectDir: args.projectDir,
              settings: args.settings,
              projectBindings: args.projectBindings ?? null,
              writeAppLog,
            }),
            generateMotionCard: segmentHybridSelection
              ? wrapWithHybridSelection(baseSegmentProvider, segmentHybridSelection)
              : baseSegmentProvider,
            validateMotionSource: assertCardRenders,
            segmentIndex: approvedSegmentIndex,
            totalSegments: project.production!.approvedPlan!.segments.length,
            prevSegment: project.production!.approvedPlan!.segments[approvedSegmentIndex - 1],
            nextSegment: project.production!.approvedPlan!.segments[approvedSegmentIndex + 1],
            visualType: args.approvedFallbackExecution === 'motion'
              ? 'motion'
              : approvedSegment.visualType ?? 'motion',
            renderStrategy: directorContext.renderStrategy,
            compositionIntent: directorContext.compositionIntent,
            compositionInputs: directorContext.compositionInputs,
            fallbackPolicy: directorContext.fallbackPolicy,
            qualityMode: args.qualityMode ?? 'auto',
            telemetry,
          },
        );

        if (card.type === 'image' && args.projectDir) {
          card = await materializeImageCard(card, async (invoke) =>
            handleGenerateCardImage(
              {
                projectDir: args.projectDir!,
                cardId: invoke.cardId,
                prompt: invoke.prompt,
                aspectRatio: invoke.aspectRatio,
              },
              {
                settings: args.settings,
                projectBindings: args.projectBindings ?? null,
                onProgress: (update) => {
                  getMainWindow()?.webContents.send('card-media-progress', {
                    cardId: invoke.cardId,
                    percent: update.percent,
                    phase: update.phase,
                    message: update.message,
                    taskId: `card-media-${invoke.cardId}`,
                  });
                },
              },
            ),
          );
        }

        return card;
      } catch (error) {
        logAiError('失败段卡片补生成失败', error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    'generate-card-from-subtitles',
    async (
      _event,
      args: {
        entries: SrtEntry[];
        draft: SubtitleCardDraftInput;
        settings: AISettings;
        globalPrompt?: string;
        programSummary?: string;
        keywords?: string[];
        motionBible?: import('../src/types/motion').MotionBible;
        projectDir?: string;
        projectBindings?: PromptBindingMap | null;
        feedId?: string;
      },
    ) => {
      await requireApprovedDirector(args.projectDir);
      writeAppLog(
        'info',
        'ai-analysis',
        '收到字幕手选卡片生成请求',
        `entries=${args.entries.length}, type=${args.draft.type}, textLen=${args.draft.text.length}`,
      );

      try {
        const userDataPath = app.getPath('userData');
        const { cardTemplate, imageTemplate, animationTemplate } = await loadCardTemplates({
          userDataPath,
          projectDir: args.projectDir,
        });
        const projectStylePresetId = await loadProjectStylePresetId(args.projectDir);
        return await generateSingleCardFromSubtitles(args.entries, args.draft, args.settings, {
          globalPrompt: args.globalPrompt,
          // 手动选段是新卡片，无单卡覆盖；项目级从 project.json 读取。
          projectStylePresetId,
          defaultStylePresetId: args.settings.defaultStylePresetId,
          programSummary: args.programSummary,
          keywords: args.keywords,
          motionBible: args.motionBible,
          cardTemplate,
          imageTemplate,
          animationTemplate,
          projectBindings: args.projectBindings ?? null,
          resolveCardAssets: makeAssetResolver({
            projectDir: args.projectDir,
            settings: args.settings,
            projectBindings: args.projectBindings ?? null,
            writeAppLog,
          }),
          generateMotionCard: makeMotionCardProvider(
            args.projectDir,
            args.settings,
            args.projectBindings ?? null,
            undefined,
            args.feedId,
          ),
          validateMotionSource: assertCardRenders,
        });
      } catch (error) {
        logAiError('字幕手选卡片生成失败', error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    'regenerate-cover-prompt',
    async (
      _event,
      args: {
        entries: SrtEntry[];
        settings: AISettings;
        globalPrompt?: string;
        currentPrompt?: string;
        projectDir?: string;
        projectBindings?: PromptBindingMap | null;
        /** 发布中心 / 无项目封面：跳过导演审批门禁。 */
        skipDirectorGate?: boolean;
        /** 显式作品标题（无 project.json 可读时传入）。 */
        workTitle?: string;
      },
    ) => {
      if (!args.skipDirectorGate) await requireApprovedDirector(args.projectDir);
      writeAppLog(
        'info',
        'ai-analysis',
        '收到封面提示词重生成请求',
        `entries=${args.entries.length}, hasCurrentPrompt=${Boolean(args.currentPrompt)}`,
      );

      try {
        const userDataPath = app.getPath('userData');
        const coverTemplate = await loadEffectivePromptTemplate('cover.regeneration', {
          userDataPath,
          projectDir: args.projectDir,
        });
        const projectStylePresetId = await loadProjectStylePresetId(args.projectDir);
        return await regenerateCoverPrompt(args.entries, args.settings, {
          globalPrompt: args.globalPrompt,
          // 项目级默认风格：从 project.json 读取，缺省时为 undefined（下游回退全局/内置默认）。
          projectStylePresetId,
          defaultStylePresetId: args.settings.defaultStylePresetId,
          currentPrompt: args.currentPrompt,
          coverTemplate,
          projectBindings: args.projectBindings ?? null,
          workTitle: args.workTitle ?? (await loadProjectWorkTitle(args.projectDir)),
        });
      } catch (error) {
        logAiError('封面提示词重生成失败', error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    'generate-cover-images',
    async (
      _event,
      args: {
        prompts: string[];
        settings: AISettings;
        projectDir?: string;
        /** 显式输出目录（发布中心工作目录）；提供时跳过导演审批门禁。 */
        outputDir?: string;
        projectBindings?: PromptBindingMap | null;
        telemetryRunId?: string | null;
        /** 画幅比例（发布选项卡按 16:9 / 4:3 / 3:4 生成）；缺省 16:9。 */
        aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
        /** 每条 prompt 生成的候选数量；缺省 4。 */
        n?: number;
      },
    ) => {
      if (!args.outputDir) await requireApprovedDirector(args.projectDir);
      const telemetry = makeMainTelemetry(args.telemetryRunId);
      const coverStart = Date.now();
      telemetry.emit('stage.start', { stage: 'cover', prompts: args.prompts.length });
      const coversDir = args.outputDir ?? path.join(args.projectDir!, 'covers');
      const binding = resolvePromptBinding(
        'cover.regeneration',
        args.settings,
        args.projectBindings ?? null,
      );
      if (!binding.imageProvider || !binding.imageModel) {
        throw new Error('cover.regeneration 未绑定 ImageProvider/Model');
      }
      const coverSuffix = (args.settings.globalCoverImagePrompt ?? '').trim();
      const mergedPrompts = args.prompts.map((prompt) => {
        const withCoverSuffix = coverSuffix ? `${prompt.trim()}\n${coverSuffix}` : prompt;
        return withCoverSuffix;
      });
      const total = mergedPrompts.length;
      const coverProgressCtx = {
        taskId: 'cover-generation',
        signal: new AbortController().signal,
        onProgress: (update: { percent?: number; phase?: string; message?: string }) => {
          getMainWindow()?.webContents.send('cover-progress', {
            percent: update.percent ?? 0,
            phase: update.phase ?? 'rendering',
            message: update.message ?? '',
            total,
          });
        },
      };
      try {
        const candidates = await generateCoverCandidates(
          mergedPrompts,
          binding.imageProvider,
          binding.imageModel,
          coversDir,
          coverProgressCtx,
          { aspectRatio: args.aspectRatio, n: args.n },
        );
        telemetry.emit('stage.end', {
          stage: 'cover',
          durationMs: Date.now() - coverStart,
          ok: true,
          total: candidates.length,
          succeeded: candidates.filter((c) => c.imageUrl && !c.error).length,
        });
        return candidates;
      } catch (err) {
        telemetry.emit('stage.end', {
          stage: 'cover',
          durationMs: Date.now() - coverStart,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  );

  ipcMain.handle(
    'generate-publish-metadata',
    async (
      _event,
      args: {
        settings: AISettings;
        sourceText: string;
        currentTitle?: string;
        projectDir?: string;
        projectBindings?: PromptBindingMap | null;
      },
    ) => {
      writeAppLog(
        'info',
        'publish',
        '收到发布文案生成请求',
        `sourceLen=${args.sourceText?.length ?? 0}`,
      );
      try {
        const userDataPath = app.getPath('userData');
        const template = await loadEffectivePromptTemplate('publish.metadata', {
          userDataPath,
          projectDir: args.projectDir,
        });
        const binding = resolvePromptBinding(
          'publish.metadata',
          args.settings,
          args.projectBindings ?? null,
        );
        return await generatePublishMetadata(
          args.settings,
          {
            sourceText: args.sourceText,
            currentTitle: args.currentTitle,
          },
          { template, binding },
        );
      } catch (error) {
        writeAppLog(
          'error',
          'publish',
          '发布文案生成失败',
          error instanceof Error ? error.stack ?? error.message : String(error),
        );
        throw error;
      }
    },
  );

  ipcMain.handle(
    'recommend-bilibili-partition',
    async (
      _event,
      args: {
        settings: AISettings;
        title: string;
        desc: string;
        fallbackSource?: string;
        projectDir?: string;
        projectBindings?: PromptBindingMap | null;
      },
    ) => {
      writeAppLog(
        'info',
        'publish',
        '收到 B站分区推荐请求',
        `titleLen=${args.title?.length ?? 0} descLen=${args.desc?.length ?? 0}`,
      );
      try {
        const userDataPath = app.getPath('userData');
        const template = await loadEffectivePromptTemplate('publish.partition', {
          userDataPath,
          projectDir: args.projectDir,
        });
        const binding = resolvePromptBinding(
          'publish.partition',
          args.settings,
          args.projectBindings ?? null,
        );
        return await recommendBilibiliPartition(
          args.settings,
          {
            title: args.title,
            desc: args.desc,
            fallbackSource: args.fallbackSource,
          },
          { template, binding },
        );
      } catch (error) {
        writeAppLog(
          'error',
          'publish',
          'B站分区推荐失败',
          error instanceof Error ? error.stack ?? error.message : String(error),
        );
        throw error;
      }
    },
  );

  ipcMain.handle(
    'generate-card-image',
    async (
      _event,
      args: GenerateCardImageArgs & {
        settings: AISettings;
        projectBindings?: PromptBindingMap | null;
      },
    ) => {
      await requireApprovedDirector(args.projectDir);
      const prev = cardMediaAbortMap.get(args.cardId);
      prev?.abort();
      const ac = new AbortController();
      cardMediaAbortMap.set(args.cardId, ac);
      try {
        return await handleGenerateCardImage(args, {
          settings: args.settings,
          projectBindings: args.projectBindings ?? null,
          signal: ac.signal,
          onProgress: (u) => {
            getMainWindow()?.webContents.send('card-media-progress', {
              cardId: args.cardId,
              percent: u.percent,
              phase: u.phase,
              message: u.message,
              taskId: `card-media-${args.cardId}`,
            });
          },
        });
      } finally {
        if (cardMediaAbortMap.get(args.cardId) === ac) {
          cardMediaAbortMap.delete(args.cardId);
        }
      }
    },
  );

  ipcMain.handle(
    'generate-card-video',
    async (
      _event,
      args: GenerateCardVideoArgs & {
        settings: AISettings;
        projectBindings?: PromptBindingMap | null;
      },
    ) => {
      await requireApprovedDirector(args.projectDir);
      const prev = cardMediaAbortMap.get(args.cardId);
      prev?.abort();
      const ac = new AbortController();
      cardMediaAbortMap.set(args.cardId, ac);
      try {
        return await handleGenerateCardVideo(args, {
          settings: args.settings,
          projectBindings: args.projectBindings ?? null,
          signal: ac.signal,
          onProgress: (u) => {
            getMainWindow()?.webContents.send('card-media-progress', {
              cardId: args.cardId,
              percent: u.percent,
              phase: u.phase,
              message: u.message,
              taskId: `card-media-${args.cardId}`,
            });
          },
        });
      } finally {
        if (cardMediaAbortMap.get(args.cardId) === ac) {
          cardMediaAbortMap.delete(args.cardId);
        }
      }
    },
  );

  ipcMain.handle('cancel-card-media-generation', async (_event, args: { cardId: string }) => {
    const ac = cardMediaAbortMap.get(args.cardId);
    ac?.abort();
    cardMediaAbortMap.delete(args.cardId);
    return { ok: true as const };
  });

  ipcMain.handle('delete-card-media-assets', async (_event, args: { projectDir: string; cardId: string }) => {
    const { deleteCardAssets } = await import('./ai-card-assets');
    await deleteCardAssets(args.projectDir, args.cardId);
    return { ok: true as const };
  });
}
