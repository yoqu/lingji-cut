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
  StoryboardAnnotation,
  StoryboardCameraShot,
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

/** 某槽位元素在分镜 lifecycle 中声明的生命周期拍索引（缺省 = 分镜未声明）。 */
interface SlotLifecycleBeats {
  enter?: number;
  update?: number;
  collapse?: number;
  exit?: number;
}

interface CompileCtx {
  beats: StoryboardBeat[];
  /** 主原语入场拍（focus 元素 lifecycle.enter 优先；否则 focus 拍；无 focus 时第 1 拍，单拍时第 0 拍）。 */
  enter: number;
  /** focus 拍索引（无合法 focus 时 -1）。 */
  focus: number;
  emphasisAttr: string;
  anchorsLiteral: string;
  /** focus 元素（main 槽）的分镜生命周期。 */
  mainLifecycle: SlotLifecycleBeats;
  /** support 元素（header 槽）的分镜生命周期。 */
  headerLifecycle: SlotLifecycleBeats;
  /** asset 元素（asset 槽）的分镜生命周期。 */
  assetLifecycle: SlotLifecycleBeats;
  /** true 时把 underline-sweep 强调编译为独立 UnderlineSweep 原语（主原语不再重复下划线）。 */
  sweep: boolean;
}

function beatsOf(sb: MotionStoryboard): StoryboardBeat[] {
  return Array.isArray(sb.beats) && sb.beats.length > 0
    ? sb.beats
    : [{ cue: null, kind: 'build', adds: sb.claim }];
}

/** 从分镜 elements + beats[].lifecycle 提取某角色槽位的生命周期拍索引（每类操作取首次出现的拍）。 */
function slotLifecycleBeats(sb: MotionStoryboard, role: 'focus' | 'support' | 'asset', beats: StoryboardBeat[]): SlotLifecycleBeats {
  const element = sb.elements?.find((el) => el.role === role);
  if (!element) return {};
  const result: SlotLifecycleBeats = {};
  beats.forEach((beat, index) => {
    const lifecycle = beat.lifecycle;
    if (!lifecycle) return;
    if (result.enter == null && lifecycle.enter?.includes(element.id)) result.enter = index;
    if (result.update == null && lifecycle.update?.includes(element.id)) result.update = index;
    if (result.collapse == null && lifecycle.collapse?.includes(element.id)) result.collapse = index;
    if (result.exit == null && lifecycle.exit?.includes(element.id)) result.exit = index;
  });
  return result;
}

/** 把槽位生命周期编译为 MotionSlot lifecycle 属性片段（分镜未声明的项不输出）。 */
function lifecycleAttr(enter: number, lc: SlotLifecycleBeats): string {
  let attr = `enter: beats[${enter}]`;
  if (lc.update != null) attr += `, update: beats[${lc.update}]`;
  if (lc.collapse != null) attr += `, collapse: beats[${lc.collapse}]`;
  if (lc.exit != null) attr += `, exit: beats[${lc.exit}]`;
  return attr;
}

function makeCtx(sb: MotionStoryboard): CompileCtx {
  const beats = beatsOf(sb);
  const focus =
    sb.focus && Number.isInteger(sb.focus.beat) && sb.focus.beat >= 0 && sb.focus.beat < beats.length
      ? sb.focus.beat
      : -1;
  const mainLifecycle = slotLifecycleBeats(sb, 'focus', beats);
  const enter = mainLifecycle.enter ?? (focus > 0 ? focus : beats.length > 1 ? 1 : 0);
  const anchorsLiteral = `[${beats
    .map((b, i) => (i === 0 ? 'null' : b.cue == null ? 'null' : String(b.cue)))
    .join(', ')}]`;
  const emphasis = sb.focus?.emphasis;
  const sweep = emphasis === 'underline-sweep' && focus >= 0;
  return {
    beats,
    enter,
    focus,
    emphasisAttr: emphasis && !sweep ? ` emphasis=${q(emphasis)}` : '',
    anchorsLiteral,
    mainLifecycle,
    headerLifecycle: slotLifecycleBeats(sb, 'support', beats),
    assetLifecycle: slotLifecycleBeats(sb, 'asset', beats),
    sweep,
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
    const limit = data.variant === 'bar' ? 4 : data.variant === 'horizontal-bars' ? 5 : 6;
    const items = data.items.slice(0, limit);
    const literal = items
      .map((it) => `{ label: ${q(String(it.label))}, value: ${numberLiteral(Number(it.value) || 0)}${it.display ? `, display: ${q(String(it.display))}` : ''} }`)
      .join(', ');
    if (data.variant === 'horizontal-bars') {
      return { imports: ['HorizontalBars'], jsx: `<HorizontalBars items={[${literal}]} ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
    }
    if (data.variant === 'bar') {
      return { imports: ['BarChart'], jsx: `<BarChart items={[${literal}]} ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
    }
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
    const limit = data.variant === 'rank' || data.variant === 'check' ? 5 : 4;
    const items = data.items.slice(0, limit).map(String);
    if (data.variant === 'rank') {
      const literal = items.map((item) => `{ label: ${q(item)} }`).join(', ');
      return { imports: ['RankList'], jsx: `<RankList items={[${literal}]} ${perItemBeatAttr(ctx, items.length)}${focusIndexAttr(ctx, items.length)}${ctx.emphasisAttr} />` };
    }
    if (data.variant === 'check') {
      return { imports: ['ChecklistPop'], jsx: `<ChecklistPop items={[${items.map(q).join(', ')}]} ${perItemBeatAttr(ctx, items.length)}${focusIndexAttr(ctx, items.length)}${ctx.emphasisAttr} />` };
    }
    if (data.variant === 'keyword-scan') {
      // 条内关键词按下标配对，空串 = 该条不点亮；全部缺省时退化为普通 ListBuild。
      const keywords = items.map((_, i) => {
        const kw = data.keywords?.[i];
        return typeof kw === 'string' ? kw.trim() : '';
      });
      const keywordsAttr = keywords.some(Boolean) ? ` keywords={[${keywords.map(q).join(', ')}]}` : '';
      return { imports: ['ListBuild'], jsx: `<ListBuild items={[${items.map(q).join(', ')}]}${keywordsAttr} ${perItemBeatAttr(ctx, items.length)}${focusIndexAttr(ctx, items.length)}${ctx.emphasisAttr} />` };
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
  if (
    data?.variant === 'citation' &&
    typeof data.text === 'string' && data.text.trim() &&
    typeof data.source === 'string' && data.source.trim()
  ) {
    const dateAttr = data.date ? ` date=${q(String(data.date))}` : '';
    return { imports: ['CitationCard'], jsx: `<CitationCard text=${q(data.text.trim())} source=${q(data.source.trim())}${dateAttr} ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
  }
  if (data?.variant === 'word-pop' && Array.isArray(data.words)) {
    // 逐词弹入：语义块由分镜切分（编译器不再分词）；source 沿用 QuoteBlock 的 mono 出处行。
    const words = data.words.map((w) => String(w ?? '').trim()).filter(Boolean).slice(0, 8);
    if (words.length >= 2) {
      const sourceJsx = typeof data.source === 'string' && data.source.trim()
        ? `\n          <Kicker text=${q(`—— ${data.source.trim()}`)} ${beatAttr(ctx)} accent={false} />`
        : '';
      return {
        imports: ['WordPop'],
        jsx: `<><WordPop words={[${words.map(q).join(', ')}]} font="display" size={0.075} weight={520} ${beatAttr(ctx)}${ctx.emphasisAttr} />${sourceJsx}</>`,
      };
    }
  }
  const text = typeof data?.text === 'string' && data.text.trim()
    ? data.text.trim()
    : cleanScreenText(ctx.beats[ctx.focus]?.adds ?? sb.claim, 22);
  const sourceAttr = data?.source ? ` source=${q(String(data.source))}` : '';
  return { imports: ['QuoteBlock'], jsx: `<QuoteBlock text=${q(text)}${sourceAttr} ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
}

function buildConcept(sb: MotionStoryboard, ctx: CompileCtx): CompiledMain {
  const data = sb.data as StoryboardConceptData | undefined;
  if (data?.variant === 'anchor') {
    // 关键词锚点：term 或 keywords（1~3 个），角落小字 WordPop 逐词弹入，不抢主视觉。
    const words = (Array.isArray(data.keywords) && data.keywords.length > 0 ? data.keywords : [data.term])
      .map((word) => String(word ?? '').trim())
      .filter(Boolean)
      .slice(0, 3);
    if (words.length > 0) {
      return {
        imports: ['WordPop'],
        jsx: `<WordPop words={[${words.map(q).join(', ')}]} font="display" size={0.04} weight={600} ${beatAttr(ctx)}${ctx.emphasisAttr} />`,
      };
    }
  }
  if (data?.variant === 'section' && typeof data?.title === 'string' && data.title.trim()) {
    const indexAttr = data.index ? ` index=${q(String(data.index))}` : '';
    const subtitleAttr = data.subtitle ? ` subtitle=${q(String(data.subtitle))}` : '';
    return { imports: ['SectionTitle'], jsx: `<SectionTitle${indexAttr} title=${q(data.title.trim())}${subtitleAttr} ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
  }
  if (data?.variant === 'typewriter' && typeof data.term === 'string' && data.term.trim()) {
    // 标题逐字上屏打字机；definition 作为副行在打完后淡入。
    const detailAttr = typeof data.definition === 'string' && data.definition.trim() ? ` detail=${q(data.definition.trim())}` : '';
    return { imports: ['TypewriterText'], jsx: `<TypewriterText text=${q(data.term.trim())} font="display" size={0.09} weight={650}${detailAttr} ${beatAttr(ctx)}${ctx.emphasisAttr} />` };
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

/**
 * asset-led 主槽：单行增量注释（≤14 字）。大图小字——素材承担叙事，文字只做注脚；
 * 取 focus 元素 content（缺省 focus 拍文本 / claim），WordPop 整行弹入，与 corner-anchor 同手法。
 */
function buildAssetLedNote(sb: MotionStoryboard, ctx: CompileCtx): CompiledMain {
  const focusContent = sb.elements?.find((el) => el.role === 'focus')?.content;
  const note =
    cleanScreenText(focusContent ?? ctx.beats[ctx.focus]?.adds ?? sb.claim, 14) ||
    cleanScreenText(sb.claim, 14);
  return {
    imports: ['WordPop'],
    jsx: `<WordPop words={[${q(note)}]} font="display" size={0.034} weight={600} ${beatAttr(ctx)}${ctx.emphasisAttr} />`,
  };
}

const VALID_LAYOUTS = new Set<StoryboardLayout>([
  'single-focus',
  'title-hero',
  'split-compare',
  'chart-with-kicker',
  'list-with-kicker',
  'asset-aside',
  'asset-led',
  'corner-anchor',
]);

/** 素材主导布局：asset 槽有独立网格列，素材未物化时整体退回载体默认布局。 */
const ASSET_DRIVEN_LAYOUTS = new Set<StoryboardLayout>(['asset-aside', 'asset-led']);

/** 关键词锚点卡（concept + anchor）：编译器强制 corner-anchor 布局，保证不抢主视觉。 */
function isAnchorCard(sb: MotionStoryboard): boolean {
  return sb.carrier === 'concept' && (sb.data as StoryboardConceptData | undefined)?.variant === 'anchor';
}

export interface CompileMotionCardOptions {
  /**
   * 分镜声明的 assets 是否已解析出可渲染绑定（素材由 overlay 素材层按 binding 渲染，不进 TSX）。
   * false 时确定性降级：asset-aside / asset-led 布局退回载体默认布局——主内容不再被压缩、
   * 资产格不留死空，卡片仍是完整可用的纯文字卡。缺省（undefined）保持旧行为：完全按分镜 layout 编译。
   */
  assetsResolved?: boolean;
  /**
   * 自动运镜 / 自动标注（默认开启）。
   *
   * 实测教训：99% 的卡走确定性模板编译，导演极少主动声明 camera / annotate，
   * 光靠提示词请求会得到 0% 利用率。所以把"焦点该被指出来"做成系统默认行为，
   * 分镜显式声明时以声明为准；关掉它可回到纯载体形态（A/B 对照用）。
   */
  autoEmphasisMotion?: boolean;
}

/**
 * data-hero 的多项变体：stat-grid 是 2×2 指标网格，不是单个焦点——
 * 圈选会把整片网格套进一个椭圆并穿过文字（A/B 实拍确认），必须排除。
 */
const MULTI_ITEM_HERO_VARIANTS = new Set(['stat-grid']);

/**
 * 系统默认的焦点运镜：焦点拍推近、收束拍拉开。
 * 只在有明确焦点拍且总拍数 ≥2 时给——单拍卡推近没有对照，反而像抖动。
 */
function autoCameraShots(sb: MotionStoryboard, ctx: CompileCtx): StoryboardCameraShot[] {
  if (ctx.focus <= 0 || ctx.beats.length < 2) return [];
  const shots: StoryboardCameraShot[] = [{ beat: ctx.focus, move: 'push-in', target: 'main' }];
  const last = ctx.beats.length - 1;
  if (last > ctx.focus) shots.push({ beat: last, move: 'pull-out' });
  return shots;
}

/**
 * 系统默认的焦点标注——按 A/B 实拍结论收敛到"只在确定安全且确定可见"的两种：
 * - 单值数据大字 → box：矩形贴合内容盒，永不穿过文字（圈选椭圆内切于矩形，一定切到边角文字）；
 * - 金句 → underline：底线在任何底色上都可见（聚光灯在近黑底上压暗等于没压，实拍确认不可用）。
 * 其余载体一律不自动标注：多项载体自身有 focusIndex 高亮，概念卡本就是克制留白。
 */
function autoAnnotations(
  sb: MotionStoryboard,
  ctx: CompileCtx,
  layout: StoryboardLayout,
  presetTokensJson: string,
): StoryboardAnnotation[] {
  if (ctx.focus <= 0 || layout === 'corner-anchor') return [];
  const variant = (sb.data as { variant?: string } | undefined)?.variant;
  if (sb.carrier === 'quote') return [{ beat: ctx.focus, kind: 'underline', target: 'main' }];
  if (sb.carrier === 'data-hero' && !MULTI_ITEM_HERO_VARIANTS.has(variant ?? '')) {
    // glass / panel 预设已给内容块画了面和边框，再描一圈就是双边框——退回底线（同样指得清楚，不冲突）
    const panelled = /"kind"\s*:\s*"(glass|panel)"/.test(presetTokensJson);
    return [{ beat: ctx.focus, kind: panelled ? 'underline' : 'box', target: 'main' }];
  }
  return [];
}

function resolveLayout(sb: MotionStoryboard, opts?: CompileMotionCardOptions): StoryboardLayout {
  if (sb.layout && VALID_LAYOUTS.has(sb.layout)) {
    // 素材未能物化（生成失败 / 手动取消 / 未声明 assets）时 asset 布局退回载体默认布局。
    if (!(ASSET_DRIVEN_LAYOUTS.has(sb.layout) && opts?.assetsResolved === false)) {
      if (sb.layout !== 'asset-led') return sb.layout;
      // asset-led 大图小字容量守卫：文字区只容 1 focus（main 注）+ 1 support（header kicker）。
      // 文字区块超容时确定性降级——有资产占位退 asset-aside（文字区更宽），否则退 title-hero。
      const textBlocks = (sb.elements ?? []).filter((el) => el.role === 'focus' || el.role === 'support').length;
      if (textBlocks <= 2) return 'asset-led';
      const hasAssetBlock =
        (sb.elements ?? []).some((el) => el.role === 'asset') || (sb.assets?.length ?? 0) > 0;
      if (hasAssetBlock && opts?.assetsResolved !== false) return 'asset-aside';
      return 'title-hero';
    }
  }
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
 *
 * asset 槽约定：素材由 overlay 素材层（CardAssetLayer，按卡片记录 assetBindings 绝对定位）
 * 渲染，不进 TSX。布局为 asset-aside / asset-led 时编译器补发一个空的 <MotionSlot name="asset"> 占位——
 * 作用是把资产格显式保留在网格里（asset-aside 主内容约束在左列；asset-led 素材通栏居左、
 * 文字压缩为右列 kicker + 单行注释）并给布局探针一个 slot:asset 语义锚点；
 * 素材图像本身由 overlay 按 binding.placement 叠进该区域。opts.assetsResolved === false
 * （素材物化失败）时 asset 布局退回载体默认布局，卡片降级为纯文字卡。
 */
/**
 * 指示标注包裹：分镜声明了标注就把目标 JSX 裹进 Annotate，否则原样返回。
 * 标注层不占布局也不进容量预算，因此不影响既有的高度模拟。
 */
function wrapAnnotate(jsx: string, annotation: StoryboardAnnotation | undefined, indent: number): string {
  if (!annotation) return jsx;
  const pad = ' '.repeat(indent + 2);
  const attrs = [
    `kind=${q(annotation.kind)}`,
    `beat={beats[${annotation.beat}]}`,
    ...(annotation.side ? [`side=${q(annotation.side)}`] : []),
  ].join(' ');
  return `<Annotate ${attrs}>\n${pad}${jsx}\n${' '.repeat(indent)}</Annotate>`;
}

export function compileMotionCardFromStoryboard(
  sb: MotionStoryboard,
  presetTokensJson: string,
  opts?: CompileMotionCardOptions,
): string {
  const ctx = makeCtx(sb);
  const layout = isAnchorCard(sb) ? 'corner-anchor' : resolveLayout(sb, opts);
  // asset-led 主槽只放单行增量注释（大图小字），不渲染载体的完整原语；
  // 降级（resolveLayout 退回 asset-aside / title-hero / 载体默认）时仍按载体正常编译。
  const builder = CARRIER_BUILDERS[sb.carrier] ?? ((s: MotionStoryboard, c: CompileCtx) => asListFallback(s, c));
  const main = layout === 'asset-led' ? buildAssetLedNote(sb, ctx) : builder(sb, ctx);

  // 运镜 / 标注：分镜声明优先，未声明时按载体与焦点拍自动补（autoEmphasisMotion 可关）。
  const auto = opts?.autoEmphasisMotion !== false;
  const declaredShots = (sb.camera ?? []).filter((shot) => shot.beat < ctx.beats.length);
  const declaredAnnotations = (sb.annotate ?? []).filter((item) => item.beat < ctx.beats.length);
  const shots = declaredShots.length || !auto ? declaredShots : autoCameraShots(sb, ctx);
  const annotations =
    declaredAnnotations.length || !auto
      ? declaredAnnotations
      : autoAnnotations(sb, ctx, layout, presetTokensJson);
  const mainAnnotation = annotations.find((item) => (item.target ?? 'main') === 'main');
  const headerAnnotation = annotations.find((item) => item.target === 'header');
  const shotsAttr = shots.length
    ? ` layout=${q(layout)} shots={[${shots
        .map(
          (shot) =>
            `{ beat: beats[${shot.beat}], move: ${q(shot.move)}${shot.target ? `, target: ${q(shot.target)}` : ''} }`,
        )
        .join(', ')}]}`
    : '';

  const imports = [
    ...new Set([
      'CardStage',
      'SafeLayout',
      'MotionSlot',
      'useTimingPlan',
      'Kicker',
      ...(annotations.length ? ['Annotate'] : []),
      ...(ctx.sweep ? ['UnderlineSweep'] : []),
      ...main.imports,
    ]),
  ].join(', ');
  // header 生命周期：分镜声明优先；未声明 collapse 时沿用旧行为（focus 拍收为弱辅助）。
  const headerLifecycle: SlotLifecycleBeats = {
    ...ctx.headerLifecycle,
    collapse: ctx.headerLifecycle.collapse ?? (ctx.focus > 0 ? ctx.focus : undefined),
  };
  const headerBeat = ctx.headerLifecycle.enter ?? 0;
  const kickerJsx = `<Kicker text=${q(headerText(sb))} beat={beats[${headerBeat}]} />`;
  const headerSlot =
    layout === 'single-focus' || layout === 'corner-anchor'
      ? ''
      : `        <MotionSlot name="header" role="support" lifecycle={{ ${lifecycleAttr(headerBeat, headerLifecycle)} }}>
          ${wrapAnnotate(kickerJsx, headerAnnotation, 10)}
        </MotionSlot>\n`;
  const sweepJsx = ctx.sweep ? `\n          <UnderlineSweep beat={beats[${ctx.focus}]} />` : '';
  // asset 占位格：素材图像由 overlay 素材层渲染，这里只保留网格区域与探针锚点。
  const assetSlot =
    ASSET_DRIVEN_LAYOUTS.has(layout)
      ? `        <MotionSlot name="asset" role="asset" lifecycle={{ ${lifecycleAttr(ctx.assetLifecycle.enter ?? ctx.enter, ctx.assetLifecycle)} }} />\n`
      : '';

  return `import { ${imports} } from '@lingji/motion-kit';

const TOKENS = ${presetTokensJson};

export default function Card({ cues = [], timingPlan }) {
  const beats = useTimingPlan(timingPlan, cues, ${ctx.anchorsLiteral});
  return (
    <CardStage tokens={TOKENS}${shotsAttr}>
      <SafeLayout variant=${q(layout)}>
${headerSlot}        <MotionSlot name="main" role="focus" lifecycle={{ ${lifecycleAttr(ctx.enter, ctx.mainLifecycle)} }}>
          ${wrapAnnotate(`${main.jsx}${sweepJsx}`, mainAnnotation, 10)}
        </MotionSlot>
${assetSlot}      </SafeLayout>
    </CardStage>
  );
}
`;
}
