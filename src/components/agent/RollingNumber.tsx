/**
 * 行数变更动画 —— odometer 风格的"数字往上翻"，仅在数字真的发生变化时才滚一次。
 *
 * 设计动机：编辑文件 / 文件变更块的 +N / -M 出现时，希望视觉是"从旧值滚到新值"，
 * 而不是直接闪一个静态数字。但要避免每次 mount 都从 0 重滚——历史对话回显
 * （reload 后从 DB 重新挂载、AssistantMessage.memo 重新渲染）会让人看到
 * "每条历史都在重滚"，且 RAF 异步导致首帧卡在 0、看起来像数字消失。
 *
 * 语义：
 *  - mount 时直接显示 value（不滚）。
 *  - props value 后续变化 → strip 渲染 min(prev, value)..max(prev, value)，
 *    transform 从 prev 位置过渡到 value 位置，一次性"翻牌"。
 *  - prefers-reduced-motion / value 极大 / strip 长度超过上限 → 静态展示，不滚。
 *
 * 这正好覆盖流式场景（数字随 LLM 推进持续变大），同时不会污染历史回显。
 */

import { useEffect, useRef, useState } from 'react';
import styles from './AgentTranscript.module.css';

interface RollingNumberProps {
  value: number;
  /** 动画时长（ms），默认 600ms。 */
  durationMs?: number;
  /** 当 strip 区间长度超过该上限时退化为静态展示（避免 DOM 过长）。 */
  stripLimit?: number;
  /** 可选的 className，附加到外层 span。 */
  className?: string;
  /** 可选的 a11y label 前缀，例如 "+" / "-"，仅作用于 aria-label。 */
  prefix?: string;
}

interface RollingMotion {
  from: number;
  to: number;
  animate: boolean;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function floor(n: number): number {
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function RollingNumber({
  value,
  durationMs = 600,
  stripLimit = 200,
  className,
  prefix,
}: RollingNumberProps) {
  const initialValue = floor(value);
  const previousTargetRef = useRef(initialValue);
  const [motion, setMotion] = useState<RollingMotion>(() => ({
    from: initialValue,
    to: initialValue,
    animate: false,
  }));

  useEffect(() => {
    const target = floor(value);
    const previous = previousTargetRef.current;
    if (target === previous) return;
    previousTargetRef.current = target;
    setMotion({ from: previous, to: target, animate: true });

    const timer = window.setTimeout(() => {
      setMotion((current) => current.to === target
        ? { from: target, to: target, animate: false }
        : current);
    }, durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs, value]);

  const target = floor(value);
  const ariaLabel = `${prefix ?? ''}${target}`;

  const reducedMotion = prefersReducedMotion();

  // strip 范围：从 min(prev, display) 到 max(prev, display)。
  // 没有变化（首次 / 历史回显）时 strip 只含一个元素，等同于静态展示。
  const lower = Math.min(motion.from, motion.to);
  const upper = Math.max(motion.from, motion.to);
  const stripSpan = upper - lower + 1;

  // 退化路径：用户禁用动画、或 strip 范围太大 → 静态数字，避免 DOM 爆炸。
  if (reducedMotion || stripSpan > stripLimit) {
    return (
      <span className={`${styles.rollingNumber} ${className ?? ''}`} aria-label={ariaLabel}>
        <span className={styles.rollingNumberStatic}>{target}</span>
      </span>
    );
  }

  // strip 内偏移：从 lower 开始数，displayValue 对应的 cell 在 displayValue - lower 位置。
  // transform 把 strip 上移到这个位置。
  const displayOffset = motion.to - lower;
  const items: number[] = [];
  for (let i = lower; i <= upper; i += 1) items.push(i);

  return (
    <span className={`${styles.rollingNumber} ${className ?? ''}`} aria-label={ariaLabel}>
      <span
        className={styles.rollingNumberStrip}
        style={{
          transform: `translateY(${-displayOffset * 100}%)`,
          transitionDuration: motion.animate ? `${durationMs}ms` : '0ms',
        }}
      >
        {items.map((n) => (
          <span key={n} className={styles.rollingNumberCell}>
            {n}
          </span>
        ))}
      </span>
    </span>
  );
}
