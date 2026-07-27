import { describe, expect, it } from 'vitest';
import { kenBurnsStyle } from '../src/remotion/ken-burns';

describe('kenBurnsStyle（图片卡确定性 Ken Burns）', () => {
  it('首帧 scale=1 无位移，末帧推近到 1.07（幅度克制）', () => {
    expect(kenBurnsStyle(0, 150, 'card-a').transform).toBe('scale(1.0000) translate(0.00%, 0.00%)');
    expect(kenBurnsStyle(150, 150, 'card-a').transform).toContain('scale(1.0700)');
  });

  it('同帧同 seed 输出稳定（帧纯函数），超出时长 clamp 不继续漂移', () => {
    const a = kenBurnsStyle(75, 150, 'card-a');
    expect(kenBurnsStyle(75, 150, 'card-a')).toEqual(a);
    expect(kenBurnsStyle(999, 150, 'card-a')).toEqual(kenBurnsStyle(150, 150, 'card-a'));
  });

  it('平移方向随 seed 奇偶交替，位移幅度不超缩放富余量', () => {
    // 'b' 字符码和为偶 → 正向；'a' 为奇 → 反向
    expect(kenBurnsStyle(150, 150, 'b').transform).toBe('scale(1.0700) translate(1.40%, -0.90%)');
    expect(kenBurnsStyle(150, 150, 'a').transform).toBe('scale(1.0700) translate(-1.40%, 0.90%)');
  });

  it('durationFrames 为 0 时不除零', () => {
    expect(() => kenBurnsStyle(0, 0, 'x')).not.toThrow();
  });
});
