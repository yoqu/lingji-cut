import {
  Ban,
  CheckCircle2,
  Circle,
  CircleAlert,
  Download,
  FilePenLine,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Mic,
  Search,
  Sparkles,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import { useTaskProgressStore } from '../store/task-progress';
import type { TaskCategory, TaskProgressItem } from '../store/task-progress';
import { Progress } from '../ui';
import styles from './AppStatusBar.module.css';

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

export function getTaskSummary(task: TaskProgressItem): { Icon: LucideIcon; label: string } {
  if (task.status === 'completed') {
    return { Icon: CheckCircle2, label: `${task.label} 已完成` };
  }
  if (task.status === 'error') {
    return { Icon: CircleAlert, label: `${task.label} 失败` };
  }
  if (task.status === 'cancelled') {
    return { Icon: Ban, label: `${task.label} 已取消` };
  }
  return { Icon: CATEGORY_ICONS[task.category] ?? Circle, label: task.label };
}

export function StatusBarTaskSummary() {
  const primaryTask = useTaskProgressStore((s) => s.primaryTask);
  const activeCount = useTaskProgressStore((s) => s.activeCount);
  const panelOpen = useTaskProgressStore((s) => s.panelOpen);
  const setPanelOpen = useTaskProgressStore((s) => s.setPanelOpen);

  if (!primaryTask) return null;

  const isActive = primaryTask.status === 'active';
  const isIndeterminate = isActive && primaryTask.mode !== 'determinate';
  const { Icon, label } = getTaskSummary(primaryTask);
  const additionalCount = isActive ? activeCount - 1 : 0;

  return (
    <button
      type="button"
      className={styles.taskSummary}
      data-status={primaryTask.status}
      onClick={() => setPanelOpen(!panelOpen)}
      title="点击查看任务详情"
      aria-expanded={panelOpen}
      aria-controls="task-progress-panel"
    >
      <Icon className={styles.taskSummaryIcon} aria-hidden="true" />
      <span className={styles.taskSummaryLabel}>{label}</span>
      {isActive && (
        <Progress
          value={primaryTask.progress}
          size="sm"
          variant="default"
          indeterminate={isIndeterminate}
          className={styles.taskSummaryProgress}
        />
      )}
      {isActive && primaryTask.mode === 'determinate' && (
        <span className={styles.taskSummaryPercent}>
          {primaryTask.progress}%
        </span>
      )}
      {additionalCount > 0 && (
        <span className={styles.taskSummaryCount}>+{additionalCount}</span>
      )}
    </button>
  );
}
