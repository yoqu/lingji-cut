import { describe, expect, it } from 'vitest';
import { resolveAudioVolume } from '../src/remotion/overlays/AudioOverlay';
import type { RenderableAudio } from '../src/remotion/timeline-to-sequences';

function clip(): RenderableAudio {
  return {
    id: 'bgm',
    assetPath: '/bgm.mp3',
    startFrame: 0,
    durationFrames: 300,
    trimStartMs: 0,
    volume: 1,
    fadeInMs: 1_000,
    fadeOutMs: 1_000,
    loop: true,
    volumeEnvelope: [],
    ducking: { enabled: true, reductionDb: 6, attackMs: 100, releaseMs: 300, holdMs: 600 },
    speechWindows: [{ startFrame: 60, endFrame: 120 }],
  };
}

describe('audio overlay volume', () => {
  it('同时应用淡入和口播 ducking', () => {
    expect(resolveAudioVolume(clip(), 0, 30)).toBe(0);
    expect(resolveAudioVolume(clip(), 90, 30)).toBeCloseTo(10 ** (-6 / 20), 4);
  });

  it('hold 和 release 完成后恢复原音量', () => {
    expect(resolveAudioVolume(clip(), 130, 30)).toBeCloseTo(10 ** (-6 / 20), 4);
    expect(resolveAudioVolume(clip(), 170, 30)).toBeCloseTo(1, 4);
  });
});
