import { randomUUID } from 'node:crypto';
import {
  DEFAULT_AI_CARDS_TRACK_ID,
  DEFAULT_AUDIO_OVERLAY_TRACK_ID,
  createAudioOverlayTrack,
  createDefaultAudioOverlayData,
  createDefaultTimeline,
  createVisualTrack,
  type OverlayItem,
  type SubtitleHighlight,
  type TimelineData,
} from '../../src/types';
import { getAICardOverlayPosition } from '../../src/lib/ai-card-layout';
import { normalizeTimelineData } from '../../src/lib/timeline-tracks';
import { buildAICardTimelineDraft, type AIAnalysisResult } from '../../src/types/ai';
import type { AudioCuePlan } from '../../src/types/production';
import type { DirectorPlan } from '../../src/types/director';
import {
  areDirectorSoundEffectsEnabled,
  isDirectorBgmEnabled,
} from '../../src/lib/director-audio-options';

export interface HeadlessAudioPlacement {
  cue: AudioCuePlan;
  assetPath: string;
  sourceDurationMs: number;
}

function mergeCardOverlays(
  timeline: TimelineData,
  analysis: AIAnalysisResult,
  plan: DirectorPlan,
): OverlayItem[] {
  const drafts = analysis.cards
    .filter((card) => card.enabled)
    .map((card) => buildAICardTimelineDraft(card, plan.motionBible));
  const nextIds = new Set(drafts.map((draft) => draft.sourceCardId));
  const retained = timeline.overlays.filter((overlay) => (
    overlay.overlayType !== 'ai-card'
    || !overlay.aiCardData?.sourceCardId
    || nextIds.has(overlay.aiCardData.sourceCardId)
  ));
  for (const draft of drafts) {
    const index = retained.findIndex((overlay) => (
      overlay.overlayType === 'ai-card'
      && overlay.aiCardData?.sourceCardId === draft.sourceCardId
    ));
    const existing = index >= 0 ? retained[index] : undefined;
    const position = existing?.aiCardData?.displayMode === draft.aiCardData.displayMode
      ? existing.position
      : getAICardOverlayPosition(draft.aiCardData.displayMode, timeline.width, timeline.height);
    const overlay: OverlayItem = {
      id: existing?.id ?? randomUUID(),
      type: 'image',
      assetPath: '',
      trackId: existing?.trackId ?? DEFAULT_AI_CARDS_TRACK_ID,
      startMs: draft.startMs,
      durationMs: draft.durationMs,
      position,
      overlayType: 'ai-card',
      aiCardData: draft.aiCardData,
    };
    if (index >= 0) retained[index] = overlay;
    else retained.push(overlay);
  }
  return retained;
}

function audioOverlay(placement: HeadlessAudioPlacement, existing?: OverlayItem): OverlayItem {
  const { cue, assetPath, sourceDurationMs } = placement;
  return {
    id: existing?.id ?? randomUUID(),
    type: 'audio',
    assetPath,
    trackId: existing?.trackId ?? DEFAULT_AUDIO_OVERLAY_TRACK_ID,
    startMs: cue.startMs,
    durationMs: cue.durationMs ?? sourceDurationMs,
    position: { x: 0, y: 0, width: 0, height: 0 },
    audioData: {
      ...createDefaultAudioOverlayData(sourceDurationMs),
      cueId: cue.id,
      role: cue.role,
      loop: cue.loop === true && sourceDurationMs < (cue.durationMs ?? sourceDurationMs),
      volume: 10 ** ((cue.volumeDb ?? -12) / 20),
      fadeInMs: cue.fadeInMs ?? 0,
      fadeOutMs: cue.fadeOutMs ?? 80,
    },
  };
}

function mergeAudioOverlays(
  overlays: OverlayItem[],
  placements: HeadlessAudioPlacement[],
  plan: DirectorPlan,
): OverlayItem[] {
  const cueIds = new Set(placements.map((placement) => placement.cue.id));
  const bgmEnabled = isDirectorBgmEnabled(plan.audioDirection);
  const effectsEnabled = areDirectorSoundEffectsEnabled(plan.audioDirection);
  const retained = overlays.filter((overlay) => (
    overlay.type !== 'audio'
    || !overlay.audioData?.cueId
    || (
      !cueIds.has(overlay.audioData.cueId)
      && (overlay.audioData.role !== 'bgm' ? effectsEnabled : bgmEnabled)
    )
  ));
  for (const placement of placements) {
    const existing = overlays.find((overlay) => (
      overlay.type === 'audio' && overlay.audioData?.cueId === placement.cue.id
    ));
    retained.push(audioOverlay(placement, existing));
  }
  return retained;
}

export function buildHeadlessDirectorTimeline(options: {
  current: TimelineData | null;
  analysis: AIAnalysisResult;
  plan: DirectorPlan;
  highlights: SubtitleHighlight[];
  audioPlacements: HeadlessAudioPlacement[];
}): TimelineData {
  const current = options.current ?? createDefaultTimeline();
  const hasCardTrack = current.tracks.some((track) => track.id === DEFAULT_AI_CARDS_TRACK_ID);
  const cardTracks = hasCardTrack ? current.tracks : [...current.tracks, createVisualTrack(2, 2)];
  const hasAudioTrack = cardTracks.some((track) => track.id === DEFAULT_AUDIO_OVERLAY_TRACK_ID);
  const tracks = options.audioPlacements.length > 0 && !hasAudioTrack
    ? [...cardTracks, createAudioOverlayTrack(1)]
    : cardTracks;
  const cards = mergeCardOverlays({ ...current, tracks }, options.analysis, options.plan);
  const overlays = mergeAudioOverlays(cards, options.audioPlacements, options.plan);
  return normalizeTimelineData({
    ...current,
    tracks,
    overlays,
    subtitleHighlights: options.highlights,
    subtitle: {
      ...current.subtitle,
      highlightEnabled: options.highlights.length > 0 || current.subtitle.highlightEnabled,
    },
  });
}
