/**
 * motion-hybrid.ts
 *
 * hybrid 出卡模式（motionCardMode === 'hybrid'）的分段筛选：重点段走 agent 精雕
 * （LLM 雕刻+修复+审查多轮链路），普通段走 template 确定性编译——把 LLM 创造力
 * 花在刀刃上，同时用每期上限锁住 token 成本。
 *
 * 命中规则（任一即视为重点段）：
 *   - planning 产的 visualizationScore ≥ HYBRID_AGENT_SCORE_THRESHOLD；
 *   - semanticType 为 data / quote（结构化内容，模板编舞表达力最吃力）；
 *   - 导演 Motion Bible carrierPlan 标 intensity = 3。
 * 上限：每期 agent 段 ≤ ceil(总段数 / 3) 且 ≤ HYBRID_AGENT_MAX_PER_RUN，
 * 候选按 visualizationScore 降序（缺分垫底）→ bible intensity 降序 → 原顺序截断，
 * 超出部分回落 template。段信号全部缺失时不进候选（回落 template）。
 *
 * 两个消费层：
 *   1. 批量路径（analyze-run）：持有全量段列表，selectHybridAgentSegments 预选后
 *      把决议注入 ctx.hybridDecision；
 *   2. 单卡路径（重生成 / 转换 / 手动选段）：编排器 resolveMotionCardPath 按单卡
 *      规则兜底判定（单卡即上限 1，无需预算概念）。
 */

import type { AISegmentSemanticType, AISegmentVisualType } from '../../src/types/ai';

/** visualizationScore（0-100）达到该值视为重点段；planning 缺省分 50 不会命中。 */
export const HYBRID_AGENT_SCORE_THRESHOLD = 75;
/** 这些语义类型的段天然需要数据/引用级表达，模板编舞上限不够。 */
export const HYBRID_AGENT_SEMANTIC_TYPES: readonly AISegmentSemanticType[] = ['data', 'quote'];
/** Motion Bible 给本段的最高强度标记。 */
export const HYBRID_AGENT_BIBLE_INTENSITY = 3;
/** 每期 agent 段硬上限（比例上限之外的绝对值闸）。 */
export const HYBRID_AGENT_MAX_PER_RUN = 6;
/** 每期 agent 段比例上限：不超过总段数的 1/3（向上取整，保证小期至少 1 段）。 */
export const HYBRID_AGENT_RATIO_DENOMINATOR = 3;

export interface HybridSegmentSignals {
  id: string;
  semanticType?: AISegmentSemanticType;
  visualizationScore?: number;
  motionBibleIntensity?: number;
}

export interface HybridSegmentDecision {
  agent: boolean;
  /** 命中原因或回落原因（telemetry / 观测面板展示用，不含敏感内容）。 */
  reasons: string[];
}

function finiteScore(signals: Pick<HybridSegmentSignals, 'visualizationScore'>): number | undefined {
  const score = signals.visualizationScore;
  return typeof score === 'number' && Number.isFinite(score) ? score : undefined;
}

/** 单段规则判定（不含上限概念）；上限截断见 selectHybridAgentSegments。 */
export function evaluateHybridSegment(signals: Omit<HybridSegmentSignals, 'id'>): HybridSegmentDecision {
  const reasons: string[] = [];
  const score = finiteScore(signals);
  if (score !== undefined && score >= HYBRID_AGENT_SCORE_THRESHOLD) {
    reasons.push(`visualizationScore ${score} ≥ ${HYBRID_AGENT_SCORE_THRESHOLD}`);
  }
  if (signals.semanticType && HYBRID_AGENT_SEMANTIC_TYPES.includes(signals.semanticType)) {
    reasons.push(`semanticType=${signals.semanticType}`);
  }
  if (signals.motionBibleIntensity === HYBRID_AGENT_BIBLE_INTENSITY) {
    reasons.push(`bible intensity=${HYBRID_AGENT_BIBLE_INTENSITY}`);
  }
  if (reasons.length > 0) return { agent: true, reasons };
  const hasAnySignal =
    score !== undefined || Boolean(signals.semanticType) || typeof signals.motionBibleIntensity === 'number';
  return { agent: false, reasons: [hasAnySignal ? '未命中精雕规则' : '缺段信号，回落 template'] };
}

export interface HybridSelectionOptions {
  /** 每期 agent 段上限；缺省 min(ceil(总数 / 3), HYBRID_AGENT_MAX_PER_RUN)。 */
  maxAgent?: number;
}

/**
 * 批量预选：对全量段做规则判定 + 每期上限截断。返回按段 id 的决议表；
 * 未进候选的段决议 agent=false（含回落原因），调用方按表注入 ctx.hybridDecision。
 */
export function selectHybridAgentSegments(
  segments: HybridSegmentSignals[],
  options: HybridSelectionOptions = {},
): Map<string, HybridSegmentDecision> {
  const cap = Math.max(
    0,
    Math.floor(
      options.maxAgent ??
        Math.min(
          Math.ceil(segments.length / HYBRID_AGENT_RATIO_DENOMINATOR),
          HYBRID_AGENT_MAX_PER_RUN,
        ),
    ),
  );
  const evaluated = segments.map((segment, index) => ({
    segment,
    index,
    decision: evaluateHybridSegment(segment),
  }));
  // 截断优先级：visualizationScore 降序（缺分 -1 垫底）→ bible intensity 降序 → 原顺序。
  const candidates = evaluated
    .filter((item) => item.decision.agent)
    .sort(
      (a, b) =>
        (finiteScore(b.segment) ?? -1) - (finiteScore(a.segment) ?? -1) ||
        (b.segment.motionBibleIntensity ?? 0) - (a.segment.motionBibleIntensity ?? 0) ||
        a.index - b.index,
    );
  const admitted = new Set(candidates.slice(0, cap).map((item) => item.index));
  const decisions = new Map<string, HybridSegmentDecision>();
  for (const item of evaluated) {
    if (!item.decision.agent) {
      decisions.set(item.segment.id, item.decision);
    } else if (admitted.has(item.index)) {
      decisions.set(item.segment.id, {
        agent: true,
        reasons: [...item.decision.reasons, `hybrid 预算内（≤${cap}）`],
      });
    } else {
      decisions.set(item.segment.id, {
        agent: false,
        reasons: [...item.decision.reasons, `超出每期 agent 上限 ${cap}，回落 template`],
      });
    }
  }
  return decisions;
}

/** 预选所需的导演方案最小结构；DirectorPlan 与 project.production.approvedPlan 均满足。 */
export interface HybridPlanLike {
  segments: Array<{
    id: string;
    enabled?: boolean;
    visualType?: AISegmentVisualType;
    semanticType?: AISegmentSemanticType;
    visualizationScore?: number;
  }>;
  motionBible?: {
    carrierPlan?: Array<{ segmentId: string; intensity?: number }>;
  } | null;
}

/**
 * 从导演方案构建 hybrid 预选表：只对启用的 motion 段（image 段不进 generateMotionCard）
 * 按规则 + 每期上限截断。analyze-run、analyze-srt IPC、generate-ai-card-for-segment
 * 三个批量入口共用，保证 renderer / headless 路径的 hybrid 分流口径一致。
 */
export function buildHybridSelectionFromPlan(plan: HybridPlanLike): Map<string, HybridSegmentDecision> {
  const intensityBySegment = new Map(
    (plan.motionBible?.carrierPlan ?? []).map(
      (directive) => [directive.segmentId, directive.intensity] as const,
    ),
  );
  return selectHybridAgentSegments(
    plan.segments
      .filter((segment) => segment.enabled !== false && (segment.visualType ?? 'motion') === 'motion')
      .map((segment) => ({
        id: segment.id,
        semanticType: segment.semanticType,
        visualizationScore: segment.visualizationScore,
        motionBibleIntensity: intensityBySegment.get(segment.id),
      })),
  );
}

export type MotionCardPath = 'template' | 'agent';

export interface MotionCardPathInput {
  motionCardMode?: 'template' | 'agent' | 'hybrid';
  /** 精雕时传入的现有组件源码；存在即强制 agent（模板编译会丢掉现有实现）。 */
  existingTsx?: string;
  semanticType?: AISegmentSemanticType;
  visualizationScore?: number;
  motionBibleIntensity?: number;
  /** 批量路径预选决议（含每期上限）；优先级高于单卡规则。 */
  hybridDecision?: HybridSegmentDecision;
}

export interface MotionCardPathDecision {
  path: MotionCardPath;
  /** hybrid 判定原因；非 hybrid 模式为空数组。 */
  reasons: string[];
}

/**
 * 编排器出卡路径决议：existingTsx → agent（精雕强制）；显式 template/agent 直译；
 * hybrid 先用批量预选决议，缺失时按单卡规则兜底（重生成 / 转换 / 手动选段场景）。
 */
export function resolveMotionCardPath(input: MotionCardPathInput): MotionCardPathDecision {
  if (input.existingTsx) return { path: 'agent', reasons: [] };
  const mode = input.motionCardMode ?? 'template';
  if (mode !== 'hybrid') return { path: mode, reasons: [] };
  if (input.hybridDecision) {
    return {
      path: input.hybridDecision.agent ? 'agent' : 'template',
      reasons: input.hybridDecision.reasons,
    };
  }
  const decision = evaluateHybridSegment(input);
  return { path: decision.agent ? 'agent' : 'template', reasons: decision.reasons };
}
