/**
 * StatusBarProgressLine — AppStatusBar 顶部 2px 统一进度条
 *
 * Hero ④:width 动画改由 framer-motion 的 MotionValue 驱动,
 * 进度变化不再触发 React re-render。
 *
 * 关键点:
 * 1. 只 select primaryTask 的 identity 字段(mode / status),
 *    progress 不进 React state,避免每次 updateTask 都重渲染整个 AppStatusBar 子树。
 * 2. useEffect 内订阅 store,把最新进度写入 MotionValue,由 LazyMotion (m.div) 直接消费。
 * 3. 宽度通过 useProgressWidth 把 0~1 范围 MotionValue 映射为 "0%"~"100%",
 *    底层走 useSpring 做 60fps 平滑过渡,完全脱离 React tree。
 * 4. indeterminate / streaming 模式继续由 CSS 关键帧动画驱动(CSS 里 width 被 !important 覆盖)。
 *
 * 活跃任务统一使用系统蓝，任务类型不再改变交互色。
 */

import { useEffect } from 'react';
import { m, useMotionValue } from 'framer-motion';
import { useTaskProgressStore } from '../store/task-progress';
import { useProgressWidth } from '../ui/lib/motion/hooks';
import styles from './AppStatusBar.module.css';

export function StatusBarProgressLine() {
  // 仅 select 低频变化字段;progress 不进入 React state
  const visible = useTaskProgressStore(
    (state) => !!state.primaryTask && state.primaryTask.status === 'active',
  );
  const mode = useTaskProgressStore((state) => state.primaryTask?.mode ?? null);

  // MotionValue:raw 存 0~1 进度,由 store 订阅驱动;useProgressWidth 内部用 useTransform 平滑转字符串
  const raw = useMotionValue(0);
  const width = useProgressWidth(raw);

  // 订阅 store,进度写入 MotionValue。这里不走 React re-render 路径。
  useEffect(() => {
    // 初始化:立即同步一次当前进度
    const current = useTaskProgressStore.getState().primaryTask;
    if (current && current.status === 'active' && current.mode === 'determinate') {
      raw.set(Math.max(0, Math.min(100, current.progress)) / 100);
    }

    const unsubscribe = useTaskProgressStore.subscribe((state) => {
      const task = state.primaryTask;
      if (!task || task.status !== 'active') return;
      if (task.mode !== 'determinate') return;
      const normalized = Math.max(0, Math.min(100, task.progress)) / 100;
      raw.set(normalized);
    });

    return unsubscribe;
  }, [raw]);

  if (!visible || !mode) {
    return null;
  }

  const isDeterminate = mode === 'determinate';

  return (
    <div className={styles.progressLine} aria-hidden="true">
      <m.div
        className={styles.progressFillLine}
        data-mode={mode}
        // determinate:width 由 MotionValue 驱动;其他模式由 CSS 关键帧接管(CSS 中 width 被 !important 覆盖)
        style={{
          width: isDeterminate ? width : undefined,
        }}
      />
    </div>
  );
}
