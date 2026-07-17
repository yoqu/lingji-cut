import { describe, it, expect, beforeEach } from 'vitest';
import { useTaskProgressStore } from '../src/store/task-progress';

function reset() {
  useTaskProgressStore.setState({
    tasks: new Map(),
    panelOpen: false,
    primaryTask: null,
    activeCount: 0,
  });
}

const base = {
  category: 'ai-analyze' as const,
  label: 'x',
  mode: 'determinate' as const,
  progress: 0,
  phase: null,
  level: 0 as const,
  canCancel: false,
};

describe('task-progress 父子模型', () => {
  beforeEach(reset);

  it('子任务不参与 primaryTask 选取', () => {
    const s = useTaskProgressStore.getState();
    s.startTask({ ...base, id: 'parent' });
    s.startChildTask('parent', { ...base, id: 'parent::card::0', label: '卡片#1' });
    expect(useTaskProgressStore.getState().primaryTask?.id).toBe('parent');
  });

  it('activeCount 只数顶层活动任务', () => {
    const s = useTaskProgressStore.getState();
    s.startTask({ ...base, id: 'parent' });
    s.startChildTask('parent', { ...base, id: 'parent::card::0' });
    s.startChildTask('parent', { ...base, id: 'parent::card::1' });
    expect(useTaskProgressStore.getState().activeCount).toBe(1);
  });

  it('父任务 completeTask 级联收尾活动子任务', () => {
    const s = useTaskProgressStore.getState();
    s.startTask({ ...base, id: 'parent' });
    s.startChildTask('parent', { ...base, id: 'parent::card::0' });
    s.completeTask('parent');
    const tasks = useTaskProgressStore.getState().tasks;
    expect(tasks.get('parent')!.status).toBe('completed');
    expect(tasks.get('parent::card::0')!.status).toBe('completed');
  });

  it('父任务 failTask 把活动子任务标记 error、保留已成功子任务', () => {
    const s = useTaskProgressStore.getState();
    s.startTask({ ...base, id: 'parent' });
    s.startChildTask('parent', { ...base, id: 'parent::card::0' });
    s.startChildTask('parent', { ...base, id: 'parent::card::1' });
    s.completeTask('parent::card::0');
    s.failTask('parent', 'boom');
    const tasks = useTaskProgressStore.getState().tasks;
    expect(tasks.get('parent::card::0')!.status).toBe('completed');
    expect(tasks.get('parent::card::1')!.status).toBe('error');
  });

  it('父任务 cancelTask 中性取消活动子任务、保留已成功子任务', () => {
    const s = useTaskProgressStore.getState();
    s.startTask({ ...base, id: 'parent' });
    s.startChildTask('parent', { ...base, id: 'parent::card::0' });
    s.startChildTask('parent', { ...base, id: 'parent::card::1' });
    s.completeTask('parent::card::0');
    s.cancelTask('parent', '用户停止');

    const state = useTaskProgressStore.getState();
    expect(state.tasks.get('parent')).toMatchObject({
      status: 'cancelled',
      cancelReason: '用户停止',
    });
    expect(state.tasks.get('parent::card::0')!.status).toBe('completed');
    expect(state.tasks.get('parent::card::1')).toMatchObject({
      status: 'cancelled',
      cancelReason: '用户停止',
    });
    expect(state.activeCount).toBe(0);
  });

  it('removeTask 父任务连带移除子任务', () => {
    const s = useTaskProgressStore.getState();
    s.startTask({ ...base, id: 'parent' });
    s.startChildTask('parent', { ...base, id: 'parent::card::0' });
    s.removeTask('parent');
    const tasks = useTaskProgressStore.getState().tasks;
    expect(tasks.has('parent')).toBe(false);
    expect(tasks.has('parent::card::0')).toBe(false);
  });
});
