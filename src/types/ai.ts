import type { MotionCardPayload } from './motion';
import type { PromptKind } from '../lib/prompts/types';
import type { CoverEditState } from '../lib/cover-editor/contracts';
export type { MotionCardPayload } from './motion';

export type AICardType =
  | 'summary'
  | 'data'
  | 'insight'
  | 'chapter'
  | 'quote'
  | 'motion'
  | 'image'
  | 'video';

export type AICardMediaType = 'image' | 'video';
export type AICardDisplayMode = 'fullscreen' | 'pip';
export type AICardRenderMode = 'legacy' | 'motion-card';

export interface DataContent {
  chartType: 'bar' | 'comparison' | 'ranking' | 'stat';
  items: Array<{
    label: string;
    value: string | number;
    highlight?: boolean;
  }>;
}

export interface MediaCardContent {
  mediaType: AICardMediaType;
  /** 相对 projectDir，例：'ai-cards/<cardId>/image.png' */
  assetPath: string | null;
  /** 仅 video：首帧海报，相对 projectDir */
  posterPath?: string | null;
  /** 仅 video：生成产物的真实时长（ms） */
  mediaDurationMs?: number;
  /** 字段类型为 ImageAspectRatio；video 卡运行时仅接受 '16:9' | '9:16' | '1:1' 子集，由 form 与 IPC handler 双向校验 */
  aspectRatio: ImageAspectRatio;
  prompt: string;
  negativePrompt?: string;
  providerId: string | null;
  model: string | null;
  generationStatus:
    | 'idle'
    | 'pending'
    | 'generating'
    | 'ready'
    | 'failed'
    | 'cancelled';
  errorMessage?: string;
  generatedAt?: number;
  extraParams?: Record<string, unknown>;
}

export interface CardStyle {
  primaryColor: string;
  backgroundColor: string;
  fontSize: number;
}

export type VisualStyleFacetKind = 'motion' | 'cover' | 'image';

export interface VisualStylePalette {
  bg: string;
  ink: string;
  muted: string;
  accent: string;
}

export interface VisualStyleFonts {
  display: string;
  body: string;
  mono?: string;
}

/** 三个生成表面的「视觉系统」提示词块；缺省表示该表面回退默认风格 */
export type VisualStyleFacets = Partial<Record<VisualStyleFacetKind, string>>;

export interface VisualStylePreview {
  /** 静态 Motion Card HTML 片段（含内联 <style> + 同步 <script>，遵守 motion-card 契约） */
  motionHtml?: string;
  /** 封面示意图资产路径（renderer 通过 import 取得的 URL 字符串） */
  coverImageAsset?: string;
}

/**
 * Motion Card 风格 tokens：由 @lingji/motion-kit 的 CardStage 与内容原语消费。
 * 结构与 src/remotion/motion-kit 的 MotionTokens 一致（此处独立声明避免类型层依赖渲染层）。
 */
export interface VisualMotionTokens {
  palette: VisualStylePalette & { track?: string };
  fonts: { display: string; body: string; mono: string };
  typeScale?: { hero?: number; dataHero?: number; lead?: number; body?: number; label?: number };
  surface?: { kind: 'none' | 'glass' | 'panel'; bg?: string; border?: string; radius?: number };
  ambient?: { kind: 'none' | 'grid' | 'orbs' | 'hairline' | 'grain'; opacity?: [number, number]; color?: string };
  camera?: { mode: 'push' | 'pull' | 'pan' | 'still'; range?: [number, number] };
  persona?: { easing?: 'crisp' | 'calm' | 'bouncy'; emphasis?: 'settle' | 'brighten' | 'underline' | 'none' };
}

export interface VisualStylePreset {
  id: string;
  name: string;
  description: string;
  tags: string[];
  /** 来源 html-anything skill，便于追溯 */
  source: string;
  palette: VisualStylePalette;
  fonts: VisualStyleFonts;
  facets: VisualStyleFacets;
  /** Motion Card 风格 tokens（motion facet 的结构化替代；缺省回退默认风格） */
  motionTokens?: VisualMotionTokens;
  /** 少量预设专属提示（如玻璃拟态面板、渐变标题），注入 {{presetStyleNotes}}；≤3 行 */
  motionStyleNotes?: string;
  preview: VisualStylePreview;
}

/** 内置默认风格 id；旧数据 / 未知 id 一律回退到它 */
export const DEFAULT_STYLE_PRESET_ID = 'editorial-eink';

export interface AISegment {
  id: string;
  title: string;
  summary: string;
  startMs: number;
  endMs: number;
  transcriptExcerpt?: string;
}

export type AISegmentSemanticType =
  | 'data'
  | 'explanation'
  | 'chapter-transition'
  | 'quote'
  | 'narration';

export type AISegmentComplexityLevel = 'low' | 'medium' | 'high';
export type AISegmentPacingNeed = 'steady' | 'accent' | 'transition';

/**
 * 段落最适合的卡片可视化形式：
 * - motion：抽象 / 摘要 / 数据演示 / 时间线 / 概念对比 → 适合 HyperFrames 动画卡片
 * - image：产品 / 参数 / 界面 / 物件 / 复杂场景 → 适合 AI 生成的实拍/插画图片
 *
 * planning.segment LLM 自行判定；缺省回退 motion。
 */
export type AISegmentVisualType = 'motion' | 'image';

export interface AISegmentAnalysis extends AISegment {
  semanticType: AISegmentSemanticType;
  complexityLevel: AISegmentComplexityLevel;
  visualizationScore: number;
  pacingNeed: AISegmentPacingNeed;
  keywords: string[];
  entities: string[];
  visualType?: AISegmentVisualType;
}

export interface AICard {
  id: string;
  segmentId: string;
  type: AICardType;
  title: string;
  content: string | DataContent | MediaCardContent;
  startMs: number;
  endMs: number;
  displayDurationMs: number;
  displayMode: AICardDisplayMode;
  template: string;
  enabled: boolean;
  style: CardStyle;
  renderMode?: AICardRenderMode;
  cardPrompt?: string;
  /** AI 生成的 JSON 分镜（storyboard），由 cards.animation 产出，注入 cards.segment 指导出卡。仅 motion 卡使用。 */
  animationDirection?: string;
  motionCard?: MotionCardPayload;
  /** 单卡级风格覆盖；缺省继承项目 / 全局 / 内置默认 */
  stylePresetId?: string;
}

export interface CoverCandidate {
  id: string;
  prompt: string;
  imageUrl: string;
  selected: boolean;
  error?: string;
  /** 来源候选 id；AI 原图为 undefined */
  editedFrom?: string;
  /** 编辑状态快照，用于再编辑时恢复工具面板 */
  edits?: CoverEditState;
  /** 生成时间戳 */
  createdAt?: number;
  /**
   * 画幅比例。编辑器封面默认 16:9；发布选项卡会按 16:9 / 4:3 / 3:4 分组展示。
   * 旧工程候选无此字段，读取时按 '16:9' 处理（见 coverAspectRatio()）。
   */
  aspectRatio?: ImageAspectRatio;
}

/** 读取封面候选的画幅比例，旧数据缺省按 16:9。 */
export function coverAspectRatio(candidate: Pick<CoverCandidate, 'aspectRatio'>): ImageAspectRatio {
  return candidate.aspectRatio ?? '16:9';
}

export type { CoverEditState, CoverTextOverlay } from '../lib/cover-editor/contracts';

export interface AIAnalysisCardError {
  segmentId: string;
  segmentTitle?: string;
  segmentIndex?: number;
  totalSegments?: number;
  message: string;
}

export interface AIAnalysisResult {
  segments: AISegment[];
  cards: AICard[];
  coverPrompts: string[];
  summary: string;
  keywords: string[];
  globalPrompt?: string;
  /**
   * 段卡片生成中失败的段（不阻塞其它段）。UI 可据此在 Editor 里
   * 引导用户对失败段单独执行"重生成卡片"。
   */
  cardErrors?: AIAnalysisCardError[];
}

/** LM Studio 默认 OpenAI 兼容端点 */
export const LMSTUDIO_DEFAULT_BASE_URL = 'http://localhost:1234/v1';

export type PiProviderApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

export type PiModelInputType = 'text' | 'image';
export type PiMaxTokensField = 'max_tokens' | 'max_completion_tokens';
export type PiThinkingFormat =
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'together'
  | 'zai'
  | 'qwen'
  | 'qwen-chat-template';
export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type PiThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;

export interface PiModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PiModelCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: PiMaxTokensField;
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?: PiThinkingFormat;
  cacheControlFormat?: 'anthropic';
  supportsStrictMode?: boolean;
  supportsLongCacheRetention?: boolean;
  supportsEagerToolInputStreaming?: boolean;
  sendSessionAffinityHeaders?: boolean;
  supportsCacheControlOnTools?: boolean;
  forceAdaptiveThinking?: boolean;
  allowEmptySignature?: boolean;
}

export interface PiModelProjectionOptions {
  /**
   * 是否把模型声明为 pi extended thinking 模型。
   * 这是 Pi Agent 请求层能力，不等同于普通 LLM 对话的 enableThinking。
   */
  reasoning?: boolean;
  input?: PiModelInputType[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Partial<PiModelCost>;
  thinkingLevelMap?: PiThinkingLevelMap;
}

export interface PiProviderProjectionOptions {
  /**
   * pi 内置 provider id。设置后 pi 直接使用内置 provider/model 定义，
   * App 只负责把 API Key 写入 auth.json；models.json 不再重复投影。
   */
  builtinProviderId?: string;
  /** 覆盖投影到 pi models.json 的 api 类型；留空按 LLMProvider.type 推断 */
  api?: PiProviderApi;
  /** 为非标准 provider 自动追加 Authorization: Bearer <apiKey> */
  authHeader?: boolean;
  /** pi models.json provider.headers，支持 pi 的 $ENV / !command 取值语法 */
  headers?: Record<string, string>;
  /** provider/model 兼容性开关，投影到每个 pi model 的 compat */
  compat?: PiModelCompat;
  /** 应用于当前 Provider 下所有模型的 pi model 默认参数 */
  model?: PiModelProjectionOptions;
}

/** 单个 LLM Provider 配置 */
export interface LLMProvider {
  id: string;
  name: string;
  type:
    | 'openai_compatible'
    | 'openai_responses'
    | 'minimax'
    | 'gemini'
    | 'lmstudio'
    | 'volcengine_ark';
  baseUrl: string;
  apiKey: string;
  models: string[];
  /**
   * 该 Provider 的默认模型，必须是 models 之一。
   * 绑定解析时优先级位于全局 AISettings.defaultModel 之前、提示词级绑定之后；
   * 切换默认 Provider 时也用它回填全局默认模型。缺省 / 不在 models 内时忽略。
   */
  defaultModel?: string;
  /** 是否启用模型思考模式；缺省视为 true */
  enableThinking?: boolean;
  /**
   * 思考深度（thinking budget，单位 token）。仅 type='minimax'（Anthropic 兼容端点）使用：
   * 映射到 thinking.budget_tokens，越小越快、越大思考越深。缺省走内置默认（1024）。
   * enableThinking=false 时忽略本字段（直接 thinking.type='disabled'）。
   */
  thinkingBudgetTokens?: number;
  /** type='volcengine_ark' 专属参数；其它 Provider 类型忽略本字段 */
  volcengineArk?: VolcengineArkParams;
  /** 内置 pi agent 的 provider / model 投影参数，不影响当前 LangChain 调用路径 */
  pi?: PiProviderProjectionOptions;
}

/**
 * 火山引擎方舟（type='volcengine_ark'）专属请求参数。
 * 火山方舟是 OpenAI 兼容端点，但额外支持以下火山特有字段，经 modelKwargs 透传进请求体。
 */
export interface VolcengineArkParams {
  /** 深度思考模式，映射到请求体 thinking.type；缺省 enabled */
  thinkingMode?: 'enabled' | 'disabled' | 'auto';
  /** 思考力度，映射到 reasoning_effort；缺省不下发（走 API 默认 medium） */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'max';
  /** 在线推理模式，映射到 service_tier；缺省不下发（走 API 默认 auto） */
  serviceTier?: 'fast' | 'auto' | 'default';
}

export type TTSProviderType = 'minimax' | 'xiaomi_mimo';

export interface TTSProvider {
  id: string;
  name: string;
  type: TTSProviderType;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export interface TTSVoiceParams {
  speed: number;
  vol?: number;
  pitch?: number;
  emotion?: string;
}

export interface TTSVoicePreset {
  id: string;
  name: string;
  providerId: string;
  providerType: TTSProviderType;
  model: string | null;
  voiceId?: string;
  source: 'system' | 'cloned';
  referenceAudioPath?: string;
  referenceAudioName?: string;
  referenceAudioMime?: 'audio/mpeg' | 'audio/wav';
  params: TTSVoiceParams;
  createdAt: number;
  updatedAt: number;
}

export interface AISettings {
  // 多 Provider
  llmProviders: LLMProvider[];
  defaultProviderId: string | null;
  defaultModel: string | null;
  /** @deprecated 仅存于旧配置文件，加载时经 migrateToProviders 一次性迁移并清空 */
  llmBaseUrl?: string;
  /** @deprecated 同 llmBaseUrl */
  llmApiKey?: string;
  /** @deprecated 同 llmBaseUrl */
  llmModel?: string;
  /** @deprecated 已迁移到 LLMProvider.enableThinking；保留仅用于旧数据迁移 */
  enableThinking?: boolean;
  // 图片生成
  jimengApiUrl: string;
  jimengSessionId: string;
  jimengModel?: string;
  // MiniMax TTS
  minimaxApiKey: string;
  minimaxVoiceId: string;
  minimaxSpeed: number;
  minimaxVol?: number;
  minimaxPitch?: number;
  minimaxEmotion?: string;
  minimaxModel?: string;
  // 多 TTS Provider
  ttsProviders: TTSProvider[];
  defaultTtsProviderId: string | null;
  defaultTtsVoiceId: string | null;
  ttsVoices: TTSVoicePreset[];
  /** MiMo 智能语气打标开关；缺省视为 true */
  ttsMimoAutoAnnotate?: boolean;
  // —— 新增：图像 Provider ——
  imageProviders: ImageProvider[];
  defaultImageProviderId: string | null;
  defaultImageModel: string | null;
  /**
   * 全局封面图生成提示词。
   * 在生成封面图时与"基于内容生成的提示词"拼接后再发送给图像 Provider，
   * 用于稳定承载用户偏好的整体风格、品牌、画质等约束。
   */
  globalCoverImagePrompt?: string;
  // —— 新增：视频 Provider ——
  videoProviders: VideoProvider[];
  defaultVideoProviderId: string | null;
  defaultVideoModel: string | null;
  // —— 新增：提示词 → AI 绑定（全局层）——
  promptBindings: PromptBindingMap;
  /** 全局默认风格预设 id；缺省视为 DEFAULT_STYLE_PRESET_ID */
  defaultStylePresetId?: string;
  /**
   * 段落信息卡片（含信息图）生成并发数。
   * 控制 analyzeSrt 中分段卡片生成 worker 数；image 卡片的图像 Provider 调用
   * 嵌套在 worker 内，因此该值同时决定信息图并行生成数。
   * 必须 >= 1，默认 2。
   */
  cardGenerationConcurrency?: number;
  /** 出卡前是否自动为 motion 卡生成动画指导（cards.animation）。缺省视为 true。 */
  autoAnimationDirection?: boolean;
}

export const DEFAULT_JIMENG_MODEL = 'jimeng-5.0';

/** cardGenerationConcurrency 缺省值；store 归一化与 analyzeSrt 兜底共用同一真源。 */
export const DEFAULT_CARD_GENERATION_CONCURRENCY = 2;

/** 归一化卡片生成并发：有限正整数向下取整，否则回落默认值。 */
export function normalizeCardGenerationConcurrency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CARD_GENERATION_CONCURRENCY;
  }
  const n = Math.floor(value);
  return n >= 1 ? n : DEFAULT_CARD_GENERATION_CONCURRENCY;
}

export interface AICardOverlayData {
  sourceCardId?: string;
  cardType: AICardType;
  title: string;
  content: string | DataContent | MediaCardContent;
  template: string;
  displayMode: AICardDisplayMode;
  style: CardStyle;
  renderMode?: AICardRenderMode;
  cardPrompt?: string;
  motionCard?: MotionCardPayload;
  sourceStartMs?: number;
  sourceEndMs?: number;
  stylePresetId?: string;
}

export interface AICardTimelineDraft {
  sourceCardId: string;
  startMs: number;
  durationMs: number;
  aiCardData: AICardOverlayData;
}

const DEFAULT_CARD_BACKGROUND = '#151922';

export const DEFAULT_CARD_STYLE: Record<AICardType, CardStyle> = {
  summary: { primaryColor: '#79c4ff', backgroundColor: DEFAULT_CARD_BACKGROUND, fontSize: 48 },
  data: { primaryColor: '#4ed38a', backgroundColor: DEFAULT_CARD_BACKGROUND, fontSize: 48 },
  insight: { primaryColor: '#ffb347', backgroundColor: DEFAULT_CARD_BACKGROUND, fontSize: 48 },
  chapter: { primaryColor: '#9eb7ff', backgroundColor: DEFAULT_CARD_BACKGROUND, fontSize: 48 },
  quote: { primaryColor: '#ff8f7a', backgroundColor: DEFAULT_CARD_BACKGROUND, fontSize: 48 },
  motion: { primaryColor: '#7df9ff', backgroundColor: DEFAULT_CARD_BACKGROUND, fontSize: 48 },
  image: { primaryColor: '#79c4ff', backgroundColor: DEFAULT_CARD_BACKGROUND, fontSize: 48 },
  video: { primaryColor: '#ff8f7a', backgroundColor: DEFAULT_CARD_BACKGROUND, fontSize: 48 },
};

export const DEFAULT_CARD_DURATION_MS = 5_000;

export function getDefaultTemplate(type: AICardType): string {
  return `${type}-default`;
}

export function getDefaultCardStyle(type: AICardType): CardStyle {
  return { ...DEFAULT_CARD_STYLE[type] };
}

export function isAICardType(value: unknown): value is AICardType {
  return [
    'summary',
    'data',
    'insight',
    'chapter',
    'quote',
    'motion',
    'image',
    'video',
  ].includes(String(value));
}

export function isDataContent(value: unknown): value is DataContent {
  if (!value || typeof value !== 'object' || !('chartType' in value) || !('items' in value)) {
    return false;
  }

  return Array.isArray(value.items);
}

export function isMediaContent(value: unknown): value is MediaCardContent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    'mediaType' in v &&
    'aspectRatio' in v &&
    'generationStatus' in v &&
    (v.mediaType === 'image' || v.mediaType === 'video')
  );
}

export function isMediaCardType(t: AICardType): t is 'image' | 'video' {
  return t === 'image' || t === 'video';
}

export function buildAICardOverlayData(card: AICard): AICardOverlayData {
  return {
    sourceCardId: card.id,
    cardType: card.type,
    title: card.title,
    content: card.content,
    template: card.template,
    displayMode: card.displayMode,
    style: card.style,
    renderMode: card.renderMode ?? 'legacy',
    cardPrompt: card.cardPrompt,
    motionCard: card.motionCard,
    sourceStartMs: card.startMs,
    sourceEndMs: card.endMs,
    stylePresetId: card.stylePresetId,
  };
}

/** 受支持的图像生成 Provider 类型 */
export type ImageProviderType =
  | 'jimeng'
  | 'openai_image'
  | 'minimax'
  | 'doubao'
  | 'imagen'
  | 'wanx'
  | 'apimart'
  | 'custom';

/** 图像宽高比公共集 */
export type ImageAspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';

/** Provider 能力描述（由 adapter 在 image-gen 注册表内注入，types 仅做类型契约） */
export interface ImageProviderCapabilities {
  aspectRatios: ImageAspectRatio[];
  maxN: number;
  supportsImageToImage: boolean;
  isAsync: boolean;
  defaultModels: string[];
}

/** 单个 Image Provider 配置（文生图） */
export interface ImageProvider {
  id: string;
  name: string;
  type: ImageProviderType;
  baseUrl: string;
  apiKey: string;          // 即梦下：实际承载 sessionId（client 层适配）
  models: string[];
  /** provider-specific 额外配置：imagen.projectId、wanx.region 等 */
  extras?: Record<string, unknown>;
}

/** 受支持的视频生成 Provider 类型（仅保留有运行时适配器的类型） */
export type VideoProviderType = 'vidu';

/** 视频宽高比公共集（video 卡运行时仅接受该子集） */
export type VideoAspectRatio = '16:9' | '9:16' | '1:1';

/** 单个 Video Provider 配置（文生/图生视频） */
export interface VideoProvider {
  id: string;
  name: string;
  type: VideoProviderType;
  baseUrl: string;
  apiKey: string;
  models: string[];
  /** provider-specific 额外配置 */
  extras?: Record<string, unknown>;
}

/** 单个提示词的 AI 绑定（null 表示继承） */
export interface PromptBinding {
  providerId: string | null;
  model: string | null;
  // 仅 cover.regeneration 写入
  imageProviderId?: string | null;
  imageModel?: string | null;
  // 视频生成相关提示词写入
  videoProviderId?: string | null;
  videoModel?: string | null;
}

/**
 * 提示词 → 绑定映射；缺失 key 视为继承。
 * Key 空间：
 * - PromptKind（如 'script.review', 'planning.segment'）
 * - `user:<category>:<id>`（如 'user:script-template:news-broadcast'）—— 用户自定义提示词条目的项目级绑定
 */
export type PromptBindingMap = Partial<Record<string, PromptBinding>>;

export function buildAICardTimelineDraft(card: AICard): AICardTimelineDraft {
  const sourceStartMs = Number.isFinite(card.startMs) ? Math.max(0, Math.round(card.startMs)) : 0;
  const sourceEndMs = Number.isFinite(card.endMs)
    ? Math.max(sourceStartMs, Math.round(card.endMs))
    : sourceStartMs;
  const durationMs =
    Number.isFinite(card.displayDurationMs) && card.displayDurationMs > 0
      ? Math.round(card.displayDurationMs)
      : DEFAULT_CARD_DURATION_MS;
  const topicSpanMs = Math.max(0, sourceEndMs - sourceStartMs);
  const timelineStartMs = topicSpanMs > durationMs ? sourceEndMs - durationMs : sourceStartMs;

  return {
    sourceCardId: card.id,
    startMs: timelineStartMs,
    durationMs,
    aiCardData: buildAICardOverlayData(card),
  };
}
