import { describe, expect, it } from 'vitest';
import { highlightMotionSpanStyle } from '../src/remotion/overlays/SubtitleLayer';

// SubtitleLayer 消费 project.json 的 subtitle.highlightAnimation（pop | wipe | none），
// 帧以字幕条目出现为 0（外层 Sequence from = 条目起始帧）。
describe('highlightMotionSpanStyle（字幕高亮动画）', () => {
  it('pop：高亮块缩放回弹入场，落定后 scale 收敛为 1', () => {
    const start = highlightMotionSpanStyle('pop', 0, 30, '#F8DC48');
    expect(start.transform).toContain('scale(0.5500)');
    expect(start.opacity).toBe(0);
    const landed = highlightMotionSpanStyle('pop', 20, 30, '#F8DC48');
    expect(landed.transform).toBe('scale(1.0000)');
    expect(landed.opacity).toBe(1);
    expect(landed.display).toBe('inline-block');
  });

  it('wipe：色块自左向右扫过（backgroundSize 0% → 100%）', () => {
    const start = highlightMotionSpanStyle('wipe', 0, 30, '#F8DC48');
    expect(start.backgroundSize).toBe('0.0% 100%');
    expect(start.backgroundColor).toBe('transparent');
    expect(start.backgroundImage).toContain('#F8DC48');
    const done = highlightMotionSpanStyle('wipe', 13, 30, '#F8DC48');
    expect(done.backgroundSize).toBe('100.0% 100%');
  });

  it('none：无动效样式（保持静态旧行为）', () => {
    expect(highlightMotionSpanStyle('none', 0, 30, '#F8DC48')).toEqual({});
    expect(highlightMotionSpanStyle('none', 10, 30, '#F8DC48')).toEqual({});
  });

  it('同帧输出确定（无 Date.now / random）', () => {
    expect(highlightMotionSpanStyle('pop', 5, 30, '#F8DC48')).toEqual(highlightMotionSpanStyle('pop', 5, 30, '#F8DC48'));
    expect(highlightMotionSpanStyle('wipe', 7, 30, '#F8DC48')).toEqual(highlightMotionSpanStyle('wipe', 7, 30, '#F8DC48'));
  });
});
