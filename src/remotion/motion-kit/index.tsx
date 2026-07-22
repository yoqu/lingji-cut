/**
 * @lingji/motion-kit —— Motion Card 运动设计系统（工艺层）。
 *
 * 卡片 TSX 通过 require 垫片 `import { ... } from '@lingji/motion-kit'` 使用本模块；
 * 垫片在两个上下文各自用 createMotionKit 绑定正确的 remotion 实例：
 * - 预览 / 导出（card-host）：真实 remotion；
 * - 生成期冒烟渲染（smoke-render）：固定帧垫片。
 *
 * 设计原则：好缓动、安全区、有界摄影机、装饰氛围、落地强调是常量不是创意——
 * 全部固化在这里，由构造保证合规；卡片代码只做"组合原语"的设计判断。
 */
import * as React from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { MotionEmphasisKind, TimingPlan } from '../../types/motion';

/* ============================== tokens ============================== */

export interface MotionTokens {
  palette: { bg: string; ink: string; muted: string; accent: string; track?: string };
  fonts: { display: string; body: string; mono: string };
  /** 字号阶梯，均为 H 的倍数 */
  typeScale?: { hero?: number; dataHero?: number; lead?: number; body?: number; label?: number };
  /** 面板质感：none=纯排版；glass/panel 给内容块半透明面 */
  surface?: { kind: 'none' | 'glass' | 'panel'; bg?: string; border?: string; radius?: number };
  ambient?: {
    kind: 'none' | 'grid' | 'orbs' | 'hairline' | 'grain';
    opacity?: [number, number];
    color?: string;
  };
  camera?: { mode: 'push' | 'pull' | 'pan' | 'still'; range?: [number, number] };
  persona?: {
    easing?: 'crisp' | 'calm' | 'bouncy';
    emphasis?: MotionKitEmphasis;
  };
}

export type MotionKitEmphasis = MotionEmphasisKind | 'settle' | 'underline' | 'none';

export const DEFAULT_MOTION_TOKENS: MotionTokens = {
  palette: { bg: '#0E0E10', ink: '#ECE7DA', muted: '#8A8478', accent: '#0A84FF', track: 'rgba(236,231,218,0.12)' },
  fonts: {
    display: "'Noto Serif SC', Georgia, serif",
    body: "'PingFang SC', 'Noto Sans SC', sans-serif",
    mono: "'SF Mono', 'JetBrains Mono', monospace",
  },
  typeScale: { hero: 0.15, dataHero: 0.26, lead: 0.05, body: 0.036, label: 0.025 },
  surface: { kind: 'none' },
  ambient: { kind: 'hairline', opacity: [0.08, 0.16] },
  camera: { mode: 'push', range: [0.99, 1.01] },
  persona: { easing: 'crisp', emphasis: 'settle' },
};

export function normalizeMotionTokens(partial?: Partial<MotionTokens> | null): MotionTokens {
  const d = DEFAULT_MOTION_TOKENS;
  if (!partial) return d;
  return {
    palette: { ...d.palette, ...partial.palette },
    fonts: { ...d.fonts, ...partial.fonts },
    typeScale: { ...d.typeScale, ...partial.typeScale },
    surface: { ...d.surface, ...partial.surface } as MotionTokens['surface'],
    ambient: { ...d.ambient, ...partial.ambient } as MotionTokens['ambient'],
    camera: { ...d.camera, ...partial.camera } as MotionTokens['camera'],
    persona: { ...d.persona, ...partial.persona },
  };
}

/* ---------- accent 字色对比度守卫 ----------
 * 浅色预设的 accent 多为"面色"（便签 / 高亮条），直接作前景文字会糊底。
 * WCAG 相对亮度对比不足 3:1 时字色回落 ink；只约束"字"，条 / 面 / 描线仍用 accent。
 * 原语可能坐在页面底（palette.bg）或面板底（surface.bg）上，任一底不达标即回落。 */

type Rgba = [number, number, number, number];

function parseColor(color: string): Rgba | null {
  const value = color.trim();
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hexMatch) {
    const hex = hexMatch[1].length === 3 ? hexMatch[1].replace(/./g, (c) => c + c) : hexMatch[1];
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
      1,
    ];
  }
  const rgbMatch = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(value);
  if (!rgbMatch) return null;
  return [
    Math.max(0, Math.min(255, Number(rgbMatch[1]))),
    Math.max(0, Math.min(255, Number(rgbMatch[2]))),
    Math.max(0, Math.min(255, Number(rgbMatch[3]))),
    Math.max(0, Math.min(1, rgbMatch[4] === undefined ? 1 : Number(rgbMatch[4]))),
  ];
}

function compositeColor(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (alpha <= 0) return [0, 0, 0, 0];
  return [
    (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
    alpha,
  ];
}

function colorLuminance(color: Rgba | null): number | null {
  if (!color) return null;
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
}

/** 导出仅供测试；卡片经 require 垫片只拿到 createMotionKit 的返回值，接触不到本函数。 */
export function accentTextColor(t: Pick<MotionTokens, 'palette' | 'surface'>): string {
  const { palette, surface } = t;
  const page = parseColor(palette.bg);
  const accent = parseColor(palette.accent);
  const la = colorLuminance(accent && page ? compositeColor(accent, page) : accent);
  if (la == null) return palette.accent;
  const contrastOk = (bgLum: number | null) => {
    if (bgLum == null) return true; // 不可解析（rgba 等）时不否决
    return (Math.max(la, bgLum) + 0.05) / (Math.min(la, bgLum) + 0.05) >= 3;
  };
  const surfaceColor = surface && surface.kind !== 'none' && surface.bg ? parseColor(surface.bg) : null;
  const effectiveSurface = surfaceColor && page ? compositeColor(surfaceColor, page) : surfaceColor;
  return contrastOk(colorLuminance(page)) && contrastOk(colorLuminance(effectiveSurface)) ? palette.accent : palette.ink;
}

/* ============================== remotion 注入 ============================== */

type EasingFn = (t: number) => number;

export interface MotionKitRemotion {
  useCurrentFrame: () => number;
  useVideoConfig: () => { width: number; height: number; fps: number; durationInFrames: number };
  interpolate: (
    input: number,
    inputRange: number[],
    outputRange: number[],
    options?: { extrapolateLeft?: string; extrapolateRight?: string; easing?: EasingFn },
  ) => number;
  spring: (args: {
    frame: number;
    fps: number;
    config?: { damping?: number; stiffness?: number; mass?: number };
    durationInFrames?: number;
  }) => number;
  Easing: {
    in: (e: EasingFn) => EasingFn;
    out: (e: EasingFn) => EasingFn;
    inOut: (e: EasingFn) => EasingFn;
    quad: EasingFn;
    cubic: EasingFn;
    sin: EasingFn;
    back: (s?: number) => EasingFn;
    poly: (n: number) => EasingFn;
  };
  AbsoluteFill: React.ComponentType<{ style?: CSSProperties; children?: ReactNode }>;
}

export interface Beat {
  /** 揭示起始帧（已按提前量 / entrance / 单调性 clamp） */
  start: number;
  /** 线性揭示进度 0→1（手法函数内部各自应用缓动） */
  p: number;
  /** 揭示窗结束帧（落地强调的锚点） */
  land: number;
  done: boolean;
}

export type SafeLayoutVariant =
  | 'single-focus'
  | 'title-hero'
  | 'split-compare'
  | 'chart-with-kicker'
  | 'list-with-kicker'
  | 'asset-aside';

export type MotionSlotName =
  | 'header'
  | 'main'
  | 'asset'
  | 'background';

export interface MotionSlotLifecycle {
  enter?: Beat;
  update?: Beat;
  collapse?: Beat;
  exit?: Beat;
}

interface StageState {
  tokens: MotionTokens;
  W: number;
  H: number;
  /** 内容盒宽（CardStage 左右各留 10%）；整行元素 / svg 宽度用 CW，用 W 全宽必溢出 */
  CW: number;
  /** 内容盒高（顶部 8% + 底部 20% 字幕安全区之外） */
  CH: number;
  fps: number;
  D: number;
  frame: number;
}

export interface MotionKit {
  CardStage: React.ComponentType<{ tokens?: Partial<MotionTokens> | null; children?: ReactNode; style?: CSSProperties }>;
  SafeLayout: React.ComponentType<{ variant: SafeLayoutVariant; children?: ReactNode; style?: CSSProperties }>;
  MotionSlot: React.ComponentType<{
    name: MotionSlotName;
    role?: 'focus' | 'support' | 'asset' | 'decorative';
    lifecycle?: MotionSlotLifecycle;
    children?: ReactNode;
    style?: CSSProperties;
  }>;
  useStage: () => StageState;
  useBeats: (cues: number[], anchors: Array<number | null>, opts?: { lead?: number; dur?: number }) => Beat[];
  useTimingPlan: (
    timingPlan: TimingPlan | undefined,
    cues: number[],
    anchors: Array<number | null>,
    opts?: { lead?: number; dur?: number },
  ) => Beat[];
  fadeUp: (p: number, dist?: number) => CSSProperties;
  slideIn: (p: number, dir?: 'left' | 'right', dist?: number) => CSSProperties;
  riseIn: (p: number) => CSSProperties;
  popIn: (p: number) => CSSProperties;
  trackIn: (p: number) => CSSProperties;
  drawOn: (p: number, axis?: 'x' | 'y') => CSSProperties;
  countUp: (p: number, value: number, decimals?: number) => string;
  settle: (frame: number, land: number, fps: number, max?: number) => CSSProperties;
  brighten: (frame: number, land: number) => CSSProperties;
  emphasize: (frame: number, land: number, fps: number, kind?: MotionKitEmphasis) => CSSProperties;
  Kicker: React.ComponentType<{ text: string; beat: Beat; accent?: boolean }>;
  StatHero: React.ComponentType<{
    value: number;
    unit?: string;
    label?: string;
    beat: Beat;
    decimals?: number;
    emphasis?: MotionKitEmphasis;
    /** 提供 max 时在数字下方画等比配重条 */
    max?: number;
  }>;
  RingCounter: React.ComponentType<{
    value: number;
    max?: number;
    unit?: string;
    label?: string;
    beat: Beat;
    decimals?: number;
    emphasis?: MotionKitEmphasis;
  }>;
  BarChart: React.ComponentType<{
    items: Array<{ label: string; value: number; display?: string }>;
    beat: Beat;
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }>;
  HorizontalBars: React.ComponentType<{
    items: Array<{ label: string; value: number; display?: string }>;
    beat: Beat;
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }>;
  TrendLine: React.ComponentType<{
    points: number[];
    beat: Beat;
    startLabel?: string;
    endLabel?: string;
    markers?: Array<{ index: number; label?: string }>;
    fill?: boolean;
    emphasis?: MotionKitEmphasis;
  }>;
  CompareRow: React.ComponentType<{
    left: { label: string; value: string };
    right: { label: string; value: string };
    beat: Beat;
    divider?: string;
    focusSide?: 'left' | 'right';
    emphasis?: MotionKitEmphasis;
  }>;
  ListBuild: React.ComponentType<{
    items: string[];
    beat?: Beat;
    beats?: Beat[];
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }>;
  RankList: React.ComponentType<{
    items: Array<{ label: string; value?: string }>;
    beat?: Beat;
    beats?: Beat[];
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }>;
  ChecklistPop: React.ComponentType<{
    items: string[];
    beat?: Beat;
    beats?: Beat[];
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }>;
  ProcessFlow: React.ComponentType<{ steps: string[]; beat?: Beat; beats?: Beat[]; focusIndex?: number; emphasis?: MotionKitEmphasis }>;
  CauseChain: React.ComponentType<{ steps: string[]; beat?: Beat; beats?: Beat[]; focusIndex?: number; emphasis?: MotionKitEmphasis }>;
  QuoteBlock: React.ComponentType<{ text: string; source?: string; beat: Beat; emphasis?: MotionKitEmphasis }>;
  CitationCard: React.ComponentType<{ text: string; source: string; date?: string; beat: Beat; emphasis?: MotionKitEmphasis }>;
  KeyPointMarker: React.ComponentType<{ text: string; label?: string; beat: Beat; emphasis?: MotionKitEmphasis }>;
  ConceptCard: React.ComponentType<{ term: string; definition: string; hint?: string; beat: Beat; emphasis?: MotionKitEmphasis }>;
  TimelineRail: React.ComponentType<{ items: string[]; beat?: Beat; beats?: Beat[]; focusIndex?: number; emphasis?: MotionKitEmphasis }>;
  MatrixQuadrant: React.ComponentType<{
    xLabel?: string;
    yLabel?: string;
    items: Array<{ label: string; x: number; y: number; focus?: boolean }>;
    beat: Beat;
    emphasis?: MotionKitEmphasis;
  }>;
  FunnelStack: React.ComponentType<{ steps: Array<{ label: string; value?: string }>; beat: Beat; focusIndex?: number; emphasis?: MotionKitEmphasis }>;
  NetworkMap: React.ComponentType<{ nodes: string[]; links?: Array<[number, number]>; beat: Beat; focusIndex?: number; emphasis?: MotionKitEmphasis }>;
  BeforeAfter: React.ComponentType<{ before: string; after: string; beat: Beat; mode?: 'split' | 'wipe'; focusSide?: 'before' | 'after'; emphasis?: MotionKitEmphasis }>;
  MythFactSwap: React.ComponentType<{ myth: string; fact: string; beat: Beat; swapBeat?: Beat; emphasis?: MotionKitEmphasis }>;
  StackedComposition: React.ComponentType<{ items: Array<{ label: string; value: number; display?: string }>; beat: Beat; focusIndex?: number; emphasis?: MotionKitEmphasis }>;
  /** 垂直柱状图：基线 + hairline 网格，柱弹性逐根生长；items ≤6 */
  ColumnChart: React.ComponentType<{
    items: Array<{ label: string; value: number; display?: string }>;
    beat: Beat;
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }>;
  /** 环形饼图：分段接力绘制 + 中心数字 + 图例；segments ≤5 */
  DonutChart: React.ComponentType<{
    segments: Array<{ label: string; value: number; display?: string }>;
    beat: Beat;
    focusIndex?: number;
    centerLabel?: string;
    emphasis?: MotionKitEmphasis;
  }>;
  /** 数据脉冲：巨型计数 + 落定后脉冲环扩散 + 可选 delta 徽章 */
  MetricPulse: React.ComponentType<{
    value: number;
    unit?: string;
    label?: string;
    delta?: string;
    beat: Beat;
    decimals?: number;
    emphasis?: MotionKitEmphasis;
  }>;
  /** 极致刻度：巨型数值 + 同值刻度尺，指示标记滑到 value，可选对照刻度 */
  ScaleImpact: React.ComponentType<{
    value: number;
    max: number;
    unit?: string;
    label?: string;
    reference?: { value: number; label: string };
    beat: Beat;
    decimals?: number;
    emphasis?: MotionKitEmphasis;
  }>;
  /** 多指标陈列：2×2 mini stat 网格逐格弹出；items ≤4 */
  StatGrid: React.ComponentType<{
    items: Array<{ value: string; label: string }>;
    beat?: Beat;
    beats?: Beat[];
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }>;
  /** 数据表：mono 表头 + hairline 分隔，行逐条揭示，focusRow accent；columns ≤4、rows ≤5 */
  DataTable: React.ComponentType<{
    columns: string[];
    rows: string[][];
    beat: Beat;
    focusRow?: number;
    emphasis?: MotionKitEmphasis;
  }>;
  /** 章节标题卡：mono 编号 + 大标题 + hairline 展开 + 可选副题 */
  SectionTitle: React.ComponentType<{
    index?: string;
    title: string;
    subtitle?: string;
    beat: Beat;
    emphasis?: MotionKitEmphasis;
  }>;
  UnderlineSweep: React.ComponentType<{ beat: Beat; width?: string }>;
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

export function createMotionKit(R: MotionKitRemotion): MotionKit {
  const { useCurrentFrame, useVideoConfig, interpolate, spring, Easing, AbsoluteFill } = R;

  const eases = {
    crisp: Easing.out(Easing.cubic),
    snap: Easing.out(Easing.quad),
    glide: Easing.inOut(Easing.sin),
    drive: Easing.out(Easing.poly(4)),
    lift: Easing.out(Easing.back(1.3)),
  };

  const StageCtx = React.createContext<StageState | null>(null);

  function useStage(): StageState {
    const ctx = React.useContext(StageCtx);
    const frame = useCurrentFrame();
    const { width, height, fps, durationInFrames } = useVideoConfig();
    return (
      ctx ?? {
        tokens: DEFAULT_MOTION_TOKENS,
        W: width,
        H: height,
        CW: width * 0.8,
        CH: height * 0.72,
        fps,
        D: durationInFrames,
        frame,
      }
    );
  }

  /**
   * 语义锚定节拍：anchors[i] = 第 i 拍内容在 cues 里被讲到的句索引。
   * 第 0 拍固定入场；提前量 / 单调不减 / 空 cues 均匀兜底 / clamp 全部内置。
   */
  function useBeats(
    cues: number[],
    anchors: Array<number | null>,
    opts: { lead?: number; dur?: number } = {},
  ): Beat[] {
    const frame = useCurrentFrame();
    const { durationInFrames: D } = useVideoConfig();
    const lead = opts.lead ?? 10;
    const dur = opts.dur ?? 14;
    const entranceEnd = Math.min(18, Math.round(D * 0.12));
    const n = Math.max(anchors.length, 1);
    const starts: number[] = [];
    for (let i = 0; i < n; i += 1) {
      let s: number;
      if (i === 0) {
        s = 0;
      } else {
        const k = anchors[i];
        const hasCue = Array.isArray(cues) && cues.length > 0 && k != null && k >= 0 && k < cues.length;
        s = hasCue
          ? cues[k as number] - lead
          : entranceEnd + (D * 0.8 - entranceEnd) * (n > 1 ? i / (n - 1) : 0);
        s = Math.max(entranceEnd, Math.min(D - 12, s));
        s = Math.max(s, starts[i - 1]);
      }
      starts.push(Math.round(s));
    }
    return starts.map((start) => ({
      start,
      p: interpolate(frame, [start, start + dur], [0, 1], CLAMP),
      land: start + dur,
      done: frame >= start + dur,
    }));
  }

  /**
   * 专业节奏计划：优先消费 render plan 注入的 TimingPlan；缺失时保持 useBeats 旧行为。
   * 返回仍是 Beat[]，让旧原语和新卡片共享同一个运动合约。
   */
  function useTimingPlan(
    timingPlan: TimingPlan | undefined,
    cues: number[],
    anchors: Array<number | null>,
    opts: { lead?: number; dur?: number } = {},
  ): Beat[] {
    const fallback = useBeats(cues, anchors, opts);
    const frame = useCurrentFrame();
    const { durationInFrames: D } = useVideoConfig();
    if (!timingPlan?.beats?.length) return fallback;
    const dur = opts.dur ?? 14;
    return timingPlan.beats.map((beat) => {
      const start = Math.max(0, Math.min(D - 1, Math.round(beat.startFrame)));
      const rawLand = Math.max(start + 1, Math.round(beat.landFrame));
      const land = Math.max(start + 1, Math.min(D, rawLand));
      const holdUntil = beat.holdUntil == null ? land : Math.max(land, Math.min(D, Math.round(beat.holdUntil)));
      return {
        start,
        p: interpolate(frame, [start, Math.max(start + 1, land || start + dur)], [0, 1], CLAMP),
        land,
        done: frame >= holdUntil,
      };
    });
  }

  /* ---------- 手法：每种自带不同缓动与幅度，构造性保证"入场反单调" ---------- */

  const fadeUp = (p: number, dist = 36): CSSProperties => {
    const e = eases.crisp(p);
    return { opacity: e, transform: `translateY(${(1 - e) * dist}px)` };
  };
  const slideIn = (p: number, dir: 'left' | 'right' = 'left', dist = 64): CSSProperties => {
    const e = eases.drive(p);
    const sign = dir === 'left' ? -1 : 1;
    return { opacity: e, transform: `translateX(${sign * (1 - e) * dist}px)` };
  };
  const riseIn = (p: number): CSSProperties => ({ opacity: eases.snap(p) });
  const popIn = (p: number): CSSProperties => {
    const e = eases.lift(p);
    return { opacity: Math.min(1, eases.snap(p) * 1.4), transform: `scale(${0.94 + e * 0.06})` };
  };
  const trackIn = (p: number): CSSProperties => {
    const e = eases.glide(p);
    return { opacity: e, letterSpacing: `${0.3 - e * 0.16}em` };
  };
  const drawOn = (p: number, axis: 'x' | 'y' = 'x'): CSSProperties => {
    const e = eases.glide(p);
    return axis === 'x'
      ? { transform: `scaleX(${e})`, transformOrigin: 'left center' }
      : { transform: `scaleY(${e})`, transformOrigin: 'center bottom' };
  };
  const countUp = (p: number, value: number, decimals = 0): string => {
    const v = value * eases.drive(p);
    return decimals > 0 ? v.toFixed(decimals) : String(Math.round(v));
  };

  /* ---------- 落地强调：一次性、有界、收敛后静止 ---------- */

  const settle = (frame: number, land: number, fps: number, max = 1.05): CSSProperties => {
    if (frame < land) return {};
    const s = spring({
      frame: frame - land,
      fps,
      config: { damping: 14, stiffness: 160, mass: 0.8 },
      durationInFrames: 16,
    });
    const scale = 1 + (max - 1) * Math.sin(Math.min(1, s) * Math.PI);
    return { transform: `scale(${scale.toFixed(4)})` };
  };
  const brighten = (frame: number, land: number): CSSProperties => {
    const e = interpolate(frame, [land, land + 4, land + 12], [1, 1.35, 1], CLAMP);
    return e === 1 ? {} : { filter: `brightness(${e.toFixed(3)})` };
  };
  const slam = (frame: number, land: number, fps: number): CSSProperties => {
    if (frame < land) return {};
    const s = spring({
      frame: frame - land,
      fps,
      config: { damping: 16, stiffness: 220, mass: 0.72 },
      durationInFrames: 14,
    });
    const progress = Math.max(0, Math.min(1, s));
    const scale = 1.12 - progress * 0.12;
    const translateY = -14 * (1 - progress);
    return { transform: `translateY(${translateY.toFixed(2)}px) scale(${scale.toFixed(4)})` };
  };
  const underlineSweep = (frame: number, land: number): CSSProperties => {
    const p = interpolate(frame, [land, land + 12], [0, 1], CLAMP);
    return {
      backgroundImage: 'linear-gradient(currentColor, currentColor)',
      backgroundRepeat: 'no-repeat',
      backgroundPosition: 'left bottom',
      backgroundSize: `${(p * 100).toFixed(1)}% 0.08em`,
      paddingBottom: '0.12em',
    };
  };
  const emphasize = (
    frame: number,
    land: number,
    fps: number,
    kind: MotionKitEmphasis = 'settle',
  ): CSSProperties => {
    if (kind === 'settle' || kind === 'countup-settle') return settle(frame, land, fps);
    if (kind === 'slam') return slam(frame, land, fps);
    if (kind === 'brighten') return brighten(frame, land);
    if (kind === 'underline' || kind === 'underline-sweep') return underlineSweep(frame, land);
    return {};
  };

  /* ---------- 舞台：安全区 / 摄影机 / 氛围 / 退场，一处实现处处合规 ---------- */

  function Ambient({ t, frame, W, H }: { t: MotionTokens; frame: number; W: number; H: number }) {
    const ambient = t.ambient ?? { kind: 'none' as const };
    if (ambient.kind === 'none') return null;
    const [lo, hi] = ambient.opacity ?? [0.06, 0.16];
    const opacity = lo + ((hi - lo) / 2) * (1 + Math.sin(frame / 90));
    const color = ambient.color ?? t.palette.accent;
    const base: CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none', opacity };
    if (ambient.kind === 'grid') {
      const cell = Math.round(H * 0.08);
      return (
        <div
          style={{
            ...base,
            backgroundImage: `repeating-linear-gradient(0deg, ${t.palette.track ?? 'rgba(255,255,255,0.1)'} 0 1px, transparent 1px ${cell}px), repeating-linear-gradient(90deg, ${t.palette.track ?? 'rgba(255,255,255,0.1)'} 0 1px, transparent 1px ${cell}px)`,
          }}
        />
      );
    }
    if (ambient.kind === 'orbs') {
      return (
        <div style={base}>
          <div
            style={{
              position: 'absolute',
              top: -H * 0.1,
              left: -W * 0.05,
              width: W * 0.35,
              height: W * 0.35,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${color}44, transparent 62%)`,
              filter: 'blur(40px)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              bottom: -H * 0.12,
              right: -W * 0.06,
              width: W * 0.3,
              height: W * 0.3,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${color}2e, transparent 62%)`,
              filter: 'blur(40px)',
            }}
          />
        </div>
      );
    }
    if (ambient.kind === 'grain') {
      return (
        <div
          style={{
            ...base,
            backgroundImage: `repeating-linear-gradient(45deg, ${t.palette.track ?? 'rgba(255,255,255,0.06)'} 0 1px, transparent 1px 5px)`,
          }}
        />
      );
    }
    // hairline：安全区顶部一条基线 + 左上角短 accent 刻度
    return (
      <div style={base}>
        <div
          style={{
            position: 'absolute',
            left: W * 0.1,
            right: W * 0.1,
            top: H * 0.075,
            height: 1,
            background: t.palette.track ?? 'rgba(255,255,255,0.14)',
          }}
        />
        <div
          style={{ position: 'absolute', left: W * 0.1, top: H * 0.075, width: W * 0.04, height: 2, background: color }}
        />
      </div>
    );
  }

  function CardStage({
    tokens,
    children,
    style,
  }: {
    tokens?: Partial<MotionTokens> | null;
    children?: ReactNode;
    style?: CSSProperties;
  }) {
    const frame = useCurrentFrame();
    const { width: W, height: H, fps, durationInFrames: D } = useVideoConfig();
    const t = normalizeMotionTokens(tokens);
    const camera = t.camera ?? { mode: 'still' as const };
    let cameraTransform = 'none';
    if (camera.mode !== 'still') {
      // range = [起点, 终点]，跨全片单调慢漂；push 通常升序（推近）、pull 降序（拉远），
      // 数值本身即真源，mode 只是语义标签。pan 把同一漂移映射为 ±小幅水平位移。
      const [a, b] = camera.range ?? (camera.mode === 'pull' ? [1.01, 0.99] : [0.99, 1.01]);
      const drift = interpolate(frame, [0, Math.max(D, 1)], [a, b], { ...CLAMP, easing: eases.glide });
      if (camera.mode === 'pan') {
        cameraTransform = `translateX(${((drift - (a + b) / 2) * W).toFixed(2)}px)`;
      } else {
        cameraTransform = `scale(${drift.toFixed(4)})`;
      }
    }
    const exitOpacity = D > 90 ? interpolate(frame, [D - 14, D], [1, 0], CLAMP) : 1;
    const stage: StageState = { tokens: t, W, H, CW: W * 0.8, CH: H * 0.72, fps, D, frame };
    return (
      <AbsoluteFill
        style={{
          background: `var(--lingji-card-stage-bg, ${t.palette.bg})`,
          color: t.palette.ink,
          fontFamily: t.fonts.body,
          opacity: exitOpacity,
          overflow: 'hidden',
          ...style,
        }}
      >
        <Ambient t={t} frame={frame} W={W} H={H} />
        <div style={{ position: 'absolute', inset: 0, transform: cameraTransform }}>
          <div
            style={{
              position: 'absolute',
              left: W * 0.1,
              right: W * 0.1,
              top: H * 0.08,
              bottom: H * 0.2,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
            }}
            data-role="cardstage-content"
          >
            <StageCtx.Provider value={stage}>{children}</StageCtx.Provider>
          </div>
        </div>
      </AbsoluteFill>
    );
  }

  function SafeLayout({
    variant,
    children,
    style,
  }: {
    variant: SafeLayoutVariant;
    children?: ReactNode;
    style?: CSSProperties;
  }) {
    const { H } = useStage();
    const gap = H * 0.035;
    const variants: Record<SafeLayoutVariant, CSSProperties> = {
      'single-focus': {
        gridTemplateColumns: 'minmax(0, 1fr)',
        gridTemplateRows: 'minmax(0, 1fr)',
        gridTemplateAreas: '"main"',
      },
      'title-hero': {
        gridTemplateColumns: 'minmax(0, 1fr)',
        gridTemplateRows: 'auto minmax(0, 1fr)',
        gridTemplateAreas: '"header" "main"',
      },
      'split-compare': {
        gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
        gridTemplateRows: 'auto minmax(0, 1fr)',
        gridTemplateAreas: '"header header" "main main"',
      },
      'chart-with-kicker': {
        gridTemplateColumns: 'minmax(0, 1fr)',
        gridTemplateRows: 'auto minmax(0, 1fr)',
        gridTemplateAreas: '"header" "main"',
      },
      'list-with-kicker': {
        gridTemplateColumns: 'minmax(0, 1fr)',
        gridTemplateRows: 'auto minmax(0, 1fr)',
        gridTemplateAreas: '"header" "main"',
      },
      'asset-aside': {
        gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 0.85fr)',
        gridTemplateRows: 'auto minmax(0, 1fr)',
        gridTemplateAreas: '"header header" "main asset"',
      },
    };
    return (
      <div
        data-motion-layout={variant}
        style={{
          width: '100%',
          height: '100%',
          minWidth: 0,
          minHeight: 0,
          display: 'grid',
          gap,
          alignItems: 'center',
          ...variants[variant],
          ...style,
        }}
      >
        {children}
      </div>
    );
  }

  function MotionSlot({
    name,
    role = name === 'main' ? 'focus' : name === 'asset' ? 'asset' : 'support',
    lifecycle,
    children,
    style,
  }: {
    name: MotionSlotName;
    role?: 'focus' | 'support' | 'asset' | 'decorative';
    lifecycle?: MotionSlotLifecycle;
    children?: ReactNode;
    style?: CSSProperties;
  }) {
    const { frame, fps } = useStage();
    const area: CSSProperties = { gridArea: name };
    const enter = lifecycle?.enter ? eases.crisp(lifecycle.enter.p) : 1;
    const collapse = lifecycle?.collapse ? eases.glide(lifecycle.collapse.p) : 0;
    const exit = lifecycle?.exit ? eases.crisp(lifecycle.exit.p) : 0;
    const lifecycleMotion: CSSProperties = lifecycle
      ? {
          opacity: Math.max(0, enter * (1 - collapse * 0.55) * (1 - exit)),
          transform: `translateY(${((1 - enter) * 18 - exit * 12).toFixed(2)}px) scale(${(1 - collapse * 0.16).toFixed(4)})`,
          transformOrigin: 'center top',
          ...(lifecycle.update ? emphasize(frame, lifecycle.update.land, fps, 'brighten') : {}),
        }
      : {};
    return (
      <div
        data-motion-id={`slot:${name}`}
        data-motion-layer={role === 'decorative' ? 'decorative' : 'semantic'}
        data-motion-role={role}
        style={{
          minWidth: 0,
          minHeight: 0,
          maxWidth: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          ...area,
          ...lifecycleMotion,
          ...style,
        }}
      >
        {children}
      </div>
    );
  }

  /* ---------- 面板质感（glass/panel 预设用；none 预设返回空） ---------- */

  function panelStyle(t: MotionTokens): CSSProperties {
    const s = t.surface;
    if (!s || s.kind === 'none') return {};
    return {
      background: s.bg ?? 'rgba(255,255,255,0.05)',
      border: `1px solid ${s.border ?? 'rgba(255,255,255,0.10)'}`,
      borderRadius: s.radius ?? 16,
    };
  }

  /* ---------- 内容原语 ---------- */

  function Kicker({ text, beat, accent = true }: { text: string; beat: Beat; accent?: boolean }) {
    const { tokens: t, H } = useStage();
    return (
      <div
        style={{
          fontFamily: t.fonts.mono,
          fontSize: H * (t.typeScale?.label ?? 0.025),
          fontWeight: 500,
          textTransform: 'uppercase',
          color: accent ? accentTextColor(t) : t.palette.muted,
          ...trackIn(beat.p),
        }}
      >
        {text}
      </div>
    );
  }

  function StatHero({
    value,
    unit,
    label,
    beat,
    decimals = 0,
    max,
    emphasis: emphasisOverride,
  }: {
    value: number;
    unit?: string;
    label?: string;
    beat: Beat;
    decimals?: number;
    max?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, W, fps, frame } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const ratio = max && max > 0 ? Math.min(1, value / max) : 0.62;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: H * 0.03, ...panelStyle(t), ...(t.surface && t.surface.kind !== 'none' ? { padding: `${H * 0.05}px ${W * 0.04}px` } : {}) }}>
        {label ? <Kicker text={label} beat={beat} /> : null}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: H * 0.02, opacity: eases.snap(beat.p) }}>
          <span
            style={{
              fontFamily: t.fonts.display,
              fontSize: H * (t.typeScale?.dataHero ?? 0.26),
              fontWeight: 600,
              lineHeight: 1,
              color: accentTextColor(t),
              fontVariantNumeric: 'tabular-nums',
              display: 'inline-block',
              ...emphasize(frame, beat.land, fps, emphasis),
            }}
          >
            {countUp(beat.p, value, decimals)}
          </span>
          {unit ? (
            <span style={{ fontFamily: t.fonts.body, fontSize: H * (t.typeScale?.lead ?? 0.05), color: t.palette.muted }}>
              {unit}
            </span>
          ) : null}
        </div>
        <div style={{ height: Math.max(4, H * 0.008), width: '100%', background: t.palette.track, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${ratio * 100}%`, background: t.palette.accent, ...drawOn(beat.p) }} />
        </div>
      </div>
    );
  }

  function RingCounter({
    value,
    max,
    unit,
    label,
    beat,
    decimals = 0,
    emphasis: emphasisOverride,
  }: {
    value: number;
    max?: number;
    unit?: string;
    label?: string;
    beat: Beat;
    decimals?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const ratio = max && max > 0 ? Math.max(0, Math.min(1, value / max)) : 1;
    const progress = ratio * eases.glide(beat.p);
    const circumference = 2 * Math.PI * 42;
    const pulse = interpolate(frame, [beat.land, beat.land + 14], [0, 1], CLAMP);
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: H * 0.055, ...panelStyle(t), ...(t.surface?.kind !== 'none' ? { padding: H * 0.04 } : {}) }}>
        <div style={{ position: 'relative', width: H * 0.32, height: H * 0.32, flexShrink: 0 }}>
          <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%', transform: 'rotate(-90deg)' }}>
            <circle cx={50} cy={50} r={42} fill="none" stroke={t.palette.track} strokeWidth={7} />
            <circle
              cx={50}
              cy={50}
              r={42}
              fill="none"
              stroke={t.palette.accent}
              strokeWidth={7}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - progress)}
            />
            <circle
              cx={50}
              cy={50}
              r={42 + pulse * 5}
              fill="none"
              stroke={t.palette.accent}
              strokeWidth={1.5}
              opacity={frame >= beat.land ? 1 - pulse : 0}
            />
          </svg>
        </div>
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: H * 0.018 }}>
          {label ? <Kicker text={label} beat={beat} /> : null}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: H * 0.014 }}>
            <span style={{ fontFamily: t.fonts.display, fontSize: H * ((t.typeScale?.dataHero ?? 0.26) * 0.72), lineHeight: 1, fontWeight: 650, color: accentTextColor(t), fontVariantNumeric: 'tabular-nums', display: 'inline-block', ...emphasize(frame, beat.land, fps, emphasis) }}>
              {countUp(beat.p, value, decimals)}
            </span>
            {unit ? <span style={{ fontFamily: t.fonts.body, fontSize: H * (t.typeScale?.body ?? 0.036), color: t.palette.muted }}>{unit}</span> : null}
          </div>
          {max && max > 0 ? <span style={{ fontFamily: t.fonts.mono, fontSize: H * (t.typeScale?.label ?? 0.025), color: t.palette.muted }}>MAX {max}</span> : null}
        </div>
      </div>
    );
  }

  function BarChart({
    items,
    beat,
    focusIndex = 0,
    emphasis: emphasisOverride,
  }: {
    items: Array<{ label: string; value: number; display?: string }>;
    beat: Beat;
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const safeItems = items.slice(0, 4);
    const maxValue = Math.max(...safeItems.map((it) => it.value), 1);
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: H * 0.03 }}>
        {safeItems.map((it, i) => {
          const rowStart = beat.start + i * 5;
          const p = interpolate(frame, [rowStart, rowStart + 18], [0, 1], CLAMP);
          const focus = i === focusIndex;
          const land = rowStart + 18;
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: H * 0.025, opacity: eases.snap(p) }}>
              <div
                style={{
                  fontFamily: t.fonts.mono,
                  fontSize: H * (t.typeScale?.label ?? 0.025),
                  color: focus ? t.palette.ink : t.palette.muted,
                  width: '18%',
                  flexShrink: 0,
                }}
              >
                {it.label}
              </div>
              <div style={{ flex: 1, height: H * 0.045, background: t.palette.track, overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${(it.value / maxValue) * 100}%`,
                    background: focus ? t.palette.accent : t.palette.muted,
                    ...drawOn(p),
                    ...(focus ? emphasize(frame, land, fps, emphasis) : {}),
                  }}
                />
              </div>
              <div
                style={{
                  fontFamily: t.fonts.display,
                  fontSize: H * ((t.typeScale?.body ?? 0.036) * 1.1),
                  fontVariantNumeric: 'tabular-nums',
                  color: focus ? accentTextColor(t) : t.palette.ink,
                  width: '14%',
                  textAlign: 'right',
                  flexShrink: 0,
                }}
              >
                {it.display ?? countUp(p, it.value)}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  function HorizontalBars({
    items,
    beat,
    focusIndex = 0,
    emphasis: emphasisOverride,
  }: {
    items: Array<{ label: string; value: number; display?: string }>;
    beat: Beat;
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const safeItems = items.slice(0, 5);
    const maxValue = Math.max(...safeItems.map((item) => Math.max(0, item.value)), 1);
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: H * 0.018 }}>
        {safeItems.map((item, index) => {
          const start = beat.start + index * 5;
          const p = interpolate(frame, [start, start + 15], [0, 1], CLAMP);
          const focus = index === focusIndex;
          return (
            <div key={index} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 22%) minmax(0, 1fr) auto', alignItems: 'center', gap: H * 0.018, ...fadeUp(p, 12) }}>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere', fontFamily: t.fonts.body, fontSize: H * 0.03, color: focus ? t.palette.ink : t.palette.muted }}>{item.label}</span>
              <div style={{ height: H * 0.034, background: t.palette.track, overflow: 'hidden' }}>
                <div style={{ width: `${(Math.max(0, item.value) / maxValue) * 100}%`, height: '100%', background: focus ? t.palette.accent : t.palette.muted, ...drawOn(p), ...(focus ? emphasize(frame, start + 15, fps, emphasis) : {}) }} />
              </div>
              <span style={{ minWidth: H * 0.07, textAlign: 'right', fontFamily: t.fonts.mono, fontSize: H * 0.028, color: focus ? accentTextColor(t) : t.palette.muted, fontVariantNumeric: 'tabular-nums' }}>{item.display ?? countUp(p, item.value)}</span>
            </div>
          );
        })}
      </div>
    );
  }

  function TrendLine({
    points,
    beat,
    startLabel,
    endLabel,
    markers = [],
    fill = false,
    emphasis: emphasisOverride,
  }: {
    points: number[];
    beat: Beat;
    startLabel?: string;
    endLabel?: string;
    markers?: Array<{ index: number; label?: string }>;
    fill?: boolean;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const safePoints = points.length > 0 ? points : [0];
    const min = Math.min(...safePoints);
    const max = Math.max(...safePoints);
    const span = max - min || 1;
    const coords = safePoints.map((v, i) => ({
      x: (i / Math.max(safePoints.length - 1, 1)) * 100,
      y: 38 - ((v - min) / span) * 32,
    }));
    const e = eases.glide(beat.p);
    const line = coords.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ');
    const last = coords[coords.length - 1];
    const first = coords[0];
    return (
      <div style={{ position: 'relative', width: '100%' }}>
        <svg viewBox="0 0 100 42" style={{ width: '100%', display: 'block', overflow: 'visible' }}>
          {fill ? (
            <polygon
              points={`${line} ${last.x.toFixed(2)},40 ${first.x.toFixed(2)},40`}
              fill={`color-mix(in srgb, ${t.palette.accent} 18%, transparent)`}
              clipPath={`inset(0 ${(1 - e) * 100}% 0 0)`}
              opacity={0.9}
            />
          ) : null}
          <polyline
            points={line}
            fill="none"
            stroke={t.palette.accent}
            strokeWidth={0.8}
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1 - e}
          />
          <circle cx={first.x} cy={first.y} r={1.2} fill={t.palette.muted} opacity={e > 0.05 ? 1 : 0} />
          <circle cx={last.x} cy={last.y} r={1.4} fill={t.palette.accent} opacity={beat.done ? 1 : 0} />
          {markers.slice(0, 4).map((marker, markerIndex) => {
            const index = Math.max(0, Math.min(coords.length - 1, Math.floor(marker.index)));
            const point = coords[index];
            const markerP = interpolate(frame, [beat.land + markerIndex * 4, beat.land + markerIndex * 4 + 10], [0, 1], CLAMP);
            return (
              <g key={`${index}-${markerIndex}`} opacity={markerP}>
                <circle cx={point.x} cy={point.y} r={1.3 + markerP * 0.8} fill={t.palette.bg} stroke={t.palette.accent} strokeWidth={0.8} />
                {marker.label ? <text x={point.x} y={Math.max(3, point.y - 3)} textAnchor="middle" fill={accentTextColor(t)} fontFamily={t.fonts.mono} fontSize={3}>{marker.label}</text> : null}
              </g>
            );
          })}
        </svg>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontFamily: t.fonts.mono,
            fontSize: H * (t.typeScale?.label ?? 0.025),
            color: t.palette.muted,
            marginTop: H * 0.015,
            opacity: eases.snap(beat.p),
          }}
        >
          <span>{startLabel ?? ''}</span>
          <span style={{ color: accentTextColor(t), display: 'inline-block', ...emphasize(frame, beat.land, fps, emphasis) }}>{endLabel ?? ''}</span>
        </div>
      </div>
    );
  }

  function CompareRow({
    left,
    right,
    beat,
    divider = 'VS',
    focusSide = 'left',
    emphasis: emphasisOverride,
  }: {
    left: { label: string; value: string };
    right: { label: string; value: string };
    beat: Beat;
    divider?: string;
    focusSide?: 'left' | 'right';
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const cell = (side: 'left' | 'right', item: { label: string; value: string }, focus: boolean) => (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: side === 'left' ? 'flex-end' : 'flex-start',
          gap: H * 0.02,
          flex: 1,
          ...slideIn(beat.p, side === 'left' ? 'left' : 'right'),
        }}
      >
        <span
          style={{
            fontFamily: t.fonts.display,
            fontSize: H * ((t.typeScale?.dataHero ?? 0.26) * 0.6),
            fontWeight: 600,
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
            color: focus ? accentTextColor(t) : t.palette.muted,
            display: 'inline-block',
            ...(focus ? emphasize(frame, beat.land, fps, emphasis) : {}),
          }}
        >
          {item.value}
        </span>
        <span style={{ fontFamily: t.fonts.mono, fontSize: H * (t.typeScale?.label ?? 0.025), color: t.palette.muted }}>
          {item.label}
        </span>
      </div>
    );
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: H * 0.05 }}>
        {cell('left', left, focusSide === 'left')}
        <div
          style={{
            fontFamily: t.fonts.mono,
            fontSize: H * (t.typeScale?.label ?? 0.025),
            color: t.palette.muted,
            ...riseIn(beat.p),
          }}
        >
          {divider}
        </div>
        {cell('right', right, focusSide === 'right')}
      </div>
    );
  }

  function ListBuild({
    items,
    beat,
    beats,
    focusIndex = 0,
    emphasis: emphasisOverride,
  }: {
    items: string[];
    beat?: Beat;
    beats?: Beat[];
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const safeItems = items.slice(0, 4);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: H * 0.045 }}>
        {safeItems.map((text, i) => {
          const b = beats?.[i];
          const start = b ? b.start : (beat?.start ?? 0) + i * 6;
          const p = b ? b.p : interpolate(frame, [start, start + 12], [0, 1], CLAMP);
          const numP = interpolate(frame, [start, start + 8], [0, 1], CLAMP);
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: H * 0.03 }}>
              <span
                style={{
                  fontFamily: t.fonts.mono,
                  fontSize: H * (t.typeScale?.label ?? 0.025),
                  color: accentTextColor(t),
                  ...trackIn(numP),
                }}
              >
                {String(i + 1).padStart(2, '0')}
              </span>
              <span
                style={{
                  fontFamily: t.fonts.body,
                  fontSize: H * (t.typeScale?.lead ?? 0.05),
                  lineHeight: 1.4,
                  overflowWrap: 'anywhere',
                  minWidth: 0,
                  ...fadeUp(p, 20),
                  ...(i === focusIndex ? emphasize(frame, b?.land ?? start + 12, fps, emphasis) : {}),
                }}
              >
                {text}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  function RankList({
    items,
    beat,
    beats,
    focusIndex = 0,
    emphasis: emphasisOverride,
  }: {
    items: Array<{ label: string; value?: string }>;
    beat?: Beat;
    beats?: Beat[];
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: H * 0.014 }}>
        {items.slice(0, 5).map((item, index) => {
          const itemBeat = beats?.[index];
          const start = itemBeat?.start ?? (beat?.start ?? 0) + index * 5;
          const p = itemBeat?.p ?? interpolate(frame, [start, start + 13], [0, 1], CLAMP);
          const focus = index === focusIndex;
          return (
            <div key={index} style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', alignItems: 'center', gap: H * 0.022, padding: `${H * 0.012}px ${H * 0.018}px`, borderLeft: `${Math.max(2, H * 0.004)}px solid ${focus ? t.palette.accent : 'transparent'}`, background: focus ? t.palette.track : 'transparent', ...popIn(p), ...(focus ? emphasize(frame, itemBeat?.land ?? start + 13, fps, emphasis) : {}) }}>
              <span style={{ fontFamily: t.fonts.mono, fontSize: H * 0.03, color: focus ? accentTextColor(t) : t.palette.muted }}>{String(index + 1).padStart(2, '0')}</span>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere', fontFamily: t.fonts.body, fontSize: H * 0.034, fontWeight: focus ? 650 : 450 }}>{item.label}</span>
              {item.value ? <span style={{ fontFamily: t.fonts.mono, fontSize: H * 0.028, color: focus ? accentTextColor(t) : t.palette.muted }}>{item.value}</span> : null}
            </div>
          );
        })}
      </div>
    );
  }

  function ChecklistPop({
    items,
    beat,
    beats,
    focusIndex = 0,
    emphasis: emphasisOverride,
  }: {
    items: string[];
    beat?: Beat;
    beats?: Beat[];
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: H * 0.018 }}>
        {items.slice(0, 5).map((item, index) => {
          const itemBeat = beats?.[index];
          const start = itemBeat?.start ?? (beat?.start ?? 0) + index * 6;
          const p = itemBeat?.p ?? interpolate(frame, [start, start + 13], [0, 1], CLAMP);
          const checkP = interpolate(frame, [start + 5, start + 15], [0, 1], CLAMP);
          const focus = index === focusIndex;
          return (
            <div key={index} style={{ display: 'flex', alignItems: 'center', gap: H * 0.024, minHeight: H * 0.065, ...popIn(p), ...(focus ? emphasize(frame, itemBeat?.land ?? start + 13, fps, emphasis) : {}) }}>
              <svg viewBox="0 0 28 28" style={{ width: H * 0.043, height: H * 0.043, flexShrink: 0 }}>
                <rect x={2} y={2} width={24} height={24} rx={t.surface?.radius ? 5 : 0} fill={focus ? t.palette.accent : 'none'} stroke={focus ? t.palette.accent : t.palette.muted} strokeWidth={2} />
                <path d="M7 14.5l4.2 4.2L21 8.8" fill="none" stroke={focus ? t.palette.bg : t.palette.accent} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - checkP} />
              </svg>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere', fontFamily: t.fonts.body, fontSize: H * 0.036, lineHeight: 1.3, color: focus ? t.palette.ink : t.palette.muted }}>{item}</span>
            </div>
          );
        })}
      </div>
    );
  }

  function ProcessFlow({
    steps,
    beat,
    beats,
    focusIndex = 0,
    emphasis: emphasisOverride,
  }: {
    steps: string[];
    beat?: Beat;
    beats?: Beat[];
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const safeSteps = steps.slice(0, 4);
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: H * 0.02 }}>
        {safeSteps.map((text, i) => {
          const b = beats?.[i];
          const start = b ? b.start : (beat?.start ?? 0) + i * 8;
          const p = b ? b.p : interpolate(frame, [start, start + 12], [0, 1], CLAMP);
          const connP = interpolate(frame, [start - 6, start + 4], [0, 1], CLAMP);
          return (
            <React.Fragment key={i}>
              {i > 0 ? (
                <div style={{ flex: 1, height: 1, background: t.palette.track, minWidth: H * 0.03 }}>
                  <div style={{ height: '100%', background: t.palette.accent, ...drawOn(connP) }} />
                </div>
              ) : null}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: H * 0.015,
                  ...popIn(p),
                  ...(i === focusIndex ? emphasize(frame, b?.land ?? start + 12, fps, emphasis) : {}),
                }}
              >
                <span
                  style={{
                    fontFamily: t.fonts.mono,
                    fontSize: H * (t.typeScale?.label ?? 0.025),
                    color: accentTextColor(t),
                    border: `1px solid ${t.palette.track}`,
                    padding: `${H * 0.008}px ${H * 0.016}px`,
                  }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span style={{ fontFamily: t.fonts.body, fontSize: H * (t.typeScale?.body ?? 0.036), textAlign: 'center' }}>
                  {text}
                </span>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    );
  }

  function CauseChain({
    steps,
    beat,
    beats,
    focusIndex = Math.max(0, steps.length - 1),
    emphasis: emphasisOverride,
  }: {
    steps: string[];
    beat?: Beat;
    beats?: Beat[];
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const safeSteps = steps.slice(0, 4);
    const resolvedFocusIndex = Math.max(0, Math.min(safeSteps.length - 1, focusIndex));
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    return (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, safeSteps.length)}, minmax(0, 1fr))`, alignItems: 'center', gap: H * 0.035 }}>
        {safeSteps.map((step, index) => {
          const itemBeat = beats?.[index];
          const start = itemBeat?.start ?? (beat?.start ?? 0) + index * 7;
          const p = itemBeat?.p ?? interpolate(frame, [start, start + 14], [0, 1], CLAMP);
          const arrowP = interpolate(frame, [start - 4, start + 7], [0, 1], CLAMP);
          const focus = index === resolvedFocusIndex;
          return (
            <div key={index} style={{ position: 'relative', minWidth: 0 }}>
              {index > 0 ? (
                <div style={{ position: 'absolute', right: 'calc(100% + 2px)', top: '50%', width: H * 0.035, height: 2, background: t.palette.track, transform: 'translateY(-50%)' }}>
                  <div style={{ height: '100%', background: t.palette.accent, ...drawOn(arrowP) }} />
                  <span style={{ position: 'absolute', right: -1, top: '50%', color: t.palette.accent, fontSize: H * 0.025, transform: 'translate(50%, -54%)' }}>›</span>
                </div>
              ) : null}
              <div style={{ minHeight: H * 0.15, padding: H * 0.025, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: H * 0.018, ...panelStyle(t), border: `1px solid ${focus ? t.palette.accent : t.palette.track}`, ...riseIn(p), ...(focus ? emphasize(frame, itemBeat?.land ?? start + 14, fps, emphasis) : {}) }}>
                <span style={{ fontFamily: t.fonts.mono, fontSize: H * 0.022, color: focus ? accentTextColor(t) : t.palette.muted }}>{['CAUSE', 'MECHANISM', 'EFFECT', 'RESULT'][index]}</span>
                <span style={{ overflowWrap: 'anywhere', fontFamily: t.fonts.body, fontSize: H * 0.032, lineHeight: 1.3 }}>{step}</span>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  function QuoteBlock({
    text,
    source,
    beat,
    emphasis: emphasisOverride,
  }: {
    text: string;
    source?: string;
    beat: Beat;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const srcP = interpolate(frame, [beat.start + 8, beat.start + 18], [0, 1], CLAMP);
    return (
      <div style={{ position: 'relative', paddingLeft: H * 0.06 }}>
        <span
          data-motion-layer="decorative"
          style={{
            position: 'absolute',
            left: 0,
            top: -H * 0.02,
            fontFamily: t.fonts.display,
            fontSize: H * 0.09,
            color: accentTextColor(t),
            lineHeight: 1,
            ...riseIn(beat.p),
          }}
        >
          「
        </span>
        <div
          style={{
            fontFamily: t.fonts.display,
            fontSize: H * ((t.typeScale?.hero ?? 0.15) * 0.72),
            fontWeight: 500,
            lineHeight: 1.35,
            ...fadeUp(beat.p, 28),
            ...emphasize(frame, beat.land, fps, emphasis),
          }}
        >
          {text}
        </div>
        {source ? (
          <div
            style={{
              marginTop: H * 0.035,
              fontFamily: t.fonts.mono,
              fontSize: H * (t.typeScale?.label ?? 0.025),
              color: t.palette.muted,
              ...trackIn(srcP),
            }}
          >
            —— {source}
          </div>
        ) : null}
      </div>
    );
  }

  function ConceptCard({
    term,
    definition,
    hint,
    beat,
    emphasis: emphasisOverride,
  }: {
    term: string;
    definition: string;
    hint?: string;
    beat: Beat;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const detailP = interpolate(frame, [beat.start + 5, beat.start + 17], [0, 1], CLAMP);
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 0.8fr) minmax(0, 1.2fr)', alignItems: 'center', gap: H * 0.05, padding: H * 0.045, ...panelStyle(t), ...fadeUp(beat.p, 20) }}>
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: H * 0.018 }}>
          <span style={{ fontFamily: t.fonts.mono, fontSize: H * (t.typeScale?.label ?? 0.025), color: accentTextColor(t), ...trackIn(beat.p) }}>CONCEPT</span>
          <span style={{ overflowWrap: 'anywhere', fontFamily: t.fonts.display, fontSize: H * ((t.typeScale?.hero ?? 0.15) * 0.72), lineHeight: 1.1, fontWeight: 650, display: 'inline-block', ...emphasize(frame, beat.land, fps, emphasis) }}>{term}</span>
        </div>
        <div style={{ minWidth: 0, paddingLeft: H * 0.04, borderLeft: `1px solid ${t.palette.track}`, ...fadeUp(detailP, 16) }}>
          <div style={{ overflowWrap: 'anywhere', fontFamily: t.fonts.body, fontSize: H * 0.038, lineHeight: 1.45 }}>{definition}</div>
          {hint ? <div style={{ marginTop: H * 0.025, fontFamily: t.fonts.mono, fontSize: H * 0.024, color: t.palette.muted, lineHeight: 1.4 }}>{hint}</div> : null}
        </div>
      </div>
    );
  }

  function CitationCard({
    text,
    source,
    date,
    beat,
    emphasis: emphasisOverride,
  }: {
    text: string;
    source: string;
    date?: string;
    beat: Beat;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const sourceP = interpolate(frame, [beat.start + 8, beat.start + 20], [0, 1], CLAMP);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: H * 0.035, padding: `${H * 0.035}px ${H * 0.045}px`, borderTop: `1px solid ${t.palette.track}`, borderBottom: `1px solid ${t.palette.track}`, ...fadeUp(beat.p, 22) }}>
        <div style={{ maxWidth: '94%', overflowWrap: 'anywhere', fontFamily: t.fonts.display, fontSize: H * ((t.typeScale?.hero ?? 0.15) * 0.58), fontWeight: 520, lineHeight: 1.35, ...emphasize(frame, beat.land, fps, emphasis) }}>{text}</div>
        <div style={{ width: '22%', height: 2, background: t.palette.accent, ...drawOn(sourceP) }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: H * 0.03, fontFamily: t.fonts.mono, fontSize: H * (t.typeScale?.label ?? 0.025), color: t.palette.muted, ...trackIn(sourceP) }}>
          <span>{source}</span>
          {date ? <span>{date}</span> : null}
        </div>
      </div>
    );
  }

  function KeyPointMarker({
    text,
    label = 'KEY POINT',
    beat,
    emphasis: emphasisOverride,
  }: {
    text: string;
    label?: string;
    beat: Beat;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'underline-sweep';
    const underlineP = interpolate(frame, [beat.start + 7, beat.start + 20], [0, 1], CLAMP);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: H * 0.03 }}>
        <span style={{ padding: `${H * 0.008}px ${H * 0.016}px`, background: t.palette.accent, color: t.palette.bg, fontFamily: t.fonts.mono, fontSize: H * 0.022, ...popIn(beat.p) }}>{label}</span>
        <span style={{ maxWidth: '100%', overflowWrap: 'anywhere', fontFamily: t.fonts.display, fontSize: H * ((t.typeScale?.hero ?? 0.15) * 0.72), fontWeight: 650, lineHeight: 1.2, ...fadeUp(beat.p, 24), ...emphasize(frame, beat.land, fps, emphasis) }}>{text}</span>
        <div style={{ width: '62%', height: Math.max(3, H * 0.006), background: t.palette.accent, ...drawOn(underlineP) }} />
      </div>
    );
  }

  function TimelineRail({
    items,
    beat,
    beats,
    focusIndex = 0,
    emphasis: emphasisOverride,
  }: {
    items: string[];
    beat?: Beat;
    beats?: Beat[];
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const safeItems = items.slice(0, 4);
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: H * 0.025 }}>
        {safeItems.map((text, i) => {
          const b = beats?.[i];
          const start = b ? b.start : (beat?.start ?? 0) + i * 7;
          const p = b ? b.p : interpolate(frame, [start, start + 12], [0, 1], CLAMP);
          return (
            <React.Fragment key={i}>
              {i > 0 ? (
                <div style={{ flex: 1, height: 1, marginTop: H * 0.026, background: t.palette.track }}>
                  <div style={{ height: '100%', background: t.palette.accent, ...drawOn(p) }} />
                </div>
              ) : null}
              <div style={{ width: `${100 / Math.max(1, safeItems.length)}%`, minWidth: 0, ...fadeUp(p, 20), ...(i === focusIndex ? emphasize(frame, b?.land ?? start + 12, fps, emphasis) : {}) }}>
                <div style={{ width: H * 0.04, height: H * 0.04, borderRadius: '50%', background: t.palette.accent }} />
                <div style={{ marginTop: H * 0.018, fontFamily: t.fonts.body, fontSize: H * (t.typeScale?.body ?? 0.036), lineHeight: 1.3 }}>
                  {text}
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    );
  }

  function MatrixQuadrant({
    xLabel = '高',
    yLabel = '高',
    items,
    beat,
    emphasis: emphasisOverride,
  }: {
    xLabel?: string;
    yLabel?: string;
    items: Array<{ label: string; x: number; y: number; focus?: boolean }>;
    beat: Beat;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const safeItems = items.slice(0, 4);
    return (
      <div style={{ position: 'relative', height: H * 0.42, border: `1px solid ${t.palette.track}`, ...fadeUp(beat.p, 18) }}>
        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: t.palette.track }} />
        <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 1, background: t.palette.track }} />
        <span style={{ position: 'absolute', right: H * 0.02, bottom: H * 0.012, fontFamily: t.fonts.mono, fontSize: H * 0.022, color: t.palette.muted }}>{xLabel}</span>
        <span style={{ position: 'absolute', left: H * 0.012, top: H * 0.012, fontFamily: t.fonts.mono, fontSize: H * 0.022, color: t.palette.muted }}>{yLabel}</span>
        {safeItems.map((item, i) => {
          const x = Math.max(8, Math.min(92, item.x));
          const y = Math.max(8, Math.min(92, 100 - item.y));
          return (
            <div key={i} style={{ position: 'absolute', left: `${x}%`, top: `${y}%`, transform: 'translate(-50%, -50%)', opacity: eases.snap(beat.p) }}>
              <div style={{ padding: `${H * 0.01}px ${H * 0.018}px`, background: item.focus ? t.palette.accent : t.palette.track, color: item.focus ? t.palette.bg : t.palette.ink, fontFamily: t.fonts.body, fontSize: H * 0.028, whiteSpace: 'nowrap', ...(item.focus ? emphasize(frame, beat.land, fps, emphasis) : {}) }}>
                {item.label}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  function FunnelStack({
    steps,
    beat,
    focusIndex = 0,
    emphasis: emphasisOverride,
  }: {
    steps: Array<{ label: string; value?: string }>;
    beat: Beat;
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const safeSteps = steps.slice(0, 4);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: H * 0.014 }}>
        {safeSteps.map((step, i) => {
          const p = interpolate(frame, [beat.start + i * 5, beat.start + i * 5 + 14], [0, 1], CLAMP);
          const width = 92 - i * (52 / Math.max(1, safeSteps.length));
          return (
            <div key={i} style={{ width: `${width}%`, padding: `${H * 0.014}px ${H * 0.025}px`, background: i === focusIndex ? t.palette.accent : t.palette.track, color: i === focusIndex ? t.palette.bg : t.palette.ink, display: 'flex', justifyContent: 'space-between', fontFamily: t.fonts.body, fontSize: H * 0.032, ...fadeUp(p, 16), ...(i === focusIndex ? emphasize(frame, beat.land, fps, emphasis) : {}) }}>
              <span>{step.label}</span>
              {step.value ? <span style={{ fontFamily: t.fonts.mono }}>{step.value}</span> : null}
            </div>
          );
        })}
      </div>
    );
  }

  function NetworkMap({
    nodes,
    links = [],
    beat,
    focusIndex = 0,
    emphasis: emphasisOverride,
  }: {
    nodes: string[];
    links?: Array<[number, number]>;
    beat: Beat;
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const safeNodes = nodes.slice(0, 5);
    const coords = safeNodes.map((_, i) => {
      const angle = (Math.PI * 2 * i) / Math.max(1, safeNodes.length) - Math.PI / 2;
      return { x: 50 + Math.cos(angle) * 32, y: 50 + Math.sin(angle) * 28 };
    });
    return (
      <div style={{ position: 'relative', height: H * 0.42, ...fadeUp(beat.p, 16) }}>
        <svg viewBox="0 0 100 100" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          {links.slice(0, 8).map(([a, b], i) => coords[a] && coords[b] ? (
            <line key={i} x1={coords[a].x} y1={coords[a].y} x2={coords[b].x} y2={coords[b].y} stroke={t.palette.track} strokeWidth={0.8} />
          ) : null)}
        </svg>
        {safeNodes.map((node, i) => (
          <div key={i} style={{ position: 'absolute', left: `${coords[i].x}%`, top: `${coords[i].y}%`, transform: 'translate(-50%, -50%)', padding: `${H * 0.012}px ${H * 0.02}px`, background: i === focusIndex ? t.palette.accent : t.palette.track, color: i === focusIndex ? t.palette.bg : t.palette.ink, fontFamily: t.fonts.body, fontSize: H * 0.028, whiteSpace: 'nowrap' }}>
            <span style={{ display: 'inline-block', ...(i === focusIndex ? emphasize(frame, beat.land, fps, emphasis) : {}) }}>{node}</span>
          </div>
        ))}
      </div>
    );
  }

  function BeforeAfter({
    before,
    after,
    beat,
    mode = 'split',
    focusSide = 'after',
    emphasis: emphasisOverride,
  }: {
    before: string;
    after: string;
    beat: Beat;
    mode?: 'split' | 'wipe';
    focusSide?: 'before' | 'after';
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const wipe = `${Math.round(beat.p * 100)}%`;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: H * 0.035, ...fadeUp(beat.p, 18) }}>
        {[before, after].map((text, i) => (
          <div key={i} style={{ padding: H * 0.035, background: i === 1 ? t.palette.track : 'transparent', border: `1px solid ${t.palette.track}`, overflow: 'hidden', ...((focusSide === 'before' ? i === 0 : i === 1) ? emphasize(frame, beat.land, fps, emphasis) : {}) }}>
            <div style={{ fontFamily: t.fonts.mono, fontSize: H * 0.022, color: i === 1 ? accentTextColor(t) : t.palette.muted, marginBottom: H * 0.02 }}>
              {i === 0 ? 'Before' : 'After'}
            </div>
            <div style={{ fontFamily: t.fonts.display, fontSize: H * 0.052, lineHeight: 1.25, clipPath: mode === 'wipe' && i === 1 ? `inset(0 ${100 - Number.parseInt(wipe, 10)}% 0 0)` : undefined }}>
              {text}
            </div>
          </div>
        ))}
      </div>
    );
  }

  function MythFactSwap({
    myth,
    fact,
    beat,
    swapBeat,
    emphasis: emphasisOverride,
  }: {
    myth: string;
    fact: string;
    beat: Beat;
    swapBeat?: Beat;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const swapStart = swapBeat?.start ?? beat.start + 14;
    const swapP = swapBeat?.p ?? interpolate(frame, [swapStart, swapStart + 14], [0, 1], CLAMP);
    const strikeP = interpolate(frame, [swapStart - 8, swapStart + 3], [0, 1], CLAMP);
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)', alignItems: 'center', gap: H * 0.035 }}>
        <div style={{ minWidth: 0, opacity: 1 - swapP * 0.72, transform: `translateX(${(-swapP * 14).toFixed(2)}px)` }}>
          <span style={{ fontFamily: t.fonts.mono, fontSize: H * 0.022, color: t.palette.muted }}>MYTH</span>
          <div style={{ position: 'relative', marginTop: H * 0.018, overflowWrap: 'anywhere', fontFamily: t.fonts.display, fontSize: H * 0.052, lineHeight: 1.25, ...fadeUp(beat.p, 18) }}>
            {myth}
            <div style={{ position: 'absolute', left: 0, right: 0, top: '52%', height: Math.max(2, H * 0.004), background: t.palette.accent, ...drawOn(strikeP) }} />
          </div>
        </div>
        <span style={{ color: t.palette.muted, fontFamily: t.fonts.mono, fontSize: H * 0.035, opacity: swapP }}>→</span>
        <div style={{ minWidth: 0, ...slideIn(swapP, 'right', 28), ...emphasize(frame, swapBeat?.land ?? swapStart + 14, fps, emphasis) }}>
          <span style={{ fontFamily: t.fonts.mono, fontSize: H * 0.022, color: accentTextColor(t) }}>FACT</span>
          <div style={{ marginTop: H * 0.018, overflowWrap: 'anywhere', fontFamily: t.fonts.display, fontSize: H * 0.052, lineHeight: 1.25, color: t.palette.ink }}>{fact}</div>
        </div>
      </div>
    );
  }

  function StackedComposition({
    items,
    beat,
    focusIndex = 0,
    emphasis: emphasisOverride,
  }: {
    items: Array<{ label: string; value: number; display?: string }>;
    beat: Beat;
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const safeItems = items.slice(0, 4);
    const total = Math.max(1, safeItems.reduce((sum, item) => sum + Math.max(0, item.value), 0));
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: H * 0.03, ...fadeUp(beat.p, 18) }}>
        <div style={{ display: 'flex', height: H * 0.085, background: t.palette.track, overflow: 'hidden' }}>
          {safeItems.map((item, i) => (
            <div key={i} style={{ width: `${(Math.max(0, item.value) / total) * 100}%`, background: i === 0 ? t.palette.accent : `color-mix(in srgb, ${t.palette.accent} ${Math.max(18, 70 - i * 12)}%, ${t.palette.track})`, ...drawOn(beat.p) }} />
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: H * 0.018 }}>
          {safeItems.map((item, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: H * 0.02, fontFamily: t.fonts.body, fontSize: H * 0.03, ...(i === focusIndex ? emphasize(frame, beat.land, fps, emphasis) : {}) }}>
              <span>{item.label}</span>
              <span style={{ fontFamily: t.fonts.mono, color: i === 0 ? accentTextColor(t) : t.palette.muted }}>{item.display ?? item.value}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function UnderlineSweep({ beat, width = '38%' }: { beat: Beat; width?: string }) {
    const { tokens: t, H } = useStage();
    return (
      <div style={{ width, height: Math.max(3, H * 0.005), background: t.palette.accent, ...drawOn(beat.p) }} />
    );
  }

  /* ---------- 图表精细化原语（数据表 / 垂直柱 / 饼环 / 脉冲 / 刻度 / 指标格 / 章节卡） ---------- */

  function ColumnChart({
    items,
    beat,
    focusIndex = 0,
    emphasis: emphasisOverride,
  }: {
    items: Array<{ label: string; value: number; display?: string }>;
    beat: Beat;
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const safeItems = items.slice(0, 6);
    const maxValue = Math.max(...safeItems.map((it) => Math.max(0, it.value)), 1);
    const chartH = H * 0.32;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: H * 0.02 }}>
        <div style={{ position: 'relative', height: chartH, display: 'flex', alignItems: 'flex-end', gap: H * 0.03 }}>
          {[0.5, 1].map((ratio) => (
            <div key={ratio} style={{ position: 'absolute', left: 0, right: 0, bottom: ratio * chartH, borderTop: `1px solid ${t.palette.track}`, opacity: eases.snap(beat.p) }}>
              <span style={{ position: 'absolute', right: 0, top: -H * 0.026, fontFamily: t.fonts.mono, fontSize: H * (t.typeScale?.label ?? 0.025) * 0.85, color: t.palette.muted, fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(maxValue * ratio)}
              </span>
            </div>
          ))}
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, borderTop: `1.5px solid ${t.palette.muted}`, opacity: eases.snap(beat.p) }} />
          {safeItems.map((it, i) => {
            const start = beat.start + i * 5;
            const grow = spring({ frame: Math.max(0, frame - start), fps, config: { damping: 15, stiffness: 130, mass: 0.9 } });
            const p = Math.max(0, Math.min(1, grow));
            const height = (Math.max(0, it.value) / maxValue) * chartH;
            const labelP = interpolate(frame, [start + 12, start + 18], [0, 1], CLAMP);
            const focus = i === focusIndex;
            return (
              <div key={i} style={{ position: 'relative', flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end' }}>
                <div
                  style={{
                    width: '100%',
                    height: height * p,
                    background: focus ? t.palette.accent : `color-mix(in srgb, ${t.palette.muted} 72%, ${t.palette.track})`,
                    ...(focus ? emphasize(frame, start + 12, fps, emphasis) : {}),
                  }}
                />
                <span
                  style={{
                    position: 'absolute',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    bottom: height + H * 0.008,
                    fontFamily: t.fonts.display,
                    fontSize: H * ((t.typeScale?.body ?? 0.036) * 0.92),
                    fontVariantNumeric: 'tabular-nums',
                    color: focus ? accentTextColor(t) : t.palette.ink,
                    whiteSpace: 'nowrap',
                    ...popIn(labelP),
                  }}
                >
                  {it.display ?? countUp(p, it.value)}
                </span>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: H * 0.03 }}>
          {safeItems.map((it, i) => (
            <span key={i} style={{ flex: 1, minWidth: 0, textAlign: 'center', fontFamily: t.fonts.mono, fontSize: H * (t.typeScale?.label ?? 0.025), color: i === focusIndex ? t.palette.ink : t.palette.muted, overflowWrap: 'anywhere' }}>
              {it.label}
            </span>
          ))}
        </div>
      </div>
    );
  }

  function DonutChart({
    segments,
    beat,
    focusIndex = 0,
    centerLabel,
    emphasis: emphasisOverride,
  }: {
    segments: Array<{ label: string; value: number; display?: string }>;
    beat: Beat;
    focusIndex?: number;
    centerLabel?: string;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const safe = segments.slice(0, 5);
    const total = Math.max(1, safe.reduce((sum, it) => sum + Math.max(0, it.value), 0));
    const r = 40;
    const circumference = 2 * Math.PI * r;
    const per = 12;
    let acc = 0;
    const arcs = safe.map((it, i) => {
      const ratio = Math.max(0, it.value) / total;
      const offset = acc;
      acc += ratio;
      return { it, i, ratio, offset };
    });
    const focusItem = safe[Math.max(0, Math.min(safe.length - 1, focusIndex))];
    const segColor = (i: number) =>
      i === focusIndex
        ? t.palette.accent
        : `color-mix(in srgb, ${t.palette.accent} ${Math.max(20, 68 - i * 12)}%, ${t.palette.track})`;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: H * 0.06 }}>
        <div style={{ position: 'relative', width: H * 0.36, height: H * 0.36, flexShrink: 0 }}>
          <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%', transform: 'rotate(-90deg)' }}>
            <circle cx={50} cy={50} r={r} fill="none" stroke={t.palette.track} strokeWidth={12} />
            {arcs.map(({ i, ratio, offset }) => {
              const p = interpolate(frame, [beat.start + 6 + i * per, beat.start + 6 + (i + 1) * per], [0, 1], CLAMP);
              const len = ratio * circumference * eases.glide(p);
              return (
                <circle
                  key={i}
                  cx={50}
                  cy={50}
                  r={r}
                  fill="none"
                  stroke={segColor(i)}
                  strokeWidth={12}
                  strokeDasharray={`${len} ${circumference}`}
                  strokeDashoffset={-offset * circumference}
                />
              );
            })}
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: H * 0.008 }}>
            <span style={{ fontFamily: t.fonts.display, fontSize: H * ((t.typeScale?.dataHero ?? 0.26) * 0.42), fontWeight: 650, lineHeight: 1, color: accentTextColor(t), fontVariantNumeric: 'tabular-nums', display: 'inline-block', ...emphasize(frame, beat.land, fps, emphasis) }}>
              {focusItem?.display ?? focusItem?.value ?? ''}
            </span>
            {centerLabel ? (
              <span style={{ fontFamily: t.fonts.mono, fontSize: H * (t.typeScale?.label ?? 0.025), color: t.palette.muted }}>{centerLabel}</span>
            ) : null}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: H * 0.02, minWidth: 0 }}>
          {safe.map((it, i) => {
            const p = interpolate(frame, [beat.start + 6 + i * per, beat.start + 6 + i * per + 10], [0, 1], CLAMP);
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: H * 0.015, ...fadeUp(p, 12) }}>
                <span style={{ width: H * 0.02, height: H * 0.02, borderRadius: 2, background: segColor(i), flexShrink: 0 }} />
                <span style={{ fontFamily: t.fonts.body, fontSize: H * 0.03, color: i === focusIndex ? t.palette.ink : t.palette.muted, overflowWrap: 'anywhere', minWidth: 0 }}>{it.label}</span>
                <span style={{ marginLeft: 'auto', fontFamily: t.fonts.mono, fontSize: H * 0.028, color: i === focusIndex ? accentTextColor(t) : t.palette.muted, fontVariantNumeric: 'tabular-nums' }}>{it.display ?? it.value}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function MetricPulse({
    value,
    unit,
    label,
    delta,
    beat,
    decimals = 0,
    emphasis: emphasisOverride,
  }: {
    value: number;
    unit?: string;
    label?: string;
    delta?: string;
    beat: Beat;
    decimals?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const pulse1 = interpolate(frame, [beat.land, beat.land + 16], [0, 1], CLAMP);
    const pulse2 = interpolate(frame, [beat.land + 8, beat.land + 24], [0, 1], CLAMP);
    const deltaP = interpolate(frame, [beat.land + 4, beat.land + 12], [0, 1], CLAMP);
    const ring = (p: number): CSSProperties => ({
      position: 'absolute',
      inset: `-${(p * H * 0.05).toFixed(1)}px`,
      borderRadius: 9999,
      border: `2px solid ${t.palette.accent}`,
      opacity: frame >= beat.land ? (1 - p) * 0.7 : 0,
      pointerEvents: 'none',
    });
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: H * 0.03, ...panelStyle(t), ...(t.surface?.kind !== 'none' ? { padding: H * 0.04 } : {}) }}>
        {label ? <Kicker text={label} beat={beat} /> : null}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: H * 0.02 }}>
          <span style={{ position: 'relative', display: 'inline-block' }}>
            <span style={ring(pulse1)} />
            <span style={ring(pulse2)} />
            <span style={{ fontFamily: t.fonts.display, fontSize: H * (t.typeScale?.dataHero ?? 0.26), fontWeight: 650, lineHeight: 1, color: accentTextColor(t), fontVariantNumeric: 'tabular-nums', display: 'inline-block', ...emphasize(frame, beat.land, fps, emphasis) }}>
              {countUp(beat.p, value, decimals)}
            </span>
          </span>
          {unit ? <span style={{ fontFamily: t.fonts.body, fontSize: H * (t.typeScale?.lead ?? 0.05), color: t.palette.muted }}>{unit}</span> : null}
          {delta ? (
            <span style={{ fontFamily: t.fonts.mono, fontSize: H * (t.typeScale?.label ?? 0.025) * 1.1, color: accentTextColor(t), border: `1px solid ${t.palette.accent}`, borderRadius: 9999, padding: `${H * 0.006}px ${H * 0.016}px`, ...popIn(deltaP) }}>
              {delta}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  function ScaleImpact({
    value,
    max,
    unit,
    label,
    reference,
    beat,
    decimals = 0,
    emphasis: emphasisOverride,
  }: {
    value: number;
    max: number;
    unit?: string;
    label?: string;
    reference?: { value: number; label: string };
    beat: Beat;
    decimals?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const safeMax = max > 0 ? max : Math.max(1, value);
    const ratio = Math.max(0, Math.min(1, value / safeMax));
    const refRatio = reference ? Math.max(0, Math.min(1, reference.value / safeMax)) : null;
    const slide = eases.drive(beat.p);
    const ticks = [0, 0.25, 0.5, 0.75, 1];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: H * 0.035, ...panelStyle(t), ...(t.surface?.kind !== 'none' ? { padding: H * 0.04 } : {}) }}>
        {label ? <Kicker text={label} beat={beat} /> : null}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: H * 0.02 }}>
          <span style={{ fontFamily: t.fonts.display, fontSize: H * (t.typeScale?.dataHero ?? 0.26), fontWeight: 650, lineHeight: 1, color: accentTextColor(t), fontVariantNumeric: 'tabular-nums', display: 'inline-block', ...emphasize(frame, beat.land, fps, emphasis) }}>
            {countUp(beat.p, value, decimals)}
          </span>
          {unit ? <span style={{ fontFamily: t.fonts.body, fontSize: H * (t.typeScale?.lead ?? 0.05), color: t.palette.muted }}>{unit}</span> : null}
        </div>
        <div style={{ position: 'relative', height: H * 0.1 }}>
          <div style={{ position: 'absolute', left: 0, right: 0, top: H * 0.045, borderTop: `1.5px solid ${t.palette.muted}` }} />
          {ticks.map((tick) => (
            <div key={tick} style={{ position: 'absolute', left: `${tick * 100}%`, top: tick === 0 || tick === 1 ? H * 0.03 : H * 0.038, height: tick === 0 || tick === 1 ? H * 0.03 : H * 0.014, borderLeft: `1px solid ${t.palette.muted}`, opacity: eases.snap(beat.p) }} />
          ))}
          <span style={{ position: 'absolute', left: 0, top: H * 0.066, fontFamily: t.fonts.mono, fontSize: H * (t.typeScale?.label ?? 0.025) * 0.9, color: t.palette.muted }}>0</span>
          <span style={{ position: 'absolute', right: 0, top: H * 0.066, fontFamily: t.fonts.mono, fontSize: H * (t.typeScale?.label ?? 0.025) * 0.9, color: t.palette.muted, fontVariantNumeric: 'tabular-nums' }}>{safeMax}{unit ?? ''}</span>
          {refRatio != null && reference ? (
            <div style={{ position: 'absolute', left: `${refRatio * 100}%`, top: 0, transform: 'translateX(-50%)', textAlign: 'center', opacity: beat.done ? 1 : 0 }}>
              <div style={{ width: 0, height: 0, borderLeft: `${H * 0.007}px solid transparent`, borderRight: `${H * 0.007}px solid transparent`, borderTop: `${H * 0.01}px solid ${t.palette.muted}`, margin: '0 auto' }} />
              <span style={{ fontFamily: t.fonts.mono, fontSize: H * (t.typeScale?.label ?? 0.025) * 0.85, color: t.palette.muted, whiteSpace: 'nowrap' }}>{reference.label}</span>
            </div>
          ) : null}
          <div style={{ position: 'absolute', left: `${ratio * slide * 100}%`, top: H * 0.014, transform: 'translateX(-50%)' }}>
            <div style={{ width: Math.max(3, H * 0.006), height: H * 0.062, background: t.palette.accent, borderRadius: 2 }} />
          </div>
        </div>
      </div>
    );
  }

  function StatGrid({
    items,
    beat,
    beats,
    focusIndex = 0,
    emphasis: emphasisOverride,
  }: {
    items: Array<{ value: string; label: string }>;
    beat?: Beat;
    beats?: Beat[];
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const safeItems = items.slice(0, 4);
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: H * 0.04 }}>
        {safeItems.map((it, i) => {
          const b = beats?.[i];
          const start = b ? b.start : (beat?.start ?? 0) + i * 6;
          const p = b ? b.p : interpolate(frame, [start, start + 12], [0, 1], CLAMP);
          const focus = i === focusIndex;
          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: H * 0.01, borderLeft: `2px solid ${focus ? t.palette.accent : t.palette.track}`, paddingLeft: H * 0.02, ...popIn(p) }}>
              <span style={{ fontFamily: t.fonts.display, fontSize: H * ((t.typeScale?.dataHero ?? 0.26) * 0.4), fontWeight: 650, lineHeight: 1, color: focus ? accentTextColor(t) : t.palette.ink, fontVariantNumeric: 'tabular-nums', display: 'inline-block', ...(focus ? emphasize(frame, b?.land ?? start + 12, fps, emphasis) : {}) }}>
                {it.value}
              </span>
              <span style={{ fontFamily: t.fonts.body, fontSize: H * (t.typeScale?.label ?? 0.025) * 1.1, color: t.palette.muted, overflowWrap: 'anywhere' }}>{it.label}</span>
            </div>
          );
        })}
      </div>
    );
  }

  function DataTable({
    columns,
    rows,
    beat,
    focusRow = 0,
    emphasis: emphasisOverride,
  }: {
    columns: string[];
    rows: string[][];
    beat: Beat;
    focusRow?: number;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const safeCols = columns.slice(0, 4);
    const safeRows = rows.slice(0, 5).map((row) => safeCols.map((_, ci) => row[ci] ?? ''));
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${safeCols.length}, minmax(0, 1fr))`, gap: H * 0.02, paddingBottom: H * 0.012, borderBottom: `1.5px solid ${t.palette.muted}`, opacity: eases.snap(beat.p) }}>
          {safeCols.map((col, ci) => (
            <span key={ci} style={{ fontFamily: t.fonts.mono, fontSize: H * (t.typeScale?.label ?? 0.025), color: accentTextColor(t), textAlign: ci === 0 ? 'left' : 'right', overflowWrap: 'anywhere' }}>{col}</span>
          ))}
        </div>
        {safeRows.map((row, ri) => {
          const start = beat.start + 6 + ri * 6;
          const p = interpolate(frame, [start, start + 12], [0, 1], CLAMP);
          const focus = ri === focusRow;
          return (
            <div key={ri} style={{ position: 'relative', display: 'grid', gridTemplateColumns: `repeat(${safeCols.length}, minmax(0, 1fr))`, gap: H * 0.02, alignItems: 'center', padding: `${H * 0.014}px 0`, borderBottom: `1px solid ${t.palette.track}`, ...fadeUp(p, 14) }}>
              {focus ? <div style={{ position: 'absolute', left: -H * 0.02, top: '50%', transform: 'translateY(-50%)', width: Math.max(3, H * 0.006), height: '60%', background: t.palette.accent, borderRadius: 2 }} /> : null}
              {row.map((cell, ci) => (
                <span
                  key={ci}
                  style={{
                    fontFamily: ci === 0 ? t.fonts.body : t.fonts.mono,
                    fontSize: H * (ci === 0 ? 0.032 : 0.03),
                    color: focus ? (ci === 0 ? t.palette.ink : accentTextColor(t)) : ci === 0 ? t.palette.ink : t.palette.muted,
                    textAlign: ci === 0 ? 'left' : 'right',
                    fontVariantNumeric: 'tabular-nums',
                    overflowWrap: 'anywhere',
                    minWidth: 0,
                    display: 'inline-block',
                    ...(focus && ci === 0 ? emphasize(frame, start + 12, fps, emphasis) : {}),
                  }}
                >
                  {cell}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    );
  }

  function SectionTitle({
    index,
    title,
    subtitle,
    beat,
    emphasis: emphasisOverride,
  }: {
    index?: string;
    title: string;
    subtitle?: string;
    beat: Beat;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const ruleP = interpolate(frame, [Math.max(beat.start, beat.land - 6), beat.land + 10], [0, 1], CLAMP);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: H * 0.028 }}>
        {index ? (
          <span style={{ fontFamily: t.fonts.mono, fontSize: H * (t.typeScale?.label ?? 0.025) * 1.1, color: accentTextColor(t), ...trackIn(beat.p) }}>
            {index}
          </span>
        ) : null}
        <span style={{ fontFamily: t.fonts.display, fontSize: H * (t.typeScale?.hero ?? 0.15) * 0.72, fontWeight: 650, lineHeight: 1.15, color: t.palette.ink, display: 'inline-block', ...fadeUp(beat.p, 26), ...emphasize(frame, beat.land, fps, emphasis) }}>
          {title}
        </span>
        <div style={{ height: Math.max(2, H * 0.004), width: `${eases.glide(ruleP) * 38}%`, background: t.palette.accent }} />
        {subtitle ? (
          <span style={{ fontFamily: t.fonts.body, fontSize: H * (t.typeScale?.lead ?? 0.05) * 0.9, lineHeight: 1.5, color: t.palette.muted, ...fadeUp(ruleP, 14) }}>
            {subtitle}
          </span>
        ) : null}
      </div>
    );
  }

  return {
    CardStage,
    SafeLayout,
    MotionSlot,
    useStage,
    useBeats,
    useTimingPlan,
    fadeUp,
    slideIn,
    riseIn,
    popIn,
    trackIn,
    drawOn,
    countUp,
    settle,
    brighten,
    emphasize: emphasize as MotionKit['emphasize'],
    Kicker,
    StatHero,
    RingCounter,
    BarChart,
    HorizontalBars,
    TrendLine,
    CompareRow,
    ListBuild,
    RankList,
    ChecklistPop,
    ProcessFlow,
    CauseChain,
    QuoteBlock,
    ConceptCard,
    CitationCard,
    KeyPointMarker,
    TimelineRail,
    MatrixQuadrant,
    FunnelStack,
    NetworkMap,
    BeforeAfter,
    MythFactSwap,
    StackedComposition,
    ColumnChart,
    DonutChart,
    MetricPulse,
    ScaleImpact,
    StatGrid,
    DataTable,
    SectionTitle,
    UnderlineSweep,
  };
}

/**
 * kit 的全部可 import 名称——lint 用它静态校验卡片的 named import，
 * 在编译前拦住"幻觉 API"。新增导出时必须同步本清单与下方 API 摘要。
 */
export const MOTION_KIT_EXPORT_NAMES = [
  'CardStage',
  'SafeLayout',
  'MotionSlot',
  'useStage',
  'useBeats',
  'useTimingPlan',
  'fadeUp',
  'slideIn',
  'riseIn',
  'popIn',
  'trackIn',
  'drawOn',
  'countUp',
  'settle',
  'brighten',
  'emphasize',
  'Kicker',
  'StatHero',
  'RingCounter',
  'BarChart',
  'HorizontalBars',
  'TrendLine',
  'CompareRow',
  'ListBuild',
  'RankList',
  'ChecklistPop',
  'ProcessFlow',
  'CauseChain',
  'QuoteBlock',
  'ConceptCard',
  'CitationCard',
  'KeyPointMarker',
  'TimelineRail',
  'MatrixQuadrant',
  'FunnelStack',
  'NetworkMap',
  'BeforeAfter',
  'MythFactSwap',
  'StackedComposition',
  'ColumnChart',
  'DonutChart',
  'MetricPulse',
  'ScaleImpact',
  'StatGrid',
  'DataTable',
  'SectionTitle',
  'UnderlineSweep',
] as const;

/**
 * 注入雕刻提示词的 kit API 摘要——唯一事实来源，与实现同文件维护。
 * 修改 API 时必须同步本摘要。
 */
export const MOTION_KIT_API_DOC = `import { CardStage, SafeLayout, MotionSlot, useBeats, useTimingPlan, Kicker, StatHero, RingCounter, BarChart, HorizontalBars, TrendLine, CompareRow, ListBuild, RankList, ChecklistPop, ProcessFlow, CauseChain, QuoteBlock, ConceptCard, CitationCard, KeyPointMarker, TimelineRail, MatrixQuadrant, FunnelStack, NetworkMap, BeforeAfter, MythFactSwap, StackedComposition, ColumnChart, DonutChart, MetricPulse, ScaleImpact, StatGrid, DataTable, SectionTitle, UnderlineSweep, fadeUp, slideIn, riseIn, popIn, trackIn, drawOn, countUp, emphasize, useStage } from '@lingji/motion-kit';

// 舞台（必用做根节点）：底色/安全区(底部20%字幕区)/镜头慢漂/氛围装饰层/退场淡出全部内置
<CardStage tokens={TOKENS}>{...}</CardStage>   // TOKENS = 系统注入的风格 tokens 常量，原样传入

// 自动模式安全布局（必用）：一个 header + 一个 main，或明确的左右槽位；禁止自由 absolute 定位
<SafeLayout variant="title-hero">
  <MotionSlot name="header" role="support" lifecycle={{enter: beats[0], collapse: beats[1]}}><Kicker ... /></MotionSlot>
  <MotionSlot name="main" role="focus" lifecycle={{enter: beats[1]}}><StatHero ... /></MotionSlot>
</SafeLayout>
// lifecycle 作用于整个语义区块：enter 入场、update 短暂提亮、collapse 收为弱辅助、exit 退场

// 节拍（必用）：anchors[i] = 第 i 拍内容在逐句字幕里被讲到的句索引（第 0 拍传 null 表示入场）
const beats = useBeats(cues, [null, 2, 5]);    // 返回 Beat[]：{ start, p(0→1), land, done }
// 若组件 props 收到 timingPlan，优先用专业节奏；无 timingPlan 时自动回退 useBeats
const beats = useTimingPlan(timingPlan, cues, [null, 2, 5]);
// 提前量/单调不减/空 cues 均匀兜底/clamp 已内置——不要自己计算揭示帧

// 内容原语（自动消费 tokens 的颜色/字体/字号，自带 tabular-nums 与等比配重）
<Kicker text="标签" beat={beats[0]} />                                   // mono 小标签，字距收拢入场
<StatHero value={28842} unit="人" label="硕士报名" beat={beats[1]} max={40000} emphasis="countup-settle" />
<RingCounter value={72} max={100} unit="%" label="完成率" beat={beats[1]} /> // 环形进度+计数；max>0
<BarChart items={[{label:'硕士', value:28842}, {label:'博士', value:2403}]} beat={beats[1]} focusIndex={0} emphasis="slam" />
<HorizontalBars items={[{label:'今年',value:72,display:'72%'},{label:'去年',value:48,display:'48%'}]} beat={beats[1]} focusIndex={0} /> // ≤5行，CH≈778px
<TrendLine points={[3,5,4,9,14]} beat={beats[1]} markers={[{index:2,label:'拐点'}]} fill startLabel="2020" endLabel="2024" emphasis="countup-settle" />
<CompareRow left={{label:'今年', value:'28842'}} right={{label:'去年', value:'19003'}} beat={beats[1]} focusSide="right" emphasis="brighten" />
<ListBuild items={['要点一','要点二','要点三']} beats={[beats[1], beats[2], beats[3]]} focusIndex={2} emphasis="underline-sweep" />
<RankList items={[{label:'第一名',value:'92'},{label:'第二名',value:'86'}]} beat={beats[1]} /> // ≤5行，每行约0.07H
<ChecklistPop items={['已确认','已同步','已交付']} beat={beats[1]} />       // ≤5行，逐条勾选
<ProcessFlow steps={['报名','初试','复试']} beats={[beats[1], beats[2], beats[3]]} focusIndex={2} emphasis="slam" />
<CauseChain steps={['原因','机制','结果']} beats={[beats[1],beats[2],beats[3]]} focusIndex={2} /> // ≤4节点
<QuoteBlock text="金句原文" source="出处" beat={beats[1]} emphasis="slam" />
<ConceptCard term="概念" definition="一句清晰释义" hint="补充提示" beat={beats[1]} />
<CitationCard text="引用正文" source="来源名称" date="2026" beat={beats[1]} />
<KeyPointMarker text="必须记住的重点" label="KEY POINT" beat={beats[1]} />
<TimelineRail items={['2019 起步','2022 爆发','2024 分化']} beats={[beats[1], beats[2], beats[3]]} focusIndex={2} emphasis="brighten" />
<MatrixQuadrant xLabel="价值" yLabel="难度" items={[{label:'优先做', x:78, y:72, focus:true}, {label:'暂缓', x:28, y:36}]} beat={beats[1]} />
<FunnelStack steps={[{label:'触达', value:'10万'}, {label:'转化', value:'1.2万'}]} beat={beats[1]} />
<NetworkMap nodes={['平台','创作者','观众']} links={[[0,1],[1,2]]} beat={beats[1]} />
<BeforeAfter before="旧流程慢" after="新流程快" beat={beats[1]} mode="wipe" />
<MythFactSwap myth="常见误区" fact="真实结论" beat={beats[1]} swapBeat={beats[2]} />
<StackedComposition items={[{label:'内容', value:55, display:'55%'}, {label:'分发', value:30, display:'30%'}]} beat={beats[1]} />
<ColumnChart items={[{label:'图文', value:32}, {label:'视频', value:68}]} beat={beats[1]} focusIndex={1} /> // ≤6柱，垂直柱+网格线，弹性生长
<DonutChart segments={[{label:'内容', value:55, display:'55%'}, {label:'分发', value:30, display:'30%'}]} beat={beats[1]} focusIndex={0} centerLabel="时间占比" /> // ≤5段，环形分段接力绘制
<MetricPulse value={120} unit="万" label="单月涨粉" delta="+32%" beat={beats[1]} emphasis="countup-settle" /> // 计数落定后脉冲环扩散
<ScaleImpact value={3} max={100} unit="%" label="付费转化" reference={{value:38, label:'行业均值'}} beat={beats[1]} /> // 极值刻度尺，标记滑到 value
<StatGrid items={[{value:'120万', label:'曝光'}, {value:'3.1万', label:'完播'}]} beats={[beats[1], beats[2]]} /> // ≤4格 2×2 多指标
<DataTable columns={['平台','粉丝','单价']} rows={[['抖音','120万','¥18'], ['B站','45万','¥32']]} beat={beats[1]} focusRow={0} /> // ≤5行×≤4列，行逐条揭示
<SectionTitle index="02" title="章节标题" subtitle="可选副题" beat={beats[1]} />          // 章节过渡卡
<UnderlineSweep beat={beats[2]} width="38%" />                           // 焦点下划线扫过（accent 小重音）

// 手法（返回 style 片段，自由拼装自己的元素；每种缓动不同，别整卡只用一种）
fadeUp(beat.p)  slideIn(beat.p,'left')  riseIn(beat.p)  popIn(beat.p)  trackIn(beat.p)  drawOn(beat.p,'x')
countUp(beat.p, 28842)                       // 数字字符串（配 fontVariantNumeric:'tabular-nums'）
emphasize(frame, beat.land, fps, 'slam')
// storyboard 原生强调：'countup-settle'计数后回弹 | 'slam'重落 | 'underline-sweep'下划线扫过 | 'brighten'短暂提亮
// 兼容旧卡：'settle' | 'underline' | 'none'

// 布局与自定义：useStage() → { tokens, W, H, CW, CH, fps, D, frame }；自定义元素用 tokens 配色配字体
// useStage 的 tokens 只在 CardStage 的子组件内有效——在渲染 <CardStage> 的组件体里调用会拿到默认深色 tokens（surface.bg 为空、ink 反色，字底同色判失败）；该处配色请直接读 TOKENS 常量，useStage 只取尺寸/帧率
// 自定义色块内的字色必须与该块底色对比 ≥3:1：accent 当块底时字用 bg/ink，绝不 accent 底配 accent 字（机器逐帧检查对比度，撞色直接打回）
// 尺寸铁律：CardStage 内容区左右各留 10%、底部留 20% 字幕区——整行元素 / svg / 横向条的宽度用 CW（=0.8×W），高度预算用 CH（=0.72×H）；写 W/H 全尺寸必溢出画布判失败
// 仍可 import { useCurrentFrame, useVideoConfig, interpolate, spring, Easing } from 'remotion' 写 kit 没有的表达
// 自写 interpolate 必须带双侧 clamp：{ extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }（漏一侧=区间外爆炸，lint 会拦）`;
