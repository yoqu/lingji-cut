import type { SrtEntry } from '../types';
import {
  DEFAULT_CARD_DURATION_MS,
  getDefaultCardStyle,
  getDefaultTemplate,
  isAICardType,
  isDataContent,
  normalizeCardGenerationConcurrency,
  type AIAnalysisCardError,
  type AIAnalysisResult,
  type AICard,
  type AICardType,
  type AISegmentAnalysis,
  type AISegment,
  type AISegmentComplexityLevel,
  type AISegmentPacingNeed,
  type AISegmentSemanticType,
  type AISegmentVisualType,
  type AISettings,
  type CardStyle,
  type ImageAspectRatio,
  type MediaCardContent,
  type PromptBindingMap,
} from '../types/ai';
import type { MotionCardPayload } from '../types/motion';
import { generateStructuredData, generateText } from './llm';
import { resolvePromptBinding } from './llm/binding-resolver';
import type { TelemetryHook } from './telemetry/auto-run';
import type { PromptKind } from './prompts/types';
import {
  getBuiltinPromptTemplate,
  renderUserPromptWithLock,
  type PromptTemplate,
} from './prompts';
import { getMotionStyleNotes, getMotionTokensBlock, getStyleFacetBlock, resolveStylePresetId } from './card-style';
import { MOTION_KIT_API_DOC } from '../remotion/motion-kit';
import { compileMotionSource } from './motion-compiler';

export type AnalyzeCardSubStage = 'start' | 'generating-image' | 'done' | 'failed';

export interface AnalyzeCardProgress {
  segmentIndex: number;
  segmentId: string;
  title?: string;
  visualType?: string;
  status: AnalyzeCardSubStage;
  error?: string;
}

export interface AnalyzeSrtProgress {
  phase: 'planning' | 'cards' | 'done';
  percent: number;
  message?: string;
  cardIndex?: number;
  cardTotal?: number;
  card?: AnalyzeCardProgress;
}

/** 把卡片生命周期事件包装成 cards 阶段进度（父进度百分比沿用 30，子任务靠 card 字段驱动）。 */
export function buildCardProgress(card: AnalyzeCardProgress): AnalyzeSrtProgress {
  return { phase: 'cards', percent: 30, card };
}

/**
 * 把段落 LLM 产出的 image cardPrompt 物化成实际图片资产。
 * 主进程通过 `electron/card-media-handlers.ts` 的 handleGenerateCardImage 提供；
 * Renderer / 测试 mock 也可以注入此函数。
 */
export interface GenerateCardImageInvocation {
  cardId: string;
  prompt: string;
  aspectRatio: ImageAspectRatio;
  segmentId: string;
}

export type GenerateCardImageFn = (
  args: GenerateCardImageInvocation,
) => Promise<MediaCardContent>;

/**
 * Motion Card 多 agent 生成上下文：ai-analysis 负责组装全部提示词素材（cue 契约、
 * 风格 facet、模板），以闭包形式交给主进程注入的 provider（pi 导演→雕刻→审查编排器）。
 * Motion TSX 生成没有直连 LLM 回退——未注入 provider 时 motion 段直接抛错。
 */
export interface MotionCardAgentContext {
  segmentId: string;
  segmentTitle: string;
  /** 渲染 cards.animation 模板（导演的任务书）。 */
  buildDirectorPrompt: () => string;
  /** 渲染 cards.segment 模板（雕刻师的任务书）；传入导演产出的 JSON 分镜。 */
  buildCardPrompt: (animationDirection?: string) => string;
  /** 段内逐字稿（±2s 缓冲），供雕刻师忠实取材。 */
  segmentTranscript: string;
  /** 本段逐句字幕句数（与运行时 cues 数组长度一致），供 storyboard 校验 cue 越界。 */
  cueCount?: number;
  /** 风格 tokens JSON 块；供编排器的确定性兜底渲染直接复用。 */
  presetMotionTokens?: string;
  /** 用户已有的动画指导草案；导演须把它当作创作约束。 */
  animationDirectionDraft?: string;
  /** 精雕/重生成时的现有组件源码，导演据此做针对性诊断。 */
  existingTsx?: string;
  /** 冒烟渲染校验（assertCardRenders）；抛错触发编排器内修复循环。 */
  validate?: (tsx: string) => void | Promise<void>;
  label?: string;
  telemetry?: TelemetryHook;
}

export interface MotionCardAgentResult {
  tsx: string;
  /** 导演最终采用的 JSON 分镜（回写 card.animationDirection，Inspector 可见可改）。 */
  animationDirection?: string;
}

export type MotionCardAgentProvider = (
  ctx: MotionCardAgentContext,
) => Promise<MotionCardAgentResult>;

interface AnalyzeSrtOptions {
  maxTokens?: number;
  generateStructuredData?: typeof generateStructuredData;
  generateText?: typeof generateText;
  /** Motion Card 多 agent 生成器（pi 导演→雕刻→审查）；motion 段必需，仅主进程注入。 */
  generateMotionCard?: MotionCardAgentProvider;
  /** 生成期 Motion Card 冒烟渲染校验；抛错触发重生成。仅主进程注入。 */
  validateMotionSource?: (tsx: string) => void | Promise<void>;
  generateCardImage?: GenerateCardImageFn;
  globalPrompt?: string;
  /** 项目级视觉风格预设 ID；注入各 build 函数的 styleSystemBlock。 */
  projectStylePresetId?: string;
  /** 全局默认视觉风格预设 ID；优先级低于项目级。 */
  defaultStylePresetId?: string;
  planningTemplate?: PromptTemplate;
  cardTemplate?: PromptTemplate;
  imageTemplate?: PromptTemplate;
  /** cover.regeneration 模板；提供则一键流水线会在 planning 完成后单独跑一轮
   * 封面提示词生成（COVER_REGENERATION 视觉系统），覆盖 planning 内置的 coverPrompts。 */
  coverTemplate?: PromptTemplate;
  /** cards.animation 模板（导演任务书）；缺省回退内置默认。 */
  animationTemplate?: PromptTemplate;
  projectBindings?: PromptBindingMap | null;
  onProgress?: (progress: AnalyzeSrtProgress) => void;
  /** 一键流水线观测 hook；中途阶段 / 单卡耗时通过这里上报 */
  telemetry?: TelemetryHook;
  /** 规划阶段完成后，先把 planning 结果回吐给主进程，再继续生成卡片，
   * 让 renderer / 主进程能在卡片生成的同时并行启动封面生成。
   *
   * 注意：当上层使用 onCoverPromptsReady 路径时，此回调里的 coverPrompts 仅作 fallback，
   * Track C 应优先等 onCoverPromptsReady 拿到的 COVER_REGENERATION 产物。 */
  onPlanningDone?: (planning: SegmentPlanningResult) => void;
  /** 独立的 cover.regeneration LLM 调用完成时回调，prompts 已遵循 COVER_REGENERATION 视觉系统。
   * 失败时不调用；调用方应使用 onPlanningDone 的 coverPrompts 作为兜底或放弃封面生成。 */
  onCoverPromptsReady?: (prompts: string[]) => void;
  /** planning 完成后生成/取回作品标题；返回值注入 cover.regeneration 的 {{title}}。
   * 生成与落盘（fill-if-empty）由调用方负责；抛错或返回 null 时封面无标题继续。 */
  generateWorkTitle?: (planning: SegmentPlanningResult) => Promise<string | null>;
  /** 单卡生成成功时回调（卡片流式回吐）。每张成功生成的卡片落入 cardSlots[index] 后恰好调用一次。
   * 失败卡片不调用（失败已通过 onProgress 的 card.status==='failed' 暴露）。
   * index 为 planning 顺序中的 segment 下标。 */
  onCardGenerated?: (card: AICard, index: number) => void;
}

interface RegenerateCardOptions {
  generateStructuredData?: typeof generateStructuredData;
  generateText?: typeof generateText;
  /** Motion Card 多 agent 生成器；motion 卡必需，仅主进程注入。 */
  generateMotionCard?: MotionCardAgentProvider;
  /** 生成期 Motion Card 冒烟渲染校验；抛错触发重生成。仅主进程注入。 */
  validateMotionSource?: (tsx: string) => void | Promise<void>;
  globalPrompt?: string;
  projectStylePresetId?: string;
  defaultStylePresetId?: string;
  cardPrompt?: string;
  programSummary?: string;
  keywords?: string[];
  cardTemplate?: PromptTemplate;
  imageTemplate?: PromptTemplate;
  /** cards.animation 模板（动画指导）；缺省回退内置默认。 */
  animationTemplate?: PromptTemplate;
  /** 手动传入的分镜（storyboard）；缺省沿用既有卡片的 animationDirection。 */
  animationDirection?: string;
  projectBindings?: PromptBindingMap | null;
}

interface RegenerateCoverPromptOptions {
  generateStructuredData?: typeof generateStructuredData;
  globalPrompt?: string;
  projectStylePresetId?: string;
  defaultStylePresetId?: string;
  currentPrompt?: string;
  coverTemplate?: PromptTemplate;
  projectBindings?: PromptBindingMap | null;
  /** 作品标题；注入 cover.regeneration 的 {{title}}，空值渲染为"无"。 */
  workTitle?: string;
}

/**
 * 解析指定 PromptKind 的 LLM 绑定。
 *
 * - `projectBindings === null`：无项目级 binding，走 settings.promptBindings / default 回退链
 * - `projectBindings === undefined`：**仅测试 mock 走此路径**。生产路径必须显式传入（null 或 map），
 *   否则会 silently bypass 绑定体系。所有 electron/main.ts IPC 处理器均已显式传入。
 */
function maybeResolveBinding(
  kind: PromptKind,
  settings: AISettings,
  projectBindings: PromptBindingMap | null | undefined,
): ReturnType<typeof resolvePromptBinding> | undefined {
  if (projectBindings === undefined) {
    return undefined;
  }
  return resolvePromptBinding(kind, settings, projectBindings);
}

interface SegmentPlanningResult {
  segments: AISegmentAnalysis[];
  coverPrompts: string[];
  summary: string;
  keywords: string[];
  globalPrompt?: string;
}

const TARGET_PLANNED_SEGMENT_DURATION_MS = 40_000;
const MAX_PLANNED_SEGMENT_DURATION_MS = 60_000;
const MIN_PLANNED_SPLIT_DURATION_MS = 18_000;
const MAX_SEGMENT_EXCERPT_CHARS = 220;

function msToTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1_000;

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function normalizeStyle(type: AICard['type'], style: unknown): CardStyle {
  if (!style || typeof style !== 'object') {
    return getDefaultCardStyle(type);
  }

  const candidate = style as Partial<CardStyle>;
  const defaults = getDefaultCardStyle(type);
  return {
    primaryColor: candidate.primaryColor ?? defaults.primaryColor,
    backgroundColor: candidate.backgroundColor ?? defaults.backgroundColor,
    fontSize: Number.isFinite(candidate.fontSize) ? Number(candidate.fontSize) : defaults.fontSize,
  };
}

// 注意：与 llm/content.ts 的 extractMotionCardSource 语义不同——后者面向 agent 流式
// 产物、会强制 JSX 校验并抛错；这里只剥单层包裹围栏，缺 JSX 由编译层报错。
function stripSourceCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = /^```(?:[a-zA-Z]*)\n([\s\S]*?)\n```$/m.exec(trimmed);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/**
 * 把 LLM 返回的 motionCard 字段编译成可执行 Motion Card payload。
 * 编译失败直接抛错，由外层链路把"请重新生成"提示给用户。
 */
function buildMotionCardPayloadStrict(
  value: unknown,
  promptFallback: string,
): MotionCardPayload {
  if (!value || typeof value !== 'object') {
    throw new Error('LLM 未返回 motionCard；请重新生成');
  }

  const candidate = value as { tsx?: unknown; html?: unknown };
  const rawSource =
    typeof candidate.tsx === 'string' && candidate.tsx.trim()
      ? candidate.tsx
      : typeof candidate.html === 'string'
        ? candidate.html
        : '';
  const tsxSource = stripSourceCodeFences(rawSource);
  if (!tsxSource) {
    throw new Error('LLM 未返回 motionCard.tsx；请重新生成');
  }

  const compiled = compileMotionSource(tsxSource);
  if (!compiled.success) {
    throw new Error(`Motion Card 源码编译失败：${compiled.error}；请重新生成`);
  }

  return {
    tsx: compiled.tsx,
    compiledAt: Date.now(),
    prompt: promptFallback,
    retryCount: 0,
  };
}

function normalizeSemanticType(value: unknown): AISegmentSemanticType {
  return value === 'data' ||
    value === 'explanation' ||
    value === 'chapter-transition' ||
    value === 'quote'
    ? value
    : 'narration';
}

function normalizeComplexityLevel(value: unknown): AISegmentComplexityLevel {
  return value === 'low' || value === 'high' ? value : 'medium';
}

function normalizePacingNeed(value: unknown): AISegmentPacingNeed {
  return value === 'steady' || value === 'transition' ? value : 'accent';
}

function normalizeVisualType(value: unknown): AISegmentVisualType | undefined {
  if (value === 'image' || value === 'motion') return value;
  return undefined;
}

const ALLOWED_IMAGE_ASPECT_RATIOS: ImageAspectRatio[] = ['16:9', '9:16', '1:1', '4:3', '3:4'];

function normalizeImageAspectRatio(
  value: unknown,
  displayMode: 'fullscreen' | 'pip',
): ImageAspectRatio {
  if (typeof value === 'string') {
    const found = ALLOWED_IMAGE_ASPECT_RATIOS.find((r) => r === value);
    if (found) return found;
  }
  return displayMode === 'pip' ? '1:1' : '16:9';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function normalizeSegment(rawSegment: unknown, index: number): AISegmentAnalysis | null {
  if (!rawSegment || typeof rawSegment !== 'object') {
    return null;
  }

  const candidate = rawSegment as Record<string, unknown>;
  const startMs = Number(candidate.startMs);
  const endMs = Number(candidate.endMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }

  return {
    id: typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim() : `segment-${index + 1}`,
    title:
      typeof candidate.title === 'string' && candidate.title.trim()
        ? candidate.title.trim()
        : `段落 ${index + 1}`,
    summary:
      typeof candidate.summary === 'string' && candidate.summary.trim()
        ? candidate.summary.trim()
        : `段落 ${index + 1}`,
    startMs,
    endMs,
    transcriptExcerpt:
      typeof candidate.transcriptExcerpt === 'string' && candidate.transcriptExcerpt.trim()
        ? candidate.transcriptExcerpt.trim()
        : undefined,
    semanticType: normalizeSemanticType(candidate.semanticType),
    complexityLevel: normalizeComplexityLevel(candidate.complexityLevel),
    visualizationScore: Number.isFinite(candidate.visualizationScore)
      ? Math.max(0, Math.min(100, Number(candidate.visualizationScore)))
      : 50,
    pacingNeed: normalizePacingNeed(candidate.pacingNeed),
    keywords: normalizeStringArray(candidate.keywords),
    entities: normalizeStringArray(candidate.entities),
    visualType: normalizeVisualType(candidate.visualType),
  };
}

/**
 * 解析新卡片的展示时长：默认铺满所在 segment（`endMs - startMs`），避免时间轴出现大量空白
 * （此前固定 DEFAULT_CARD_DURATION_MS=5s，导致每段只占 5s、其余留空）。
 * 重生成时若既有卡片已有有效 displayDurationMs（用户可能在 Inspector 改过），则沿用之。
 */
function resolveSegmentCardDurationMs(segment: AISegment, currentCard?: AICard): number {
  if (
    currentCard &&
    Number.isFinite(currentCard.displayDurationMs) &&
    currentCard.displayDurationMs > 0
  ) {
    return Math.round(currentCard.displayDurationMs);
  }
  const spanMs = Math.round(segment.endMs - segment.startMs);
  return spanMs > 0 ? spanMs : DEFAULT_CARD_DURATION_MS;
}

/**
 * image 段直接合成卡片 shell：cards.segment 模板自 v7 起为 motion-only，
 * 不再为 image 段调用 LLM。这里给一个最小合法 image AICard，
 * 真正的中文文生图 prompt 由后续 card.image 链路填充到 cardPrompt / content.prompt。
 */
function buildImageCardShell(params: {
  segment: AISegment;
  cardPrompt?: string;
  currentCard?: AICard;
}): AICard {
  const { segment, cardPrompt, currentCard } = params;
  const previousMedia: Partial<MediaCardContent> =
    currentCard && currentCard.type === 'image' && currentCard.content && typeof currentCard.content === 'object'
      ? (currentCard.content as MediaCardContent)
      : {};
  const displayMode: 'fullscreen' | 'pip' =
    currentCard?.displayMode === 'pip' ? 'pip' : 'fullscreen';
  const aspectRatio: ImageAspectRatio =
    previousMedia.aspectRatio ?? (displayMode === 'pip' ? '1:1' : '16:9');
  const title = segment.title?.trim() || `卡片 ${segment.id}`;
  const placeholderContent: MediaCardContent = {
    mediaType: 'image',
    assetPath: null,
    aspectRatio,
    prompt: cardPrompt?.trim() ?? '',
    providerId: null,
    model: null,
    generationStatus: 'pending',
  };

  return {
    id: currentCard?.id ?? `${segment.id}-card-1`,
    segmentId: segment.id,
    type: 'image',
    title,
    startMs: segment.startMs,
    endMs: segment.endMs,
    displayDurationMs: resolveSegmentCardDurationMs(segment, currentCard),
    displayMode,
    template: currentCard?.template ?? getDefaultTemplate('image'),
    enabled: currentCard?.enabled !== false,
    style: currentCard?.style ?? getDefaultCardStyle('image'),
    cardPrompt: cardPrompt?.trim() || undefined,
    content: placeholderContent,
    renderMode: 'legacy',
  };
}

/**
 * 用模型产出的 Remotion TSX 源码 + segment 元信息合成一张 Motion Card。
 * 新版 cards.segment 只让模型输出 TSX 代码块，type / title / 时间 / 样式等不再由 LLM 决定，
 * 而是从 segment（重生成时叠加 currentCard）合成，规避"模型必须严格产出 JSON"的高失败路径。
 * TSX 编译失败时 buildMotionCardPayloadStrict 抛 "请重新生成"，由上层提示用户重试。
 */
function buildMotionCardShell(params: {
  segment: AISegment;
  tsx: string;
  cardPrompt?: string;
  currentCard?: AICard;
  content?: string;
  animationDirection?: string;
}): AICard {
  const { segment, tsx, cardPrompt, currentCard, content, animationDirection } = params;
  // 沿用既有卡片的语义类型（重生成保持一致）；新卡片默认 'motion'。image/video 不属于 motion 流程。
  const type: AICardType =
    currentCard && currentCard.type !== 'image' && currentCard.type !== 'video'
      ? currentCard.type
      : 'motion';
  const displayMode: 'fullscreen' | 'pip' =
    currentCard?.displayMode === 'pip' ? 'pip' : 'fullscreen';
  const title = currentCard?.title?.trim() || segment.title?.trim() || `卡片 ${segment.id}`;
  const motionCard = buildMotionCardPayloadStrict({ tsx }, cardPrompt?.trim() ?? '');

  return {
    id: currentCard?.id ?? `${segment.id}-card-1`,
    segmentId: segment.id,
    type,
    title,
    startMs: segment.startMs,
    endMs: segment.endMs,
    displayDurationMs: resolveSegmentCardDurationMs(segment, currentCard),
    displayMode,
    template: currentCard?.template ?? getDefaultTemplate(type),
    enabled: currentCard?.enabled !== false,
    style: currentCard?.style ?? getDefaultCardStyle(type),
    cardPrompt: cardPrompt?.trim() || currentCard?.cardPrompt,
    animationDirection: animationDirection?.trim() || undefined,
    content: content ?? '',
    renderMode: 'motion-card',
    motionCard,
  };
}

function normalizeCard(
  rawCard: unknown,
  index: number,
  segmentId: string,
  promptFallback?: string,
  expectedVisualType?: AISegmentVisualType,
): AICard | null {
  if (!rawCard || typeof rawCard !== 'object') {
    return null;
  }

  const candidate = rawCard as Record<string, unknown>;
  let cardType: AICardType | null = isAICardType(candidate.type) ? candidate.type : null;
  // 强制对齐分流策略：上游 visualType 优先于 LLM 自报
  if (expectedVisualType === 'image') {
    cardType = 'image';
  } else if (expectedVisualType === 'motion' && cardType === 'image') {
    cardType = 'motion';
  }
  if (!cardType) return null;

  const startMs = Number(candidate.startMs);
  const endMs = Number(candidate.endMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }

  const cardPrompt =
    typeof candidate.cardPrompt === 'string' && candidate.cardPrompt.trim()
      ? candidate.cardPrompt.trim()
      : promptFallback?.trim() || undefined;
  const displayMode: 'fullscreen' | 'pip' = candidate.displayMode === 'pip' ? 'pip' : 'fullscreen';

  const style = normalizeStyle(cardType, candidate.style);
  const baseFields = {
    id:
      typeof candidate.id === 'string' && candidate.id.trim()
        ? candidate.id.trim()
        : `${segmentId}-card-${index + 1}`,
    segmentId:
      typeof candidate.segmentId === 'string' && candidate.segmentId.trim()
        ? candidate.segmentId.trim()
        : segmentId,
    title: typeof candidate.title === 'string' ? candidate.title : `卡片 ${index + 1}`,
    startMs,
    endMs,
    displayDurationMs:
      Number.isFinite(candidate.displayDurationMs) && Number(candidate.displayDurationMs) > 0
        ? Number(candidate.displayDurationMs)
        : // 模型未给时长则铺满 segment（避免时间轴空白），span 非法再退回固定默认值
          endMs - startMs > 0
          ? Math.round(endMs - startMs)
          : DEFAULT_CARD_DURATION_MS,
    displayMode,
    template:
      typeof candidate.template === 'string' && candidate.template
        ? candidate.template
        : getDefaultTemplate(cardType),
    enabled: candidate.enabled !== false,
    style,
    cardPrompt,
  };

  if (cardType === 'image') {
    // 注意：cards.segment 流程不再要求 LLM 直接产出 cardPrompt（文生图提示词）。
    // 真正的中文 prompt 会在 generateCardForSegment 内部追加一次 card.image LLM 调用后回填，
    // 这里允许 cardPrompt 暂为 undefined，下游 materializeImageCard 在生成前会校验非空。
    const aspectRatio = normalizeImageAspectRatio(
      candidate.imageAspectRatio ?? candidate.aspectRatio,
      displayMode,
    );
    const placeholderContent: MediaCardContent = {
      mediaType: 'image',
      assetPath: null,
      aspectRatio,
      prompt: cardPrompt ?? '',
      providerId: null,
      model: null,
      generationStatus: 'pending',
    };
    return {
      ...baseFields,
      type: 'image',
      content: placeholderContent,
      renderMode: 'legacy',
    };
  }

  // motion 路径必须由 LLM 明确返回 Remotion TSX 组件。
  const content =
    typeof candidate.content === 'string' || isDataContent(candidate.content)
      ? candidate.content
      : '';
  const motionCard = buildMotionCardPayloadStrict(candidate.motionCard, cardPrompt ?? '');

  return {
    ...baseFields,
    type: cardType,
    content,
    renderMode: 'motion-card',
    motionCard,
  };
}

function normalizeCoverPrompts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const prompt = value.find(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  );
  return prompt ? [prompt.trim()] : [];
}

function parseCoverPromptResult(value: unknown): string[] {
  if (!value || typeof value !== 'object') {
    return [];
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.coverPrompt === 'string' && candidate.coverPrompt.trim()) {
    return [candidate.coverPrompt.trim()];
  }

  return normalizeCoverPrompts(candidate.coverPrompts);
}

export function parseSegmentPlanningResult(value: unknown): SegmentPlanningResult | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const segments = Array.isArray(candidate.segments)
    ? candidate.segments
        .map(normalizeSegment)
        .filter((segment): segment is AISegmentAnalysis => segment !== null)
    : [];

  if (segments.length === 0) {
    return null;
  }

  return {
    segments,
    coverPrompts: normalizeCoverPrompts(candidate.coverPrompts),
    summary: typeof candidate.summary === 'string' ? candidate.summary : '',
    keywords: normalizeStringArray(candidate.keywords),
    globalPrompt: typeof candidate.globalPrompt === 'string' ? candidate.globalPrompt : undefined,
  };
}

function collectSegmentEntries(entries: SrtEntry[], startMs: number, endMs: number): SrtEntry[] {
  return entries
    .filter((entry) => entry.endMs > startMs && entry.startMs < endMs)
    .sort((a, b) => a.startMs - b.startMs);
}

function buildTranscriptExcerptForRange(
  entries: SrtEntry[],
  startMs: number,
  endMs: number,
  fallback?: string,
): string | undefined {
  const text = collectSegmentEntries(entries, startMs, endMs)
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const source = text || fallback?.trim();
  if (!source) return undefined;
  return source.length > MAX_SEGMENT_EXCERPT_CHARS
    ? `${source.slice(0, MAX_SEGMENT_EXCERPT_CHARS - 3)}...`
    : source;
}

function findNearestBoundary(
  boundaries: number[],
  idealMs: number,
  lowerMs: number,
  upperMs: number,
): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const boundary of boundaries) {
    if (boundary < lowerMs || boundary > upperMs) continue;
    const distance = Math.abs(boundary - idealMs);
    if (distance < bestDistance) {
      best = boundary;
      bestDistance = distance;
    }
  }
  return best;
}

function splitLongPlannedSegment(
  segment: AISegmentAnalysis,
  entries: SrtEntry[],
): AISegmentAnalysis[] {
  const startMs = Math.max(0, Math.round(segment.startMs));
  const endMs = Math.max(startMs, Math.round(segment.endMs));
  const durationMs = endMs - startMs;
  if (durationMs <= MAX_PLANNED_SEGMENT_DURATION_MS) {
    return [{ ...segment, startMs, endMs }];
  }

  const partCount = Math.max(
    2,
    Math.round(durationMs / TARGET_PLANNED_SEGMENT_DURATION_MS),
  );
  const subtitleBoundaries = Array.from(
    new Set(
      collectSegmentEntries(entries, startMs, endMs)
        .map((entry) => Math.round(entry.endMs))
        .filter((boundary) => boundary > startMs && boundary < endMs),
    ),
  ).sort((a, b) => a - b);

  const boundaries = [startMs];
  let previous = startMs;
  for (let i = 1; i < partCount; i += 1) {
    const remainingParts = partCount - i;
    const ideal = startMs + Math.round((durationMs * i) / partCount);
    const lower = Math.max(
      previous + MIN_PLANNED_SPLIT_DURATION_MS,
      endMs - remainingParts * MAX_PLANNED_SEGMENT_DURATION_MS,
    );
    const upper = Math.min(
      previous + MAX_PLANNED_SEGMENT_DURATION_MS,
      endMs - remainingParts * MIN_PLANNED_SPLIT_DURATION_MS,
    );
    const fallbackLower = Math.min(Math.max(previous + 1, lower), endMs - remainingParts);
    const fallbackUpper = Math.max(fallbackLower, Math.min(upper, endMs - remainingParts));
    const boundary =
      findNearestBoundary(subtitleBoundaries, ideal, lower, upper) ??
      Math.min(fallbackUpper, Math.max(fallbackLower, ideal));

    if (boundary <= previous || boundary >= endMs) break;
    boundaries.push(boundary);
    previous = boundary;
  }
  boundaries.push(endMs);

  const ranges = boundaries
    .slice(0, -1)
    .map((start, index) => ({ startMs: start, endMs: boundaries[index + 1] }))
    .filter((range): range is { startMs: number; endMs: number } =>
      Number.isFinite(range.endMs) && range.endMs > range.startMs,
    );

  if (ranges.length <= 1) {
    return [{ ...segment, startMs, endMs }];
  }

  return ranges.map((range, index) => ({
    ...segment,
    id: `${segment.id}-part-${index + 1}`,
    title: `${segment.title}（${index + 1}/${ranges.length}）`,
    summary: `${segment.summary}（第 ${index + 1}/${ranges.length} 小节）`,
    startMs: range.startMs,
    endMs: range.endMs,
    transcriptExcerpt: buildTranscriptExcerptForRange(
      entries,
      range.startMs,
      range.endMs,
      segment.transcriptExcerpt,
    ),
  }));
}

function enforceSegmentDurationBudget(
  planning: SegmentPlanningResult,
  entries: SrtEntry[],
): SegmentPlanningResult {
  const segments = planning.segments.flatMap((segment) =>
    splitLongPlannedSegment(segment, entries),
  );
  return { ...planning, segments };
}

export function buildSrtText(entries: SrtEntry[]): string {
  return entries
    .map((entry) => `[${msToTimestamp(entry.startMs)} --> ${msToTimestamp(entry.endMs)}] ${entry.text}`)
    .join('\n');
}

const ANCHOR_PREFIX_LENS = [24, 18, 14, 10, 8, 6];

function normalizeForAnchor(text: string): string {
  return text.replace(/[\s，。、！？,.!?"'：:；;（）()…—\-]/g, '');
}

/**
 * 把 LLM 规划出的段落时间重锚定到字幕真实时间轴。
 *
 * 背景：planning.segment 即便拿到带时间码的 SRT，部分模型仍会按自估语速虚构 startMs/endMs，
 * 导致时间整体漂移、甚至排到音频结束之后（卡片错位 + 时间轴大量空白/溢出）。
 * 这里用每段的 transcriptExcerpt 在真实字幕全文里做「单调前缀匹配」（游标只前进，避免错配到
 * 更早出现的重复短语），命中即把该段 startMs 钉到对应字幕条目的真实起点；endMs 由下一段起点决定，
 * 末段收尾到字幕末尾。匹配不到则保留模型原值并钳制到 [prevStart, lastEnd]。
 * 起点已越过字幕末尾的「溢出段落」直接丢弃。
 */
export function anchorSegmentsToTranscript(
  segments: AISegmentAnalysis[],
  entries: SrtEntry[],
): AISegmentAnalysis[] {
  if (entries.length === 0 || segments.length === 0) return segments;
  const lastEnd = entries.reduce((max, e) => Math.max(max, Math.round(e.endMs)), 0);

  // 归一化全文 + 字符位置 → 字幕条目 startMs 映射
  let big = '';
  const pos2ms: number[] = [];
  for (const entry of entries) {
    const n = normalizeForAnchor(entry.text);
    const startMs = Math.round(entry.startMs);
    for (let i = 0; i < n.length; i += 1) pos2ms.push(startMs);
    big += n;
  }

  let cursorChar = 0;
  let prevStart = 0;
  const anchored: AISegmentAnalysis[] = [];
  for (const seg of segments) {
    const excerpt = normalizeForAnchor(seg.transcriptExcerpt ?? '');
    let start: number | null = null;
    for (const len of ANCHOR_PREFIX_LENS) {
      if (excerpt.length < len) continue;
      const idx = big.indexOf(excerpt.slice(0, len), cursorChar);
      if (idx >= 0) {
        start = pos2ms[idx];
        cursorChar = idx + len;
        break;
      }
    }
    if (start === null) {
      start = Math.min(Math.max(Math.round(seg.startMs), prevStart), lastEnd);
    }
    if (start >= lastEnd) continue; // 溢出字幕末尾：丢弃
    anchored.push({ ...seg, startMs: start });
    prevStart = start;
  }

  anchored.sort((a, b) => a.startMs - b.startMs);
  return anchored.map((seg, index) => ({
    ...seg,
    endMs: index + 1 < anchored.length ? anchored[index + 1].startMs : lastEnd,
  }));
}

function truncatePromptValue(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

// 仅截取与 [startMs, endMs] 有重叠的字幕条目，再追加上下 paddingMs 缓冲
// 用于卡片生成时只把"本段及邻接"逐字稿喂给模型，避免每次都注入整篇全文
export function buildSrtTextRange(
  entries: SrtEntry[],
  startMs: number,
  endMs: number,
  paddingMs = 2000,
): string {
  const lo = Math.max(0, startMs - paddingMs);
  const hi = endMs + paddingMs;
  const sliced = entries.filter((entry) => entry.endMs >= lo && entry.startMs <= hi);
  return buildSrtText(sliced);
}

// 仅取与 [startMs, endMs] 精确重叠的字幕条目，逐句拼接其原文（换行分隔，无时间码、无 padding）。
// 用于卡片内容确定性来源：直接还原该段落字幕原文，避免依赖 LLM 改写而丢字/漏句。
export function buildPlainTranscriptRange(
  entries: SrtEntry[],
  startMs: number,
  endMs: number,
): string {
  return entries
    .filter((entry) => entry.endMs > startMs && entry.startMs < endMs)
    .map((entry) => entry.text.trim())
    .filter((text) => text.length > 0)
    .join('\n');
}

// 逐句字幕节拍列表，供 cards.segment 提示词的 {{segmentCues}}：让模型把每个焦点元素锚到"讲出它的那一句"。
// 选取规则必须与渲染期 computeCardCues 完全一致（startMs 落在 [startMs, endMs) 内、按时间升序），
// 这样列表里的索引 k 才与运行时注入卡片组件的 cues 数组一一对应（cues[k] = 第 k 句口播的相对起始帧）。
export function buildSegmentCuesBlock(
  entries: SrtEntry[],
  startMs: number,
  endMs: number,
  maxTextLen = 48,
): string {
  const lines = entries
    .filter((entry) => entry.startMs >= startMs && entry.startMs < endMs)
    .sort((a, b) => a.startMs - b.startMs)
    .map((entry, i) => {
      const sec = ((entry.startMs - startMs) / 1000).toFixed(1);
      const text = entry.text.trim().replace(/\s+/g, ' ');
      const clipped = text.length > maxTextLen ? `${text.slice(0, maxTextLen)}…` : text;
      return `  [${i}] +${sec}s ${clipped}`;
    });
  return lines.length > 0
    ? lines.join('\n')
    : '  （本段无字幕句，cues 为空数组，按兜底均匀铺满）';
}

// 节目级浓缩上下文：只给定位用，不复述全文
function buildProgramContext(params: {
  programSummary?: string;
  keywords?: string[];
  segment: AISegment;
  segmentIndex?: number;
  totalSegments?: number;
  prevSegment?: AISegment;
  nextSegment?: AISegment;
}): string {
  const {
    programSummary,
    keywords = [],
    segment,
    segmentIndex,
    totalSegments,
    prevSegment,
    nextSegment,
  } = params;

  const lines: string[] = [];
  lines.push(`节目摘要：${truncatePromptValue(programSummary ?? '', 160) || '无'}`);
  lines.push(`节目关键词：${keywords.length > 0 ? keywords.join('、') : '无'}`);

  if (typeof segmentIndex === 'number' && typeof totalSegments === 'number' && totalSegments > 0) {
    lines.push(`当前段位置：第 ${segmentIndex + 1} 段，共 ${totalSegments} 段`);
  }
  if (prevSegment) {
    lines.push(`上一段标题：${prevSegment.title || '无'}`);
  }
  if (nextSegment) {
    lines.push(`下一段标题：${nextSegment.title || '无'}`);
  }
  return lines.join('\n');
}

export function buildSegmentPlanningPrompt(
  globalPrompt?: string,
  template?: PromptTemplate,
): string {
  const tpl = template ?? getBuiltinPromptTemplate('planning.segment');
  const trimmed = globalPrompt?.trim();
  const globalPromptLine = trimmed ? `额外创作要求：${trimmed}` : '';
  return renderUserPromptWithLock('planning.segment', tpl, {
    globalPromptLine,
  });
}

export function buildCoverPromptRegenerationPrompt(
  options: {
    globalPrompt?: string;
    currentPrompt?: string;
    stylePresetId?: string;
    workTitle?: string;
  } = {},
  template?: PromptTemplate,
): string {
  const tpl = template ?? getBuiltinPromptTemplate('cover.regeneration');
  const globalPrompt = options.globalPrompt?.trim();
  const currentPrompt = options.currentPrompt?.trim();
  return renderUserPromptWithLock('cover.regeneration', tpl, {
    title: options.workTitle?.trim() || '无',
    globalPrompt: globalPrompt || '无',
    currentPrompt: currentPrompt || '无',
    styleSystemBlock: getStyleFacetBlock(options.stylePresetId, 'cover'),
  });
}

export function buildSegmentCardPrompt(
  params: {
    programContext: string;
    segment: AISegment;
    globalPrompt?: string;
    cardPrompt?: string;
    currentCard?: AICard;
    programSummary?: string;
    keywords?: string[];
    visualType?: AISegmentVisualType;
    stylePresetId?: string;
    /** 本段逐句字幕节拍块（[k] +秒数 文本；索引与运行时 cues 对齐），注入 {{segmentCues}}。 */
    segmentCues?: string;
    /** cards.animation 产出的 JSON 分镜，注入 {{animationDirection}} 指导出卡。 */
    animationDirection?: string;
  },
  template?: PromptTemplate,
): string {
  const {
    programContext,
    segment,
    globalPrompt,
    cardPrompt,
    currentCard,
    programSummary,
    keywords = [],
    visualType,
    stylePresetId,
    segmentCues,
    animationDirection,
  } = params;
  const tpl = template ?? getBuiltinPromptTemplate('cards.segment');

  const currentCardSection = currentCard
    ? [
        '当前卡片线索（仅延续风格，不照抄）：',
        `- id: ${currentCard.id}`,
        `- type: ${currentCard.type}`,
        `- title: ${truncatePromptValue(currentCard.title, 40)}`,
        `- content: ${truncatePromptValue(
          typeof currentCard.content === 'string'
            ? currentCard.content
            : JSON.stringify(currentCard.content),
          180,
        )}`,
        `- displayMode: ${currentCard.displayMode}`,
        `- style: ${currentCard.style.primaryColor}/${currentCard.style.backgroundColor}/${currentCard.style.fontSize}`,
      ].join('\n')
    : '当前卡片线索：无';

  return renderUserPromptWithLock('cards.segment', tpl, {
    globalPrompt: truncatePromptValue(globalPrompt ?? '', 240) || '无',
    programSummary: truncatePromptValue(programSummary ?? '', 180) || '无',
    keywords: keywords.length > 0 ? keywords.join('、') : '无',
    segmentId: segment.id,
    segmentTitle: truncatePromptValue(segment.title, 60),
    segmentSummary: truncatePromptValue(segment.summary, 180),
    segmentStartMs: segment.startMs,
    segmentEndMs: segment.endMs,
    segmentTranscriptExcerpt: truncatePromptValue(segment.transcriptExcerpt ?? '', 260) || '无',
    segmentCues: segmentCues?.trim() ? segmentCues : '  （无逐句字幕节拍可用，按兜底均匀铺满）',
    cardPrompt: truncatePromptValue(cardPrompt ?? '', 240) || '无',
    // JSON 分镜（storyboard）；上限放宽到 4000 保证结构完整，不截断 JSON。
    animationDirection: truncatePromptValue(animationDirection ?? '', 4000) || '无',
    currentCardSection,
    programContext,
    segmentVisualType: visualType ?? 'motion',
    motionKitApi: MOTION_KIT_API_DOC,
    presetMotionTokens: getMotionTokensBlock(stylePresetId),
    presetStyleNotes: getMotionStyleNotes(stylePresetId),
    styleSystemBlock: getStyleFacetBlock(stylePresetId, 'motion'),
    // 旧版自定义模板可能仍在使用 {{fullTranscript}}；这里给它注入与 programContext
    // 同值的浓缩上下文，避免破坏存量模板，同时不再发送整篇全文。
    fullTranscript: programContext,
    sandboxReference:
      'Remotion 单文件 TSX 组件（export default）；从 "remotion" 引入 useCurrentFrame/useVideoConfig/interpolate/spring/Easing/AbsoluteFill/Sequence/Img，输出到 motionCard.tsx；动画必须是 useCurrentFrame() 的纯函数；禁止 fetch/setTimeout/Math.random/new Date 等非确定性 API。图片资源：用全局函数 cardAsset(\'assets/文件名\')（项目相对路径，文件须已存在于项目 assets/ 目录）解析后传给 <Img src={cardAsset(\'assets/x.png\')} />；严禁内联大体积 base64 data URI、严禁绝对路径、严禁 staticFile() 传绝对路径。',
  });
}

/** 渲染 cards.animation 模板：把段落级 / 节目级信息注入动画指导元提示词。 */
export function buildAnimationDirectionPrompt(
  params: {
    segment: AISegment;
    globalPrompt?: string;
    programSummary?: string;
    keywords?: string[];
    cardPrompt?: string;
    segmentCues?: string;
  },
  template?: PromptTemplate,
): string {
  const { segment, globalPrompt, programSummary, keywords = [], cardPrompt, segmentCues } = params;
  const tpl = template ?? getBuiltinPromptTemplate('cards.animation');
  return renderUserPromptWithLock('cards.animation', tpl, {
    globalPrompt: truncatePromptValue(globalPrompt ?? '', 240) || '无',
    programSummary: truncatePromptValue(programSummary ?? '', 180) || '无',
    keywords: keywords.length > 0 ? keywords.join('、') : '无',
    segmentId: segment.id,
    segmentTitle: truncatePromptValue(segment.title, 60),
    segmentStartMs: segment.startMs,
    segmentEndMs: segment.endMs,
    segmentSummary: truncatePromptValue(segment.summary, 180),
    segmentTranscriptExcerpt: truncatePromptValue(segment.transcriptExcerpt ?? '', 260) || '无',
    segmentCues: segmentCues?.trim() ? segmentCues : '  （无逐句字幕节拍可用）',
    cardPrompt: truncatePromptValue(cardPrompt ?? '', 240) || '无',
  });
}

/**
 * 用 cards.animation 模板单独请求 LLM，产出本卡的 JSON 分镜（storyboard）。
 * 仅 motion 卡使用；返回脚本注入 cards.segment 的 {{animationDirection}}，指导出卡动效。
 */
export async function generateAnimationDirection(
  entries: SrtEntry[],
  planning: Pick<SegmentPlanningResult, 'summary' | 'keywords' | 'globalPrompt'>,
  segment: AISegment,
  settings: AISettings,
  options: {
    generateText?: typeof generateText;
    cardPrompt?: string;
    animationTemplate?: PromptTemplate;
    projectBindings?: PromptBindingMap | null;
  } = {},
): Promise<string> {
  const { generateText: requestText = generateText, cardPrompt, animationTemplate, projectBindings } = options;
  const binding = maybeResolveBinding('cards.animation', settings, projectBindings);
  const userMessage = buildAnimationDirectionPrompt(
    {
      segment,
      globalPrompt: planning.globalPrompt,
      programSummary: planning.summary,
      keywords: planning.keywords,
      cardPrompt,
      segmentCues: buildSegmentCuesBlock(entries, segment.startMs, segment.endMs),
    },
    animationTemplate,
  );
  // cards.animation 的指令全在 user 段，传空 system。
  const text = await requestText(settings, '', userMessage, binding);
  return text.trim();
}

/**
 * 渲染 card.image 模板：把段落级 / 节目级 / 当前 image 卡片结构信息注入模板变量。
 * 模板末尾会自动拼接 lockedContract（"只输出一段中文 prompt"）。
 */
export function buildSegmentImagePrompt(
  params: {
    segment: AISegment;
    card: AICard;
    aspectRatio: ImageAspectRatio;
    globalPrompt?: string;
    programSummary?: string;
    keywords?: string[];
    cardPromptHint?: string;
    stylePresetId?: string;
  },
  template?: PromptTemplate,
): string {
  const {
    segment,
    card,
    aspectRatio,
    globalPrompt,
    programSummary,
    keywords = [],
    cardPromptHint,
    stylePresetId,
  } = params;
  const tpl = template ?? getBuiltinPromptTemplate('card.image');
  const cardContent =
    typeof card.content === 'string' && card.content.trim()
      ? card.content
      : segment.summary;
  return renderUserPromptWithLock('card.image', tpl, {
    globalPrompt: globalPrompt?.trim() || '无',
    programSummary: programSummary?.trim() || '无',
    keywords: keywords.length > 0 ? keywords.join('、') : '无',
    segmentId: segment.id,
    segmentTitle: segment.title,
    segmentSummary: segment.summary,
    segmentExcerpt: segment.transcriptExcerpt || '无',
    cardTitle: card.title || segment.title,
    cardContent,
    displayMode: card.displayMode,
    aspectRatio,
    cardPromptHint: cardPromptHint?.trim() || '无',
    styleSystemBlock: getStyleFacetBlock(stylePresetId, 'image'),
  });
}

/**
 * 用 card.image 模板单独请求 LLM，产出**简体中文**文生图 prompt。
 * card.image 的 binding 会同时绑定 LLM + ImageProvider；本函数只用其 LLM 部分。
 */
async function generateImagePromptForSegment(params: {
  segment: AISegment;
  card: AICard;
  settings: AISettings;
  generateText: typeof generateText;
  globalPrompt?: string;
  stylePresetId?: string;
  programSummary?: string;
  keywords?: string[];
  cardPromptHint?: string;
  imageTemplate?: PromptTemplate;
  projectBindings?: PromptBindingMap | null | undefined;
  telemetry?: TelemetryHook;
}): Promise<string> {
  const {
    segment,
    card,
    settings,
    generateText: requestText,
    globalPrompt,
    stylePresetId,
    programSummary,
    keywords,
    cardPromptHint,
    imageTemplate,
    projectBindings,
    telemetry,
  } = params;
  if (card.type !== 'image' || !card.content || typeof card.content !== 'object' || !('mediaType' in card.content)) {
    throw new Error('generateImagePromptForSegment: 仅适用于 image 占位卡片');
  }
  const aspectRatio = (card.content as MediaCardContent).aspectRatio;
  const userMessage = buildSegmentImagePrompt(
    {
      segment,
      card,
      aspectRatio,
      globalPrompt,
      stylePresetId,
      programSummary,
      keywords,
      cardPromptHint,
    },
    imageTemplate,
  );
  const binding = maybeResolveBinding('card.image', settings, projectBindings);
  const label = `card.image(${segment.id})`;
  const startTs = Date.now();
  telemetry?.emit('llm.start', {
    label,
    attempt: 0,
    model: binding?.model ?? null,
    provider: binding?.provider?.id ?? null,
    userChars: userMessage.length,
  });
  // card.image 的 system prompt 完全由模板 user 段承载，传空 system 即可。
  let text: string;
  try {
    text = await requestText(settings, '', userMessage, binding);
  } catch (err) {
    telemetry?.emit('llm.end', {
      label,
      attempt: 0,
      durationMs: Date.now() - startTs,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  telemetry?.emit('llm.end', {
    label,
    attempt: 0,
    durationMs: Date.now() - startTs,
    outputChars: text.length,
    ok: true,
  });
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('card.image LLM 返回空内容；请重新生成');
  }
  return trimmed;
}

export async function planTranscriptSegments(
  entries: SrtEntry[],
  settings: AISettings,
  options: AnalyzeSrtOptions = {},
): Promise<SegmentPlanningResult> {
  const {
    generateStructuredData: requestStructuredData = generateStructuredData,
    globalPrompt,
    planningTemplate,
    projectBindings,
    telemetry,
  } = options;

  if (entries.length === 0) {
    throw new Error('没有可分析的字幕内容');
  }

  const binding = maybeResolveBinding('planning.segment', settings, projectBindings);
  const payload = await requestStructuredData(
    settings,
    buildSegmentPlanningPrompt(globalPrompt, planningTemplate),
    buildSrtText(entries),
    binding,
    { label: 'planning.segment', telemetry },
  );
  const parsed = parseSegmentPlanningResult(payload);
  if (!parsed) {
    throw new Error('LLM 未返回有效的段落规划结果');
  }
  // 先把模型可能漂移/虚构的段落时间重锚定到字幕真实时间轴，再按时长预算拆分长段，
  // 避免段落（及其卡片）整体偏移或排到音频之后。
  const anchored: SegmentPlanningResult = {
    ...parsed,
    segments: anchorSegmentsToTranscript(parsed.segments, entries),
  };
  const planned = enforceSegmentDurationBudget(anchored, entries);

  // 观测分流健康度：统计 planning 阶段每段的 visualType（缺失视为 motion 默认）
  const total = planned.segments.length;
  let motionCount = 0;
  let imageCount = 0;
  let unspecifiedCount = 0;
  for (const seg of planned.segments) {
    if (seg.visualType === 'image') imageCount += 1;
    else if (seg.visualType === 'motion') motionCount += 1;
    else unspecifiedCount += 1;
  }
  console.log(
    `[planning.segment] segments=${total} motion=${motionCount} image=${imageCount} unspecified=${unspecifiedCount} (unspecified 默认按 motion 走)`,
  );

  return {
    ...planned,
    globalPrompt: globalPrompt?.trim() || planned.globalPrompt,
  };
}

export async function generateCardForSegment(
  entries: SrtEntry[],
  planning: Pick<SegmentPlanningResult, 'summary' | 'keywords' | 'globalPrompt'>,
  segment: AISegment,
  settings: AISettings,
  options: {
    generateStructuredData?: typeof generateStructuredData;
    generateText?: typeof generateText;
    /** Motion Card 多 agent 生成器（pi 导演→雕刻→审查）；motion 段必需，仅主进程注入。 */
    generateMotionCard?: MotionCardAgentProvider;
    /** 生成期 Motion Card 冒烟渲染校验；抛错触发重生成。仅主进程注入（需 esbuild/react-dom）。 */
    validateMotionSource?: (tsx: string) => void | Promise<void>;
    globalPrompt?: string;
    /** 已解析的视觉风格预设 ID（含单卡 / 项目 / 全局优先级）；注入 build 函数的 styleSystemBlock。 */
    stylePresetId?: string;
    cardPrompt?: string;
    currentCard?: AICard;
    cardTemplate?: PromptTemplate;
    imageTemplate?: PromptTemplate;
    /** cards.animation 模板（动画指导）；缺省回退内置默认。 */
    animationTemplate?: PromptTemplate;
    /** 手动传入的分镜草案；作为导演的创作约束（导演仍会产出合法 storyboard）。 */
    animationDirection?: string;
    projectBindings?: PromptBindingMap | null;
    segmentIndex?: number;
    totalSegments?: number;
    prevSegment?: AISegment;
    nextSegment?: AISegment;
    visualType?: AISegmentVisualType;
    telemetry?: TelemetryHook;
  } = {},
): Promise<AICard> {
  const {
    generateStructuredData: requestStructuredData = generateStructuredData,
    generateText: requestText = generateText,
    generateMotionCard,
    validateMotionSource,
    globalPrompt,
    stylePresetId,
    cardPrompt,
    currentCard,
    cardTemplate,
    imageTemplate,
    animationTemplate,
    animationDirection,
    projectBindings,
    segmentIndex,
    totalSegments,
    prevSegment,
    nextSegment,
    visualType,
    telemetry,
  } = options;

  if (entries.length === 0) {
    throw new Error('没有可用于生成卡片的字幕内容');
  }

  const programContext = buildProgramContext({
    programSummary: planning.summary,
    keywords: planning.keywords,
    segment,
    segmentIndex,
    totalSegments,
    prevSegment,
    nextSegment,
  });

  let finalCard: AICard;

  if (visualType === 'image') {
    // image 段落不再走 cards.segment LLM：cards.segment 模板自 v7 起仅描述 Motion Card，
    // 这里直接合成一张 image 占位卡片 shell，下面的 card.image 调用会回填中文文生图 prompt。
    finalCard = buildImageCardShell({
      segment,
      cardPrompt,
      currentCard,
    });
  } else {
    // Motion TSX 生成唯一路径：pi 多 agent 编排器（导演→雕刻→审查），由主进程注入。
    // 没有直连 LLM 回退——未注入即抛错，渲染端必须走 IPC 到主进程。
    if (!generateMotionCard) {
      throw new Error(
        'Motion 卡生成必须由主进程注入多 agent provider（generateMotionCard）；渲染端请通过 IPC 调用主进程生成。',
      );
    }

    // 只发段内逐字稿（含 ±2s 缓冲），而不是整篇 SRT，显著降低单次请求体积
    const segmentTranscript = buildSrtTextRange(entries, segment.startMs, segment.endMs);
    const segmentCues = buildSegmentCuesBlock(entries, segment.startMs, segment.endMs);
    const positionLabel =
      typeof segmentIndex === 'number' && typeof totalSegments === 'number'
        ? `cards.segment#${segmentIndex + 1}/${totalSegments}（${segment.id}）`
        : `cards.segment（${segment.id}）`;

    const generated = await generateMotionCard({
      segmentId: segment.id,
      segmentTitle: segment.title,
      buildDirectorPrompt: () =>
        buildAnimationDirectionPrompt(
          {
            segment,
            globalPrompt: globalPrompt?.trim() || planning.globalPrompt,
            programSummary: planning.summary,
            keywords: planning.keywords,
            cardPrompt,
            segmentCues,
          },
          animationTemplate,
        ),
      buildCardPrompt: (direction) =>
        buildSegmentCardPrompt(
          {
            programContext,
            segment,
            globalPrompt: globalPrompt?.trim() || planning.globalPrompt,
            stylePresetId,
            cardPrompt,
            currentCard,
            programSummary: planning.summary,
            keywords: planning.keywords,
            visualType,
            segmentCues,
            animationDirection: direction,
          },
          cardTemplate,
        ),
      segmentTranscript,
      cueCount: entries.filter((e) => e.startMs >= segment.startMs && e.startMs < segment.endMs).length,
      presetMotionTokens: getMotionTokensBlock(stylePresetId),
      animationDirectionDraft: animationDirection?.trim() || undefined,
      existingTsx: currentCard?.motionCard?.tsx || undefined,
      validate: validateMotionSource,
      label: positionLabel,
      telemetry,
    });

    // 文案忠于字幕：content 用本段字幕原文（无字幕时退回段落摘要），杜绝 AI 改写丢字。
    const verbatim = buildPlainTranscriptRange(entries, segment.startMs, segment.endMs);
    finalCard = buildMotionCardShell({
      segment,
      tsx: generated.tsx,
      cardPrompt,
      currentCard,
      content: verbatim || segment.summary,
      animationDirection: generated.animationDirection?.trim() || animationDirection?.trim() || undefined,
    });
  }

  // image 卡片：cards.segment 不再直接产 prompt，这里追加一次 card.image LLM 调用，
  // 用配置中心的 card.image 模板生成中文文生图提示词，并回填到 cardPrompt / content.prompt。
  if (finalCard.type === 'image') {
    const generatedPrompt = await generateImagePromptForSegment({
      segment,
      card: finalCard,
      settings,
      generateText: requestText,
      globalPrompt: globalPrompt?.trim() || planning.globalPrompt,
      stylePresetId,
      programSummary: planning.summary,
      keywords: planning.keywords,
      cardPromptHint: cardPrompt,
      imageTemplate,
      projectBindings,
      telemetry,
    });
    const prevContent = finalCard.content as MediaCardContent;
    finalCard = {
      ...finalCard,
      cardPrompt: generatedPrompt,
      content: {
        ...prevContent,
        prompt: generatedPrompt,
      },
    };
  }

  return finalCard;
}

/**
 * 把一张已 normalize 出来的 image 占位卡片真正物化成图片资产。
 * 失败时直接抛错，由外层并发循环把段记入 cardErrors。
 */
export async function materializeImageCard(
  card: AICard,
  generateCardImage: GenerateCardImageFn,
): Promise<AICard> {
  if (card.type !== 'image') return card;
  const content = card.content;
  if (!content || typeof content !== 'object' || !('mediaType' in content)) {
    throw new Error('image 卡片缺少 MediaCardContent 占位结构');
  }
  const media = content as MediaCardContent;
  const prompt = media.prompt || card.cardPrompt;
  if (!prompt) {
    throw new Error('image 卡片缺少图像 prompt，无法生成');
  }
  const generated = await generateCardImage({
    cardId: card.id,
    prompt,
    aspectRatio: media.aspectRatio,
    segmentId: card.segmentId,
  });
  return {
    ...card,
    content: generated,
  };
}

export async function analyzeSrt(
  entries: SrtEntry[],
  settings: AISettings,
  options: AnalyzeSrtOptions = {},
): Promise<AIAnalysisResult> {
  const {
    generateStructuredData: requestStructuredData = generateStructuredData,
    generateText: requestText = generateText,
    generateMotionCard,
    validateMotionSource,
    generateCardImage,
    globalPrompt,
    projectStylePresetId,
    defaultStylePresetId,
    planningTemplate,
    cardTemplate,
    imageTemplate,
    coverTemplate,
    animationTemplate,
    projectBindings,
    onProgress,
    telemetry,
    onPlanningDone,
    onCoverPromptsReady,
    generateWorkTitle,
    onCardGenerated,
  } = options;

  // 批量分析路径没有单卡层（卡片尚未生成），按 项目 → 全局 → 内置默认 解析。
  const resolvedStylePresetId = resolveStylePresetId({
    project: projectStylePresetId,
    global: defaultStylePresetId,
  });

  onProgress?.({ phase: 'planning', percent: 0, message: '规划分段与封面提示词…' });

  const planningStart = Date.now();
  telemetry?.emit('stage.start', { stage: 'analyze.planning', srtEntries: entries.length });
  let planning: SegmentPlanningResult;
  try {
    // planning 阶段不注入 styleSystemBlock（planning.segment 无该占位符）。
    planning = await planTranscriptSegments(entries, settings, {
      generateStructuredData: requestStructuredData,
      globalPrompt,
      planningTemplate,
      projectBindings,
      telemetry,
    });
  } catch (err) {
    telemetry?.emit('stage.end', {
      stage: 'analyze.planning',
      durationMs: Date.now() - planningStart,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  telemetry?.emit('stage.end', {
    stage: 'analyze.planning',
    durationMs: Date.now() - planningStart,
    ok: true,
    segments: planning.segments.length,
    coverPrompts: planning.coverPrompts.length,
  });
  // 让外层（main.ts -> renderer）能在卡片生成之前就拿到 planning 概要（segments / summary 等），
  // 卡片生成立即与封面提示词生成并行启动。
  // 注意：planning.coverPrompts 是 planning.segment 模板顺带产出的 fallback，
  // 真正用于一键流水线的封面提示词来自下方独立的 cover.regeneration LLM 调用。
  try {
    onPlanningDone?.(planning);
  } catch {
    // 回调出错不影响卡片生成
  }

  // 作品标题：planning 一完成就并行生成，赶在下方 cover.regeneration 调用前就绪。
  const workTitlePromise: Promise<string | null> = generateWorkTitle
    ? generateWorkTitle(planning).catch(() => null)
    : Promise.resolve(null);

  // 独立的 cover.regeneration LLM 调用，与卡片生成并行进行。
  // 完成后通过 onCoverPromptsReady 回吐给上层（Track C 等这条事件再触发封面图生成）。
  // 失败时静默退回 planning.coverPrompts（已经通过 onPlanningDone 给了上层）。
  const coverPromptsPromise: Promise<string[] | null> = (async () => {
    if (!onCoverPromptsReady && !coverTemplate) {
      // 调用方既未注入模板也不订阅事件：保持向后兼容，跳过这次额外调用。
      return null;
    }
    const coverStart = Date.now();
    telemetry?.emit('stage.start', { stage: 'analyze.cover-prompt' });
    try {
      const workTitle = await workTitlePromise;
      const prompts = await regenerateCoverPrompt(entries, settings, {
        generateStructuredData: requestStructuredData,
        globalPrompt: planning.globalPrompt ?? globalPrompt,
        projectStylePresetId,
        defaultStylePresetId,
        coverTemplate,
        projectBindings,
        workTitle: workTitle ?? undefined,
      });
      telemetry?.emit('stage.end', {
        stage: 'analyze.cover-prompt',
        durationMs: Date.now() - coverStart,
        ok: true,
        prompts: prompts.length,
      });
      try {
        onCoverPromptsReady?.(prompts);
      } catch {
        // 回调出错不影响主流程
      }
      return prompts;
    } catch (err) {
      telemetry?.emit('stage.end', {
        stage: 'analyze.cover-prompt',
        durationMs: Date.now() - coverStart,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      // 失败也要触发回调，避免上层（renderer Track C）无限等待 cover-prompts-ready；
      // 给 fallback 让上层可以决定是否仍然跑封面图生成。
      try {
        onCoverPromptsReady?.(planning.coverPrompts);
      } catch {
        // 回调出错不影响主流程
      }
      return null;
    }
  })();

  const total = planning.segments.length;
  onProgress?.({
    phase: 'cards',
    percent: total > 0 ? 30 : 95,
    message: total > 0 ? `生成内容卡片 0/${total}` : '规划完成',
    cardIndex: 0,
    cardTotal: total,
  });

  // 并发池：同时跑 N 个段的卡片生成；进度按"完成顺序"累加
  // 单段失败不阻塞其它段——失败段记入 cardErrors，UI 可引导用户对该段单独重生成
  // 并发数从 settings.cardGenerationConcurrency 读取；image 卡片的图像 Provider
  // 调用嵌套在 worker 内，所以该值也决定信息图并行度。
  const CARD_CONCURRENCY = normalizeCardGenerationConcurrency(
    settings.cardGenerationConcurrency,
  );
  const cardSlots: (AICard | null)[] = new Array(planning.segments.length).fill(null);
  const cardErrors: AIAnalysisCardError[] = [];
  let done = 0;
  let failed = 0;
  let cursor = 0;

  const runOne = async (): Promise<void> => {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= planning.segments.length) return;
      const segment = planning.segments[i];
      const visualType: AISegmentVisualType = segment.visualType ?? 'motion';
      const cardStart = Date.now();
      telemetry?.emit('card.start', {
        segmentIndex: i,
        totalSegments: total,
        segmentId: segment.id,
        visualType,
      });
      onProgress?.(buildCardProgress({
        segmentIndex: i,
        segmentId: segment.id,
        title: segment.title,
        visualType,
        status: 'start',
      }));
      try {
        let card = await generateCardForSegment(entries, planning, segment, settings, {
          generateStructuredData: requestStructuredData,
          generateText: requestText,
          generateMotionCard,
          validateMotionSource,
          globalPrompt: planning.globalPrompt,
          stylePresetId: resolvedStylePresetId,
          cardTemplate,
          imageTemplate,
          animationTemplate,
          projectBindings,
          segmentIndex: i,
          totalSegments: total,
          prevSegment: i > 0 ? planning.segments[i - 1] : undefined,
          nextSegment: i + 1 < planning.segments.length ? planning.segments[i + 1] : undefined,
          visualType,
          telemetry,
        });
        const llmDoneTs = Date.now();
        // image 卡片：LLM 拿到 prompt 后立即调图像 provider 物化资产
        if (card.type === 'image') {
          if (!generateCardImage) {
            throw new Error('image 卡片需要 generateCardImage 注入（主进程未提供）');
          }
          telemetry?.emit('card.image.start', { segmentIndex: i, segmentId: segment.id });
          onProgress?.(buildCardProgress({
            segmentIndex: i,
            segmentId: segment.id,
            title: segment.title,
            visualType,
            status: 'generating-image',
          }));
          card = await materializeImageCard(card, generateCardImage);
          telemetry?.emit('card.image.end', {
            segmentIndex: i,
            segmentId: segment.id,
            durationMs: Date.now() - llmDoneTs,
          });
        }
        cardSlots[i] = card;
        done += 1;
        telemetry?.emit('card.end', {
          segmentIndex: i,
          segmentId: segment.id,
          durationMs: Date.now() - cardStart,
          ok: true,
          visualType,
        });
        onProgress?.(buildCardProgress({
          segmentIndex: i,
          segmentId: segment.id,
          title: segment.title,
          visualType,
          status: 'done',
        }));
        // 单卡流式回吐：仅成功路径调用一次，传入最终落入 cardSlots[i] 的同一卡片对象。
        try {
          onCardGenerated?.(card, i);
        } catch {
          // 回调出错不影响后续卡片生成
        }
      } catch (error) {
        failed += 1;
        cardErrors.push({
          segmentId: segment.id,
          segmentTitle: segment.title,
          segmentIndex: i,
          totalSegments: total,
          message: error instanceof Error ? error.message : String(error),
        });
        telemetry?.emit('card.end', {
          segmentIndex: i,
          segmentId: segment.id,
          durationMs: Date.now() - cardStart,
          ok: false,
          visualType,
          error: error instanceof Error ? error.message : String(error),
        });
        onProgress?.(buildCardProgress({
          segmentIndex: i,
          segmentId: segment.id,
          title: segment.title,
          visualType,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      const completed = done + failed;
      const percent = Math.min(95, Math.round(30 + (completed / Math.max(1, total)) * 65));
      const message =
        failed > 0
          ? `生成内容卡片 ${completed}/${total}（成功 ${done}，失败 ${failed}）`
          : `生成内容卡片 ${completed}/${total}`;
      onProgress?.({
        phase: 'cards',
        percent,
        message,
        cardIndex: completed,
        cardTotal: total,
      });
    }
  };

  const workerCount = Math.min(CARD_CONCURRENCY, Math.max(1, planning.segments.length));
  const cardsStartTs = Date.now();
  telemetry?.emit('stage.start', {
    stage: 'analyze.cards',
    totalSegments: total,
    concurrency: workerCount,
  });
  await Promise.all(Array.from({ length: workerCount }, () => runOne()));
  telemetry?.emit('stage.end', {
    stage: 'analyze.cards',
    durationMs: Date.now() - cardsStartTs,
    ok: true,
    done,
    failed,
    totalSegments: total,
  });
  const cards: AICard[] = cardSlots.filter((card): card is AICard => card !== null);

  // 等待并行启动的 cover.regeneration LLM 调用收尾，
  // 让返回的 AIAnalysisResult.coverPrompts 优先反映 COVER_REGENERATION 产物。
  const coverPromptsFromCoverTemplate = await coverPromptsPromise;
  const finalCoverPrompts =
    coverPromptsFromCoverTemplate && coverPromptsFromCoverTemplate.length > 0
      ? coverPromptsFromCoverTemplate
      : planning.coverPrompts;

  onProgress?.({
    phase: 'done',
    percent: 100,
    message:
      failed > 0 ? `内容分析完成（成功 ${done}，失败 ${failed}）` : '内容分析完成',
  });

  return {
    segments: planning.segments,
    cards,
    coverPrompts: finalCoverPrompts,
    summary: planning.summary,
    keywords: planning.keywords,
    globalPrompt: planning.globalPrompt,
    cardErrors: cardErrors.length > 0 ? cardErrors : undefined,
  };
}

export async function regenerateAICard(
  entries: SrtEntry[],
  card: AICard,
  segment: AISegment,
  settings: AISettings,
  options: RegenerateCardOptions = {},
): Promise<AICard> {
  const {
    generateStructuredData: requestStructuredData = generateStructuredData,
    generateText: requestText = generateText,
    generateMotionCard,
    validateMotionSource,
    globalPrompt,
    projectStylePresetId,
    defaultStylePresetId,
    cardPrompt = card.cardPrompt,
    programSummary,
    keywords = [],
    cardTemplate,
    imageTemplate,
    animationTemplate,
    animationDirection = card.animationDirection,
    projectBindings,
  } = options;

  if (!segment) {
    throw new Error('缺少卡片对应的段落信息');
  }

  // 单卡重生成：单卡覆盖 → 项目 → 全局 → 内置默认。
  const resolvedStylePresetId = resolveStylePresetId({
    card: card.stylePresetId,
    project: projectStylePresetId,
    global: defaultStylePresetId,
  });

  const regenerated = await generateCardForSegment(
    entries,
    {
      summary: programSummary ?? '',
      keywords,
      globalPrompt: globalPrompt?.trim() || undefined,
    },
    segment,
    settings,
    {
      generateStructuredData: requestStructuredData,
      generateText: requestText,
      generateMotionCard,
      validateMotionSource,
      globalPrompt,
      stylePresetId: resolvedStylePresetId,
      cardPrompt,
      currentCard: card,
      cardTemplate,
      imageTemplate,
      animationTemplate,
      animationDirection,
      projectBindings,
    },
  );

  return {
    ...card,
    ...regenerated,
    id: card.id,
    segmentId: segment.id,
    enabled: card.enabled,
    cardPrompt: cardPrompt?.trim() || undefined,
    animationDirection: regenerated.animationDirection,
  };
}

export interface SubtitleCardDraftInput {
  /** 用户二次编辑后的字幕文本（默认来自选中条目拼接） */
  text: string;
  /** 卡片起始毫秒（默认来自首条 startMs） */
  startMs: number;
  /** 卡片结束毫秒（默认来自末条 endMs） */
  endMs: number;
  /** 卡片停留毫秒（默认 = endMs - startMs） */
  displayDurationMs: number;
  /** 卡片类型倾向（user hint，LLM 可自行微调） */
  type: AICardType;
  /** 用户补充指令，可选 */
  promptHint?: string;
}

/**
 * 面向"用户手选字幕 → 单张 Motion Card"的生成入口。
 *
 * 策略：复用 `cards.segment` 管线，把用户草稿组装成合成段落后喂入；
 * normalizeCard 会对返回的 motionCard.tsx 做 Remotion 组件校验，
 * 编译失败直接抛错让用户重新生成。
 */
export async function generateSingleCardFromSubtitles(
  entries: SrtEntry[],
  draft: SubtitleCardDraftInput,
  settings: AISettings,
  options: {
    globalPrompt?: string;
    projectStylePresetId?: string;
    defaultStylePresetId?: string;
    programSummary?: string;
    keywords?: string[];
    cardTemplate?: PromptTemplate;
    imageTemplate?: PromptTemplate;
    /** cards.animation 模板（导演任务书）；缺省回退内置默认。 */
    animationTemplate?: PromptTemplate;
    /** 用户已有的动画指导草案（可选，导演当作约束）。 */
    animationDirection?: string;
    projectBindings?: PromptBindingMap | null;
    generateStructuredData?: typeof generateStructuredData;
    generateText?: typeof generateText;
    /** Motion Card 多 agent 生成器；motion 卡必需，仅主进程注入。 */
    generateMotionCard?: MotionCardAgentProvider;
    /** 生成期 Motion Card 冒烟渲染校验；抛错触发重生成。仅主进程注入。 */
    validateMotionSource?: (tsx: string) => void | Promise<void>;
  } = {},
): Promise<AICard> {
  const trimmedText = draft.text.trim();
  if (trimmedText.length === 0) {
    throw new Error('字幕内容为空，无法生成卡片');
  }
  if (!(draft.startMs < draft.endMs)) {
    throw new Error('时间范围无效');
  }
  if (!Number.isFinite(draft.displayDurationMs) || draft.displayDurationMs <= 0) {
    throw new Error('展示时长无效');
  }
  if (!isAICardType(draft.type)) {
    throw new Error('卡片类型无效');
  }

  const {
    globalPrompt,
    projectStylePresetId,
    defaultStylePresetId,
    programSummary,
    keywords = [],
    cardTemplate,
    imageTemplate,
    animationTemplate,
    animationDirection,
    projectBindings,
    generateStructuredData: requestStructuredData,
    generateText: requestText,
    generateMotionCard,
    validateMotionSource,
  } = options;

  const hint = draft.promptHint?.trim();
  const cardPromptLines = [
    `只产出 1 张卡片，renderMode 必须为 "motion-card"，并在 motionCard.tsx 里给出单文件 Remotion 函数组件（export default，帧驱动动画）。`,
    `卡片类型建议为 "${draft.type}"，可根据内容微调。`,
  ];
  if (hint) {
    cardPromptLines.push(`用户补充：${hint}`);
  }
  const cardPrompt = cardPromptLines.join('\n');

  const syntheticSegment: AISegment = {
    id: `manual-${Date.now()}`,
    title: `手动选段 ${msToTimestamp(draft.startMs)} → ${msToTimestamp(draft.endMs)}`,
    summary: hint || trimmedText.slice(0, 120),
    startMs: draft.startMs,
    endMs: draft.endMs,
    transcriptExcerpt: trimmedText,
  };

  const card = await generateCardForSegment(
    entries.length > 0 ? entries : [],
    {
      summary: programSummary ?? '',
      keywords,
      globalPrompt: globalPrompt?.trim() || undefined,
    },
    syntheticSegment,
    settings,
    {
      generateStructuredData: requestStructuredData,
      generateText: requestText,
      generateMotionCard,
      validateMotionSource,
      globalPrompt,
      // 手动选段是新卡片，无单卡覆盖；按 项目 → 全局 → 内置默认 解析。
      stylePresetId: resolveStylePresetId({
        project: projectStylePresetId,
        global: defaultStylePresetId,
      }),
      cardPrompt,
      cardTemplate,
      imageTemplate,
      animationTemplate,
      animationDirection,
      projectBindings,
    },
  );

  return {
    ...card,
    segmentId: syntheticSegment.id,
    startMs: draft.startMs,
    endMs: draft.endMs,
    displayDurationMs: draft.displayDurationMs,
    cardPrompt: hint || card.cardPrompt,
  };
}

export async function regenerateCoverPrompt(
  entries: SrtEntry[],
  settings: AISettings,
  options: RegenerateCoverPromptOptions = {},
): Promise<string[]> {
  const {
    generateStructuredData: requestStructuredData = generateStructuredData,
    globalPrompt,
    projectStylePresetId,
    defaultStylePresetId,
    currentPrompt,
    coverTemplate,
    projectBindings,
    workTitle,
  } = options;

  if (entries.length === 0) {
    throw new Error('没有可用于生成封面提示词的字幕内容');
  }

  const binding = maybeResolveBinding('cover.regeneration', settings, projectBindings);
  const payload = await requestStructuredData(
    settings,
    buildCoverPromptRegenerationPrompt(
      {
        globalPrompt,
        // 封面重生成无单卡层；按 项目 → 全局 → 内置默认 解析。
        stylePresetId: resolveStylePresetId({
          project: projectStylePresetId,
          global: defaultStylePresetId,
        }),
        currentPrompt,
        workTitle,
      },
      coverTemplate,
    ),
    buildSrtText(entries),
    binding,
  );
  const prompts = parseCoverPromptResult(payload);

  if (prompts.length === 0) {
    throw new Error('LLM 未返回有效的封面提示词');
  }

  return prompts;
}
