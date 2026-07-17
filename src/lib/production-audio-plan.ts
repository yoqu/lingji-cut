import type {
  AudioCuePlan,
  MotionProductionPlan,
  ProductionSequence,
  VisualShot,
} from '../types/production';
import { buildMediaReuseKey } from './media-asset-resolution';
import { buildChapterStingerPrompt, buildShotSfxPrompt } from './production-audio-prompts';

export const AUDIO_CUE_TARGET_PER_MINUTE = 3;
export const MAX_STINGERS_PER_MINUTE = 1;
export const MIN_STINGER_GAP_MS = 30_000;
export const MIN_SFX_GAP_MS = 15_000;
export const MIN_CROSS_CUE_GAP_MS = 6_000;

function audioCue(
  role: 'stinger' | 'sfx',
  id: string,
  query: string,
  startMs: number,
  durationMs: number,
  transientType: string,
): AudioCuePlan {
  const request = {
    kind: 'audio' as const,
    role,
    query,
    reusePolicy: 'prefer-library' as const,
    constraints: {
      durationRangeMs: [200, durationMs] as [number, number],
      loopable: false,
      transientType,
    },
  };
  return {
    id,
    role,
    query,
    startMs,
    durationMs,
    required: false,
    reuseKey: buildMediaReuseKey(request),
    volumeDb: role === 'stinger' ? -14 : -12,
    fadeInMs: role === 'stinger' ? 80 : 0,
    fadeOutMs: role === 'stinger' ? 250 : 80,
  };
}

function takeEvenly<T>(items: T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return [];
  if (items.length <= count) return items;
  if (count === 1) return [items[Math.floor(items.length / 2)]];
  return Array.from({ length: count }, (_, index) => (
    items[Math.round(index * (items.length - 1) / (count - 1))]
  ));
}

function chapterSequences(sequences: ProductionSequence[], shots: VisualShot[]): ProductionSequence[] {
  const shotMap = new Map(shots.map((shot) => [shot.id, shot]));
  const candidates = sequences.slice(1).filter((sequence) => sequence.shotIds.some((id) => {
    const shot = shotMap.get(id);
    return shot?.intensity === 1 || shot?.purpose === 'transition';
  }));
  const collapsed: ProductionSequence[] = [];
  for (const sequence of candidates) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && sequence.startMs - previous.startMs < MIN_STINGER_GAP_MS) {
      collapsed[collapsed.length - 1] = sequence;
    } else {
      collapsed.push(sequence);
    }
  }
  return collapsed;
}

function buildStingers(
  sequences: ProductionSequence[],
  shots: VisualShot[],
  durationMs: number,
): AudioCuePlan[] {
  const maxStingers = Math.ceil(durationMs / 60_000) * MAX_STINGERS_PER_MINUTE;
  return takeEvenly(chapterSequences(sequences, shots), maxStingers).map((sequence, index) => audioCue(
    'stinger',
    `stinger-${index + 1}`,
    buildChapterStingerPrompt(sequence.title),
    sequence.startMs,
    3_000,
    'chapter-stinger',
  ));
}

function shotCueStart(shot: VisualShot): number {
  return shot.startMs + Math.min(800, Math.max(0, shot.endMs - shot.startMs) * 0.2);
}

function buildSfx(shots: VisualShot[], stingers: AudioCuePlan[], maxSfx: number): AudioCuePlan[] {
  const candidates = shots.filter((shot) => (
    shot.intensity === 3 || ['emphasis', 'evidence', 'transition'].includes(shot.purpose)
  ));
  const selected: VisualShot[] = [];
  for (const shot of candidates) {
    if (selected.length >= maxSfx) break;
    const startMs = shotCueStart(shot);
    const previous = selected[selected.length - 1];
    if (previous && startMs - shotCueStart(previous) < MIN_SFX_GAP_MS) continue;
    if (stingers.some((cue) => Math.abs(startMs - cue.startMs) < MIN_CROSS_CUE_GAP_MS)) continue;
    selected.push(shot);
  }
  return selected.map((shot, index) => audioCue(
    'sfx',
    `sfx-${index + 1}`,
    buildShotSfxPrompt(shot.purpose === 'transition' ? 'whoosh' : 'impact', shot.carrier),
    shotCueStart(shot),
    1_200,
    shot.purpose === 'transition' ? 'whoosh' : 'impact',
  ));
}

export function buildSoundCues(
  sequences: ProductionSequence[],
  shots: VisualShot[],
  durationMs: number,
): { stingers: AudioCuePlan[]; sfx: AudioCuePlan[] } {
  const stingers = buildStingers(sequences, shots, durationMs);
  const totalBudget = Math.max(1, Math.round(durationMs / 60_000 * AUDIO_CUE_TARGET_PER_MINUTE));
  const sfx = buildSfx(shots, stingers, Math.max(0, totalBudget - stingers.length));
  return { stingers, sfx };
}

function cueSignature(cues: AudioCuePlan[]): string {
  return JSON.stringify(cues.map((cue) => ({
    id: cue.id,
    startMs: cue.startMs,
    durationMs: cue.durationMs,
    query: cue.query,
    volumeDb: cue.volumeDb,
  })));
}

export function rebalanceProductionSoundPlan(plan: MotionProductionPlan): MotionProductionPlan {
  const existing = [...plan.audioPlan.stingers, ...plan.audioPlan.sfx];
  if (existing.some((cue) => cue.assetId)) return plan;
  const durationMs = plan.audioPlan.bgm[0]?.durationMs
    || Math.max(0, ...plan.shots.map((shot) => shot.endMs));
  if (durationMs < 30_000) return plan;
  const currentRate = existing.length / (durationMs / 60_000);
  const maxStingers = Math.ceil(durationMs / 60_000) * MAX_STINGERS_PER_MINUTE;
  if (currentRate <= 4 && plan.audioPlan.stingers.length <= maxStingers) return plan;

  const next = buildSoundCues(plan.sequences, plan.shots, durationMs);
  if (
    cueSignature(plan.audioPlan.stingers) === cueSignature(next.stingers)
    && cueSignature(plan.audioPlan.sfx) === cueSignature(next.sfx)
  ) return plan;

  const oldCueIds = new Set(existing.map((cue) => cue.id));
  const nextCues = [...next.stingers, ...next.sfx];
  return {
    ...plan,
    shots: plan.shots.map((shot) => ({
      ...shot,
      audioCueIds: [
        ...shot.audioCueIds.filter((id) => !oldCueIds.has(id)),
        ...nextCues
          .filter((cue) => cue.startMs >= shot.startMs && cue.startMs < shot.endMs)
          .map((cue) => cue.id),
      ],
    })),
    audioPlan: {
      ...plan.audioPlan,
      stingers: next.stingers,
      sfx: next.sfx,
    },
  };
}
