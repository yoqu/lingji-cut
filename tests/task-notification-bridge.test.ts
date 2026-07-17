import { describe, expect, it } from 'vitest';
import type { TaskProgressItem } from '../src/store/task-progress';
import {
  NOTIFY_MIN_DURATION_MS,
  buildTaskNotification,
  shouldNotifyTask,
} from '../src/lib/task-notification-bridge';

function makeTask(overrides: Partial<TaskProgressItem> = {}): TaskProgressItem {
  return {
    id: 't1',
    category: 'export',
    label: '视频导出',
    mode: 'determinate',
    progress: 100,
    phase: null,
    level: 0,
    canCancel: false,
    startedAt: 0,
    completedAt: NOTIFY_MIN_DURATION_MS + 500,
    status: 'completed',
    ...overrides,
  };
}

const now = NOTIFY_MIN_DURATION_MS + 1000;

describe('shouldNotifyTask', () => {
  it('耗时顶层任务 active → completed 触发通知', () => {
    const task = makeTask();
    const before = makeTask({ status: 'active', completedAt: undefined, progress: 40 });
    expect(shouldNotifyTask(task, before, now)).toBe(true);
  });

  it('active → error 也触发通知', () => {
    const task = makeTask({ status: 'error', error: '渲染失败' });
    const before = makeTask({ status: 'active', completedAt: undefined });
    expect(shouldNotifyTask(task, before, now)).toBe(true);
  });

  it('首次出现即为完成态（无 before）也触发', () => {
    expect(shouldNotifyTask(makeTask(), undefined, now)).toBe(true);
  });

  it('子任务不通知', () => {
    const task = makeTask({ parentId: 'p1' });
    expect(shouldNotifyTask(task, undefined, now)).toBe(false);
  });

  it('仍 active 不通知', () => {
    const task = makeTask({ status: 'active', completedAt: undefined });
    expect(shouldNotifyTask(task, undefined, now)).toBe(false);
  });

  it('active → cancelled 不触发成功或失败通知', () => {
    const task = makeTask({ status: 'cancelled', cancelReason: '用户停止' });
    const before = makeTask({ status: 'active', completedAt: undefined });
    expect(shouldNotifyTask(task, before, now)).toBe(false);
    expect(buildTaskNotification(task)).toBeNull();
  });

  it('已完成态再次 patch（before 非 active）不重复通知', () => {
    const task = makeTask();
    const before = makeTask(); // 已经是 completed
    expect(shouldNotifyTask(task, before, now)).toBe(false);
  });

  it('瞬时任务（时长低于阈值）不通知', () => {
    const task = makeTask({ startedAt: 0, completedAt: NOTIFY_MIN_DURATION_MS - 1 });
    const before = makeTask({ status: 'active', completedAt: undefined });
    expect(shouldNotifyTask(task, before, now)).toBe(false);
  });

  it('无 completedAt 时用 now 估算时长', () => {
    const task = makeTask({ completedAt: undefined, startedAt: now - NOTIFY_MIN_DURATION_MS });
    const before = makeTask({ status: 'active', completedAt: undefined });
    expect(shouldNotifyTask(task, before, now)).toBe(true);
  });
});

describe('buildTaskNotification', () => {
  it('完成态文案包含标签', () => {
    const notification = buildTaskNotification(makeTask());
    expect(notification).not.toBeNull();
    const { title, body } = notification!;
    expect(title).toContain('视频导出');
    expect(title).toContain('已完成');
    expect(title).not.toMatch(/[✅⚠️]/u);
    expect(body).toContain('继续下一步');
  });

  it('失败态展示错误信息', () => {
    const notification = buildTaskNotification(makeTask({ status: 'error', error: '磁盘已满' }));
    expect(notification).not.toBeNull();
    const { title, body } = notification!;
    expect(title).toContain('失败');
    expect(body).toBe('磁盘已满');
  });

  it('失败态无错误信息时给默认文案', () => {
    const notification = buildTaskNotification(makeTask({ status: 'error', error: undefined }));
    expect(notification).not.toBeNull();
    const { body } = notification!;
    expect(body).toContain('回到灵机剪影');
  });
});
