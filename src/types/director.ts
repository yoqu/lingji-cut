import type { TimelineData } from '../types';
import type { AISegmentAnalysis } from './ai';
import type { MotionBible } from './motion';
import type { MotionProductionPlan, VisualShotPurpose } from './production';

export type DirectorWorkflowMode = 'auto' | 'director';

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
  rationale: string;
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
  summary: string;
  keywords: string[];
  globalPrompt?: string;
  segments: DirectorSegmentPlan[];
  motionBible: MotionBible;
  coverDirection: DirectorCoverDirection;
  audioDirection: DirectorAudioDirection;
  warnings: string[];
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

export type ProductionOutputKey = 'cards' | 'cover' | 'audio' | 'timeline';
export type ProductionOutputStatus = 'empty' | 'generating' | 'current' | 'stale' | 'failed';

export interface ProductionOutputState {
  status: ProductionOutputStatus;
  directorRevision?: number;
  updatedAt: number;
  error?: string;
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
