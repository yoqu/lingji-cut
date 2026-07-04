import { describe, expect, it } from 'vitest';
import {
  buildRenderPlan,
  CARD_CROSSFADE_FRAMES,
  computeCardCues,
} from '../src/remotion/timeline-to-sequences';
import type { AICardDisplayMode } from '../src/types/ai';

describe('computeCardCues', () => {
  const srt = [
    { index: 1, startMs: 500, endMs: 1000, text: '段前一句' },
    { index: 2, startMs: 1000, endMs: 1900, text: '第一句' },
    { index: 3, startMs: 2000, endMs: 3400, text: '第二句' },
    { index: 4, startMs: 3500, endMs: 4900, text: '第三句' },
    { index: 5, startMs: 6000, endMs: 7000, text: '段后一句' },
  ];

  it('returns each in-window sentence start as a frame relative to the card start, in order', () => {
    // 卡片窗口 [1000, 5000)，fps=30 → 相对帧 = msToFrames(e.startMs) - msToFrames(1000)
    expect(computeCardCues(srt, 1000, 4000, 30)).toEqual([0, 30, 75]);
  });

  it('excludes sentences that start before or after the card window', () => {
    const cues = computeCardCues(srt, 1000, 4000, 30);
    expect(cues).not.toContain(-15); // 段前一句(500ms) 不计入
    expect(cues.length).toBe(3); // 6000ms 的段后一句也排除
  });

  it('returns an empty array when no sentence starts within the window', () => {
    expect(computeCardCues(srt, 4900, 1000, 30)).toEqual([]);
  });
});
import {
  createDefaultTimeline,
  DEFAULT_VISUAL_TRACK_ID,
  type OverlayItem,
  type SrtEntry,
  type TimelineData,
} from '../src/types';

function timelineWithImage(): TimelineData {
  const timeline = createDefaultTimeline();
  timeline.podcast = { audioPath: '/p/a.mp3', srtPath: '/p/s.srt', durationMs: 4000 };
  const image: OverlayItem = {
    id: 'v1',
    type: 'image',
    assetPath: '/p/i.png',
    trackId: DEFAULT_VISUAL_TRACK_ID,
    startMs: 0,
    durationMs: 2000,
    position: { x: 0, y: 0, width: 1920, height: 1080 },
  };
  timeline.overlays = [image];
  return timeline;
}

describe('buildRenderPlan', () => {
  it('separates audio and visual clips and computes frames', () => {
    const plan = buildRenderPlan(timelineWithImage(), [], 30);
    expect(plan.durationFrames).toBeGreaterThan(0);
    const img = plan.visual.find((c) => c.id === 'v1');
    expect(img).toBeTruthy();
    expect(img!.kind).toBe('image');
    expect(img!.startFrame).toBe(0);
    expect(img!.durationFrames).toBe(60); // 2000ms @30fps
    expect(img!.zIndex).toBeGreaterThanOrEqual(10);
  });

  it('includes podcast audio as the first audio clip', () => {
    const plan = buildRenderPlan(timelineWithImage(), [], 30);
    expect(plan.audio[0]?.id).toBe('podcast-audio');
    expect(plan.audio[0]?.assetPath).toBe('/p/a.mp3');
  });

  it('maps srt entries to subtitle frames', () => {
    const srt: SrtEntry[] = [{ index: 0, startMs: 1000, endMs: 2000, text: 'hi' }];
    const plan = buildRenderPlan(timelineWithImage(), srt, 30);
    expect(plan.subtitles).toHaveLength(1);
    expect(plan.subtitles[0].startFrame).toBe(30);
    expect(plan.subtitles[0].durationFrames).toBe(30);
  });
});

function aiCardOverlay(
  id: string,
  startMs: number,
  durationMs: number,
  displayMode: AICardDisplayMode = 'fullscreen',
): OverlayItem {
  return {
    id,
    type: 'image',
    assetPath: '',
    trackId: DEFAULT_VISUAL_TRACK_ID,
    startMs,
    durationMs,
    position: { x: 0, y: 0, width: 1920, height: 1080 },
    overlayType: 'ai-card',
    aiCardData: {
      cardType: 'concept',
      title: id,
      content: '',
      template: 'default',
      displayMode,
      style: { primaryColor: '#fff', backgroundColor: '#000', fontSize: 24 },
    },
  };
}

function timelineWithCards(overlays: OverlayItem[]): TimelineData {
  const timeline = createDefaultTimeline();
  timeline.podcast = { audioPath: '/p/a.mp3', srtPath: '/p/s.srt', durationMs: 20000 };
  timeline.overlays = overlays;
  return timeline;
}

describe('buildRenderPlan card crossfade', () => {
  it('extends the previous fullscreen card into the next one when the gap is small', () => {
    // A: [0, 4000)，B: [4300, 8000) → 空隙 300ms ≤ 500ms，A 延长到 B 开始后 14 帧
    const plan = buildRenderPlan(
      timelineWithCards([aiCardOverlay('a', 0, 4000), aiCardOverlay('b', 4300, 3700)]),
      [],
      30,
    );
    const a = plan.visual.find((c) => c.id === 'a')!;
    const b = plan.visual.find((c) => c.id === 'b')!;
    expect(a.durationFrames).toBe(b.startFrame + CARD_CROSSFADE_FRAMES);
    expect(b.durationFrames).toBe(111); // 后卡不受影响
  });

  it('keeps cards untouched when the gap exceeds the snap threshold', () => {
    const plan = buildRenderPlan(
      timelineWithCards([aiCardOverlay('a', 0, 4000), aiCardOverlay('b', 5000, 3000)]),
      [],
      30,
    );
    expect(plan.visual.find((c) => c.id === 'a')!.durationFrames).toBe(120);
  });

  it('renders the earlier card after the later one so it fades out on top', () => {
    const plan = buildRenderPlan(
      timelineWithCards([aiCardOverlay('a', 0, 4000), aiCardOverlay('b', 4300, 3700)]),
      [],
      30,
    );
    const cardIds = plan.visual.filter((c) => c.kind === 'ai-card').map((c) => c.id);
    expect(cardIds).toEqual(['b', 'a']);
  });

  it('ignores pip cards and existing overlaps', () => {
    const plan = buildRenderPlan(
      timelineWithCards([
        aiCardOverlay('a', 0, 4000, 'pip'),
        aiCardOverlay('b', 4300, 3700, 'pip'),
        aiCardOverlay('c', 8000, 2000),
        aiCardOverlay('d', 9500, 2000), // 与 c 已重叠（gap < 0），不再延长
      ]),
      [],
      30,
    );
    expect(plan.visual.find((c) => c.id === 'a')!.durationFrames).toBe(120);
    expect(plan.visual.find((c) => c.id === 'c')!.durationFrames).toBe(60);
  });

  it('computes cues from the original card window, not the extended one', () => {
    const srt: SrtEntry[] = [
      { index: 0, startMs: 100, endMs: 2000, text: 's1' },
      { index: 1, startMs: 4400, endMs: 6000, text: 's2' }, // 属于 B 窗口
    ];
    const plan = buildRenderPlan(
      timelineWithCards([aiCardOverlay('a', 0, 4000), aiCardOverlay('b', 4300, 3700)]),
      srt,
      30,
    );
    expect(plan.visual.find((c) => c.id === 'a')!.cues).toEqual([3]);
    expect(plan.visual.find((c) => c.id === 'b')!.cues).toEqual([3]);
  });
});
