import type { CardAssetBinding } from './assets';

export interface MotionCardPayload {
  /**
   * Remotion 卡片源码：单文件 React/Remotion 函数组件（default export）。
   * 内存态始终填充；落盘时被剥离并写入 tsxPath 指向的独立文件。
   */
  tsx?: string;
  /**
   * 卡片源码外置文件相对路径（相对 projectDir），例：'ai-cards/<overlayId>/motionCard.tsx'。
   * 仅存在于磁盘 project.json；加载时据此读回 tsx。
   */
  tsxPath?: string;
  compiledAt: number;
  compileError?: string;
  prompt: string;
  retryCount: number;
  /** 生成期制作质检报告：lint / 渲染 / 审查 / 兜底状态的汇总。 */
  productionReport?: MotionCardProductionReport;
  /** 结构化分镜，优先由 cards.animation 产出；旧卡可从 AICard.animationDirection 解析。 */
  storyboard?: import('../lib/motion-storyboard').MotionStoryboard;
  /** 分镜/TSX 版本历史，供精雕后回退上一版。 */
  storyboardHistory?: MotionStoryboardVersion[];
}

export interface MotionStoryboardVersion {
  savedAt: number;
  storyboard?: import('../lib/motion-storyboard').MotionStoryboard;
  tsxHash?: string;
  tsx?: string;
}

export type MotionCardQualityStatus = 'pass' | 'acceptable' | 'risk' | 'fallback' | 'failed';

export type MotionCardProductionIssueSource =
  | 'lint'
  | 'layout'
  | 'render'
  | 'review'
  | 'storyboard'
  | 'visual-review'
  | 'asset';

export interface MotionCardProductionIssue {
  severity: 'error' | 'warning';
  source: MotionCardProductionIssueSource;
  code?: string;
  message: string;
  element?: string;
  rule?: string;
  fix?: string;
  frame?: number;
  beat?: number;
  visualProblem?: string;
}

export interface MotionCardProductionReport {
  status: MotionCardQualityStatus;
  generatedAt: number;
  framesChecked: number[];
  lintIssues: MotionCardProductionIssue[];
  layoutIssues: MotionCardProductionIssue[];
  reviewIssues: MotionCardProductionIssue[];
  assetIssues: MotionCardProductionIssue[];
  fallbackUsed: boolean;
  /** true = 由 storyboard 确定性模板编译产出（未经 LLM 雕刻/审查）。 */
  compiled?: boolean;
  fixRounds: number;
  reviewRounds: number;
  renderOk: boolean;
  visualReviewAvailable?: boolean;
  unavailableReason?: string;
  contactSheetPath?: string;
  contactSheetCacheKey?: string;
  contactSheetCached?: boolean;
  contactSheetError?: string;
}

export interface MotionCardMechanicalIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  frame?: number;
  element?: string;
}

export interface MotionCardMechanicalValidation {
  ok: boolean;
  renderOk: boolean;
  issues: MotionCardMechanicalIssue[];
  framesChecked: number[];
}

export interface MotionCardValidationInput {
  cues?: number[];
  timingPlan?: TimingPlan;
  frames?: number[];
  durationInFrames?: number;
  assetBindings?: CardAssetBinding[];
  /** 组合镜头放开固定布局约束，但继续执行确定性、字幕安全和可见性检查。 */
  qualityProfile?: 'motion-card' | 'agent-composite';
  checkRenderedLayout?: boolean;
}

export type MotionBibleDensity = 'quiet' | 'balanced' | 'dense';
export type MotionBibleTransition = 'crossfade' | 'hard-cut' | 'push' | 'wipe' | 'match-cut';
export type MotionBibleIssueSeverity = 'warning' | 'error';
export type MotionDirectiveVisualType = 'motion' | 'image' | 'footage';
export type MotionDirectiveComposition = 'graphic' | 'full-bleed' | 'media-window' | 'split';
export type MotionDirectiveCameraMove =
  | 'static'
  | 'push-in'
  | 'pull-out'
  | 'pan-left'
  | 'pan-right'
  | 'tracking';
export type MotionDirectiveMediaRole = 'evidence' | 'context' | 'emotion' | 'demonstration';
export type MotionDirectiveRenderStrategy = 'motion-card' | 'standalone-media' | 'agent-composite';
export type MotionDirectiveFallbackPolicy = 'standalone-media' | 'motion' | 'block';

export interface MotionDirectiveCompositionIntent {
  narrativeGoal: string;
  focalPriority: string;
  temporalRelationship: string;
  mustShow: string[];
  avoid: string[];
}

export interface MotionSegmentDirective {
  segmentId: string;
  /** 整片导演最终分配的主视觉媒介；批准后它覆盖 planning.segment 的初始建议。 */
  visualType?: MotionDirectiveVisualType;
  preferredCarrier?: string;
  /** 载体内变体提示（目前仅 'anchor'：concept 关键词锚点卡，由弱卡降级 pass 写入）。 */
  preferredVariant?: string;
  intensity: 1 | 2 | 3;
  composition?: MotionDirectiveComposition;
  cameraMove?: MotionDirectiveCameraMove;
  mediaRole?: MotionDirectiveMediaRole;
  /** 决定制作执行路由，不规定画中画、分屏等具体布局。 */
  renderStrategy?: MotionDirectiveRenderStrategy;
  /** 仅 agent-composite 使用，由下游 Agent 自主转译为 React/Remotion 构图。 */
  compositionIntent?: MotionDirectiveCompositionIntent;
  fallbackPolicy?: MotionDirectiveFallbackPolicy;
  /** footage 的素材库检索词；其它媒介可省略。 */
  mediaQuery?: string;
  footageFallback?: 'image' | 'motion';
  /** 进入本段的转场；缺省沿用整片 transitionRules.default。 */
  transition?: MotionBibleTransition;
  reason: string;
}

export interface MotionBible {
  visualThesis: string;
  rhythm: {
    density: MotionBibleDensity;
    heavySegments: string[];
    quietSegments: string[];
  };
  carrierPlan: MotionSegmentDirective[];
  styleRules: {
    paletteUse: string;
    typographyUse: string;
    recurringMotif?: string;
  };
  transitionRules: {
    default: MotionBibleTransition;
    matchCutCandidates: Array<{
      fromSegmentId: string;
      toSegmentId: string;
      motif: string;
    }>;
  };
  generatedAt?: number;
  fallbackUsed?: boolean;
  warnings?: MotionBibleIssue[];
  /** normalize 阶段系统按 concept 占比上限确定性再平衡的段数；0 / 缺省表示未触发。 */
  carrierRebalanceCount?: number;
  /** normalize 阶段弱卡降级（chapter-transition / 低可视化收益叙述段 → concept+anchor）的段数；0 / 缺省表示未触发。 */
  carrierDowngradeCount?: number;
}

export interface MotionBibleIssue {
  severity: MotionBibleIssueSeverity;
  code: string;
  message: string;
  segmentId?: string;
}

export type TimingBeatRole = 'anticipation' | 'reveal' | 'emphasis' | 'hold' | 'resolve';

export const MOTION_EMPHASIS_KINDS = [
  'countup-settle',
  'slam',
  'underline-sweep',
  'brighten',
] as const;

export type MotionEmphasisKind = (typeof MOTION_EMPHASIS_KINDS)[number];

export interface TimingPause {
  frame: number;
  durationFrames: number;
}

export interface TimingAccent {
  frame: number;
  strength: 1 | 2 | 3;
  source: 'speech' | 'subtitle' | 'bgm';
}

export interface MotionTimingMetadataAccent {
  /** 绝对时间轴时间（毫秒），相对整条口播/项目时间线。 */
  timeMs: number;
  strength: 1 | 2 | 3;
  source: 'speech' | 'bgm';
  label?: string;
}

export interface MotionTimingMetadata {
  /** TTS/audio analyzer/BGM analyzer 产出的重音或节拍；没有时 TimingPlan 仅使用 SRT。 */
  accents?: MotionTimingMetadataAccent[];
}

export interface TimingBeat {
  storyboardBeatIndex: number;
  role: TimingBeatRole;
  startFrame: number;
  landFrame: number;
  holdUntil?: number;
}

export interface TimingPlan {
  fps: number;
  cues: number[];
  pauses: TimingPause[];
  accents: TimingAccent[];
  beats: TimingBeat[];
}

export type MotionCardTransitionKind = MotionBibleTransition;

export interface MotionCardTransitionPlan {
  kind: MotionCardTransitionKind;
  overlapFrames: number;
  direction?: 'left' | 'right' | 'up' | 'down';
  motif?: string;
}

export interface MotionSubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
  relativeStartFrame: number;
  relativeEndFrame: number;
}

export interface MotionAssetInfo {
  name: string;
  type: 'image' | 'video' | 'audio' | 'other';
  path?: string;
}

export interface MotionCanvasSize {
  width: number;
  height: number;
}

export interface MotionCompileSuccess {
  success: true;
  /** Remotion 卡片 TSX 源码。 */
  tsx: string;
}

export interface MotionCompileFailure {
  success: false;
  error: string;
}

export type MotionCompileResult = MotionCompileSuccess | MotionCompileFailure;

export interface MotionGenerateParams {
  prompt: string;
  durationMs?: number;
  displayMode?: 'fullscreen' | 'pip';
  canvasSize?: MotionCanvasSize;
  assets?: MotionAssetInfo[];
}
