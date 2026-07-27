import { describe, expect, it } from 'vitest';
import { resolveTextMotionFrame } from '../src/remotion/overlays/TextOverlay';
import type { OverlayMotion } from '../src/types';

const FPS = 30;
const DURATION = 60;

function motion(partial: Partial<OverlayMotion> = {}): OverlayMotion {
  return { enter: 'none', enterDurationMs: 400, exit: 'none', exitDurationMs: 400, loop: 'none', ...partial };
}

// TextOverlay 消费 resolveOverlayMotion 的进出场 / 循环预设（UI 配置不再"配了不动"）。
describe('resolveTextMotionFrame（文字 overlay 进出场 / 循环动效）', () => {
  it('enter=none 保持旧行为：按 18% 时长淡入，其余无变换', () => {
    const start = resolveTextMotionFrame(motion(), 'none', 0, DURATION, FPS, 1, 0);
    expect(start.opacity).toBe(0);
    expect(start.transforms).toEqual([]);
    expect(start.visibleChars).toBeNull();
    // 旧公式 fadeIn = min(13, max(5, 60*0.18=11)) = 11 帧
    const after = resolveTextMotionFrame(motion(), 'none', 20, DURATION, FPS, 1, 0);
    expect(after.opacity).toBe(1);
  });

  it('fadeIn：按 enterDurationMs 线性淡入', () => {
    const mid = resolveTextMotionFrame(motion({ enter: 'fadeIn' }), 'none', 6, DURATION, FPS, 1, 0);
    expect(mid.opacity).toBeCloseTo(0.5, 5);
  });

  it('slideInLeft / scaleIn：起始帧带位移 / 缩放，落定后收敛', () => {
    const slide = resolveTextMotionFrame(motion({ enter: 'slideInLeft' }), 'none', 0, DURATION, FPS, 1, 0);
    expect(slide.transforms).toEqual(['translateX(-48.00px)']);
    expect(slide.opacity).toBe(0);
    const slideDone = resolveTextMotionFrame(motion({ enter: 'slideInUp' }), 'none', 20, DURATION, FPS, 1, 0);
    expect(slideDone.transforms).toEqual(['translateY(0.00px)']);
    const scale = resolveTextMotionFrame(motion({ enter: 'scaleIn' }), 'none', 0, DURATION, FPS, 1, 0);
    expect(scale.transforms).toEqual(['scale(0.7200)']);
  });

  it('bounceIn：弹入起始缩小透明，落定 scale=1', () => {
    const start = resolveTextMotionFrame(motion({ enter: 'bounceIn' }), 'none', 0, DURATION, FPS, 1, 0);
    expect(start.opacity).toBe(0);
    expect(start.transforms).toEqual(['scale(0.5500)']);
    const done = resolveTextMotionFrame(motion({ enter: 'bounceIn' }), 'none', 30, DURATION, FPS, 1, 0);
    expect(done.transforms).toEqual(['scale(1.0000)']);
    expect(done.opacity).toBe(1);
  });

  it('fadeOut / scaleOut：只在出场窗口内生效', () => {
    // exitDurationMs=300 → exitFrames=9，窗口 [51, 60]
    const m = motion({ exit: 'fadeOut', exitDurationMs: 300 });
    expect(resolveTextMotionFrame(m, 'none', 30, DURATION, FPS, 1, 0).opacity).toBe(1);
    expect(resolveTextMotionFrame(m, 'none', 60, DURATION, FPS, 1, 0).opacity).toBe(0);
    const scale = resolveTextMotionFrame(motion({ exit: 'scaleOut', exitDurationMs: 300 }), 'none', 60, DURATION, FPS, 1, 0);
    expect(scale.transforms).toEqual(['scale(0.7200)']);
  });

  it('bounceOut：先回拉再弹出，末帧 opacity=0', () => {
    const done = resolveTextMotionFrame(motion({ exit: 'bounceOut', exitDurationMs: 300 }), 'none', 60, DURATION, FPS, 1, 0);
    expect(done.opacity).toBe(0);
    expect(done.transforms[0]).toContain('scale(0.62');
  });

  it('typewriter：逐字揭示，出场前铺满', () => {
    const m = motion({ enter: 'none', exit: 'none' });
    // exitFrames=12 → exitStart=48；window = 48 - min(12,8) = 40
    expect(resolveTextMotionFrame(m, 'typewriter', 0, DURATION, FPS, 1, 10).visibleChars).toBe(0);
    expect(resolveTextMotionFrame(m, 'typewriter', 20, DURATION, FPS, 1, 10).visibleChars).toBe(5);
    expect(resolveTextMotionFrame(m, 'typewriter', 40, DURATION, FPS, 1, 10).visibleChars).toBe(10);
    // 非 typewriter 不截字
    expect(resolveTextMotionFrame(m, 'pulse', 20, DURATION, FPS, 1, 10).visibleChars).toBeNull();
  });

  it('pulse / float / flicker：仅在入场完成后、出场开始前的循环窗口生效', () => {
    const m = motion();
    const early = resolveTextMotionFrame(m, 'pulse', 0, DURATION, FPS, 1, 0);
    expect(early.transforms).toEqual([]);
    const pulsing = resolveTextMotionFrame(m, 'pulse', 24, DURATION, FPS, 1, 0);
    expect(pulsing.transforms[0]).toContain('scale(1.0');
    const floating = resolveTextMotionFrame(m, 'float', 24, DURATION, FPS, 1, 0);
    expect(floating.transforms[0]).toContain('translateY(');
    const flickered = resolveTextMotionFrame(m, 'flicker', 24, DURATION, FPS, 1, 0);
    expect(flickered.opacity).toBeGreaterThan(0);
  });

  it('baseOpacity 参与合成且同帧输出确定', () => {
    const m = motion({ enter: 'fadeIn' });
    const a = resolveTextMotionFrame(m, 'none', 6, DURATION, FPS, 0.6, 0);
    expect(a.opacity).toBeCloseTo(0.3, 5);
    expect(a).toEqual(resolveTextMotionFrame(m, 'none', 6, DURATION, FPS, 0.6, 0));
  });
});
