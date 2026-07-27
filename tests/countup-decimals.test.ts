import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Remotion from 'remotion';
import { createMotionKit, DEFAULT_MOTION_TOKENS } from '../src/remotion/motion-kit';
import type { MotionKitRemotion } from '../src/remotion/motion-kit';

const makeKit = (frame = 120) =>
  createMotionKit({
    ...Remotion,
    useCurrentFrame: () => frame,
    useVideoConfig: () => ({ width: 1920, height: 1080, fps: 30, durationInFrames: 150 }),
  } as unknown as MotionKitRemotion);

const beat = { start: 0, p: 1, land: 12, done: true };

describe('countUp 小数位', () => {
  const kit = makeKit();

  it('未指定 decimals 时按数值自动推导（8.66 不再被取整成 9）', () => {
    expect(kit.countUp(1, 8.66)).toBe('8.66');
    expect(kit.countUp(1, 0.4)).toBe('0.4');
    expect(kit.countUp(1, 13.5)).toBe('13.5');
  });

  it('整数行为不变', () => {
    expect(kit.countUp(1, 13)).toBe('13');
    expect(kit.countUp(1, 500)).toBe('500');
    expect(kit.countUp(0, 10)).toBe('0');
    expect(kit.countUp(0.5, 10)).not.toContain('.');
  });

  it('小数位超过 2 位时封顶 2 位', () => {
    expect(kit.countUp(1, 8.666)).toBe('8.67');
    expect(kit.countUp(1, 0.125)).toBe('0.13');
  });

  it('显式 decimals 优先于自动推导（含显式 0 取整）', () => {
    expect(kit.countUp(1, 8.66, 0)).toBe('9');
    expect(kit.countUp(1, 8.66, 2)).toBe('8.66');
    expect(kit.countUp(1, 13, 1)).toBe('13.0');
  });

  it('动画中间帧也保持小数位', () => {
    const mid = kit.countUp(0.5, 8.66);
    expect(mid).toMatch(/^\d+\.\d{2}$/);
  });
});

describe('数值原语不再默认取整', () => {
  const kit = makeKit();
  const renderIntoStage = (el: React.ReactElement) =>
    renderToStaticMarkup(
      React.createElement(kit.CardStage, { tokens: DEFAULT_MOTION_TOKENS as never }, el),
    );

  it('MetricPulse 无 decimals prop 渲染 8.66', () => {
    const html = renderIntoStage(React.createElement(kit.MetricPulse, { value: 8.66, unit: '元', label: '发行价', beat }));
    expect(html).toContain('8.66');
    expect(html).not.toContain('>9<');
  });

  it('StatHero 无 decimals prop 渲染 8.66', () => {
    const html = renderIntoStage(React.createElement(kit.StatHero, { value: 8.66, unit: '元', beat }));
    expect(html).toContain('8.66');
  });

  it('RingCounter / ScaleImpact 同样自动小数位', () => {
    expect(renderIntoStage(React.createElement(kit.RingCounter, { value: 0.4, max: 100, beat }))).toContain('0.4');
    expect(renderIntoStage(React.createElement(kit.ScaleImpact, { value: 8.66, max: 20, beat }))).toContain('8.66');
  });

  it('图表项无 display 时数值不再取整', () => {
    const html = renderIntoStage(
      React.createElement(kit.HorizontalBars, {
        items: [
          { label: '甲', value: 8.66 },
          { label: '乙', value: 1.5 },
        ],
        beat,
      }),
    );
    expect(html).toContain('8.66');
    expect(html).toContain('1.5');
  });
});
