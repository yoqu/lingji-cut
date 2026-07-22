import { describe, expect, it } from 'vitest';
import { buildAICardOverlayData, getDefaultCardStyle, type AICard } from '../src/types/ai';

function makeCard(overrides: Partial<AICard> = {}): AICard {
  return {
    id: 'c1',
    segmentId: 's1',
    type: 'summary',
    title: 'T',
    content: '',
    startMs: 0,
    endMs: 1000,
    displayDurationMs: 5000,
    displayMode: 'fullscreen',
    template: 'summary-default',
    enabled: true,
    style: getDefaultCardStyle('summary'),
    ...overrides,
  };
}

describe('buildAICardOverlayData stylePresetId 透传', () => {
  it('保留单卡 stylePresetId', () => {
    const overlay = buildAICardOverlayData(makeCard({ stylePresetId: 'swiss-grid' }));
    expect(overlay.stylePresetId).toBe('swiss-grid');
  });

  it('未设置时为 undefined', () => {
    const overlay = buildAICardOverlayData(makeCard());
    expect(overlay.stylePresetId).toBeUndefined();
  });
});

import {
  resolveStylePresetId,
  getStylePresetById,
  getStyleFacetBlock,
  getContentTypeRuleBlock,
  getMotionStyleNotes,
  resolveContentTypeRule,
} from '../src/lib/card-style';
import { DEFAULT_STYLE_PRESET_ID } from '../src/types/ai';

describe('resolveStylePresetId 优先级', () => {
  it('单卡 > 项目 > 全局 > 默认', () => {
    expect(resolveStylePresetId({ card: 'a', project: 'b', global: 'c' })).toBe('a');
    expect(resolveStylePresetId({ project: 'b', global: 'c' })).toBe('b');
    expect(resolveStylePresetId({ global: 'c' })).toBe('c');
    expect(resolveStylePresetId({})).toBe(DEFAULT_STYLE_PRESET_ID);
  });
  it('空白字符串视为未设置', () => {
    expect(resolveStylePresetId({ card: '  ', project: 'editorial-eink' })).toBe('editorial-eink');
  });
  it('项目缺 stylePresetId 时解析回退默认', () => {
    expect(resolveStylePresetId({ project: undefined })).toBe(DEFAULT_STYLE_PRESET_ID);
  });
});

describe('getStylePresetById / getStyleFacetBlock 回退', () => {
  it('未知 id 回退默认 preset', () => {
    expect(getStylePresetById('does-not-exist').id).toBe(DEFAULT_STYLE_PRESET_ID);
  });
  it('缺失 facet 回退到默认风格同 facet（motion 非空）', () => {
    expect(getStyleFacetBlock('editorial-eink', 'motion').length).toBeGreaterThan(0);
  });
  it('未知 id 取默认风格的 facet', () => {
    expect(getStyleFacetBlock('nope', 'motion')).toBe(getStyleFacetBlock('editorial-eink', 'motion'));
  });
});

import { buildDefaultAISettings } from '../src/store/ai';

describe('AISettings 默认风格', () => {
  it('buildDefaultAISettings 给出默认风格 id', () => {
    expect(buildDefaultAISettings().defaultStylePresetId).toBe(DEFAULT_STYLE_PRESET_ID);
  });
});

import { DEFAULT_CONTENT_TYPE_RULES, VISUAL_STYLE_PRESETS } from '../src/lib/card-style-presets';
import { accentTextColor } from '../src/remotion/motion-kit';
import { STORYBOARD_CARRIERS } from '../src/lib/motion-storyboard';

describe('内容类型规则', () => {
  it('预设覆盖优先，其他类型回退共享默认', () => {
    expect(resolveContentTypeRule('nyt-data', 'data').source).toBe('preset');
    expect(resolveContentTypeRule('nyt-data', 'narration')).toEqual({
      rule: DEFAULT_CONTENT_TYPE_RULES.narration,
      source: 'default',
    });
  });

  it('无 semanticType 不注入，有值时包含载体与密度', () => {
    expect(getContentTypeRuleBlock('nyt-data', undefined)).toBe('');
    expect(getContentTypeRuleBlock('nyt-data', 'data')).toContain('trend > data-hero > comparison');
    expect(getContentTypeRuleBlock('nyt-data', 'data')).toContain('信息密度：heavy');
  });

  it('全部默认与预设 carrier 都属于 storyboard 枚举', () => {
    const allowed = new Set<string>(STORYBOARD_CARRIERS);
    for (const rule of Object.values(DEFAULT_CONTENT_TYPE_RULES)) {
      expect(rule.preferredCarriers.every((carrier) => allowed.has(carrier))).toBe(true);
    }
    for (const preset of VISUAL_STYLE_PRESETS) {
      for (const rule of Object.values(preset.contentTypeRules ?? {})) {
        expect(rule!.preferredCarriers.every((carrier) => allowed.has(carrier)), preset.id).toBe(true);
      }
    }
  });

  it('结构化运动细则与旧提示合并输出', () => {
    const notes = getMotionStyleNotes('nyt-data');
    expect(notes).toContain('图表工艺');
    expect(notes).toContain('禁用清单');
    expect(notes).toContain('补充说明');
  });
});

describe('预设调色板撞色防回归', () => {
  it('任何预设的 motion accent 不得与 surface 面色同色（面内 accent 元素会隐形）', () => {
    for (const preset of VISUAL_STYLE_PRESETS) {
      const t = preset.motionTokens;
      const surfaceBg = t?.surface && t.surface.kind !== 'none' ? t.surface.bg : undefined;
      if (!t || !surfaceBg) continue;
      expect(t.palette.accent.toLowerCase(), `${preset.id} accent == surface.bg`).not.toBe(
        surfaceBg.toLowerCase(),
      );
    }
  });

  it('每个预设 accentTextColor 产出的字色对页面底可读（守卫回落 ink 或 accent 本身达标）', () => {
    for (const preset of VISUAL_STYLE_PRESETS) {
      const t = preset.motionTokens;
      if (!t) continue;
      const color = accentTextColor(t);
      expect([t.palette.accent, t.palette.ink], preset.id).toContain(color);
    }
  });

  it('rgba 半透明 surface 会先与页面底合成再判断对比度', () => {
    expect(accentTextColor({
      palette: { bg: '#000000', ink: '#777777', muted: '#888888', accent: '#00CC00' },
      surface: { kind: 'panel', bg: 'rgba(255,255,255,0.92)' },
    })).toBe('#777777');
  });
});
