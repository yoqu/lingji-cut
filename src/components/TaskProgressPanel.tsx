import { useState } from 'react';
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
    >
      {copied ? '已复制' : '复制'}
    </button>
  );
}

const CATEGORY_ICONS: Record<TaskCategory, string> = {
  'ai-write': '🤖',
  'ai-review': '🔍',
  'ai-analyze': '🧠',
  'import': '📥',
  'export': '🎬',
  'tts': '🎙️',
  'cover': '🖼️',
  'io': '📁',
  'publish': '📤',
};

const CATEGORY_COLORS: Record<TaskCategory, string> = {
  'ai-write': '#a78bfa',
  'ai-review': '#34d399',
  'ai-analyze': '#60a5fa',
  'import': '#fbbf24',
  'export': '#0A84FF',
  'tts': '#f472b6',
  'cover': '#c084fc',
  'io': '#9ca3af',
  'publish': '#64d2ff',
};

/** 任务对应的观测入口：存在 agent 观测会话（feedId=任务 id）时显示「查看过程」。 */
function ObserveButton({ taskId }: { taskId: string }) {
  const hasFeed = useAgentFeedStore((s) => hasFeedSessions(s.sessions, taskId));
  const openPanel = useAgentFeedStore((s) => s.openPanel);
  if (!hasFeed) return null;
  return (
    <button
      className={styles.actionBtn}
      onClick={() => openPanel(taskId)}
      title="查看 agent 生成过程"
    >
      查看过程
    </button>
  );
}

function TaskRow({ task }: { task: TaskProgressItem }) {
  const removeTask = useTaskProgressStore((s) => s.removeTask);
  const icon = CATEGORY_ICONS[task.category] ?? '📁';
  const color = CATEGORY_COLORS[task.category] ?? '#9ca3af';

  const barColor =
    task.status === 'completed'
      ? 'var(--color-success, #32D74B)'
      : task.status === 'error'
        ? 'var(--color-danger, #FF453A)'
        : color;

  const barWidth = task.status === 'completed' ? 100 : task.progress;

  return (
    <div className={styles.taskRow}>
      <span className={styles.taskIcon}>{
        task.status === 'completed' ? '✅' : task.status === 'error' ? '❌' : icon
      }</span>
      <span className={styles.taskLabel}>{task.label}{task.status === 'completed' ? ' 完成' : ''}</span>

      {task.status === 'error' && task.error && (
        <span className={styles.errorText} title={task.error}>{task.error}</span>
      )}
      {task.status === 'active' && task.phase && (
        <span className={styles.taskPhase}>{task.phase}</span>
      )}

      <Progress
        value={barWidth}
        size="sm"
        variant={
          task.status === 'completed' ? 'success'
            : task.status === 'error' ? 'danger'
            : 'default'
        }
        indeterminate={task.status === 'active' && task.mode !== 'determinate'}
        className={styles.taskBar}
      />

      {task.status === 'active' && task.mode === 'determinate' && (
        <span className={styles.taskPct}>{task.progress}%</span>
      )}
      {task.status !== 'active' && <span className={styles.taskPct} />}

      <ObserveButton taskId={task.id} />
      {task.status === 'active' && task.canCancel && task.onCancel && (
        <button className={styles.cancelBtn} onClick={task.onCancel} title="取消">⏹</button>
      )}
      {task.status === 'completed' && task.completionAction && (
        <button className={styles.actionBtn} onClick={task.completionAction.handler}>
          {task.completionAction.label}
        </button>
      )}
      {task.status === 'error' && <CopyErrorButton task={task} />}
      {task.status === 'error' && (
        <button className={styles.actionBtn} onClick={() => removeTask(task.id)}>关闭</button>
      )}
    </div>
  );
}

function CardChildRow({ task }: { task: TaskProgressItem }) {
  const dot =
    task.status === 'completed' ? '✓'
      : task.status === 'error' ? '✗'
      : '◉';
  const dotClass =
    task.status === 'completed' ? styles.childDotDone
      : task.status === 'error' ? styles.childDotError
      : styles.childDotActive;
  return (
    <div className={styles.childRow}>
      <span className={`${styles.childDot} ${dotClass}`}>{dot}</span>
      <span className={styles.childLabel}>{task.label}</span>
      {task.status === 'active' && task.phase && (
        <span className={styles.taskPhase}>{task.phase}</span>
      )}
      {task.status === 'error' && task.error && (
        <span className={styles.errorText} title={task.error}>{task.error}</span>
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
      <div className={styles.panel}>
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
