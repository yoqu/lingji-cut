import { describe, expect, it } from 'vitest';
import { lintMotionCardTsx, formatLintIssues } from '../src/lib/motion-card-lint';

const GOOD = `import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';
import { CardStage, useBeats } from '@lingji/motion-kit';
const TOKENS = { palette: { bg: '#F4EDE1', ink: '#2B2B2B', muted: '#7A6E5A', accent: '#FFD84D' } };
export default function Card({ cues = [] }) {
  const beats = useBeats(cues, [null, 1]);
  return <CardStage tokens={TOKENS}>{beats[0].p}</CardStage>;
}`;

describe('lintMotionCardTsx', () => {
  it('合法 kit 组件通过', () => {
    const r = lintMotionCardTsx(GOOD);
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('自动模式强制 SafeLayout/MotionSlot、禁止 absolute 与多个主原语', () => {
    expect(lintMotionCardTsx(GOOD, { requireSafeLayout: true }).issues.map((issue) => issue.code))
      .toContain('safe-layout-required');
    const safe = `import { CardStage, SafeLayout, MotionSlot, useBeats, Kicker, StatHero } from '@lingji/motion-kit';
const TOKENS = { palette: { bg: '#111', ink: '#fff', muted: '#999', accent: '#08f' } };
export default function Card({ cues = [] }) {
  const beats = useBeats(cues, [null, 1]);
  return <CardStage tokens={TOKENS}><SafeLayout variant="title-hero">
    <MotionSlot name="header"><Kicker text="标题" beat={beats[0]} /></MotionSlot>
    <MotionSlot name="main"><StatHero value={42} beat={beats[1]} /></MotionSlot>
  </SafeLayout></CardStage>;
}`;
    expect(lintMotionCardTsx(safe, { requireSafeLayout: true }).ok).toBe(true);
    const crowded = safe.replace('</MotionSlot>\n  </SafeLayout>', '<StatHero value={21} beat={beats[1]} /></MotionSlot>\n  </SafeLayout>');
    expect(lintMotionCardTsx(crowded, { requireSafeLayout: true }).issues.map((issue) => issue.code))
      .toContain('too-many-main-primitives');
  });

  it('任意两个新主原语同卡触发 too-many-main-primitives', () => {
    const source = `import { CardStage, SafeLayout, MotionSlot, useBeats, RankList, ConceptCard } from '@lingji/motion-kit';
const TOKENS = { palette: { bg: '#111', ink: '#fff', muted: '#999', accent: '#08f' } };
export default function Card({ cues = [] }) {
  const beats = useBeats(cues, [null, 1]);
  return <CardStage tokens={TOKENS}><SafeLayout variant="title-hero">
    <MotionSlot name="main"><RankList items={[{label:'A'}]} beat={beats[0]} /><ConceptCard term="B" definition="C" beat={beats[1]} /></MotionSlot>
  </SafeLayout></CardStage>;
}`;
    expect(lintMotionCardTsx(source, { requireSafeLayout: true }).issues.map((issue) => issue.code))
      .toContain('too-many-main-primitives');
  });

  it('空源码 / 缺 export default 报错', () => {
    expect(lintMotionCardTsx('').ok).toBe(false);
    const r = lintMotionCardTsx('function Card() { return null; }');
    expect(r.issues.map((i) => i.code)).toContain('missing-default-export');
  });

  it('禁用 API 逐条拦截', () => {
    for (const [snippet, code] of [
      ['const x = Math.random();', 'banned-random'],
      ['const t = new Date();', 'banned-date'],
      ['const t = Date.now();', 'banned-date'],
      ['fetch("https://x")', 'banned-network'],
      ['setTimeout(() => {}, 1)', 'banned-timer'],
      ['requestAnimationFrame(() => {})', 'banned-raf'],
      ['document.querySelector("x")', 'banned-dom'],
      ['window.innerWidth', 'banned-dom'],
    ] as const) {
      const r = lintMotionCardTsx(`${GOOD}\n// extra\nconst extra = () => { ${snippet} };`);
      expect(r.ok, snippet).toBe(false);
      expect(r.issues.map((i) => i.code), snippet).toContain(code);
    }
  });

  it('非法 import 拦截（仅允许 remotion/react/@lingji/motion-kit）', () => {
    const r = lintMotionCardTsx(`import * as d3 from 'd3';\n${GOOD}`);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('forbidden-import');
  });

  it('kit 幻觉 API 拦截：named import 必须在导出清单里，错误信息列出合法名', () => {
    const bad = GOOD.replace(
      "import { CardStage, useBeats } from '@lingji/motion-kit';",
      "import { CardStage, useBeats, MagicChart } from '@lingji/motion-kit';",
    );
    const r = lintMotionCardTsx(bad);
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.code === 'unknown-kit-export');
    expect(issue?.message).toContain('MagicChart');
    expect(issue?.message).toContain('StatHero');
    // 别名写法（as）取原名校验，不误伤
    const aliased = GOOD.replace(
      "import { CardStage, useBeats } from '@lingji/motion-kit';",
      "import { CardStage as Stage, useBeats } from '@lingji/motion-kit';",
    );
    expect(lintMotionCardTsx(aliased).ok).toBe(true);
  });

  it('TODO / 省略占位报错', () => {
    const stub = `import { AbsoluteFill } from 'remotion';
export default function Card({ cues = [] }) {
  const a = 1;
  // TODO: build out the rest
  return <AbsoluteFill />;
}`;
    expect(lintMotionCardTsx(stub).issues.map((i) => i.code)).toContain('unfinished-source');
  });

  it('interpolate 缺任一侧 clamp 报错；双侧齐全或 spread 预置常量放行', () => {
    const oneSide = `${GOOD}\nconst y = (frame) => interpolate(frame, [10, 20], [0, 350], { extrapolateRight: 'clamp', easing: (t) => t });`;
    const r = lintMotionCardTsx(oneSide);
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === 'unclamped-interpolate')?.message).toContain('extrapolateLeft');

    const noClamp = `${GOOD}\nconst y = (frame) => interpolate(frame, [10, 20], [0, 1]);`;
    expect(lintMotionCardTsx(noClamp).issues.map((i) => i.code)).toContain('unclamped-interpolate');

    const both = `${GOOD}\nconst y = (frame) => interpolate(frame, [10, 20], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });`;
    expect(lintMotionCardTsx(both).ok).toBe(true);

    const spread = `${GOOD}\nconst CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };\nconst y = (frame) => interpolate(frame, [10, 20], [0, 1], { ...CLAMP });`;
    expect(lintMotionCardTsx(spread).ok).toBe(true);
  });

  it('interpolate 颜色字符串范围报错（提示 interpolateColors），数值范围不误伤', () => {
    const color = `${GOOD}\nconst c = (frame) => interpolate(frame, [0, 30], ['#F4EDE1', '#FFD84D'], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });`;
    const r = lintMotionCardTsx(color);
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === 'interpolate-color-range')?.message).toContain('interpolateColors');

    const numeric = `${GOOD}\nconst y = (frame) => interpolate(frame, [10, 20], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });`;
    expect(lintMotionCardTsx(numeric).ok).toBe(true);
  });

  it('高频 Math.sin(frame/T<60) 报错，低频 T≥60 放行', () => {
    const high = lintMotionCardTsx(`${GOOD}\nconst y = (frame) => Math.sin(frame / 10);`);
    expect(high.issues.map((i) => i.code)).toContain('high-frequency-loop');
    const low = lintMotionCardTsx(`${GOOD}\nconst y = (frame) => Math.sin(frame / 90);`);
    expect(low.ok).toBe(true);
  });

  it('cues 完全未消费给出 warn（不阻断）', () => {
    const noCues = `import { AbsoluteFill } from 'remotion';
export default function Card({ cues = [] }) {
  return <AbsoluteFill>静态</AbsoluteFill>;
}`;
    const r = lintMotionCardTsx(noCues);
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.code)).toContain('cues-unused');
  });

  it('CardStage 缺 tokens 报错（bg=/palette= 幻觉 prop 与裸标签均拦截）', () => {
    // 真实黑卡回归样本①：bg= + ambient= + camera= 独立 prop
    const bgProp = GOOD.replace(
      '<CardStage tokens={TOKENS}>',
      "<CardStage bg={'#F4EDE1'} ambient={{ kind: 'grid', opacity: [0.08, 0.08] }} camera={{ mode: 'still' }}>",
    );
    expect(lintMotionCardTsx(bgProp).issues.map((i) => i.code)).toContain('cardstage-missing-tokens');
    // 真实黑卡回归样本②：palette= 独立 prop
    const paletteProp = GOOD.replace('<CardStage tokens={TOKENS}>', '<CardStage palette={TOKENS.palette}>');
    expect(lintMotionCardTsx(paletteProp).issues.map((i) => i.code)).toContain('cardstage-missing-tokens');
    // 裸标签（回落深色默认底）同样拦截
    const bare = GOOD.replace('<CardStage tokens={TOKENS}>', '<CardStage>');
    expect(lintMotionCardTsx(bare).issues.map((i) => i.code)).toContain('cardstage-missing-tokens');
    // 合法内联 tokens（含嵌套花括号）放行
    const inline = GOOD.replace(
      '<CardStage tokens={TOKENS}>',
      "<CardStage tokens={{ palette: TOKENS.palette, camera: { mode: 'still' } }}>",
    );
    expect(lintMotionCardTsx(inline).ok).toBe(true);
    // 不用 CardStage 的纯 AbsoluteFill 卡不受影响
    const noStage = `import { AbsoluteFill } from 'remotion';
export default function Card({ cues = [] }) {
  return <AbsoluteFill style={{ backgroundColor: '#F4EDE1' }}>{cues.length}</AbsoluteFill>;
}`;
    expect(lintMotionCardTsx(noStage).ok).toBe(true);
  });

  it('formatLintIssues 产出编号修复指令', () => {
    const r = lintMotionCardTsx('');
    expect(formatLintIssues(r.issues)).toMatch(/^1\. \[error\]/);
  });
});
