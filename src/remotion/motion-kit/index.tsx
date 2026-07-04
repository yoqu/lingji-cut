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
    emphasis?: 'settle' | 'brighten' | 'underline' | 'none';
  };
}

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
 * WCAG 相对亮度对比不足 3:1 时字色回落 ink；只约束"字"，条 / 面 / 描线仍用 accent。 */

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

function accentTextColor(palette: MotionTokens['palette']): string {
  const la = hexLuminance(palette.accent);
  const lb = hexLuminance(palette.bg);
  if (la == null || lb == null) return palette.accent;
  const ratio = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  return ratio < 3 ? palette.ink : palette.accent;
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
  useStage: () => StageState;
  useBeats: (cues: number[], anchors: Array<number | null>, opts?: { lead?: number; dur?: number }) => Beat[];
  fadeUp: (p: number, dist?: number) => CSSProperties;
  slideIn: (p: number, dir?: 'left' | 'right', dist?: number) => CSSProperties;
  riseIn: (p: number) => CSSProperties;
  popIn: (p: number) => CSSProperties;
  trackIn: (p: number) => CSSProperties;
  drawOn: (p: number, axis?: 'x' | 'y') => CSSProperties;
  countUp: (p: number, value: number, decimals?: number) => string;
  settle: (frame: number, land: number, fps: number, max?: number) => CSSProperties;
  brighten: (frame: number, land: number) => CSSProperties;
  emphasize: (frame: number, land: number, fps: number, kind?: 'settle' | 'brighten' | 'underline' | 'none') => CSSProperties;
  Kicker: React.ComponentType<{ text: string; beat: Beat; accent?: boolean }>;
  StatHero: React.ComponentType<{
    value: number;
    unit?: string;
    label?: string;
    beat: Beat;
    decimals?: number;
    /** 提供 max 时在数字下方画等比配重条 */
    max?: number;
  }>;
  BarChart: React.ComponentType<{
    items: Array<{ label: string; value: number; display?: string }>;
    beat: Beat;
    focusIndex?: number;
  }>;
  TrendLine: React.ComponentType<{
    points: number[];
    beat: Beat;
    startLabel?: string;
    endLabel?: string;
  }>;
  CompareRow: React.ComponentType<{
    left: { label: string; value: string };
    right: { label: string; value: string };
    beat: Beat;
    divider?: string;
  }>;
  ListBuild: React.ComponentType<{
    items: string[];
    beat?: Beat;
    beats?: Beat[];
  }>;
  ProcessFlow: React.ComponentType<{ steps: string[]; beat?: Beat; beats?: Beat[] }>;
  QuoteBlock: React.ComponentType<{ text: string; source?: string; beat: Beat }>;
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
  const emphasize = (
    frame: number,
    land: number,
    fps: number,
    kind: 'settle' | 'brighten' | 'underline' | 'none' = 'settle',
  ): CSSProperties => {
    if (kind === 'settle') return settle(frame, land, fps);
    if (kind === 'brighten') return brighten(frame, land);
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
          background: t.palette.bg,
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
          >
            <StageCtx.Provider value={stage}>{children}</StageCtx.Provider>
          </div>
        </div>
      </AbsoluteFill>
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
          color: accent ? accentTextColor(t.palette) : t.palette.muted,
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
  }: {
    value: number;
    unit?: string;
    label?: string;
    beat: Beat;
    decimals?: number;
    max?: number;
  }) {
    const { tokens: t, H, W, fps, frame } = useStage();
    const emphasis = t.persona?.emphasis ?? 'settle';
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
              color: accentTextColor(t.palette),
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
  }: {
    items: Array<{ label: string; value: number; display?: string }>;
    beat: Beat;
    focusIndex?: number;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const maxValue = Math.max(...items.map((it) => it.value), 1);
    const emphasis = t.persona?.emphasis ?? 'settle';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: H * 0.03 }}>
        {items.map((it, i) => {
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
                  color: focus ? accentTextColor(t.palette) : t.palette.ink,
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
  }: {
    points: number[];
    beat: Beat;
    startLabel?: string;
    endLabel?: string;
  }) {
    const { tokens: t, H } = useStage();
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
          <span style={{ color: accentTextColor(t.palette) }}>{endLabel ?? ''}</span>
        </div>
      </div>
    );
  }

  function CompareRow({
    left,
    right,
    beat,
    divider = 'VS',
  }: {
    left: { label: string; value: string };
    right: { label: string; value: string };
    beat: Beat;
    divider?: string;
  }) {
    const { tokens: t, H, frame, fps } = useStage();
    const emphasis = t.persona?.emphasis ?? 'settle';
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
            color: focus ? accentTextColor(t.palette) : t.palette.muted,
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
        {cell('left', left, true)}
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
        {cell('right', right, false)}
      </div>
    );
  }

  function ListBuild({ items, beat, beats }: { items: string[]; beat?: Beat; beats?: Beat[] }) {
    const { tokens: t, H, frame } = useStage();
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: H * 0.045 }}>
        {items.map((text, i) => {
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
                  color: accentTextColor(t.palette),
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
                  ...fadeUp(p, 20),
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

  function ProcessFlow({ steps, beat, beats }: { steps: string[]; beat?: Beat; beats?: Beat[] }) {
    const { tokens: t, H, frame } = useStage();
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: H * 0.02 }}>
        {steps.map((text, i) => {
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
                }}
              >
                <span
                  style={{
                    fontFamily: t.fonts.mono,
                    fontSize: H * (t.typeScale?.label ?? 0.025),
                    color: accentTextColor(t.palette),
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

  function QuoteBlock({ text, source, beat }: { text: string; source?: string; beat: Beat }) {
    const { tokens: t, H, frame } = useStage();
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
            color: accentTextColor(t.palette),
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

  function UnderlineSweep({ beat, width = '38%' }: { beat: Beat; width?: string }) {
    const { tokens: t, H } = useStage();
    return (
      <div style={{ width, height: Math.max(3, H * 0.005), background: t.palette.accent, ...drawOn(beat.p) }} />
    );
  }

  return {
    CardStage,
    useStage,
    useBeats,
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
    UnderlineSweep,
  };
}

/**
 * kit 的全部可 import 名称——lint 用它静态校验卡片的 named import，
 * 在编译前拦住"幻觉 API"。新增导出时必须同步本清单与下方 API 摘要。
 */
export const MOTION_KIT_EXPORT_NAMES = [
  'CardStage',
  'useStage',
  'useBeats',
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
  'UnderlineSweep',
] as const;

/**
 * 注入雕刻提示词的 kit API 摘要——唯一事实来源，与实现同文件维护。
 * 修改 API 时必须同步本摘要。
 */
export const MOTION_KIT_API_DOC = `import { CardStage, useBeats, Kicker, StatHero, BarChart, TrendLine, CompareRow, ListBuild, ProcessFlow, QuoteBlock, UnderlineSweep, fadeUp, slideIn, riseIn, popIn, trackIn, drawOn, countUp, emphasize, useStage } from '@lingji/motion-kit';

// 舞台（必用做根节点）：底色/安全区(底部20%字幕区)/镜头慢漂/氛围装饰层/退场淡出全部内置
<CardStage tokens={TOKENS}>{...}</CardStage>   // TOKENS = 系统注入的风格 tokens 常量，原样传入

// 节拍（必用）：anchors[i] = 第 i 拍内容在逐句字幕里被讲到的句索引（第 0 拍传 null 表示入场）
const beats = useBeats(cues, [null, 2, 5]);    // 返回 Beat[]：{ start, p(0→1), land, done }
// 提前量/单调不减/空 cues 均匀兜底/clamp 已内置——不要自己计算揭示帧

// 内容原语（自动消费 tokens 的颜色/字体/字号，自带 tabular-nums 与等比配重）
<Kicker text="标签" beat={beats[0]} />                                   // mono 小标签，字距收拢入场
<StatHero value={28842} unit="人" label="硕士报名" beat={beats[1]} max={40000} />  // 大数计数+配重条+落地强调
<BarChart items={[{label:'硕士', value:28842}, {label:'博士', value:2403}]} beat={beats[1]} focusIndex={0} />
<TrendLine points={[3,5,4,9,14]} beat={beats[1]} startLabel="2020" endLabel="2024" />
<CompareRow left={{label:'今年', value:'28842'}} right={{label:'去年', value:'19003'}} beat={beats[1]} />
<ListBuild items={['要点一','要点二','要点三']} beats={[beats[1], beats[2], beats[3]]} />  // 或单 beat 内错峰：beat={beats[1]}
<ProcessFlow steps={['报名','初试','复试']} beat={beats[1]} />
<QuoteBlock text="金句原文" source="出处" beat={beats[1]} />
<UnderlineSweep beat={beats[2]} width="38%" />                           // 焦点下划线扫过（accent 小重音）

// 手法（返回 style 片段，自由拼装自己的元素；每种缓动不同，别整卡只用一种）
fadeUp(beat.p)  slideIn(beat.p,'left')  riseIn(beat.p)  popIn(beat.p)  trackIn(beat.p)  drawOn(beat.p,'x')
countUp(beat.p, 28842)                       // 数字字符串（配 fontVariantNumeric:'tabular-nums'）
emphasize(frame, beat.land, fps, 'settle')   // 焦点落地强调：'settle'回弹 | 'brighten'提亮，一次性收敛

// 布局与自定义：useStage() → { tokens, W, H, CW, CH, fps, D, frame }；自定义元素用 tokens 配色配字体
// 尺寸铁律：CardStage 内容区左右各留 10%、底部留 20% 字幕区——整行元素 / svg / 横向条的宽度用 CW（=0.8×W），高度预算用 CH（=0.72×H）；写 W/H 全尺寸必溢出画布判失败
// 仍可 import { useCurrentFrame, useVideoConfig, interpolate, spring, Easing } from 'remotion' 写 kit 没有的表达
// 自写 interpolate 必须带双侧 clamp：{ extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }（漏一侧=区间外爆炸，lint 会拦）`;
