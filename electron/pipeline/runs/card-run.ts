import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSrt } from '../../../src/lib/srt-parser';
import { regenerateAICard, generateSingleCardFromSubtitles } from '../../../src/lib/ai-analysis';
import type { SubtitleCardDraftInput } from '../../../src/lib/ai-analysis';
import { planMotionConversion, mergeMotionConversionResult } from '../../../src/lib/ai-card-conversion';
import { handleGenerateCardImage, handleGenerateCardVideo } from '../../card-media-handlers';
import { assertCardRenders } from '../../remotion/smoke-render';
import { createMotionCardAgentProvider, resolveMotionCardModels } from '../motion-agent-run';
import { makeAgentFeedCallback } from '../agent-feed';
import type { MotionCardAgentProvider } from '../../../src/lib/ai-analysis';
import { updateCardInResult } from '../../../src/lib/ai-persistence';
import { loadFullHeadlessAISettings, loadHeadlessProjectBindings } from '../headless-settings';
import { loadCardTemplates } from '../../prompts-io';
import { loadProjectFile } from '../../project-file';
import { HeadlessProjectContext } from '../context';
import { GenerationError } from '../generation-error';
import type { GenerationRunCtx } from '../headless-generation';
import {
  DEFAULT_CARD_STYLE,
  getDefaultTemplate,
} from '../../../src/types/ai';
import type {
  AICard,
  AISegment,
  AIAnalysisResult,
  MediaCardContent,
  CoverCandidate,
} from '../../../src/types/ai';
import type { SrtEntry } from '../../../src/types';
import { requireApprovedDirectorPlan } from '../director-gate';

/** image/video 卡本地重写时的兜底展示时长（ms），复刻 src/store/ai.ts 的 MEDIA_DEFAULT_DURATION_MS。 */
const MEDIA_DEFAULT_DURATION_MS: Record<'image' | 'video', number> = {
  image: 5_000,
  video: 6_000,
};

interface Loaded {
  projectPath: string;
  settings: Awaited<ReturnType<typeof loadFullHeadlessAISettings>>;
  projectBindings: Awaited<ReturnType<typeof loadHeadlessProjectBindings>>;
  result: AIAnalysisResult;
  card: AICard;
  segment: AISegment | undefined;
  entries: SrtEntry[];
  coverCandidates: CoverCandidate[];
}

async function loadForCard(ctx: GenerationRunCtx): Promise<Loaded> {
  const { projectPath, userDataPath } = ctx;
  await requireApprovedDirectorPlan(projectPath);
  const settings = await loadFullHeadlessAISettings(userDataPath);
  const projectBindings = await loadHeadlessProjectBindings(projectPath);
  const data = await loadProjectFile(projectPath);
  const result = data.aiAnalysis?.analysisResult ?? null;
  const cardId = String((ctx.params ?? {}).cardId ?? '');
  const card = result?.cards.find((c) => c.id === cardId);
  if (!result || !card) {
    throw new GenerationError('card_not_found', `卡片不存在: ${cardId}`);
  }
  const segment = result.segments.find((s) => s.id === card.segmentId);
  let entries: SrtEntry[] = [];
  try {
    entries = parseSrt(await readFile(join(projectPath, 'podcast-subtitles.srt'), 'utf-8'));
  } catch {
    // 字幕缺失时回退为空：手动卡（subtitles 路径）不依赖字幕逐字稿。
  }
  return {
    projectPath,
    settings,
    projectBindings,
    result,
    card,
    segment,
    entries,
    coverCandidates: data.aiAnalysis?.coverCandidates ?? [],
  };
}

async function persistCard(l: Loaded, nextCard: AICard): Promise<AICard> {
  const next = updateCardInResult(l.result, nextCard.id, nextCard);
  await new HeadlessProjectContext(l.projectPath).saveSection('aiAnalysis', {
    analysisResult: next,
    coverCandidates: l.coverCandidates,
  });
  return next!.cards.find((c) => c.id === nextCard.id)!;
}

/**
 * 本地把卡片重写为 image/video（无生成，建空 idle media）。
 * 复刻 src/store/ai.ts 的 convertCardToMedia 纯逻辑：seedPrompt = title + segment.summary，
 * 默认 template/style，displayDurationMs 保留有效原值否则取媒体默认。
 */
function mergeMediaConversion(
  card: AICard,
  segment: AISegment | undefined,
  mediaType: 'image' | 'video',
): AICard {
  const seedParts: string[] = [];
  if (card.title?.trim()) seedParts.push(card.title.trim());
  if (segment?.summary?.trim()) seedParts.push(segment.summary.trim());
  const seedPrompt = seedParts.join('\n');

  const defaultDurationMs = MEDIA_DEFAULT_DURATION_MS[mediaType];
  const newContent: MediaCardContent = {
    mediaType,
    assetPath: null,
    aspectRatio: '16:9',
    prompt: seedPrompt,
    providerId: null,
    model: null,
    generationStatus: 'idle',
  };

  return {
    ...card,
    type: mediaType,
    content: newContent,
    template: getDefaultTemplate(mediaType),
    style: { ...DEFAULT_CARD_STYLE[mediaType] },
    displayDurationMs:
      card.displayDurationMs && card.displayDurationMs > 0
        ? card.displayDurationMs
        : defaultDurationMs,
  };
}

type RegenerateFn = (
  entries: SrtEntry[],
  card: AICard,
  segment: AISegment,
  settings: unknown,
  opts: Record<string, unknown>,
) => Promise<AICard>;

interface RegenDeps {
  regenerate?: RegenerateFn;
}

/**
 * Motion TSX 多 agent provider（懒构造）：electron 依赖延迟到真正生成 motion 卡时才加载，
 * 保持 card-run 的 import 图对 vitest 友好（测试 mock regenerate 后不会触达 electron）。
 */
function makeHeadlessMotionCardProvider(ctx: GenerationRunCtx, l: Loaded): MotionCardAgentProvider {
  const { directorModel, sculptorModel } = resolveMotionCardModels(l.settings, l.projectBindings);
  return async (mctx) => {
    const { app } = await import('electron');
    const provider = createMotionCardAgentProvider({
      userDataPath: ctx.userDataPath,
      projectPath: ctx.projectPath,
      rolesSeedDir: join(app.getAppPath(), 'resources', 'pi-agents', 'agents'),
      contactSheetCacheDir: join(ctx.userDataPath, 'motion-contact-sheets'),
      signal: ctx.handle.signal,
      onPhase: (phase) => ctx.handle.update({ phase }),
      // 观测面板关联键与统一进度条的 bridgeId 同值（pipeline:<taskId>）。
      onAgentEvent: makeAgentFeedCallback(`pipeline:${ctx.handle.taskId}`),
      directorModel,
      sculptorModel,
    });
    return provider(mctx);
  };
}

/** 装配 regenerateAICard 的 options，复刻 main.ts 的 regenerate-ai-card 处理体。 */
async function buildRegenerateOptions(
  ctx: GenerationRunCtx,
  l: Loaded,
  refineExistingMotion = false,
): Promise<Record<string, unknown>> {
  const { cardTemplate, imageTemplate, animationTemplate } = await loadCardTemplates({
    userDataPath: ctx.userDataPath,
    projectDir: l.projectPath,
  });
  const projectStylePresetId = (await loadProjectFile(l.projectPath)).stylePresetId;
  return {
    globalPrompt: l.result.globalPrompt,
    projectStylePresetId,
    defaultStylePresetId: l.settings.defaultStylePresetId,
    cardPrompt: l.card.cardPrompt,
    programSummary: l.result.summary,
    keywords: l.result.keywords,
    motionBible: l.result.motionBible,
    cardTemplate,
    imageTemplate,
    animationTemplate,
    animationDirection: refineExistingMotion ? l.card.animationDirection : undefined,
    refineExistingMotion,
    projectBindings: l.projectBindings,
    generateMotionCard: makeHeadlessMotionCardProvider(ctx, l),
    validateMotionSource: assertCardRenders,
  };
}

/** 重新生成整卡（复刻 main 的 regenerate-ai-card 装配，保号 id/segmentId）。 */
export async function runRegenerateCard(ctx: GenerationRunCtx, deps: RegenDeps = {}): Promise<AICard> {
  const regenerate = deps.regenerate ?? (regenerateAICard as unknown as RegenerateFn);
  const l = await loadForCard(ctx);
  if (!l.segment) {
    throw new GenerationError('no_segment', `卡片无对应段落: ${l.card.segmentId}`);
  }
  ctx.handle.update({ phase: '重生成', percent: 20 });
  const opts = await buildRegenerateOptions(ctx, l);
  const generated = await regenerate(l.entries, l.card, l.segment, l.settings, opts);
  ctx.handle.update({ phase: '写入', percent: 90 });
  return persistCard(l, { ...generated, id: l.card.id, segmentId: l.card.segmentId });
}

/**
 * 精雕 motion 卡（refine）：与 runRegenerateCard 同引擎（pi 导演→雕刻→审查），
 * 差异在于①仅接受 motion 卡②可携带用户精雕要求 notes③导演会拿到现有 motionCard.tsx
 * 做针对性诊断（regenerateAICard 传 currentCard → provider 的 existingTsx）。
 */
export async function runSculptCard(ctx: GenerationRunCtx, deps: RegenDeps = {}): Promise<AICard> {
  const regenerate = deps.regenerate ?? (regenerateAICard as unknown as RegenerateFn);
  const l = await loadForCard(ctx);
  if (!l.segment) {
    throw new GenerationError('no_segment', `卡片无对应段落: ${l.card.segmentId}`);
  }
  if (!l.card.motionCard?.tsx && !l.card.motionCard?.tsxPath) {
    throw new GenerationError('not_motion_card', `仅 motion 卡可精雕，卡片 ${l.card.id} 无 motionCard 源码`);
  }
  ctx.handle.update({ phase: '精雕', percent: 10 });
  const opts = await buildRegenerateOptions(ctx, l, true);
  const notes = String((ctx.params ?? {}).notes ?? '').trim();
  if (notes) {
    opts.cardPrompt = [l.card.cardPrompt, `精雕要求：${notes}`].filter(Boolean).join('\n');
  }
  const generated = await regenerate(l.entries, l.card, l.segment, l.settings, opts);
  ctx.handle.update({ phase: '写入', percent: 90 });
  return persistCard(l, { ...generated, id: l.card.id, segmentId: l.card.segmentId });
}

interface MediaDeps {
  generateImage?: typeof handleGenerateCardImage;
  generateVideo?: typeof handleGenerateCardVideo;
}

/** 仅重新生成 image/video 卡的媒体素材（复用卡片现有 content 的 prompt/aspectRatio/provider/model）。 */
export async function runRegenerateCardMedia(
  ctx: GenerationRunCtx,
  deps: MediaDeps = {},
): Promise<AICard> {
  const l = await loadForCard(ctx);
  if (l.card.type !== 'image' && l.card.type !== 'video') {
    throw new GenerationError(
      'not_media_card',
      `仅 image/video 卡可重生成媒体，实际为 ${l.card.type}`,
    );
  }
  const content = (l.card.content ?? {}) as unknown as Record<string, unknown>;
  const cmnCtx = {
    settings: l.settings,
    projectBindings: l.projectBindings,
    onProgress: () => {},
    signal: ctx.handle.signal,
  };
  const base = {
    projectDir: l.projectPath,
    cardId: l.card.id,
    prompt: String(content.prompt ?? l.card.title ?? ''),
    negativePrompt: content.negativePrompt as string | undefined,
    aspectRatio: (content.aspectRatio ?? '16:9') as never,
    providerId: content.providerId as string | undefined,
    model: content.model as string | undefined,
    extraParams: content.extraParams as Record<string, unknown> | undefined,
  };
  ctx.handle.update({ phase: '生成媒体', percent: 30 });
  let mediaContent: MediaCardContent;
  if (l.card.type === 'image') {
    mediaContent = await (deps.generateImage ?? handleGenerateCardImage)(base as never, cmnCtx as never);
  } else {
    mediaContent = await (deps.generateVideo ?? handleGenerateCardVideo)(
      {
        ...base,
        durationSeconds: Math.max(1, Math.round((l.card.displayDurationMs ?? 3000) / 1000)),
      } as never,
      cmnCtx as never,
    );
  }
  ctx.handle.update({ phase: '写入', percent: 90 });
  const patch: Partial<AICard> = { content: mediaContent };
  if (l.card.type === 'video' && (mediaContent as { mediaDurationMs?: number }).mediaDurationMs) {
    patch.displayDurationMs = (mediaContent as { mediaDurationMs: number }).mediaDurationMs;
  }
  return persistCard(l, { ...l.card, ...patch });
}

type FromSubtitlesFn = (
  entries: SrtEntry[],
  draft: SubtitleCardDraftInput,
  settings: unknown,
  opts: Record<string, unknown>,
) => Promise<AICard>;

interface ConvertDeps {
  regenerate?: RegenerateFn;
  fromSubtitles?: FromSubtitlesFn;
}

/**
 * 转换卡片类型：
 * - image/video：本地字段重写（建空 idle media，无生成），与 store.convertCardToMedia 一致；
 *   用户随后用 regen-media 出图/视频。
 * - motion：planMotionConversion → segment 走 regenerate / subtitles 走 fromSubtitles → mergeMotionConversionResult。
 */
export async function runConvertCard(ctx: GenerationRunCtx, deps: ConvertDeps = {}): Promise<AICard> {
  const to = String((ctx.params ?? {}).to ?? '');
  const l = await loadForCard(ctx);
  ctx.handle.update({ phase: '转换', percent: 20 });

  if (to === 'image' || to === 'video') {
    const next = mergeMediaConversion(l.card, l.segment, to);
    ctx.handle.update({ phase: '写入', percent: 90 });
    return persistCard(l, next);
  }

  if (to === 'motion') {
    const plan = planMotionConversion(l.card, l.result);
    if (plan.kind === 'noop') {
      return l.card;
    }
    let generated: AICard;
    if (plan.kind === 'segment') {
      const regenerate = deps.regenerate ?? (regenerateAICard as unknown as RegenerateFn);
      const opts = await buildRegenerateOptions(ctx, l);
      generated = await regenerate(l.entries, l.card, plan.segment, l.settings, opts);
    } else {
      const fromSubtitles =
        deps.fromSubtitles ?? (generateSingleCardFromSubtitles as unknown as FromSubtitlesFn);
      const { cardTemplate, imageTemplate, animationTemplate } = await loadCardTemplates({
        userDataPath: ctx.userDataPath,
        projectDir: l.projectPath,
      });
      const projectStylePresetId = (await loadProjectFile(l.projectPath)).stylePresetId;
      generated = await fromSubtitles(l.entries, plan.draft, l.settings, {
        globalPrompt: l.result.globalPrompt,
        projectStylePresetId,
        defaultStylePresetId: l.settings.defaultStylePresetId,
        programSummary: l.result.summary,
        keywords: l.result.keywords,
        motionBible: l.result.motionBible,
        cardTemplate,
        imageTemplate,
        animationTemplate,
        animationDirection: l.card.animationDirection,
        projectBindings: l.projectBindings,
        generateMotionCard: makeHeadlessMotionCardProvider(ctx, l),
        validateMotionSource: assertCardRenders,
      });
    }
    const merged = mergeMotionConversionResult(l.card, generated);
    ctx.handle.update({ phase: '写入', percent: 90 });
    return persistCard(l, merged);
  }

  throw new GenerationError('bad_convert_target', `不支持的转换目标: ${to}（image/video/motion）`);
}
