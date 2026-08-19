import type { TimelineData } from '../types';
import type { AISegmentAnalysis } from './ai';
import type {
  MotionBible,
  MotionBibleTransition,
  MotionDirectiveCameraMove,
  MotionDirectiveComposition,
  MotionDirectiveCompositionIntent,
  MotionDirectiveFallbackPolicy,
  MotionDirectiveMediaRole,
  MotionDirectiveRenderStrategy,
} from './motion';
import type { MotionProductionPlan, VisualShotPurpose } from './production';
import type {
  DirectorCompositionAsset,
  FootageCompositionInput,
  FootageFallbackPlan,
  FootagePlacement,
  SelectedFootageAsset,
} from './footage';

export type DirectorWorkflowMode = 'auto' | 'director';

export type DirectorRenderStrategy = MotionDirectiveRenderStrategy;
export type DirectorCompositionIntent = MotionDirectiveCompositionIntent;
export type DirectorFallbackPolicy = MotionDirectiveFallbackPolicy;

export type DirectorStrategyStatus = 'ready' | 'blocked' | 'fallback';

export interface DirectorAssetDecision {
  candidateId: string;
  decision: 'selected' | 'rejected';
  reason: string;
  /** 0-1，表示导演对这项素材判断的把握，不等同于素材检索分。 */
  confidence?: number;
  inspected?: boolean;
}

export interface DirectorFallbackDecision {
  from: 'agent-composite' | 'standalone-media';
  to: 'motion-card' | 'standalone-media';
  reason: string;
  explicit: true;
}

export interface DirectorSegmentLocks {
  /** 用户已手工指定执行策略；重新编排时 Pi 不得覆盖。 */
  strategy?: boolean;
  /** 用户已手工选择素材；重新编排时 Pi 不得替换或删除。 */
  assets?: boolean;
  /** 用户已手工修改合成意图、机位或其它镜头语言。 */
  direction?: boolean;
}

export interface DirectorPlanLocks {
  title?: boolean;
  summary?: boolean;
  cover?: boolean;
  audio?: boolean;
  globalDirection?: boolean;
}

export type DirectorWorkflowStage =
  | 'idle'
  | 'director-planning'
  | 'director-review'
  | 'production-running'
  | 'production-paused'
  | 'animatic-review'
  | 'refining'
  | 'quality-blocked'
  | 'complete'
  | 'error';

export interface DirectorSegmentPlan extends AISegmentAnalysis {
  enabled: boolean;
  purpose: VisualShotPurpose;
  carrier: string;
  intensity: 1 | 2 | 3;
  /** 导演审核阶段人工确认的素材；存在时制作轨不得再自动替换。 */
  selectedFootage?: SelectedFootageAsset;
  /**
   * 画面内容类型与执行方式分离：visualType 描述素材形态，renderStrategy 决定最终如何渲染。
   * 旧项目缺失时 footage 映射为 standalone-media，其余映射为 motion-card。
   */
  renderStrategy?: DirectorRenderStrategy;
  compositionIntent?: DirectorCompositionIntent;
  compositionAssets?: DirectorCompositionAsset[];
  /** agent-composite 缺省 block，禁止组合失败后静默变为纯 Motion。 */
  fallbackPolicy?: DirectorFallbackPolicy;
  /** 旧导演方案可缺失；执行时按视觉形式补默认值。 */
  composition?: MotionDirectiveComposition;
  cameraMove?: MotionDirectiveCameraMove;
  mediaRole?: MotionDirectiveMediaRole;
  transition?: MotionBibleTransition;
  rationale: string;
  /** Pi 导演选择本策略的直接理由；与面向执行的 rationale 分开保存。 */
  strategyReason?: string;
  /** 0-1。低置信度不会被框架改写，只在导演台明确提示。 */
  strategyConfidence?: number;
  /** 组合镜头的“双重不可替代”证据。 */
  mediaIndispensability?: string;
  graphicsIndispensability?: string;
  assetDecisions?: DirectorAssetDecision[];
  strategyStatus?: DirectorStrategyStatus;
  blockedReason?: string;
  fallbackDecision?: DirectorFallbackDecision;
  userLocks?: DirectorSegmentLocks;
}

export interface DirectorCoverDirection {
  prompt: string;
  composition: string;
  mood?: string;
  typography?: string;
  negativeConstraints?: string;
}

export interface DirectorAudioDirection {
  /** 缺省 true，兼容没有该字段的早期 V3 项目。 */
  bgmEnabled?: boolean;
  /** 缺省 true，控制 ambience / stinger / sfx。 */
  soundEffectsEnabled?: boolean;
  bgmStyle: string;
  energy: 1 | 2 | 3;
  soundDensity: 'quiet' | 'balanced' | 'active';
}

export interface DirectorPlan {
  revision: number;
  inputFingerprint: string;
  /** 作品标题；旧导演方案可缺失，新的规划会生成并同步到项目元信息。 */
  title?: string;
  summary: string;
  keywords: string[];
  /** 用户明确输入的创作要求；只允许此字段在重新编排时回注为用户指令。 */
  userPrompt?: string;
  globalPrompt?: string;
  segments: DirectorSegmentPlan[];
  motionBible: MotionBible;
  coverDirection: DirectorCoverDirection;
  audioDirection: DirectorAudioDirection;
  warnings: string[];
  /** 全片没有 agent-composite 时必须由 Pi 给出，避免“全是 Motion”成为静默默认。 */
  zeroCompositeReason?: string;
  /** 顶层 Pi 导演运行的可追溯摘要；不含提示词、凭证或素材绝对路径。 */
  agentPlanning?: {
    roleVersion: string;
    workflowVersion: string;
    completedAt: number;
    toolCalls: number;
    repairRounds: number;
    materialSearches?: number;
    materialSearchFailures?: number;
    candidateCount?: number;
    inspectedCandidateCount?: number;
  };
  userLocks?: DirectorPlanLocks;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
}

export interface DirectorChangeImpact {
  allCards: boolean;
  segmentIds: string[];
  cover: boolean;
  audio: boolean;
  timeline: boolean;
  quality: boolean;
  reasons: string[];
}

export interface GenerationProvenance {
  directorRevision: number;
  fingerprint: string;
  generatedAt: number;
  modifiedByUser?: boolean;
  legacyProtected?: boolean;
}

export type ProductionOutputKey = 'cards' | 'cover' | 'audio' | 'timeline' | 'footage';
export type ProductionOutputStatus = 'empty' | 'generating' | 'current' | 'stale' | 'failed';

export interface ProductionOutputState {
  status: ProductionOutputStatus;
  directorRevision?: number;
  updatedAt: number;
  error?: string;
}

/**
 * footage 轨制作产物：成功认领的素材放置 + 未认领段的出卡退路。
 * 恢复制作时若 provenance 与 outputs.footage 匹配则整份复用，不重新检索 KaCut。
 */
export interface FootageProductionState {
  placements: FootagePlacement[];
  /** 旧项目可缺失；读取时按空数组处理。 */
  compositionInputs?: FootageCompositionInput[];
  claimedSegmentIds: string[];
  fallbacks: FootageFallbackPlan[];
  blockedSegmentIds?: string[];
  generationProvenance?: GenerationProvenance;
}

/** 统一 renderer / headless 的旧项目执行路由。 */
export function resolveDirectorRenderStrategy(
  segment: Pick<DirectorSegmentPlan, 'renderStrategy' | 'visualType'>,
): DirectorRenderStrategy {
  if (
    segment.renderStrategy === 'motion-card'
    || segment.renderStrategy === 'standalone-media'
    || segment.renderStrategy === 'agent-composite'
  ) return segment.renderStrategy;
  return segment.visualType === 'footage' ? 'standalone-media' : 'motion-card';
}

export function resolveDirectorFallbackPolicy(
  segment: Pick<DirectorSegmentPlan, 'fallbackPolicy' | 'renderStrategy' | 'visualType'>,
): DirectorFallbackPolicy {
  if (
    segment.fallbackPolicy === 'standalone-media'
    || segment.fallbackPolicy === 'motion'
    || segment.fallbackPolicy === 'block'
  ) return segment.fallbackPolicy;
  return resolveDirectorRenderStrategy(segment) === 'agent-composite' ? 'block' : 'motion';
}

export interface ProjectProductionWorkflow {
  mode: DirectorWorkflowMode;
  stage: DirectorWorkflowStage;
  updatedAt: number;
  directorApprovedAt?: number;
  animaticApprovedAt?: number;
  failedStage?: DirectorWorkflowStage;
  error?: string;
  activeTaskId?: string;
}

export interface ProjectProductionState {
  version: 3;
  draftPlan: DirectorPlan | null;
  approvedPlan: DirectorPlan | null;
  execution: MotionProductionPlan | null;
  workflow: ProjectProductionWorkflow;
  pendingImpact: DirectorChangeImpact | null;
  outputs: Record<ProductionOutputKey, ProductionOutputState>;
  /** footage 轨产物；旧项目（footage 轨引入前）缺失，读取时按无产物处理。 */
  footage?: FootageProductionState | null;
  legacyProtected: boolean;
  updatedAt: number;
}

export interface LegacyProductionMigrationInput {
  analysisResult: import('./ai').AIAnalysisResult | null;
  legacyPlan: MotionProductionPlan | null;
  timeline: TimelineData | null;
  mode: DirectorWorkflowMode;
  now?: number;
}
