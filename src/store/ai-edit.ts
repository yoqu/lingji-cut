import { create } from 'zustand';

interface AiEditState {
  locked: boolean;
  scope?: 'video' | 'script';
  owner?: string;
  projectPath?: string;
  reason?: string;
  setLock: (change: {
    active: boolean;
    scope?: 'video' | 'script';
    owner?: string;
    projectPath?: string;
    reason?: string;
  }) => void;
}

export const useAiEditStore = create<AiEditState>((set) => ({
  locked: false,
  scope: undefined,
  owner: undefined,
  projectPath: undefined,
  reason: undefined,
  setLock: ({ active, scope, owner, projectPath, reason }) =>
    set({
      locked: active,
      scope: active ? scope : undefined,
      owner: active ? owner : undefined,
      projectPath: active ? projectPath : undefined,
      reason: active ? reason : undefined,
    }),
}));

/** 供非 React 处（timeline 订阅）同步读取当前是否锁定。 */
export function isAiEditLocked(): boolean {
  return useAiEditStore.getState().locked;
}
