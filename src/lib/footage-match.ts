/**
 * footage 轨的纯逻辑：规划期 prompt 块、规划后处理规则、制作期匹配决策矩阵。
 * 全部无副作用、无 IPC，供 lib 层与单测直接复用。
 */

import type { AISegmentAnalysis, AISegmentVisualType } from '../types/ai';
import type { FootageMatchDecision, KacutLibraryDigest } from '../types/footage';

/** 仅供无人审阅的旧自动匹配路径使用；人工或 Agent 明确选材不受此阈值限制。 */
export const FOOTAGE_ADOPT_MIN_SCORE = 0.7;
/** 仅供无人审阅的旧自动匹配路径记录低分区间。 */
export const FOOTAGE_FALLBACK_MIN_SCORE = 0.4;

/** 把导演常见但素材标签命中较差的词收敛为检索库常用表达，并去掉同义重复。 */
export function normalizeFootageQuery(query: string): string {
  const normalized = query
    .trim()
    .split(/\s+/u)
    .map((term) => term === '车道' ? '道路' : term)
    .filter(Boolean);
  const terms = Array.from(new Set(normalized));
  if (terms.includes('汽车')) {
    const vehicleIndex = terms.indexOf('车辆');
    if (vehicleIndex >= 0) terms.splice(vehicleIndex, 1);
  }
  return terms.slice(0, 6).join(' ');
}

export interface FootageMatchVerdict {
  decision: FootageMatchDecision;
  /**
   * 未认领时 cards 轨应使用的视觉形态；adopt 时为 null（不出卡）。
   * 'none'（无结果 / 检索失败）仍按导演指定的 footageFallback 出卡。
   */
  cardVisualType: 'image' | 'motion' | null;
}

/**
 * 无人审阅的旧自动匹配决策矩阵（topScore 为最高匹配分；null 表示无结果 / 检索失败）：
 * 已由用户或导演 Agent 检视并明确选择的素材不调用此函数，检索分只保留为排序与审计信息。
 * - ≥ 0.7 → adopt（素材上屏，该段不出卡）
 * - 0.4–0.7 → 按 footageFallback 降级（'image' 走 image 卡片管线）
 * - < 0.4 → 按 footageFallback 降级
 * - 无结果 → 'none'，按 footageFallback 降级
 */
export function decideFootageMatch(
  topScore: number | null,
  footageFallback: 'image' | 'motion' = 'motion',
): FootageMatchVerdict {
  if (topScore == null || !Number.isFinite(topScore)) {
    return { decision: 'none', cardVisualType: footageFallback };
  }
  if (topScore >= FOOTAGE_ADOPT_MIN_SCORE) {
    return { decision: 'adopt', cardVisualType: null };
  }
  if (topScore >= FOOTAGE_FALLBACK_MIN_SCORE) {
    return footageFallback === 'image'
      ? { decision: 'fallback-image', cardVisualType: 'image' }
      : { decision: 'fallback-motion', cardVisualType: 'motion' };
  }
  return footageFallback === 'image'
    ? { decision: 'fallback-image', cardVisualType: 'image' }
    : { decision: 'fallback-motion', cardVisualType: 'motion' };
}

/**
 * 素材库摘要 → planning.segment prompt 注入块。
 * 只在 settings.kacut.enabled 且 digest 可用时出现；不出现则 prompt 与现状一致。
 */
export function buildFootageLibraryBlock(digest: KacutLibraryDigest): string {
  const kindOrder: Array<[string, string]> = [
    ['video', '视频'],
    ['image', '图片'],
    ['audio', '音频'],
    ['gif', 'GIF'],
  ];
  const kindParts = kindOrder
    .filter(([key]) => (digest.kindCounts?.[key] ?? 0) > 0)
    .map(([key, label]) => `${label} ${digest.kindCounts[key]} 条`);
  const tags = (digest.topSceneTags ?? [])
    .slice(0, 30)
    .map((item) => item.tag)
    .filter((tag) => typeof tag === 'string' && tag.trim());

  const lines: string[] = [];
  lines.push('');
  lines.push('');
  lines.push('【素材库 footage 轨道（可选）】');
  lines.push(
    `本机素材库可用：共 ${digest.itemCount} 条素材（${kindParts.join(' / ') || '分类统计缺失'}）。`,
  );
  if (tags.length > 0) {
    lines.push(`高频场景标签：${tags.join('、')}`);
  }
  lines.push('你可以把段落的 visualType 定为 "footage"，表示该段画面从素材库检索真实素材上屏，而不是默认生成卡片：');
  lines.push('- evidence 需要能核验到口播所述人物、机构、产品、地点或事件的来源特定素材；通用 B-roll 不能冒充事实现场；');
  lines.push('- context / emotion / demonstration / breath 可以使用相关且不误导的通用真实 B-roll，承担场景、情绪、动作过程或留白；');
  lines.push('- 数据 / 金句 / 结构化段落可用 motion；需要精确单张静帧呈现的可用 image；不要因为不需要来源特定证据就机械退回 motion；');
  lines.push('- 不设 footage 的数量、占比、连续段数或首尾禁用规则；逐段按叙事价值决定，零段或多段都可以；');
  lines.push(
    '- 选 footage 时必须同时给 footageQuery（2-6 个中文关键词，尽量贴合上方高频场景标签），' +
    '可选 footageFallback（"image" 或 "motion"，缺省 "motion"）：检索不到合适素材时的出卡退路。',
  );
  return lines.join('\n');
}

function revertFootageSegment(
  segment: AISegmentAnalysis,
  imageFallbackAvailable: boolean,
): AISegmentAnalysis {
  const fallback: AISegmentVisualType = segment.footageFallback === 'image' && imageFallbackAvailable
    ? 'image'
    : 'motion';
  // 维持不变式：footage* 字段只在 visualType==='footage' 时存在。
  return { ...segment, visualType: fallback, footageQuery: undefined, footageFallback: undefined };
}

/**
 * 规划后处理只维护可执行性，不替导演分配素材数量或位置：
 * 1. 未向 LLM 提供 footage 选项（kacut 未启用 / digest 不可用）时，仍出现的 footage 一律回落；
 * 2. footage 段必须带非空 footageQuery，否则回落；
 * 回落目标均为该段 footageFallback（缺省 'motion'）。
 */
export function enforceFootageSegmentRules(
  segments: AISegmentAnalysis[],
  options: { footageOffered: boolean; imageFallbackAvailable?: boolean },
): AISegmentAnalysis[] {
  if (segments.length === 0) return segments;
  let changed = false;

  const next = segments.map((segment) => {
    if (segment.visualType !== 'footage') {
      return segment;
    }
    const query = normalizeFootageQuery(segment.footageQuery ?? '');
    const lacksQuery = !query;
    if (!options.footageOffered || lacksQuery) {
      changed = true;
      return revertFootageSegment(segment, options.imageFallbackAvailable !== false);
    }
    if (query !== segment.footageQuery) {
      changed = true;
      return { ...segment, footageQuery: query };
    }
    return segment;
  });

  return changed ? next : segments;
}
