import { describe, expect, it } from 'vitest';
import { buildTimingPlan } from '../src/lib/motion-timing';
import type { MotionStoryboard } from '../src/lib/motion-storyboard';
import type { SrtEntry } from '../src/types';

const SRT: SrtEntry[] = [
  { index: 0, startMs: 1000, endMs: 1800, text: '硕士报名 28842 人。' },
  { index: 1, startMs: 2400, endMs: 3000, text: '关键是增长速度！' },
  { index: 2, startMs: 3100, endMs: 3700, text: '最后落到选择。' },
];

const STORYBOARD: MotionStoryboard = {
  claim: '报名人数与增长都值得看',
  carrier: 'data-hero',
  scene: '大数字与结论收束',
  focus: { beat: 1, emphasis: 'countup-settle' },
  beats: [
    { cue: null, kind: 'build', role: 'anticipation', adds: '标题：报名变化' },
    { cue: 0, kind: 'accent', role: 'emphasis', adds: '28842 人' },
    { cue: 2, kind: 'build', role: 'resolve', adds: '选择收束' },
  ],
};

describe('buildTimingPlan', () => {
  it('从 SRT 推导 cues、停顿和字幕重音', () => {
    const plan = buildTimingPlan({ srt: SRT, startMs: 1000, durationMs: 3000, fps: 30, storyboard: STORYBOARD });
    expect(plan.cues).toEqual([0, 42, 63]);
    expect(plan.pauses).toEqual([{ frame: 24, durationFrames: 18 }]);
    expect(plan.accents[0]).toMatchObject({ frame: 0, strength: 3, source: 'subtitle' });
    expect(plan.accents.some((accent) => accent.frame === 42 && accent.strength >= 2)).toBe(true);
  });

  it('按 storyboard role 生成 anticipation/emphasis/resolve 节奏拍', () => {
    const plan = buildTimingPlan({ srt: SRT, startMs: 1000, durationMs: 3000, fps: 30, storyboard: STORYBOARD });
    expect(plan.beats.map((beat) => beat.role)).toEqual(['anticipation', 'emphasis', 'resolve']);
    expect(plan.beats[1]).toMatchObject({ storyboardBeatIndex: 1, startFrame: 0, landFrame: 0 });
    expect(plan.beats[2].holdUntil).toBeUndefined();
  });

  it('没有 storyboard 时仍按字幕 cues 生成兼容节奏', () => {
    const plan = buildTimingPlan({ srt: SRT, startMs: 1000, durationMs: 3000, fps: 30 });
    expect(plan.beats).toHaveLength(3);
    expect(plan.beats[0].role).toBe('anticipation');
    expect(plan.beats[2].role).toBe('resolve');
  });

  it('合并 TTS/audio/BGM metadata accents，且无 metadata 时不阻断', () => {
    const plan = buildTimingPlan({
      srt: SRT,
      startMs: 1000,
      durationMs: 3000,
      fps: 30,
      metadata: {
        accents: [
          { timeMs: 1800, strength: 2, source: 'speech' },
          { timeMs: 2500, strength: 3, source: 'bgm' },
          { timeMs: 5000, strength: 3, source: 'speech' },
        ],
      },
    });
    expect(plan.accents).toContainEqual({ frame: 24, strength: 2, source: 'speech' });
    expect(plan.accents).toContainEqual({ frame: 45, strength: 3, source: 'bgm' });
    expect(plan.accents.some((accent) => accent.frame > 90)).toBe(false);
  });
});
