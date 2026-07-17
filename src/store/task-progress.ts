import { create } from 'zustand';

export type ProgressMode = 'determinate' | 'indeterminate' | 'streaming';
export type TaskProgressStatus = 'active' | 'completed' | 'error' | 'cancelled';

export type TaskCategory =
  | 'ai-write'
  | 'ai-review'
  | 'ai-analyze'
  | 'import'
  | 'export'
  | 'tts'
  | 'cover'
  | 'io'
  | 'publish';

export interface TaskCompletionAction {
  label: string;
  handler: () => void;
}

export interface TaskProgressItem {
  id: string;
  category: TaskCategory;
  label: string;
  mode: ProgressMode;
  progress: number;
  phase: string | null;
  level: 0 | 1 | 2;
  canCancel: boolean;
  onCancel?: () => void;
  startedAt: number;
  completedAt?: number;
  status: TaskProgressStatus;
  error?: string;
  cancelReason?: string;
  completionAction?: TaskCompletionAction;
  parentId?: string;
}

type StartTaskInput = Omit<TaskProgressItem, 'startedAt' | 'status'>;
type UpdateTaskPatch = Partial<
  Pick<
    TaskProgressItem,
    'progress' | 'phase' | 'mode' | 'label' | 'category' | 'canCancel' | 'onCancel'
  >
>;

interface TaskProgressStore {
  tasks: Map<string, TaskProgressItem>;
  panelOpen: boolean;
  primaryTask: TaskProgressItem | null;
  activeCount: number;

  setPanelOpen: (open: boolean) => void;
  startTask: (task: StartTaskInput) => void;
  startChildTask: (parentId: string, task: StartTaskInput) => void;
  updateTask: (id: string, patch: UpdateTaskPatch) => void;
  completeTask: (id: string, action?: TaskCompletionAction) => void;
  failTask: (id: string, error: string) => void;
  cancelTask: (id: string, reason?: string) => void;
  removeTask: (id: string) => void;
}

function derivePrimaryTask(tasks: Map<string, TaskProgressItem>): TaskProgressItem | null {
  // 遍历时记录 index，Map 按插入顺序迭代，index 越大 = 越新插入
  let best: TaskProgressItem | null = null;
  let bestIndex = -1;
  let index = 0;
  for (const t of tasks.values()) {
    if (t.parentId) { index++; continue; }
    if (t.status === 'active') {
      if (
        !best ||
        best.status !== 'active' ||
        t.startedAt > best.startedAt ||
        (t.startedAt === best.startedAt && index > bestIndex)
      ) {
        best = t;
        bestIndex = index;
      }
    } else if (!best || best.status !== 'active') {
      const tTime = t.completedAt ?? t.startedAt;
      const bestTime = best ? (best.completedAt ?? best.startedAt) : -1;
      if (
        !best ||
        tTime > bestTime ||
        (tTime === bestTime && index > bestIndex)
      ) {
        best = t;
        bestIndex = index;
      }
    }
    index++;
  }
  return best;
}

function deriveActiveCount(tasks: Map<string, TaskProgressItem>): number {
  let count = 0;
  for (const t of tasks.values()) {
    if (t.status === 'active' && !t.parentId) count++;
  }
  return count;
}

const removalTimers = new Map<string, ReturnType<typeof setTimeout>>();
const COMPLETED_REMOVAL_DELAY_MS = 5000;
const ERROR_REMOVAL_DELAY_MS = 10000;
const CANCELLED_REMOVAL_DELAY_MS = 5000;

function scheduleRemoval(id: string, delayMs: number) {
  clearRemovalTimer(id);
  const timer = setTimeout(() => {
    removalTimers.delete(id);
    useTaskProgressStore.getState().removeTask(id);
  }, delayMs);
  removalTimers.set(id, timer);
}

function clearRemovalTimer(id: string) {
  const existing = removalTimers.get(id);
  if (existing) {
    clearTimeout(existing);
    removalTimers.delete(id);
  }
}

type SettledStatus = Exclude<TaskProgressStatus, 'active'>;

function settleTaskItem(
  task: TaskProgressItem,
  status: SettledStatus,
  completedAt: number,
  detail?: string,
  completionAction?: TaskCompletionAction,
): TaskProgressItem {
  return {
    ...task,
    status,
    progress: status === 'completed' ? 100 : task.progress,
    completedAt,
    canCancel: false,
    onCancel: undefined,
    error: status === 'error' ? detail : undefined,
    cancelReason: status === 'cancelled' ? detail : undefined,
    completionAction: status === 'completed' ? completionAction : undefined,
  };
}

function settleActiveChildren(
  tasks: Map<string, TaskProgressItem>,
  parentId: string,
  status: SettledStatus,
  completedAt: number,
  detail?: string,
): void {
  const delay = status === 'error'
    ? ERROR_REMOVAL_DELAY_MS
    : status === 'completed'
      ? COMPLETED_REMOVAL_DELAY_MS
      : CANCELLED_REMOVAL_DELAY_MS;
  for (const child of tasks.values()) {
    if (child.parentId !== parentId || child.status !== 'active') continue;
    tasks.set(child.id, settleTaskItem(child, status, completedAt, detail));
    scheduleRemoval(child.id, delay);
  }
}

export const useTaskProgressStore = create<TaskProgressStore>((set, get) => ({
  tasks: new Map(),
  panelOpen: false,
  primaryTask: null,
  activeCount: 0,

  setPanelOpen: (open) => set({ panelOpen: open }),

  startTask: (input) => {
    clearRemovalTimer(input.id);
    const task: TaskProgressItem = {
      ...input,
      startedAt: Date.now(),
      status: 'active',
    };
    const next = new Map(get().tasks);
    next.set(task.id, task);
    set({
      tasks: next,
      primaryTask: derivePrimaryTask(next),
      activeCount: deriveActiveCount(next),
    });
  },

  startChildTask: (parentId, input) => {
    get().startTask({ ...input, parentId, level: 1 });
  },

  updateTask: (id, patch) => {
    const tasks = get().tasks;
    const existing = tasks.get(id);
    if (!existing || existing.status !== 'active') return;
    const updated = { ...existing, ...patch };
    const next = new Map(tasks);
    next.set(id, updated);
    set({
      tasks: next,
      primaryTask: derivePrimaryTask(next),
    });
  },

  completeTask: (id, action) => {
    const tasks = get().tasks;
    const existing = tasks.get(id);
    if (!existing || existing.status !== 'active') return;
    const completedAt = Date.now();
    const next = new Map(tasks);
    next.set(id, settleTaskItem(existing, 'completed', completedAt, undefined, action));
    // 父任务完成：把仍 active 的子任务一并收尾
    if (!existing.parentId) {
      settleActiveChildren(next, id, 'completed', completedAt);
    }
    set({
      tasks: next,
      primaryTask: derivePrimaryTask(next),
      activeCount: deriveActiveCount(next),
    });
    scheduleRemoval(id, COMPLETED_REMOVAL_DELAY_MS);
  },

  failTask: (id, error) => {
    const tasks = get().tasks;
    const existing = tasks.get(id);
    if (!existing || existing.status !== 'active') return;
    const completedAt = Date.now();
    const next = new Map(tasks);
    next.set(id, settleTaskItem(existing, 'error', completedAt, error));
    if (!existing.parentId) {
      settleActiveChildren(next, id, 'error', completedAt, error);
    }
    set({
      tasks: next,
      primaryTask: derivePrimaryTask(next),
      activeCount: deriveActiveCount(next),
    });
    scheduleRemoval(id, ERROR_REMOVAL_DELAY_MS);
  },

  cancelTask: (id, reason) => {
    const tasks = get().tasks;
    const existing = tasks.get(id);
    if (!existing || existing.status !== 'active') return;
    const completedAt = Date.now();
    const next = new Map(tasks);
    next.set(id, settleTaskItem(existing, 'cancelled', completedAt, reason));
    if (!existing.parentId) {
      settleActiveChildren(next, id, 'cancelled', completedAt, reason);
    }
    set({
      tasks: next,
      primaryTask: derivePrimaryTask(next),
      activeCount: deriveActiveCount(next),
    });
    scheduleRemoval(id, CANCELLED_REMOVAL_DELAY_MS);
  },

  removeTask: (id) => {
    clearRemovalTimer(id);
    const next = new Map(get().tasks);
    next.delete(id);
    for (const child of [...next.values()]) {
      if (child.parentId === id) {
        clearRemovalTimer(child.id);
        next.delete(child.id);
      }
    }
    set({
      tasks: next,
      primaryTask: derivePrimaryTask(next),
      activeCount: deriveActiveCount(next),
    });
  },
}));
