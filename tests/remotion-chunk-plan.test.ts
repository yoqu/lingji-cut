import { describe, expect, it } from 'vitest';
import type { OverlayItem, SrtEntry, TimelineData } from '../src/types';
import { planRenderChunks, sliceChunkInput } from '../electron/remotion/chunk-plan';

function overlay(
  id: string,
  startMs: number,
  durationMs: number,
  options: Partial<OverlayItem> = {},
): OverlayItem {
  return {
    id,
    type: 'image',
    assetPath: `${id}.png`,
    trackId: 'visual-1',
    startMs,
    durationMs,
    position: { x: 0, y: 0, width: 1920, height: 1080 },
    ...options,
  };
}

function timeline(overlays: OverlayItem[]): TimelineData {
  return {
    version: 2,
    fps: 30,
    width: 1920,
    height: 1080,
    podcast: {
      audioPath: 'podcast.mp3',
      srtPath: 'podcast.srt',
      durationMs: 180_000,
    },
    tracks: [
      { id: 'audio', kind: 'audio', label: 'audio', order: 0 },
      { id: 'visual-1', kind: 'visual', label: 'visual', order: 0 },
    ],
    overlays,
    subtitle: {
      fontSize: 48,
      color: '#fff',
      position: 'bottom',
      highlightEnabled: true,
      highlightBackgroundColor: '#000',
      highlightTextColor: '#ff0',
      highlightPaddingX: 8,
      highlightPaddingY: 4,
      highlightRadius: 4,
      highlightAnimation: 'pop',
      maxCharsPerEntry: 35,
      autoResegment: true,
    },
    subtitleHighlights: [
      { entryIndex: 1, start: 0, end: 2, highlightText: 'out', sourceText: 'outside' },
      { entryIndex: 2, start: 0, end: 2, highlightText: 'in', sourceText: 'inside' },
    ],
  };
}

describe('planRenderChunks', () => {
  it('creates inclusive fixed-size ranges and a short tail', () => {
    expect(planRenderChunks(5_557, 1_800)).toEqual([
      { index: 0, startFrame: 0, endFrame: 1_799, frameCount: 1_800 },
      { index: 1, startFrame: 1_800, endFrame: 3_599, frameCount: 1_800 },
      { index: 2, startFrame: 3_600, endFrame: 5_399, frameCount: 1_800 },
      { index: 3, startFrame: 5_400, endFrame: 5_556, frameCount: 157 },
    ]);
  });

  it('handles a single frame and rejects non-positive inputs', () => {
    expect(planRenderChunks(1, 1_800)).toEqual([
      { index: 0, startFrame: 0, endFrame: 0, frameCount: 1 },
    ]);
    expect(() => planRenderChunks(0, 1_800)).toThrow(/duration/i);
    expect(() => planRenderChunks(100, 0)).toThrow(/chunk/i);
  });
});

describe('sliceChunkInput', () => {
  it('keeps only data intersecting the chunk and preserves absolute timing', () => {
    const crossingCard = overlay('crossing-card', 59_500, 2_000, {
      overlayType: 'ai-card',
      aiCardData: { motionCard: { tsx: 'export default () => null' } } as OverlayItem['aiCardData'],
    });
    const audioInChunk = overlay('audio-in-chunk', 75_000, 5_000, {
      type: 'audio',
      trackId: 'audio',
      assetPath: 'effect.wav',
    });
    const sourceTimeline = timeline([
      overlay('before', 1_000, 2_000),
      crossingCard,
      audioInChunk,
      overlay('at-next-boundary', 120_000, 2_000),
    ]);
    const srtEntries: SrtEntry[] = [
      { index: 1, startMs: 10_000, endMs: 11_000, text: 'outside' },
      { index: 2, startMs: 70_000, endMs: 71_000, text: 'inside' },
      { index: 3, startMs: 120_000, endMs: 121_000, text: 'next chunk' },
    ];

    const result = sliceChunkInput(
      {
        timeline: sourceTimeline,
        srtEntries,
        compiledCards: {
          'crossing-card': 'compiled crossing card',
          before: 'compiled outside card',
        },
      },
      { index: 1, startFrame: 1_800, endFrame: 3_599, frameCount: 1_800 },
      30,
    );

    expect(result.timeline.overlays.map((item) => item.id)).toEqual([
      'crossing-card',
      'audio-in-chunk',
    ]);
    expect(result.timeline.overlays[0].startMs).toBe(59_500);
    expect(result.srtEntries.map((entry) => entry.index)).toEqual([2]);
    expect(Object.keys(result.compiledCards)).toEqual(['crossing-card']);
    expect(result.timeline.subtitleHighlights?.map((highlight) => highlight.entryIndex)).toEqual([2]);
    expect(result.timeline.podcast.durationMs).toBe(180_000);
  });

  it('includes the previous card needed for a crossfade at the left boundary', () => {
    const sourceTimeline = timeline([
      overlay('transition-tail', 58_000, 1_600, {
        overlayType: 'ai-card',
        aiCardData: { motionCard: { tsx: 'export default () => null' } } as OverlayItem['aiCardData'],
      }),
      overlay('current-card', 60_000, 10_000, {
        overlayType: 'ai-card',
        aiCardData: { motionCard: { tsx: 'export default () => null' } } as OverlayItem['aiCardData'],
      }),
    ]);

    const result = sliceChunkInput(
      {
        timeline: sourceTimeline,
        srtEntries: [],
        compiledCards: { 'transition-tail': 'a', 'current-card': 'b' },
      },
      { index: 1, startFrame: 1_800, endFrame: 3_599, frameCount: 1_800 },
      30,
    );

    expect(result.timeline.overlays.map((item) => item.id)).toEqual([
      'transition-tail',
      'current-card',
    ]);
    expect(Object.keys(result.compiledCards)).toEqual(['transition-tail', 'current-card']);
  });
});
