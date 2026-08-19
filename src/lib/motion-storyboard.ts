/**
 * motion-storyboard —— 导演产出的结构化分镜（视觉论证设计）契约与机器校验。
 *
 * JSON 分镜换来确定性校验：cue 锚定合法性 / 单调性、信息密度上限、
 * 数字防编造（逐字稿匹配）、载体枚举（结构上排除具象实物）。
 * 校验 error 回喂导演重出，不进入雕刻阶段。
 */
import {
  MOTION_EMPHASIS_KINDS,
  type MotionEmphasisKind,
  type TimingBeatRole,
} from '../types/motion';
import type { StoryboardAssetRequest } from '../types/assets';
import type { AISegmentSemanticType } from '../types/ai';

export const STORYBOARD_CARRIERS = [
  'data-hero',
  'comparison',
  'table',
  'trend',
  'list-build',
  'process',
  'quote',
  'concept',
  'timeline',
  'matrix',
  'funnel',
  'network',
  'before-after',
  'stacked-composition',
] as const;
export type StoryboardCarrier = (typeof STORYBOARD_CARRIERS)[number];

/** 载体展示元信息（唯一中文标签真源；UI / 预览分组统一从这里取）。 */
export const CARRIER_META: Record<StoryboardCarrier, { label: string; description: string }> = {
  'data-hero': { label: '数据大字', description: '一个核心数字直接证明论点' },
  comparison: { label: '对比', description: 'A/B 两方或多指标对照' },
  table: { label: '数据表', description: '多行多列结构化数据' },
  trend: { label: '趋势', description: '随时间变化的趋势与关键拐点' },
  'list-build': { label: '列表', description: '并列要点逐条建立' },
  process: { label: '流程', description: '步骤与因果的依次连接' },
  quote: { label: '引用', description: '金句、来源引用与重点标注' },
  concept: { label: '概念', description: '术语定义与概念拆解' },
  timeline: { label: '时间线', description: '历史阶段与版本演进' },
  matrix: { label: '象限', description: '二维定位与优先级判断' },
  funnel: { label: '漏斗', description: '层层筛选与转化收窄' },
  network: { label: '关系网', description: '人物 / 组织 / 概念关系' },
  'before-after': { label: '前后对照', description: '旧 vs 新、误区 vs 事实' },
  'stacked-composition': { label: '堆叠构成', description: '占比与层级堆叠' },
};

export const STORYBOARD_EMPHASES = MOTION_EMPHASIS_KINDS;

/** 强调动效中文标签（UI 统一从这里取）。 */
export const EMPHASIS_LABELS: Record<MotionEmphasisKind, string> = {
  'countup-settle': '数字落定',
  slam: '重锤',
  'underline-sweep': '下划线',
  brighten: '提亮',
};

/** 节拍角色中文标签（UI 统一从这里取）。 */
export const BEAT_ROLE_LABELS: Record<TimingBeatRole, string> = {
  anticipation: '预备',
  reveal: '揭示',
  emphasis: '强调',
  hold: '保持',
  resolve: '收束',
};

export type StoryboardBeatKind = 'build' | 'transform' | 'accent';
export const STORYBOARD_BEAT_ROLES = ['anticipation', 'reveal', 'emphasis', 'hold', 'resolve'] as const;
export const STORYBOARD_LAYOUTS = [
  'single-focus',
  'title-hero',
  'split-compare',
  'chart-with-kicker',
  'list-with-kicker',
  'asset-aside',
  'asset-led',
  'corner-anchor',
] as const;
export type StoryboardLayout = (typeof STORYBOARD_LAYOUTS)[number];
export type StoryboardElementRole = 'focus' | 'support' | 'asset' | 'decorative';
export type StoryboardElementSlot = 'header' | 'main' | 'asset' | 'background';

export interface StoryboardElement {
  id: string;
  role: StoryboardElementRole;
  slot: StoryboardElementSlot;
  /** 一个元素代表一个语义区块，不代表区块内的每个列表项。 */
  content: string;
  /** 对 CardStage 可用高度 CH 的占用比例；机器会按生命周期逐拍累计。 */
  heightRatio: number;
  priority?: 1 | 2 | 3;
  assetSlot?: string;
}

export interface StoryboardLifecycle {
  enter?: string[];
  update?: string[];
  collapse?: string[];
  exit?: string[];
}

export interface StoryboardCapacityBudget {
  maxVisible: number;
  maxHeightRatio: number;
}

/* ---------- 叙事运镜与指示标注：导演只声明意图，kit / 编译器确定性落地 ---------- */

export const STORYBOARD_CAMERA_MOVES = ['push-in', 'pull-out', 'pan-left', 'pan-right', 'focus'] as const;
export type StoryboardCameraMove = (typeof STORYBOARD_CAMERA_MOVES)[number];

/** 整卡运镜上限：超过就晕，normalize 直接截断。 */
export const MAX_CAMERA_SHOTS = 2;

export interface StoryboardCameraShot {
  /** 该运镜发生在第几拍（beats 下标） */
  beat: number;
  move: StoryboardCameraMove;
  /** focus / push-in 的目标槽位 */
  target?: 'header' | 'main' | 'asset';
}

export const STORYBOARD_ANNOTATE_KINDS = [
  'circle',
  'box',
  'underline',
  'highlight',
  'strike',
  'arrow',
  'spotlight',
] as const;
export type StoryboardAnnotateKind = (typeof STORYBOARD_ANNOTATE_KINDS)[number];

/** 整卡标注上限：指多了等于没指。 */
export const MAX_ANNOTATIONS = 2;

export interface StoryboardAnnotation {
  /** 标注出现在第几拍（beats 下标） */
  beat: number;
  kind: StoryboardAnnotateKind;
  /** 被指的槽位；只有 main / header 可标 */
  target?: 'main' | 'header';
  /** arrow 的指入方向 */
  side?: 'left' | 'right' | 'top' | 'bottom';
}

export interface StoryboardBeat {
  /** 讲出该拍内容的句索引（对应运行时 cues[k]）；第 0 拍可为 null（入场） */
  cue: number | null;
  kind: StoryboardBeatKind;
  /** 剪辑节奏角色：决定该拍更偏预备、揭示、强调、保持还是收束。旧分镜可省略，normalize 会补默认值。 */
  role?: TimingBeatRole;
  /** 新出现的元素及内容；数字 / 专名必须来自逐字稿原文 */
  adds: string;
  /** 已有元素如何变化（保持 / 转化 / 让位 / 弱化）；可省略 */
  changes?: string;
  /** 一句动作意图（不含帧数 / 缓动参数） */
  motion?: string;
  /** 元素生命周期：旧内容可以 collapse / exit，避免每拍只增不减。 */
  lifecycle?: StoryboardLifecycle;
}

/**
 * Agent 原子合成只描述已批准素材与叙事节拍的关系，不承载布局模板。
 * `slot` 是运行时素材绑定标识，不是 MotionSlot / SafeLayout 的版式槽位。
 */
export interface CompositeStoryboardMediaUse {
  assetId?: string;
  slot?: string;
  purpose: string;
  beats: number[];
}

export interface CompositeStoryboardAssetRef {
  assetId: string;
  slot: string;
  usage: 'required' | 'optional';
}

/**
 * 偏离整片 bible 指定载体的正当理由（枚举，防自由发挥）。
 * 只有写了理由，"图形载体 → 文字载体"的降密度偏离才放行。
 */
export const CARRIER_DEVIATION_REASONS = ['no-data', 'data-not-comparable', 'transcript-mismatch'] as const;
export type CarrierDeviationReason = (typeof CARRIER_DEVIATION_REASONS)[number];

/**
 * 信息密度分级——闸门只拦"图形 → 纯文字"这一类塌陷。
 * 实测（152 张真实卡）：整片 bible 规划 37 张趋势图，单段导演一张没画，
 * 全部改写成一个大数字或一句概念；83% 的段落偏离了指令且方向高度一致。
 */
const STRUCTURED_CARRIERS = new Set<string>([
  'trend', 'table', 'comparison', 'matrix', 'funnel', 'network',
  'timeline', 'stacked-composition', 'before-after', 'list-build', 'process',
]);
const NARRATIVE_CARRIERS = new Set<string>(['concept', 'quote']);

export interface MotionStoryboard {
  claim: string;
  carrier: StoryboardCarrier;
  /** 偏离 bible 指定载体时必须给的理由；只在"图形 → 文字"降密度偏离时被检查。 */
  carrierDeviation?: { reason: CarrierDeviationReason; note?: string };
  layout?: StoryboardLayout;
  elements?: StoryboardElement[];
  capacity?: StoryboardCapacityBudget;
  scene: string;
  /** 本卡需要的可复用视觉资产；由资产解析器优先匹配已有素材，缺失进入待生成队列。 */
  assets?: StoryboardAssetRequest[];
  focus?: { beat: number; emphasis?: MotionEmphasisKind; subject?: string };
  /** 仅 agent-composite 使用；普通 Motion Card 忽略。 */
  media?: CompositeStoryboardMediaUse[];
  /** 叙事运镜（可选，≤2 次）：把镜头推向正在讲的那块内容。 */
  camera?: StoryboardCameraShot[];
  /** 指示标注（可选，≤2 个）：圈 / 框 / 划 / 指 / 聚光，讲解者的手。 */
  annotate?: StoryboardAnnotation[];
  beats: StoryboardBeat[];
  /**
   * 模板化结构化数据（可选）：有 data 时上屏内容以 data 为准，编译器直接映射为原语 props；
   * 缺省时编译器回落为从 beats 文本提取。字段按 carrier 解释，见 validateStoryboardData。
   */
  data?: StoryboardData;
}

/* ---------- 模板化结构化数据（per-carrier） ---------- */

export interface StoryboardHeroData {
  value?: number;
  unit?: string;
  label?: string;
  max?: number;
  variant?: 'metric-pulse' | 'ring-counter' | 'scale-impact' | 'stat-grid';
  items?: Array<{ value: string; label: string }>;
}
export interface StoryboardComparisonData {
  left?: { label: string; value: string };
  right?: { label: string; value: string };
  items?: Array<{ label: string; value: number; display?: string }>;
  variant?: 'column' | 'horizontal-bars' | 'bar';
}
export interface StoryboardTableData {
  columns: string[];
  rows: string[][];
}
export interface StoryboardTrendData {
  points: number[];
  startLabel?: string;
  endLabel?: string;
  markers?: Array<{ index: number; label?: string }>;
}
export interface StoryboardListData {
  items: string[];
  /** keyword-scan = 条目逐条揭示后条内关键词变色点亮（keywords 与 items 按下标配对）。 */
  variant?: 'rank' | 'check' | 'keyword-scan';
  /** keyword-scan 变体的条内关键词（可选；keywords[i] 属于 items[i]，空串 = 该条不点亮）。 */
  keywords?: string[];
}
export interface StoryboardProcessData {
  steps: string[];
  variant?: 'cause';
}
export interface StoryboardQuoteData {
  text: string;
  source?: string;
  /** citation 变体的可核验出处日期（如 "2024.12"）。 */
  date?: string;
  /** citation = 来源引用卡（CitationCard），必须带 source；word-pop = 正文按语义块逐词弹入（WordPop），必须带 words。 */
  variant?: 'citation' | 'word-pop';
  /** word-pop 变体的语义块切分（2~8 块，由导演切分，编译器不再分词）。 */
  words?: string[];
}
export interface StoryboardConceptData {
  term?: string;
  definition?: string;
  /** anchor 变体的多关键词形态：1~3 个关键词（每个 ≤6 字），与 term 二选一。 */
  keywords?: string[];
  hint?: string;
  index?: string;
  title?: string;
  subtitle?: string;
  /**
   * section = 章节标题卡（SectionTitle）；typewriter = 标题逐字上屏打字机（TypewriterText），definition 打完后淡入；
   * anchor = 关键词锚点卡：term（≤6 字）或 keywords（1~3 个）二选一，不允许 definition——
   * 只做角落小字强调（编译为 corner-anchor 布局 + WordPop），让观众聚焦口播。
   */
  variant?: 'section' | 'typewriter' | 'anchor';
}
export interface StoryboardTimelineData {
  items: string[];
}
export interface StoryboardMatrixData {
  items: Array<{ label: string; x: number; y: number; focus?: boolean }>;
  xLabel?: string;
  yLabel?: string;
}
export interface StoryboardFunnelData {
  steps: Array<{ label: string; value?: string }>;
}
export interface StoryboardNetworkData {
  nodes: string[];
  links?: Array<[number, number]>;
}
export interface StoryboardBeforeAfterData {
  before: string;
  after: string;
  variant?: 'myth-fact';
}
export interface StoryboardStackedData {
  items: Array<{ label: string; value: number; display?: string }>;
  variant?: 'donut';
}

export type StoryboardData =
  | StoryboardHeroData
  | StoryboardComparisonData
  | StoryboardTableData
  | StoryboardTrendData
  | StoryboardListData
  | StoryboardProcessData
  | StoryboardQuoteData
  | StoryboardConceptData
  | StoryboardTimelineData
  | StoryboardMatrixData
  | StoryboardFunnelData
  | StoryboardNetworkData
  | StoryboardBeforeAfterData
  | StoryboardStackedData;

export interface StoryboardValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const MAX_VISIBLE_SEMANTIC_BLOCKS = 3;
const MAX_HEIGHT_RATIO = 0.72;

function validateCapacityModel(
  sb: MotionStoryboard,
  strict: boolean,
  errors: string[],
  warnings: string[],
): void {
  if (!sb.layout || !(STORYBOARD_LAYOUTS as readonly string[]).includes(sb.layout)) {
    (strict ? errors : warnings).push(`缺少合法 layout（${STORYBOARD_LAYOUTS.join(' | ')}）`);
  }
  if (!Array.isArray(sb.elements) || sb.elements.length === 0) {
    (strict ? errors : warnings).push('缺少 elements，无法计算同时驻留区块与容量预算');
    return;
  }
  if (!sb.capacity || !Number.isFinite(sb.capacity.maxVisible) || !Number.isFinite(sb.capacity.maxHeightRatio)) {
    (strict ? errors : warnings).push('缺少 capacity.maxVisible / maxHeightRatio');
    return;
  }
  if (sb.capacity.maxVisible > MAX_VISIBLE_SEMANTIC_BLOCKS) {
    errors.push(`capacity.maxVisible=${sb.capacity.maxVisible} 超过硬上限 ${MAX_VISIBLE_SEMANTIC_BLOCKS}`);
  }
  if (sb.capacity.maxHeightRatio > MAX_HEIGHT_RATIO) {
    errors.push(`capacity.maxHeightRatio=${sb.capacity.maxHeightRatio} 超过内容盒上限 ${MAX_HEIGHT_RATIO}`);
  }

  const ids = new Set<string>();
  const byId = new Map<string, StoryboardElement>();
  const semanticSlots = new Set<string>();
  let focusCount = 0;
  let supportCount = 0;
  let assetCount = 0;
  for (const [index, element] of sb.elements.entries()) {
    if (!element?.id?.trim()) {
      errors.push(`元素 ${index} 缺少 id`);
      continue;
    }
    if (ids.has(element.id)) errors.push(`元素 id "${element.id}" 重复`);
    ids.add(element.id);
    byId.set(element.id, element);
    if (!['focus', 'support', 'asset', 'decorative'].includes(element.role)) {
      errors.push(`元素 ${element.id} role="${String(element.role)}" 不合法`);
    }
    if (!['header', 'main', 'asset', 'background'].includes(element.slot)) {
      errors.push(`元素 ${element.id} slot="${String(element.slot)}" 不合法`);
    }
    if (!element.content?.trim()) errors.push(`元素 ${element.id} 缺少 content`);
    if (!Number.isFinite(element.heightRatio) || element.heightRatio < 0 || element.heightRatio > MAX_HEIGHT_RATIO) {
      errors.push(`元素 ${element.id} heightRatio=${String(element.heightRatio)} 不合法`);
    }
    if (element.role === 'focus') {
      focusCount += 1;
      if (element.slot !== 'main') errors.push(`焦点元素 ${element.id} 必须放在 main 槽位`);
    }
    if (element.role === 'support') {
      supportCount += 1;
      if (element.slot !== 'header') errors.push(`辅助元素 ${element.id} 必须放在 header 槽位`);
    }
    if (element.role === 'asset') {
      assetCount += 1;
      if (element.slot !== 'asset') errors.push(`资产元素 ${element.id} 必须放在 asset 槽位`);
    }
    if (element.role !== 'decorative') {
      if (semanticSlots.has(element.slot)) errors.push(`槽位 ${element.slot} 被多个语义区块占用`);
      semanticSlots.add(element.slot);
    }
    if (element.role === 'asset' && !element.assetSlot) errors.push(`资产元素 ${element.id} 缺少 assetSlot`);
  }
  if (focusCount !== 1) errors.push(`elements 必须且只能有 1 个 focus，当前为 ${focusCount}`);
  if (supportCount > 1) errors.push(`elements 最多只能有 1 个 support，当前为 ${supportCount}`);
  if (assetCount > 1) errors.push(`elements 最多只能有 1 个 asset，当前为 ${assetCount}`);
  for (const asset of sb.assets ?? []) {
    if (asset.importance !== 'primary') continue;
    const reserved = sb.elements.some((element) => element.role === 'asset' && element.assetSlot === asset.slot);
    if (!reserved) errors.push(`主资产 ${asset.slot} 未在 elements 中声明 asset 占位区`);
  }

  const visible = new Set<string>();
  const collapsed = new Set<string>();
  let sawLifecycle = false;
  sb.beats.forEach((beat, beatIndex) => {
    const lifecycle = beat.lifecycle;
    if (!lifecycle) {
      if (strict) errors.push(`拍 ${beatIndex} 缺少 lifecycle`);
      return;
    }
    sawLifecycle = true;
    const operations = [
      ...((lifecycle.enter ?? []).map((id) => ['enter', id] as const)),
      ...((lifecycle.update ?? []).map((id) => ['update', id] as const)),
      ...((lifecycle.collapse ?? []).map((id) => ['collapse', id] as const)),
      ...((lifecycle.exit ?? []).map((id) => ['exit', id] as const)),
    ];
    const semanticOperations = operations.filter(([, id]) => byId.get(id)?.role !== 'decorative');
    if (semanticOperations.length > 3) {
      errors.push(`拍 ${beatIndex} 同时操作 ${semanticOperations.length} 个语义区块，超过上限 3`);
    }
    for (const [operation, id] of operations) {
      if (!byId.has(id)) {
        errors.push(`拍 ${beatIndex} 的 ${operation} 引用了未知元素 ${id}`);
        continue;
      }
      if (operation === 'enter') {
        visible.add(id);
        collapsed.delete(id);
      } else if (operation === 'collapse') {
        if (!visible.has(id)) errors.push(`拍 ${beatIndex} collapse 的元素 ${id} 尚未 enter`);
        collapsed.add(id);
      } else if (operation === 'exit') {
        visible.delete(id);
        collapsed.delete(id);
      } else if (!visible.has(id)) {
        errors.push(`拍 ${beatIndex} update 的元素 ${id} 尚未 enter`);
      }
    }
    const semanticVisible = [...visible].filter((id) => byId.get(id)?.role !== 'decorative');
    const heightRatio = semanticVisible.reduce((sum, id) => {
      const ratio = byId.get(id)?.heightRatio ?? 0;
      return sum + (collapsed.has(id) ? Math.min(0.08, ratio) : ratio);
    }, 0);
    if (semanticVisible.length > Math.min(MAX_VISIBLE_SEMANTIC_BLOCKS, sb.capacity!.maxVisible)) {
      errors.push(`拍 ${beatIndex} 同时驻留 ${semanticVisible.length} 个语义区块，超过容量预算`);
    }
    if (heightRatio > Math.min(MAX_HEIGHT_RATIO, sb.capacity!.maxHeightRatio) + 0.001) {
      errors.push(`拍 ${beatIndex} 预计占高 ${heightRatio.toFixed(2)}H，超过容量预算 ${sb.capacity!.maxHeightRatio.toFixed(2)}H`);
    }
  });
  if (strict && !sawLifecycle) errors.push('beats 未声明任何 lifecycle，无法验证元素退出与让位');

  const focusBeat = sb.focus?.beat;
  const focusId = sb.elements.find((element) => element.role === 'focus')?.id;
  if (focusBeat != null && focusId) {
    const focusLifecycle = sb.beats[focusBeat]?.lifecycle;
    const referenced = [
      ...(focusLifecycle?.enter ?? []),
      ...(focusLifecycle?.update ?? []),
    ].includes(focusId);
    if (!referenced) errors.push(`focus 拍 ${focusBeat} 未 enter/update 焦点元素 ${focusId}`);
  }
}

/* ---------- data 字段的机器校验（模板化编译的硬约束来源） ---------- */

/** 上屏文本长度上限：条目/标签 ≤14 字、标题 ≤10 字、金句/释义 ≤28 字（与提示词既有约束一致）。 */
const DATA_TEXT_MAX = 14;
const DATA_TITLE_MAX = 10;
const DATA_LONG_TEXT_MAX = 28;

function dataLen(text: unknown): number {
  return typeof text === 'string' ? text.trim().length : 0;
}

function checkDataText(value: unknown, max: number, what: string, errors: string[]): void {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`data.${what} 缺失或不是字符串`);
    return;
  }
  if (value.trim().length > max) {
    errors.push(`data.${what}「${value.trim().slice(0, max + 4)}…」${value.trim().length} 字超过上限 ${max} 字——上屏文案必须精简`);
  }
}

function checkOptionalDataText(value: unknown, max: number, what: string, errors: string[]): void {
  if (value == null) return;
  if (typeof value !== 'string') {
    errors.push(`data.${what} 不是字符串`);
    return;
  }
  if (value.trim().length > max) {
    errors.push(`data.${what} ${value.trim().length} 字超过上限 ${max} 字`);
  }
}

function checkDataNumber(value: unknown, what: string, errors: string[], opts: { min?: number; max?: number } = {}): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`data.${what} 缺失或不是数字`);
    return;
  }
  if (opts.min != null && value < opts.min) errors.push(`data.${what}=${value} 小于下限 ${opts.min}`);
  if (opts.max != null && value > opts.max) errors.push(`data.${what}=${value} 超过上限 ${opts.max}`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 数字防编造（data 版）：收集 data 里的内容数字（value/points/条目 value/文本内数字），交给逐字稿匹配。 */
function collectDataNumbers(data: Record<string, unknown>): string[] {
  const numbers: string[] = [];
  const pushNumber = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value) && (Math.abs(value) >= 10 || !Number.isInteger(value))) {
      numbers.push(String(value));
    }
  };
  const walk = (value: unknown, keyPath: string[]) => {
    if (typeof value === 'number') {
      // matrix 的 x/y 是布局坐标不是内容数字，跳过。
      if (keyPath.includes('x') || keyPath.includes('y')) return;
      pushNumber(value);
      return;
    }
    if (typeof value === 'string') {
      numbers.push(...extractCheckableNumbers(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, [...keyPath, String(i)]));
      return;
    }
    const record = asRecord(value);
    if (record) {
      for (const [k, v] of Object.entries(record)) walk(v, [...keyPath, k]);
    }
  };
  walk(data, []);
  return [...new Set(numbers)];
}

function collectQuantifiedScreenStrings(sb: MotionStoryboard): string[] {
  const texts: string[] = [];
  const collectStrings = (value: unknown): void => {
    if (typeof value === 'string') {
      texts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collectStrings);
      return;
    }
    const record = asRecord(value);
    if (record) Object.values(record).forEach(collectStrings);
  };
  collectStrings(sb.claim);
  for (const beat of sb.beats ?? []) {
    collectStrings(beat?.adds);
    collectStrings(beat?.changes);
  }
  collectStrings(sb.data);
  for (const element of sb.elements ?? []) collectStrings(element?.content);
  return texts;
}

/** 卡面数量一律使用阿拉伯数字；专有名词中的“一”等非数量文字不会命中。 */
function collectChineseScreenNumerals(sb: MotionStoryboard): string[] {
  return [...new Set(collectQuantifiedScreenStrings(sb).flatMap(extractChineseQuantityLiterals))];
}

function checkScreenNumeralStyle(sb: MotionStoryboard): string[] {
  const literals = collectChineseScreenNumerals(sb);
  if (literals.length === 0) return [];
  return [
    `卡面可量化信息必须使用阿拉伯数字，检测到中文数字 [${literals.slice(0, 8).join('、')}]；` +
      `请保持原始精度改写，例如“百分之一百二十四点三”→“124.3%”、“十七万九千八百四十一辆”→“179,841辆”，不得换算或四舍五入`,
  ];
}

/* ---------- 文字防复述（卡面文字不得整段复述口播，底部已有完整字幕通道） ---------- */

/** 触发复述判定的重合比例：卡面文字被逐字稿覆盖超过该比例即复述。 */
export const REPETITION_OVERLAP_RATIO = 0.7;
/** 触发复述判定的最少重合字符数（低于此属于短文本噪声，豁免）。 */
export const REPETITION_MIN_MATCHED_CHARS = 14;
/** kicker 级短标签豁免上限：归一化后 ≤ 该字数的文案不参与重合度计算。 */
export const REPETITION_KICKER_MAX_CHARS = 6;

/**
 * 复述检测适用的纯文字阐述类载体。quote 豁免（金句本来就是原话上屏）；
 * 图形 / 数据载体（data-hero / comparison / table / trend / matrix / funnel /
 * network / before-after / stacked-composition）提供的是结构化增量，不查。
 */
const REPETITION_CHECK_CARRIERS: ReadonlySet<string> = new Set(['concept', 'list-build', 'process', 'timeline']);

/**
 * 重合度归一化：先剥离数字（数字防编造已强制数字出自原文，是合法引用，不计入复述），
 * 再去掉全部空白 / 标点 / 符号，只留下可比对的字面字符。
 */
function normalizeForOverlap(text: string): string {
  return text
    .replace(/[0-9０-９]+(?:[.,，%％‰][0-9０-９]+)*/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 文本与逐字稿的最长公共子串（跳过已覆盖字符）；供贪心覆盖循环使用。 */
function longestCommonRun(text: string, covered: boolean[], transcript: string): { start: number; length: number } {
  let best = 0;
  let bestEnd = 0;
  let prev = new Array<number>(transcript.length + 1).fill(0);
  for (let i = 1; i <= text.length; i += 1) {
    const curr = new Array<number>(transcript.length + 1).fill(0);
    if (!covered[i - 1]) {
      for (let j = 1; j <= transcript.length; j += 1) {
        if (text[i - 1] === transcript[j - 1]) {
          curr[j] = prev[j - 1] + 1;
          if (curr[j] > best) {
            best = curr[j];
            bestEnd = i;
          }
        }
      }
    }
    prev = curr;
  }
  return { start: bestEnd - best, length: best };
}

/** 单条文案被逐字稿覆盖的字符数：贪心摘取 ≥2 字的最长公共子串，直到无可摘。 */
function coveredByTranscript(text: string, transcript: string): number {
  const covered = new Array<boolean>(text.length).fill(false);
  let total = 0;
  for (;;) {
    const run = longestCommonRun(text, covered, transcript);
    if (run.length < 2) break;
    for (let i = run.start; i < run.start + run.length; i += 1) covered[i] = true;
    total += run.length;
  }
  return total;
}

export interface TranscriptOverlap {
  /** 参与计算的卡面字符数（已剥离数字 / 标点，并剔除 kicker 级短标签）。 */
  totalChars: number;
  /** 其中能在逐字稿里匹配到的字符数。 */
  matchedChars: number;
  /** matchedChars / totalChars（totalChars 为 0 时为 0）。 */
  ratio: number;
}

/**
 * 卡面文字与逐字稿的字符级重合度（纯函数，供单测）：多条上屏文案合并计算——
 * 重合比例 > REPETITION_OVERLAP_RATIO 且重合字符 > REPETITION_MIN_MATCHED_CHARS
 * 即构成「复述口播」。transcript 归一化为空时返回全 0（跳过检测）。
 */
export function measureTranscriptOverlap(texts: string[], transcript: string): TranscriptOverlap {
  const haystack = normalizeForOverlap(transcript ?? '');
  if (!haystack) return { totalChars: 0, matchedChars: 0, ratio: 0 };
  let totalChars = 0;
  let matchedChars = 0;
  for (const raw of texts) {
    const text = normalizeForOverlap(raw ?? '');
    if (text.length <= REPETITION_KICKER_MAX_CHARS) continue;
    totalChars += text.length;
    matchedChars += coveredByTranscript(text, haystack);
  }
  return { totalChars, matchedChars, ratio: totalChars > 0 ? matchedChars / totalChars : 0 };
}

/** 收集卡面上屏文案：claim + data 内上屏字段；term / keywords / source 等锚点与出处字段豁免。 */
function collectScreenTexts(sb: MotionStoryboard): string[] {
  const texts: string[] = [sb.claim ?? ''];
  const data = asRecord(sb.data);
  if (!data) return texts;
  const pushAll = (value: unknown) => {
    for (const item of asArray(value)) if (typeof item === 'string') texts.push(item);
  };
  switch (sb.carrier) {
    case 'concept':
      // term / keywords 是关键词锚点（专名豁免），不参与复述计算。
      if (typeof data.definition === 'string') texts.push(data.definition);
      if (typeof data.hint === 'string') texts.push(data.hint);
      if (typeof data.title === 'string') texts.push(data.title);
      if (typeof data.subtitle === 'string') texts.push(data.subtitle);
      break;
    case 'list-build':
      pushAll(data.items);
      break;
    case 'process':
      pushAll(data.steps);
      break;
    case 'timeline':
      pushAll(data.items);
      break;
    default:
      break;
  }
  return texts;
}

/**
 * 文字防复述：阐述类卡的卡面文字不得整段复述口播（底部字幕通道已覆盖原文），
 * 卡面必须给字幕没有的增量——数据 / 结构 / 出处；关键词锚点仅限章节路标与系统弱卡
 * （见下方 anchor 硬闸门），不是复述的通用逃生出口。
 */
function checkTranscriptRepetition(sb: MotionStoryboard, transcript?: string): string[] {
  if (!transcript?.trim() || !REPETITION_CHECK_CARRIERS.has(sb.carrier)) return [];
  const { matchedChars, totalChars, ratio } = measureTranscriptOverlap(collectScreenTexts(sb), transcript);
  if (matchedChars > REPETITION_MIN_MATCHED_CHARS && ratio > REPETITION_OVERLAP_RATIO) {
    return [
      `卡面文字复述口播（与逐字稿重合 ${matchedChars}/${totalChars} 字，${Math.round(ratio * 100)}%）：` +
        `优先提炼增量（数据 / 结构 / 出处）或改用图形 / 素材载体；` +
        `关键词锚点仅当该段是章节路标或系统已标弱卡时可用，不得作为复述的逃生出口`,
    ];
  }
  return [];
}

/* ---------- anchor 使用硬闸门（角落小字仅限章节路标 / 系统降级标记段） ---------- */

/** anchor 硬闸门的段级上下文：由编排器从 planning（semanticType）与 Motion Bible carrierPlan 注入。 */
export interface AnchorGateContext {
  /** 段语义类型（planning 产出）；不可得（缺省）时闸门放行，避免卡死手动选段 / 旧项目等异常路径。 */
  semanticType?: AISegmentSemanticType;
  /** 本段 bible carrierPlan directive；缺省或无 preferredVariant 按「未标记」处理。 */
  bibleDirective?: {
    preferredCarrier?: string;
    preferredVariant?: string;
    intensity?: number;
  };
}

/**
 * 载体塌陷闸门：bible 规划了图形化载体，分镜却塌陷成纯文字载体（concept / quote）时，
 * 要求给出枚举理由。第 1 轮回喂纠正，之后降级为提醒——绝不因为这条把卡片打没。
 */
export function checkCarrierCollapse(
  sb: MotionStoryboard,
  ctx: AnchorGateContext & { attempt?: number },
): { errors: string[]; warnings: string[] } {
  const planned = ctx.bibleDirective?.preferredCarrier;
  if (!planned || !STRUCTURED_CARRIERS.has(planned)) return { errors: [], warnings: [] };
  if (!NARRATIVE_CARRIERS.has(sb.carrier)) return { errors: [], warnings: [] };
  const reason = sb.carrierDeviation?.reason;
  if (reason && (CARRIER_DEVIATION_REASONS as readonly string[]).includes(reason)) {
    return { errors: [], warnings: [] };
  }
  const message =
    `整片 bible 为本段规划了 carrier="${planned}"（图形化表达），分镜却塌陷成 "${sb.carrier}"（纯文字）。`
    + `两条出路二选一：① 按规划做 ${planned}——本段逐字稿里的数字 / 时间序列 / 多项对照就是它的数据；`
    + `② 本段确实没有可上屏的结构化数据，则保留当前载体并补字段 `
    + `"carrierDeviation":{"reason":"no-data|data-not-comparable|transcript-mismatch"}。`;
  return (ctx.attempt ?? 0) > 0 ? { errors: [], warnings: [message] } : { errors: [message], warnings: [] };
}

/**
 * 分镜是否使用了关键词锚点形态：concept 载体的 anchor 变体，或直接声明 corner-anchor
 * 布局（该布局专配 anchor 变体，编译器对 anchor 卡强制此布局，见 motion-card-templates）。
 */
export function storyboardUsesAnchor(sb: MotionStoryboard): boolean {
  if (sb.layout === 'corner-anchor') return true;
  if (sb.carrier !== 'concept') return false;
  return asRecord(sb.data)?.variant === 'anchor';
}

/**
 * anchor 硬闸门：concept(anchor) / corner-anchor 是「右上角小字」弱卡形态，仅放行——
 * (a) 章节路标段（semanticType=chapter-transition）；
 * (b) 系统弱卡降级标记段（bible directive preferredVariant='anchor'）。
 * 其余段打回：错误文案指出 bible 指定的载体与 intensity，要求产出满版增量卡，
 * 防止导演无视 directive 自选锚点（尤其复述打回后拿锚点当逃生出口）。
 */
export function checkAnchorGate(sb: MotionStoryboard, ctx: AnchorGateContext): string[] {
  if (!storyboardUsesAnchor(sb)) return [];
  if (!ctx.semanticType) return [];
  if (ctx.semanticType === 'chapter-transition') return [];
  if (ctx.bibleDirective?.preferredVariant === 'anchor') return [];
  const carrier = ctx.bibleDirective?.preferredCarrier ?? '未指定';
  const intensity = ctx.bibleDirective?.intensity;
  return [
    `关键词锚点（concept 的 anchor 变体 / corner-anchor 布局）仅限章节路标段或系统标记的弱卡使用；` +
      `本段 bible directive 指定 carrier=${carrier}${intensity != null ? `、intensity=${intensity}` : ''}，` +
      `请按 directive 产出满版增量卡（数据 / 图形 / 素材），不得以锚点逃避信息增量`,
  ];
}

/**
 * 逐 carrier 校验可选 data 字段：形状 / 条数上限 / 文本长度 / 数字忠于逐字稿。
 * data 校验失败的 error 与 cue / 容量 error 一样回喂导演重出。
 */
export function validateStoryboardData(
  sb: MotionStoryboard,
  ctx: { transcript?: string },
): { errors: string[] } {
  const errors: string[] = [];
  errors.push(...checkScreenNumeralStyle(sb));
  // 文字防复述：只依赖 claim / carrier / transcript，无 data 的回落路径同样要查。
  errors.push(...checkTranscriptRepetition(sb, ctx.transcript));
  const data = asRecord(sb.data);
  if (!sb.data) return { errors };
  if (!data) {
    errors.push('data 必须是对象');
    return { errors };
  }

  switch (sb.carrier) {
    case 'data-hero': {
      const variant = data.variant as StoryboardHeroData['variant'];
      if (variant != null && !['metric-pulse', 'ring-counter', 'scale-impact', 'stat-grid'].includes(variant)) {
        errors.push(`data.variant "${String(variant)}" 不合法（metric-pulse | ring-counter | scale-impact | stat-grid）`);
      }
      if (variant === 'stat-grid') {
        const items = asArray(data.items);
        if (items.length < 2 || items.length > 4) {
          errors.push(`stat-grid 需要 2~4 个指标格，当前 ${items.length}`);
        }
        items.forEach((item, i) => {
          const record = asRecord(item);
          checkDataText(record?.value, DATA_TEXT_MAX, `items[${i}].value`, errors);
          checkDataText(record?.label, DATA_TITLE_MAX, `items[${i}].label`, errors);
        });
      } else {
        checkDataNumber(data.value, 'value', errors);
        if (data.max != null) checkDataNumber(data.max, 'max', errors, { min: 0.0001 });
        if (variant === 'scale-impact' && data.max == null) {
          errors.push('scale-impact 变体必须提供 data.max（刻度尺上限）');
        }
        checkOptionalDataText(data.unit, 4, 'unit', errors);
        checkOptionalDataText(data.label, DATA_TITLE_MAX, 'label', errors);
      }
      break;
    }
    case 'comparison': {
      const variant = data.variant as StoryboardComparisonData['variant'];
      if (variant != null && !['column', 'horizontal-bars', 'bar'].includes(variant)) {
        errors.push(`data.variant "${String(variant)}" 不合法（column | horizontal-bars | bar）`);
      }
      if (variant != null || Array.isArray(data.items)) {
        const items = asArray(data.items);
        const limit = variant === 'bar' ? 4 : variant === 'horizontal-bars' ? 5 : 6;
        if (items.length < 2 || items.length > limit) {
          errors.push(`comparison items 需要 2~${limit} 项，当前 ${items.length}`);
        }
        items.forEach((item, i) => {
          const record = asRecord(item);
          checkDataText(record?.label, DATA_TEXT_MAX, `items[${i}].label`, errors);
          checkDataNumber(record?.value, `items[${i}].value`, errors);
          checkOptionalDataText(record?.display, DATA_TEXT_MAX, `items[${i}].display`, errors);
        });
      } else {
        for (const side of ['left', 'right'] as const) {
          const record = asRecord(data[side]);
          if (!record) {
            errors.push(`data.${side} 缺失（comparison 需要 left / right 或 items）`);
            continue;
          }
          checkDataText(record.label, DATA_TEXT_MAX, `${side}.label`, errors);
          checkDataText(record.value, DATA_TEXT_MAX, `${side}.value`, errors);
        }
      }
      break;
    }
    case 'table': {
      const columns = asArray(data.columns);
      const rows = asArray(data.rows);
      if (columns.length < 1 || columns.length > 4) {
        errors.push(`table columns 需要 1~4 列，当前 ${columns.length}`);
      }
      columns.forEach((col, i) => checkDataText(col, DATA_TITLE_MAX, `columns[${i}]`, errors));
      if (rows.length < 1 || rows.length > 5) {
        errors.push(`table rows 需要 1~5 行，当前 ${rows.length}`);
      }
      rows.forEach((row, i) => {
        const cells = asArray(row);
        if (columns.length > 0 && cells.length !== columns.length) {
          errors.push(`table 第 ${i + 1} 行有 ${cells.length} 格，与表头 ${columns.length} 列不一致`);
        }
        cells.forEach((cell, j) => checkDataText(cell, DATA_TEXT_MAX, `rows[${i}][${j}]`, errors));
      });
      break;
    }
    case 'trend': {
      const points = asArray(data.points);
      if (points.length < 2 || points.length > 8) {
        errors.push(`trend points 需要 2~8 个点，当前 ${points.length}`);
      }
      points.forEach((point, i) => checkDataNumber(point, `points[${i}]`, errors));
      checkOptionalDataText(data.startLabel, DATA_TITLE_MAX, 'startLabel', errors);
      checkOptionalDataText(data.endLabel, DATA_TITLE_MAX, 'endLabel', errors);
      asArray(data.markers).forEach((marker, i) => {
        const record = asRecord(marker);
        checkDataNumber(record?.index, `markers[${i}].index`, errors, { min: 0, max: Math.max(0, points.length - 1) });
        checkOptionalDataText(record?.label, DATA_TEXT_MAX, `markers[${i}].label`, errors);
      });
      break;
    }
    case 'list-build': {
      const variant = data.variant as StoryboardListData['variant'];
      if (variant != null && !['rank', 'check', 'keyword-scan'].includes(variant)) {
        errors.push(`data.variant "${String(variant)}" 不合法（rank | check | keyword-scan）`);
      }
      const limit = variant === 'rank' || variant === 'check' ? 5 : 4;
      const items = asArray(data.items);
      if (items.length < 1 || items.length > limit) {
        errors.push(`list-build items 需要 1~${limit} 条${limit === 5 ? '' : '（rank/check 变体可到 5）'}，当前 ${items.length}`);
      }
      items.forEach((item, i) => checkDataText(item, DATA_TEXT_MAX, `items[${i}]`, errors));
      if (variant === 'keyword-scan' && data.keywords != null) {
        const keywords = asArray(data.keywords);
        if (keywords.length > items.length) {
          errors.push(`keyword-scan keywords ${keywords.length} 个超过 items ${items.length} 条（按下标配对）`);
        }
        keywords.forEach((kw, i) => checkOptionalDataText(kw, 8, `keywords[${i}]`, errors));
      }
      break;
    }
    case 'process': {
      const variant = data.variant as StoryboardProcessData['variant'];
      if (variant != null && variant !== 'cause') {
        errors.push(`data.variant "${String(variant)}" 不合法（仅支持 cause）`);
      }
      const steps = asArray(data.steps);
      if (steps.length < 2 || steps.length > 4) {
        errors.push(`process steps 需要 2~4 步，当前 ${steps.length}`);
      }
      steps.forEach((step, i) => checkDataText(step, DATA_TEXT_MAX, `steps[${i}]`, errors));
      break;
    }
    case 'quote': {
      const variant = data.variant as StoryboardQuoteData['variant'];
      if (variant != null && !['citation', 'word-pop'].includes(variant)) {
        errors.push(`data.variant "${String(variant)}" 不合法（citation | word-pop）`);
      }
      checkDataText(data.text, DATA_LONG_TEXT_MAX, 'text', errors);
      if (variant === 'citation') {
        // 来源引用卡：出处必填，日期可选（可核验性是该变体的存在意义）。
        checkDataText(data.source, DATA_TEXT_MAX, 'source', errors);
        checkOptionalDataText(data.date, DATA_TEXT_MAX, 'date', errors);
      } else if (variant === 'word-pop') {
        // 逐词弹入：语义块由导演切分（2~8 块），编译器不再分词。
        const words = asArray(data.words);
        if (words.length < 2 || words.length > 8) {
          errors.push(`word-pop words 需要 2~8 个语义块，当前 ${words.length}`);
        }
        words.forEach((word, i) => checkDataText(word, 10, `words[${i}]`, errors));
        checkOptionalDataText(data.source, DATA_TEXT_MAX, 'source', errors);
      } else {
        checkOptionalDataText(data.source, DATA_TEXT_MAX, 'source', errors);
      }
      break;
    }
    case 'concept': {
      const variant = data.variant as StoryboardConceptData['variant'];
      if (variant != null && !['section', 'typewriter', 'anchor'].includes(variant)) {
        errors.push(`data.variant "${String(variant)}" 不合法（section | typewriter | anchor）`);
      }
      if (variant === 'section') {
        checkDataText(data.title, DATA_TITLE_MAX, 'title', errors);
        checkOptionalDataText(data.subtitle, DATA_TEXT_MAX, 'subtitle', errors);
        checkOptionalDataText(data.index, 4, 'index', errors);
      } else if (variant === 'anchor') {
        // 关键词锚点：term（≤6 字）或 keywords（1~3 个、每个 ≤6 字）二选一；
        // 不允许 definition（锚点无释义，只做「叮一下」的强调）。
        if (typeof data.definition === 'string' && data.definition.trim()) {
          errors.push('anchor 变体不允许 definition（锚点只做关键词强调，无释义）');
        }
        const keywords = asArray(data.keywords).filter((kw): kw is string => typeof kw === 'string' && Boolean(kw.trim()));
        const hasTerm = typeof data.term === 'string' && Boolean(data.term.trim());
        if (keywords.length > 0 && hasTerm) {
          errors.push('anchor 变体 term 与 keywords 二选一（单关键词用 term，多关键词用 keywords）');
        }
        if (keywords.length > 0) {
          if (keywords.length > 3) errors.push(`anchor keywords 需要 1~3 个，当前 ${keywords.length}`);
          keywords.forEach((kw, i) => checkDataText(kw, REPETITION_KICKER_MAX_CHARS, `keywords[${i}]`, errors));
        } else if (hasTerm) {
          checkDataText(data.term, REPETITION_KICKER_MAX_CHARS, 'term', errors);
        } else {
          errors.push('anchor 变体需要 term（≤6 字关键词）或 keywords（1~3 个，每个 ≤6 字）');
        }
      } else {
        checkDataText(data.term, DATA_TITLE_MAX, 'term', errors);
        checkDataText(data.definition, DATA_LONG_TEXT_MAX, 'definition', errors);
        checkOptionalDataText(data.hint, DATA_TEXT_MAX, 'hint', errors);
      }
      break;
    }
    case 'timeline': {
      const items = asArray(data.items);
      if (items.length < 2 || items.length > 4) {
        errors.push(`timeline items 需要 2~4 项，当前 ${items.length}`);
      }
      items.forEach((item, i) => checkDataText(item, DATA_TEXT_MAX, `items[${i}]`, errors));
      break;
    }
    case 'matrix': {
      const items = asArray(data.items);
      if (items.length < 2 || items.length > 5) {
        errors.push(`matrix items 需要 2~5 项，当前 ${items.length}`);
      }
      items.forEach((item, i) => {
        const record = asRecord(item);
        checkDataText(record?.label, DATA_TEXT_MAX, `items[${i}].label`, errors);
        checkDataNumber(record?.x, `items[${i}].x`, errors, { min: 0, max: 100 });
        checkDataNumber(record?.y, `items[${i}].y`, errors, { min: 0, max: 100 });
      });
      checkOptionalDataText(data.xLabel, 8, 'xLabel', errors);
      checkOptionalDataText(data.yLabel, 8, 'yLabel', errors);
      break;
    }
    case 'funnel': {
      const steps = asArray(data.steps);
      if (steps.length < 2 || steps.length > 5) {
        errors.push(`funnel steps 需要 2~5 级，当前 ${steps.length}`);
      }
      steps.forEach((step, i) => {
        const record = asRecord(step);
        checkDataText(record?.label, DATA_TEXT_MAX, `steps[${i}].label`, errors);
        checkOptionalDataText(record?.value, 8, `steps[${i}].value`, errors);
      });
      break;
    }
    case 'network': {
      const nodes = asArray(data.nodes);
      if (nodes.length < 2 || nodes.length > 5) {
        errors.push(`network nodes 需要 2~5 个节点，当前 ${nodes.length}`);
      }
      nodes.forEach((node, i) => checkDataText(node, 8, `nodes[${i}]`, errors));
      asArray(data.links).forEach((link, i) => {
        const pair = asArray(link);
        if (pair.length !== 2 || pair.some((p) => typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p >= nodes.length)) {
          errors.push(`network links[${i}] 不是合法的节点下标对（0-${Math.max(0, nodes.length - 1)}）`);
        }
      });
      break;
    }
    case 'before-after': {
      const variant = data.variant as StoryboardBeforeAfterData['variant'];
      if (variant != null && variant !== 'myth-fact') {
        errors.push(`data.variant "${String(variant)}" 不合法（仅支持 myth-fact）`);
      }
      checkDataText(data.before, DATA_TEXT_MAX, 'before', errors);
      checkDataText(data.after, DATA_TEXT_MAX, 'after', errors);
      break;
    }
    case 'stacked-composition': {
      const variant = data.variant as StoryboardStackedData['variant'];
      if (variant != null && variant !== 'donut') {
        errors.push(`data.variant "${String(variant)}" 不合法（仅支持 donut）`);
      }
      const items = asArray(data.items);
      if (items.length < 2 || items.length > 5) {
        errors.push(`stacked-composition items 需要 2~5 项，当前 ${items.length}`);
      }
      items.forEach((item, i) => {
        const record = asRecord(item);
        checkDataText(record?.label, DATA_TEXT_MAX, `items[${i}].label`, errors);
        checkDataNumber(record?.value, `items[${i}].value`, errors);
        checkOptionalDataText(record?.display, 8, `items[${i}].display`, errors);
      });
      break;
    }
    default:
      break;
  }

  // 数字防编造：data 里的内容数字必须能在逐字稿中找到（matrix x/y 坐标除外）。
  const transcriptNumbers = new Set(extractCheckableNumbers(ctx.transcript ?? ''));
  if (transcriptNumbers.size > 0) {
    const fabricated = collectDataNumbers(data).filter((num) => !transcriptNumbers.has(num));
    if (fabricated.length > 0) {
      errors.push(
        `data 中的数字 [${fabricated.join(', ')}] 在本段逐字稿中不存在；数据必须忠于口播原文，不得编造 / 换算 / 四舍五入`,
      );
    }
  }

  return { errors };
}

/** 模型常见的字段变体归一化：adds/changes/motion 的近义键收敛到契约键名。 */
function normalizeStoryboard(raw: MotionStoryboard): MotionStoryboard {  if (!raw || !Array.isArray(raw.beats)) return raw;
  const pick = (obj: Record<string, unknown>, keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return undefined;
  };
  const focusBeat = Number.isInteger(raw.focus?.beat) ? raw.focus!.beat : -1;
  const lastBeat = raw.beats.length - 1;
  const defaultRole = (beat: StoryboardBeat, i: number): TimingBeatRole => {
    if ((beat as { role?: unknown }).role && (STORYBOARD_BEAT_ROLES as readonly string[]).includes(String(beat.role))) {
      return beat.role as TimingBeatRole;
    }
    if (i === focusBeat || beat.kind === 'accent') return 'emphasis';
    if (i === 0) return 'anticipation';
    if (i === lastBeat) return 'resolve';
    return beat.kind === 'transform' ? 'reveal' : 'hold';
  };
  return {
    ...raw,
    camera: normalizeCameraShots(raw.camera, raw.beats.length),
    annotate: normalizeAnnotations(raw.annotate, raw.beats.length),
    beats: raw.beats.map((beat, i) => {
      if (!beat || typeof beat !== 'object') return beat;
      const b = beat as unknown as Record<string, unknown>;
      return {
        ...beat,
        role: defaultRole(beat, i),
        adds: pick(b, ['adds', 'add', 'content', 'element', 'elements', 'text']) ?? beat.adds,
        changes: pick(b, ['changes', 'change', 'update', 'updates']) ?? beat.changes,
        motion: pick(b, ['motion', 'action', 'animation']) ?? beat.motion,
      };
    }),
  };
}

/**
 * 运镜归一化：非法 move / 越界拍号直接丢弃，同拍去重，超上限截断。
 * 导演写错不打回（不值得为增强项增加重出率），机器夹到合法即可。
 */
function normalizeCameraShots(raw: unknown, beatCount: number): StoryboardCameraShot[] | undefined {
  if (!Array.isArray(raw) || beatCount <= 0) return undefined;
  const seen = new Set<number>();
  const shots: StoryboardCameraShot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const move = String(s.move ?? '');
    if (!(STORYBOARD_CAMERA_MOVES as readonly string[]).includes(move)) continue;
    const beat = Number(s.beat);
    if (!Number.isInteger(beat) || beat < 0 || beat >= beatCount || seen.has(beat)) continue;
    seen.add(beat);
    const target = String(s.target ?? '');
    shots.push({
      beat,
      move: move as StoryboardCameraMove,
      ...(target === 'header' || target === 'main' || target === 'asset' ? { target } : {}),
    });
  }
  if (!shots.length) return undefined;
  return shots.sort((a, b) => a.beat - b.beat).slice(0, MAX_CAMERA_SHOTS);
}

/** 标注归一化：规则同运镜；target 缺省指 main。 */
function normalizeAnnotations(raw: unknown, beatCount: number): StoryboardAnnotation[] | undefined {
  if (!Array.isArray(raw) || beatCount <= 0) return undefined;
  const items: StoryboardAnnotation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    const kind = String(a.kind ?? '');
    if (!(STORYBOARD_ANNOTATE_KINDS as readonly string[]).includes(kind)) continue;
    const beat = Number(a.beat);
    if (!Number.isInteger(beat) || beat < 0 || beat >= beatCount) continue;
    const target = a.target === 'header' ? 'header' : 'main';
    const side = a.side;
    items.push({
      beat,
      kind: kind as StoryboardAnnotateKind,
      target,
      ...(side === 'left' || side === 'right' || side === 'top' || side === 'bottom' ? { side } : {}),
    });
  }
  if (!items.length) return undefined;
  // 同一槽位只保留最后一个标注：叠加标注会互相遮挡
  const byTarget = new Map<string, StoryboardAnnotation>();
  for (const item of items) byTarget.set(item.target ?? 'main', item);
  return Array.from(byTarget.values())
    .sort((a, b) => a.beat - b.beat)
    .slice(0, MAX_ANNOTATIONS);
}

/** 从 start 起扫描字符串感知的平衡 {...}，返回闭合下标；未闭合返回 -1。 */
function scanBalanced(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = inString;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 严格解析失败时修复尾随逗号再试一次（模型最常见的 JSON 语法错）。 */
function tryParseObject(slice: string): Record<string, unknown> | null {
  for (const candidate of [slice, slice.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* 尝试下一形态 */
    }
  }
  return null;
}

/**
 * 从导演回复中抽取 JSON 分镜：扫描全部平衡 {...} 候选，优先返回含 beats 数组的对象
 * （回复里常混有字段示例等小对象），全部无 beats 时回退首个可解析对象交给校验报缺字段。
 */
export function parseStoryboard(text: string): MotionStoryboard | null {
  const source = (text ?? '').trim();
  let fallback: MotionStoryboard | null = null;
  for (let start = source.indexOf('{'); start >= 0; ) {
    const end = scanBalanced(source, start);
    if (end < 0) break; // 未闭合（截断），后面不会再有完整对象
    const parsed = tryParseObject(source.slice(start, end + 1));
    if (parsed) {
      if (Array.isArray((parsed as { beats?: unknown }).beats)) {
        return normalizeStoryboard(parsed as unknown as MotionStoryboard);
      }
      fallback = fallback ?? (parsed as unknown as MotionStoryboard);
      start = source.indexOf('{', end + 1);
    } else {
      start = source.indexOf('{', start + 1);
    }
  }
  return fallback ? normalizeStoryboard(fallback) : null;
}

/** 解析失败的针对性重出提示：区分 无 JSON / 输出截断 / 语法非法，回喂导演。 */
export function storyboardParseHint(text: string): string {
  const source = (text ?? '').trim();
  const start = source.indexOf('{');
  if (start < 0) {
    return '回复中不含任何 JSON 对象——不要解释、不要提问，直接输出一个 JSON 分镜对象。';
  }
  if (scanBalanced(source, source.lastIndexOf('{')) < 0 && scanBalanced(source, start) < 0) {
    return 'JSON 未闭合，疑似输出被截断——压缩 scene / motion 等文案长度，一次性输出完整 JSON。';
  }
  return 'JSON 语法不合法（常见：单引号、未加引号的键名、注释、尾随逗号）——用严格 JSON 重新输出。';
}

/** 归一化文本用于数字匹配：统一全角数字并去掉千分位 / 空格。 */
function normalizeForNumbers(text: string): string {
  return text
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10))
    .replace(/[，,\s]/g, '');
}

const CHINESE_DIGITS: Readonly<Record<string, number>> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const CHINESE_SMALL_UNITS: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1_000 };
const CHINESE_LARGE_UNITS: Readonly<Record<string, number>> = { 万: 10_000, 亿: 100_000_000 };
const CHINESE_NUMBER_TOKEN = /[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二两三四五六七八九]+)?/gu;
const SCREEN_QUANTITY_SUFFIX = /^(?:%|％|年|月份?|季度|月|日|天|小时|分钟|秒|毫秒|辆|艘|船|元|美元|万元|亿元|人|倍|届|吨|公里|千米|米|平方米|吉瓦时|吉瓦|兆瓦时|兆瓦|千瓦时|千瓦)/u;

function parseChineseInteger(token: string): number | null {
  if (!token) return null;
  if (![...token].some((char) => char in CHINESE_SMALL_UNITS || char in CHINESE_LARGE_UNITS)) {
    const digits = [...token].map((char) => CHINESE_DIGITS[char]);
    return digits.every((digit) => digit != null) ? Number(digits.join('')) : null;
  }
  let total = 0;
  let section = 0;
  let current: number | null = null;
  for (const char of token) {
    if (char in CHINESE_DIGITS) {
      current = CHINESE_DIGITS[char];
      continue;
    }
    const smallUnit = CHINESE_SMALL_UNITS[char];
    if (smallUnit) {
      section += (current ?? 1) * smallUnit;
      current = null;
      continue;
    }
    const largeUnit = CHINESE_LARGE_UNITS[char];
    if (largeUnit) {
      section += current ?? 0;
      total += (section || 1) * largeUnit;
      section = 0;
      current = null;
      continue;
    }
    return null;
  }
  return total + section + (current ?? 0);
}

function parseChineseNumber(token: string): number | null {
  const [integerPart, decimalPart] = token.split('点', 2);
  const integer = parseChineseInteger(integerPart);
  if (integer == null) return null;
  if (decimalPart == null) return integer;
  const digits = [...decimalPart].map((char) => CHINESE_DIGITS[char]);
  if (digits.some((digit) => digit == null)) return null;
  return Number(`${integer}.${digits.join('')}`);
}

function numericKey(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(8)));
}

function addCheckableNumber(target: Set<string>, value: number | null): void {
  if (value == null || !Number.isFinite(value)) return;
  if (Math.abs(value) < 10 && Number.isInteger(value)) return;
  const key = numericKey(value);
  if (key) target.add(key);
}

/**
 * 提取可比对的数字事实。中文口播与阿拉伯数字卡面会归一到同一数值；
 * 同时保留“150万”的 150 与 1500000，兼容 value=150 + unit=万 的结构化 data。
 */
function extractCheckableNumbers(text: string): string[] {
  const numbers = new Set<string>();
  let normalized = normalizeForNumbers(text);
  normalized = normalized.replace(new RegExp(`百分之(${CHINESE_NUMBER_TOKEN.source})`, 'gu'), (_match, token: string) => {
    addCheckableNumber(numbers, parseChineseNumber(token));
    return ' ';
  });
  normalized = normalized.replace(
    new RegExp(`(${CHINESE_NUMBER_TOKEN.source})成([零〇一二两三四五六七八九]?)`, 'gu'),
    (_match, whole: string, fraction: string) => {
      const wholeValue = parseChineseNumber(whole);
      if (wholeValue != null) addCheckableNumber(numbers, wholeValue * 10 + (CHINESE_DIGITS[fraction] ?? 0));
      return ' ';
    },
  );
  normalized = normalized.replace(CHINESE_NUMBER_TOKEN, (token) => {
    addCheckableNumber(numbers, parseChineseNumber(token));
    const coefficient = token.match(/^(.+)(万|亿)$/u);
    if (coefficient) addCheckableNumber(numbers, parseChineseNumber(coefficient[1]));
    return ' ';
  });
  for (const match of normalized.matchAll(/\d+(?:\.\d+)?(?:万|亿)?/g)) {
    const literal = match[0];
    const unit = literal.endsWith('万') ? 10_000 : literal.endsWith('亿') ? 100_000_000 : 1;
    const base = Number(unit === 1 ? literal : literal.slice(0, -1));
    addCheckableNumber(numbers, base);
    if (unit !== 1) addCheckableNumber(numbers, base * unit);
  }
  return [...numbers];
}

/** 找出卡面里的中文数量写法；单独出现在专有名词中的“一”等不会命中。 */
function extractChineseQuantityLiterals(text: string): string[] {
  const literals = new Set<string>();
  for (const match of text.matchAll(CHINESE_NUMBER_TOKEN)) {
    const token = match[0];
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - 3), index);
    const after = text.slice(index + token.length);
    const quantitative = before.endsWith('百分之')
      || before.endsWith('第')
      || before.endsWith('约')
      || before.endsWith('超')
      || after.startsWith('成')
      || SCREEN_QUANTITY_SUFFIX.test(after)
      || /[十百千万亿点]/u.test(token);
    if (quantitative) literals.add(`${before.endsWith('百分之') ? '百分之' : before.endsWith('第') ? '第' : ''}${token}${after.startsWith('成') ? '成' : ''}`);
  }
  return [...literals];
}

export function validateStoryboard(
  sb: MotionStoryboard | null,
  ctx: {
    cueCount: number;
    transcript?: string;
    requireCapacityModel?: boolean;
    /** 已重出轮次；>0 时载体塌陷闸门降级为提醒，避免为一条软规则耗尽预算把卡片打没。 */
    attempt?: number;
  } & AnchorGateContext,
): StoryboardValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!sb) {
    return { ok: false, errors: ['无法从回复中解析出 JSON 分镜对象'], warnings };
  }
  if (!sb.claim || typeof sb.claim !== 'string') errors.push('缺少 claim（一句话论点）');
  if (!STORYBOARD_CARRIERS.includes(sb.carrier)) {
    errors.push(`carrier 必须是 ${STORYBOARD_CARRIERS.join(' | ')} 之一，收到 "${String(sb.carrier)}"`);
  }
  if (!sb.scene || typeof sb.scene !== 'string') warnings.push('缺少 scene（终态画面描述）');
  validateCapacityModel(sb, ctx.requireCapacityModel === true, errors, warnings);
  errors.push(...validateStoryboardData(sb, { transcript: ctx.transcript }).errors);
  // anchor 硬闸门：导演自选 concept(anchor) / corner-anchor 只放行章节路标与系统降级标记段。
  errors.push(...checkAnchorGate(sb, ctx));
  // 载体塌陷闸门：bible 规划图形化载体却写成纯文字时纠正一次（实测 83% 段落有此塌陷）。
  const collapse = checkCarrierCollapse(sb, ctx);
  errors.push(...collapse.errors);
  warnings.push(...collapse.warnings);
  if (sb.assets != null) {
    if (!Array.isArray(sb.assets)) {
      errors.push('assets 必须是数组');
    } else if (sb.assets.length > 6) {
      errors.push(`assets 数量 ${sb.assets.length} 超过上限 6（单卡物件过多会降低画面统一性）`);
    } else {
      sb.assets.forEach((asset, i) => {
        if (!asset || typeof asset !== 'object') {
          errors.push(`资产 ${i} 不是对象`);
          return;
        }
        if (!asset.slot || typeof asset.slot !== 'string') errors.push(`资产 ${i} 缺少 slot`);
        if (!asset.query || typeof asset.query !== 'string') errors.push(`资产 ${i} 缺少 query`);
        if (!['object', 'background', 'texture', 'symbol', 'overlay'].includes(asset.role)) {
          errors.push(`资产 ${i} role="${String(asset.role)}" 不合法`);
        }
        if (!['primary', 'secondary', 'ambient'].includes(asset.importance)) {
          errors.push(`资产 ${i} importance="${String(asset.importance)}" 不合法`);
        }
        if (!['prefer-library', 'generate-if-missing', 'always-generate', 'manual-only'].includes(asset.reusePolicy)) {
          errors.push(`资产 ${i} reusePolicy="${String(asset.reusePolicy)}" 不合法`);
        }
        if (!['editorial-realist-cutout', 'documentary-desk', 'technical-product', 'paper-archive', 'diagram-prop'].includes(asset.visualTreatment)) {
          errors.push(`资产 ${i} visualTreatment="${String(asset.visualTreatment)}" 不合法`);
        }
      });
    }
  }

  if (!Array.isArray(sb.beats) || sb.beats.length === 0) {
    errors.push('beats 必须是非空数组');
    return { ok: false, errors, warnings };
  }
  if (sb.beats.length > 6) errors.push(`beats 数量 ${sb.beats.length} 超过上限 6（信息密度约束）`);

  let lastCue = -1;
  sb.beats.forEach((beat, i) => {
    if (!beat || typeof beat !== 'object') {
      errors.push(`拍 ${i} 不是对象`);
      return;
    }
    if (!beat.adds || typeof beat.adds !== 'string') {
      errors.push(`拍 ${i} 缺少 adds（新出现的元素及内容）`);
    }
    if (beat.kind && !['build', 'transform', 'accent'].includes(beat.kind)) {
      warnings.push(`拍 ${i} 的 kind "${String(beat.kind)}" 不在 build|transform|accent 中`);
    }
    if (beat.role && !(STORYBOARD_BEAT_ROLES as readonly string[]).includes(beat.role)) {
      warnings.push(`拍 ${i} 的 role "${String(beat.role)}" 不在 ${STORYBOARD_BEAT_ROLES.join('|')} 中，将按默认节奏角色处理`);
    }
    const cue = beat.cue;
    if (cue == null) {
      if (i > 0) errors.push(`拍 ${i} 的 cue 为空；只有第 0 拍（入场）允许 cue 为 null`);
      return;
    }
    if (!Number.isInteger(cue) || cue < 0) {
      errors.push(`拍 ${i} 的 cue=${String(cue)} 不是合法句索引`);
      return;
    }
    if (ctx.cueCount > 0 && cue >= ctx.cueCount) {
      errors.push(`拍 ${i} 的 cue=${cue} 越界（本段只有 ${ctx.cueCount} 句，合法范围 0-${ctx.cueCount - 1}）`);
    }
    if (cue < lastCue) {
      errors.push(`拍 ${i} 的 cue=${cue} 小于前一拍的 ${lastCue}；cue 必须随拍序单调不减（跟随口播顺序）`);
    }
    lastCue = Math.max(lastCue, cue);
  });

  if (sb.focus) {
    if (!Number.isInteger(sb.focus.beat) || sb.focus.beat < 0 || sb.focus.beat >= sb.beats.length) {
      errors.push(`focus.beat=${String(sb.focus.beat)} 不是合法拍索引（0-${sb.beats.length - 1}）`);
    }
    if (sb.focus.emphasis && !(STORYBOARD_EMPHASES as readonly string[]).includes(sb.focus.emphasis)) {
      warnings.push(`focus.emphasis "${sb.focus.emphasis}" 不在 ${STORYBOARD_EMPHASES.join('|')} 中，将按 settle 处理`);
    }
  } else {
    warnings.push('未标注 focus（唯一语义焦点所在拍）');
  }

  // 数字防编造：分镜里的数字必须能在逐字稿中找到。
  const transcriptNumbers = new Set(extractCheckableNumbers(ctx.transcript ?? ''));
  if (transcriptNumbers.size > 0) {
    const fabricated = new Set<string>();
    for (const text of collectQuantifiedScreenStrings(sb)) {
      for (const num of extractCheckableNumbers(text)) {
        if (!transcriptNumbers.has(num)) fabricated.add(num);
      }
    }
    if (fabricated.size > 0) {
      errors.push(
        `分镜中的数字 [${Array.from(fabricated).join(', ')}] 在本段逐字稿中不存在；数据必须忠于口播原文，不得编造 / 换算 / 四舍五入`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Agent 原子合成的独立语义门禁。
 *
 * 它刻意不读取 carrier / layout / elements / capacity / lifecycle，也不执行
 * SafeLayout、MotionSlot 或模板 data 校验。框架只确认叙事节拍和冻结素材关系，
 * 具体空间组织由下游 React/Remotion Agent 决定。
 */
export function validateAgentCompositeStoryboard(
  sb: MotionStoryboard | null,
  ctx: {
    cueCount: number;
    transcript?: string;
    approvedAssets: CompositeStoryboardAssetRef[];
  },
): StoryboardValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!sb) {
    return { ok: false, errors: ['无法从回复中解析出 JSON 分镜对象'], warnings };
  }
  if (!sb.claim || typeof sb.claim !== 'string') errors.push('缺少 claim（一句话论点）');
  errors.push(...checkScreenNumeralStyle(sb));
  if (!sb.scene || typeof sb.scene !== 'string') warnings.push('缺少 scene（终态画面描述）');
  if (Array.isArray(sb.assets) && sb.assets.length > 0) {
    errors.push('Agent 原子合成不得新增 assets，只能使用批准时冻结的素材');
  }

  if (!Array.isArray(sb.beats) || sb.beats.length === 0) {
    errors.push('beats 必须是非空数组');
    return { ok: false, errors, warnings };
  }
  if (sb.beats.length > 6) errors.push(`beats 数量 ${sb.beats.length} 超过上限 6（节拍密度约束）`);

  let lastCue = -1;
  sb.beats.forEach((beat, index) => {
    if (!beat || typeof beat !== 'object') {
      errors.push(`拍 ${index} 不是对象`);
      return;
    }
    if (!beat.adds || typeof beat.adds !== 'string') {
      errors.push(`拍 ${index} 缺少 adds（本拍新增的叙事内容）`);
    }
    if (beat.kind && !['build', 'transform', 'accent'].includes(beat.kind)) {
      warnings.push(`拍 ${index} 的 kind "${String(beat.kind)}" 不在 build|transform|accent 中`);
    }
    if (beat.role && !(STORYBOARD_BEAT_ROLES as readonly string[]).includes(beat.role)) {
      warnings.push(`拍 ${index} 的 role "${String(beat.role)}" 不在 ${STORYBOARD_BEAT_ROLES.join('|')} 中`);
    }
    const cue = beat.cue;
    if (cue == null) {
      if (index > 0) errors.push(`拍 ${index} 的 cue 为空；只有第 0 拍（入场）允许 cue 为 null`);
      return;
    }
    if (!Number.isInteger(cue) || cue < 0) {
      errors.push(`拍 ${index} 的 cue=${String(cue)} 不是合法句索引`);
      return;
    }
    if (ctx.cueCount > 0 && cue >= ctx.cueCount) {
      errors.push(`拍 ${index} 的 cue=${cue} 越界（本段只有 ${ctx.cueCount} 句，合法范围 0-${ctx.cueCount - 1}）`);
    }
    if (cue < lastCue) {
      errors.push(`拍 ${index} 的 cue=${cue} 小于前一拍的 ${lastCue}；cue 必须随拍序单调不减`);
    }
    lastCue = Math.max(lastCue, cue);
  });

  if (!sb.focus) {
    errors.push('缺少 focus（唯一语义焦点）');
  } else {
    if (!Number.isInteger(sb.focus.beat) || sb.focus.beat < 0 || sb.focus.beat >= sb.beats.length) {
      errors.push(`focus.beat=${String(sb.focus.beat)} 不是合法拍索引（0-${sb.beats.length - 1}）`);
    }
    if (!sb.focus.subject || typeof sb.focus.subject !== 'string') {
      errors.push('focus.subject 必须说明本镜头的唯一语义焦点');
    }
  }

  const approvedByAssetId = new Map(ctx.approvedAssets.map((asset) => [asset.assetId, asset]));
  const approvedBySlot = new Map(ctx.approvedAssets.map((asset) => [asset.slot, asset]));
  const media = Array.isArray(sb.media) ? sb.media : [];
  const usedAssetIds = new Set<string>();
  for (const [index, use] of media.entries()) {
    if (!use || typeof use !== 'object') {
      errors.push(`media[${index}] 不是对象`);
      continue;
    }
    const approved = (use.assetId ? approvedByAssetId.get(use.assetId) : undefined)
      ?? (use.slot ? approvedBySlot.get(use.slot) : undefined);
    if (!approved) {
      errors.push(`media[${index}] 引用了未批准素材 ${use.assetId ?? use.slot ?? '(缺少 assetId/slot)'}`);
      continue;
    }
    if (usedAssetIds.has(approved.assetId)) {
      errors.push(`media 重复声明素材 ${approved.assetId}`);
    }
    usedAssetIds.add(approved.assetId);
    if (!use.purpose || typeof use.purpose !== 'string') {
      errors.push(`media[${index}] 缺少 purpose（素材在论证中的作用）`);
    }
    if (!Array.isArray(use.beats) || use.beats.length === 0) {
      errors.push(`media[${index}] 缺少 beats（素材出现在哪些叙事拍）`);
      continue;
    }
    for (const beat of use.beats) {
      if (!Number.isInteger(beat) || beat < 0 || beat >= sb.beats.length) {
        errors.push(`media[${index}].beats 包含非法拍索引 ${String(beat)}`);
      }
    }
  }
  for (const asset of ctx.approvedAssets) {
    if (asset.usage === 'required' && !usedAssetIds.has(asset.assetId)) {
      errors.push(`必用素材 ${asset.assetId}（${asset.slot}）未写入 media 叙事关系`);
    }
  }

  const transcriptNumbers = new Set(extractCheckableNumbers(ctx.transcript ?? ''));
  if (transcriptNumbers.size > 0) {
    const fabricated = new Set<string>();
    for (const text of collectQuantifiedScreenStrings(sb)) {
      for (const number of extractCheckableNumbers(text)) {
        if (!transcriptNumbers.has(number)) fabricated.add(number);
      }
    }
    if (fabricated.size > 0) {
      errors.push(
        `分镜中的数字 [${Array.from(fabricated).join(', ')}] 在本段逐字稿中不存在；数据必须忠于口播原文`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 把校验问题格式化为回喂导演的重出指令。 */
export function formatStoryboardIssues(validation: StoryboardValidation): string {
  const lines = validation.errors.map((e, i) => `${i + 1}. ${e}`);
  return lines.join('\n');
}
