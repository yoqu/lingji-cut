import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CardAssetBinding } from '../src/types/assets';
import {
  smokeRenderCardTsx,
  assertCardRenders,
  validateMotionCardTsx,
  motionCardContactSheetCacheKey,
  renderMotionCardKeyframeMarkups,
  renderMotionCardContactSheet,
} from '../electron/remotion/smoke-render';

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
    await expect(assertCardRenders(GOOD)).resolves.toMatchObject({ ok: true, renderOk: true });
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

describe('motion card contact sheet', () => {
  it('cache key is stable for same source/frames and changes when frames change', () => {
    const a = motionCardContactSheetCacheKey({ tsx: GOOD, frames: [0, 75, 149], storyboard: 's' });
    const b = motionCardContactSheetCacheKey({ tsx: GOOD, frames: [0, 75, 149], storyboard: 's' });
    const c = motionCardContactSheetCacheKey({ tsx: GOOD, frames: [0, 30, 149], storyboard: 's' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('contact sheet cache key changes when bound assets change', () => {
    const a = motionCardContactSheetCacheKey({
      tsx: GOOD,
      frames: [0, 30],
      assetSignature: 'hero:asset-a:v1',
    });
    const b = motionCardContactSheetCacheKey({
      tsx: GOOD,
      frames: [0, 30],
      assetSignature: 'hero:asset-a:v2',
    });
    expect(a).not.toBe(b);
  });

  it('renders static markup for requested keyframes', async () => {
    const frames = await renderMotionCardKeyframeMarkups(GOOD, { frames: [0, 30] });
    expect(frames.map((f) => f.frame)).toEqual([0, 30]);
    expect(frames[0]?.markup).toContain('0');
    expect(frames[1]?.markup).toContain('30');
  });

  it('renders and reuses a cached PNG contact sheet', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingji-contact-sheet-'));
    const first = await renderMotionCardContactSheet(GOOD, {
      frames: [0, 30],
      cacheDir,
      cacheKey: 'unit',
      thumbWidth: 240,
      columns: 2,
    });
    expect(first.cached).toBe(false);
    expect(first.png.subarray(1, 4).toString('utf8')).toBe('PNG');
    expect(first.cachePath).toBe(path.join(cacheDir, 'unit.png'));

    const second = await renderMotionCardContactSheet(GOOD, {
      frames: [0, 30],
      cacheDir,
      cacheKey: 'unit',
      thumbWidth: 240,
      columns: 2,
    });
    expect(second.cached).toBe(true);
    expect(second.png.length).toBe(first.png.length);
  }, 120_000);
});

// 超载样本：CardStage 内容盒里塞 StatHero + 6 条 ListBuild，累计高度远超 0.72H（≈778px），
// 复现"内容多 -> 元素堆叠重叠"的真实事故形态。
const OVERLOADED_KIT_CARD = `import { CardStage, useBeats, StatHero, ListBuild } from '@lingji/motion-kit';
const TOKENS = {
  palette: { bg: '#0E0E10', ink: '#ECE7DA', muted: '#8A8478', accent: '#0A84FF', track: 'rgba(236,231,218,0.12)' },
  fonts: { display: "Georgia, serif", body: "sans-serif", mono: "monospace" },
};
export default function Card({ cues = [] }) {
  const beats = useBeats(cues, [null, 0, 1, 2, 3, 4, 5, 6]);
  return (
    <CardStage tokens={TOKENS}>
      <StatHero value={28842} unit="人" label="报名人数" beat={beats[1]} max={40000} />
      <ListBuild items={['要点结论一','要点结论二','要点结论三','要点结论四','要点结论五','要点结论六']} beats={beats.slice(1)} />
    </CardStage>
  );
}`;

// 正常样本：单 Kicker + StatHero，累计高度 ~0.45H < 0.72H，不应误报 content-box-overflow。
const FIT_KIT_CARD = `import { CardStage, useBeats, Kicker, StatHero } from '@lingji/motion-kit';
const TOKENS = {
  palette: { bg: '#0E0E10', ink: '#ECE7DA', muted: '#8A8478', accent: '#0A84FF', track: 'rgba(236,231,218,0.12)' },
  fonts: { display: "Georgia, serif", body: "sans-serif", mono: "monospace" },
};
export default function Card({ cues = [] }) {
  const beats = useBeats(cues, [null, 1]);
  return (
    <CardStage tokens={TOKENS}>
      <Kicker text="考研报名" beat={beats[0]} />
      <StatHero value={28842} unit="人" label="硕士报名人数" beat={beats[1]} max={40000} />
    </CardStage>
  );
}`;

describe('内容盒累计高度溢出探针', () => {
  it('CardStage 内容超 0.72H -> content-box-overflow error', async () => {
    const result = await validateMotionCardTsx(OVERLOADED_KIT_CARD, {
      cues: [0, 10, 20, 30, 40, 50, 60, 70],
      checkRenderedLayout: true,
    });
    expect(result.issues.some((i) => i.code === 'content-box-overflow' && i.severity === 'error')).toBe(true);
    expect(result.ok).toBe(false);
  }, 120_000);

  it('单原语卡内容在容量内 -> 不报 content-box-overflow', async () => {
    const result = await validateMotionCardTsx(FIT_KIT_CARD, {
      cues: [0, 20],
      checkRenderedLayout: true,
    });
    expect(result.issues.filter((i) => i.code === 'content-box-overflow')).toEqual([]);
  }, 120_000);
});

const OVERLAPPING_TEXT = `import { AbsoluteFill } from 'remotion';
export default function Card() {
  return <AbsoluteFill style={{ background: '#101820' }}>
    <span style={{ position: 'absolute', left: 300, top: 260, fontSize: 72, color: '#fff' }}>主结论</span>
    <span style={{ position: 'absolute', left: 320, top: 275, fontSize: 64, color: '#fff' }}>辅助说明</span>
  </AbsoluteFill>;
}`;

const CROSS_FRAME_ONLY = `import { AbsoluteFill, useCurrentFrame } from 'remotion';
export default function Card() {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ background: '#101820' }}>
    <span style={{ position: 'absolute', left: frame < 15 ? 120 : 1200, top: 260, fontSize: 64, color: '#fff' }}>元素甲</span>
    <span style={{ position: 'absolute', left: frame < 15 ? 1200 : 120, top: 260, fontSize: 64, color: '#fff' }}>元素乙</span>
  </AbsoluteFill>;
}`;

// 瞬态重叠样本：前 15 帧两元素叠在同一位置（模拟 emphasis 弹簧 / 入场滑入的瞬时交叠），之后分开。
const TRANSIENT_OVERLAP = `import { AbsoluteFill, useCurrentFrame } from 'remotion';
export default function Card() {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ background: '#101820' }}>
    <span style={{ position: 'absolute', left: 120, top: 260, fontSize: 64, color: '#fff' }}>元素甲</span>
    <span style={{ position: 'absolute', left: frame < 15 ? 120 : 1200, top: 260, fontSize: 64, color: '#fff' }}>元素乙</span>
  </AbsoluteFill>;
}`;

describe('逐帧语义碰撞探针', () => {
  it('同一帧文字区块明显重叠 -> semantic-occlusion error', async () => {
    const result = await validateMotionCardTsx(OVERLAPPING_TEXT, {
      frames: [0], durationInFrames: 60, checkRenderedLayout: true,
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic-occlusion', severity: 'error', frame: 0 }),
    ]));
    expect(result.ok).toBe(false);
  }, 120_000);

  it('assert 抛错时仍携带完整 layoutIssues，供编排器记录与回喂', async () => {
    await expect(assertCardRenders(OVERLAPPING_TEXT, {
      frames: [0], durationInFrames: 60,
    })).rejects.toMatchObject({
      name: 'MotionCardValidationError',
      validation: {
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'semantic-occlusion', severity: 'error', frame: 0 }),
        ]),
      },
    });
  }, 120_000);

  it('不同帧占用过相同位置但单帧内不重叠 -> 不误报', async () => {
    const result = await validateMotionCardTsx(CROSS_FRAME_ONLY, {
      frames: [0, 30], durationInFrames: 60, checkRenderedLayout: true,
    });
    expect(result.issues.filter((issue) => issue.code === 'semantic-occlusion')).toEqual([]);
  }, 120_000);

  it('多采样帧持续重叠 -> 仍判 semantic-occlusion error（持续性规则不削弱真遮挡）', async () => {
    const result = await validateMotionCardTsx(OVERLAPPING_TEXT, {
      frames: [0, 30, 59], durationInFrames: 60, checkRenderedLayout: true,
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic-occlusion', severity: 'error' }),
    ]));
    expect(result.ok).toBe(false);
  }, 120_000);

  it('单帧瞬态重叠且落定帧无重叠 -> 降级 warning，不阻断', async () => {
    const result = await validateMotionCardTsx(TRANSIENT_OVERLAP, {
      frames: [0, 30, 59], durationInFrames: 60, checkRenderedLayout: true,
    });
    const occlusions = result.issues.filter((issue) => issue.code === 'semantic-occlusion');
    expect(occlusions.length).toBeGreaterThan(0);
    expect(occlusions.every((issue) => issue.severity === 'warning')).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
  }, 120_000);

  it('前景资产覆盖文字 -> semantic-occlusion error', async () => {
    const asset: CardAssetBinding = {
      slot: 'hero-object', assetId: 'asset-1', filePath: 'data:image/png;base64,iVBORw0KGgo=',
      treatment: {
        profile: 'editorial-realist-cutout', lighting: 'soft-left', palette: 'low-saturation',
        shadow: 'soft-ground', perspective: 'front-3q',
      },
      metadata: { width: 400, height: 200 },
      placement: { x: 260, y: 220, width: 500, height: 260, depth: 'foreground' },
      motion: { enter: 'hold', emphasis: 'none', exit: 'hold' },
    };
    const result = await validateMotionCardTsx(OVERLAPPING_TEXT.replace(
      /<span[^>]*>辅助说明<\/span>/,
      '',
    ), {
      frames: [0], durationInFrames: 60, assetBindings: [asset], checkRenderedLayout: true,
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic-occlusion', severity: 'error', frame: 0 }),
    ]));
  }, 120_000);
});
