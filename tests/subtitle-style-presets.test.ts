import { describe, expect, it } from 'vitest';
import { createDefaultSubtitleStyle, type SubtitleStyle } from '../src/types';
import type { VisualStylePreset } from '../src/types/ai';
import {
  applySubtitlePreset,
  getSubtitlePresetById,
  resolveSubtitleStyle,
  SUBTITLE_STYLE_PRESETS,
} from '../src/lib/subtitle-style-presets';

/** 构造最小可用的视觉主题夹具；默认 bg 深 / ink 浅（与内置 9 个预设同向）。 */
function makeTheme(
  accent: string,
  overrides?: { bg?: string; ink?: string; body?: string },
): VisualStylePreset {
  return {
    id: 'test-theme',
    name: '测试主题',
    description: '',
    tags: [],
    source: 'test',
    palette: {
      bg: overrides?.bg ?? '#101014',
      ink: overrides?.ink ?? '#F2F2F2',
      muted: '#888888',
      accent,
    },
    fonts: {
      display: "'Test Display', serif",
      body: overrides?.body ?? "'Test Body', sans-serif",
    },
    facets: {},
  };
}

describe('字幕样式预设表', () => {
  it('内置 4 个预设，id 与名称完整', () => {
    expect(SUBTITLE_STYLE_PRESETS.map((preset) => preset.id)).toEqual([
      'podcast-elegant',
      'podcast-minimal',
      'podcast-serif',
      'classic-bold',
    ]);
    expect(SUBTITLE_STYLE_PRESETS.map((preset) => preset.name)).toEqual([
      '播客优雅',
      '极简白字',
      '沙龙衬线',
      '经典醒目',
    ]);
  });

  it('classic-bold 等于改动前的旧默认观感（700 字重 + 黄底 pop 色块 + 无背板 + 硬切）', () => {
    const classic = getSubtitlePresetById('classic-bold').style;
    expect(classic.fontSize).toBe(48);
    expect(classic.color).toBe('#FFFFFF');
    expect(classic.fontWeight).toBe(700);
    expect(classic.highlightBackgroundColor).toBe('#F8DC48');
    expect(classic.highlightTextColor).toBe('#FFFFFF');
    expect(classic.highlightAnimation).toBe('pop');
    expect(classic.highlightVariant).toBe('block');
    expect(classic.highlightRadius).toBe(12);
    expect(classic.backdropEnabled).toBe(false);
    expect(classic.enterAnimation).toBe('cut');
    expect(classic.exitFade).toBe(false);
    expect(classic.followTheme).toBe(false);
  });

  it('createDefaultSubtitleStyle 与 podcast-elegant 预设一致', () => {
    const { maxCharsPerEntry, autoResegment, ...restDefaults } = createDefaultSubtitleStyle();
    expect(restDefaults).toEqual(getSubtitlePresetById('podcast-elegant').style);
    expect(maxCharsPerEntry).toBe(35);
    expect(autoResegment).toBe(true);
  });

  it('未知 / 空预设 id 回退 podcast-elegant', () => {
    expect(getSubtitlePresetById('not-exists').id).toBe('podcast-elegant');
    expect(getSubtitlePresetById(undefined).id).toBe('podcast-elegant');
    expect(getSubtitlePresetById(null).id).toBe('podcast-elegant');
  });
});

describe('applySubtitlePreset', () => {
  it('整体替换样式，保留 maxCharsPerEntry / autoResegment', () => {
    const current: SubtitleStyle = {
      ...createDefaultSubtitleStyle(),
      maxCharsPerEntry: 50,
      autoResegment: false,
    };
    const applied = applySubtitlePreset('classic-bold', current);
    expect(applied.maxCharsPerEntry).toBe(50);
    expect(applied.autoResegment).toBe(false);
    expect(applied).toEqual({
      ...getSubtitlePresetById('classic-bold').style,
      maxCharsPerEntry: 50,
      autoResegment: false,
    });
  });
});

describe('resolveSubtitleStyle', () => {
  it('followTheme=true 时字体取 theme.fonts.body、高亮底色取 palette.accent', () => {
    const resolved = resolveSubtitleStyle(
      { ...createDefaultSubtitleStyle(), followTheme: true },
      makeTheme('#0A84FF', { body: "'Theme Body', sans-serif" }),
    );
    expect(resolved.fontFamily).toBe("'Theme Body', sans-serif");
    expect(resolved.highlightBackgroundColor).toBe('#0A84FF');
  });

  it('高亮文字色按 accent 亮度取 bg/ink：浅 accent 用 bg，深 accent 用 ink', () => {
    // #F8DC48 浅黄 → 深色文字（palette.bg）
    const lightAccent = resolveSubtitleStyle(
      { ...createDefaultSubtitleStyle(), followTheme: true },
      makeTheme('#F8DC48'),
    );
    expect(lightAccent.highlightTextColor).toBe('#101014');
    // #0A84FF 深色系统蓝 → 浅色文字（palette.ink）
    const darkAccent = resolveSubtitleStyle(
      { ...createDefaultSubtitleStyle(), followTheme: true },
      makeTheme('#0A84FF'),
    );
    expect(darkAccent.highlightTextColor).toBe('#F2F2F2');
  });

  it('followTheme=false 时不动字体与颜色', () => {
    const style: SubtitleStyle = {
      ...createDefaultSubtitleStyle(),
      followTheme: false,
      fontFamily: "'Custom Font', serif",
      highlightBackgroundColor: '#123456',
      highlightTextColor: '#654321',
    };
    const resolved = resolveSubtitleStyle(
      style,
      makeTheme('#0A84FF', { body: "'Theme Body', sans-serif" }),
    );
    expect(resolved.fontFamily).toBe("'Custom Font', serif");
    expect(resolved.highlightBackgroundColor).toBe('#123456');
    expect(resolved.highlightTextColor).toBe('#654321');
  });

  it('未提供主题时即使 followTheme=true 也保持样式自身值', () => {
    const style: SubtitleStyle = {
      ...createDefaultSubtitleStyle(),
      followTheme: true,
      fontFamily: "'Custom Font', serif",
      highlightBackgroundColor: '#123456',
    };
    const resolved = resolveSubtitleStyle(style);
    expect(resolved.fontFamily).toBe("'Custom Font', serif");
    expect(resolved.highlightBackgroundColor).toBe('#123456');
  });

  it('旧项目样式（缺新字段）解析后保留旧值并补齐 podcast-elegant 默认', () => {
    // 模拟旧 project.json 的字幕样式：只有改动前的平铺字段
    const legacy = {
      fontSize: 48,
      color: '#FFFFFF',
      position: 'bottom',
      highlightEnabled: true,
      highlightBackgroundColor: '#F8DC48',
      highlightTextColor: '#FFFFFF',
      highlightPaddingX: 10,
      highlightPaddingY: 4,
      highlightRadius: 12,
      highlightAnimation: 'pop',
      maxCharsPerEntry: 35,
      autoResegment: true,
    } as SubtitleStyle;
    const resolved = resolveSubtitleStyle(legacy);
    expect(resolved.fontSize).toBe(48);
    expect(resolved.highlightBackgroundColor).toBe('#F8DC48');
    expect(resolved.presetId).toBe('podcast-elegant');
    expect(resolved.backdropEnabled).toBe(true);
    expect(resolved.enterAnimation).toBe('fade-rise');
  });
});
