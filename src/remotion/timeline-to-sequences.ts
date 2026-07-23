import { getRenderableOverlays, getRenderableVisualTracks } from '../lib/timeline-tracks';
import { buildTimingPlan } from '../lib/motion-timing';
import { getEffectiveTimelineDurationMs } from '../lib/utils';
import type { OverlayItem, SrtEntry, TimelineData } from '../types';
import type { MotionBible, MotionCardTransitionKind, MotionCardTransitionPlan, TimingPlan } from '../types/motion';
import { durationFrames, msToFrames } from './frames';

const VISUAL_BASE_Z_INDEX = 10;
const BACKGROUND_Z_INDEX = 1;
export const SUBTITLE_Z_INDEX = 1000;

/** 相邻全屏卡吸附阈值：空隙不超过该毫秒数时吞掉空隙做交叉溶解，避免闪露底图。 */
export const CARD_SNAP_MAX_GAP_MS = 500;
/** 交叉溶解重叠帧数：与 motion-kit CardStage 的出场淡出窗口（14 帧）对齐。 */
export const CARD_CROSSFADE_FRAMES = 14;

export type RenderableClipKind = 'video' | 'image' | 'text' | 'ai-card';

export interface RenderableClip {
  id: string;
  kind: RenderableClipKind;
  overlay: OverlayItem;
  startFrame: number;
  durationFrames: number;
  zIndex: number;
  /**
   * 仅 ai-card：落在该卡时间窗内的每句字幕的相对起始帧（相对卡片本地 frame 0，按时间顺序）。
   * 注入卡片组件用于"逐句揭示"。无字幕或非卡片时为 undefined。
   */
  cues?: number[];
  /** 仅 ai-card：SRT/分镜推导出的专业节奏计划，向后兼容 cues/useBeats。 */
  timingPlan?: TimingPlan;
  transitionIn?: MotionCardTransitionPlan;
  transitionOut?: MotionCardTransitionPlan;
}

/**
 * 计算一张卡片的逐句字幕节拍：取 startMs 落在卡片时间窗 [startMs, startMs+durationMs) 内的字幕，
 * 换算成相对卡片本地 frame 0 的起始帧（与 Sequence from 对齐：相对帧 = msToFrames(e.startMs) - msToFrames(startMs)）。
 * 结果按时间升序、去负、用于提示词控制的逐句揭示。
 */
export function computeCardCues(
  srt: SrtEntry[],
  startMs: number,
  durationMs: number,
  fps: number,
): number[] {
  const endMs = startMs + durationMs;
  const base = msToFrames(startMs, fps);
  return srt
    .filter((e) => e.startMs >= startMs && e.startMs < endMs)
    .sort((a, b) => a.startMs - b.startMs)
    .map((e) => Math.max(0, msToFrames(e.startMs, fps) - base));
}

export interface RenderableAudio {
  id: string;
  assetPath: string;
  startFrame: number;
  durationFrames: number;
  trimStartMs: number;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  loop: boolean;
  volumeEnvelope: Array<{ frame: number; volume: number }>;
  ducking?: NonNullable<import('../types').AudioOverlayData['ducking']>;
  speechWindows: Array<{ startFrame: number; endFrame: number }>;
}

export interface RenderableSubtitle {
  index: number;
  text: string;
  startFrame: number;
  durationFrames: number;
}

export interface RenderPlan {
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
  visual: RenderableClip[];
  audio: RenderableAudio[];
  subtitles: RenderableSubtitle[];
}

/**
 * 相邻全屏 AI 卡的吸附 + 交叉溶解（只改渲染计划，不动时间线数据）：
 * 空隙 ≤ CARD_SNAP_MAX_GAP_MS 时，把前卡延长到后卡开始后 CARD_CROSSFADE_FRAMES 帧——
 * CardStage 的出场淡出用尾部 14 帧，延长后淡出窗口恰好落在重叠区，形成溶解而不漏底图。
 * 同 zIndex 下叠放顺序由 DOM 顺序决定，因此把全屏卡按 startFrame 倒序写回原槽位，
 * 保证先出的卡叠在后进的卡上方淡出（真溶解，而不是被后卡硬切覆盖）。
 */
function cardSegmentId(card: RenderableClip): string | undefined {
  return card.overlay.aiCardData?.segmentId ?? card.overlay.aiCardData?.sourceCardId;
}

function transitionBible(prev: RenderableClip, next: RenderableClip): MotionBible | undefined {
  return prev.overlay.aiCardData?.motionBible ?? next.overlay.aiCardData?.motionBible;
}

function resolveCardTransition(prev: RenderableClip, next: RenderableClip): MotionCardTransitionPlan {
  const bible = transitionBible(prev, next);
  const fromSegmentId = cardSegmentId(prev);
  const toSegmentId = cardSegmentId(next);
  const matchCut = bible?.transitionRules.matchCutCandidates.find(
    (candidate) => candidate.fromSegmentId === fromSegmentId && candidate.toSegmentId === toSegmentId,
  );
  const kind: MotionCardTransitionKind = matchCut ? 'match-cut' : (bible?.transitionRules.default ?? 'crossfade');
  return {
    kind,
    overlapFrames: kind === 'hard-cut' ? 0 : CARD_CROSSFADE_FRAMES,
    direction: 'left',
    ...(matchCut?.motif ? { motif: matchCut.motif } : {}),
  };
}

function applyCardTransitions(visual: RenderableClip[], fps: number): void {
  const slots: number[] = [];
  visual.forEach((c, i) => {
    if (c.kind === 'ai-card' && c.overlay.aiCardData?.displayMode === 'fullscreen') slots.push(i);
  });
  if (slots.length < 2) return;

  const cards = slots.map((i) => visual[i]).sort((a, b) => a.startFrame - b.startFrame);
  const maxGapFrames = msToFrames(CARD_SNAP_MAX_GAP_MS, fps);
  for (let i = 0; i < cards.length - 1; i += 1) {
    const prev = cards[i];
    const next = cards[i + 1];
    const gap = next.startFrame - (prev.startFrame + prev.durationFrames);
    if (gap < 0 || gap > maxGapFrames) continue;
    const transition = resolveCardTransition(prev, next);
    prev.transitionOut = transition;
    next.transitionIn = transition;
    if (transition.kind === 'hard-cut' || transition.overlapFrames <= 0) continue;
    const overlapEnd = Math.min(
      next.startFrame + transition.overlapFrames,
      next.startFrame + next.durationFrames,
    );
    prev.durationFrames = overlapEnd - prev.startFrame;
  }

  cards.sort((a, b) => b.startFrame - a.startFrame);
  slots.forEach((slot, j) => {
    visual[slot] = cards[j];
  });
}

function trackZIndex(timeline: TimelineData, overlay: OverlayItem): number {
  if (overlay.overlayRole === 'default-background') return BACKGROUND_Z_INDEX;
  const map = new Map(getRenderableVisualTracks(timeline.tracks).map((t) => [t.id, t.order]));
  return VISUAL_BASE_Z_INDEX + (map.get(overlay.trackId) ?? 0);
}

export function buildRenderPlan(timeline: TimelineData, srt: SrtEntry[], fpsArg?: number): RenderPlan {
  const fps = fpsArg ?? timeline.fps ?? 30;
  const durationMs = getEffectiveTimelineDurationMs(timeline);
  const renderable = getRenderableOverlays(timeline);
  const visual: RenderableClip[] = [];
  const audio: RenderableAudio[] = [];

  for (const overlay of renderable) {
    if (overlay.type === 'audio') {
      const d = overlay.audioData;
      audio.push({
        id: overlay.id,
        assetPath: overlay.assetPath,
        startFrame: msToFrames(overlay.startMs, fps),
        durationFrames: durationFrames(overlay.durationMs, fps),
        trimStartMs: d?.trimStartMs ?? 0,
        volume: d?.muted ? 0 : Math.max(0, Math.min(1.5, d?.volume ?? 1)),
        fadeInMs: Math.max(0, d?.fadeInMs ?? 0),
        fadeOutMs: Math.max(0, d?.fadeOutMs ?? 0),
        loop: d?.loop ?? false,
        volumeEnvelope: (d?.volumeEnvelope ?? []).map((point) => ({
          frame: msToFrames(point.atMs, fps),
          volume: Math.max(0, Math.min(1.5, point.volume)),
        })),
        ducking: d?.ducking?.enabled ? d.ducking : undefined,
        speechWindows: srt
          .filter((entry) => entry.endMs >= overlay.startMs && entry.startMs <= overlay.startMs + overlay.durationMs)
          .map((entry) => ({
            startFrame: msToFrames(Math.max(0, entry.startMs - overlay.startMs), fps),
            endFrame: msToFrames(Math.min(overlay.durationMs, entry.endMs - overlay.startMs), fps),
          })),
      });
      continue;
    }
    const kind: RenderableClipKind = overlay.overlayType === 'ai-card' ? 'ai-card' : overlay.type;
    const timingPlan =
      kind === 'ai-card'
        ? buildTimingPlan({
            srt,
            startMs: overlay.startMs,
            durationMs: overlay.durationMs,
            fps,
            storyboard: overlay.aiCardData?.motionCard?.storyboard,
            metadata: timeline.motionTimingMetadata,
          })
        : undefined;
    visual.push({
      id: overlay.id,
      kind,
      overlay,
      startFrame: msToFrames(overlay.startMs, fps),
      durationFrames: durationFrames(overlay.durationMs, fps),
      zIndex: trackZIndex(timeline, overlay),
      cues: timingPlan?.cues ?? (kind === 'ai-card' ? computeCardCues(srt, overlay.startMs, overlay.durationMs, fps) : undefined),
      timingPlan,
    });
  }

  if (timeline.podcast.audioPath) {
    audio.unshift({
      id: 'podcast-audio',
      assetPath: timeline.podcast.audioPath,
      startFrame: 0,
      durationFrames: durationFrames(timeline.podcast.durationMs || durationMs, fps),
      trimStartMs: 0,
      volume: 1,
      fadeInMs: 0,
      fadeOutMs: 0,
      loop: false,
      volumeEnvelope: [],
      speechWindows: [],
    });
  }

  applyCardTransitions(visual, fps);

  const subtitles: RenderableSubtitle[] = srt.map((e) => ({
    // Preserve the SRT identity. Chunk slicing keeps absolute entries, so array position is
    // intentionally unstable between chunks while subtitle highlight entryIndex is stable.
    index: e.index,
    text: e.text,
    startFrame: msToFrames(e.startMs, fps),
    durationFrames: durationFrames(Math.max(1, e.endMs - e.startMs), fps),
  }));

  return {
    width: timeline.width,
    height: timeline.height,
    fps,
    durationFrames: durationFrames(durationMs, fps),
    visual,
    audio,
    subtitles,
  };
}
