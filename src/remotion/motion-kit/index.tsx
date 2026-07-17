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

function hexLuminance(color: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const ch = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}

/** 导出仅供测试；卡片经 require 垫片只拿到 createMotionKit 的返回值，接触不到本函数。 */
export function accentTextColor(t: Pick<MotionTokens, 'palette' | 'surface'>): string {
  const { palette, surface } = t;
  const la = hexLuminance(palette.accent);
  if (la == null) return palette.accent;
  const contrastOk = (bgLum: number | null) => {
    if (bgLum == null) return true; // 不可解析（rgba 等）时不否决
    return (Math.max(la, bgLum) + 0.05) / (Math.min(la, bgLum) + 0.05) >= 3;
  };
  const surfaceLum = surface && surface.kind !== 'none' && surface.bg ? hexLuminance(surface.bg) : null;
  return contrastOk(hexLuminance(palette.bg)) && contrastOk(surfaceLum) ? palette.accent : palette.ink;
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
  BarChart: React.ComponentType<{
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
  ProcessFlow: React.ComponentType<{ steps: string[]; beat?: Beat; beats?: Beat[]; focusIndex?: number; emphasis?: MotionKitEmphasis }>;
  QuoteBlock: React.ComponentType<{ text: string; source?: string; beat: Beat; emphasis?: MotionKitEmphasis }>;
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
  StackedComposition: React.ComponentType<{ items: Array<{ label: string; value: number; display?: string }>; beat: Beat; focusIndex?: number; emphasis?: MotionKitEmphasis }>;
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

  function TrendLine({
    points,
    beat,
    startLabel,
    endLabel,
    emphasis: emphasisOverride,
  }: {
    points: number[];
    beat: Beat;
    startLabel?: string;
    endLabel?: string;
    emphasis?: MotionKitEmphasis;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = emphasisOverride ?? t.persona?.emphasis ?? 'settle';
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;
    const coords = points.map((v, i) => ({
      x: (i / Math.max(points.length - 1, 1)) * 100,
      y: 38 - ((v - min) / span) * 32,
    }));
    const e = eases.glide(beat.p);
    const line = coords.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ');
    const last = coords[coords.length - 1];
    const first = coords[0];
    return (
      <div style={{ position: 'relative', width: '100%' }}>
        <svg viewBox="0 0 100 42" style={{ width: '100%', display: 'block', overflow: 'visible' }}>
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
    BarChart,
    TrendLine,
    CompareRow,
    ListBuild,
    ProcessFlow,
    QuoteBlock,
    TimelineRail,
    MatrixQuadrant,
    FunnelStack,
    NetworkMap,
    BeforeAfter,
    StackedComposition,
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
  'BarChart',
  'TrendLine',
  'CompareRow',
  'ListBuild',
  'ProcessFlow',
  'QuoteBlock',
  'TimelineRail',
  'MatrixQuadrant',
  'FunnelStack',
  'NetworkMap',
  'BeforeAfter',
  'StackedComposition',
  'UnderlineSweep',
] as const;

/**
 * 注入雕刻提示词的 kit API 摘要——唯一事实来源，与实现同文件维护。
 * 修改 API 时必须同步本摘要。
 */
export const MOTION_KIT_API_DOC = `import { CardStage, SafeLayout, MotionSlot, useBeats, useTimingPlan, Kicker, StatHero, BarChart, TrendLine, CompareRow, ListBuild, ProcessFlow, QuoteBlock, TimelineRail, MatrixQuadrant, FunnelStack, NetworkMap, BeforeAfter, StackedComposition, UnderlineSweep, fadeUp, slideIn, riseIn, popIn, trackIn, drawOn, countUp, emphasize, useStage } from '@lingji/motion-kit';

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
<BarChart items={[{label:'硕士', value:28842}, {label:'博士', value:2403}]} beat={beats[1]} focusIndex={0} emphasis="slam" />
<TrendLine points={[3,5,4,9,14]} beat={beats[1]} startLabel="2020" endLabel="2024" emphasis="countup-settle" />
<CompareRow left={{label:'今年', value:'28842'}} right={{label:'去年', value:'19003'}} beat={beats[1]} focusSide="right" emphasis="brighten" />
<ListBuild items={['要点一','要点二','要点三']} beats={[beats[1], beats[2], beats[3]]} focusIndex={2} emphasis="underline-sweep" />
<ProcessFlow steps={['报名','初试','复试']} beats={[beats[1], beats[2], beats[3]]} focusIndex={2} emphasis="slam" />
<QuoteBlock text="金句原文" source="出处" beat={beats[1]} emphasis="slam" />
<TimelineRail items={['2019 起步','2022 爆发','2024 分化']} beats={[beats[1], beats[2], beats[3]]} focusIndex={2} emphasis="brighten" />
<MatrixQuadrant xLabel="价值" yLabel="难度" items={[{label:'优先做', x:78, y:72, focus:true}, {label:'暂缓', x:28, y:36}]} beat={beats[1]} />
<FunnelStack steps={[{label:'触达', value:'10万'}, {label:'转化', value:'1.2万'}]} beat={beats[1]} />
<NetworkMap nodes={['平台','创作者','观众']} links={[[0,1],[1,2]]} beat={beats[1]} />
<BeforeAfter before="旧流程慢" after="新流程快" beat={beats[1]} mode="wipe" />
<StackedComposition items={[{label:'内容', value:55, display:'55%'}, {label:'分发', value:30, display:'30%'}]} beat={beats[1]} />
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
