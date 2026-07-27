import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CSSProperties } from 'react';
import type { OverlayItem, OverlayMotion, TextLoopAnimation } from '../../types';
import { resolveOverlayMotion } from '../../lib/overlay-motion';

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

export interface TextMotionFrame {
  opacity: number;
  /** 依次拼接到 rotate 之后的 transform 片段。 */
  transforms: string[];
  /** typewriter 循环时的可见字符数；null = 显示全文。 */
  visibleChars: number | null;
}

/**
 * 文字 overlay 的进出场 / 循环动效（纯函数，帧驱动可测试）。
 * enter/exit 消费 OverlayMotion（Inspector 配置经 timeline 归一化 / textData.animation 直通）；
 * loop 含 typewriter（逐字揭示）。enter='none' 保持旧行为：按时长 18% 的淡入。
 */
export function resolveTextMotionFrame(
  motion: OverlayMotion,
  loop: TextLoopAnimation,
  frame: number,
  durationFrames: number,
  fps: number,
  baseOpacity: number,
  totalChars: number,
): TextMotionFrame {
  const enterFrames = Math.max(1, Math.round((Math.max(0, motion.enterDurationMs) / 1000) * fps));
  const exitFrames = Math.max(1, Math.round((Math.max(0, motion.exitDurationMs) / 1000) * fps));
  const exitStart = Math.max(0, durationFrames - exitFrames);
  let opacity = baseOpacity;
  const transforms: string[] = [];

  /* ---- 入场 ---- */
  if (motion.enter === 'none') {
    const fadeIn = Math.min(13, Math.max(5, Math.round(durationFrames * 0.18)));
    opacity *= interpolate(frame, [0, fadeIn], [0, 1], CLAMP);
  } else {
    const pe = interpolate(frame, [0, enterFrames], [0, 1], CLAMP);
    switch (motion.enter) {
      case 'fadeIn':
        opacity *= pe;
        break;
      case 'slideInLeft':
        opacity *= pe;
        transforms.push(`translateX(${(-(1 - pe) * 48).toFixed(2)}px)`);
        break;
      case 'slideInRight':
        opacity *= pe;
        transforms.push(`translateX(${((1 - pe) * 48).toFixed(2)}px)`);
        break;
      case 'slideInUp':
        opacity *= pe;
        transforms.push(`translateY(${((1 - pe) * 40).toFixed(2)}px)`);
        break;
      case 'slideInDown':
        opacity *= pe;
        transforms.push(`translateY(${(-(1 - pe) * 40).toFixed(2)}px)`);
        break;
      case 'scaleIn':
        opacity *= pe;
        transforms.push(`scale(${(0.72 + pe * 0.28).toFixed(4)})`);
        break;
      case 'bounceIn': {
        const s = spring({ frame, fps, config: { damping: 10, stiffness: 170, mass: 0.8 }, durationInFrames: Math.min(enterFrames, 18) });
        const p = Math.max(0, Math.min(1.12, s));
        opacity *= Math.min(1, p * 1.5);
        transforms.push(`scale(${(0.55 + p * 0.45).toFixed(4)})`);
        break;
      }
      default:
        break;
    }
  }

  /* ---- 出场（进入窗口才生效） ---- */
  const px = motion.exit === 'none' ? 0 : interpolate(frame, [exitStart, durationFrames], [0, 1], CLAMP);
  if (px > 0) {
    switch (motion.exit) {
      case 'fadeOut':
        opacity *= 1 - px;
        break;
      case 'slideOutLeft':
        opacity *= 1 - px;
        transforms.push(`translateX(${(-px * 48).toFixed(2)}px)`);
        break;
      case 'slideOutRight':
        opacity *= 1 - px;
        transforms.push(`translateX(${(px * 48).toFixed(2)}px)`);
        break;
      case 'slideOutUp':
        opacity *= 1 - px;
        transforms.push(`translateY(${(-px * 40).toFixed(2)}px)`);
        break;
      case 'slideOutDown':
        opacity *= 1 - px;
        transforms.push(`translateY(${(px * 40).toFixed(2)}px)`);
        break;
      case 'scaleOut':
        opacity *= 1 - px;
        transforms.push(`scale(${(1 - px * 0.28).toFixed(4)})`);
        break;
      case 'bounceOut': {
        // 先小幅回拉（anticipation）再弹出
        const a = Math.min(1, px / 0.3);
        const b = Math.max(0, (px - 0.3) / 0.7);
        opacity *= 1 - b;
        transforms.push(`scale(${((1 + a * 0.08) * (1 - b * 0.42)).toFixed(4)})`);
        break;
      }
      default:
        break;
    }
  }

  /* ---- 循环（入场完成后、出场开始前） ---- */
  if (frame >= enterFrames && frame <= exitStart) {
    if (loop === 'pulse') {
      transforms.push(`scale(${(1 + Math.sin(frame / 12) * 0.035).toFixed(4)})`);
    } else if (loop === 'float') {
      transforms.push(`translateY(${(Math.sin(frame / 18) * 6).toFixed(2)}px)`);
    } else if (loop === 'flicker') {
      opacity *= Math.sin(frame * 2.3) * Math.sin(frame * 0.7 + 1.3) > -0.2 ? 1 : 0.45;
    }
  }

  /* ---- 打字机：逐字揭示，铺满入场到出场之间 ---- */
  let visibleChars: number | null = null;
  if (loop === 'typewriter' && totalChars > 0) {
    const window = Math.max(1, exitStart - Math.min(enterFrames, 8));
    visibleChars = Math.max(0, Math.min(totalChars, Math.floor((frame / window) * totalChars)));
  }

  return { opacity: Math.max(0, Math.min(1, opacity)), transforms, visibleChars };
}

export function TextOverlay({
  overlay,
  zIndex,
  durationFrames,
}: {
  overlay: OverlayItem;
  zIndex: number;
  durationFrames: number;
}) {
  const t = overlay.textData;
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!t) return null;
  const motion = resolveOverlayMotion(overlay);
  // resolveOverlayMotion 把 typewriter 归一为 none（媒体 overlay 不支持），文字层从 textData 直读
  const loop: TextLoopAnimation = t.animation?.loop === 'typewriter' ? 'typewriter' : motion.loop;
  const totalChars = loop === 'typewriter' ? Array.from(t.content ?? '').length : 0;
  const tm = resolveTextMotionFrame(motion, loop, frame, durationFrames, fps, t.opacity ?? 1, totalChars);
  const transforms = [...(t.rotation ? [`rotate(${t.rotation}deg)`] : []), ...tm.transforms];
  const content = tm.visibleChars != null ? Array.from(t.content ?? '').slice(0, tm.visibleChars).join('') : t.content;
  const motionStyle: CSSProperties = {
    opacity: tm.opacity,
    transform: transforms.length > 0 ? transforms.join(' ') : undefined,
  };
  return (
    <div
      style={{
        position: 'absolute',
        left: overlay.position.x,
        top: overlay.position.y,
        width: overlay.position.width,
        height: overlay.position.height,
        zIndex,
        display: 'flex',
        alignItems: 'center',
        justifyContent:
          t.textAlign === 'center' ? 'center' : t.textAlign === 'right' ? 'flex-end' : 'flex-start',
        fontFamily: t.fontFamily,
        fontSize: t.fontSize,
        color: t.fontColor,
        fontWeight: t.bold ? 700 : 400,
        fontStyle: t.italic ? 'italic' : 'normal',
        textDecoration: t.underline ? 'underline' : 'none',
        textAlign: t.textAlign,
        backgroundColor: t.backgroundColor,
        WebkitTextStroke: t.strokeWidth > 0 ? `${t.strokeWidth}px ${t.strokeColor}` : undefined,
        textShadow:
          t.shadowBlur > 0 || t.shadowOffsetX !== 0 || t.shadowOffsetY !== 0
            ? `${t.shadowOffsetX}px ${t.shadowOffsetY}px ${t.shadowBlur}px ${t.shadowColor}`
            : undefined,
        letterSpacing: t.letterSpacing,
        lineHeight: t.lineHeight,
        ...motionStyle,
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap',
      }}
    >
      {content}
    </div>
  );
}
