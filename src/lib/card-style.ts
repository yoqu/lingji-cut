import {
  DEFAULT_STYLE_PRESET_ID,
  type AISegmentSemanticType,
  type VisualContentTypeRule,
  type VisualStyleFacetKind,
  type VisualStylePreset,
} from '../types/ai';
import { DEFAULT_CONTENT_TYPE_RULES, VISUAL_STYLE_PRESETS } from './card-style-presets';

const PRESET_BY_ID = new Map<string, VisualStylePreset>(
  VISUAL_STYLE_PRESETS.map((p) => [p.id, p]),
);

export function getStylePresetById(id: string | undefined | null): VisualStylePreset {
  const found = id ? PRESET_BY_ID.get(id) : undefined;
  return found ?? PRESET_BY_ID.get(DEFAULT_STYLE_PRESET_ID)!;
}

export interface StylePresetScope {
  card?: string | null;
  project?: string | null;
  global?: string | null;
}

function pick(value: string | null | undefined): string | undefined {
  const v = typeof value === 'string' ? value.trim() : '';
  return v.length > 0 ? v : undefined;
}

/** 单卡 → 项目 → 全局 → 内置默认；仅做优先级选择，不校验存在性（下游 getStylePresetById 兜底）。 */
export function resolveStylePresetId(scope: StylePresetScope): string {
  return pick(scope.card) ?? pick(scope.project) ?? pick(scope.global) ?? DEFAULT_STYLE_PRESET_ID;
}

/**
 * 取某风格某 facet 的提示词块；缺失 facet（空串 / undefined）回退到内置默认风格的同 facet。
 * 注入到提示词的 {{styleSystemBlock}}。
 * motion facet 已结构化为 tokens：此处对 motion 的请求返回 tokens JSON，
 * 保证旧自定义模板里的 {{styleSystemBlock}} 仍有内容。
 */
export function getStyleFacetBlock(
  presetId: string | undefined | null,
  facet: VisualStyleFacetKind,
): string {
  if (facet === 'motion') return getMotionTokensBlock(presetId);
  const preset = getStylePresetById(presetId);
  const block = preset.facets[facet];
  if (block && block.trim().length > 0) return block;
  const fallback = getStylePresetById(DEFAULT_STYLE_PRESET_ID).facets[facet];
  return fallback ?? '';
}

/**
 * 取某风格的 Motion tokens JSON（注入 {{presetMotionTokens}}，卡片里原样定义为 TOKENS 常量）。
 * 预设未定义 motionTokens 时回退默认风格的 tokens。
 */
export function getMotionTokensBlock(presetId: string | undefined | null): string {
  const preset = getStylePresetById(presetId);
  const tokens =
    preset.motionTokens ?? getStylePresetById(DEFAULT_STYLE_PRESET_ID).motionTokens ?? null;
  if (!tokens) return '{}';
  return JSON.stringify(tokens, null, 2);
}

export function resolveContentTypeRule(
  presetId: string | undefined | null,
  type: AISegmentSemanticType,
): { rule: VisualContentTypeRule; source: 'preset' | 'default' } {
  const preset = getStylePresetById(presetId);
  const override = preset.contentTypeRules?.[type];
  return override
    ? { rule: override, source: 'preset' }
    : { rule: DEFAULT_CONTENT_TYPE_RULES[type], source: 'default' };
}

export function getContentTypeRuleBlock(
  presetId: string | undefined | null,
  semanticType: AISegmentSemanticType | undefined,
): string {
  if (!semanticType) return '';
  const { rule } = resolveContentTypeRule(presetId, semanticType);
  const density = rule.density ? `｜信息密度：${rule.density}` : '';
  return `本段内容类型：${semanticType}｜推荐载体：${rule.preferredCarriers.join(' > ')}${density}｜生产规则：${rule.renderingRules}`;
}

/** 合并结构化运动细则与旧版专属提示，注入 {{presetStyleNotes}}。 */
export function getMotionStyleNotes(presetId: string | undefined | null): string {
  const preset = getStylePresetById(presetId);
  const spec = preset.motionSpec;
  const lines = [
    spec?.chartRules ? `图表工艺：${spec.chartRules}` : '',
    spec?.emphasisRules ? `强调规则：${spec.emphasisRules}` : '',
    spec?.typographyRules ? `排版规则：${spec.typographyRules}` : '',
    spec?.banned ? `禁用清单：${spec.banned}` : '',
    preset.motionStyleNotes?.trim() ? `补充说明：${preset.motionStyleNotes.trim()}` : '',
  ].filter(Boolean);
  return lines.length > 0 ? `风格专属提示：\n${lines.join('\n')}` : '';
}
