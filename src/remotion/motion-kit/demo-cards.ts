/**
 * motion-kit demo-cards —— 内置动效系统的可预览样例（设置界面「动效系统预览」）。
 *
 * 每个 demo 是一张与生产卡片同契约的完整 TSX（export default + CardStage tokens + SafeLayout
 * + MotionSlot + useBeats），走与真实出卡相同的编译/宿主/播放链路预览。
 * 与 MOTION_KIT_API_DOC、cards.segment v24 的载体→原语映射同区维护：
 * 新增 / 改名原语时必须同步本清单；tests/motion-demo-cards.test.ts 做漂移比对。
 */
import { CARRIER_META, STORYBOARD_CARRIERS, type StoryboardCarrier } from '../../lib/motion-storyboard';

export interface MotionDemoCard {
  id: string;
  /** 分镜载体（预览分组依据）；补充原语归 supplementary 组 */
  carrier: StoryboardCarrier;
  /** kit 原语名（与 MOTION_KIT_EXPORT_NAMES / lint mainPrimitives 登记一致） */
  primitive: string;
  /** 一句用途：何时选它 */
  summary: string;
  /** 分镜 motion 意图写法（呼应 cards.animation v10 的变体引导） */
  motionHint: string;
  /** 完整 demo 组件源码；`const TOKENS = __TOKENS__` 由 buildDemoCardTsx 注入当前风格 tokens */
  tsx: string;
  /** 合成节拍（30fps 帧号，相对卡片 frame 0），与 tsx 内 anchors 配对 */
  cues: number[];
  durationInFrames: number;
  /** true = kit 可用但未被分镜载体直接映射的补充原语（如 BarChart） */
  supplementary?: boolean;
}

/** 载体分组展示元信息（顺序即面板分组顺序）；标签真源在 CARRIER_META。 */
export const MOTION_DEMO_CARRIER_META: Array<{
  carrier: StoryboardCarrier | 'supplementary';
  label: string;
  description: string;
}> = [
  ...STORYBOARD_CARRIERS.map((carrier) => ({ carrier, ...CARRIER_META[carrier] })),
  { carrier: 'supplementary', label: '补充原语', description: 'kit 可用但未被分镜载体直接映射' },
];

/* ---------- demo TSX 构造：统一生产卡范式，只替换主原语与节拍 ---------- */

function cardTsx(opts: {
  primitives: string[];
  kicker: string;
  /** main 槽位 JSX（可用 beats 数组） */
  main: string;
  layout?: 'title-hero' | 'split-compare' | 'chart-with-kicker' | 'list-with-kicker' | 'single-focus';
  /** useBeats 的 anchors 字面量，默认两拍 [null, 0] */
  anchors?: string;
  /** CardStage 叙事运镜字面量（含则同时输出 layout 属性） */
  shots?: string;
  /** 包住 main 槽内容的 Annotate 属性片段，如 `kind="circle" beat={beats[1]}` */
  annotate?: string;
}): string {
  const layout = opts.layout ?? 'chart-with-kicker';
  const imports = [
    'CardStage',
    'SafeLayout',
    'MotionSlot',
    ...(opts.annotate ? ['Annotate'] : []),
    'useBeats',
    'Kicker',
    ...opts.primitives,
  ].join(', ');
  const main = opts.annotate
    ? `          <Annotate ${opts.annotate}>\n${opts.main}\n          </Annotate>`
    : opts.main;
  return `import { ${imports} } from '@lingji/motion-kit';

const TOKENS = __TOKENS__;

export default function Card({ cues = [] }) {
  const beats = useBeats(cues, ${opts.anchors ?? '[null, 0]'});
  return (
    <CardStage tokens={TOKENS}${opts.shots ? ` layout="${layout}" shots={${opts.shots}}` : ''}>
      <SafeLayout variant="${layout}">
        <MotionSlot name="header" role="support" lifecycle={{ enter: beats[0] }}>
          <Kicker text=${JSON.stringify(opts.kicker)} beat={beats[0]} />
        </MotionSlot>
        <MotionSlot name="main" role="focus" lifecycle={{ enter: beats[1] }}>
${main}
        </MotionSlot>
      </SafeLayout>
    </CardStage>
  );
}
`;
}

/* ---------- 节拍方案（30fps） ----------
 * B2：kicker + 单拍原语；B3：两拍（swap / 分段强调）；B4：3 项逐条；B5：4 项逐条。 */
const B2 = { anchors: '[null, 0]', cues: [50], duration: 140 };
const B3 = { anchors: '[null, 0, 1]', cues: [45, 100], duration: 150 };
const B4 = { anchors: '[null, 0, 1, 2]', cues: [40, 80, 120], duration: 160 };
const B5 = { anchors: '[null, 0, 1, 2, 3]', cues: [35, 70, 105, 135], duration: 170 };
const SWAP = { anchors: '[null, 0, 1]', cues: [50, 115], duration: 180 };

export const MOTION_DEMO_CARDS: MotionDemoCard[] = [
  /* ----- data-hero 数据大字 ----- */
  {
    id: 'stat-hero',
    carrier: 'data-hero',
    primitive: 'StatHero',
    summary: '一个核心数字的巨型呈现，计数到终值后落定强调',
    motionHint: '分镜写「数字计数到 28842 后落定」',
    cues: B2.cues,
    durationInFrames: B2.duration,
    tsx: cardTsx({
      primitives: ['StatHero'],
      kicker: '报名数据公布',
      layout: 'title-hero',
      anchors: B2.anchors,
      main: `          <StatHero value={28842} unit="人" label="硕士报名人数" beat={beats[1]} max={40000} emphasis="countup-settle" />`,
    }),
  },
  {
    id: 'ring-counter',
    carrier: 'data-hero',
    primitive: 'RingCounter',
    summary: '带环形进度的计数数字，适合达成率 / 进度类 KPI',
    motionHint: '分镜写「环形进度随计数充满」',
    cues: B2.cues,
    durationInFrames: B2.duration,
    tsx: cardTsx({
      primitives: ['RingCounter'],
      kicker: '季度目标进度',
      layout: 'title-hero',
      anchors: B2.anchors,
      main: `          <RingCounter value={87} max={100} unit="%" label="目标完成率" beat={beats[1]} emphasis="countup-settle" />`,
    }),
  },
  {
    id: 'metric-pulse',
    carrier: 'data-hero',
    primitive: 'MetricPulse',
    summary: '里程碑型巨型计数，落定后脉冲环扩散 + delta 徽章',
    motionHint: '分镜写「数字落定后脉冲扩散」',
    cues: B2.cues,
    durationInFrames: B2.duration,
    tsx: cardTsx({
      primitives: ['MetricPulse'],
      kicker: '里程碑达成',
      layout: 'title-hero',
      anchors: B2.anchors,
      main: `          <MetricPulse value={120} unit="万" label="单月涨粉" delta="+32%" beat={beats[1]} emphasis="countup-settle" />`,
    }),
  },
  {
    id: 'scale-impact',
    carrier: 'data-hero',
    primitive: 'ScaleImpact',
    summary: '极值刻度尺：巨型数值 + 刻度标记滑动到位，可带对照刻度',
    motionHint: '分镜写「刻度尺指示到 3%」',
    cues: B2.cues,
    durationInFrames: B2.duration,
    tsx: cardTsx({
      primitives: ['ScaleImpact'],
      kicker: '残酷的比例',
      layout: 'title-hero',
      anchors: B2.anchors,
      main: `          <ScaleImpact value={3} max={100} unit="%" label="付费转化率" reference={{ value: 38, label: '行业均值' }} beat={beats[1]} emphasis="countup-settle" />`,
    }),
  },
  {
    id: 'stat-grid',
    carrier: 'data-hero',
    primitive: 'StatGrid',
    summary: '2-4 个 KPI 并列陈列，2×2 指标格逐格弹出',
    motionHint: '分镜写「指标格逐格弹出」',
    cues: B5.cues,
    durationInFrames: B5.duration,
    tsx: cardTsx({
      primitives: ['StatGrid'],
      kicker: '本期数据一览',
      layout: 'title-hero',
      anchors: B5.anchors,
      main: `          <StatGrid items={[{ value: '120万', label: '总曝光' }, { value: '9.6万', label: '点击' }, { value: '3.1万', label: '完播' }, { value: '4800', label: '新增关注' }]} beats={[beats[1], beats[2], beats[3], beats[4]]} focusIndex={0} emphasis="slam" />`,
    }),
  },

  /* ----- comparison 对比 ----- */
  {
    id: 'compare-row',
    carrier: 'comparison',
    primitive: 'CompareRow',
    summary: '双栏关键数字对比，一侧为唯一焦点',
    motionHint: '分镜写「右侧数字短暂提亮」',
    cues: B2.cues,
    durationInFrames: B2.duration,
    tsx: cardTsx({
      primitives: ['CompareRow'],
      kicker: '效率对照',
      layout: 'split-compare',
      anchors: B2.anchors,
      main: `          <CompareRow left={{ label: '传统流程', value: '6 小时' }} right={{ label: 'AI 流程', value: '40 分钟' }} beat={beats[1]} divider="vs" focusSide="right" emphasis="brighten" />`,
    }),
  },
  {
    id: 'horizontal-bars',
    carrier: 'comparison',
    primitive: 'HorizontalBars',
    summary: '多指标横向条形按值比例展开，焦点条 accent',
    motionHint: '分镜写「横条按比例展开，末条 accent」',
    cues: B3.cues,
    durationInFrames: B3.duration,
    tsx: cardTsx({
      primitives: ['HorizontalBars'],
      kicker: '三种制作方式耗时',
      anchors: B3.anchors,
      main: `          <HorizontalBars items={[{ label: '人工剪辑', value: 100, display: '100%' }, { label: '模板剪辑', value: 62, display: '62%' }, { label: 'AI 一键', value: 28, display: '28%' }]} beat={beats[1]} focusIndex={2} emphasis="slam" />`,
    }),
  },
  {
    id: 'column-chart',
    carrier: 'comparison',
    primitive: 'ColumnChart',
    summary: '真·垂直柱状图：基线网格 + 弹性逐根生长 + 顶部数值',
    motionHint: '分镜写「柱子从基线弹性生长」',
    cues: B3.cues,
    durationInFrames: B3.duration,
    tsx: cardTsx({
      primitives: ['ColumnChart'],
      kicker: '各内容形式占比',
      anchors: B3.anchors,
      main: `          <ColumnChart items={[{ label: '图文', value: 32, display: '32%' }, { label: '短视频', value: 68, display: '68%' }, { label: '直播', value: 45, display: '45%' }]} beat={beats[1]} focusIndex={1} emphasis="slam" />`,
    }),
  },

  /* ----- table 数据表 ----- */
  {
    id: 'data-table',
    carrier: 'table',
    primitive: 'DataTable',
    summary: '多行多列结构化数据：表头先入、行逐条揭示、焦点行 accent',
    motionHint: '分镜写「表头先入、行逐条揭示、焦点行 accent」',
    cues: B3.cues,
    durationInFrames: B3.duration,
    tsx: cardTsx({
      primitives: ['DataTable'],
      kicker: '三大平台创作者单价',
      anchors: B3.anchors,
      main: `          <DataTable columns={['平台', '粉丝量', '千次单价']} rows={[['抖音', '120万', '¥18'], ['B站', '45万', '¥32'], ['视频号', '80万', '¥24']]} beat={beats[1]} focusRow={1} emphasis="brighten" />`,
    }),
  },

  /* ----- trend 趋势 ----- */
  {
    id: 'trend-line',
    carrier: 'trend',
    primitive: 'TrendLine',
    summary: '折线描线绘制，点亮关键拐点并晕染下方区域',
    motionHint: '分镜写「折线绘制后在拐点处点亮标注」',
    cues: B3.cues,
    durationInFrames: B3.duration,
    tsx: cardTsx({
      primitives: ['TrendLine'],
      kicker: '账号粉丝增长',
      anchors: B3.anchors,
      main: `          <TrendLine points={[12, 18, 15, 26, 34, 31, 45]} beat={beats[1]} startLabel="2019" endLabel="2024" markers={[{ index: 4, label: '爆发点' }]} fill emphasis="countup-settle" />`,
    }),
  },

  /* ----- list-build 列表 ----- */
  {
    id: 'list-build',
    carrier: 'list-build',
    primitive: 'ListBuild',
    summary: '并列要点逐条建立，焦点条下划线扫过',
    motionHint: '分镜写「逐条弹出，第二条下划线强调」',
    cues: B4.cues,
    durationInFrames: B4.duration,
    tsx: cardTsx({
      primitives: ['ListBuild'],
      kicker: '留存三要素',
      layout: 'list-with-kicker',
      anchors: B4.anchors,
      main: `          <ListBuild items={['完播率优先于时长', '前 3 秒决定去留', '信息密度要分层']} beats={[beats[1], beats[2], beats[3]]} focusIndex={1} emphasis="underline-sweep" />`,
    }),
  },
  {
    id: 'rank-list',
    carrier: 'list-build',
    primitive: 'RankList',
    summary: 'Top 排名逐条弹出：mono 序号 + 焦点行 accent 侧条',
    motionHint: '分镜写「逐条弹出带序号」',
    cues: B4.cues,
    durationInFrames: B4.duration,
    tsx: cardTsx({
      primitives: ['RankList'],
      kicker: '剪辑工具使用占比 Top3',
      layout: 'list-with-kicker',
      anchors: B4.anchors,
      main: `          <RankList items={[{ label: '剪映', value: '42%' }, { label: 'CapCut', value: '31%' }, { label: '必剪', value: '18%' }]} beats={[beats[1], beats[2], beats[3]]} focusIndex={0} emphasis="slam" />`,
    }),
  },
  {
    id: 'checklist-pop',
    carrier: 'list-build',
    primitive: 'ChecklistPop',
    summary: '行动清单逐条弹出并完成勾选',
    motionHint: '分镜写「逐条勾选」',
    cues: B4.cues,
    durationInFrames: B4.duration,
    tsx: cardTsx({
      primitives: ['ChecklistPop'],
      kicker: '发布前自查',
      layout: 'list-with-kicker',
      anchors: B4.anchors,
      main: `          <ChecklistPop items={['检查字幕错别字', '核对数字来源', '导出前完整看一遍']} beats={[beats[1], beats[2], beats[3]]} emphasis="brighten" />`,
    }),
  },

  /* ----- process 流程 ----- */
  {
    id: 'process-flow',
    carrier: 'process',
    primitive: 'ProcessFlow',
    summary: '步骤节点依次点亮并连接，适合 SOP / 教程',
    motionHint: '分镜写「节点依次点亮」',
    cues: B5.cues,
    durationInFrames: B5.duration,
    tsx: cardTsx({
      primitives: ['ProcessFlow'],
      kicker: '一条视频的诞生',
      layout: 'list-with-kicker',
      anchors: B5.anchors,
      main: `          <ProcessFlow steps={['写稿', '配音', '出卡', '导出']} beats={[beats[1], beats[2], beats[3], beats[4]]} focusIndex={2} emphasis="slam" />`,
    }),
  },
  {
    id: 'cause-chain',
    carrier: 'process',
    primitive: 'CauseChain',
    summary: '原因→机制→结果的因果链路依次连接',
    motionHint: '分镜写「原因→机制→结果依次连接」',
    cues: B4.cues,
    durationInFrames: B4.duration,
    tsx: cardTsx({
      primitives: ['CauseChain'],
      kicker: '为什么短内容更吃香',
      layout: 'list-with-kicker',
      anchors: B4.anchors,
      main: `          <CauseChain steps={['算法改版', '完播权重上调', '短内容受益']} beats={[beats[1], beats[2], beats[3]]} focusIndex={2} emphasis="brighten" />`,
    }),
  },

  /* ----- quote 引用 ----- */
  {
    id: 'quote-block',
    carrier: 'quote',
    primitive: 'QuoteBlock',
    summary: '金句定格：大字 + 出处',
    motionHint: '分镜写「金句落定，出处随后」',
    cues: B2.cues,
    durationInFrames: B2.duration,
    tsx: cardTsx({
      primitives: ['QuoteBlock'],
      kicker: '本期金句',
      layout: 'title-hero',
      anchors: B2.anchors,
      main: `          <QuoteBlock text="趋势不会奖励最早的人，只会奖励最懂的人" source="本期口播" beat={beats[1]} emphasis="slam" />`,
    }),
  },
  {
    id: 'citation-card',
    carrier: 'quote',
    primitive: 'CitationCard',
    summary: '来源引用卡：数据 / 论断 + 可核验出处',
    motionHint: '分镜写「引用正文与来源分层入场」',
    cues: B2.cues,
    durationInFrames: B2.duration,
    tsx: cardTsx({
      primitives: ['CitationCard'],
      kicker: '数据有出处',
      anchors: B2.anchors,
      main: `          <CitationCard text="2024 年知识付费市场规模突破 2800 亿元" source="艾瑞咨询《中国知识付费行业研究报告》" date="2024.12" beat={beats[1]} emphasis="brighten" />`,
    }),
  },
  {
    id: 'key-point-marker',
    carrier: 'quote',
    primitive: 'KeyPointMarker',
    summary: '重点句标注：角标入场 + 扫描下划线',
    motionHint: '分镜写「角标入场后下划线扫过」',
    cues: B2.cues,
    durationInFrames: B2.duration,
    tsx: cardTsx({
      primitives: ['KeyPointMarker'],
      kicker: '记住这一句',
      anchors: B2.anchors,
      main: `          <KeyPointMarker text="完播率是唯一的一级指标" label="重点" beat={beats[1]} emphasis="brighten" />`,
    }),
  },

  /* ----- concept 概念 ----- */
  {
    id: 'concept-card',
    carrier: 'concept',
    primitive: 'ConceptCard',
    summary: '术语 / 概念的聚焦释义面板',
    motionHint: '分镜写「术语先入，释义随后展开」',
    cues: B2.cues,
    durationInFrames: B2.duration,
    tsx: cardTsx({
      primitives: ['ConceptCard'],
      kicker: '名词解释',
      anchors: B2.anchors,
      main: `          <ConceptCard term="信息密度" definition="单位时间内观众接收到的有效信息点数量，直接决定留存曲线形态" hint="本系列第 3 期详解" beat={beats[1]} emphasis="brighten" />`,
    }),
  },
  {
    id: 'section-title',
    carrier: 'concept',
    primitive: 'SectionTitle',
    summary: '章节标题卡：编号 + 大标题 + hairline 展开，章节过渡专用',
    motionHint: '分镜写「章节标题展开」',
    cues: B2.cues,
    durationInFrames: B2.duration,
    tsx: cardTsx({
      primitives: ['SectionTitle'],
      kicker: '进入下一章',
      layout: 'title-hero',
      anchors: B2.anchors,
      main: `          <SectionTitle index="PART 02" title="从流量到留量" subtitle="私域承接的三种姿势" beat={beats[1]} emphasis="brighten" />`,
    }),
  },

  /* ----- timeline 时间线 ----- */
  {
    id: 'timeline-rail',
    carrier: 'timeline',
    primitive: 'TimelineRail',
    summary: '阶段 / 版本沿时间线依次点亮',
    motionHint: '分镜写「节点沿轨依次点亮」',
    cues: B5.cues,
    durationInFrames: B5.duration,
    tsx: cardTsx({
      primitives: ['TimelineRail'],
      kicker: '行业六年',
      layout: 'list-with-kicker',
      anchors: B5.anchors,
      main: `          <TimelineRail items={['2019 起步', '2021 爆发', '2023 分化', '2025 重构']} beats={[beats[1], beats[2], beats[3], beats[4]]} focusIndex={3} emphasis="brighten" />`,
    }),
  },

  /* ----- matrix 象限 ----- */
  {
    id: 'matrix-quadrant',
    carrier: 'matrix',
    primitive: 'MatrixQuadrant',
    summary: '二维象限定位，决策 / 优先级判断',
    motionHint: '分镜写「象限点依次弹出，焦点项提亮」',
    cues: B3.cues,
    durationInFrames: B3.duration,
    tsx: cardTsx({
      primitives: ['MatrixQuadrant'],
      kicker: '内容形式怎么选',
      anchors: B3.anchors,
      main: `          <MatrixQuadrant xLabel="传播力" yLabel="制作成本" items={[{ label: '口播切片', x: 78, y: 25, focus: true }, { label: '动画解说', x: 62, y: 70 }, { label: '实拍大片', x: 85, y: 88 }, { label: '图文复用', x: 35, y: 18 }]} beat={beats[1]} emphasis="brighten" />`,
    }),
  },

  /* ----- funnel 漏斗 ----- */
  {
    id: 'funnel-stack',
    carrier: 'funnel',
    primitive: 'FunnelStack',
    summary: '转化漏斗逐层收窄',
    motionHint: '分镜写「层级依次收窄落定」',
    cues: B3.cues,
    durationInFrames: B3.duration,
    tsx: cardTsx({
      primitives: ['FunnelStack'],
      kicker: '一条视频的转化链',
      anchors: B3.anchors,
      main: `          <FunnelStack steps={[{ label: '曝光', value: '120万' }, { label: '点击', value: '9.6万' }, { label: '完播', value: '3.1万' }, { label: '关注', value: '4800' }]} beat={beats[1]} focusIndex={3} emphasis="slam" />`,
    }),
  },

  /* ----- network 关系网 ----- */
  {
    id: 'network-map',
    carrier: 'network',
    primitive: 'NetworkMap',
    summary: '多主体关系网连接生长',
    motionHint: '分镜写「节点入场后连线生长」',
    cues: B3.cues,
    durationInFrames: B3.duration,
    tsx: cardTsx({
      primitives: ['NetworkMap'],
      kicker: '平台的四方关系',
      anchors: B3.anchors,
      main: `          <NetworkMap nodes={['平台', '创作者', '观众', '广告主']} links={[[0, 1], [1, 2], [0, 3], [2, 3]]} beat={beats[1]} focusIndex={1} emphasis="brighten" />`,
    }),
  },

  /* ----- before-after 前后对照 ----- */
  {
    id: 'before-after',
    carrier: 'before-after',
    primitive: 'BeforeAfter',
    summary: '前后对照：旧状态被新状态擦除替换',
    motionHint: '分镜写「新状态擦除旧状态」',
    cues: B2.cues,
    durationInFrames: B2.duration,
    tsx: cardTsx({
      primitives: ['BeforeAfter'],
      kicker: '工作流升级',
      layout: 'split-compare',
      anchors: B2.anchors,
      main: `          <BeforeAfter before="逐句手动对轴" after="AI 一键成稿" beat={beats[1]} mode="wipe" focusSide="after" emphasis="brighten" />`,
    }),
  },
  {
    id: 'myth-fact-swap',
    carrier: 'before-after',
    primitive: 'MythFactSwap',
    summary: '先划掉常见误区，再揭示真实情况',
    motionHint: '分镜写「先划掉误区再揭示事实」',
    cues: SWAP.cues,
    durationInFrames: SWAP.duration,
    tsx: cardTsx({
      primitives: ['MythFactSwap'],
      kicker: '认知纠偏',
      layout: 'split-compare',
      anchors: SWAP.anchors,
      main: `          <MythFactSwap myth="播放量高 = 收益高" fact="千次播放单价差 6 倍" beat={beats[1]} swapBeat={beats[2]} emphasis="slam" />`,
    }),
  },

  /* ----- stacked-composition 堆叠构成 ----- */
  {
    id: 'stacked-composition',
    carrier: 'stacked-composition',
    primitive: 'StackedComposition',
    summary: '构成占比的层级堆叠',
    motionHint: '分镜写「分段依次堆叠」',
    cues: B3.cues,
    durationInFrames: B3.duration,
    tsx: cardTsx({
      primitives: ['StackedComposition'],
      kicker: '博主的时间去哪了',
      anchors: B3.anchors,
      main: `          <StackedComposition items={[{ label: '内容制作', value: 55, display: '55%' }, { label: '分发运营', value: 30, display: '30%' }, { label: '商务合作', value: 15, display: '15%' }]} beat={beats[1]} focusIndex={0} emphasis="brighten" />`,
    }),
  },
  {
    id: 'donut-chart',
    carrier: 'stacked-composition',
    primitive: 'DonutChart',
    summary: '环形饼图：分段接力绘制 + 中心焦点数字 + 图例',
    motionHint: '分镜写「分段依次绘制」',
    cues: B3.cues,
    durationInFrames: B3.duration,
    tsx: cardTsx({
      primitives: ['DonutChart'],
      kicker: '时间花在哪里',
      anchors: B3.anchors,
      main: `          <DonutChart segments={[{ label: '内容制作', value: 55, display: '55%' }, { label: '分发运营', value: 30, display: '30%' }, { label: '商务合作', value: 15, display: '15%' }]} beat={beats[1]} focusIndex={0} centerLabel="时间占比" emphasis="brighten" />`,
    }),
  },

  /* ----- 补充原语（kit 可用，未被分镜载体直接映射） ----- */
  {
    id: 'bar-chart',
    carrier: 'comparison',
    supplementary: true,
    primitive: 'BarChart',
    summary: '纵向柱状对比，逐柱弹性生长 + 数值标签',
    motionHint: 'kit 补充原语：分镜 carrier 选 comparison 时可用',
    cues: B3.cues,
    durationInFrames: B3.duration,
    tsx: cardTsx({
      primitives: ['BarChart'],
      kicker: '各内容形式占比',
      anchors: B3.anchors,
      main: `          <BarChart items={[{ label: '图文', value: 32, display: '32%' }, { label: '短视频', value: 68, display: '68%' }, { label: '直播', value: 45, display: '45%' }]} beat={beats[1]} focusIndex={1} emphasis="slam" />`,
    }),
  },
  {
    id: 'annotate-circle',
    carrier: 'data-hero',
    supplementary: true,
    primitive: 'Annotate',
    summary: '指示标注：圈出正在讲的那块内容（讲解者的手）',
    motionHint: '分镜写 annotate:[{beat,kind:"circle",target:"main"}]',
    cues: B3.cues,
    durationInFrames: B3.duration,
    tsx: cardTsx({
      primitives: ['StatHero'],
      kicker: '硕士报名',
      anchors: B3.anchors,
      annotate: 'kind="circle" beat={beats[2]}',
      main: `            <StatHero value={28842} unit="人" label="今年报名" beat={beats[1]} max={40000} emphasis="countup-settle" />`,
    }),
  },
  {
    id: 'camera-focus',
    carrier: 'trend',
    supplementary: true,
    primitive: 'CardStage.shots',
    summary: '叙事运镜：焦点拍推近到主槽，收束拍拉开看全局',
    motionHint: '分镜写 camera:[{beat,move:"focus",target:"main"}]',
    cues: B3.cues,
    durationInFrames: B3.duration,
    tsx: cardTsx({
      primitives: ['TrendLine'],
      kicker: '三年增速',
      anchors: B3.anchors,
      shots: `[{ beat: beats[1], move: 'focus', target: 'main' }, { beat: beats[2], move: 'pull-out' }]`,
      main: `          <TrendLine points={[12, 18, 41]} beat={beats[1]} startLabel="2023" endLabel="2025" fill emphasis="countup-settle" />`,
    }),
  },
];

/** 把当前风格 tokens JSON 注入 demo TSX（替换唯一占位 __TOKENS__，与生产 TOKENS 注入一致）。 */
export function buildDemoCardTsx(demo: MotionDemoCard, tokensJson: string): string {
  return demo.tsx.replace('__TOKENS__', tokensJson);
}
