import type { TimingPlan } from '../types/motion';
import type { MotionStoryboard } from './motion-storyboard';

export interface SelectMotionCardKeyframesInput {
  durationInFrames: number;
  cues?: number[];
  storyboard?: MotionStoryboard | null;
  anchors?: Array<number | null>;
  lead?: number;
  revealDuration?: number;
  maxFrames?: number;
}

const DEFAULT_LEAD = 10;
const DEFAULT_REVEAL_DURATION = 14;
const DEFAULT_MAX_FRAMES = 8;

function clampFrame(frame: number, durationInFrames: number): number {
  const max = Math.max(0, Math.round(durationInFrames) - 1);
  return Math.max(0, Math.min(max, Math.round(frame)));
}

function anchorsFromStoryboard(storyboard?: MotionStoryboard | null): Array<number | null> {
  if (!storyboard?.beats?.length) return [null];
  return storyboard.beats.map((beat, index) => (index === 0 ? null : beat.cue ?? null));
}

export function computeMotionBeatLandFrames(
  input: SelectMotionCardKeyframesInput,
): number[] {
  const durationInFrames = Math.max(1, Math.round(input.durationInFrames));
  const cues = input.cues ?? [];
  const anchors = input.anchors?.length ? input.anchors : anchorsFromStoryboard(input.storyboard);
  const lead = input.lead ?? DEFAULT_LEAD;
  const revealDuration = input.revealDuration ?? DEFAULT_REVEAL_DURATION;
  const entranceEnd = Math.min(18, Math.round(durationInFrames * 0.12));
  const count = Math.max(anchors.length, 1);
  const starts: number[] = [];

  for (let i = 0; i < count; i += 1) {
    let start: number;
    if (i === 0) {
      start = 0;
    } else {
      const cueIndex = anchors[i];
      const hasCue =
        Array.isArray(cues) &&
        cues.length > 0 &&
        cueIndex != null &&
        cueIndex >= 0 &&
        cueIndex < cues.length;
      start = hasCue
        ? cues[cueIndex as number] - lead
        : entranceEnd + (durationInFrames * 0.8 - entranceEnd) * (count > 1 ? i / (count - 1) : 0);
      start = Math.max(entranceEnd, Math.min(durationInFrames - 12, start));
      start = Math.max(start, starts[i - 1] ?? 0);
    }
    starts.push(Math.round(start));
  }

  return starts.map((start) => clampFrame(start + revealDuration, durationInFrames));
}

export function selectMotionCardKeyframes(input: SelectMotionCardKeyframesInput): number[] {
  const durationInFrames = Math.max(1, Math.round(input.durationInFrames));
  const maxFrames = Math.max(3, Math.round(input.maxFrames ?? DEFAULT_MAX_FRAMES));
  const lands = computeMotionBeatLandFrames(input);
  const required = new Set<number>([0, durationInFrames - 1]);
  const focusBeat = input.storyboard?.focus?.beat;
  if (
    typeof focusBeat === 'number' &&
    Number.isInteger(focusBeat) &&
    focusBeat >= 0 &&
    focusBeat < lands.length
  ) {
    required.add(lands[focusBeat]);
  }

  const selected = new Set<number>(required);
  for (const frame of lands) {
    if (selected.size >= maxFrames) break;
    selected.add(frame);
  }

  return Array.from(selected)
    .map((frame) => clampFrame(frame, durationInFrames))
    .sort((a, b) => a - b);
}

/**
 * 机械碰撞探针使用更密的帧集合：每拍开始、运动中点、落点与落点后都要覆盖。
 * 视觉 contact sheet 仍使用上面的精简集合，避免无谓放大审片成本。
 */
export function selectMotionCardProbeFrames(input: {
  durationInFrames: number;
  timingPlan?: TimingPlan;
  storyboard?: MotionStoryboard | null;
  cues?: number[];
  maxFrames?: number;
}): number[] {
  const durationInFrames = Math.max(1, Math.round(input.durationInFrames));
  const maxFrames = Math.max(6, Math.round(input.maxFrames ?? 18));
  const selected = new Set<number>([0, durationInFrames - 1]);
  const beats = input.timingPlan?.beats;
  if (beats?.length) {
    for (const beat of beats) {
      const start = clampFrame(beat.startFrame, durationInFrames);
      const land = clampFrame(beat.landFrame, durationInFrames);
      selected.add(start);
      selected.add(clampFrame((start + land) / 2, durationInFrames));
      selected.add(land);
      selected.add(clampFrame(land + 2, durationInFrames));
    }
  } else {
    const lands = computeMotionBeatLandFrames({
      durationInFrames,
      storyboard: input.storyboard,
      cues: input.cues,
    });
    for (const land of lands) {
      selected.add(clampFrame(land - DEFAULT_REVEAL_DURATION / 2, durationInFrames));
      selected.add(land);
      selected.add(clampFrame(land + 2, durationInFrames));
    }
  }
  const frames = Array.from(selected).sort((a, b) => a - b);
  if (frames.length <= maxFrames) return frames;
  const required = new Set<number>([0, durationInFrames - 1]);
  const focusBeat = input.storyboard?.focus?.beat;
  if (focusBeat != null && beats?.[focusBeat]) {
    required.add(clampFrame(beats[focusBeat].landFrame, durationInFrames));
  }
  const remaining = frames.filter((frame) => !required.has(frame));
  const slots = Math.max(0, maxFrames - required.size);
  for (let index = 0; index < slots; index += 1) {
    const sourceIndex = Math.min(
      remaining.length - 1,
      Math.round((index * Math.max(0, remaining.length - 1)) / Math.max(1, slots - 1)),
    );
    if (sourceIndex >= 0) required.add(remaining[sourceIndex]);
  }
  return Array.from(required).sort((a, b) => a - b);
}
