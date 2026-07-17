import { useState } from 'react';
import {
  Ban,
  Check,
  CheckCircle2,
  Circle,
  CircleAlert,
  Copy,
  Download,
  Eye,
  FilePenLine,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Mic,
  Search,
  Sparkles,
  Square,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTaskProgressStore } from '../store/task-progress';
import type { TaskCategory, TaskProgressItem } from '../store/task-progress';
import { useAgentFeedStore, hasFeedSessions } from '../store/agent-feed';
import { Progress } from '../ui';
import styles from './TaskProgressPanel.module.css';

function buildErrorReport(task: TaskProgressItem): string {
  const ts = new Date(task.completedAt ?? task.startedAt);
  return [
    `任务: ${task.label}`,
    `类型: ${task.category}`,
    `时间: ${ts.toLocaleString()}`,
    '错误:',
    task.error ?? '(无详细信息)',
  ].join('\n');
}

function CopyErrorButton({ task }: { task: TaskProgressItem }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const report = buildErrorReport(task);
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      // 退化路径：clipboard API 不可用时用临时 textarea
      const ta = document.createElement('textarea');
      ta.value = report;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* noop */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      className={styles.actionBtn}
      onClick={handleCopy}
      title="复制错误详情用于排查"
      aria-label={copied ? '错误详情已复制' : '复制错误详情'}
      type="button"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

const CATEGORY_ICONS: Record<TaskCategory, LucideIcon> = {
  'ai-write': FilePenLine,
  'ai-review': Search,
  'ai-analyze': Sparkles,
  'import': Download,
  'export': Film,
  'tts': Mic,
  'cover': ImageIcon,
  'io': FolderOpen,
  'publish': Upload,
};

function getStatusIcon(task: TaskProgressItem): LucideIcon {
  if (task.status === 'completed') return CheckCircle2;
  if (task.status === 'error') return CircleAlert;
  if (task.status === 'cancelled') return Ban;
  return CATEGORY_ICONS[task.category] ?? Circle;
}

function getTaskLabel(task: TaskProgressItem): string {
  if (task.status === 'completed') return `${task.label} 已完成`;
  if (task.status === 'error') return `${task.label} 失败`;
  if (task.status === 'cancelled') return `${task.label} 已取消`;
  return task.label;
}

/** 任务对应的观测入口：存在 agent 观测会话（feedId=任务 id）时显示「查看过程」。 */
function ObserveButton({ taskId }: { taskId: string }) {
  const hasFeed = useAgentFeedStore((s) => hasFeedSessions(s.sessions, taskId));
  const openPanel = useAgentFeedStore((s) => s.openPanel);
  if (!hasFeed) return null;
  return (
    <button
      className={styles.actionBtn}
      onClick={() => openPanel(taskId)}
      title="查看生成过程"
      aria-label="查看生成过程"
      type="button"
    >
      <Eye size={12} />
    </button>
  );
}

function TaskActions({ task }: { task: TaskProgressItem }) {
  const removeTask = useTaskProgressStore((s) => s.removeTask);
  const cancelTask = useTaskProgressStore((s) => s.cancelTask);
  const handleCancel = () => {
    const interrupt = task.onCancel;
    cancelTask(task.id);
    interrupt?.();
  };

  return (
    <>
      <ObserveButton taskId={task.id} />
      {task.status === 'active' && task.canCancel && task.onCancel && (
        <button
          className={styles.cancelBtn}
          onClick={handleCancel}
          title="停止"
          aria-label={`停止${task.label}`}
          type="button"
        >
          <Square size={11} fill="currentColor" />
        </button>
      )}
      {task.status === 'completed' && task.completionAction && (
        <button className={styles.actionBtn} onClick={task.completionAction.handler} type="button">
          {task.completionAction.label}
        </button>
      )}
      {task.status === 'error' && <CopyErrorButton task={task} />}
      {task.status === 'error' && (
        <button
          className={styles.actionBtn}
          onClick={() => removeTask(task.id)}
          title="关闭"
          aria-label={`关闭${task.label}`}
          type="button"
        >
          <X size={12} />
        </button>
      )}
    </>
  );
}

function TaskRow({ task }: { task: TaskProgressItem }) {
  const StatusIcon = getStatusIcon(task);
  const barWidth = task.status === 'completed' ? 100 : task.progress;
  const taskBarClass = task.status === 'cancelled'
    ? `${styles.taskBar} ${styles.taskBarCancelled}`
    : styles.taskBar;

  return (
    <div className={styles.taskRow}>
      <StatusIcon className={styles.taskIcon} data-status={task.status} aria-hidden="true" />
      <span className={styles.taskLabel}>{getTaskLabel(task)}</span>
      {task.status === 'error' && task.error && (
        <span className={styles.errorText} title={task.error}>{task.error}</span>
      )}
      {task.status === 'cancelled' && task.cancelReason && (
        <span className={styles.cancelledText} title={task.cancelReason}>{task.cancelReason}</span>
      )}
      {task.status === 'active' && task.phase && (
        <span className={styles.taskPhase}>{task.phase}</span>
      )}
      <Progress
        value={barWidth}
        size="sm"
        variant={task.status === 'completed' ? 'success' : task.status === 'error' ? 'danger' : 'default'}
        indeterminate={task.status === 'active' && task.mode !== 'determinate'}
        className={taskBarClass}
      />
      <span className={styles.taskPct}>
        {task.status === 'active' && task.mode === 'determinate' ? `${task.progress}%` : ''}
      </span>
      <TaskActions task={task} />
    </div>
  );
}

function CardChildRow({ task }: { task: TaskProgressItem }) {
  const StatusIcon = task.status === 'completed' ? Check
    : task.status === 'error' ? X
      : task.status === 'cancelled' ? Ban
        : Circle;
  const dotClass =
    task.status === 'completed' ? styles.childDotDone
      : task.status === 'error' ? styles.childDotError
        : task.status === 'cancelled' ? styles.childDotCancelled
      : styles.childDotActive;
  return (
    <div className={styles.childRow}>
      <StatusIcon className={`${styles.childDot} ${dotClass}`} aria-hidden="true" />
      <span className={styles.childLabel}>{getTaskLabel(task)}</span>
      {task.status === 'active' && task.phase && (
        <span className={styles.taskPhase}>{task.phase}</span>
      )}
      {task.status === 'error' && task.error && (
        <span className={styles.errorText} title={task.error}>{task.error}</span>
      )}
      {task.status === 'cancelled' && task.cancelReason && (
        <span className={styles.cancelledText} title={task.cancelReason}>{task.cancelReason}</span>
      )}
      {task.status === 'error' && <CopyErrorButton task={task} />}
    </div>
  );
}

export function TaskProgressPanel() {
  const panelOpen = useTaskProgressStore((s) => s.panelOpen);
  const setPanelOpen = useTaskProgressStore((s) => s.setPanelOpen);
  const tasks = useTaskProgressStore((s) => s.tasks);

  if (!panelOpen || tasks.size === 0) return null;

  const all = Array.from(tasks.values());
  const topLevel = all
    .filter((t) => !t.parentId)
    .sort((a, b) => b.startedAt - a.startedAt);
  const childrenOf = (parentId: string) =>
    all
      .filter((t) => t.parentId === parentId)
      .sort((a, b) => a.startedAt - b.startedAt);

  return (
    <>
      <div className={styles.overlay} onClick={() => setPanelOpen(false)} />
      <div id="task-progress-panel" className={styles.panel} role="region" aria-label="任务详情">
        {topLevel.map((task) => (
          <div key={task.id}>
            <TaskRow task={task} />
            {childrenOf(task.id).map((child) => (
              <CardChildRow key={child.id} task={child} />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
