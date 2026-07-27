import type { CSSProperties } from 'react';
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { SubtitleHighlight, SubtitleStyle } from '../../types';
import type { VisualStylePreset } from '../../types/ai';
import type { RenderableSubtitle } from '../timeline-to-sequences';
import { filterValidSubtitleHighlights } from '../../lib/subtitle-highlights';
import { resolveSubtitleStyle } from '../../lib/subtitle-style-presets';

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

// 字幕本体进场帧数：fade-rise = 8 帧 opacity 0→1、Y +10→0；fade 复用同一时长只做透明度
const ENTER_FRAMES = 8;
// 字幕本体出场：最后 5 帧 opacity →0（exitFade 开启时）
const EXIT_FRAMES = 5;

/**
 * 高亮块的入场动效样式（纯函数，帧驱动可测试）：
 * pop = 高亮块缩放回弹入场；wipe = 色块自左向右扫过；none = 静态。
 * frame 以字幕条目出现为 0（外层 Sequence from = 条目起始帧）。
 */
export function highlightMotionSpanStyle(
  animation: SubtitleStyle['highlightAnimation'],
  frame: number,
  fps: number,
  backgroundColor: string,
): CSSProperties {
  if (animation === 'pop') {
    const s = spring({ frame, fps, config: { damping: 11, stiffness: 220, mass: 0.7 }, durationInFrames: 14 });
    const p = Math.max(0, Math.min(1.15, s));
    return {
      display: 'inline-block',
      opacity: Math.min(1, p * 1.6),
      transform: `scale(${(0.55 + p * 0.45).toFixed(4)})`,
      transformOrigin: 'center bottom',
    };
  }
  if (animation === 'wipe') {
    const p = interpolate(frame, [1, 13], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
    return {
      backgroundColor: 'transparent',
      backgroundImage: `linear-gradient(${backgroundColor}, ${backgroundColor})`,
      backgroundRepeat: 'no-repeat',
      backgroundSize: `${(p * 100).toFixed(1)}% 100%`,
    };
  }
  return {};
}

export function SubtitleLayer({
  cue,
  style,
  highlights,
  theme,
}: {
  cue: RenderableSubtitle;
  style: SubtitleStyle;
  highlights: SubtitleHighlight[];
  /** 项目视觉主题；style.followTheme 开启时字体与高亮 accent 由其派生。 */
  theme?: VisualStylePreset;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const resolved = resolveSubtitleStyle(style, theme);
  const pos: CSSProperties =
    resolved.position === 'top'
      ? { top: 60 }
      : resolved.position === 'center'
        ? { top: '50%', transform: 'translateY(-50%)' }
        : { bottom: 64 };

  const valid = filterValidSubtitleHighlights(
    [{ index: cue.index, startMs: 0, endMs: 0, text: cue.text }],
    highlights,
  )[0];

  // ── 字幕本体进出场（帧以条目出现为 0；cut 保持硬切旧行为）──
  // 极短条目（≤2 帧）跳过动效直接显示，避免淡入窗口比条目还长导致整条不可见。
  const enterAnimation = resolved.enterAnimation ?? 'cut';
  const enterEnd = Math.max(1, Math.min(ENTER_FRAMES, cue.durationFrames - 1));
  const enterOpacity =
    enterAnimation === 'cut' || cue.durationFrames <= 2
      ? 1
      : interpolate(frame, [0, enterEnd], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const riseY =
    enterAnimation === 'fade-rise' && cue.durationFrames > 2
      ? interpolate(frame, [0, enterEnd], [10, 0], { ...CLAMP, easing: Easing.out(Easing.cubic) })
      : 0;
  const exitOpacity =
    resolved.exitFade && cue.durationFrames > EXIT_FRAMES
      ? interpolate(
          frame,
          [cue.durationFrames - EXIT_FRAMES, cue.durationFrames - 1],
          [1, 0],
          CLAMP,
        )
      : 1;
  const bodyOpacity = Math.min(enterOpacity, exitOpacity);

  const motionSpan = highlightMotionSpanStyle(
    resolved.highlightAnimation,
    frame,
    fps,
    resolved.highlightBackgroundColor,
  );

  // 文字变色高亮：色块动效（pop/wipe）退化为透明度淡入，时序与 wipe 一致
  const textHighlightOpacity =
    resolved.highlightAnimation === 'none'
      ? 1
      : interpolate(frame, [1, 13], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });

  const content =
    valid && resolved.highlightEnabled ? (
      <>
        {cue.text.slice(0, valid.start)}
        {resolved.highlightVariant === 'text' ? (
          <span
            style={{
              color: resolved.highlightBackgroundColor,
              fontWeight: 650,
              opacity: textHighlightOpacity,
            }}
          >
            {cue.text.slice(valid.start, valid.end)}
          </span>
        ) : (
          <span
            style={{
              padding: `${resolved.highlightPaddingY}px ${resolved.highlightPaddingX}px`,
              borderRadius: resolved.highlightRadius,
              background: resolved.highlightBackgroundColor,
              color: resolved.highlightTextColor,
              boxShadow: '0 2px 8px rgba(0,0,0,.22)',
              ...motionSpan,
            }}
          >
            {cue.text.slice(valid.start, valid.end)}
          </span>
        )}
        {cue.text.slice(valid.end)}
      </>
    ) : (
      cue.text
    );

  const backdropEnabled = resolved.backdropEnabled ?? false;

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        zIndex: 1000,
        textAlign: 'center',
        padding: '0 80px',
        boxSizing: 'border-box',
        pointerEvents: 'none',
        ...pos,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          maxWidth: '100%',
          opacity: bodyOpacity,
          transform: riseY !== 0 ? `translateY(${riseY.toFixed(2)}px)` : undefined,
          // 圆角 pill 背板：柔和投影，开启时替代 textShadow 避免脏边
          ...(backdropEnabled
            ? {
                background: resolved.backdropColor,
                borderRadius: resolved.backdropRadius,
                padding: `${resolved.backdropPaddingY}px ${resolved.backdropPaddingX}px`,
                boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
              }
            : {}),
        }}
      >
        <span
          style={{
            fontSize: resolved.fontSize,
            color: resolved.color,
            fontFamily: resolved.fontFamily,
            fontWeight: resolved.fontWeight,
            letterSpacing: resolved.letterSpacing,
            lineHeight: 1.42,
            textShadow: backdropEnabled ? 'none' : '0 1px 6px rgba(0,0,0,.5)',
            whiteSpace: 'pre-line',
            display: 'inline-block',
            maxWidth: '100%',
          }}
        >
          {content}
        </span>
      </span>
    </div>
  );
}
