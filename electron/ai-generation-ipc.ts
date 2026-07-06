import { app, ipcMain, type BrowserWindow } from 'electron';
import path from 'node:path';
import {
  analyzeSrt,
  generateAnimationDirection,
  generateCardForSegment,
  generateSingleCardFromSubtitles,
  materializeImageCard,
  regenerateAICard,
  regenerateCoverPrompt,
  type SubtitleCardDraftInput,
} from '../src/lib/ai-analysis';
import { resolveStylePresetId } from '../src/lib/card-style';
import { assertCardRenders } from './remotion/smoke-render';
import { createMotionCardAgentProvider, resolveMotionCardModels } from './pipeline/motion-agent-run';
import { makeAgentFeedCallback } from './pipeline/agent-feed';
import { generateCoverCandidates } from '../src/lib/cover-generation';
import { generatePublishMetadata } from '../src/lib/publish-metadata';
import { recommendBilibiliPartition } from '../src/lib/publish-partition-recommend';
import { resolvePromptBinding } from '../src/lib/llm/binding-resolver';
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
  AISegment,
  AISegmentVisualType,
  AISettings,
  ImageAspectRatio,
  PromptBindingMap,
} from '../src/types/ai';
import { loadCardTemplates, loadEffectivePromptTemplate } from './prompts-io';
import { loadProjectFile } from './project-file';
import { resolveWorkTitle } from '../src/lib/project-persistence';
import { makeMainTelemetry } from './telemetry/main-telemetry';

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
  return createMotionCardAgentProvider({
    userDataPath: app.getPath('userData'),
    projectPath: projectDir ?? process.cwd(),
    rolesSeedDir: path.join(app.getAppPath(), 'resources', 'pi-agents', 'agents'),
    onPhase,
    onAgentEvent: makeAgentFeedCallback(feedId),
    ...models,
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
        const result = await analyzeSrt(entries, args.settings, {
          globalPrompt: args.globalPrompt,
          // 项目级默认风格：从 project.json 读取，缺省时为 undefined（下游回退全局/内置默认）。
          projectStylePresetId,
          defaultStylePresetId: args.settings.defaultStylePresetId,
          planningTemplate,
          cardTemplate,
          imageTemplate,
          animationTemplate,
          coverTemplate,
          projectBindings: args.projectBindings ?? null,
          generateCardImage,
          generateMotionCard: makeMotionCardProvider(
            args.projectDir,
            args.settings,
            args.projectBindings ?? null,
            undefined,
            args.feedId,
          ),
          validateMotionSource: assertCardRenders,
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
        projectDir?: string;
        projectBindings?: PromptBindingMap | null;
        feedId?: string;
      },
    ) => {
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
        return await regenerateAICard(args.entries, args.card, args.segment, args.settings, {
          globalPrompt: args.globalPrompt,
          // 单卡覆盖来自 args.card.stylePresetId（lib 层 resolve 时合并）；项目级从 project.json 读取。
          projectStylePresetId,
          defaultStylePresetId: args.settings.defaultStylePresetId,
          cardPrompt: args.cardPrompt,
          programSummary: args.programSummary,
          keywords: args.keywords,
          cardTemplate,
          imageTemplate,
          animationTemplate,
          projectBindings: args.projectBindings ?? null,
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
        projectDir?: string;
        projectBindings?: PromptBindingMap | null;
      },
    ) => {
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
        return await generateAnimationDirection(
          args.entries,
          {
            summary: args.programSummary ?? '',
            keywords: args.keywords ?? [],
            globalPrompt: args.globalPrompt?.trim() || undefined,
          },
          args.segment,
          args.settings,
          {
            cardPrompt: args.cardPrompt,
            animationTemplate,
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
        projectDir?: string;
        projectBindings?: PromptBindingMap | null;
        segmentIndex?: number;
        totalSegments?: number;
        prevSegment?: AISegment;
        nextSegment?: AISegment;
        visualType?: AISegmentVisualType;
        feedId?: string;
      },
    ) => {
      writeAppLog(
        'info',
        'ai-analysis',
        '收到失败段卡片补生成请求',
        `segmentId=${args.segment.id}, entries=${args.entries.length}`,
      );

      try {
        const userDataPath = app.getPath('userData');
        const { cardTemplate, imageTemplate, animationTemplate } = await loadCardTemplates({
          userDataPath,
          projectDir: args.projectDir,
        });
        const projectStylePresetId = await loadProjectStylePresetId(args.projectDir);
        let card = await generateCardForSegment(
          args.entries,
          {
            summary: args.programSummary ?? '',
            keywords: args.keywords ?? [],
            globalPrompt: args.globalPrompt?.trim() || undefined,
          },
          args.segment,
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
            generateMotionCard: makeMotionCardProvider(
              args.projectDir,
              args.settings,
              args.projectBindings ?? null,
              undefined,
              args.feedId,
            ),
            validateMotionSource: assertCardRenders,
            segmentIndex: args.segmentIndex,
            totalSegments: args.totalSegments,
            prevSegment: args.prevSegment,
            nextSegment: args.nextSegment,
            visualType: args.visualType ?? 'motion',
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
        projectDir?: string;
        projectBindings?: PromptBindingMap | null;
        feedId?: string;
      },
    ) => {
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
          cardTemplate,
          imageTemplate,
          animationTemplate,
          projectBindings: args.projectBindings ?? null,
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
      },
    ) => {
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
          workTitle: await loadProjectWorkTitle(args.projectDir),
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
        projectDir: string;
        projectBindings?: PromptBindingMap | null;
        telemetryRunId?: string | null;
        /** 画幅比例（发布选项卡按 16:9 / 4:3 / 3:4 生成）；缺省 16:9。 */
        aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
        /** 每条 prompt 生成的候选数量；缺省 4。 */
        n?: number;
      },
    ) => {
      const telemetry = makeMainTelemetry(args.telemetryRunId);
      const coverStart = Date.now();
      telemetry.emit('stage.start', { stage: 'cover', prompts: args.prompts.length });
      const coversDir = path.join(args.projectDir, 'covers');
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
