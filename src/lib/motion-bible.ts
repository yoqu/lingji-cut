import type { AICard, AISegment } from '../types/ai';
import type {
  MotionBible,
  MotionBibleDensity,
  MotionBibleIssue,
  MotionBibleTransition,
  MotionSegmentDirective,
} from '../types/motion';
import { parseStoryboard } from './motion-storyboard';

const CARRIERS = [
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
  if (/[0-9０-９]|%|％|倍|万|亿|人数|金额|参数/.test(haystack)) return 'data-hero';
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

export function buildDeterministicMotionBible(input: {
  summary?: string;
  keywords?: string[];
  segments: AISegment[];
  warning?: string;
}): MotionBible {
  const carrierPlan = normalizeCarrierPlan([], input.segments);
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

  return {
    visualThesis: cleanText(value.visualThesis, '用统一的信息动效组织整期观点。'),
    rhythm: { density, heavySegments, quietSegments },
    carrierPlan: normalizeCarrierPlan(value.carrierPlan, segments),
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
      ? `本段 directive：segment=${directive.segmentId}，carrier=${directive.preferredCarrier ?? '未指定'}，intensity=${directive.intensity}，reason=${directive.reason}`
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
