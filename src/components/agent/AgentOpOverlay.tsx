import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, LoaderCircle } from 'lucide-react';
import {
  toActivity,
  displayDurationMs,
  type AgentActivity,
} from '../../lib/agent-op-feedback';
import type { ControlOpEvent } from '../../lib/electron-api';
import styles from './AgentOpOverlay.module.css';

export interface AgentOpOverlayProps {
  /** 事件订阅入口；默认接控制服务广播（测试可注入） */
  subscribe?: (cb: (ev: ControlOpEvent) => void) => () => void;
}

/**
 * 控制服务触发操作时，在状态栏上方显示克制的全局状态提示。
 * 长任务提交后交接给统一任务进度，不再用虚拟鼠标或目标区光环抢占焦点。
 */
export function AgentOpOverlay({ subscribe }: AgentOpOverlayProps) {
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const sub = subscribe ?? window.electronAPI?.onControlOpEvent;
    if (!sub) return;
    const unsub = sub((ev) => {
      const activity = toActivity(ev);
      setActivity(activity);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setActivity(null), displayDurationMs(activity));
    });
    return () => {
      unsub();
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [subscribe]);

  if (!activity) return null;

  const StatusIcon = activity.phase === 'start'
    ? LoaderCircle
    : activity.phase === 'success'
      ? Check
      : CircleAlert;
  const chipText =
    activity.phase === 'error'
      ? `${activity.label} 失败${activity.error ? `：${activity.error}` : ''}`
      : activity.task && activity.phase === 'success'
        ? `${activity.label} · 已提交，进度见底部`
        : activity.label;

  return (
    <div className={styles.overlay} data-testid="agent-op-overlay" role="status" aria-live="polite">
      <span
        className={`${styles.chip} ${
          activity.phase === 'success' ? styles.chipSuccess : activity.phase === 'error' ? styles.chipError : ''
        }`}
        data-testid="agent-op-chip"
      >
        <StatusIcon
          className={`${styles.chipIcon} ${activity.phase === 'start' ? styles.chipIconActive : ''}`}
          size={14}
          aria-hidden="true"
        />
        <span className={styles.chipText}>{chipText}</span>
      </span>
    </div>
  );
}
