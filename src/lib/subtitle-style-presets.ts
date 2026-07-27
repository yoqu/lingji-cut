import { createDefaultSubtitleStyle, type SubtitleStyle } from '../types';
import type { VisualStylePreset } from '../types/ai';

/**
 * 播客优雅字幕样式体系：预设定骨架，主题注色彩与字体。
 * 预设表每个条目都是完整样式（Required 约束），applySubtitlePreset 整体覆盖，
 * 只保留与风格无关的切分字段（maxCharsPerEntry / autoResegment）。
 */

/** 系统黑体栈：旧版不显式指定字体时 Chromium 在各平台本就回落到这几个字体 */
export const SUBTITLE_SANS_FONT_STACK =
  "'PingFang SC','HarmonicOS Sans SC','Source Han Sans SC','Microsoft YaHei',sans-serif";
/** 沙龙衬线栈 */
export const SUBTITLE_SERIF_FONT_STACK = "'Songti SC','Noto Serif SC',serif";

/** Inspector 字体栈下拉的候选项（跟随主题时下拉禁用，由 VisualStylePreset.fonts.body 接管） */
export const SUBTITLE_FONT_STACK_OPTIONS: Array<{ value: string; label: string }> = [
  { value: SUBTITLE_SANS_FONT_STACK, label: '系统黑体' },
  { value: SUBTITLE_SERIF_FONT_STACK, label: '沙龙衬线' },
];

export const DEFAULT_SUBTITLE_PRESET_ID = 'podcast-elegant';

/** 预设覆盖的完整样式（不含切分字段；Required 保证预设即最终观感，无隐藏继承） */
type SubtitlePresetStyle = Required<Omit<SubtitleStyle, 'maxCharsPerEntry' | 'autoResegment'>>;

export interface SubtitleStylePreset {
  id: string;
  name: string;
  description: string;
  style: SubtitlePresetStyle;
}

const PILL_BACKDROP = {
  backdropColor: 'rgba(8,10,14,0.52)',
  backdropRadius: 16,
  backdropPaddingX: 22,
  backdropPaddingY: 10,
} as const;

export const SUBTITLE_STYLE_PRESETS: SubtitleStylePreset[] = [
  {
    id: 'podcast-elegant',
    name: '播客优雅',
    description: 'pill 背板 + 字重 500 + fade-rise + accent 文字高亮',
    style: {
      fontSize: 42,
      color: '#F5F5F7',
      position: 'bottom',
      highlightEnabled: false,
      highlightBackgroundColor: '#0A84FF',
      highlightTextColor: '#FFFFFF',
      highlightPaddingX: 10,
      highlightPaddingY: 4,
      highlightRadius: 10,
      highlightAnimation: 'wipe',
      presetId: 'podcast-elegant',
      followTheme: true,
      fontFamily: SUBTITLE_SANS_FONT_STACK,
      fontWeight: 500,
      letterSpacing: 0.84,
      backdropEnabled: true,
      ...PILL_BACKDROP,
      enterAnimation: 'fade-rise',
      exitFade: true,
      highlightVariant: 'text',
    },
  },
  {
    id: 'podcast-minimal',
    name: '极简白字',
    description: '无背板 + 柔和 textShadow + 字重 500 + fade',
    style: {
      fontSize: 42,
      color: '#F5F5F7',
      position: 'bottom',
      highlightEnabled: false,
      highlightBackgroundColor: '#0A84FF',
      highlightTextColor: '#FFFFFF',
      highlightPaddingX: 10,
      highlightPaddingY: 4,
      highlightRadius: 10,
      highlightAnimation: 'wipe',
      presetId: 'podcast-minimal',
      followTheme: true,
      fontFamily: SUBTITLE_SANS_FONT_STACK,
      fontWeight: 500,
      letterSpacing: 0.84,
      backdropEnabled: false,
      ...PILL_BACKDROP,
      enterAnimation: 'fade',
      exitFade: true,
      highlightVariant: 'text',
    },
  },
  {
    id: 'podcast-serif',
    name: '沙龙衬线',
    description: '衬线字体 + 字距放宽 + fade-rise（不跟随主题，保住衬线身份）',
    style: {
      fontSize: 42,
      color: '#F5F5F7',
      position: 'bottom',
      highlightEnabled: false,
      highlightBackgroundColor: '#C9A86A',
      highlightTextColor: '#FFFFFF',
      highlightPaddingX: 10,
      highlightPaddingY: 4,
      highlightRadius: 10,
      highlightAnimation: 'wipe',
      presetId: 'podcast-serif',
      followTheme: false,
      fontFamily: SUBTITLE_SERIF_FONT_STACK,
      fontWeight: 500,
      letterSpacing: 1.26,
      backdropEnabled: true,
      ...PILL_BACKDROP,
      enterAnimation: 'fade-rise',
      exitFade: true,
      highlightVariant: 'text',
    },
  },
  {
    id: 'classic-bold',
    name: '经典醒目',
    description: '旧版默认观感：700 字重 + 黄底 pop 色块 + 无背板 + 硬切',
    style: {
      fontSize: 48,
      color: '#FFFFFF',
      position: 'bottom',
      highlightEnabled: false,
      highlightBackgroundColor: '#F8DC48',
      highlightTextColor: '#FFFFFF',
      highlightPaddingX: 10,
      highlightPaddingY: 4,
      highlightRadius: 12,
      highlightAnimation: 'pop',
      presetId: 'classic-bold',
      followTheme: false,
      fontFamily: SUBTITLE_SANS_FONT_STACK,
      fontWeight: 700,
      letterSpacing: 0,
      backdropEnabled: false,
      ...PILL_BACKDROP,
      enterAnimation: 'cut',
      exitFade: false,
      highlightVariant: 'block',
    },
  },
];

const PRESET_BY_ID = new Map<string, SubtitleStylePreset>(
  SUBTITLE_STYLE_PRESETS.map((preset) => [preset.id, preset]),
);

export function getSubtitlePresetById(id: string | undefined | null): SubtitleStylePreset {
  const found = id ? PRESET_BY_ID.get(id) : undefined;
  return found ?? PRESET_BY_ID.get(DEFAULT_SUBTITLE_PRESET_ID)!;
}

/** 套用预设：样式整体替换，保留与风格无关的切分设置。 */
export function applySubtitlePreset(presetId: string, current: SubtitleStyle): SubtitleStyle {
  const preset = getSubtitlePresetById(presetId);
  return {
    ...preset.style,
    maxCharsPerEntry: current.maxCharsPerEntry,
    autoResegment: current.autoResegment,
  };
}

/**
 * 渲染期解析最终样式：先填充默认（旧 project.json 缺新字段时与加载合并同值），
 * followTheme 开启且有主题时，字体与高亮 accent 由 VisualStylePreset 派生；
 * 高亮文字色按 accent 相对亮度自动取 palette.bg/ink，保证对比度。
 */
export function resolveSubtitleStyle(
  style: SubtitleStyle,
  theme?: VisualStylePreset,
): SubtitleStyle {
  const merged: SubtitleStyle = { ...createDefaultSubtitleStyle(), ...style };
  if (!merged.followTheme || !theme) return merged;
  return {
    ...merged,
    fontFamily: theme.fonts.body,
    highlightBackgroundColor: theme.palette.accent,
    highlightTextColor:
      contrastOnAccent(theme.palette.accent) === 'light' ? theme.palette.bg : theme.palette.ink,
  };
}

/** 判断 accent 本身是浅色还是深色（WCAG 相对亮度），内部工具 */
function contrastOnAccent(hex: string): 'light' | 'dark' {
  const rgb = parseHexColor(hex);
  if (!rgb) return 'dark';
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.35 ? 'light' : 'dark';
}

function parseHexColor(hex: string): [number, number, number] | null {
  const match = /^#(?:([0-9a-f]{3})|([0-9a-f]{6}))$/i.exec(hex.trim());
  if (!match) return null;
  const full = match[2] ?? match[1].split('').map((c) => c + c).join('');
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}
