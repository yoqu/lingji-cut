/**
 * 任务系统通知桥：订阅底部统一任务进度（task-progress store），在耗时顶层任务
 * 完成 / 失败时弹出系统通知（mac 通知中心 / Windows 通知），提醒用户回到软件。
 *
 * 背景：耗时任务（导出 / TTS / 导入 / AI 分析 / 封面 / 卡片）跑在后台时，用户切走
 * 就看不到底部进度条，无法及时进行下一步。本桥只把「active → completed/error」的状态
 * 跃迁映射为一次系统通知；用户主动取消属于中性终态，不发送系统通知。
 */

import { useTaskProgressStore, type TaskProgressItem } from '../store/task-progress';

/** 低于此时长的瞬时任务（如小型 IO 保存）不通知，只提醒真正耗时的操作。 */
export const NOTIFY_MIN_DURATION_MS = 1500;

export interface TaskNotificationPayload {
  title: string;
  body: string;
}

/** 判断一个任务的状态跃迁是否应触发系统通知。 */
export function shouldNotifyTask(
  task: TaskProgressItem,
  before: TaskProgressItem | undefined,
  now: number,
): boolean {
  if (task.parentId) return false; // 仅顶层任务，子步骤不单独通知
  const settled = task.status === 'completed' || task.status === 'error';
  if (!settled) return false;
  const wasActive = !before || before.status === 'active';
  if (!wasActive) return false; // 仅 active → settled 的那一次跃迁
  const duration = (task.completedAt ?? now) - task.startedAt;
  return duration >= NOTIFY_MIN_DURATION_MS;
}

/** 根据可通知的终态生成通知文案，活动或取消状态不产生通知。 */
export function buildTaskNotification(task: TaskProgressItem): TaskNotificationPayload | null {
  if (task.status === 'error') {
    return {
      title: `${task.label}失败`,
      body: task.error?.trim() || '任务执行失败，点此回到灵机剪影查看。',
    };
  }
  if (task.status === 'completed') {
    return {
      title: `${task.label}已完成`,
      body: '任务已完成，点此回到灵机剪影继续下一步。',
    };
  }
  return null;
}

/**
 * 挂载任务通知桥，返回取消订阅函数。需在 Electron 环境（window.electronAPI 可用）下调用。
 */
export function attachTaskNotificationBridge(): () => void {
  const notify = window.electronAPI?.showSystemNotification;
  if (!notify) return () => {};

  return useTaskProgressStore.subscribe((state, prev) => {
    const now = Date.now();
    for (const [id, task] of state.tasks) {
      if (shouldNotifyTask(task, prev.tasks.get(id), now)) {
        const notification = buildTaskNotification(task);
        if (notification) notify(notification);
      }
    }
  });
}
