import { describe, expect, it } from 'vitest';
import { compileMotionCardFromStoryboard } from '../src/lib/motion-card-templates';
import { lintMotionCardTsx } from '../src/lib/motion-card-lint';
import { validateMotionCardTsx } from '../electron/remotion/smoke-render';
import { selectMotionCardProbeFrames } from '../src/lib/motion-keyframes';
import type { MotionStoryboard } from '../src/lib/motion-storyboard';
import type { TimingPlan } from '../src/types/motion';

const TOKENS_JSON = JSON.stringify({
  palette: { bg: '#0E0E10', ink: '#ECE7DA', muted: '#8A8478', accent: '#0A84FF' },
  fonts: { display: 'Georgia, serif', body: 'sans-serif', mono: 'monospace' },
});

const BEATS: MotionStoryboard['beats'] = [
  { cue: null, kind: 'build', adds: '标题入场', motion: '软落' },
  { cue: 1, kind: 'accent', adds: '核心内容落地', motion: '计数' },
  { cue: 2, kind: 'build', adds: '补充信息', motion: '淡入' },
];

function sb(partial: Partial<MotionStoryboard>): MotionStoryboard {
  return {
    claim: '新易盛中报预增',
    carrier: 'list-build',
    scene: '终态',
    focus: { beat: 1, emphasis: 'slam' },
    beats: BEATS,
    ...partial,
  };
}

function expectWellFormed(tsx: string) {
  const lint = lintMotionCardTsx(tsx, { requireSafeLayout: true });
  expect(lint.issues.filter((i) => i.severity === 'error')).toEqual([]);
  expect(lint.ok).toBe(true);
  expect(tsx).toContain('useTimingPlan(timingPlan, cues, [null,');
  expect(tsx).toContain('<SafeLayout');
  expect(tsx).toContain('tokens={TOKENS}');
  expect(tsx).toContain('export default function Card');
}

describe('compileMotionCardFromStoryboard（storyboard 确定性模板编译）', () => {
  it('data-hero：StatHero 直通 value/unit/label/max 与 emphasis', () => {
    const tsx = compileMotionCardFromStoryboard(
      sb({
        carrier: 'data-hero',
        layout: 'title-hero',
        data: { value: 43, unit: '%', label: '环比增速', max: 100 },
      }),
      TOKENS_JSON,
    );
    expectWellFormed(tsx);
    expect(tsx).toContain('<StatHero value={43} unit="%" label="环比增速" max={100}');
    expect(tsx).toContain('emphasis="slam"');
    expect(tsx).toContain('variant="title-hero"');
  });

  it('data-hero 变体：metric-pulse / ring-counter / scale-impact / stat-grid', () => {
    const pulse = compileMotionCardFromStoryboard(
      sb({ carrier: 'data-hero', data: { value: 28842, unit: '人', label: '硕士报名', variant: 'metric-pulse' } }),
      TOKENS_JSON,
    );
    expectWellFormed(pulse);
    expect(pulse).toContain('<MetricPulse value={28842}');

    const ring = compileMotionCardFromStoryboard(
      sb({ carrier: 'data-hero', data: { value: 72, max: 100, unit: '%', label: '完成率', variant: 'ring-counter' } }),
      TOKENS_JSON,
    );
    expectWellFormed(ring);
    expect(ring).toContain('<RingCounter value={72} max={100}');

    const scale = compileMotionCardFromStoryboard(
      sb({ carrier: 'data-hero', data: { value: 3, max: 100, unit: '%', label: '付费转化', variant: 'scale-impact' } }),
      TOKENS_JSON,
    );
    expectWellFormed(scale);
    expect(scale).toContain('<ScaleImpact value={3} max={100}');

    const grid = compileMotionCardFromStoryboard(
      sb({
        carrier: 'data-hero',
        data: { variant: 'stat-grid', items: [{ value: '120万', label: '曝光' }, { value: '3.1万', label: '完播' }] },
        beats: [BEATS[0], BEATS[1], BEATS[2]],
      }),
      TOKENS_JSON,
    );
    expectWellFormed(grid);
    expect(grid).toContain('<StatGrid');
    expect(grid).toContain('{ value: "120万", label: "曝光" }');
  });

  it('comparison：left/right → CompareRow；items → ColumnChart', () => {
    const row = compileMotionCardFromStoryboard(
      sb({
        carrier: 'comparison',
        layout: 'split-compare',
        data: { left: { label: '新易盛', value: '43%' }, right: { label: '天孚通信', value: '40%' } },
      }),
      TOKENS_JSON,
    );
    expectWellFormed(row);
    expect(row).toContain('<CompareRow left={{ label: "新易盛", value: "43%" }} right={{ label: "天孚通信", value: "40%" }}');
    expect(row).toContain('variant="split-compare"');

    const column = compileMotionCardFromStoryboard(
      sb({
        carrier: 'comparison',
        data: { variant: 'column', items: [{ label: '新易盛', value: 43 }, { label: '天孚', value: 40 }, { label: '中际旭创', value: 38 }] },
      }),
      TOKENS_JSON,
    );
    expectWellFormed(column);
    expect(column).toContain('<ColumnChart');
  });

  it('comparison 变体：horizontal-bars → HorizontalBars，bar → BarChart', () => {
    const items = [{ label: '新易盛', value: 43 }, { label: '天孚', value: 40 }, { label: '中际旭创', value: 38 }];
    const bars = compileMotionCardFromStoryboard(
      sb({ carrier: 'comparison', data: { variant: 'horizontal-bars', items } }),
      TOKENS_JSON,
    );
    expectWellFormed(bars);
    expect(bars).toContain('<HorizontalBars items={[{ label: "新易盛", value: 43 }, { label: "天孚", value: 40 }, { label: "中际旭创", value: 38 }]}');

    const bar = compileMotionCardFromStoryboard(
      sb({ carrier: 'comparison', data: { variant: 'bar', items } }),
      TOKENS_JSON,
    );
    expectWellFormed(bar);
    expect(bar).toContain('<BarChart items=');
  });

  it('table：columns/rows → DataTable；无 data 降级 ListBuild', () => {
    const table = compileMotionCardFromStoryboard(
      sb({
        carrier: 'table',
        data: { columns: ['公司', '增速'], rows: [['新易盛', '43%'], ['天孚通信', '40%']] },
      }),
      TOKENS_JSON,
    );
    expectWellFormed(table);
    expect(table).toContain('<DataTable columns={["公司", "增速"]} rows={[["新易盛", "43%"], ["天孚通信", "40%"]]}');

    const degraded = compileMotionCardFromStoryboard(sb({ carrier: 'table' }), TOKENS_JSON);
    expectWellFormed(degraded);
    expect(degraded).toContain('<ListBuild');
  });

  it('trend：points/labels/markers → TrendLine', () => {
    const tsx = compileMotionCardFromStoryboard(
      sb({
        carrier: 'trend',
        data: { points: [12, 18, 41], startLabel: '2023', endLabel: '2025', markers: [{ index: 2, label: '拐点' }] },
      }),
      TOKENS_JSON,
    );
    expectWellFormed(tsx);
    expect(tsx).toContain('<TrendLine points={[12, 18, 41]} startLabel="2023" endLabel="2025" markers={[{ index: 2, label: "拐点" }]} fill');
  });

  it('list-build：默认 ListBuild；rank/check 变体；逐项 beats 对齐', () => {
    const fourBeats: MotionStoryboard['beats'] = [
      { cue: null, kind: 'build', adds: '标题' },
      { cue: 0, kind: 'build', adds: '要点一' },
      { cue: 1, kind: 'build', adds: '要点二' },
      { cue: 2, kind: 'build', adds: '要点三' },
    ];
    const list = compileMotionCardFromStoryboard(
      sb({ carrier: 'list-build', beats: fourBeats, data: { items: ['要点一', '要点二', '要点三'] } }),
      TOKENS_JSON,
    );
    expectWellFormed(list);
    expect(list).toContain('<ListBuild items={["要点一", "要点二", "要点三"]} beats={[beats[1], beats[2], beats[3]]}');

    const rank = compileMotionCardFromStoryboard(
      sb({ carrier: 'list-build', data: { items: ['第一名', '第二名'], variant: 'rank' } }),
      TOKENS_JSON,
    );
    expectWellFormed(rank);
    expect(rank).toContain('<RankList items={[{ label: "第一名" }, { label: "第二名" }]}');

    const check = compileMotionCardFromStoryboard(
      sb({ carrier: 'list-build', data: { items: ['已确认', '已同步'], variant: 'check' } }),
      TOKENS_JSON,
    );
    expectWellFormed(check);
    expect(check).toContain('<ChecklistPop');
  });

  it('process：ProcessFlow / cause 变体 CauseChain', () => {
    const flow = compileMotionCardFromStoryboard(
      sb({ carrier: 'process', data: { steps: ['报名', '初试', '复试'] } }),
      TOKENS_JSON,
    );
    expectWellFormed(flow);
    expect(flow).toContain('<ProcessFlow steps={["报名", "初试", "复试"]}');

    const cause = compileMotionCardFromStoryboard(
      sb({ carrier: 'process', data: { steps: ['原因', '机制', '结果'], variant: 'cause' } }),
      TOKENS_JSON,
    );
    expectWellFormed(cause);
    expect(cause).toContain('<CauseChain');
  });

  it('quote：QuoteBlock 带出处；single-focus 不生成 header 槽', () => {
    const tsx = compileMotionCardFromStoryboard(
      sb({ carrier: 'quote', data: { text: '光模块是最大的确定性', source: '纪要' } }),
      TOKENS_JSON,
    );
    expectWellFormed(tsx);
    expect(tsx).toContain('<QuoteBlock text="光模块是最大的确定性" source="纪要"');
    expect(tsx).toContain('variant="single-focus"');
    expect(tsx).not.toContain('<MotionSlot name="header"');
  });

  it('quote citation 变体 → CitationCard（text/source/date 直通）', () => {
    const tsx = compileMotionCardFromStoryboard(
      sb({ carrier: 'quote', data: { variant: 'citation', text: '市场规模突破2800亿元', source: '艾瑞咨询', date: '2024.12' } }),
      TOKENS_JSON,
    );
    expectWellFormed(tsx);
    expect(tsx).toContain('<CitationCard text="市场规模突破2800亿元" source="艾瑞咨询" date="2024.12"');
  });

  it('quote word-pop 变体 → WordPop 逐词弹入（words 直通，source 编译为出处行）', () => {
    const tsx = compileMotionCardFromStoryboard(
      sb({ carrier: 'quote', data: { variant: 'word-pop', text: '光模块是最大的确定性', source: '纪要', words: ['光模块', '是', '最大的', '确定性'] } }),
      TOKENS_JSON,
    );
    expectWellFormed(tsx);
    expect(tsx).toContain('<WordPop words={["光模块", "是", "最大的", "确定性"]} font="display" size={0.075} weight={520} beat={beats[1]} emphasis="slam" />');
    expect(tsx).toContain('<Kicker text="—— 纪要" beat={beats[1]} accent={false} />');
    expect(tsx).not.toContain('<QuoteBlock');

    const noSource = compileMotionCardFromStoryboard(
      sb({ carrier: 'quote', data: { variant: 'word-pop', text: '趋势奖励最懂的人', words: ['趋势', '奖励', '最懂的人'] } }),
      TOKENS_JSON,
    );
    expectWellFormed(noSource);
    expect(noSource).toContain('<WordPop words={["趋势", "奖励", "最懂的人"]}');
    expect(noSource).not.toContain('——');

    // words 不足 2 块时回落 QuoteBlock（确定性旧行为）
    const degraded = compileMotionCardFromStoryboard(
      sb({ carrier: 'quote', data: { variant: 'word-pop', text: '趋势奖励最懂的人', words: ['一整句'] } }),
      TOKENS_JSON,
    );
    expectWellFormed(degraded);
    expect(degraded).toContain('<QuoteBlock text="趋势奖励最懂的人"');
  });

  it('concept typewriter 变体 → TypewriterText（term 打字机 + definition 副行淡入）', () => {
    const tsx = compileMotionCardFromStoryboard(
      sb({ carrier: 'concept', data: { variant: 'typewriter', term: '环比增速', definition: '相对上一个统计周期的增长比例' } }),
      TOKENS_JSON,
    );
    expectWellFormed(tsx);
    expect(tsx).toContain('<TypewriterText text="环比增速" font="display" size={0.09} weight={650} detail="相对上一个统计周期的增长比例" beat={beats[1]} emphasis="slam" />');
    expect(tsx).not.toContain('<ConceptCard');
  });

  it('list-build keyword-scan 变体 → ListBuild 带条内关键词配对（空串跳过）', () => {
    const tsx = compileMotionCardFromStoryboard(
      sb({ carrier: 'list-build', data: { items: ['需求爆发', '订单饱满'], variant: 'keyword-scan', keywords: ['爆发', ''] } }),
      TOKENS_JSON,
    );
    expectWellFormed(tsx);
    expect(tsx).toContain('<ListBuild items={["需求爆发", "订单饱满"]} keywords={["爆发", ""]} beats={[beats[1], beats[2]]} focusIndex={0} emphasis="slam" />');

    // keywords 全缺省时退化为普通 ListBuild（无 keywords 属性）
    const degraded = compileMotionCardFromStoryboard(
      sb({ carrier: 'list-build', data: { items: ['需求爆发'], variant: 'keyword-scan' } }),
      TOKENS_JSON,
    );
    expectWellFormed(degraded);
    expect(degraded).toContain('<ListBuild items={["需求爆发"]}');
    expect(degraded).not.toContain('keywords=');
  });

  it('emphasis=underline-sweep 编译为独立 UnderlineSweep 原语，主原语不再重复下划线', () => {
    const tsx = compileMotionCardFromStoryboard(
      sb({ carrier: 'quote', focus: { beat: 1, emphasis: 'underline-sweep' }, data: { text: '趋势奖励最懂的人', source: '口播' } }),
      TOKENS_JSON,
    );
    expectWellFormed(tsx);
    expect(tsx).toContain('<UnderlineSweep beat={beats[1]} />');
    expect(tsx).toMatch(/import \{[^}]*UnderlineSweep[^}]*\} from '@lingji\/motion-kit'/);
    expect(tsx).not.toContain('emphasis="underline-sweep"');
  });

  it('分镜 lifecycle 编译进 MotionSlot：主槽 enter/update/exit、header collapse/exit', () => {
    const tsx = compileMotionCardFromStoryboard(
      sb({
        carrier: 'list-build',
        elements: [
          { id: 'title', role: 'support', slot: 'header', content: '标题', heightRatio: 0.1 },
          { id: 'points', role: 'focus', slot: 'main', content: '要点', heightRatio: 0.4 },
        ],
        beats: [
          { cue: null, kind: 'build', adds: '标题入场', lifecycle: { enter: ['title'] } },
          { cue: 0, kind: 'build', adds: '要点一', lifecycle: { enter: ['points'], collapse: ['title'] } },
          { cue: 1, kind: 'accent', adds: '要点更新', lifecycle: { update: ['points'], exit: ['title'] } },
          { cue: 2, kind: 'build', adds: '收尾', lifecycle: { exit: ['points'] } },
        ],
        focus: { beat: 1, emphasis: 'slam' },
        data: { items: ['要点一', '要点更新', '收尾'] },
      }),
      TOKENS_JSON,
    );
    expectWellFormed(tsx);
    expect(tsx).toContain('<MotionSlot name="main" role="focus" lifecycle={{ enter: beats[1], update: beats[2], exit: beats[3] }}>');
    expect(tsx).toContain('<MotionSlot name="header" role="support" lifecycle={{ enter: beats[0], collapse: beats[1], exit: beats[2] }}>');
  });

  it('未声明 lifecycle 时保持旧行为：header 在 focus 拍 collapse，主槽仅 enter', () => {
    const tsx = compileMotionCardFromStoryboard(
      sb({ carrier: 'list-build', data: { items: ['要点一', '要点二'] } }),
      TOKENS_JSON,
    );
    expectWellFormed(tsx);
    expect(tsx).toContain('<MotionSlot name="header" role="support" lifecycle={{ enter: beats[0], collapse: beats[1] }}>');
    expect(tsx).toContain('<MotionSlot name="main" role="focus" lifecycle={{ enter: beats[1] }}>');
  });

  it('concept：ConceptCard / section 变体 SectionTitle', () => {
    const card = compileMotionCardFromStoryboard(
      sb({ carrier: 'concept', data: { term: '环比增速', definition: '相对上一个统计周期的增长比例' } }),
      TOKENS_JSON,
    );
    expectWellFormed(card);
    expect(card).toContain('<ConceptCard term="环比增速" definition="相对上一个统计周期的增长比例"');

    const section = compileMotionCardFromStoryboard(
      sb({ carrier: 'concept', data: { variant: 'section', index: '02', title: '业绩拆解', subtitle: '中报' } }),
      TOKENS_JSON,
    );
    expectWellFormed(section);
    expect(section).toContain('<SectionTitle index="02" title="业绩拆解" subtitle="中报"');
  });

  it('concept anchor 变体 → WordPop 关键词锚点（corner-anchor 布局、无 header、0.04H 小字）', () => {
    const single = compileMotionCardFromStoryboard(
      sb({ carrier: 'concept', data: { variant: 'anchor', term: '光模块' } }),
      TOKENS_JSON,
    );
    expectWellFormed(single);
    expect(single).toContain('variant="corner-anchor"');
    expect(single).toContain('<WordPop words={["光模块"]} font="display" size={0.04} weight={600} beat={beats[1]} emphasis="slam" />');
    expect(single).not.toContain('name="header"');
    expect(single).not.toContain('<ConceptCard');

    const multi = compileMotionCardFromStoryboard(
      sb({ carrier: 'concept', data: { variant: 'anchor', keywords: ['算力', '光模块', '订单'] } }),
      TOKENS_JSON,
    );
    expectWellFormed(multi);
    expect(multi).toContain('<WordPop words={["算力", "光模块", "订单"]}');
    expect(multi).toContain('variant="corner-anchor"');

    // 导演显式声明其它 layout 也被编译器强制为 corner-anchor（不抢主视觉是确定性保证）
    const forced = compileMotionCardFromStoryboard(
      sb({ carrier: 'concept', layout: 'single-focus', data: { variant: 'anchor', term: '光模块' } }),
      TOKENS_JSON,
    );
    expect(forced).toContain('variant="corner-anchor"');
    // 无 variant 的旧行为不变：concept 仍编译 ConceptCard + single-focus
    const legacy = compileMotionCardFromStoryboard(
      sb({ carrier: 'concept', data: { term: '环比增速', definition: '相对上一个统计周期的增长比例' } }),
      TOKENS_JSON,
    );
    expect(legacy).toContain('variant="single-focus"');
    expect(legacy).toContain('<ConceptCard');
  });

  it('timeline / matrix / funnel / network / before-after / stacked-composition', () => {
    const timeline = compileMotionCardFromStoryboard(
      sb({ carrier: 'timeline', data: { items: ['2019 起步', '2022 爆发', '2024 分化'] } }),
      TOKENS_JSON,
    );
    expectWellFormed(timeline);
    expect(timeline).toContain('<TimelineRail items={["2019 起步", "2022 爆发", "2024 分化"]}');

    const matrix = compileMotionCardFromStoryboard(
      sb({
        carrier: 'matrix',
        data: { items: [{ label: '优先做', x: 78, y: 72, focus: true }, { label: '暂缓', x: 28, y: 36 }], xLabel: '价值', yLabel: '难度' },
      }),
      TOKENS_JSON,
    );
    expectWellFormed(matrix);
    expect(matrix).toContain('<MatrixQuadrant xLabel="价值" yLabel="难度"');
    expect(matrix).toContain('focus: true');

    const funnel = compileMotionCardFromStoryboard(
      sb({ carrier: 'funnel', data: { steps: [{ label: '触达', value: '10万' }, { label: '转化', value: '1.2万' }] } }),
      TOKENS_JSON,
    );
    expectWellFormed(funnel);
    expect(funnel).toContain('<FunnelStack steps={[{ label: "触达", value: "10万" }, { label: "转化", value: "1.2万" }]}');

    const network = compileMotionCardFromStoryboard(
      sb({ carrier: 'network', data: { nodes: ['平台', '创作者', '观众'], links: [[0, 1], [1, 2]] } }),
      TOKENS_JSON,
    );
    expectWellFormed(network);
    expect(network).toContain('<NetworkMap nodes={["平台", "创作者", "观众"]} links={[[0,1], [1,2]]}');

    const beforeAfter = compileMotionCardFromStoryboard(
      sb({ carrier: 'before-after', data: { before: '旧流程慢', after: '新流程快' } }),
      TOKENS_JSON,
    );
    expectWellFormed(beforeAfter);
    expect(beforeAfter).toContain('<BeforeAfter before="旧流程慢" after="新流程快"');

    const mythFact = compileMotionCardFromStoryboard(
      sb({ carrier: 'before-after', data: { before: '常见误区', after: '真实结论', variant: 'myth-fact' } }),
      TOKENS_JSON,
    );
    expectWellFormed(mythFact);
    expect(mythFact).toContain('<MythFactSwap myth="常见误区" fact="真实结论"');

    const stacked = compileMotionCardFromStoryboard(
      sb({ carrier: 'stacked-composition', data: { items: [{ label: '内容', value: 55, display: '55%' }, { label: '分发', value: 30, display: '30%' }] } }),
      TOKENS_JSON,
    );
    expectWellFormed(stacked);
    expect(stacked).toContain('<StackedComposition');

    const donut = compileMotionCardFromStoryboard(
      sb({ carrier: 'stacked-composition', data: { variant: 'donut', items: [{ label: '内容', value: 55 }, { label: '分发', value: 30 }] } }),
      TOKENS_JSON,
    );
    expectWellFormed(donut);
    expect(donut).toContain('<DonutChart segments=');
  });

  it('无 data 时从 beats 提取：data-hero 提数字、list-build 提文案', () => {
    const hero = compileMotionCardFromStoryboard(
      sb({
        carrier: 'data-hero',
        beats: [
          { cue: null, kind: 'build', adds: '标题「考研报名」' },
          { cue: 1, kind: 'build', adds: '数字 28842 人' },
        ],
      }),
      TOKENS_JSON,
    );
    expectWellFormed(hero);
    expect(hero).toContain('<StatHero value={28842} unit="人"');

    const list = compileMotionCardFromStoryboard(
      sb({
        carrier: 'list-build',
        data: undefined,
        beats: [
          { cue: null, kind: 'build', adds: '标题：光模块' },
          { cue: 0, kind: 'build', adds: '需求爆发' },
          { cue: 1, kind: 'build', adds: '订单饱满' },
        ],
      }),
      TOKENS_JSON,
    );
    expectWellFormed(list);
    expect(list).toContain('<ListBuild items={["需求爆发", "订单饱满"]}');
  });

  it('编译产物通过真实编译 + 布局探针（含字幕安全区）', async () => {
    const samples: MotionStoryboard[] = [
      sb({ carrier: 'data-hero', layout: 'title-hero', data: { value: 28842, unit: '人', label: '硕士报名', max: 40000 } }),
      sb({
        carrier: 'list-build',
        data: { items: ['需求爆发', '订单饱满', '产能爬坡'] },
        beats: [
          { cue: null, kind: 'build', adds: '标题：光模块' },
          { cue: 0, kind: 'build', adds: '需求爆发' },
          { cue: 1, kind: 'build', adds: '订单饱满' },
          { cue: 2, kind: 'build', adds: '产能爬坡' },
        ],
      }),
      sb({ carrier: 'quote', data: { text: '光模块是最大的确定性', source: '纪要' } }),
      // lifecycle 全接线（主槽 update/exit、header collapse/exit）
      sb({
        carrier: 'list-build',
        elements: [
          { id: 'title', role: 'support', slot: 'header', content: '标题', heightRatio: 0.1 },
          { id: 'points', role: 'focus', slot: 'main', content: '要点', heightRatio: 0.4 },
        ],
        beats: [
          { cue: null, kind: 'build', adds: '标题入场', lifecycle: { enter: ['title'] } },
          { cue: 0, kind: 'build', adds: '要点一', lifecycle: { enter: ['points'], collapse: ['title'] } },
          { cue: 1, kind: 'accent', adds: '要点更新', lifecycle: { update: ['points'], exit: ['title'] } },
          { cue: 2, kind: 'build', adds: '收尾', lifecycle: { exit: ['points'] } },
        ],
        data: { items: ['要点一', '要点更新', '收尾'] },
      }),
      // 幽灵原语接线：horizontal-bars / citation / UnderlineSweep
      sb({ carrier: 'comparison', data: { variant: 'horizontal-bars', items: [{ label: '新易盛', value: 43 }, { label: '天孚', value: 40 }] } }),
      sb({ carrier: 'quote', data: { variant: 'citation', text: '市场规模突破2800亿元', source: '艾瑞咨询', date: '2024.12' } }),
      sb({ carrier: 'quote', focus: { beat: 1, emphasis: 'underline-sweep' }, data: { text: '趋势奖励最懂的人', source: '口播' } }),
      // kinetic typography 接线：word-pop / typewriter / keyword-scan
      sb({ carrier: 'quote', data: { variant: 'word-pop', text: '光模块是最大的确定性', source: '纪要', words: ['光模块', '是', '最大的', '确定性'] } }),
      sb({ carrier: 'concept', data: { variant: 'typewriter', term: '环比增速', definition: '相对上一个统计周期的增长比例' } }),
      sb({ carrier: 'list-build', data: { items: ['需求爆发', '订单饱满'], variant: 'keyword-scan', keywords: ['爆发', '饱满'] } }),
      // 关键词锚点卡：corner-anchor 角落小字（term 单关键词 / keywords 多关键词）
      sb({ carrier: 'concept', data: { variant: 'anchor', term: '光模块' } }),
      sb({ carrier: 'concept', data: { variant: 'anchor', keywords: ['算力', '光模块', '订单'] } }),
      // asset-led 大图小字：素材通栏左格 + 右列 kicker/单行注（asset 占位格由 overlay 素材层填图）
      sb({
        carrier: 'data-hero',
        layout: 'asset-led',
        elements: [
          { id: 'kicker', role: 'support', slot: 'header', content: '报名', heightRatio: 0.1 },
          { id: 'note', role: 'focus', slot: 'main', content: '报名 28842 人', heightRatio: 0.12 },
          { id: 'prop', role: 'asset', slot: 'asset', content: '旧档案袋', heightRatio: 0.6, assetSlot: 'archive_prop' },
        ],
        assets: [
          {
            slot: 'archive_prop',
            query: '旧档案袋',
            role: 'object',
            importance: 'primary',
            reusePolicy: 'generate-if-missing',
            visualTreatment: 'editorial-realist-cutout',
          },
        ],
        beats: [
          { cue: null, kind: 'build', adds: '标题入场', lifecycle: { enter: ['kicker'] } },
          { cue: 1, kind: 'build', adds: '数字落地', lifecycle: { enter: ['note', 'prop'], collapse: ['kicker'] } },
        ],
        data: { value: 28842, unit: '人', label: '硕士报名' },
      }),
      // 叙事运镜 + 指示标注：标注层不得越出内容盒，运镜不得把内容推出画布
      sb({
        carrier: 'data-hero',
        layout: 'title-hero',
        data: { value: 28842, unit: '人', label: '硕士报名', max: 40000 },
        camera: [{ beat: 1, move: 'focus', target: 'main' }],
        annotate: [{ beat: 1, kind: 'circle', target: 'main' }],
      }),
      sb({
        carrier: 'trend',
        layout: 'chart-with-kicker',
        data: { points: [12, 18, 41], startLabel: '2023', endLabel: '2025' },
        camera: [{ beat: 1, move: 'push-in', target: 'main' }, { beat: 2, move: 'pull-out' }],
        annotate: [{ beat: 2, kind: 'arrow', target: 'main', side: 'right' }],
      }),
      sb({
        carrier: 'quote',
        data: { text: '趋势奖励最懂的人', source: '口播' },
        annotate: [{ beat: 1, kind: 'spotlight', target: 'main' }],
      }),
      sb({
        carrier: 'list-build',
        data: { items: ['需求爆发', '订单饱满'] },
        annotate: [
          { beat: 1, kind: 'box', target: 'main' },
          { beat: 0, kind: 'highlight', target: 'header' },
        ],
      }),
    ];
    for (const sample of samples) {
      const tsx = compileMotionCardFromStoryboard(sample, TOKENS_JSON);
      const result = await validateMotionCardTsx(tsx, { cues: [0, 96, 228, 354], checkRenderedLayout: true });
      expect(result.render.ok).toBe(true);
      expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    }
  }, 180_000);

  it('叙事运镜：camera 编译为 CardStage shots，layout 与 SafeLayout 同源', () => {
    const tsx = compileMotionCardFromStoryboard(
      sb({
        carrier: 'data-hero',
        layout: 'title-hero',
        data: { value: 43, unit: '%', label: '环比增速' },
        camera: [{ beat: 1, move: 'focus', target: 'main' }],
      }),
      TOKENS_JSON,
    );
    expectWellFormed(tsx);
    expect(tsx).toContain('layout="title-hero" shots={[{ beat: beats[1], move: "focus", target: "main" }]}');
    expect(tsx).toContain('variant="title-hero"');
  });

  it('指示标注：annotate 裹住目标槽位内容并引入 Annotate', () => {
    const tsx = compileMotionCardFromStoryboard(
      sb({
        carrier: 'data-hero',
        layout: 'title-hero',
        data: { value: 43, unit: '%', label: '环比增速' },
        annotate: [
          { beat: 1, kind: 'arrow', target: 'main', side: 'right' },
          { beat: 0, kind: 'underline', target: 'header' },
        ],
      }),
      TOKENS_JSON,
    );
    expectWellFormed(tsx);
    expect(tsx).toContain("import { CardStage, SafeLayout, MotionSlot, useTimingPlan, Kicker, Annotate");
    expect(tsx).toContain('<Annotate kind="arrow" beat={beats[1]} side="right">');
    expect(tsx).toContain('<Annotate kind="underline" beat={beats[0]}>');
    expect(tsx).toContain('</Annotate>');
  });

  it('autoEmphasisMotion=false 时回到纯载体形态（A/B 对照组）', () => {
    const tsx = compileMotionCardFromStoryboard(
      sb({ carrier: 'data-hero', layout: 'title-hero', data: { value: 43, unit: '%' } }),
      TOKENS_JSON,
      { autoEmphasisMotion: false },
    );
    expect(tsx).toContain('<CardStage tokens={TOKENS}>');
    expect(tsx).not.toContain('Annotate');
    expect(tsx).not.toContain('shots=');
  });

  it('默认自动补运镜与标注：焦点拍推近 + 收束拍拉开，单焦点载体圈出焦点', () => {
    const hero = compileMotionCardFromStoryboard(
      sb({ carrier: 'data-hero', layout: 'title-hero', data: { value: 43, unit: '%' } }),
      TOKENS_JSON,
    );
    expectWellFormed(hero);
    expect(hero).toContain("shots={[{ beat: beats[1], move: \"push-in\", target: \"main\" }, { beat: beats[2], move: \"pull-out\" }]}");
    expect(hero).toContain('<Annotate kind="box" beat={beats[1]}>');

    // 金句用底线（聚光灯在近黑底上不可见，A/B 实拍确认）
    const quote = compileMotionCardFromStoryboard(
      sb({ carrier: 'quote', data: { text: '趋势奖励最懂的人', source: '口播' } }),
      TOKENS_JSON,
    );
    expect(quote).toContain('<Annotate kind="underline"');

    // stat-grid 是多项网格，圈选会套住整片并穿字——不自动标注
    const grid = compileMotionCardFromStoryboard(
      sb({ carrier: 'data-hero', data: { variant: 'stat-grid', items: [{ value: '120万', label: '曝光' }, { value: '3.1万', label: '完播' }] } }),
      TOKENS_JSON,
    );
    expect(grid).not.toContain('Annotate');

    // glass / panel 预设不叠框，退回底线（仍然指得清楚，且不产生双边框）
    const panel = compileMotionCardFromStoryboard(
      sb({ carrier: 'data-hero', layout: 'title-hero', data: { value: 43, unit: '%' } }),
      JSON.stringify({ palette: { bg: '#111', ink: '#fff', muted: '#999', accent: '#08f' }, surface: { kind: 'glass' } }),
    );
    expect(panel).toContain('<Annotate kind="underline"');

    // 多项载体自身有 focusIndex 高亮，不叠加标注（但仍有运镜）
    const list = compileMotionCardFromStoryboard(
      sb({ carrier: 'list-build', data: { items: ['要点一', '要点二'] } }),
      TOKENS_JSON,
    );
    expect(list).not.toContain('Annotate');
    expect(list).toContain('shots=');

    // 分镜显式声明时以声明为准，不叠加系统默认
    const declared = compileMotionCardFromStoryboard(
      sb({
        carrier: 'data-hero',
        layout: 'title-hero',
        data: { value: 43, unit: '%' },
        annotate: [{ beat: 2, kind: 'circle', target: 'main' }],
      }),
      TOKENS_JSON,
    );
    expect(declared).toContain('<Annotate kind="circle" beat={beats[2]}>');
    expect(declared).not.toContain('kind="box"');

    // 角落锚点卡与 section 章节卡保持克制留白，不加标注
    const anchor = compileMotionCardFromStoryboard(
      sb({ carrier: 'concept', data: { variant: 'anchor', term: '光模块' } }),
      TOKENS_JSON,
    );
    expect(anchor).not.toContain('Annotate');
  });

  it('concept 卡 slam 落定弹簧瞬态不再误报 semantic-occlusion（真实故障回归）', async () => {
    // 真实故障（2026-07-23 seg-24「动力电池行业」/ seg-52「耐用消费品」）：
    // concept 卡 term+definition → ConceptCard，focus emphasis=slam 且首句字幕 cue 贴段首
    // （land≈0）。探针在 land / land+2 采样时，slam 弹簧（translateY(-14px) scale(1.12)）
    // 把折成两行的大标题盒顶进上方 CONCEPT 标签（重叠 18.1%），误判遮挡回退卡；
    // 落定后静态间距约 19px 并无重叠——瞬态交叠应降级 warning，不再阻断。
    const timingPlan: TimingPlan = {
      fps: 30,
      cues: [0, 60],
      pauses: [],
      accents: [],
      beats: [{ storyboardBeatIndex: 0, role: 'emphasis', startFrame: 0, landFrame: 0 }],
    };
    const samples: MotionStoryboard[] = [
      sb({
        carrier: 'concept',
        focus: { beat: 0, emphasis: 'slam' },
        beats: [{ cue: 0, kind: 'build', adds: '概念入场' }],
        data: { term: '动力电池行业', definition: '以动力电池为核心产品的上下游产业集合' },
      }),
      sb({
        carrier: 'concept',
        focus: { beat: 0, emphasis: 'slam' },
        beats: [{ cue: 0, kind: 'build', adds: '概念入场' }],
        data: { term: '耐用消费品', definition: '使用周期较长、重复购买频率低的商品类别' },
      }),
      // typewriter / section 变体 + slam 同场景兜底：均不得报 error。
      sb({
        carrier: 'concept',
        focus: { beat: 0, emphasis: 'slam' },
        beats: [{ cue: 0, kind: 'build', adds: '概念入场' }],
        data: { variant: 'typewriter', term: '动力电池行业', definition: '以动力电池为核心产品的上下游产业集合' },
      }),
      sb({
        carrier: 'concept',
        focus: { beat: 0, emphasis: 'slam' },
        beats: [{ cue: 0, kind: 'build', adds: '概念入场' }],
        data: { variant: 'section', index: '02', title: '动力电池行业', subtitle: '产业链拆解' },
      }),
    ];
    for (const sample of samples) {
      const tsx = compileMotionCardFromStoryboard(sample, TOKENS_JSON);
      const frames = selectMotionCardProbeFrames({
        storyboard: sample,
        durationInFrames: 120,
        cues: timingPlan.cues,
        timingPlan,
      });
      const result = await validateMotionCardTsx(tsx, {
        cues: timingPlan.cues,
        timingPlan,
        frames,
        durationInFrames: 120,
        checkRenderedLayout: true,
      });
      expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(result.ok).toBe(true);
    }
  }, 120_000);

  it('重音吸附回归：骨架只经 useTimingPlan 间接引用 beats，帧/重音数据不内联进产物', () => {
    // 音画重音吸附发生在 buildTimingPlan（运行时注入的 timingPlan），
    // 模板编译产物必须保持"beats[N] 间接引用"契约：有无 accents 数据，产物逐字节一致。
    const storyboard = sb({
      carrier: 'data-hero',
      layout: 'title-hero',
      data: { value: 43, unit: '%', label: '环比增速', max: 100 },
    });
    const first = compileMotionCardFromStoryboard(storyboard, TOKENS_JSON);
    const second = compileMotionCardFromStoryboard(storyboard, TOKENS_JSON);
    expectWellFormed(first);
    expect(first).toBe(second);
    expect(first).not.toContain('accents');
    expect(first).not.toContain('landFrame');
    expect(first).not.toContain('snap');
  });
});

describe('asset 槽编译（素材由 overlay 素材层渲染，TSX 只保留占位格）', () => {
  const ASSET_ELEMENTS: MotionStoryboard['elements'] = [
    { id: 'kicker', role: 'support', slot: 'header', content: '报名', heightRatio: 0.1 },
    { id: 'hero', role: 'focus', slot: 'main', content: '28842 人', heightRatio: 0.35 },
    { id: 'prop', role: 'asset', slot: 'asset', content: '旧档案袋', heightRatio: 0.25, assetSlot: 'archive_prop' },
  ];
  const ASSETS: MotionStoryboard['assets'] = [
    {
      slot: 'archive_prop',
      query: '旧档案袋',
      role: 'object',
      importance: 'primary',
      reusePolicy: 'generate-if-missing',
      visualTreatment: 'editorial-realist-cutout',
      placementHint: '右侧',
    },
  ];
  const ASSET_BEATS: MotionStoryboard['beats'] = [
    { cue: null, kind: 'build', adds: '标题入场', lifecycle: { enter: ['kicker'] } },
    { cue: 1, kind: 'build', adds: '数字落地', lifecycle: { enter: ['hero', 'prop'], collapse: ['kicker'] } },
  ];
  const assetSb = (layout: MotionStoryboard['layout']) =>
    sb({
      carrier: 'data-hero',
      layout,
      elements: ASSET_ELEMENTS,
      assets: ASSETS,
      beats: ASSET_BEATS,
      data: { value: 28842, unit: '人', label: '硕士报名' },
    });

  it('assetsResolved=true：asset-aside 保留并补发 asset 占位格（生命周期随分镜 enter 拍）', () => {
    const tsx = compileMotionCardFromStoryboard(assetSb('asset-aside'), TOKENS_JSON, { assetsResolved: true });
    expectWellFormed(tsx);
    expect(tsx).toContain('variant="asset-aside"');
    expect(tsx).toContain('<MotionSlot name="asset" role="asset" lifecycle={{ enter: beats[1] }} />');
    // 主内容仍编译在主槽（素材不进 TSX，由 overlay 按 binding 渲染）
    expect(tsx).toContain('<StatHero value={28842}');
  });

  it('assetsResolved=false（素材物化失败）：asset-aside 退回载体默认布局，不留死空格', () => {
    const tsx = compileMotionCardFromStoryboard(assetSb('asset-aside'), TOKENS_JSON, { assetsResolved: false });
    expectWellFormed(tsx);
    // data-hero 载体默认布局 title-hero；卡片仍是完整纯文字卡
    expect(tsx).toContain('variant="title-hero"');
    expect(tsx).not.toContain('name="asset"');
    expect(tsx).toContain('<StatHero value={28842}');
  });

  it('缺省 opts：完全按分镜 layout 编译（旧行为回归，asset-aside 保留）', () => {
    const tsx = compileMotionCardFromStoryboard(assetSb('asset-aside'), TOKENS_JSON);
    expectWellFormed(tsx);
    expect(tsx).toContain('variant="asset-aside"');
    expect(tsx).toContain('name="asset"');
  });

  it('无 assets 回归：非 asset-aside 布局永不发 asset 槽', () => {
    const tsx = compileMotionCardFromStoryboard(
      sb({ carrier: 'data-hero', data: { value: 43, unit: '%', label: '环比增速', max: 100 } }),
      TOKENS_JSON,
      { assetsResolved: true },
    );
    expectWellFormed(tsx);
    expect(tsx).toContain('variant="title-hero"');
    expect(tsx).not.toContain('name="asset"');
  });
});

describe('asset-led 大图小字布局（素材通栏 + kicker/单行注）', () => {
  const LED_ELEMENTS: MotionStoryboard['elements'] = [
    { id: 'kicker', role: 'support', slot: 'header', content: '考研报名', heightRatio: 0.1 },
    { id: 'note', role: 'focus', slot: 'main', content: '报名 28842 人', heightRatio: 0.12 },
    { id: 'prop', role: 'asset', slot: 'asset', content: '旧档案袋', heightRatio: 0.6, assetSlot: 'archive_prop' },
  ];
  const LED_ASSETS: MotionStoryboard['assets'] = [
    {
      slot: 'archive_prop',
      query: '旧档案袋',
      role: 'object',
      importance: 'primary',
      reusePolicy: 'generate-if-missing',
      visualTreatment: 'editorial-realist-cutout',
      placementHint: '左侧通栏',
    },
  ];
  const LED_BEATS: MotionStoryboard['beats'] = [
    { cue: null, kind: 'build', adds: '标题入场', lifecycle: { enter: ['kicker'] } },
    { cue: 1, kind: 'build', adds: '数字落地', lifecycle: { enter: ['note', 'prop'], collapse: ['kicker'] } },
  ];
  const ledSb = () =>
    sb({
      carrier: 'data-hero',
      layout: 'asset-led',
      elements: LED_ELEMENTS,
      assets: LED_ASSETS,
      beats: LED_BEATS,
      data: { value: 28842, unit: '人', label: '硕士报名' },
    });

  it('assetsResolved=true：asset-led 保留并补发 asset 占位格，主槽只编译单行注释', () => {
    const tsx = compileMotionCardFromStoryboard(ledSb(), TOKENS_JSON, { assetsResolved: true });
    expectWellFormed(tsx);
    expect(tsx).toContain('variant="asset-led"');
    expect(tsx).toContain('<MotionSlot name="asset" role="asset" lifecycle={{ enter: beats[1] }} />');
    // 大图小字：header kicker + main 单行 WordPop 注释（≤14 字），不渲染载体完整原语
    expect(tsx).toContain('<Kicker text="考研报名"');
    expect(tsx).toContain(
      '<WordPop words={["报名 28842 人"]} font="display" size={0.034} weight={600} beat={beats[1]} emphasis="slam" />',
    );
    expect(tsx).not.toContain('<StatHero');
  });

  it('注释缺省提取：无 focus 元素时取 focus 拍文本（清洗到 ≤14 字）', () => {
    const tsx = compileMotionCardFromStoryboard(
      sb({
        carrier: 'data-hero',
        layout: 'asset-led',
        assets: LED_ASSETS,
        data: { value: 28842, unit: '人', label: '硕士报名' },
      }),
      TOKENS_JSON,
      { assetsResolved: true },
    );
    expectWellFormed(tsx);
    // 缺省 beats 的 focus 拍 adds 为「核心内容落地」
    expect(tsx).toContain('<WordPop words={["核心内容落地"]}');
  });

  it('assetsResolved=false（素材物化失败）：asset-led 退回载体默认布局，与 asset-aside 同款降级', () => {
    const tsx = compileMotionCardFromStoryboard(ledSb(), TOKENS_JSON, { assetsResolved: false });
    expectWellFormed(tsx);
    expect(tsx).toContain('variant="title-hero"');
    expect(tsx).not.toContain('name="asset"');
    expect(tsx).toContain('<StatHero value={28842}');
  });

  it('缺省 opts：完全按分镜 layout 编译（旧行为回归，asset-led 保留）', () => {
    const tsx = compileMotionCardFromStoryboard(ledSb(), TOKENS_JSON);
    expectWellFormed(tsx);
    expect(tsx).toContain('variant="asset-led"');
    expect(tsx).toContain('name="asset"');
  });

  it('多元素分镜降级：文字区块超 1 focus + 1 support 时退回 asset-aside（载体原语恢复）', () => {
    const tsx = compileMotionCardFromStoryboard(
      sb({
        carrier: 'data-hero',
        layout: 'asset-led',
        elements: [
          ...LED_ELEMENTS,
          { id: 'kicker2', role: 'support', slot: 'header', content: '第二辅助', heightRatio: 0.1 },
        ],
        assets: LED_ASSETS,
        beats: LED_BEATS,
        data: { value: 28842, unit: '人', label: '硕士报名' },
      }),
      TOKENS_JSON,
      { assetsResolved: true },
    );
    expectWellFormed(tsx);
    // 1 focus + 2 support 超容 → asset-aside（文字区更宽）；载体原语与 asset 占位格都在
    expect(tsx).toContain('variant="asset-aside"');
    expect(tsx).toContain('<StatHero value={28842}');
    expect(tsx).not.toContain('<WordPop');
    expect(tsx).toContain('name="asset"');
  });

  it('多元素分镜降级：无资产占位时退回 title-hero（纯文字卡）', () => {
    const tsx = compileMotionCardFromStoryboard(
      sb({
        carrier: 'data-hero',
        layout: 'asset-led',
        elements: [
          { id: 'kicker', role: 'support', slot: 'header', content: '考研报名', heightRatio: 0.1 },
          { id: 'kicker2', role: 'support', slot: 'header', content: '第二辅助', heightRatio: 0.1 },
          { id: 'note', role: 'focus', slot: 'main', content: '报名 28842 人', heightRatio: 0.12 },
        ],
        data: { value: 28842, unit: '人', label: '硕士报名' },
      }),
      TOKENS_JSON,
      { assetsResolved: true },
    );
    expectWellFormed(tsx);
    expect(tsx).toContain('variant="title-hero"');
    expect(tsx).not.toContain('name="asset"');
    expect(tsx).toContain('<StatHero value={28842}');
  });
});
