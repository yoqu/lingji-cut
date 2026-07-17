import type { MotionBible, MotionBibleTransition, TimingBeatRole } from './motion';
import type { GenerationProvenance } from './director';

export type VisualShotPurpose =
  | 'context'
  | 'explain'
  | 'compare'
  | 'evidence'
  | 'emphasis'
  | 'transition'
  | 'breath';

export type AudioAssetRole = 'bgm' | 'stinger' | 'sfx' | 'ambience' | 'transition-sound';
export type VideoAssetRole =
  | 'broll'
  | 'background-loop'
  | 'overlay'
  | 'transition-video'
  | 'greenscreen-video';

export interface AudioAssetConstraints {
  durationRangeMs?: [number, number];
  mood?: string[];
  energy?: 1 | 2 | 3;
  bpmRange?: [number, number];
  key?: string;
  loopable?: boolean;
  transientType?: string;
}

export interface VideoAssetConstraints {
  durationRangeMs?: [number, number];
  aspectRatio?: string;
  minWidth?: number;
  minHeight?: number;
  loopable?: boolean;
  motionIntensity?: 1 | 2 | 3;
  shotType?: string;
  subject?: string;
  action?: string;
}

export interface ImageAssetConstraints {
  aspectRatio?: string;
  minWidth?: number;
  minHeight?: number;
  hasAlpha?: boolean;
}

export type MediaAssetConstraints =
  | AudioAssetConstraints
  | VideoAssetConstraints
  | ImageAssetConstraints;

export interface MediaAssetRequest {
  id: string;
  kind: 'image' | 'video' | 'audio';
  role: string;
  query: string;
  reusePolicy: 'prefer-library' | 'generate-if-missing' | 'always-generate' | 'manual-only';
  constraints: MediaAssetConstraints;
  reuseKey: string;
  required?: boolean;
}

export interface VisualShotBeat {
  role: TimingBeatRole;
  cueMs?: number;
  description: string;
}

export interface ShotTransition {
  kind: MotionBibleTransition;
  durationMs: number;
  motif?: string;
}

export interface VisualShot {
  id: string;
  segmentId: string;
  startMs: number;
  endMs: number;
  purpose: VisualShotPurpose;
  carrier: string;
  intensity: 1 | 2 | 3;
  beats: VisualShotBeat[];
  assetRequests: MediaAssetRequest[];
  audioCueIds: string[];
  transitionIn?: ShotTransition;
  transitionOut?: ShotTransition;
}

export interface ProductionSequence {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  shotIds: string[];
}

export type AudioCueRole = AudioAssetRole;

export interface AudioCuePlan {
  id: string;
  role: AudioCueRole;
  query: string;
  startMs: number;
  durationMs?: number;
  required: boolean;
  assetId?: string;
  reuseKey: string;
  volumeDb?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  loop?: boolean;
}

export interface DuckingPlan {
  enabled: boolean;
  reductionDb: number;
  attackMs: number;
  releaseMs: number;
  holdMs: number;
}

export interface MasteringPlan {
  targetLufs: number;
  toleranceLu: number;
  maxTruePeakDbtp: number;
}

export interface AudioPlan {
  bgm: AudioCuePlan[];
  ambience: AudioCuePlan[];
  stingers: AudioCuePlan[];
  sfx: AudioCuePlan[];
  ducking: DuckingPlan;
  mastering: MasteringPlan;
}

export interface ProductionQualityIssue {
  severity: 'error' | 'warning';
  source: 'visual' | 'audio' | 'asset' | 'render';
  code: string;
  message: string;
  shotId?: string;
  cueId?: string;
}

export interface ProductionQualityReport {
  generatedAt: number;
  exportAllowed: boolean;
  degraded: boolean;
  integratedLufs?: number;
  truePeakDbtp?: number;
  remoteAssetCount: number;
  issues: ProductionQualityIssue[];
}

export type ProductionWorkflowStage =
  | 'planning'
  | 'animatic-review'
  | 'approved'
  | 'quality-blocked'
  | 'complete';

export interface ProductionWorkflowState {
  mode: 'auto' | 'director';
  stage: ProductionWorkflowStage;
  updatedAt: number;
  approvedAt?: number;
}

export interface MotionProductionPlan {
  version: 2;
  motionBible: MotionBible;
  sequences: ProductionSequence[];
  shots: VisualShot[];
  audioPlan: AudioPlan;
  workflow?: ProductionWorkflowState;
  qualityReport?: ProductionQualityReport;
  generationProvenance?: GenerationProvenance;
}

export const DEFAULT_AUDIO_PLAN: AudioPlan = {
  bgm: [],
  ambience: [],
  stingers: [],
  sfx: [],
  ducking: {
    enabled: true,
    reductionDb: 6,
    attackMs: 80,
    releaseMs: 350,
    holdMs: 600,
  },
  mastering: {
    targetLufs: -15,
    toleranceLu: 1,
    maxTruePeakDbtp: -1,
  },
};
