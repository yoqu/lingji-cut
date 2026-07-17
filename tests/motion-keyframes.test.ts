import { describe, expect, it } from 'vitest';
import { computeMotionBeatLandFrames, selectMotionCardKeyframes } from '../src/lib/motion-keyframes';
import type { MotionStoryboard } from '../src/lib/motion-storyboard';

const STORYBOARD: MotionStoryboard = {
  claim: '报名人数变化',
  carrier: 'data-hero',
  scene: '大数字与列表',
  focus: { beat: 2, emphasis: 'countup-settle' },
  beats: [
    { cue: null, kind: 'build', adds: '标题' },
    { cue: 1, kind: 'build', adds: '硕士' },
    { cue: 2, kind: 'accent', adds: '28842 人' },
  ],
};

describe('motion keyframes', () => {
  it('按 useBeats 语义从 cues 推导每拍落点', () => {
    expect(
      computeMotionBeatLandFrames({
        storyboard: STORYBOARD,
        cues: [0, 40, 90],
        durationInFrames: 150,
      }),
    ).toEqual([14, 44, 94]);
  });

  it('没有 cues 时按兜底节奏铺满，并包含首帧与尾帧', () => {
    const frames = selectMotionCardKeyframes({
      storyboard: STORYBOARD,
      durationInFrames: 150,
    });
    expect(frames[0]).toBe(0);
    expect(frames.at(-1)).toBe(149);
    expect(frames).toContain(134); // 第 2 拍兜底 land，且是 focus beat
  });

  it('maxFrames 会保留首尾与 focus 落点', () => {
    const frames = selectMotionCardKeyframes({
      storyboard: STORYBOARD,
      cues: [0, 40, 90],
      durationInFrames: 150,
      maxFrames: 3,
    });
    expect(frames).toEqual([0, 94, 149]);
  });
});
