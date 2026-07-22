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

const PROFESSIONAL_CARRIER_CARD = `import { CardStage, useBeats, TimelineRail, MatrixQuadrant, FunnelStack, NetworkMap, BeforeAfter, StackedComposition } from '@lingji/motion-kit';
export default function Card({ cues = [] }) {
  const beats = useBeats(cues, [null, 0, 1, 2, 3, 4]);
  return (
    <CardStage>
      <TimelineRail items={['起步', '爆发', '分化']} beat={beats[0]} />
      <MatrixQuadrant items={[{ label: '优先', x: 78, y: 72, focus: true }, { label: '暂缓', x: 28, y: 36 }]} beat={beats[1]} />
      <FunnelStack steps={[{ label: '触达', value: '10万' }, { label: '转化', value: '1万' }]} beat={beats[2]} />
      <NetworkMap nodes={['平台', '创作者', '观众']} links={[[0, 1], [1, 2]]} beat={beats[3]} />
      <BeforeAfter before="旧流程慢" after="新流程快" beat={beats[4]} />
      <StackedComposition items={[{ label: '内容', value: 55, display: '55%' }, { label: '分发', value: 30, display: '30%' }]} beat={beats[5]} />
    </CardStage>
  );
}`;

const TIMING_PLAN_CARD = `import { CardStage, useTimingPlan, Kicker, StatHero } from '@lingji/motion-kit';
export default function Card({ cues = [], timingPlan }) {
  const beats = useTimingPlan(timingPlan, cues, [null, 1]);
  return (
    <CardStage>
      <Kicker text="节奏卡" beat={beats[0]} />
      <StatHero value={28842} unit="人" label="重音落点" beat={beats[1]} max={40000} />
    </CardStage>
  );
}`;

const LIFECYCLE_CARD = `import { CardStage, SafeLayout, MotionSlot, useBeats, Kicker, ProcessFlow } from '@lingji/motion-kit';
export default function Card({ cues = [] }) {
  const beats = useBeats(cues, [null, 0, 1]);
  return (
    <CardStage>
      <SafeLayout variant="title-hero">
        <MotionSlot name="header" lifecycle={{ enter: beats[0], collapse: beats[1] }}>
          <Kicker text="资金成本" beat={beats[0]} />
        </MotionSlot>
        <MotionSlot name="main" lifecycle={{ enter: beats[1], update: beats[2] }}>
          <ProcessFlow steps={['高利率', '成本抬升', '投资者算账']} beats={[beats[0], beats[1], beats[2]]} focusIndex={2} emphasis="slam" />
        </MotionSlot>
      </SafeLayout>
    </CardStage>
  );
}`;

const NEW_PRIMITIVES_CARD = `import { CardStage, useBeats, RingCounter, HorizontalBars, TrendLine, RankList, ChecklistPop, CauseChain, ConceptCard, CitationCard, KeyPointMarker, MythFactSwap } from '@lingji/motion-kit';
const TOKENS = {
  palette: { bg: '#0E0E10', ink: '#ECE7DA', muted: '#8A8478', accent: '#0A84FF', track: 'rgba(236,231,218,0.12)' },
  fonts: { display: 'Georgia, serif', body: 'sans-serif', mono: 'monospace' },
};
export default function Card({ cues = [] }) {
  const beats = useBeats(cues, [null, 0, 1]);
  return <CardStage tokens={TOKENS}><div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:16}}>
    <RingCounter value={72} max={100} unit="%" beat={beats[0]} />
    <HorizontalBars items={[{label:'A',value:72},{label:'B',value:48}]} beat={beats[0]} />
    <TrendLine points={[2,5,3,9]} markers={[{index:2,label:'拐点'}]} fill beat={beats[0]} />
    <RankList items={[{label:'第一',value:'92'},{label:'第二',value:'86'}]} beat={beats[0]} />
    <ChecklistPop items={['确认','同步']} beat={beats[0]} />
    <CauseChain steps={['原因','机制','结果']} beat={beats[0]} />
    <ConceptCard term="概念" definition="一句释义" beat={beats[0]} />
    <CitationCard text="引用正文" source="来源" date="2026" beat={beats[0]} />
    <KeyPointMarker text="关键结论" beat={beats[0]} />
    <MythFactSwap myth="误区" fact="事实" beat={beats[0]} swapBeat={beats[1]} />
  </div></CardStage>;
}`;

const MAX_LIST_LAYOUT_CARD = `import { CardStage, SafeLayout, MotionSlot, useBeats, HorizontalBars } from '@lingji/motion-kit';
const TOKENS = {
  palette: { bg: '#0E0E10', ink: '#ECE7DA', muted: '#8A8478', accent: '#0A84FF', track: 'rgba(236,231,218,0.12)' },
  fonts: { display: 'Georgia, serif', body: 'sans-serif', mono: 'monospace' },
};
export default function Card({ cues = [] }) {
  const beats = useBeats(cues, [null]);
  const items = [
    {label:'核心指标一',value:100,display:'100%'},{label:'核心指标二',value:82,display:'82%'},
    {label:'核心指标三',value:64,display:'64%'},{label:'核心指标四',value:46,display:'46%'},
    {label:'核心指标五',value:28,display:'28%'},{label:'应被截断',value:12,display:'12%'},
  ];
  return <CardStage tokens={TOKENS}><SafeLayout variant="single-focus"><MotionSlot name="main"><HorizontalBars items={items} beat={beats[0]} focusIndex={0} /></MotionSlot></SafeLayout></CardStage>;
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

  it('新增专业 carrier 原语可正常渲染', async () => {
    const result = await validateMotionCardTsx(PROFESSIONAL_CARRIER_CARD, {
      cues: [0, 15, 30, 45, 60],
      checkRenderedLayout: false,
    });
    expect(result.render.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('useTimingPlan 可消费注入的 TimingPlan 并保持旧 cues fallback', async () => {
    const result = await validateMotionCardTsx(TIMING_PLAN_CARD, {
      cues: [0, 45],
      timingPlan: {
        fps: 30,
        cues: [0, 45],
        pauses: [{ frame: 70, durationFrames: 18 }],
        accents: [{ frame: 45, strength: 3, source: 'subtitle' }],
        beats: [
          { storyboardBeatIndex: 0, role: 'anticipation', startFrame: 0, landFrame: 12 },
          { storyboardBeatIndex: 1, role: 'emphasis', startFrame: 39, landFrame: 45, holdUntil: 70 },
        ],
      },
      checkRenderedLayout: false,
    });
    expect(result.render.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('MotionSlot lifecycle 与逐拍 ProcessFlow/emphasis 可编译渲染', async () => {
    const result = await validateMotionCardTsx(LIFECYCLE_CARD, {
      cues: [20, 50],
      checkRenderedLayout: false,
    });
    expect(result.render.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('9 个新原语与 TrendLine markers/fill 可编译渲染', async () => {
    const result = await validateMotionCardTsx(NEW_PRIMITIVES_CARD, {
      cues: [0, 24, 48],
      frames: [0, 24, 80],
      durationInFrames: 90,
      checkRenderedLayout: false,
    });
    expect(result.render.ok).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
  });

  it('满载横条在关键帧通过真实布局与字幕安全区探针', async () => {
    const result = await validateMotionCardTsx(MAX_LIST_LAYOUT_CARD, {
      cues: [0],
      frames: [0, 20, 89],
      durationInFrames: 90,
      checkRenderedLayout: true,
    });
    expect(result.render.ok).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
  }, 60_000);

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

describe('storyboard emphasis 映射', () => {
  const kit = createMotionKit({
    ...Remotion,
    useCurrentFrame: () => 16,
    useVideoConfig: () => ({ width: 1920, height: 1080, fps: 30, durationInFrames: 150 }),
  } as unknown as MotionKitRemotion);

  it('支持 countup-settle / slam / underline-sweep / brighten', () => {
    expect(kit.emphasize(16, 12, 30, 'countup-settle').transform).toContain('scale');
    expect(kit.emphasize(12, 12, 30, 'slam').transform).toContain('translateY');
    expect(kit.emphasize(18, 12, 30, 'underline-sweep').backgroundImage).toContain('linear-gradient');
    expect(kit.emphasize(16, 12, 30, 'brighten').filter).toContain('brightness');
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

  it('hand-sketch accent（红马克笔）对纸底与便利贴黄都达标，字色保持 accent、便利贴仍黄', () => {
    const html = renderCard(HAND_SKETCH.motionTokens);
    expect(html).toContain('color:#D0342C');
    expect(html).toContain('background:#FFD84D');
  });

  it('accent 对页面底达标但与 surface 面色撞色时，字色回落 ink', () => {
    const html = renderCard({
      palette: { bg: '#0E0E10', ink: '#ECE7DA', muted: '#8A8478', accent: '#FFD84D', track: 'rgba(236,231,218,0.12)' },
      fonts: { display: 'serif', body: 'sans-serif', mono: 'monospace' },
      surface: { kind: 'panel', bg: '#FFD84D' },
    });
    expect(html).not.toContain('color:#FFD84D');
    expect(html).toContain('color:#ECE7DA');
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

describe('新列表原语容量与确定性', () => {
  const makeKit = () => createMotionKit({
    ...Remotion,
    useCurrentFrame: () => 120,
    useVideoConfig: () => ({ width: 1920, height: 1080, fps: 30, durationInFrames: 150 }),
  } as unknown as MotionKitRemotion);
  const beat = { start: 0, p: 1, land: 12, done: true };

  it('RankList 截断到 5 项，且同帧输出稳定', () => {
    const kit = makeKit();
    const element = React.createElement(
      kit.CardStage,
      null,
      React.createElement(kit.RankList, {
        beat,
        items: Array.from({ length: 6 }, (_, index) => ({ label: `排名${index + 1}` })),
      }),
    );
    const first = renderToStaticMarkup(element);
    const second = renderToStaticMarkup(element);
    expect(first).toBe(second);
    expect(first).toContain('排名5');
    expect(first).not.toContain('排名6');
  });
});

describe('图表精细化原语（column/donut/pulse/scale/grid/table/section）', () => {
  const CHART_PRIMITIVES_CARD = `import { CardStage, useBeats, ColumnChart, DonutChart, MetricPulse, ScaleImpact, StatGrid, DataTable, SectionTitle } from '@lingji/motion-kit';
const TOKENS = {
  palette: { bg: '#0E0E10', ink: '#ECE7DA', muted: '#8A8478', accent: '#0A84FF', track: 'rgba(236,231,218,0.12)' },
  fonts: { display: 'Georgia, serif', body: 'sans-serif', mono: 'monospace' },
};
export default function Card({ cues = [] }) {
  const beats = useBeats(cues, [null, 0, 1]);
  return <CardStage tokens={TOKENS}><div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:16}}>
    <ColumnChart items={[{label:'图文',value:32},{label:'视频',value:68},{label:'直播',value:45}]} beat={beats[0]} focusIndex={1} />
    <DonutChart segments={[{label:'内容',value:55,display:'55%'},{label:'分发',value:30,display:'30%'}]} beat={beats[0]} focusIndex={0} centerLabel="占比" />
    <MetricPulse value={120} unit="万" label="涨粉" delta="+32%" beat={beats[0]} />
    <ScaleImpact value={3} max={100} unit="%" label="转化" reference={{value:38, label:'均值'}} beat={beats[0]} />
    <StatGrid items={[{value:'120万', label:'曝光'},{value:'3.1万', label:'完播'}]} beats={[beats[0], beats[1]]} />
    <DataTable columns={['平台','粉丝','单价']} rows={[['抖音','120万','¥18'], ['B站','45万','¥32']]} beat={beats[0]} focusRow={0} />
    <SectionTitle index="02" title="章节标题" subtitle="副题" beat={beats[0]} />
  </div></CardStage>;
}`;

  it('7 个图表原语可编译渲染（含多个拍点与末帧）', async () => {
    const result = await validateMotionCardTsx(CHART_PRIMITIVES_CARD, {
      cues: [0, 24, 48],
      frames: [0, 24, 60, 119],
      durationInFrames: 120,
      checkRenderedLayout: false,
    });
    expect(result.render.ok).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
  });

  const makeKit = () => createMotionKit({
    ...Remotion,
    useCurrentFrame: () => 120,
    useVideoConfig: () => ({ width: 1920, height: 1080, fps: 30, durationInFrames: 150 }),
  } as unknown as MotionKitRemotion);
  const beat = { start: 0, p: 1, land: 12, done: true };

  it('ColumnChart 截断到 6 柱且同帧输出稳定', () => {
    const kit = makeKit();
    const element = React.createElement(
      kit.CardStage,
      null,
      React.createElement(kit.ColumnChart, {
        beat,
        items: Array.from({ length: 8 }, (_, index) => ({ label: `柱${index + 1}`, value: index + 1 })),
      }),
    );
    const first = renderToStaticMarkup(element);
    expect(first).toBe(renderToStaticMarkup(element));
    expect(first).toContain('柱6');
    expect(first).not.toContain('柱7');
  });

  it('DonutChart 截断到 5 段且中心显示 focus 值', () => {
    const kit = makeKit();
    const element = React.createElement(
      kit.CardStage,
      null,
      React.createElement(kit.DonutChart, {
        beat,
        focusIndex: 0,
        segments: Array.from({ length: 7 }, (_, index) => ({ label: `段${index + 1}`, value: 10, display: `${index + 1}0%` })),
      }),
    );
    const first = renderToStaticMarkup(element);
    expect(first).toBe(renderToStaticMarkup(element));
    expect(first).toContain('段5');
    expect(first).not.toContain('段6');
  });

  it('DataTable 截断到 5 行且超宽列按前 4 列对齐', () => {
    const kit = makeKit();
    const element = React.createElement(
      kit.CardStage,
      null,
      React.createElement(kit.DataTable, {
        beat,
        columns: ['项目', '甲', '乙', '丙', '丁'],
        rows: Array.from({ length: 7 }, (_, index) => [`行${index + 1}`, '1', '2', '3', '4']),
      }),
    );
    const first = renderToStaticMarkup(element);
    expect(first).toBe(renderToStaticMarkup(element));
    expect(first).toContain('行5');
    expect(first).not.toContain('行6');
    expect(first).not.toContain('丁');
  });

  it('StatGrid 截断到 4 格且同帧输出稳定', () => {
    const kit = makeKit();
    const element = React.createElement(
      kit.CardStage,
      null,
      React.createElement(kit.StatGrid, {
        beat,
        items: Array.from({ length: 6 }, (_, index) => ({ value: `${index + 1}`, label: `指标${index + 1}` })),
      }),
    );
    const first = renderToStaticMarkup(element);
    expect(first).toBe(renderToStaticMarkup(element));
    expect(first).toContain('指标4');
    expect(first).not.toContain('指标5');
  });
});
