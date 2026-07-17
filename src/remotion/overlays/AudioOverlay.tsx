import { Audio } from 'remotion';
import type { RenderableAudio } from '../timeline-to-sequences';
import { resolveAssetSrc } from '../asset-src';

export function AudioOverlay({
  clip,
  fps,
  mediaRevision,
}: {
  clip: RenderableAudio;
  fps: number;
  mediaRevision?: number;
}) {
  return (
    <Audio
      src={resolveAssetSrc(clip.assetPath, mediaRevision)}
      volume={(frame) => resolveAudioVolume(clip, frame, fps)}
      startFrom={Math.round((clip.trimStartMs / 1000) * fps)}
      loop={clip.loop}
    />
  );
}

function interpolateEnvelope(points: RenderableAudio['volumeEnvelope'], frame: number): number {
  if (points.length === 0) return 1;
  const sorted = [...points].sort((left, right) => left.frame - right.frame);
  if (frame <= sorted[0].frame) return sorted[0].volume;
  const nextIndex = sorted.findIndex((point) => point.frame >= frame);
  if (nextIndex < 0) return sorted[sorted.length - 1].volume;
  const left = sorted[nextIndex - 1];
  const right = sorted[nextIndex];
  const progress = (frame - left.frame) / Math.max(1, right.frame - left.frame);
  return left.volume + (right.volume - left.volume) * progress;
}

function duckingGain(clip: RenderableAudio, frame: number, fps: number): number {
  if (!clip.ducking || clip.speechWindows.length === 0) return 1;
  const attack = Math.max(1, Math.round((clip.ducking.attackMs / 1000) * fps));
  const release = Math.max(1, Math.round((clip.ducking.releaseMs / 1000) * fps));
  const hold = Math.max(0, Math.round((clip.ducking.holdMs / 1000) * fps));
  const reduced = 10 ** (-Math.max(0, clip.ducking.reductionDb) / 20);
  let gain = 1;
  for (const window of clip.speechWindows) {
    if (frame >= window.startFrame && frame <= window.endFrame + hold) return reduced;
    if (frame < window.startFrame && frame >= window.startFrame - attack) {
      const progress = (frame - (window.startFrame - attack)) / attack;
      gain = Math.min(gain, 1 + (reduced - 1) * progress);
    }
    const releaseStart = window.endFrame + hold;
    if (frame > releaseStart && frame <= releaseStart + release) {
      const progress = (frame - releaseStart) / release;
      gain = Math.min(gain, reduced + (1 - reduced) * progress);
    }
  }
  return gain;
}

export function resolveAudioVolume(clip: RenderableAudio, frame: number, fps: number): number {
  const fadeInFrames = Math.round((clip.fadeInMs / 1000) * fps);
  const fadeOutFrames = Math.round((clip.fadeOutMs / 1000) * fps);
  const fadeIn = fadeInFrames > 0 ? Math.min(1, frame / fadeInFrames) : 1;
  const remaining = clip.durationFrames - frame;
  const fadeOut = fadeOutFrames > 0 ? Math.min(1, Math.max(0, remaining / fadeOutFrames)) : 1;
  return clip.volume * fadeIn * fadeOut * interpolateEnvelope(clip.volumeEnvelope, frame) * duckingGain(clip, frame, fps);
}
