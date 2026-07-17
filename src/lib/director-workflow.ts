import type { SrtEntry } from '../types';
import type { AIAnalysisResult, AISegmentAnalysis } from '../types/ai';
import type {
  DirectorChangeImpact,
  DirectorPlan,
  DirectorSegmentPlan,
  LegacyProductionMigrationInput,
  ProjectProductionState,
} from '../types/director';
import type { MotionBible } from '../types/motion';
import type { VisualShotPurpose } from '../types/production';

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `director-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function createDirectorInputFingerprint(input: {
  entries: SrtEntry[];
  globalPrompt?: string;
  stylePresetId?: string;
}): string {
  return stableHash(JSON.stringify({
    entries: input.entries.map(({ index, startMs, endMs, text }) => ({
      index,
      startMs,
      endMs,
      text: text.trim(),
    })),
    globalPrompt: input.globalPrompt?.trim() ?? '',
    stylePresetId: input.stylePresetId ?? '',
  }));
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function globalStrategyChanged(before: DirectorPlan, after: DirectorPlan): boolean {
  return before.inputFingerprint !== after.inputFingerprint
    || before.summary !== after.summary
    || before.globalPrompt !== after.globalPrompt
    || !same(before.keywords, after.keywords)
    || before.motionBible.visualThesis !== after.motionBible.visualThesis
    || !same(before.motionBible.rhythm, after.motionBible.rhythm)
    || !same(before.motionBible.styleRules, after.motionBible.styleRules);
}

export function compareDirectorPlans(before: DirectorPlan, after: DirectorPlan): DirectorChangeImpact {
  const impact: DirectorChangeImpact = {
    allCards: false,
    segmentIds: [],
    cover: false,
    audio: false,
    timeline: false,
    quality: false,
    reasons: [],
  };
  if (globalStrategyChanged(before, after)) {
    impact.allCards = true;
    impact.cover = true;
    impact.audio = true;
    impact.timeline = true;
    addReason(impact.reasons, 'global-strategy');
  }
  if (!same(before.motionBible.transitionRules, after.motionBible.transitionRules)) {
    impact.timeline = true;
    addReason(impact.reasons, 'transition-rules');
  }
  const beforeSegments = new Map(before.segments.map((segment) => [segment.id, segment]));
  const afterSegments = new Map(after.segments.map((segment) => [segment.id, segment]));
  for (const segmentId of new Set([...beforeSegments.keys(), ...afterSegments.keys()])) {
    const previous = beforeSegments.get(segmentId);
    const next = afterSegments.get(segmentId);
    if (!previous || !next) {
      impact.segmentIds.push(segmentId);
      impact.cover = true;
      impact.audio = true;
      impact.timeline = true;
      addReason(impact.reasons, 'segment-structure');
      continue;
    }
    if (same(previous, next)) continue;
    impact.segmentIds.push(segmentId);
    impact.timeline = true;
    addReason(impact.reasons, 'segment-directive');
    if (
      previous.title !== next.title
      || previous.summary !== next.summary
      || previous.enabled !== next.enabled
      || previous.visualType !== next.visualType
      || previous.startMs !== next.startMs
      || previous.endMs !== next.endMs
    ) impact.cover = true;
    if (
      previous.purpose !== next.purpose
      || previous.intensity !== next.intensity
      || previous.enabled !== next.enabled
      || previous.startMs !== next.startMs
      || previous.endMs !== next.endMs
    ) impact.audio = true;
  }
  if (!same(before.coverDirection, after.coverDirection)) {
    impact.cover = true;
    addReason(impact.reasons, 'cover-direction');
  }
  if (!same(before.audioDirection, after.audioDirection)) {
    impact.audio = true;
    addReason(impact.reasons, 'audio-direction');
  }
  impact.segmentIds = [...new Set(impact.segmentIds)].sort();
  impact.quality = impact.allCards
    || impact.segmentIds.length > 0
    || impact.cover
    || impact.audio
    || impact.timeline;
  return impact;
}

/**
 * 制作是否可从当前状态「继续」（增量补生成失败镜头并重排时间线）。
 * refining 阶段仅在存在失败产出时开放，避免正常精修期出现无意义入口。
 */
export function canResumeProduction(production: ProjectProductionState): boolean {
  if (!production.approvedPlan) return false;
  const { stage } = production.workflow;
  if (stage === 'production-paused' || stage === 'error' || stage === 'quality-blocked') return true;
  if (stage !== 'refining') return false;
  return production.outputs.cards.status === 'failed'
    || production.outputs.timeline.status === 'failed';
}

export function createEmptyProductionState(now = Date.now()): ProjectProductionState {
  const emptyOutput = { status: 'empty' as const, updatedAt: now };
  return {
    version: 3,
    draftPlan: null,
    approvedPlan: null,
    execution: null,
    workflow: { mode: 'director', stage: 'idle', updatedAt: now },
    pendingImpact: null,
    outputs: {
      cards: { ...emptyOutput },
      cover: { ...emptyOutput },
      audio: { ...emptyOutput },
      timeline: { ...emptyOutput },
    },
    legacyProtected: false,
    updatedAt: now,
  };
}

function purposeFor(segment: AISegmentAnalysis): VisualShotPurpose {
  if (segment.semanticType === 'data') return 'evidence';
  if (segment.semanticType === 'chapter-transition') return 'transition';
  if (segment.semanticType === 'quote') return 'emphasis';
  return 'explain';
}

function directorSegment(segment: AISegmentAnalysis, bible: MotionBible): DirectorSegmentPlan {
  const directive = bible.carrierPlan.find((item) => item.segmentId === segment.id);
  return {
    ...segment,
    enabled: true,
    purpose: purposeFor(segment),
    carrier: directive?.preferredCarrier ?? (segment.visualType === 'image' ? 'image' : 'concept'),
    intensity: directive?.intensity ?? (segment.pacingNeed === 'accent' ? 3 : 2),
    rationale: directive?.reason ?? '由旧项目分析结果恢复。',
  };
}

function legacyDirectorPlan(
  analysis: AIAnalysisResult,
  now: number,
  approved: boolean,
): DirectorPlan {
  const bible = analysis.motionBible ?? {
    visualThesis: analysis.summary || '信息清晰、节奏克制的专业 MG 视频',
    rhythm: { density: 'balanced' as const, heavySegments: [], quietSegments: [] },
    carrierPlan: [],
    styleRules: { paletteUse: '沿用项目风格', typographyUse: '沿用项目字体层级' },
    transitionRules: { default: 'crossfade' as const, matchCutCandidates: [] },
    fallbackUsed: true,
  };
  return {
    revision: 1,
    inputFingerprint: stableHash(JSON.stringify(analysis.segments)),
    summary: analysis.summary,
    keywords: analysis.keywords,
    globalPrompt: analysis.globalPrompt,
    segments: analysis.segments.map((segment) => directorSegment(segment as AISegmentAnalysis, bible)),
    motionBible: bible,
    coverDirection: {
      prompt: analysis.coverPrompts[0] ?? '',
      composition: '沿用旧项目封面构图',
    },
    audioDirection: {
      bgmEnabled: true,
      soundEffectsEnabled: true,
      bgmStyle: '克制、现代、为口播留出空间',
      energy: 2,
      soundDensity: 'balanced',
    },
    warnings: ['此导演方案由 V2 项目自动恢复，已有制作结果受到保护。'],
    createdAt: now,
    updatedAt: now,
    approvedAt: approved ? now : undefined,
  };
}

export function migrateLegacyProductionState(input: LegacyProductionMigrationInput): ProjectProductionState {
  const now = input.now ?? Date.now();
  const state = createEmptyProductionState(now);
  state.workflow.mode = input.mode;
  if (!input.analysisResult?.segments.length) return state;
  const approved = input.analysisResult.cards.length > 0;
  const plan = legacyDirectorPlan(input.analysisResult, now, approved);
  state.execution = input.legacyPlan;
  state.legacyProtected = approved;
  if (!approved) {
    state.draftPlan = plan;
    state.workflow.stage = 'director-review';
    return state;
  }
  state.approvedPlan = plan;
  state.workflow.stage = input.mode === 'director' ? 'animatic-review' : 'complete';
  state.workflow.directorApprovedAt = now;
  for (const key of Object.keys(state.outputs) as Array<keyof typeof state.outputs>) {
    state.outputs[key] = { status: 'current', directorRevision: 1, updatedAt: now };
  }
  return state;
}
