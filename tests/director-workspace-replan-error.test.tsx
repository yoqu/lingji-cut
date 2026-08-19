// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadAISettings: vi.fn(async () => ({})),
  taskProgress: {
    startTask: vi.fn(), updateTask: vi.fn(), completeTask: vi.fn(),
    failTask: vi.fn(), cancelTask: vi.fn(),
  },
}));

vi.mock('../src/lib/ai-settings', () => ({
  getAISettingsIssue: () => null,
}));
vi.mock('../src/store/ai', () => ({
  loadAISettings: mocks.loadAISettings,
  useAIStore: { getState: () => ({ projectBindings: null }) },
}));
vi.mock('../src/store/task-progress', () => ({
  useTaskProgressStore: { getState: () => mocks.taskProgress },
}));

import { useDirectorWorkspace } from '../src/hooks/useDirectorWorkspace';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import { useTimelineStore } from '../src/store/timeline';
import type { ProjectProductionState } from '../src/types/director';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latest: ReturnType<typeof useDirectorWorkspace>;

function Harness() {
  latest = useDirectorWorkspace('/project');
  return null;
}

describe('useDirectorWorkspace replanning errors', () => {
  let root: Root;
  let container: HTMLDivElement;
  let persisted: ProjectProductionState;
  const api = {
    loadProject: vi.fn(),
    onProjectUpdated: vi.fn(() => () => undefined),
    onDirectorPlanProgress: vi.fn(() => () => undefined),
    startDirectorPlan: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    persisted = createEmptyProductionState(1);
    api.loadProject.mockImplementation(async () => JSON.stringify({ production: persisted }));
    api.startDirectorPlan.mockImplementation(async () => {
      persisted = {
        ...persisted,
        workflow: {
          ...persisted.workflow,
          stage: 'error',
          error: '导演规划已落盘的真实错误',
          updatedAt: 2,
        },
      };
      throw new Error('IPC 连接中断');
    });
    Object.assign(window, { electronAPI: api });
    useTimelineStore.setState({
      srtEntries: [{ index: 1, startMs: 0, endMs: 1_000, text: '字幕' }],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await vi.waitFor(() => expect(latest.loading).toBe(false));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('重新编排失败后重读项目，以磁盘 workflow.error 为准', async () => {
    await act(async () => {
      await latest.generatePlan('优先使用真实素材');
    });

    expect(api.startDirectorPlan).toHaveBeenCalledTimes(1);
    expect(api.loadProject).toHaveBeenCalledTimes(2);
    expect(latest.production.workflow.stage).toBe('error');
    expect(latest.production.workflow.error).toBe('导演规划已落盘的真实错误');
    expect(latest.error).toBe('导演规划已落盘的真实错误');
    expect(latest.error).not.toBe('IPC 连接中断');
    expect(latest.planning).toBe(false);
  });
});
