import type { SrtEntry } from '../types';
import type {
  MotionTimingMetadata,
  TimingAccent,
  TimingBeat,
  TimingBeatRole,
  TimingPause,
  TimingPlan,
} from '../types/motion';
import type { MotionStoryboard, StoryboardBeat } from './motion-storyboard';
import { msToFrames } from '../remotion/frames';

export const TIMING_PAUSE_THRESHOLD_MS = 400;

/**
 * 音画重音吸附容差：emphasis 拍的落地帧只在这个窗口内向最近重音帧对齐，
 * 避免节拍被拉离分镜/字幕锚点太远。与停顿阈值同量级（30fps 下 12 帧）。
 */
export const ACCENT_SNAP_TOLERANCE_MS = 400;

/**
 * 把 frame 吸附到容差内最近的重音帧；等距时强度高者优先，再等距取更早帧。
 * 无候选（无 accents / 全部超出容差）时原样返回——无重音数据时产物与旧版逐帧一致。
 */
export function snapFrameToAccents(frame: number, accents: TimingAccent[], toleranceFrames: number): number {
  let best: TimingAccent | undefined;
  let bestDistance = Infinity;
  for (const accent of accents) {
    const distance = Math.abs(accent.frame - frame);
    if (distance > toleranceFrames) continue;
    if (!best || distance < bestDistance || (distance === bestDistance && accent.strength > best.strength)) {
      best = accent;
      bestDistance = distance;
    }
  }
  return best ? best.frame : frame;
}

export interface BuildTimingPlanInput {
  srt: SrtEntry[];
  startMs: number;
  durationMs: number;
  fps: number;
  storyboard?: MotionStoryboard | null;
  metadata?: MotionTimingMetadata;
}

interface WindowEntry extends SrtEntry {
  relativeStartFrame: number;
  relativeEndFrame: number;
}

function clampFrame(frame: number, durationFrames: number): number {
  return Math.max(0, Math.min(Math.max(0, durationFrames - 1), Math.round(frame)));
}

function entriesInWindow(input: BuildTimingPlanInput): WindowEntry[] {
  const base = msToFrames(input.startMs, input.fps);
  const endMs = input.startMs + input.durationMs;
  return input.srt
    .filter((entry) => entry.startMs >= input.startMs && entry.startMs < endMs)
    .sort((a, b) => a.startMs - b.startMs)
    .map((entry) => ({
      ...entry,
      relativeStartFrame: Math.max(0, msToFrames(entry.startMs, input.fps) - base),
      relativeEndFrame: Math.max(0, msToFrames(entry.endMs, input.fps) - base),
    }));
}

function detectPauses(entries: WindowEntry[], fps: number): TimingPause[] {
  const pauses: TimingPause[] = [];
  for (let i = 0; i < entries.length - 1; i += 1) {
    const current = entries[i];
    const next = entries[i + 1];
    const gapMs = next.startMs - current.endMs;
    if (gapMs <= TIMING_PAUSE_THRESHOLD_MS) continue;
    pauses.push({
      frame: current.relativeEndFrame,
      durationFrames: Math.max(1, msToFrames(gapMs, fps)),
    });
  }
  return pauses;
}

function accentStrength(text: string): 0 | 1 | 2 | 3 {
  const compact = text.replace(/\s/g, '');
  const hasNumber = /\d/.test(compact);
  const hasPunch = /[!！?？。；;]/.test(compact);
  const hasEmphasisWord = /关键|重点|只有|必须|第一|最后|真正|核心|暴涨|翻倍/.test(compact);
  if (hasNumber && (hasPunch || hasEmphasisWord)) return 3;
  if (hasNumber || hasEmphasisWord) return 2;
  if (compact.length > 0 && compact.length <= 12 && hasPunch) return 1;
  return 0;
}

function detectAccents(entries: WindowEntry[]): TimingAccent[] {
  const accents: TimingAccent[] = [];
  for (const entry of entries) {
    const strength = accentStrength(entry.text);
    if (strength === 0) continue;
    accents.push({
      frame: entry.relativeStartFrame,
      strength,
      source: 'subtitle',
    });
  }
  return accents;
}

function metadataAccents(input: BuildTimingPlanInput, durationFrames: number): TimingAccent[] {
  const startMs = input.startMs;
  const endMs = input.startMs + input.durationMs;
  const accents: TimingAccent[] = [];
  for (const accent of input.metadata?.accents ?? []) {
    if (!Number.isFinite(accent.timeMs) || accent.timeMs < startMs || accent.timeMs >= endMs) continue;
    accents.push({
      frame: clampFrame(msToFrames(accent.timeMs - startMs, input.fps), durationFrames),
      strength: accent.strength,
      source: accent.source,
    });
  }
  return accents;
}

function mergeAccents(accents: TimingAccent[]): TimingAccent[] {
  const rank: Record<TimingAccent['source'], number> = { speech: 3, bgm: 2, subtitle: 1 };
  const byFrame = new Map<number, TimingAccent>();
  for (const accent of accents) {
    const key = accent.frame;
    const existing = byFrame.get(key);
    if (
      !existing ||
      accent.strength > existing.strength ||
      (accent.strength === existing.strength && rank[accent.source] > rank[existing.source])
    ) {
      byFrame.set(key, accent);
    }
  }
  return Array.from(byFrame.values()).sort((a, b) => a.frame - b.frame);
}

export function defaultTimingRole(beat: Pick<StoryboardBeat, 'kind' | 'role'>, index: number, lastIndex: number, focusBeat = -1): TimingBeatRole {
  if (beat.role) return beat.role;
  if (index === focusBeat || beat.kind === 'accent') return 'emphasis';
  if (index === 0) return 'anticipation';
  if (index === lastIndex) return 'resolve';
  return beat.kind === 'transform' ? 'reveal' : 'hold';
}

function roleLead(role: TimingBeatRole): number {
  if (role === 'anticipation') return 12;
  if (role === 'emphasis') return 6;
  if (role === 'hold') return 4;
  if (role === 'resolve') return 8;
  return 8;
}

function fallbackLand(index: number, total: number, durationFrames: number): number {
  if (index === 0) return Math.min(12, Math.max(0, durationFrames - 1));
  const spanStart = Math.min(18, Math.round(durationFrames * 0.12));
  const spanEnd = Math.max(spanStart, Math.round(durationFrames * 0.86));
  return spanStart + ((spanEnd - spanStart) * index) / Math.max(1, total - 1);
}

function findPauseAfter(pauses: TimingPause[], frame: number): TimingPause | undefined {
  return pauses.find((pause) => pause.frame >= frame);
}

function buildBeats(
  storyboard: MotionStoryboard | null | undefined,
  cues: number[],
  pauses: TimingPause[],
  accents: TimingAccent[],
  durationFrames: number,
  snapToleranceFrames: number,
): TimingBeat[] {
  const sourceBeats = storyboard?.beats?.length
    ? storyboard.beats
    : cues.map((_, index) => ({ cue: index, kind: 'build' as const, adds: '' }));
  const focusBeat = Number.isInteger(storyboard?.focus?.beat) ? storyboard!.focus!.beat : -1;
  const lastIndex = Math.max(0, sourceBeats.length - 1);
  let previousStart = 0;

  return sourceBeats.map((beat, index) => {
    const role = defaultTimingRole(beat, index, lastIndex, focusBeat);
    const cueIndex = beat.cue;
    const hasCue = cueIndex != null && cueIndex >= 0 && cueIndex < cues.length;
    const rawLand = hasCue ? cues[cueIndex] : fallbackLand(index, sourceBeats.length, durationFrames);
    // 音画对齐：emphasis 拍的落地帧（slam/brighten/underline-sweep 的触发帧）
    // 在容差内向最近重音帧吸附，让视觉强调打在读出重音的那一帧。
    const snappedLand =
      role === 'emphasis' ? snapFrameToAccents(rawLand, accents, snapToleranceFrames) : rawLand;
    const landFrame = clampFrame(snappedLand, durationFrames);
    const startFrame = clampFrame(Math.max(previousStart, landFrame - roleLead(role)), durationFrames);
    previousStart = startFrame;
    const pause = role === 'hold' || role === 'resolve' ? findPauseAfter(pauses, landFrame) : undefined;
    const holdUntil = pause ? clampFrame(pause.frame + pause.durationFrames, durationFrames) : undefined;
    return {
      storyboardBeatIndex: index,
      role,
      startFrame,
      landFrame: Math.max(landFrame, startFrame),
      ...(holdUntil != null && holdUntil > landFrame ? { holdUntil } : {}),
    };
  });
}

export function buildTimingPlan(input: BuildTimingPlanInput): TimingPlan {
  const durationFrames = Math.max(1, msToFrames(input.durationMs, input.fps));
  const entries = entriesInWindow(input);
  const cues = entries.map((entry) => clampFrame(entry.relativeStartFrame, durationFrames));
  const pauses = detectPauses(entries, input.fps).map((pause) => ({
    frame: clampFrame(pause.frame, durationFrames),
    durationFrames: Math.max(1, Math.min(pause.durationFrames, durationFrames)),
  }));
  const accents = mergeAccents([
    ...detectAccents(entries).map((accent) => ({
      ...accent,
      frame: clampFrame(accent.frame, durationFrames),
    })),
    ...metadataAccents(input, durationFrames),
  ]);
  return {
    fps: input.fps,
    cues,
    pauses,
    accents,
    beats: buildBeats(
      input.storyboard,
      cues,
      pauses,
      accents,
      durationFrames,
      msToFrames(ACCENT_SNAP_TOLERANCE_MS, input.fps),
    ),
  };
}
