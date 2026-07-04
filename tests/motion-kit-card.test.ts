import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Remotion from 'remotion';
import { validateMotionCardTsx } from '../electron/remotion/smoke-render';
import { normalizeMotionTokens, DEFAULT_MOTION_TOKENS, createMotionKit } from '../src/remotion/motion-kit';
import type { MotionKitRemotion } from '../src/remotion/motion-kit';
import { HAND_SKETCH } from '../src/lib/card-style-presets/hand-sketch';
import { MONO_BOLD } from '../src/lib/card-style-presets/mono-bold';

/** 典型 kit 组合卡：CardStage + useBeats + Kicker/StatHero（走真实 esbuild 编译 + require 垫片求值）。 */
const KIT_CARD = `import { CardStage, useBeats, Kicker, StatHero } from '@lingji/motion-kit';
const TOKENS = {
  palette: { bg: '#0E0E10', ink: '#ECE7DA', muted: '#8A8478', accent: '#0A84FF', track: 'rgba(236,231,218,0.12)' },
  fonts: { display: "Georgia, serif", body: "sans-serif", mono: "monospace" },
  ambient: { kind: 'hairline', opacity: [0.08, 0.16] },
  camera: { mode: 'push', range: [0.99, 1.01] },
};
export default function Card({ cues = [] }) {
  const beats = useBeats(cues, [null, 0]);
  return (
    <CardStage tokens={TOKENS}>
      <Kicker text="考研报名" beat={beats[0]} />
      <StatHero value={28842} unit="人" label="硕士报名人数" beat={beats[1]} max={40000} />
    </CardStage>
  );
}`;

const MIXED_CARD = `import { interpolate, useCurrentFrame } from 'remotion';
import { CardStage, useBeats, fadeUp, slideIn, ListBuild } from '@lingji/motion-kit';
export default function Card({ cues = [] }) {
  const frame = useCurrentFrame();
  const beats = useBeats(cues, [null, 0, 1]);
  const custom = interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <CardStage>
      <div style={fadeUp(beats[0].p)}>三个结论</div>
      <ListBuild items={['结论一', '结论二']} beats={[beats[1], beats[2]]} />
      <div style={{ ...slideIn(beats[1].p, 'left'), opacity: custom }}>补充说明</div>
    </CardStage>
  );
}`;

describe('motion-kit 卡片端到端（编译 + 垫片求值 + 冒烟渲染）', () => {
  it('kit 组合卡通过冒烟渲染并在末帧呈现完整数字', async () => {
    const result = await validateMotionCardTsx(KIT_CARD, {
      cues: [0, 20],
      checkRenderedLayout: false,
    });
    expect(result.render.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('kit 与原生 remotion API 混用可正常渲染', async () => {
    const result = await validateMotionCardTsx(MIXED_CARD, {
      cues: [0, 15, 40],
      checkRenderedLayout: false,
    });
    expect(result.render.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('空 cues 下 useBeats 兜底铺满，组件不崩', async () => {
    const result = await validateMotionCardTsx(KIT_CARD, { cues: [], checkRenderedLayout: false });
    expect(result.render.ok).toBe(true);
  });

  it('旧式无 kit 卡片保持向后兼容', async () => {
    const legacy = `import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';
export default function Card({ cues = [] }) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ opacity, alignItems: 'center', justifyContent: 'center' }}>旧卡片</AbsoluteFill>;
}`;
    const result = await validateMotionCardTsx(legacy, { checkRenderedLayout: false });
    expect(result.render.ok).toBe(true);
  });

  it('引用未注入模块仍会被拒绝', async () => {
    const bad = `import gsap from 'gsap';
export default function Card({ cues = [] }) { return <div>{String(gsap)}</div>; }`;
    const result = await validateMotionCardTsx(bad, { checkRenderedLayout: false });
    expect(result.render.ok).toBe(false);
    expect(result.render.error).toContain('gsap');
  });
});

describe('accent 字色对比度守卫', () => {
  const makeKit = (frame = 120) =>
    createMotionKit({
      ...Remotion,
      useCurrentFrame: () => frame,
      useVideoConfig: () => ({ width: 1920, height: 1080, fps: 30, durationInFrames: 150 }),
    } as unknown as MotionKitRemotion);
  const beat = { start: 0, p: 1, land: 12, done: true };

  const renderCard = (tokens: unknown) => {
    const kit = makeKit();
    return renderToStaticMarkup(
      React.createElement(
        kit.CardStage,
        { tokens: tokens as never },
        React.createElement(kit.Kicker, { text: '考研报名', beat }),
        React.createElement(kit.StatHero, { value: 42, unit: '倍', beat }),
      ),
    );
  };

  it('浅色预设（hand-sketch）accent 对底色对比不足，字色回落 ink，条/面仍用 accent', () => {
    const html = renderCard(HAND_SKETCH.motionTokens);
    expect(html).not.toContain('color:#FFD84D');
    expect(html).toContain('color:#2B2B2B');
    expect(html).toContain('background:#FFD84D');
  });

  it('深色预设（mono-bold）accent 对比充足，字色保持 accent', () => {
    const html = renderCard(MONO_BOLD.motionTokens);
    expect(html).toContain('color:#FFE600');
  });

  it('useStage 暴露内容盒尺寸 CW/CH（安全区内可用宽高）', () => {
    const kit = makeKit();
    const Probe = () => {
      const { W, H, CW, CH } = kit.useStage();
      return React.createElement('div', null, `${W}x${H}|${CW}x${Math.round(CH)}`);
    };
    const html = renderToStaticMarkup(
      React.createElement(kit.CardStage, null, React.createElement(Probe)),
    );
    expect(html).toContain('1920x1080|1536x778');
  });
});

describe('normalizeMotionTokens', () => {
  it('缺省回退默认 tokens，部分覆盖深合并', () => {
    expect(normalizeMotionTokens(null)).toEqual(DEFAULT_MOTION_TOKENS);
    const merged = normalizeMotionTokens({ palette: { ...DEFAULT_MOTION_TOKENS.palette, accent: '#FF0000' } });
    expect(merged.palette.accent).toBe('#FF0000');
    expect(merged.fonts.display).toBe(DEFAULT_MOTION_TOKENS.fonts.display);
    expect(merged.camera?.mode).toBe(DEFAULT_MOTION_TOKENS.camera?.mode);
  });
});
