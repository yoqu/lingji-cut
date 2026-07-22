/**
 * motion-card-templates —— storyboard 的确定性满血模板编译（template 模式主路径，不经 LLM）。
 *
 * 与 buildFallbackCardTsx（简版兜底）的关系：两者共享"storyboard → 纯 motion-kit 原语"的
 * 编译思想与文本提取器；本模块是满血版——优先消费分镜的可选 data 结构化字段（原语 props
 * 直接映射），缺 data 时回落到 beats 文本提取。布局 / 安全区 / 节拍锚定由 kit 构造保证：
 * 永不越界、永可渲染、永过 lint。
 */
import type {
  MotionStoryboard,
  StoryboardBeat,
  StoryboardBeforeAfterData,
  StoryboardComparisonData,
  StoryboardConceptData,
  StoryboardFunnelData,
  StoryboardHeroData,
  StoryboardLayout,
  StoryboardListData,
  StoryboardMatrixData,
  StoryboardNetworkData,
  StoryboardProcessData,
  StoryboardQuoteData,
  StoryboardStackedData,
  StoryboardTableData,
  StoryboardTimelineData,
  StoryboardTrendData,
} from './motion-storyboard';
import { cleanScreenText, extractHeroNumber } from './motion-card-fallback';

const q = (text: string): string => JSON.stringify(text);

/* ---------- 编译上下文：节拍锚定 / 焦点 / 强调 ---------- */

interface CompileCtx {
  beats: StoryboardBeat[];
  /** 主原语入场拍（focus 拍；无 focus 时第 1 拍，单拍时第 0 拍）。 */
  enter: number;
  /** focus 拍索引（无合法 focus 时 -1）。 */
  focus: number;
  emphasisAttr: string;
  anchorsLiteral: string;
}

function beatsOf(sb: MotionStoryboard): StoryboardBeat[] {
  return Array.isArray(sb.beats) && sb.beats.length > 0
    ? sb.beats
    : [{ cue: null, kind: 'build', adds: sb.claim }];
}

function makeCtx(sb: MotionStoryboard): CompileCtx {
  const beats = beatsOf(sb);
  const focus =
    sb.focus && Number.isInteger(sb.focus.beat) && sb.focus.beat >= 0 && sb.focus.beat < beats.length
      ? sb.focus.beat
      : -1;
  const enter = focus > 0 ? focus : beats.length > 1 ? 1 : 0;
  const anchorsLiteral = `[${beats
    .map((b, i) => (i === 0 ? 'null' : b.cue == null ? 'null' : String(b.cue)))
    .join(', ')}]`;
  const emphasis = sb.focus?.emphasis;
  return {
    beats,
    enter,
    focus,
    emphasisAttr: emphasis ? ` emphasis=${q(emphasis)}` : '',
    anchorsLiteral,
  };
}

/** 逐项揭示：条目数与"入场拍之外的内容拍"一一对应时传 beats 数组，否则整块单 beat 入场。 */
function perItemBeatAttr(ctx: CompileCtx, count: number): string {
  if (count > 1 && count === ctx.beats.length - 1) {
    return `beats={[${Array.from({ length: count }, (_, i) => `beats[${i + 1}]`).join(', ')}]}`;
  }
  return `beat={beats[${ctx.enter}]}`;
}

/** 逐项揭示时的焦点条目下标；非逐项或 focus 不在内容拍时不输出。 */
function focusIndexAttr(ctx: CompileCtx, count: number): string {
  if (count > 1 && count === ctx.beats.length - 1 && ctx.focus > 0) {
    const index = Math.min(count - 1, Math.max(0, ctx.focus - 1));
    return ` focusIndex={${index}}`;
  }
  return '';
}

function beatAttr(ctx: CompileCtx): string {
  return `beat={beats[${ctx.enter}]}`;
}

function decimalsOf(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const dot = String(value).indexOf('.');
  return dot < 0 ? 0 : Math.min(2, String(value).length - dot - 1);
}

function numberLiteral(value: number): string {
  return String(value);
}

/* ---------- 文本提取回落（无 data 时） ---------- */

/** 各拍上屏文本（跳过第 0 拍标题拍，有多拍时）。 */
function contentTexts(sb: MotionStoryboard, ctx: CompileCtx, maxLen = 12): string[] {
  const all = ctx.beats.map((b) => cleanScreenText(b.adds ?? '', maxLen));
  const content = ctx.beats.length > 1 ? all.slice(1) : all;
  return content.filter(Boolean);
}

function heroFromBeats(sb: MotionStoryboard, ctx: CompileCtx): { value: number; unit: string; label: string; beatIndex: number } | null {
  const tryAt = (index: number) => {
    if (index < 0 || index >= ctx.beats.length) return null;
    const found = extractHeroNumber(ctx.beats[index].adds ?? '');
    if (!found) return null;
    const label = cleanScreenText((ctx.beats[index].adds ?? '').replace(/[\d,，.%]+/g, ''), 10);
    return { ...found, label, beatIndex: index };
  };
  return tryAt(ctx.focus) ?? ctx.beats.map((_, i) => tryAt(i)).find((r) => r != null) ?? null;
}

/* ---------- 逐载体模板：props 优先取 data，缺省回落 beats 提取 ---------- */

interface CompiledMain {
  /** 主原语 JSX（单元素）。 */
  jsx: string;
  /** 基础集之外的 kit 具名导入。 */
  imports: string[];
}

function asListFallback(sb: MotionStoryboard, ctx: CompileCtx, maxLen = 12): CompiledMain {
  const items = contentTexts(sb, ctx, maxLen).slice(0, 4);
  const safeItems = items.length > 0 ? items : [cleanScreenText(sb.claim, maxLen)];
  return {
    imports: ['ListBuild'],
    jsx: `<ListBuild items={[${safeItems.map(q).join(', ')}]} ${perItemBeatAttr(ctx, safeItems.length)}${focusIndexAttr(ctx, safeItems.length)}${ctx.emphasisAttr} />`,
  };
}

function buildDataHero(sb: MotionStoryboard, ctx: CompileCtx): CompiledMain {
  const data = sb.data as StoryboardHeroData | undefined;
  if (data?.variant === 'stat-grid' && Array.isArray(data.items) && data.items.length >= 2) {
    const items = data.items.slice(0, 4);
    const literal = items.map((it) => `{ value: ${q(String(it.value))}, label: ${q(String(it.label))} }`).join(', ');
    return {
      imports: ['StatGrid'],
      jsx: `<StatGrid items={[${literal}]} ${perItemBeatAttr(ctx, items.length)}${focusIndexAttr(ctx, items.length)}${ctx.emphasisAttr} />`,
    };
  }
  const value = typeof data?.value === 'number' && Number.isFinite(data.value) ? data.value : null;
  if (value != null) {
    const unit = q(String(data?.unit ?? ''));
    const label = q(String(data?.label ?? ''));
    const decimals = decimalsOf(value);
    const decimalsAttr = decimals > 0 ? ` decimals={${decimals}}` : '';
    const maxAttr = typeof data?.max === 'number' && data.max > 0 ? ` max={${numberLiteral(data.max)}}` : '';
    if (data?.variant === 'metric-pulse') {
      return { imports: ['MetricPulse'], jsx: `<MetricPulse value={${numberLiteral(value)}} unit=${unit} label=${label}${decimalsAttr}${beatAttr(ctx)}${ctx.emphasisAttr} />` };
    }
    if (data?.variant === 'ring-counter') {
      return { imports: ['RingCounter'], jsx: `<RingCounter value={${numberLiteral(value)}} max={${numberLiteral(typeof data?.max === 'number' && data.max > 0 ? data.max : 100)}} unit=${unit} label=${label}${decimalsAttr}${beatAttr(ctx)}${ctx.emphasisAttr} />` };
    }
    if (data?.variant === 'scale-impact') {
      const max = typeof data?.max === 'number' && data.max > value ? data.max : value * 2;
      return { imports: ['ScaleImpact'], jsx: `<ScaleImpact value={${numberLiteral(value)}} max={${numberLiteral(max)}} unit=${unit} label=${label}${decimalsAttr}${beatAttr(ctx)}${ctx.emphasisAttr} />` };
    }
    return { imports: ['StatHero'], jsx: `<StatHero value={${numberLiteral(value)}} unit=${unit} label=${label}${decimalsAttr}${maxAttr}${beatAttr(ctx)}${ctx.emphasisAttr} />` };
  }
  const hero = heroFromBeats(sb, ctx);
  if (hero) {
    return {
      imports: ['StatHero'],
      jsx: `<StatHero value={${numberLiteral(hero.value)}} unit=${q(hero.unit)} label=${q(hero.label)} beat={beats[${hero.beatIndex}]}${ctx.emphasisAttr} />`,
    };
  }
  return asListFallback(sb, ctx);
}

function buildComparison(sb: MotionStoryboard, ctx: CompileCtx): CompiledMain {
  const data = sb.data as StoryboardComparisonData | undefined;
  if (Array.isArray(data?.items) && data.items.length >= 2) {
    const items = data.items.slice(0, 6);
    const literal = items
      .map((it) => `{ label: ${q(String(it.label))}, value: ${numberLiteral(Number(it.value) || 0)}${it.display ? `, display: ${q(String(it.display))}` : ''} }`)
      .join(', ');
    return { imports: ['ColumnChart'], jsx: `<ColumnChart items={[${literal}]} ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
  }
  if (data?.left && data?.right) {
    return {
      imports: ['CompareRow'],
      jsx: `<CompareRow left={{ label: ${q(String(data.left.label))}, value: ${q(String(data.left.value))} }} right={{ label: ${q(String(data.right.label))}, value: ${q(String(data.right.value))} }} ${beatAttr(ctx)}${ctx.emphasisAttr} />`,
    };
  }
  const texts = contentTexts(sb, ctx);
  if (texts.length >= 2) {
    return {
      imports: ['CompareRow'],
      jsx: `<CompareRow left={{ label: ${q(texts[0])}, value: ${q(texts[0])} }} right={{ label: ${q(texts[1])}, value: ${q(texts[1])} }} ${beatAttr(ctx)}${ctx.emphasisAttr} />`,
    };
  }
  return asListFallback(sb, ctx);
}

function buildTable(sb: MotionStoryboard, ctx: CompileCtx): CompiledMain {
  const data = sb.data as StoryboardTableData | undefined;
  if (Array.isArray(data?.columns) && Array.isArray(data?.rows) && data.columns.length > 0 && data.rows.length > 0) {
    const columns = data.columns.slice(0, 4).map((c) => q(String(c)));
    const rows = data.rows
      .slice(0, 5)
      .map((row) => `[${row.slice(0, data.columns.length).map((cell) => q(String(cell))).join(', ')}]`)
      .join(', ');
    return { imports: ['DataTable'], jsx: `<DataTable columns={[${columns.join(', ')}]} rows={[${rows}]} ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
  }
  // 无结构化 data 时表格无法还原列语义，确定性地降级为要点列表。
  return asListFallback(sb, ctx);
}

function buildTrend(sb: MotionStoryboard, ctx: CompileCtx): CompiledMain {
  const data = sb.data as StoryboardTrendData | undefined;
  let points = Array.isArray(data?.points)
    ? data.points.filter((p): p is number => typeof p === 'number' && Number.isFinite(p)).slice(0, 8)
    : [];
  if (points.length < 2) {
    points = ctx.beats
      .map((b) => extractHeroNumber(b.adds ?? '')?.value)
      .filter((v): v is number => typeof v === 'number')
      .slice(0, 8);
  }
  if (points.length >= 2) {
    const startAttr = data?.startLabel ? ` startLabel=${q(String(data.startLabel))}` : '';
    const endAttr = data?.endLabel ? ` endLabel=${q(String(data.endLabel))}` : '';
    const markers = Array.isArray(data?.markers) && data.markers.length > 0
      ? ` markers={[${data.markers
          .filter((m) => Number.isInteger(m?.index) && m.index >= 0 && m.index < points.length)
          .map((m) => `{ index: ${m.index}${m.label ? `, label: ${q(String(m.label))}` : ''} }`)
          .join(', ')}]}`
      : '';
    return { imports: ['TrendLine'], jsx: `<TrendLine points={[${points.map(numberLiteral).join(', ')}]}${startAttr}${endAttr}${markers} fill ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
  }
  return asListFallback(sb, ctx);
}

function buildListBuild(sb: MotionStoryboard, ctx: CompileCtx): CompiledMain {
  const data = sb.data as StoryboardListData | undefined;
  if (Array.isArray(data?.items) && data.items.length > 0) {
    const limit = data.variant ? 5 : 4;
    const items = data.items.slice(0, limit).map(String);
    if (data.variant === 'rank') {
      const literal = items.map((item) => `{ label: ${q(item)} }`).join(', ');
      return { imports: ['RankList'], jsx: `<RankList items={[${literal}]} ${perItemBeatAttr(ctx, items.length)}${focusIndexAttr(ctx, items.length)}${ctx.emphasisAttr} />` };
    }
    if (data.variant === 'check') {
      return { imports: ['ChecklistPop'], jsx: `<ChecklistPop items={[${items.map(q).join(', ')}]} ${perItemBeatAttr(ctx, items.length)}${focusIndexAttr(ctx, items.length)}${ctx.emphasisAttr} />` };
    }
    return { imports: ['ListBuild'], jsx: `<ListBuild items={[${items.map(q).join(', ')}]} ${perItemBeatAttr(ctx, items.length)}${focusIndexAttr(ctx, items.length)}${ctx.emphasisAttr} />` };
  }
  return asListFallback(sb, ctx);
}

function buildProcess(sb: MotionStoryboard, ctx: CompileCtx): CompiledMain {
  const data = sb.data as StoryboardProcessData | undefined;
  const steps = Array.isArray(data?.steps) && data.steps.length >= 2
    ? data.steps.slice(0, 4).map(String)
    : contentTexts(sb, ctx).slice(0, 4);
  if (steps.length >= 2) {
    const name = data?.variant === 'cause' ? 'CauseChain' : 'ProcessFlow';
    return { imports: [name], jsx: `<${name} steps={[${steps.map(q).join(', ')}]} ${perItemBeatAttr(ctx, steps.length)}${focusIndexAttr(ctx, steps.length)}${ctx.emphasisAttr} />` };
  }
  return asListFallback(sb, ctx);
}

function buildQuote(sb: MotionStoryboard, ctx: CompileCtx): CompiledMain {
  const data = sb.data as StoryboardQuoteData | undefined;
  const text = typeof data?.text === 'string' && data.text.trim()
    ? data.text.trim()
    : cleanScreenText(ctx.beats[ctx.focus]?.adds ?? sb.claim, 22);
  const sourceAttr = data?.source ? ` source=${q(String(data.source))}` : '';
  return { imports: ['QuoteBlock'], jsx: `<QuoteBlock text=${q(text)}${sourceAttr} ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
}

function buildConcept(sb: MotionStoryboard, ctx: CompileCtx): CompiledMain {
  const data = sb.data as StoryboardConceptData | undefined;
  if (data?.variant === 'section' && typeof data?.title === 'string' && data.title.trim()) {
    const indexAttr = data.index ? ` index=${q(String(data.index))}` : '';
    const subtitleAttr = data.subtitle ? ` subtitle=${q(String(data.subtitle))}` : '';
    return { imports: ['SectionTitle'], jsx: `<SectionTitle${indexAttr} title=${q(data.title.trim())}${subtitleAttr} ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
  }
  if (typeof data?.term === 'string' && data.term.trim() && typeof data?.definition === 'string' && data.definition.trim()) {
    const hintAttr = data.hint ? ` hint=${q(String(data.hint))}` : '';
    return { imports: ['ConceptCard'], jsx: `<ConceptCard term=${q(data.term.trim())} definition=${q(data.definition.trim())}${hintAttr} ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
  }
  return { imports: ['KeyPointMarker'], jsx: `<KeyPointMarker text=${q(cleanScreenText(ctx.beats[ctx.focus]?.adds ?? sb.claim, 16))} ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
}

function buildTimeline(sb: MotionStoryboard, ctx: CompileCtx): CompiledMain {
  const data = sb.data as StoryboardTimelineData | undefined;
  const items = Array.isArray(data?.items) && data.items.length >= 2
    ? data.items.slice(0, 4).map(String)
    : contentTexts(sb, ctx).slice(0, 4);
  if (items.length >= 2) {
    return { imports: ['TimelineRail'], jsx: `<TimelineRail items={[${items.map(q).join(', ')}]} ${perItemBeatAttr(ctx, items.length)}${focusIndexAttr(ctx, items.length)}${ctx.emphasisAttr} />` };
  }
  return asListFallback(sb, ctx);
}

function buildMatrix(sb: MotionStoryboard, ctx: CompileCtx): CompiledMain {
  const data = sb.data as StoryboardMatrixData | undefined;
  const items = Array.isArray(data?.items) && data.items.length >= 2
    ? data.items.slice(0, 5)
    : contentTexts(sb, ctx)
        .slice(0, 4)
        .map((text, i) => ({ label: text, x: 25 + (i % 3) * 25, y: 35 + (i % 2) * 32, focus: i === Math.max(0, ctx.focus - 1) }));
  if (items.length >= 2) {
    const literal = items
      .map((it) => `{ label: ${q(String(it.label))}, x: ${numberLiteral(Number(it.x) || 0)}, y: ${numberLiteral(Number(it.y) || 0)}${it.focus ? ', focus: true' : ''} }`)
      .join(', ');
    const xAttr = data?.xLabel ? ` xLabel=${q(String(data.xLabel))}` : '';
    const yAttr = data?.yLabel ? ` yLabel=${q(String(data.yLabel))}` : '';
    return { imports: ['MatrixQuadrant'], jsx: `<MatrixQuadrant${xAttr}${yAttr} items={[${literal}]} ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
  }
  return asListFallback(sb, ctx);
}

function buildFunnel(sb: MotionStoryboard, ctx: CompileCtx): CompiledMain {
  const data = sb.data as StoryboardFunnelData | undefined;
  const steps = Array.isArray(data?.steps) && data.steps.length >= 2
    ? data.steps.slice(0, 5).map((s) => ({ label: String(s.label), value: s.value ? String(s.value) : '' }))
    : contentTexts(sb, ctx).slice(0, 4).map((text) => ({ label: text, value: '' }));
  if (steps.length >= 2) {
    const literal = steps.map((s) => `{ label: ${q(s.label)}, value: ${q(s.value)} }`).join(', ');
    return { imports: ['FunnelStack'], jsx: `<FunnelStack steps={[${literal}]} ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
  }
  return asListFallback(sb, ctx);
}

function buildNetwork(sb: MotionStoryboard, ctx: CompileCtx): CompiledMain {
  const data = sb.data as StoryboardNetworkData | undefined;
  const nodes = Array.isArray(data?.nodes) && data.nodes.length >= 2
    ? data.nodes.slice(0, 5).map(String)
    : contentTexts(sb, ctx, 8).slice(0, 4);
  if (nodes.length >= 2) {
    const validLinks = Array.isArray(data?.links)
      ? data.links.filter(
          (l): l is [number, number] =>
            Array.isArray(l) && l.length === 2 && l.every((p) => Number.isInteger(p) && p >= 0 && p < nodes.length),
        )
      : [];
    const links = validLinks.length > 0
      ? validLinks
      : Array.from({ length: nodes.length - 1 }, (_, i) => [i, i + 1] as [number, number]);
    return { imports: ['NetworkMap'], jsx: `<NetworkMap nodes={[${nodes.map(q).join(', ')}]} links={[${links.map((l) => `[${l[0]},${l[1]}]`).join(', ')}]} ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
  }
  return asListFallback(sb, ctx);
}

function buildBeforeAfter(sb: MotionStoryboard, ctx: CompileCtx): CompiledMain {
  const data = sb.data as StoryboardBeforeAfterData | undefined;
  const texts = contentTexts(sb, ctx);
  const before = typeof data?.before === 'string' && data.before.trim() ? data.before.trim() : texts[0] ?? '之前';
  const after = typeof data?.after === 'string' && data.after.trim() ? data.after.trim() : texts[1] ?? texts[texts.length - 1] ?? '之后';
  if (data?.variant === 'myth-fact') {
    const swapAttr = ctx.beats.length > ctx.enter + 1 ? ` swapBeat={beats[${ctx.enter + 1}]}` : '';
    return { imports: ['MythFactSwap'], jsx: `<MythFactSwap myth=${q(before)} fact=${q(after)} ${beatAttr(ctx)}${swapAttr}${ctx.emphasisAttr} />` };
  }
  return { imports: ['BeforeAfter'], jsx: `<BeforeAfter before=${q(before)} after=${q(after)} ${beatAttr(ctx)} mode="wipe"${ctx.emphasisAttr} />` };
}

function buildStacked(sb: MotionStoryboard, ctx: CompileCtx): CompiledMain {
  const data = sb.data as StoryboardStackedData | undefined;
  const items = Array.isArray(data?.items) && data.items.length >= 2
    ? data.items.slice(0, 5).map((it) => ({ label: String(it.label), value: Number(it.value) || 0, display: it.display ? String(it.display) : undefined }))
    : contentTexts(sb, ctx).slice(0, 4).map((text, i) => ({ label: text, value: Math.max(10, 50 - i * 8), display: undefined }));
  if (items.length >= 2) {
    const literal = items
      .map((it) => `{ label: ${q(it.label)}, value: ${numberLiteral(it.value)}${it.display ? `, display: ${q(it.display)}` : ''} }`)
      .join(', ');
    if (data?.variant === 'donut') {
      return { imports: ['DonutChart'], jsx: `<DonutChart segments={[${literal}]} ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
    }
    return { imports: ['StackedComposition'], jsx: `<StackedComposition items={[${literal}]} ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
  }
  return asListFallback(sb, ctx);
}

const CARRIER_BUILDERS: Record<string, (sb: MotionStoryboard, ctx: CompileCtx) => CompiledMain> = {
  'data-hero': buildDataHero,
  comparison: buildComparison,
  table: buildTable,
  trend: buildTrend,
  'list-build': buildListBuild,
  process: buildProcess,
  quote: buildQuote,
  concept: buildConcept,
  timeline: buildTimeline,
  matrix: buildMatrix,
  funnel: buildFunnel,
  network: buildNetwork,
  'before-after': buildBeforeAfter,
  'stacked-composition': buildStacked,
};

/* ---------- 骨架 ---------- */

const VALID_LAYOUTS = new Set<StoryboardLayout>([
  'single-focus',
  'title-hero',
  'split-compare',
  'chart-with-kicker',
  'list-with-kicker',
  'asset-aside',
]);

function resolveLayout(sb: MotionStoryboard): StoryboardLayout {
  if (sb.layout && VALID_LAYOUTS.has(sb.layout)) return sb.layout;
  switch (sb.carrier) {
    case 'comparison':
    case 'before-after':
      return 'split-compare';
    case 'data-hero':
      return 'title-hero';
    case 'list-build':
    case 'process':
      return 'list-with-kicker';
    case 'quote':
    case 'concept':
      return 'single-focus';
    default:
      return 'chart-with-kicker';
  }
}

function headerText(sb: MotionStoryboard): string {
  const support = sb.elements?.find((element) => element.role === 'support');
  return cleanScreenText(support?.content ?? sb.claim, 14);
}

/**
 * 把机器校验过的 storyboard 编译为满血模板卡 TSX。
 * 产物只 import @lingji/motion-kit，帧纯函数，天然通过 lint 与安全区校验。
 */
export function compileMotionCardFromStoryboard(sb: MotionStoryboard, presetTokensJson: string): string {
  const ctx = makeCtx(sb);
  const builder = CARRIER_BUILDERS[sb.carrier] ?? ((s: MotionStoryboard, c: CompileCtx) => asListFallback(s, c));
  const main = builder(sb, ctx);
  const layout = resolveLayout(sb);

  const imports = [...new Set(['CardStage', 'SafeLayout', 'MotionSlot', 'useTimingPlan', 'Kicker', ...main.imports])].join(', ');
  const collapseAttr = ctx.focus > 0 ? `, collapse: beats[${ctx.focus}]` : '';
  const headerSlot =
    layout === 'single-focus'
      ? ''
      : `        <MotionSlot name="header" role="support" lifecycle={{ enter: beats[0]${collapseAttr} }}>
          <Kicker text=${q(headerText(sb))} beat={beats[0]} />
        </MotionSlot>\n`;

  return `import { ${imports} } from '@lingji/motion-kit';

const TOKENS = ${presetTokensJson};

export default function Card({ cues = [], timingPlan }) {
  const beats = useTimingPlan(timingPlan, cues, ${ctx.anchorsLiteral});
  return (
    <CardStage tokens={TOKENS}>
      <SafeLayout variant=${q(layout)}>
${headerSlot}        <MotionSlot name="main" role="focus" lifecycle={{ enter: beats[${ctx.enter}] }}>
          ${main.jsx}
        </MotionSlot>
      </SafeLayout>
    </CardStage>
  );
}
`;
}
