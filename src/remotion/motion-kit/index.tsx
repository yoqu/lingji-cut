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
    kind: 'none' | 'grid' | 'orbs' | 'hairline' | 'hairline-grid' | 'grain';
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
  | 'asset-aside'
  | 'asset-led'
  | 'corner-anchor';

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

/**
 * 叙事摄影机运镜：由分镜声明意图，kit 内部确定性落地（幅度硬上限、单调收敛）。
 * push-in 推近焦点 / pull-out 拉开看全局 / pan 横移 / focus 把目标槽位推到画面中心。
 */
export type CameraMove = 'push-in' | 'pull-out' | 'pan-left' | 'pan-right' | 'focus';

export interface CameraShot {
  beat: Beat;
  move: CameraMove;
  /** focus / push-in 的目标槽位；缺省时只做纵深变化不平移 */
  target?: MotionSlotName;
}

/**
 * 指示标注（讲解者的手）：圈选 / 框选 / 箭头 / 批注 / 聚光灯压暗其余。
 * 全部以包裹器形式覆盖在目标元素上，不参与布局流，不影响容量预算。
 */
export type AnnotateKind =
  | 'circle'
  | 'box'
  | 'underline'
  | 'highlight'
  | 'strike'
  | 'arrow'
  | 'spotlight';

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
  CardStage: React.ComponentType<{
    tokens?: Partial<MotionTokens> | null;
    /** 叙事运镜；与风格慢漂叠加后统一限幅 */
    shots?: CameraShot[];
    /** 运镜目标定位依据（与 SafeLayout variant 保持一致）；缺省按 single-focus 处理 */
    layout?: SafeLayoutVariant;
    children?: ReactNode;
    style?: CSSProperties;
  }>;
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
  /** 遮罩揭示：内容不位移，由一道边界擦出（比位移更"信息图"） */
  maskReveal: (p: number, dir?: 'up' | 'down' | 'left' | 'right') => CSSProperties;
  /** 失焦→合焦：注意力从模糊聚拢到清晰 */
  blurIn: (p: number) => CSSProperties;
  /** 展开：绕顶边 3D 翻下，适合结论 / 卡面展开 */
  unfold: (p: number) => CSSProperties;
  /** 穿过：从略大缩到位，读作镜头穿越而非弹出 */
  scaleThrough: (p: number) => CSSProperties;
  /** 弹性入场：一次可控 overshoot 后收敛 */
  elasticIn: (p: number) => CSSProperties;
  /** 错峰子进度：把一个 beat 的 p 分给 total 个子项，返回第 index 项的 0→1 */
  stagger: (p: number, index: number, total: number, overlap?: number) => number;
  countUp: (p: number, value: number, decimals?: number) => string;
  /** 数值改写：从 from 变到 to（不是从 0 计数），用于"同一个指标变了" */
  valueRewrite: (p: number, from: number, to: number, decimals?: number) => string;
  /** 同位替换：旧内容缩淡出、新内容放淡入，占同一位置（before→after 的"变过去"） */
  morphSwap: (p: number) => { out: CSSProperties; in: CSSProperties };
  /** 列表重排：第 fromIndex 项移动到 toIndex 位（rowHeight = 行高 px） */
  reorderY: (p: number, fromIndex: number, toIndex: number, rowHeight: number) => CSSProperties;
  settle: (frame: number, land: number, fps: number, max?: number) => CSSProperties;
  brighten: (frame: number, land: number) => CSSProperties;
  emphasize: (frame: number, land: number, fps: number, kind?: MotionKitEmphasis) => CSSProperties;
  /**
   * 指示标注包裹器：把讲解者的"手"叠在目标元素上。
   * 不占布局、不进容量预算；每张卡最多 2 个（lint 拦截）。
   */
  Annotate: React.ComponentType<{
    kind: AnnotateKind;
    beat: Beat;
    /** arrow 的指入方向 */
    side?: 'left' | 'right' | 'top' | 'bottom';
    children?: ReactNode;
    style?: CSSProperties;
  }>;
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
    /** 条内关键词（keywords[i] 属于 items[i]，空串跳过）：条目落地后逐个变色点亮。 */
    keywords?: string[];
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
  /** 打字机：逐字上屏（中文按字符切分，\n 多行），光标落笔后闪烁退出；detail 副行打完后淡入 */
  TypewriterText: React.ComponentType<{
    text: string;
    beat: Beat;
    /** 每字上屏间隔帧数（越小越快），默认 2 */
    framesPerChar?: number;
    cursor?: boolean;
    detail?: string;
    font?: 'display' | 'body' | 'mono';
    /** H 的倍数；缺省走 typeScale.lead */
    size?: number;
    weight?: number;
    color?: string;
    emphasis?: MotionKitEmphasis;
  }>;
  /** 逐词弹入：按调用方给定的语义块数组逐组 popIn（kit 不做分词），带 scale 回弹 */
  WordPop: React.ComponentType<{
    words: string[];
    beat?: Beat;
    beats?: Beat[];
    /** 逐组 stagger 帧数（无 beats 时生效），默认 4 */
    gap?: number;
    font?: 'display' | 'body' | 'mono';
    size?: number;
    weight?: number;
    color?: string;
    emphasis?: MotionKitEmphasis;
  }>;
  /** 关键词扫描：句内关键词逐个变色点亮（color）或 accent 色块扫过（sweep）；关键词以传入数组为准 */
  KeywordScan: React.ComponentType<{
    text: string;
    keywords: string[];
    beat: Beat;
    mode?: 'color' | 'sweep';
    /** 关键词逐个点亮间隔帧数，默认 10 */
    gap?: number;
    font?: 'display' | 'body' | 'mono';
    size?: number;
    weight?: number;
    color?: string;
    emphasis?: MotionKitEmphasis;
  }>;
}

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/**
 * 叙事运镜的最大推近倍率——推近必然让内容层超出画布（裁边是运镜的定义，不是缺陷）。
 * 渲染探针的画布级出血容差必须引用这个常量，否则正常运镜会被误判成"内容装不下"。
 */
export const MOTION_CAMERA_MAX_SCALE = 1.12;

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
  /* ---------- 手法扩展：揭示不等于位移，状态转移不等于重新入场 ---------- */

  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

  /** 小数位自动推导：未显式指定时按数值本身的小数位（封顶 2 位），整数恒为 0。 */
  const autoDecimals = (value: number): number => {
    if (!Number.isFinite(value)) return 0;
    const s = String(value);
    const dot = s.indexOf('.');
    return dot < 0 ? 0 : Math.min(2, s.length - dot - 1);
  };

  const maskReveal = (p: number, dir: 'up' | 'down' | 'left' | 'right' = 'up'): CSSProperties => {
    const e = eases.drive(p);
    const hidden = ((1 - e) * 100).toFixed(2);
    const inset =
      dir === 'up'
        ? `${hidden}% 0 0 0`
        : dir === 'down'
          ? `0 0 ${hidden}% 0`
          : dir === 'left'
            ? `0 ${hidden}% 0 0`
            : `0 0 0 ${hidden}%`;
    return { clipPath: `inset(${inset})`, opacity: Math.min(1, e * 1.6) };
  };
  const blurIn = (p: number): CSSProperties => {
    const e = eases.crisp(p);
    return e >= 1 ? { opacity: 1 } : { opacity: e, filter: `blur(${((1 - e) * 10).toFixed(2)}px)` };
  };
  const unfold = (p: number): CSSProperties => {
    const e = eases.drive(p);
    return {
      opacity: Math.min(1, e * 1.5),
      transform: `perspective(1200px) rotateX(${((1 - e) * -32).toFixed(2)}deg)`,
      transformOrigin: 'center top',
    };
  };
  const scaleThrough = (p: number): CSSProperties => {
    const e = eases.crisp(p);
    return { opacity: eases.snap(p), transform: `scale(${(1.14 - e * 0.14).toFixed(4)})` };
  };
  const elasticIn = (p: number): CSSProperties => {
    const e = eases.lift(p);
    return { opacity: Math.min(1, eases.snap(p) * 1.5), transform: `translateY(${((1 - e) * 28).toFixed(2)}px)` };
  };
  /**
   * 错峰子进度：overlap=0 完全串行，overlap→1 趋近齐动。
   * 让"逐项"由调用方自由拼装，不必为每种列表新增组件。
   */
  const stagger = (p: number, index: number, total: number, overlap = 0.55): number => {
    const n = Math.max(1, total);
    if (n === 1) return clamp01(p);
    const span = 1 / (n - (n - 1) * clamp01(overlap));
    const step = span * (1 - clamp01(overlap));
    const start = index * step;
    return clamp01((clamp01(p) - start) / Math.max(0.0001, span));
  };

  /* ---------- 状态转移：同一个元素变成另一个状态（MG 的核心） ---------- */

  const valueRewrite = (p: number, from: number, to: number, decimals?: number): string => {
    const v = from + (to - from) * eases.drive(clamp01(p));
    const d = decimals ?? Math.max(autoDecimals(from), autoDecimals(to));
    return d > 0 ? v.toFixed(d) : String(Math.round(v));
  };
  const morphSwap = (p: number): { out: CSSProperties; in: CSSProperties } => {
    const e = eases.glide(clamp01(p));
    return {
      out: {
        opacity: Math.max(0, 1 - e * 1.8),
        filter: `blur(${(e * 6).toFixed(2)}px)`,
        transform: `scale(${(1 - e * 0.12).toFixed(4)})`,
      },
      in: {
        opacity: Math.max(0, e * 1.8 - 0.8),
        filter: `blur(${((1 - e) * 6).toFixed(2)}px)`,
        transform: `scale(${(0.9 + e * 0.1).toFixed(4)})`,
      },
    };
  };
  const reorderY = (p: number, fromIndex: number, toIndex: number, rowHeight: number): CSSProperties => {
    const e = eases.glide(clamp01(p));
    const dy = (toIndex - fromIndex) * rowHeight * e;
    return { transform: `translateY(${dy.toFixed(2)}px)`, zIndex: toIndex < fromIndex ? 2 : 1 };
  };

  const countUp = (p: number, value: number, decimals?: number): string => {
    const v = value * eases.drive(p);
    const d = decimals ?? autoDecimals(value);
    return d > 0 ? v.toFixed(d) : String(Math.round(v));
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
          data-motion-layer="decorative"
          style={{
            ...base,
            backgroundImage: `repeating-linear-gradient(0deg, ${t.palette.track ?? 'rgba(255,255,255,0.1)'} 0 1px, transparent 1px ${cell}px), repeating-linear-gradient(90deg, ${t.palette.track ?? 'rgba(255,255,255,0.1)'} 0 1px, transparent 1px ${cell}px)`,
          }}
        />
      );
    }
    if (ambient.kind === 'orbs') {
      return (
        <div data-motion-layer="decorative" style={base}>
          <div
            data-motion-layer="decorative"
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
            data-motion-layer="decorative"
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
          data-motion-layer="decorative"
          style={{
            ...base,
            backgroundImage: `repeating-linear-gradient(45deg, ${t.palette.track ?? 'rgba(255,255,255,0.06)'} 0 1px, transparent 1px 5px)`,
          }}
        />
      );
    }
    // hairline-grid：hairline 社论基线 + 全幅细网格叠层（网格降一档透明度保持基线层级；
    // 格距比纯 grid 疏，读作杂志栏格而非坐标纸）。
    if (ambient.kind === 'hairline-grid') {
      const cell = Math.round(H * 0.12);
      return (
        <div data-motion-layer="decorative" style={base}>
          <div
            data-motion-layer="decorative"
            style={{
              position: 'absolute',
              inset: 0,
              opacity: 0.75,
              backgroundImage: `repeating-linear-gradient(0deg, ${t.palette.track ?? 'rgba(255,255,255,0.1)'} 0 1px, transparent 1px ${cell}px), repeating-linear-gradient(90deg, ${t.palette.track ?? 'rgba(255,255,255,0.1)'} 0 1px, transparent 1px ${cell}px)`,
            }}
          />
          <div
            data-motion-layer="decorative"
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
            data-motion-layer="decorative"
            style={{ position: 'absolute', left: W * 0.1, top: H * 0.075, width: W * 0.04, height: 2, background: color }}
          />
        </div>
      );
    }
    // hairline：安全区顶部一条基线 + 左上角短 accent 刻度
    return (
      <div data-motion-layer="decorative" style={base}>
        <div
          data-motion-layer="decorative"
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
          data-motion-layer="decorative"
          style={{ position: 'absolute', left: W * 0.1, top: H * 0.075, width: W * 0.04, height: 2, background: color }}
        />
      </div>
    );
  }

  /**
   * 槽位在内容盒中的归一化中心偏移（相对内容盒中心，范围 ±0.5）——
   * 运镜靠这张表确定性推算目标位置，不做 DOM 测量（渲染必须是 frame 的纯函数）。
   */
  const SLOT_OFFSET: Record<SafeLayoutVariant, Partial<Record<MotionSlotName, [number, number]>>> = {
    'single-focus': { main: [0, 0] },
    'title-hero': { header: [0, -0.38], main: [0, 0.08] },
    'split-compare': { header: [0, -0.4], main: [0, 0.08] },
    'chart-with-kicker': { header: [0, -0.38], main: [0, 0.08] },
    'list-with-kicker': { header: [0, -0.38], main: [0, 0.08] },
    'asset-aside': { header: [0, -0.4], main: [-0.22, 0.08], asset: [0.3, 0.08] },
    'asset-led': { asset: [-0.28, 0], header: [0.34, -0.3], main: [0.34, 0.15] },
    'corner-anchor': { main: [0.38, -0.36] },
  };

  /** 运镜限幅：越界即失控，一律夹在有界区间内（配合 CardStage overflow:hidden 不会露底）。 */
  const CAMERA_BOUND = { scale: [0.94, MOTION_CAMERA_MAX_SCALE] as const, shift: 0.09 };

  interface CameraState {
    scale: number;
    x: number;
    y: number;
  }

  function resolveShotState(shot: CameraShot, prev: CameraState, layout: SafeLayoutVariant): CameraState {
    const offset = (shot.target ? SLOT_OFFSET[layout]?.[shot.target] : undefined) ?? [0, 0];
    if (shot.move === 'pull-out') return { scale: 0.97, x: 0, y: 0 };
    if (shot.move === 'pan-left') return { ...prev, x: -0.05 };
    if (shot.move === 'pan-right') return { ...prev, x: 0.05 };
    const scale = shot.move === 'focus' ? 1.1 : 1.06;
    // 推近时把目标槽位往画面中心带（乘 scale 抵消缩放引入的位移放大）
    return { scale, x: -offset[0] * scale * 0.9, y: -offset[1] * scale * 0.9 };
  }

  function cameraFromShots(shots: CameraShot[] | undefined, layout: SafeLayoutVariant): CameraState {
    let cur: CameraState = { scale: 1, x: 0, y: 0 };
    for (const shot of shots ?? []) {
      if (!shot?.beat) continue;
      const target = resolveShotState(shot, cur, layout);
      const e = eases.glide(clamp01(shot.beat.p));
      cur = {
        scale: cur.scale + (target.scale - cur.scale) * e,
        x: cur.x + (target.x - cur.x) * e,
        y: cur.y + (target.y - cur.y) * e,
      };
    }
    return cur;
  }

  function CardStage({
    tokens,
    shots,
    layout = 'single-focus',
    children,
    style,
  }: {
    tokens?: Partial<MotionTokens> | null;
    shots?: CameraShot[];
    layout?: SafeLayoutVariant;
    children?: ReactNode;
    style?: CSSProperties;
  }) {
    const frame = useCurrentFrame();
    const { width: W, height: H, fps, durationInFrames: D } = useVideoConfig();
    const t = normalizeMotionTokens(tokens);
    const camera = t.camera ?? { mode: 'still' as const };
    let driftScale = 1;
    let driftX = 0;
    if (camera.mode !== 'still') {
      // range = [起点, 终点]，跨全片单调慢漂；push 通常升序（推近）、pull 降序（拉远），
      // 数值本身即真源，mode 只是语义标签。pan 把同一漂移映射为 ±小幅水平位移。
      const [a, b] = camera.range ?? (camera.mode === 'pull' ? [1.01, 0.99] : [0.99, 1.01]);
      const drift = interpolate(frame, [0, Math.max(D, 1)], [a, b], { ...CLAMP, easing: eases.glide });
      if (camera.mode === 'pan') driftX = (drift - (a + b) / 2) * W;
      else driftScale = drift;
    }
    // 叙事运镜与风格慢漂叠加后统一限幅：慢漂负责"活着"，运镜负责"讲清楚"。
    const shot = cameraFromShots(shots, layout);
    const finalScale = Math.max(
      CAMERA_BOUND.scale[0],
      Math.min(CAMERA_BOUND.scale[1], shot.scale * driftScale),
    );
    const bound = CAMERA_BOUND.shift;
    const finalX = Math.max(-bound, Math.min(bound, shot.x)) * (W * 0.8) + driftX;
    const finalY = Math.max(-bound, Math.min(bound, shot.y)) * (H * 0.72);
    const cameraTransform = `translate(${finalX.toFixed(2)}px, ${finalY.toFixed(2)}px) scale(${finalScale.toFixed(4)})`;
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
      // 大图小字：素材通栏占左格（约 65% 宽、满内容高）承担主视觉；
      // 右列只剩 header kicker + main 一行注释——文字必须少而克制。
      'asset-led': {
        gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 0.7fr)',
        gridTemplateRows: 'auto minmax(0, 1fr)',
        gridTemplateAreas: '"asset header" "asset main"',
      },
      // 关键词锚点：main 槽收缩到内容尺寸并钉在内容盒右上角（底部 20% 字幕区之外），
      // 大面积留白是刻意的——让观众聚焦口播，锚点只做「叮一下」的强调。
      'corner-anchor': {
        gridTemplateColumns: 'minmax(0, 1fr)',
        gridTemplateRows: 'minmax(0, 1fr)',
        gridTemplateAreas: '"main"',
        alignItems: 'start',
        justifyItems: 'end',
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

  /* ---------- 指示标注层：讲解者的手（圈 / 框 / 划 / 指 / 聚光） ---------- */

  function dimColor(t: MotionTokens, alpha: number): string {
    const rgb = parseColor(t.palette.bg);
    if (!rgb) return `rgba(0,0,0,${alpha.toFixed(3)})`;
    return `rgba(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])},${alpha.toFixed(3)})`;
  }

  function Annotate({
    kind,
    beat,
    side = 'right',
    children,
    style,
  }: {
    kind: AnnotateKind;
    beat: Beat;
    side?: 'left' | 'right' | 'top' | 'bottom';
    children?: ReactNode;
    style?: CSSProperties;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const p = clamp01(beat?.p ?? 1);
    const draw = eases.drive(p);
    const accent = t.palette.accent;
    const stroke = Math.max(2, H * 0.0035);
    // 标注的呼吸留白由包裹器 padding 真实占位（下方 wrap），标注层再精确铺满这层留白：
    // 任何负向外扩都会溢出内容盒被渲染探针判裁切，所以这里一律 inset:0 且显式给尺寸。
    const cover: CSSProperties = {
      position: 'absolute',
      left: 0,
      top: 0,
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
    };
    const svgProps = { viewBox: '0 0 100 100', preserveAspectRatio: 'none' as const, style: cover };
    const strokeProps = {
      fill: 'none',
      stroke: accent,
      strokeWidth: stroke,
      strokeLinecap: 'round' as const,
      vectorEffect: 'non-scaling-stroke' as const,
      pathLength: 1,
      strokeDasharray: 1,
      strokeDashoffset: 1 - draw,
    };
    let layer: ReactNode = null;
    if (kind === 'circle') {
      layer = (
        <svg {...svgProps} style={{ ...cover, transform: 'rotate(-1.2deg)' }}>
          <ellipse cx="50" cy="50" rx="48" ry="45" {...strokeProps} />
        </svg>
      );
    } else if (kind === 'box') {
      layer = (
        <svg {...svgProps}>
          <rect x="1" y="1" width="98" height="98" {...strokeProps} />
        </svg>
      );
    } else if (kind === 'underline') {
      layer = (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: Math.max(2, H * 0.005),
            background: accent,
            transform: `scaleX(${draw.toFixed(4)})`,
            transformOrigin: 'left center',
          }}
        />
      );
    } else if (kind === 'highlight') {
      // 荧光笔：低透明 accent 扫过文字背面，不改字色——不触发字底对比度回退
      layer = (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: accent,
            opacity: 0.18,
            zIndex: 0,
            transform: `scaleX(${draw.toFixed(4)})`,
            transformOrigin: 'left center',
          }}
        />
      );
    } else if (kind === 'strike') {
      layer = (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: '50%',
            height: Math.max(2, H * 0.004),
            background: accent,
            transform: `scaleX(${draw.toFixed(4)})`,
            transformOrigin: 'left center',
          }}
        />
      );
    } else if (kind === 'spotlight') {
      layer = (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: H * 0.02,
            boxShadow: `0 0 0 9999px ${dimColor(t, 0.66 * eases.crisp(p))}`,
          }}
        />
      );
    } else if (kind === 'arrow') {
      // 从挂靠边内侧指向元素中心，箭头全程在盒内
      const geometry =
        side === 'left'
          ? { d: 'M 2 50 L 26 50', head: 'M 26 50 L 18 45 L 18 55 Z' }
          : side === 'right'
            ? { d: 'M 98 50 L 74 50', head: 'M 74 50 L 82 45 L 82 55 Z' }
            : side === 'top'
              ? { d: 'M 50 2 L 50 26', head: 'M 50 26 L 45 18 L 55 18 Z' }
              : { d: 'M 50 98 L 50 74', head: 'M 50 74 L 45 82 L 55 82 Z' };
      layer = (
        <svg {...svgProps}>
          <path d={geometry.d} {...strokeProps} />
          <path d={geometry.head} fill={accent} opacity={clamp01((p - 0.6) / 0.3)} />
        </svg>
      );
    }

    return (
      <div
        data-motion-annotate={kind}
        style={{
          // 与 MotionSlot 的容器语义保持一致：包一层不能改变子元素的尺寸约束，
          // 否则原本受 flex 约束的图表会退回内在高度并撑破内容盒。
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          minWidth: 0,
          minHeight: 0,
          ...style,
        }}
      >
        <div
          style={{
            position: 'relative',
            zIndex: 1,
            // flex 子项默认 min-width:auto——不显式归零，宽内容会把包裹器顶出内容盒
            minWidth: 0,
            minHeight: 0,
            maxWidth: '100%',
            opacity: kind === 'strike' ? 1 - 0.42 * draw : 1,
          }}
        >
          {children}
        </div>
        {layer}
      </div>
    );
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
    decimals,
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
    decimals,
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
    const { tokens: t, H, CH, frame, fps } = useStage();
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
      // 满宽折线的高度 = 宽 × 0.42，通栏时单图就吃掉整个内容盒（带 header / 标签必溢出）：
      // 按内容盒高度反推最大宽度，把图表钉在 ≤0.58CH，其余留给标题与首尾标签。
      <div style={{ position: 'relative', width: '100%', maxWidth: (CH * 0.58) / 0.42, margin: '0 auto' }}>
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
    keywords,
  }: {
    items: string[];
    beat?: Beat;
    beats?: Beat[];
    focusIndex?: number;
    emphasis?: MotionKitEmphasis;
    keywords?: string[];
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
          const land = b?.land ?? start + 12;
          const keyword = typeof keywords?.[i] === 'string' && keywords[i].trim() ? keywords[i].trim() : '';
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
                  ...(i === focusIndex ? emphasize(frame, land, fps, emphasis) : {}),
                }}
              >
                {keyword
                  ? scanSpans(text, [keyword], () => land + 2, frame, 'color', t.palette.ink, accentTextColor(t), t.palette.bg)
                  : text}
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
          // 象限点逐项 stagger 入场（不再统一 opacity），focus 项落定后保留 emphasize。
          const start = beat.start + i * 5;
          const p = interpolate(frame, [start, start + 12], [0, 1], CLAMP);
          return (
            <div key={i} style={{ position: 'absolute', left: `${x}%`, top: `${y}%`, transform: 'translate(-50%, -50%)' }}>
              <div style={{ padding: `${H * 0.01}px ${H * 0.018}px`, background: item.focus ? t.palette.accent : t.palette.track, color: item.focus ? t.palette.bg : t.palette.ink, fontFamily: t.fonts.body, fontSize: H * 0.028, whiteSpace: 'nowrap', ...popIn(p), ...(item.focus ? emphasize(frame, start + 12, fps, emphasis) : {}) }}>
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
          {links.slice(0, 8).map(([a, b], i) => {
            if (!coords[a] || !coords[b]) return null;
            // 节点落位后连线依次描边生长（drawOn 在 SVG 上的描边等价手法，与 TrendLine 一致）
            const linkP = interpolate(frame, [beat.start + 4 + i * 3, beat.start + 16 + i * 3], [0, 1], CLAMP);
            return (
              <line key={i} x1={coords[a].x} y1={coords[a].y} x2={coords[b].x} y2={coords[b].y} stroke={t.palette.track} strokeWidth={0.8} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - eases.glide(linkP)} />
            );
          })}
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

  /* ---------- 文字动效原语（kinetic typography：逐字 / 逐词 / 关键词扫描） ---------- */

  /** 三个文字原语共享的排版覆写：缺省全部走 tokens。 */
  interface KineticTypeProps {
    font?: 'display' | 'body' | 'mono';
    size?: number;
    weight?: number;
    color?: string;
  }

  function kineticTypeStyle(t: MotionTokens, H: number, props: KineticTypeProps): CSSProperties {
    return {
      fontFamily: props.font ? t.fonts[props.font] : t.fonts.body,
      fontSize: H * (props.size ?? t.typeScale?.lead ?? 0.05),
      fontWeight: props.weight ?? 500,
      color: props.color ?? t.palette.ink,
    };
  }

  /** 句内关键词定位：按 keywords 顺序在 text 中顺序匹配首次出现，返回 [start, end) 区间（kit 不做分词/提取）。 */
  function locateKeywords(text: string, keywords: string[]): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    let cursor = 0;
    for (const raw of keywords) {
      const kw = String(raw ?? '');
      if (!kw) continue;
      const at = text.indexOf(kw, cursor);
      if (at < 0) continue;
      ranges.push([at, at + kw.length]);
      cursor = at + kw.length;
    }
    return ranges;
  }

  /**
   * 关键词扫描着色片段（KeywordScan 与 ListBuild keywords 共用）：
   * color = 文字颜色渐变点亮（clip-path 扫亮）；sweep = accent 色块扫过。
   * startAt(k) 给出第 k 个关键词的扫描起始帧。
   */
  function scanSpans(
    text: string,
    keywords: string[],
    startAt: (k: number) => number,
    frame: number,
    mode: 'color' | 'sweep',
    baseColor: string,
    accent: string,
    onAccent: string,
  ): ReactNode[] {
    const ranges = locateKeywords(text, keywords).slice(0, 6);
    const nodes: ReactNode[] = [];
    let pos = 0;
    ranges.forEach(([s, e], k) => {
      if (s > pos) nodes.push(text.slice(pos, s));
      const word = text.slice(s, e);
      const p = interpolate(frame, [startAt(k), startAt(k) + 10], [0, 1], CLAMP);
      if (mode === 'sweep') {
        nodes.push(
          <span
            key={`kw${k}`}
            style={{
              display: 'inline-block',
              whiteSpace: 'nowrap',
              // padding 扩块、负 margin 收回，扫块不推动前后文字
              padding: '0 0.14em',
              margin: '0 -0.14em',
              borderRadius: '0.14em',
              color: p >= 0.5 ? onAccent : baseColor,
              backgroundImage: `linear-gradient(${accent}, ${accent})`,
              backgroundRepeat: 'no-repeat',
              backgroundSize: `${(p * 100).toFixed(1)}% 100%`,
            }}
          >
            {word}
          </span>,
        );
      } else {
        nodes.push(
          <span key={`kw${k}`} style={{ position: 'relative', display: 'inline-block', whiteSpace: 'nowrap' }}>
            <span>{word}</span>
            <span style={{ position: 'absolute', inset: 0, color: accent, clipPath: `inset(0 ${((1 - p) * 100).toFixed(1)}% 0 0)` }}>
              {word}
            </span>
          </span>,
        );
      }
      pos = e;
    });
    if (pos < text.length) nodes.push(text.slice(pos));
    return nodes;
  }

  function TypewriterText({
    text,
    beat,
    framesPerChar = 2,
    cursor = true,
    detail,
    emphasis: emphasisOverride,
    ...typeProps
  }: {
    text: string;
    beat: Beat;
    framesPerChar?: number;
    cursor?: boolean;
    detail?: string;
    emphasis?: MotionKitEmphasis;
  } & KineticTypeProps) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const lines = String(text ?? '').split('\n');
    // 单字落笔窗（pop 回弹），逐字间隔 framesPerChar
    const perChar = 4;
    const total = lines.reduce((n, line) => n + Array.from(line).length, 0);
    if (total === 0 && !detail) return null;
    const typedEnd = beat.start + Math.max(0, (total - 1) * framesPerChar) + perChar;
    const headIndex = Math.min(total - 1, Math.max(-1, Math.floor((frame - beat.start) / Math.max(1, framesPerChar))));
    // 光标：打字中常显；落笔后短闪烁再退出（全部帧驱动，确定性）
    const cursorOn = frame < typedEnd || Math.floor((frame - typedEnd) / 4) % 2 === 0;
    const cursorGone = frame >= typedEnd + 22;
    const cursorNode = cursor && !cursorGone ? (
      <span
        style={{
          display: 'inline-block',
          width: '0.09em',
          height: '0.92em',
          marginLeft: '0.05em',
          verticalAlign: '-0.1em',
          background: typeProps.color ?? accentTextColor(t),
          opacity: frame >= beat.start && cursorOn ? 1 : 0,
        }}
      />
    ) : null;
    const detailP = interpolate(frame, [typedEnd + 2, typedEnd + 14], [0, 1], CLAMP);
    let charIndex = 0;
    return (
      <div style={{ lineHeight: 1.3, ...kineticTypeStyle(t, H, typeProps), ...emphasize(frame, typedEnd, fps, emphasis) }}>
        {lines.map((line, lineIdx) => {
          const chars = Array.from(line);
          const nodes: ReactNode[] = [];
          if (lineIdx === 0 && headIndex < 0 && cursorNode) nodes.push(cursorNode);
          chars.forEach((ch) => {
            const idx = charIndex;
            charIndex += 1;
            const appear = beat.start + idx * Math.max(1, framesPerChar);
            const p = interpolate(frame, [appear, appear + perChar], [0, 1], CLAMP);
            const e = eases.lift(p);
            nodes.push(
              <span
                key={idx}
                style={{
                  display: 'inline-block',
                  whiteSpace: 'pre',
                  opacity: eases.snap(p),
                  transform: `translateY(${((1 - e) * 0.3).toFixed(3)}em) scale(${(0.92 + e * 0.08).toFixed(4)})`,
                }}
              >
                {ch}
              </span>,
            );
            if (idx === headIndex && cursorNode) nodes.push(cursorNode);
          });
          return <div key={lineIdx}>{nodes.length > 0 ? nodes : ' '}</div>;
        })}
        {detail ? (
          <div style={{ marginTop: H * 0.03, fontFamily: t.fonts.body, fontSize: H * (t.typeScale?.body ?? 0.036), lineHeight: 1.45, color: t.palette.muted, ...fadeUp(detailP, 14) }}>
            {detail}
          </div>
        ) : null}
      </div>
    );
  }

  function WordPop({
    words,
    beat,
    beats,
    gap = 4,
    emphasis: emphasisOverride,
    ...typeProps
  }: {
    words: string[];
    beat?: Beat;
    beats?: Beat[];
    gap?: number;
    emphasis?: MotionKitEmphasis;
  } & KineticTypeProps) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const safeWords = words.map((w) => String(w ?? '')).filter((w) => w.length > 0).slice(0, 12);
    if (safeWords.length === 0) return null;
    const lastBeat = beats?.[safeWords.length - 1];
    const lastLand = lastBeat?.land ?? (beat?.start ?? 0) + (safeWords.length - 1) * gap + 10;
    return (
      <div style={{ lineHeight: 1.3, ...kineticTypeStyle(t, H, typeProps), ...emphasize(frame, lastLand, fps, emphasis) }}>
        {safeWords.map((word, i) => {
          const b = beats?.[i];
          const start = b ? b.start : (beat?.start ?? 0) + i * gap;
          const p = b ? b.p : interpolate(frame, [start, start + 10], [0, 1], CLAMP);
          return (
            <span key={i} style={{ display: 'inline-block', whiteSpace: 'pre', marginRight: i < safeWords.length - 1 ? '0.22em' : 0, ...popIn(p) }}>
              {word}
            </span>
          );
        })}
      </div>
    );
  }

  function KeywordScan({
    text,
    keywords,
    beat,
    mode = 'color',
    gap = 10,
    emphasis: emphasisOverride,
    ...typeProps
  }: {
    text: string;
    keywords: string[];
    beat: Beat;
    mode?: 'color' | 'sweep';
    gap?: number;
    emphasis?: MotionKitEmphasis;
  } & KineticTypeProps) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const base = kineticTypeStyle(t, H, typeProps);
    return (
      <div style={{ lineHeight: 1.4, overflowWrap: 'anywhere', ...base, ...fadeUp(beat.p, 18), ...emphasize(frame, beat.land, fps, emphasis) }}>
        {scanSpans(String(text ?? ''), keywords, (k) => beat.start + 6 + k * gap, frame, mode, base.color as string, accentTextColor(t), t.palette.bg)}
      </div>
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
    decimals,
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
    decimals,
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
    maskReveal,
    blurIn,
    unfold,
    scaleThrough,
    elasticIn,
    stagger,
    countUp,
    valueRewrite,
    morphSwap,
    reorderY,
    settle,
    brighten,
    emphasize: emphasize as MotionKit['emphasize'],
    Annotate,
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
    TypewriterText,
    WordPop,
    KeywordScan,
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
  'maskReveal',
  'blurIn',
  'unfold',
  'scaleThrough',
  'elasticIn',
  'stagger',
  'countUp',
  'valueRewrite',
  'morphSwap',
  'reorderY',
  'settle',
  'brighten',
  'emphasize',
  'Annotate',
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
  'TypewriterText',
  'WordPop',
  'KeywordScan',
] as const;

/**
 * 注入雕刻提示词的 kit API 摘要——唯一事实来源，与实现同文件维护。
 * 修改 API 时必须同步本摘要。
 */
export const MOTION_KIT_API_DOC = `import { CardStage, SafeLayout, MotionSlot, Annotate, useBeats, useTimingPlan, Kicker, StatHero, RingCounter, BarChart, HorizontalBars, TrendLine, CompareRow, ListBuild, RankList, ChecklistPop, ProcessFlow, CauseChain, QuoteBlock, ConceptCard, CitationCard, KeyPointMarker, TimelineRail, MatrixQuadrant, FunnelStack, NetworkMap, BeforeAfter, MythFactSwap, StackedComposition, ColumnChart, DonutChart, MetricPulse, ScaleImpact, StatGrid, DataTable, SectionTitle, UnderlineSweep, TypewriterText, WordPop, KeywordScan, fadeUp, slideIn, riseIn, popIn, trackIn, drawOn, maskReveal, blurIn, unfold, scaleThrough, elasticIn, stagger, countUp, valueRewrite, morphSwap, reorderY, emphasize, useStage } from '@lingji/motion-kit';

// 舞台（必用做根节点）：底色/安全区(底部20%字幕区)/镜头慢漂/氛围装饰层/退场淡出全部内置
<CardStage tokens={TOKENS}>{...}</CardStage>   // TOKENS = 系统注入的风格 tokens 常量，原样传入
// 叙事运镜（可选，强解释力）：把镜头推向正在讲的那块内容；限幅与收敛内置，只声明意图
<CardStage tokens={TOKENS} layout="title-hero" shots={[{ beat: beats[2], move: 'focus', target: 'main' }]}>
// move: 'push-in' 推近 | 'focus' 推近并把 target 槽位带到画面中心 | 'pull-out' 拉开看全局 | 'pan-left' / 'pan-right' 横移
// layout 必须与下面 SafeLayout 的 variant 一致；整卡运镜 ≤2 次，滥用会晕

// 自动模式安全布局（必用）：一个 header + 一个 main，或明确的左右槽位；禁止自由 absolute 定位
<SafeLayout variant="title-hero">
  <MotionSlot name="header" role="support" lifecycle={{enter: beats[0], collapse: beats[1]}}><Kicker ... /></MotionSlot>
  <MotionSlot name="main" role="focus" lifecycle={{enter: beats[1]}}><StatHero ... /></MotionSlot>
</SafeLayout>
// lifecycle 作用于整个语义区块：enter 入场、update 短暂提亮、collapse 收为弱辅助、exit 退场
// corner-anchor 变体：main 槽钉在右上角（无 header），专供关键词锚点卡——配 WordPop size={0.04} 小字，大面积留白让观众聚焦口播

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
<TypewriterText text="逐字上屏的标题" beat={beats[1]} framesPerChar={2} detail="打完后淡入的副行" font="display" size={0.09} /> // 打字机，\n 多行；cursor={false} 去光标
<WordPop words={['光模块', '是', '最大确定性']} beat={beats[1]} font="display" size={0.08} emphasis="settle" /> // 逐词弹入带回弹；语义块由你切分（kit 不分词），≤12 块
<KeywordScan text="毛利率创下历史新高" keywords={['历史新高']} beat={beats[1]} mode="sweep" />  // 句内关键词逐个强调：color=变色点亮(默认) sweep=色块扫过
<ListBuild items={['需求爆发', '订单饱满']} keywords={['爆发', '']} beats={[beats[1], beats[2]]} /> // keywords[i] 属于 items[i]，条目落地后变色点亮

// 指示标注（讲解者的手，clarity 最高杠杆）：包住要指的那块内容；标注层不占布局、不进容量预算
<Annotate kind="circle" beat={beats[2]}><StatHero ... /></Annotate>
<Annotate kind="arrow" beat={beats[2]} side="right"><TrendLine ... /></Annotate>
// kind: 'circle' 圈出 | 'box' 框出 | 'underline' 划线 | 'highlight' 荧光笔扫过 | 'strike' 划掉(误区)
//     | 'spotlight' 压暗其余只留这块 | 'arrow' 箭头指入(side 定方向)
// 纯图形无文字——要写字用 Kicker / 内容原语。整卡 ≤2 个 Annotate，只标真正的焦点

// 手法（返回 style 片段，自由拼装自己的元素；每种缓动不同，别整卡只用一种）
fadeUp(beat.p)  slideIn(beat.p,'left')  riseIn(beat.p)  popIn(beat.p)  trackIn(beat.p)  drawOn(beat.p,'x')
maskReveal(beat.p,'up')   // 内容不动，由边界擦出（信息图首选）
blurIn(beat.p)            // 失焦→合焦
unfold(beat.p)            // 绕顶边 3D 翻下
scaleThrough(beat.p)      // 从略大缩到位，镜头穿越感
elasticIn(beat.p)         // 一次可控回弹
stagger(beat.p, i, n)     // 逐项错峰子进度：items.map((x,i)=> fadeUp(stagger(beat.p,i,items.length)))
countUp(beat.p, 28842)                       // 数字字符串（配 fontVariantNumeric:'tabular-nums'）
// 状态转移（MG 的核心：同一元素变成另一状态，而不是又一次入场）
valueRewrite(beat.p, 19003, 28842)           // 数值从旧值改写到新值（"这个指标变了"）
const m = morphSwap(beat.p)                  // 同位替换：<span style={m.out}>旧</span> 叠 <span style={m.in}>新</span>
reorderY(beat.p, 3, 0, rowH)                 // 列表某项移动到新名次（rowH = 行高 px）
emphasize(frame, beat.land, fps, 'slam')
// storyboard 原生强调：'countup-settle'计数后回弹 | 'slam'重落 | 'underline-sweep'下划线扫过 | 'brighten'短暂提亮
// 兼容旧卡：'settle' | 'underline' | 'none'

// 布局与自定义：useStage() → { tokens, W, H, CW, CH, fps, D, frame }；自定义元素用 tokens 配色配字体
// useStage 的 tokens 只在 CardStage 的子组件内有效——在渲染 <CardStage> 的组件体里调用会拿到默认深色 tokens（surface.bg 为空、ink 反色，字底同色判失败）；该处配色请直接读 TOKENS 常量，useStage 只取尺寸/帧率
// 自定义色块内的字色必须与该块底色对比 ≥3:1：accent 当块底时字用 bg/ink，绝不 accent 底配 accent 字（机器逐帧检查对比度，撞色直接打回）
// 尺寸铁律：CardStage 内容区左右各留 10%、底部留 20% 字幕区——整行元素 / svg / 横向条的宽度用 CW（=0.8×W），高度预算用 CH（=0.72×H）；写 W/H 全尺寸必溢出画布判失败
// 仍可 import { useCurrentFrame, useVideoConfig, interpolate, spring, Easing } from 'remotion' 写 kit 没有的表达
// 自写 interpolate 必须带双侧 clamp：{ extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }（漏一侧=区间外爆炸，lint 会拦）`;
