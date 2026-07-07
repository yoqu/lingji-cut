import { useEffect, useRef, useState } from 'react';
import { AgentCursor } from './AgentCursor';
import {
  toActivity,
  displayDurationMs,
  type AgentActivity,
  type AgentZone,
} from '../../lib/agent-op-feedback';
import type { ControlOpEvent } from '../../lib/electron-api';
import styles from './AgentOpOverlay.module.css';

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface OverlayState {
  activity: AgentActivity;
  cursor: { x: number; y: number };
  ring: Rect | null;
}

/** 按 zone 查找界面锚点；cover 面板复用其既有 data-ai-cover-root 标记 */
function findAnchor(zone: AgentZone): Element | null {
  const el = document.querySelector(`[data-agent-zone="${zone}"]`);
  if (el) return el;
  if (zone === 'cover') return document.querySelector('[data-ai-cover-root]');
  return document.querySelector('[data-agent-zone="status-bar"]');
}

function targetFor(zone: AgentZone): { cursor: { x: number; y: number }; ring: Rect | null } {
  const anchor = findAnchor(zone);
  if (!anchor) {
    return { cursor: { x: window.innerWidth - 80, y: window.innerHeight - 60 }, ring: null };
  }
  const r = anchor.getBoundingClientRect();
  return {
    cursor: { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 120) },
    ring: r.width > 0 && r.height > 0
      ? { left: r.left - 4, top: r.top - 4, width: r.width + 8, height: r.height + 8 }
      : null,
  };
}

export interface AgentOpOverlayProps {
  /** 事件订阅入口；默认接控制服务广播（测试可注入） */
  subscribe?: (cb: (ev: ControlOpEvent) => void) => () => void;
}

/**
 * 全局「AI 正在操作」反馈层：agent 经 CLI 触发操作时，
 * 虚拟鼠标飞向目标面板 + 目标区脉冲光环 + 操作状态标签。
 * 视觉复用统一 AI 反馈体系（AgentCursor / 绿色 #34d399）。
 */
export function AgentOpOverlay({ subscribe }: AgentOpOverlayProps) {
  const [state, setState] = useState<OverlayState | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const sub = subscribe ?? window.electronAPI?.onControlOpEvent;
    if (!sub) return;
    const unsub = sub((ev) => {
      const activity = toActivity(ev);
      // 任务型操作提交成功 → 指针交接到底部进度条
      const zone: AgentZone =
        activity.task && activity.phase === 'success' ? 'status-bar' : activity.zone;
      setState({ activity, ...targetFor(zone) });
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setState(null), displayDurationMs(activity));
    });
    return () => {
      unsub();
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [subscribe]);

  if (!state) return null;
  const { activity, cursor, ring } = state;

  const statusIcon = activity.phase === 'start' ? '⋯' : activity.phase === 'success' ? '✓' : '✕';
  const chipText =
    activity.phase === 'error'
      ? `${activity.label} 失败${activity.error ? `：${activity.error}` : ''}`
      : activity.task && activity.phase === 'success'
        ? `${activity.label} · 已提交，进度见底部`
        : activity.label;

  return (
    <div data-testid="agent-op-overlay">
      {ring && (
        <div
          className={styles.ring}
          data-zone={activity.zone}
          style={{ left: ring.left, top: ring.top, width: ring.width, height: ring.height }}
        />
      )}
      <div
        className={`${styles.cursor} ${activity.phase === 'error' ? styles.cursorError : ''}`}
        style={{ left: cursor.x, top: cursor.y }}
      >
        <AgentCursor />
        <span
          className={`${styles.chip} ${
            activity.phase === 'success' ? styles.chipSuccess : activity.phase === 'error' ? styles.chipError : ''
          }`}
          data-testid="agent-op-chip"
        >
          <span className={styles.chipIcon}>{statusIcon}</span>
          {chipText}
        </span>
      </div>
    </div>
  );
}
