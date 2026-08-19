// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runProductionClient: vi.fn(),
  loadAISettings: vi.fn(async () => ({})),
  getAISettingsIssue: vi.fn<() => string | null>(() => null),
  taskProgress: {
    startTask: vi.fn(), updateTask: vi.fn(), completeTask: vi.fn(),
    failTask: vi.fn(), cancelTask: vi.fn(),
  },
}));
const { runProductionClient, taskProgress } = mocks;

vi.mock('../src/lib/director-production-client', () => ({
  runDirectorProductionClient: (...args: unknown[]) => mocks.runProductionClient(...args),
}));
vi.mock('../src/store/ai', () => ({
  loadAISettings: mocks.loadAISettings,
  useAIStore: { getState: () => ({ projectBindings: null }) },
}));
vi.mock('../src/lib/ai-settings', () => ({
  getAISettingsIssue: mocks.getAISettingsIssue,
}));
vi.mock('../src/store/task-progress', () => ({
  useTaskProgressStore: { getState: () => mocks.taskProgress },
}));

import { useDirectorWorkspace } from '../src/hooks/useDirectorWorkspace';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import { useTimelineStore } from '../src/store/timeline';
import type { DirectorPlan, ProjectProductionState } from '../src/types/director';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function plan(): DirectorPlan {
  return {
    revision: 1, approvedAt: 2, inputFingerprint: 'approved', summary: '摘要', keywords: [],
    segments: [{
      id: 'seg-1', title: '镜头', summary: '摘要', startMs: 0, endMs: 1_000,
      semanticType: 'explanation', complexityLevel: 'medium', visualizationScore: 80,
      pacingNeed: 'steady', keywords: [], entities: [], visualType: 'motion', enabled: true,
      purpose: 'explain', carrier: 'concept', intensity: 2, rationale: '测试',
    }],
    motionBible: {
      visualThesis: '命题', rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
      carrierPlan: [], styleRules: { paletteUse: '蓝', typographyUse: '短' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '封面', composition: '居中' },
    audioDirection: { bgmStyle: '', energy: 2, soundDensity: 'balanced' },
    agentPlanning: {
      roleVersion: '5', workflowVersion: '5', completedAt: 1, toolCalls: 1, repairRounds: 0,
    },
    warnings: [], createdAt: 1, updatedAt: 1,
  };
}

function pausedProduction(): ProjectProductionState {
  const production = createEmptyProductionState(1);
  production.approvedPlan = plan();
  production.workflow = { ...production.workflow, mode: 'director', stage: 'production-paused' };
  return production;
}

let latest: ReturnType<typeof useDirectorWorkspace>;

function Harness() {
  latest = useDirectorWorkspace('/project');
  return null;
}

describe('useDirectorWorkspace production cancellation', () => {
  let root: Root;
  let container: HTMLDivElement;
  let persisted: ProjectProductionState;
  const api = {
    loadProject: vi.fn(),
    onProjectUpdated: vi.fn(() => () => undefined),
    resumeProduction: vi.fn(),
    approveDirectorPlanAndStartProduction: vi.fn(),
    cancelProduction: vi.fn(),
    mutateProjectProduction: vi.fn(),
  };

  async function remountWith(next: ProjectProductionState) {
    act(() => root.unmount());
    container.remove();
    persisted = next;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await vi.waitFor(() => expect(latest.loading).toBe(false));
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.loadAISettings.mockResolvedValue({});
    mocks.getAISettingsIssue.mockReturnValue(null);
    persisted = pausedProduction();
    api.loadProject.mockImplementation(async () => JSON.stringify({ production: persisted }));
    api.resumeProduction.mockImplementation(async (_projectDir: string, taskId: string) => {
      persisted = {
        ...persisted,
        workflow: { ...persisted.workflow, stage: 'production-running', activeTaskId: taskId },
      };
      return persisted;
    });
    api.cancelProduction.mockImplementation(async () => {
      persisted = {
        ...persisted,
        workflow: { ...persisted.workflow, stage: 'production-paused', activeTaskId: undefined },
      };
      return persisted;
    });
    runProductionClient.mockImplementation(async (options: {
      signal?: AbortSignal;
      pauseProduction?: () => Promise<ProjectProductionState>;
    }) => {
      if (!options.signal?.aborted) {
        await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
      }
      return options.pauseProduction!();
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

  it('UI 与 client 同时请求暂停时只调用一次 IPC，最终保持 paused 而不是 error', async () => {
    let resumePromise: Promise<void>;
    act(() => {
      resumePromise = latest.resume();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(latest.producing).toBe(true);
        expect(runProductionClient).toHaveBeenCalledTimes(1);
      });
    });
    const cancel = latest.cancel;

    await act(async () => {
      await Promise.all([cancel(), cancel(), resumePromise!]);
    });

    expect(api.cancelProduction).toHaveBeenCalledTimes(1);
    expect(latest.production.workflow.stage).toBe('production-paused');
    expect(latest.error).toBeNull();
    expect(latest.producing).toBe(false);
    expect(taskProgress.cancelTask).toHaveBeenCalledTimes(1);
    expect(api.mutateProjectProduction).not.toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ kind: 'set-workflow', stage: 'error' }),
    );
  });

  it('制作正常返回 quality-blocked 时立即展示持久化失败原因', async () => {
    runProductionClient.mockImplementation(async () => {
      persisted = {
        ...persisted,
        workflow: {
          ...persisted.workflow,
          stage: 'quality-blocked',
          activeTaskId: undefined,
          error: '素材轨未完成，非 Motion 镜头尚未确认',
        },
      };
      return persisted;
    });

    await act(async () => latest.resume());

    expect(latest.production.workflow.stage).toBe('quality-blocked');
    expect(latest.error).toBe('素材轨未完成，非 Motion 镜头尚未确认');
    expect(latest.producing).toBe(false);
  });

  it('AI 配置失效时不先把暂停项目改成 production-running', async () => {
    mocks.getAISettingsIssue.mockReturnValue('请先配置文本生成服务');

    await act(async () => latest.resume());

    expect(api.resumeProduction).not.toHaveBeenCalled();
    expect(runProductionClient).not.toHaveBeenCalled();
    expect(latest.production.workflow.stage).toBe('production-paused');
    expect(latest.error).toBe('请先配置文本生成服务');
    expect(latest.producing).toBe(false);
  });

  it('AI 配置失效时不先批准导演草案', async () => {
    const review = createEmptyProductionState(1);
    review.draftPlan = { ...plan(), approvedAt: undefined };
    review.workflow = { ...review.workflow, mode: 'director', stage: 'director-review' };
    await remountWith(review);
    mocks.getAISettingsIssue.mockReturnValue('请先配置文本生成服务');

    await act(async () => latest.approveAndProduce());

    expect(api.approveDirectorPlanAndStartProduction).not.toHaveBeenCalled();
    expect(api.mutateProjectProduction).not.toHaveBeenCalled();
    expect(latest.production.workflow.stage).toBe('director-review');
    expect(latest.error).toBe('请先配置文本生成服务');
    expect(latest.producing).toBe(false);
  });

  it('旧版批准方案不能通过 renderer hook 恢复制作', async () => {
    runProductionClient.mockRejectedValue(new Error('不应启动制作 client'));
    const legacy = pausedProduction();
    legacy.approvedPlan!.agentPlanning = {
      roleVersion: '2', workflowVersion: '2', completedAt: 1, toolCalls: 1, repairRounds: 0,
    };
    await remountWith(legacy);
    expect(latest.production.approvedPlan?.agentPlanning?.roleVersion).toBe('2');

    await act(async () => latest.resume());

    expect(api.resumeProduction).not.toHaveBeenCalled();
    expect(runProductionClient).not.toHaveBeenCalled();
    expect(latest.production.workflow.stage).toBe('production-paused');
    expect(latest.error).toContain('旧版导演方案不能继续制作');
    expect(latest.producing).toBe(false);
  });
});
