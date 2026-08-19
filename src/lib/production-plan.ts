import type {
  AIAnalysisResult,
  AICard,
  AISegment,
  AISegmentAnalysis,
  MediaCardContent,
} from '../types/ai';
import type { MotionBible } from '../types/motion';
import type { DirectorPlan } from '../types/director';
import {
  DEFAULT_AUDIO_PLAN,
  type MotionProductionPlan,
  type AudioCuePlan,
  type MediaAssetRequest,
  type ProductionSequence,
  type VisualShot,
  type VisualShotPurpose,
} from '../types/production';
import { buildMediaReuseKey } from './media-asset-resolution';
import {
  buildPodcastBgmStyle,
} from './production-audio-prompts';
import { buildSoundCues } from './production-audio-plan';
import {
  areDirectorSoundEffectsEnabled,
  isDirectorBgmEnabled,
} from './director-audio-options';
import { syncDirectorPlanMotionBible } from './director-workflow';

function fallbackBible(): MotionBible {
  return {
    visualThesis: '信息清晰、节奏克制的专业 MG 播客视频',
    rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
    carrierPlan: [],
    styleRules: { paletteUse: '沿用项目风格', typographyUse: '沿用项目字体层级' },
    transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    fallbackUsed: true,
  };
}

function inferPurpose(segment: AISegment | undefined, card: AICard): VisualShotPurpose {
  const analyzed = segment as AISegmentAnalysis | undefined;
  const carrier = card.motionCard?.storyboard?.carrier;
  if (carrier === 'quote') return 'emphasis';
  if (carrier === 'data-hero' || carrier === 'table' || carrier === 'trend') return 'evidence';
  if (analyzed?.semanticType === 'chapter-transition') return 'transition';
  if (analyzed?.semanticType === 'data') return 'evidence';
  if (analyzed?.pacingNeed === 'accent') return 'emphasis';
  return 'explain';
}

function shotCarrier(card: AICard): string {
  return card.motionCard?.storyboard?.carrier ?? (card.type === 'image' ? 'image' : 'motion');
}

function mediaContent(card: AICard): MediaCardContent | null {
  return card.content && typeof card.content === 'object' && 'mediaType' in card.content
    ? card.content as MediaCardContent
    : null;
}

function buildShotAssetRequests(card: AICard): MediaAssetRequest[] {
  const media = mediaContent(card);
  if (!media) return [];
  const requestBase = media.mediaType === 'video'
    ? {
        kind: 'video' as const,
        role: 'broll',
        query: media.prompt || card.title,
        reusePolicy: 'prefer-library' as const,
        constraints: {
          aspectRatio: media.aspectRatio,
          durationRangeMs: [
            Math.max(0, card.displayDurationMs - 1_000),
            card.displayDurationMs + 1_000,
          ] as [number, number],
        },
      }
    : {
        kind: 'image' as const,
        role: card.displayMode === 'fullscreen' ? 'background' : 'object',
        query: media.prompt || card.title,
        reusePolicy: 'prefer-library' as const,
        constraints: { aspectRatio: media.aspectRatio },
      };
  return [{
    id: `${card.id}-media`,
    ...requestBase,
    reuseKey: buildMediaReuseKey(requestBase),
    required: true,
  }];
}

function defaultShotBeats(card: AICard): VisualShot['beats'] {
  const durationMs = Math.max(1, card.endMs - card.startMs);
  return [
    { role: 'anticipation', cueMs: 0, description: '建立视觉预备与方向' },
    { role: 'reveal', cueMs: Math.round(durationMs * 0.15), description: '揭示主信息' },
    { role: 'emphasis', cueMs: Math.round(durationMs * 0.45), description: '对齐口播重音完成强调' },
    { role: 'hold', cueMs: Math.round(durationMs * 0.65), description: '保留阅读与理解时间' },
    { role: 'resolve', cueMs: Math.round(durationMs * 0.85), description: '收势并准备下一镜头' },
  ];
}

function shotForCard(card: AICard, segment?: AISegment): VisualShot {
  const analyzed = segment as AISegmentAnalysis | undefined;
  const storyboardBeats = card.motionCard?.storyboard?.beats ?? [];
  return {
    id: card.id,
    segmentId: card.segmentId,
    startMs: card.startMs,
    endMs: card.endMs,
    purpose: inferPurpose(segment, card),
    carrier: shotCarrier(card),
    intensity: analyzed?.pacingNeed === 'accent'
      ? 3
      : analyzed?.pacingNeed === 'transition'
        ? 1
        : 2,
    beats: storyboardBeats.length > 0 ? storyboardBeats.map((beat) => ({
      role: beat.role ?? 'reveal',
      description: beat.adds,
    })) : defaultShotBeats(card),
    assetRequests: buildShotAssetRequests(card),
    audioCueIds: [],
  };
}

function sequenceId(segmentId: string): string {
  return segmentId.replace(/-part-\d+$/u, '');
}

function buildSequences(shots: VisualShot[], segments: AISegment[]): ProductionSequence[] {
  const groups = new Map<string, VisualShot[]>();
  for (const shot of shots) {
    const id = sequenceId(shot.segmentId);
    groups.set(id, [...(groups.get(id) ?? []), shot]);
  }
  return [...groups.entries()].map(([id, items]) => ({
    id,
    title: segments.find((segment) => sequenceId(segment.id) === id)?.title ?? id,
    startMs: Math.min(...items.map((item) => item.startMs)),
    endMs: Math.max(...items.map((item) => item.endMs)),
    shotIds: items.map((item) => item.id),
  }));
}

function attachCueIds(shots: VisualShot[], cues: AudioCuePlan[]): VisualShot[] {
  return shots.map((shot) => ({
    ...shot,
    audioCueIds: cues
      .filter((cue) => cue.startMs >= shot.startMs && cue.startMs < shot.endMs)
      .map((cue) => cue.id),
  }));
}

function attachTransitions(shots: VisualShot[], bible: MotionBible): VisualShot[] {
  return shots.map((shot, index) => {
    if (index === 0) return shot;
    const previous = shots[index - 1];
    const match = bible.transitionRules.matchCutCandidates.find(
      (item) => item.fromSegmentId === previous.segmentId && item.toSegmentId === shot.segmentId,
    );
    const directive = bible.carrierPlan.find((item) => item.segmentId === shot.segmentId);
    const kind = match ? 'match-cut' : directive?.transition ?? bible.transitionRules.default;
    const transition = { kind, durationMs: kind === 'hard-cut' ? 0 : 300, motif: match?.motif };
    return { ...shot, transitionIn: transition };
  }).map((shot, index, all) => (
    index < all.length - 1 && all[index + 1].transitionIn
      ? { ...shot, transitionOut: all[index + 1].transitionIn }
      : shot
  ));
}

export function buildMotionProductionPlan(
  analysis: AIAnalysisResult,
  durationMs: number,
): MotionProductionPlan {
  const segmentMap = new Map(analysis.segments.map((segment) => [segment.id, segment]));
  const bible = analysis.motionBible ?? fallbackBible();
  const baseShots = analysis.cards.map((card) => shotForCard(card, segmentMap.get(card.segmentId)));
  const sequences = buildSequences(baseShots, analysis.segments);
  const soundCues = buildSoundCues(sequences, baseShots, durationMs);
  const shots = attachTransitions(
    attachCueIds(baseShots, [...soundCues.stingers, ...soundCues.sfx]),
    bible,
  );
  const bgmRequest = {
    kind: 'audio' as const,
    role: 'bgm',
    query: buildPodcastBgmStyle(analysis, bible),
    reusePolicy: 'prefer-library' as const,
    constraints: {
      durationRangeMs: [Math.max(30_000, durationMs - 30_000), durationMs + 120_000] as [number, number],
      mood: ['克制', '专注', '现代'],
      energy: 2 as const,
      loopable: true,
    },
  };
  const reuseKey = buildMediaReuseKey(bgmRequest);
  return {
    version: 2,
    motionBible: bible,
    sequences,
    shots,
    audioPlan: {
      ...DEFAULT_AUDIO_PLAN,
      bgm: [{
        id: 'bgm-main',
        role: 'bgm',
        query: bgmRequest.query,
        startMs: 0,
        durationMs,
        required: true,
        reuseKey,
        volumeDb: -18,
        fadeInMs: 1_200,
        fadeOutMs: 1_800,
        loop: true,
      }],
      stingers: soundCues.stingers,
      sfx: soundCues.sfx,
    },
  };
}

function directorShot(segment: DirectorPlan['segments'][number]): VisualShot {
  const durationMs = Math.max(1, segment.endMs - segment.startMs);
  return {
    id: `shot-${segment.id}`,
    segmentId: segment.id,
    startMs: segment.startMs,
    endMs: segment.endMs,
    purpose: segment.purpose,
    carrier: segment.carrier,
    intensity: segment.intensity,
    composition: segment.composition ?? (segment.visualType === 'motion' ? 'graphic' : 'full-bleed'),
    cameraMove: segment.cameraMove ?? (segment.visualType === 'motion' ? 'static' : 'push-in'),
    mediaRole: segment.mediaRole ?? (segment.semanticType === 'data' ? 'evidence' : 'context'),
    beats: [
      { role: 'reveal', cueMs: Math.round(durationMs * 0.15), description: segment.rationale },
      { role: 'emphasis', cueMs: Math.round(durationMs * 0.45), description: segment.summary },
      { role: 'resolve', cueMs: Math.round(durationMs * 0.85), description: '收势并准备下一镜头' },
    ],
    assetRequests: [],
    audioCueIds: [],
  };
}

function directorSequences(
  segments: DirectorPlan['segments'],
  shots: VisualShot[],
): ProductionSequence[] {
  const shotMap = new Map(shots.map((shot) => [shot.segmentId, shot]));
  return segments.filter((segment) => segment.enabled).map((segment) => ({
    id: segment.id,
    title: segment.title,
    startMs: segment.startMs,
    endMs: segment.endMs,
    shotIds: [shotMap.get(segment.id)!.id],
  }));
}

function directorBgmCue(plan: DirectorPlan, durationMs: number): AudioCuePlan {
  const query = [
    plan.audioDirection.bgmStyle,
    `energy ${plan.audioDirection.energy}/3`,
    `${plan.audioDirection.soundDensity} sound density`,
    'instrumental podcast underscore, speech-safe mix, no vocals',
  ].join('; ');
  const request = {
    kind: 'audio' as const,
    role: 'bgm',
    query,
    reusePolicy: 'prefer-library' as const,
    constraints: {
      durationRangeMs: [Math.max(30_000, durationMs - 30_000), durationMs + 120_000] as [number, number],
      energy: plan.audioDirection.energy,
      loopable: true,
    },
  };
  return {
    id: 'bgm-main', role: 'bgm', query, startMs: 0, durationMs, required: true,
    reuseKey: buildMediaReuseKey(request), volumeDb: -18, fadeInMs: 1_200,
    fadeOutMs: 1_800, loop: true,
  };
}

export function buildDirectorExecutionPlan(
  plan: DirectorPlan,
  durationMs: number,
  now = Date.now(),
): MotionProductionPlan {
  const executionBible = syncDirectorPlanMotionBible(plan);
  const baseShots = plan.segments.filter((segment) => segment.enabled).map(directorShot);
  const sequences = directorSequences(plan.segments, baseShots);
  const cues = areDirectorSoundEffectsEnabled(plan.audioDirection)
    ? buildSoundCues(sequences, baseShots, durationMs)
    : { stingers: [], sfx: [] };
  const shots = attachTransitions(
    attachCueIds(baseShots, [...cues.stingers, ...cues.sfx]),
    executionBible,
  );
  return {
    version: 2,
    motionBible: executionBible,
    sequences,
    shots,
    audioPlan: {
      ...DEFAULT_AUDIO_PLAN,
      bgm: isDirectorBgmEnabled(plan.audioDirection) ? [directorBgmCue(plan, durationMs)] : [],
      stingers: cues.stingers,
      sfx: cues.sfx,
    },
    generationProvenance: {
      directorRevision: plan.revision,
      fingerprint: `execution-${plan.inputFingerprint}-${plan.revision}`,
      generatedAt: now,
      modifiedByUser: false,
    },
  };
}
