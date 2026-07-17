import { describe, expect, it } from 'vitest';
import { getPreviewAudioSources, preloadPreviewAudioSources } from '../src/remotion/preview-audio-preload';
import type { RenderableAudio } from '../src/remotion/timeline-to-sequences';

function audioClip(id: string, assetPath: string): RenderableAudio {
  return {
    id,
    assetPath,
    startFrame: 0,
    durationFrames: 30,
    trimStartMs: 0,
    volume: 1,
  };
}

describe('preview audio preloading', () => {
  it('dedupes resolved audio sources from a render plan', () => {
    const sources = getPreviewAudioSources([
      audioClip('podcast', '/tmp/podcast.mp3'),
      audioClip('overlay-1', '/tmp/effect.wav'),
      audioClip('overlay-2', '/tmp/effect.wav'),
    ]);

    expect(sources).toHaveLength(2);
    expect(sources[0]).toContain('/tmp/podcast.mp3');
    expect(sources[1]).toContain('/tmp/effect.wav');
  });

  it('creates a new preview URL when same-path podcast audio is replaced', () => {
    const clips = [audioClip('podcast-audio', '/tmp/podcast.mp3')];

    const first = getPreviewAudioSources(clips, 1);
    const replaced = getPreviewAudioSources(clips, 2);

    expect(first[0]).toContain('lingjiMediaRevision=1');
    expect(replaced[0]).toContain('lingjiMediaRevision=2');
    expect(replaced[0]).not.toBe(first[0]);
  });

  it('is a no-op outside the browser', () => {
    expect(() => preloadPreviewAudioSources(['/tmp/podcast.mp3'])()).not.toThrow();
  });
});
