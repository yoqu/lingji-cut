import type { AICard, AISegment, AISegmentSemanticType, AISegmentVisualType } from '../types/ai';
import type {
  MotionBible,
  MotionBibleDensity,
  MotionBibleIssue,
  MotionBibleTransition,
  MotionSegmentDirective,
} from '../types/motion';
import { DEFAULT_CONTENT_TYPE_RULES } from './card-style-presets';
import { parseStoryboard, STORYBOARD_CARRIERS } from './motion-storyboard';

const CARRIERS = STORYBOARD_CARRIERS;
const DENSITIES: MotionBibleDensity[] = ['quiet', 'balanced', 'dense'];
const TRANSITIONS: MotionBibleTransition[] = ['crossfade', 'hard-cut', 'push', 'wipe', 'match-cut'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function cleanText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function cleanStringArray(value: unknown, validSegmentIds: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.filter((item): item is string => typeof item === 'string' && validSegmentIds.has(item))),
  );
}

function cleanIntensity(value: unknown, fallback: 1 | 2 | 3): 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3 ? value : fallback;
}

function pickCarrier(segment: AISegment, index: number): string {
  const haystack = `${segment.title} ${segment.summary} ${segment.transcriptExcerpt ?? ''}`;
  // data-hero 需要"数字 + 数据语义"双信号：年份、序号、集数等零散数字不再触发，
  // 避免解释 / 叙述段被误判成数据卡。
  const hasNumber = /[0-9０-９%％]|[0-9０-９一二三四五六七八九十两]+(?:万|亿|倍)/.test(haystack);
  const dataSignal =
    segment.semanticType === 'data'
    || /倍|万|亿|人数|金额|参数|增长|下降|增速|同比|环比|占比|份额|突破|达到|超过|高达|仅有|只有|规模|营收|市值|估值|销量|指标|统计|排名/.test(haystack);
  if (hasNumber && dataSignal) return 'data-hero';
  if (/时间线|历史|版本|阶段|年份|过去|未来/.test(haystack)) return 'timeline';
  if (/象限|矩阵|优先级|高低|二维/.test(haystack)) return 'matrix';
  if (/漏斗|筛选|转化|流失|收窄/.test(haystack)) return 'funnel';
  if (/关系|网络|组织|连接|生态|链路/.test(haystack)) return 'network';
  if (/前后|改版|之前|之后|before|after/.test(haystack)) return 'before-after';
  if (/构成|占比|组成|层级|堆叠/.test(haystack)) return 'stacked-composition';
  if (/表格|名单|榜单|一览|对照表|排行/.test(haystack)) return 'table';
  if (/对比|相比|区别| versus |VS|vs/.test(haystack)) return 'comparison';
  if (/流程|步骤|原因|路径|阶段/.test(haystack)) return 'process';
  if (/趋势|变化|增长|下降|时间|历史|版本/.test(haystack)) return 'trend';
  if (/说|认为|一句|观点|金句/.test(haystack)) return 'quote';
  return CARRIERS[index % CARRIERS.length];
}

function defaultIntensity(segment: AISegment): 1 | 2 | 3 {
  const duration = segment.endMs - segment.startMs;
  if (duration > 45_000) return 3;
  if (duration < 22_000) return 1;
  return 2;
}

function normalizeCarrierPlan(value: unknown, segments: AISegment[]): MotionSegmentDirective[] {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const used = new Set<string>();
  const raw = Array.isArray(value) ? value : [];
  const directives: MotionSegmentDirective[] = [];

  for (const item of raw) {
    if (!isRecord(item) || typeof item.segmentId !== 'string') continue;
    const segment = byId.get(item.segmentId);
    if (!segment || used.has(segment.id)) continue;
    used.add(segment.id);
    directives.push({
      segmentId: segment.id,
      preferredCarrier: cleanText(item.preferredCarrier, pickCarrier(segment, directives.length)),
      intensity: cleanIntensity(item.intensity, defaultIntensity(segment)),
      reason: cleanText(item.reason, '按段落内容复杂度与语义重点分配。'),
    });
  }

  for (const segment of segments) {
    if (used.has(segment.id)) continue;
    directives.push({
      segmentId: segment.id,
      preferredCarrier: pickCarrier(segment, directives.length),
      intensity: defaultIntensity(segment),
      reason: 'deterministic fallback：按标题、摘要与时长推导。',
    });
  }

  return directives;
}

const CONCEPT_CARRIER = 'concept';
const DEFAULT_CONCEPT_SHARE_LIMIT = 0.35;
const DEFAULT_REBALANCE_WINDOW = 2;

type CarrierRebalanceSegment = AISegment & { visualType?: AISegmentVisualType };

export interface CarrierRebalanceOptions {
  /** concept 占比上限（默认 0.35）；超过才把超出部分改派到其它载体。 */
  conceptShareLimit?: number;
  /** 改派目标要求在近 N 段（时间线前后）内未使用过；默认 2。 */
  window?: number;
}

export interface CarrierRebalanceResult {
  carrierPlan: MotionSegmentDirective[];
  /** 实际被改派的段数（concept → 其它载体）；0 表示未触发或无需改派。 */
  rebalanced: number;
}

function recommendedCarriers(semanticType: AISegmentSemanticType | undefined): string[] {
  return DEFAULT_CONTENT_TYPE_RULES[semanticType ?? 'explanation'].preferredCarriers;
}

/**
 * concept 在该语义类型推荐清单里的适配度：不在清单 = -1（最差，最先改派）；
 * 在清单里时位置越靠后适配度越低（如 narration 的 concept 末位）。
 */
function conceptFitScore(semanticType: AISegmentSemanticType | undefined): number {
  const list = recommendedCarriers(semanticType);
  const index = list.indexOf(CONCEPT_CARRIER);
  return index === -1 ? -1 : list.length - index;
}

/**
 * carrier 多样性安全网：concept 占比超过上限时，把超出部分中适配度最低的段
 * 改派到其语义类型推荐清单中近 N 段内未用过的载体。
 * - image 段不参与（不消耗 motion 载体，分子分母都不计）；
 * - 不破坏"同类不连续 2 次"的局部约束（改派目标必与相邻段不同）；
 * - 未超限时原样返回（引用恒等）。
 */
export function rebalanceCarrierPlan(
  carrierPlan: MotionSegmentDirective[],
  segments: CarrierRebalanceSegment[],
  options: CarrierRebalanceOptions = {},
): CarrierRebalanceResult {
  const shareLimit = options.conceptShareLimit ?? DEFAULT_CONCEPT_SHARE_LIMIT;
  const windowRadius = Math.max(1, Math.floor(options.window ?? DEFAULT_REBALANCE_WINDOW));
  const segmentMetaById = new Map(segments.map((segment, index) => [segment.id, { segment, index }]));

  // 时间线顺序的工作集：只含已知且非 image 的段
  const timeline = carrierPlan
    .map((directive, planIndex) => ({ planIndex, meta: segmentMetaById.get(directive.segmentId) }))
    .filter((entry): entry is { planIndex: number; meta: { segment: CarrierRebalanceSegment; index: number } } =>
      Boolean(entry.meta) && entry.meta!.segment.visualType !== 'image',
    )
    .sort((a, b) => a.meta.index - b.meta.index);

  const conceptEntries = timeline.filter(
    (entry) => carrierPlan[entry.planIndex].preferredCarrier === CONCEPT_CARRIER,
  );
  const maxConcept = Math.floor(timeline.length * shareLimit);
  if (timeline.length === 0 || conceptEntries.length <= maxConcept) {
    return { carrierPlan, rebalanced: 0 };
  }

  // 适配度最低优先（如 data 段推荐清单里没有 concept）；并列时按时间线从前到后。
  const queue = [...conceptEntries].sort(
    (a, b) =>
      conceptFitScore(a.meta.segment.semanticType) - conceptFitScore(b.meta.segment.semanticType)
      || a.meta.index - b.meta.index,
  );

  const result = carrierPlan.map((directive) => ({ ...directive }));
  const timelinePlanIndexes = timeline.map((entry) => entry.planIndex);
  const carrierNear = (timelineIdx: number): string | undefined =>
    result[timelinePlanIndexes[timelineIdx]]?.preferredCarrier;

  const target = conceptEntries.length - maxConcept;
  let rebalanced = 0;
  for (const entry of queue) {
    if (rebalanced >= target) break;
    const timelineIdx = timelinePlanIndexes.indexOf(entry.planIndex);
    const candidates = recommendedCarriers(entry.meta.segment.semanticType).filter(
      (carrier) => carrier !== CONCEPT_CARRIER,
    );
    if (candidates.length === 0) continue;
    const usedNearby = new Set<string>();
    const from = Math.max(0, timelineIdx - windowRadius);
    const to = Math.min(timelinePlanIndexes.length - 1, timelineIdx + windowRadius);
    for (let j = from; j <= to; j += 1) {
      if (j === timelineIdx) continue;
      const carrier = carrierNear(j);
      if (carrier) usedNearby.add(carrier);
    }
    let next = candidates.find((carrier) => !usedNearby.has(carrier));
    if (!next) {
      // 窗口内候选全用过：退而只保证不与直接相邻段同 carrier
      const prev = carrierNear(timelineIdx - 1);
      const following = carrierNear(timelineIdx + 1);
      next = candidates.find((carrier) => carrier !== prev && carrier !== following);
    }
    if (!next) continue;
    const current = result[entry.planIndex];
    result[entry.planIndex] = {
      ...current,
      preferredCarrier: next,
      reason: `${current.reason}（系统再平衡：concept→${next}）`,
    };
    rebalanced += 1;
  }
  return { carrierPlan: result, rebalanced };
}

/* ---------- 弱卡降级（卡密度节奏）：纯文字弱卡改派 concept+anchor 关键词锚点 ---------- */

/** 弱卡降级的可视化收益阈值：narration / explanation 段低于该分即降级。 */
export const WEAK_CARD_VISUALIZATION_SCORE_THRESHOLD = 40;
/** 降级目标：concept 载体的 anchor 变体（关键词锚点卡）。 */
export const ANCHOR_CARD_VARIANT = 'anchor';

/**
 * 纯文字卡载体（降级的作用域）。图形 / 数据载体（data-hero / comparison / table /
 * trend / matrix / funnel / network / before-after / stacked-composition）提供的
 * 是结构化增量信息，即使段本身「弱」也不动。
 */
const TEXT_CARRIERS: ReadonlySet<string> = new Set(['concept', 'list-build', 'process', 'timeline', 'quote']);

type WeakCardSegment = AISegment & { visualType?: AISegmentVisualType; visualizationScore?: number };

export interface WeakCardDowngradeOptions {
  /** 低可视化收益阈值（默认 40）；段缺 visualizationScore 时不按分数降级。 */
  scoreThreshold?: number;
}

export interface WeakCardDowngradeResult {
  carrierPlan: MotionSegmentDirective[];
  /** 实际被降级为 concept+anchor 的段数；0 表示未触发（返回原数组引用）。 */
  downgraded: number;
}

/**
 * 卡密度节奏降级 pass（在 rebalance 之后运行）：
 * - semanticType=chapter-transition 段：职责是章节路标，降级为关键词锚点；
 * - visualizationScore < 阈值的 narration / explanation 段：可视化收益低，降级为关键词锚点；
 * - 已经是图形 / 数据载体的段不动（它们提供的是增量信息）；image 段不动；
 * - 已是 concept+anchor 的段不重复降级。
 * 只作用于纯文字卡载体；降级后 carrier=concept 且 preferredVariant='anchor'。
 */
export function downgradeWeakCarrierPlan(
  carrierPlan: MotionSegmentDirective[],
  segments: WeakCardSegment[],
  options: WeakCardDowngradeOptions = {},
): WeakCardDowngradeResult {
  const scoreThreshold = options.scoreThreshold ?? WEAK_CARD_VISUALIZATION_SCORE_THRESHOLD;
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));

  const isWeak = (segment: WeakCardSegment): boolean => {
    if (segment.semanticType === 'chapter-transition') return true;
    if (segment.semanticType !== 'narration' && segment.semanticType !== 'explanation') return false;
    return typeof segment.visualizationScore === 'number' && segment.visualizationScore < scoreThreshold;
  };

  let result: MotionSegmentDirective[] | null = null;
  let downgraded = 0;
  carrierPlan.forEach((directive, index) => {
    const segment = segmentById.get(directive.segmentId);
    if (
      !segment
      || segment.visualType === 'image'
      || directive.preferredVariant === ANCHOR_CARD_VARIANT
      || !TEXT_CARRIERS.has(directive.preferredCarrier ?? '')
      || !isWeak(segment)
    ) {
      return;
    }
    if (!result) result = carrierPlan.map((item) => ({ ...item }));
    result[index] = {
      ...result[index],
      preferredCarrier: CONCEPT_CARRIER,
      preferredVariant: ANCHOR_CARD_VARIANT,
      reason: `${result[index].reason}（弱卡降级：→concept/anchor 关键词锚点）`,
    };
    downgraded += 1;
  });
  return { carrierPlan: result ?? carrierPlan, downgraded };
}

export function buildDeterministicMotionBible(input: {
  summary?: string;
  keywords?: string[];
  segments: AISegment[];
  warning?: string;
}): MotionBible {
  const { carrierPlan: rebalancedPlan, rebalanced } = rebalanceCarrierPlan(
    normalizeCarrierPlan([], input.segments),
    input.segments,
  );
  // 弱卡降级在 rebalance 之后：chapter-transition / 低收益叙述段改派 concept+anchor。
  const { carrierPlan, downgraded } = downgradeWeakCarrierPlan(rebalancedPlan, input.segments);
  const heavySegments = carrierPlan.filter((item) => item.intensity === 3).map((item) => item.segmentId);
  const quietSegments = carrierPlan.filter((item) => item.intensity === 1).map((item) => item.segmentId);
  const warnings: MotionBibleIssue[] = input.warning
    ? [{ severity: 'warning', code: 'motion-bible-fallback', message: input.warning }]
    : [];

  return {
    visualThesis: input.summary?.trim() || '用克制的信息动效把整期论点拆成可扫描的视觉证据。',
    rhythm: {
      density: input.segments.length > 12 ? 'dense' : input.segments.length < 5 ? 'quiet' : 'balanced',
      heavySegments,
      quietSegments,
    },
    carrierPlan,
    carrierRebalanceCount: rebalanced,
    carrierDowngradeCount: downgraded,
    styleRules: {
      paletteUse: '沿用当前 motion tokens，只在重点拍使用系统蓝强调，避免额外装饰色。',
      typographyUse: '标题短、数字重、说明轻；保持同一字号层级与 tabular 数字。',
      recurringMotif: input.keywords?.[0] ? `${input.keywords[0]} 作为弱重复语义锚点` : undefined,
    },
    transitionRules: {
      default: 'crossfade',
      matchCutCandidates: [],
    },
    generatedAt: Date.now(),
    fallbackUsed: warnings.length > 0,
    warnings,
  };
}

export function normalizeMotionBible(value: unknown, segments: AISegment[]): MotionBible | null {
  if (!isRecord(value)) return null;
  const validSegmentIds = new Set(segments.map((segment) => segment.id));
  const rhythm = isRecord(value.rhythm) ? value.rhythm : {};
  const styleRules = isRecord(value.styleRules) ? value.styleRules : {};
  const transitionRules = isRecord(value.transitionRules) ? value.transitionRules : {};
  const density = DENSITIES.includes(rhythm.density as MotionBibleDensity)
    ? (rhythm.density as MotionBibleDensity)
    : 'balanced';
  const quietSegments = cleanStringArray(rhythm.quietSegments, validSegmentIds);
  const heavySegments = cleanStringArray(rhythm.heavySegments, validSegmentIds).filter(
    (segmentId) => !quietSegments.includes(segmentId),
  );
  const defaultTransition = TRANSITIONS.includes(transitionRules.default as MotionBibleTransition)
    ? (transitionRules.default as MotionBibleTransition)
    : 'crossfade';

  const { carrierPlan: rebalancedPlan, rebalanced } = rebalanceCarrierPlan(
    normalizeCarrierPlan(value.carrierPlan, segments),
    segments,
  );
  // 弱卡降级在 rebalance 之后：chapter-transition / 低收益叙述段改派 concept+anchor。
  const { carrierPlan, downgraded } = downgradeWeakCarrierPlan(rebalancedPlan, segments);

  return {
    visualThesis: cleanText(value.visualThesis, '用统一的信息动效组织整期观点。'),
    rhythm: { density, heavySegments, quietSegments },
    carrierPlan,
    carrierRebalanceCount: rebalanced,
    carrierDowngradeCount: downgraded,
    styleRules: {
      paletteUse: cleanText(styleRules.paletteUse, '沿用当前 motion tokens。'),
      typographyUse: cleanText(styleRules.typographyUse, '保持短标题、强数字、轻说明。'),
      recurringMotif: cleanText(styleRules.recurringMotif, ''),
    },
    transitionRules: {
      default: defaultTransition,
      matchCutCandidates: Array.isArray(transitionRules.matchCutCandidates)
        ? transitionRules.matchCutCandidates
            .filter(isRecord)
            .map((item) => ({
              fromSegmentId: cleanText(item.fromSegmentId, ''),
              toSegmentId: cleanText(item.toSegmentId, ''),
              motif: cleanText(item.motif, ''),
            }))
            .filter((item) => validSegmentIds.has(item.fromSegmentId) && validSegmentIds.has(item.toSegmentId))
        : [],
    },
    generatedAt: Date.now(),
  };
}

export function parseMotionBible(value: unknown, segments: AISegment[]): MotionBible | null {
  if (typeof value === 'string') {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return normalizeMotionBible(JSON.parse(match[0]), segments);
    } catch {
      return null;
    }
  }
  return normalizeMotionBible(value, segments);
}

export function validateMotionBible(bible: MotionBible, segments: AISegment[]): MotionBibleIssue[] {
  const validSegmentIds = new Set(segments.map((segment) => segment.id));
  const issues: MotionBibleIssue[] = [];
  for (const directive of bible.carrierPlan) {
    if (!validSegmentIds.has(directive.segmentId)) {
      issues.push({
        severity: 'error',
        code: 'unknown-segment',
        message: `Motion Bible 引用了不存在的 segment：${directive.segmentId}`,
        segmentId: directive.segmentId,
      });
    }
  }
  for (const segmentId of bible.rhythm.heavySegments) {
    if (bible.rhythm.quietSegments.includes(segmentId)) {
      issues.push({
        severity: 'error',
        code: 'rhythm-overlap',
        message: `同一 segment 不能同时为 heavy 与 quiet：${segmentId}`,
        segmentId,
      });
    }
  }
  return issues;
}

export function buildMotionBibleDirectiveBlock(
  bible: MotionBible | undefined,
  segmentId: string,
): string {
  if (!bible) return 'Motion Bible：无（按单卡分镜独立生成）。';
  const directive = bible.carrierPlan.find((item) => item.segmentId === segmentId);
  return [
    '===== Motion Bible（整片导演策略）=====',
    `整片视觉命题：${bible.visualThesis}`,
    `节奏密度：${bible.rhythm.density}`,
    `风格规则：${bible.styleRules.paletteUse}；${bible.styleRules.typographyUse}`,
    directive
      ? `本段 directive：segment=${directive.segmentId}，carrier=${directive.preferredCarrier ?? '未指定'}${directive.preferredVariant && directive.preferredCarrier === 'concept' ? `(${directive.preferredVariant})` : ''}，intensity=${directive.intensity}，reason=${directive.reason}`
      : '本段 directive：无，按单卡语义选择。',
  ].join('\n');
}

export function checkMotionBibleConsistency(cards: AICard[], bible?: MotionBible): MotionBibleIssue[] {
  if (!bible) return [];
  const issues: MotionBibleIssue[] = [];
  const carriers = cards.map((card) => {
    const storyboard = parseStoryboard(card.animationDirection ?? '');
    return { segmentId: card.segmentId, carrier: storyboard?.carrier ?? '' };
  });
  for (let i = 2; i < carriers.length; i += 1) {
    const a = carriers[i - 2];
    const b = carriers[i - 1];
    const c = carriers[i];
    if (a.carrier && a.carrier === b.carrier && b.carrier === c.carrier) {
      issues.push({
        severity: 'warning',
        code: 'carrier-fatigue',
        message: `连续 3 张使用 ${c.carrier}，可能造成信息载体疲劳。`,
        segmentId: c.segmentId,
      });
    }
  }
  const highIntensity = new Set(bible.carrierPlan.filter((item) => item.intensity === 3).map((item) => item.segmentId));
  for (let i = 1; i < cards.length; i += 1) {
    if (highIntensity.has(cards[i - 1].segmentId) && highIntensity.has(cards[i].segmentId)) {
      issues.push({
        severity: 'warning',
        code: 'intensity-fatigue',
        message: '连续高强度 motion 卡可能削弱重点层级。',
        segmentId: cards[i].segmentId,
      });
    }
  }
  return issues;
}
