import { describe, expect, it } from 'vitest';
import { compileMotionCardFromStoryboard } from '../src/lib/motion-card-templates';
import { lintMotionCardTsx } from '../src/lib/motion-card-lint';
import { validateMotionCardTsx } from '../electron/remotion/smoke-render';
import type { MotionStoryboard } from '../src/lib/motion-storyboard';

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
    ];
    for (const sample of samples) {
      const tsx = compileMotionCardFromStoryboard(sample, TOKENS_JSON);
      const result = await validateMotionCardTsx(tsx, { cues: [0, 96, 228, 354], checkRenderedLayout: true });
      expect(result.render.ok).toBe(true);
      expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    }
  }, 120_000);
});
