import { describe, expect, it } from 'vitest';
import { smokeRenderCardTsx, assertCardRenders, validateMotionCardTsx } from '../electron/remotion/smoke-render';

const GOOD = `import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';
export default function Good() {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ opacity }}>{frame}</AbsoluteFill>;
}`;

// 真实失败样本：模型把 stepEnd 数组写成引用了未声明的 s，esbuild 能编译，渲染时抛 ReferenceError。
const BAD_UNDECLARED = `import { AbsoluteFill, useCurrentFrame } from 'remotion';
export default function Bad() {
  const frame = useCurrentFrame();
  const stepEnd = [s + 12, frame];
  return <AbsoluteFill>{stepEnd[1]}</AbsoluteFill>;
}`;

const BAD_THROWS = `export default () => { throw new Error('boom'); }`;

const RETURNS_NULL = `export default () => null;`;

describe('smokeRenderCardTsx', () => {
  it('renders a valid Remotion component without error', async () => {
    const result = await smokeRenderCardTsx(GOOD);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('fails with "s is not defined" for the real undeclared-variable failure', async () => {
    const result = await smokeRenderCardTsx(BAD_UNDECLARED);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('s is not defined');
  });

  it('fails with the thrown message when the component throws at render', async () => {
    const result = await smokeRenderCardTsx(BAD_THROWS);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('boom');
  });

  it('does not throw at smoke-render for a component that returns null', async () => {
    const result = await smokeRenderCardTsx(RETURNS_NULL);
    expect(result.ok).toBe(true);
  });
});

describe('assertCardRenders', () => {
  it('resolves for a valid component', async () => {
    await expect(assertCardRenders(GOOD)).resolves.toBeUndefined();
  });

  it('rejects with the 渲染校验失败 + 请重新生成 message for a crashing component', async () => {
    await expect(assertCardRenders(BAD_UNDECLARED)).rejects.toThrow(/渲染校验失败/);
    await expect(assertCardRenders(BAD_UNDECLARED)).rejects.toThrow(/请重新生成/);
  });
});

// 撞色样本：色块底与字色同为 accent 粉——生成期真实事故形态（模型把 accent 同时当块底和字色）。
const SAME_COLOR_TEXT = `import { AbsoluteFill } from 'remotion';
export default function Clash() {
  return <AbsoluteFill style={{ background: '#0E0E10' }}>
    <div style={{ position: 'absolute', left: 200, top: 200, background: '#FF9EB5', padding: 40 }}>
      <span style={{ color: '#FF9EB5', fontSize: 48 }}>关键结论文字</span>
    </div>
  </AbsoluteFill>;
}`;

const READABLE_TEXT = `import { AbsoluteFill } from 'remotion';
export default function Fine() {
  return <AbsoluteFill style={{ background: '#0E0E10' }}>
    <div style={{ position: 'absolute', left: 200, top: 200, background: '#FF9EB5', padding: 40 }}>
      <span style={{ color: '#2B2B2B', fontSize: 48 }}>关键结论文字</span>
    </div>
  </AbsoluteFill>;
}`;

describe('文字-背景对比度探针', () => {
  it('字色与所在色块底色同色 → text-bg-contrast error', async () => {
    const result = await validateMotionCardTsx(SAME_COLOR_TEXT, { checkRenderedLayout: true });
    expect(result.issues.some((i) => i.code === 'text-bg-contrast' && i.severity === 'error')).toBe(true);
    expect(result.ok).toBe(false);
  }, 120_000);

  it('同一色块换 ink 字色 → 无对比度 error', async () => {
    const result = await validateMotionCardTsx(READABLE_TEXT, { checkRenderedLayout: true });
    expect(result.issues.filter((i) => i.code === 'text-bg-contrast')).toEqual([]);
  }, 120_000);
});

describe('validateMotionCardTsx', () => {
  it('marks return null as a validation error while smoke rendering stays compatible', async () => {
    const result = await validateMotionCardTsx(RETURNS_NULL, { checkRenderedLayout: false });
    expect(result.render.ok).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'returns-null' && issue.severity === 'error')).toBe(true);
  });
});
