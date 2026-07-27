import { describe, expect, it } from 'vitest';
import { buildTimingPlan, snapFrameToAccents } from '../src/lib/motion-timing';
import type { MotionStoryboard } from '../src/lib/motion-storyboard';
import type { TimingAccent } from '../src/types/motion';
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

describe('snapFrameToAccents（重音吸附纯函数）', () => {
  const at = (frame: number, strength: 1 | 2 | 3 = 1): TimingAccent => ({ frame, strength, source: 'subtitle' });

  it('容差内吸附到最近的重音帧', () => {
    expect(snapFrameToAccents(50, [at(45), at(56)], 12)).toBe(45);
    expect(snapFrameToAccents(53, [at(45), at(56)], 12)).toBe(56);
  });

  it('等距时强度高者优先，再等距取更早帧', () => {
    expect(snapFrameToAccents(50, [at(45, 1), at(55, 3)], 12)).toBe(55);
    expect(snapFrameToAccents(50, [at(45, 2), at(55, 2)], 12)).toBe(45);
  });

  it('容差边界（含等于）内吸附，超出容差或无 accents 时原样返回', () => {
    expect(snapFrameToAccents(50, [at(62)], 12)).toBe(62);
    expect(snapFrameToAccents(50, [at(63)], 12)).toBe(50);
    expect(snapFrameToAccents(50, [], 12)).toBe(50);
  });
});

describe('buildTimingPlan 重音吸附（音画对齐）', () => {
  const accentSb = (beats: MotionStoryboard['beats']): MotionStoryboard => ({
    claim: '重音落点',
    carrier: 'data-hero',
    scene: '强调落地',
    beats,
  });

  it('emphasis 拍在容差内吸附到字幕重音帧（slam/brighten 触发帧对齐口播重音）', () => {
    const srt: SrtEntry[] = [
      { index: 0, startMs: 1000, endMs: 1200, text: '关键数字 99 分！' },
      { index: 1, startMs: 1300, endMs: 1900, text: '普通补充说明一下' },
    ];
    const plan = buildTimingPlan({
      srt,
      startMs: 1000,
      durationMs: 2000,
      fps: 30,
      storyboard: accentSb([{ cue: 1, kind: 'accent', adds: '强调点' }]),
    });
    expect(plan.cues).toEqual([0, 9]);
    expect(plan.accents).toEqual([{ frame: 0, strength: 3, source: 'subtitle' }]);
    // 未吸附时 landFrame 应为 cue 帧 9；重音在 9 帧容差内 → 吸附到 0。
    expect(plan.beats[0]).toMatchObject({ role: 'emphasis', landFrame: 0 });
  });

  it('重音超出容差时不吸附，非 emphasis 拍不吸附', () => {
    const srt: SrtEntry[] = [
      { index: 0, startMs: 1000, endMs: 1200, text: '关键数字 99 分！' },
      { index: 1, startMs: 1300, endMs: 1900, text: '普通补充说明一下' },
    ];
    const plan = buildTimingPlan({
      srt,
      startMs: 1000,
      durationMs: 2000,
      fps: 30,
      storyboard: accentSb([
        { cue: 1, kind: 'build', role: 'anticipation', adds: '铺垫' },
        { cue: 1, kind: 'build', role: 'resolve', adds: '收束' },
      ]),
    });
    // accent@0 距 cue 帧 9 在容差内，但两拍都不是 emphasis → 保持 cue 锚定。
    expect(plan.beats.map((beat) => beat.landFrame)).toEqual([9, 9]);

    const farSrt: SrtEntry[] = [
      { index: 0, startMs: 1000, endMs: 1200, text: '关键数字 99 分！' },
      { index: 1, startMs: 1433, endMs: 2000, text: '普通补充说明一下' },
    ];
    const farPlan = buildTimingPlan({
      srt: farSrt,
      startMs: 1000,
      durationMs: 2000,
      fps: 30,
      storyboard: accentSb([{ cue: 1, kind: 'accent', adds: '强调点' }]),
    });
    // cue 帧 13，accent@0 距离 13 > 12 帧容差 → 不吸附。
    expect(farPlan.beats[0].landFrame).toBe(13);
  });

  it('无重音数据时 beats 与旧行为逐帧一致（回归）', () => {
    const srt: SrtEntry[] = [
      { index: 0, startMs: 1000, endMs: 1800, text: '今天天气不错适合出去走走' },
      { index: 1, startMs: 2400, endMs: 3000, text: '随便再聊一点别的事情' },
    ];
    const plan = buildTimingPlan({
      srt,
      startMs: 1000,
      durationMs: 3000,
      fps: 30,
      storyboard: accentSb([
        { cue: 0, kind: 'accent', adds: '强调点' },
        { cue: 1, kind: 'build', adds: '收束' },
      ]),
    });
    expect(plan.accents).toEqual([]);
    expect(plan.beats.map((beat) => beat.landFrame)).toEqual([plan.cues[0], plan.cues[1]]);
  });

  it('metadata 的 speech/bgm 重音同样作为吸附目标（三源合并后生效）', () => {
    const srt: SrtEntry[] = [
      { index: 0, startMs: 1000, endMs: 1500, text: '今天天气不错适合出去走走' },
      { index: 1, startMs: 1600, endMs: 2400, text: '随便再聊一点别的事情' },
    ];
    const plan = buildTimingPlan({
      srt,
      startMs: 1000,
      durationMs: 2000,
      fps: 30,
      storyboard: accentSb([{ cue: 1, kind: 'accent', adds: '强调点' }]),
      metadata: { accents: [{ timeMs: 1300, strength: 2, source: 'speech' }] },
    });
    expect(plan.cues).toEqual([0, 18]);
    expect(plan.accents).toEqual([{ frame: 9, strength: 2, source: 'speech' }]);
    // cue 帧 18 距 speech 重音帧 9 在容差内 → 吸附到语音重音时刻而非字幕句首。
    expect(plan.beats[0].landFrame).toBe(9);
  });

  it('无 cue 锚的 emphasis 拍（fallback 落点）也在容差内向重音吸附', () => {
    const srt: SrtEntry[] = [
      { index: 0, startMs: 1000, endMs: 1500, text: '关键数字 88 分！' },
      { index: 1, startMs: 2700, endMs: 3200, text: '必须记住这句话！' },
    ];
    const plan = buildTimingPlan({
      srt,
      startMs: 1000,
      durationMs: 2400,
      fps: 30,
      storyboard: accentSb([
        { cue: null, kind: 'build', role: 'anticipation', adds: '标题' },
        { cue: null, kind: 'accent', adds: '强调点' },
      ]),
    });
    // fallback 落点为 62，重音帧 51 距离 11 ≤ 12 → 吸附。
    expect(plan.accents.map((accent) => accent.frame)).toEqual([0, 51]);
    expect(plan.beats[1]).toMatchObject({ role: 'emphasis', landFrame: 51 });
  });
});
