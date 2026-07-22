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
  checkRenderedLayout?: boolean;
}

export type MotionBibleDensity = 'quiet' | 'balanced' | 'dense';
export type MotionBibleTransition = 'crossfade' | 'hard-cut' | 'push' | 'wipe' | 'match-cut';
export type MotionBibleIssueSeverity = 'warning' | 'error';

export interface MotionSegmentDirective {
  segmentId: string;
  preferredCarrier?: string;
  intensity: 1 | 2 | 3;
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

export type MotionTemplateKey =
  | 'kpi-countup'
  | 'bar-chart-reveal'
  | 'ranking-stack'
  | 'before-after-compare'
  | 'step-flow-explainer'
  | 'chapter-stinger';

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
