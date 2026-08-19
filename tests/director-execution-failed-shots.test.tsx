// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectorExecutionPanel } from '../src/components/director/DirectorExecutionPanel';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import type { ProjectProductionState } from '../src/types/director';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/store/ai', () => ({
  useAIStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ deleteCard: vi.fn() }),
    { getState: () => ({ deleteCard: vi.fn() }) },
  ),
}));

vi.mock('../src/store/timeline', () => ({
  useTimelineStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({}),
    { getState: () => ({ removeAICardOverlaysBySourceIds: vi.fn() }) },
  ),
}));

vi.mock('../src/components/director/useDirectorCoverControls', () => ({
  useDirectorCoverControls: (_projectDir: string, _production: unknown, externallyLocked = false) => ({
    analysisResult: {
      segments: [],
      cards: [],
      coverPrompts: [],
      summary: '',
      keywords: [],
      cardErrors: [
        {
          segmentId: 'seg-07', segmentTitle: '供给端幻觉', segmentIndex: 2,
          message: "Error invoking remote method 'generate-ai-card-for-segment': ApprovedDirectorSegmentMismatchError: 镜头 seg-07 与已批准导演方案不一致：质量门禁阻断",
        },
        {
          segmentId: 'seg-08', segmentTitle: '素材错配', segmentIndex: 3,
          message: "Error invoking remote method 'generate-ai-card-for-segment': ApprovedDirectorSegmentMismatchError: 镜头 seg-08 与已批准导演方案不一致：质量门禁阻断",
        },
        { segmentId: 'seg-12', message: '生成超时' },
      ],
    },
    coverCandidates: [],
    entries: [],
    busy: null,
    error: null,
    locked: externallyLocked,
    savePrompt: vi.fn(),
    selectCover: vi.fn(),
    rewritePrompt: vi.fn(),
    generateCovers: vi.fn(),
  }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function createQualityBlockedState(roleVersion = '5', workflowVersion = '5'): ProjectProductionState {
  const state = createEmptyProductionState(100);
  return {
    ...state,
    approvedPlan: {
      revision: 2,
      agentPlanning: {
        roleVersion, workflowVersion, completedAt: 100,
        toolCalls: 12, repairRounds: 0,
      },
    } as ProjectProductionState['approvedPlan'],
    workflow: { ...state.workflow, stage: 'quality-blocked' },
    outputs: {
      ...state.outputs,
      cards: { status: 'failed', directorRevision: 2, updatedAt: 100 },
    },
  };
}

describe('导演台失败镜头面板', () => {
  it('展示失败镜头清单并通过重试按钮触发继续制作', () => {
    const onResume = vi.fn();
    act(() => {
      root.render(
        <DirectorExecutionPanel
          projectDir="/tmp/project"
          production={createQualityBlockedState()}
          working={false}
          progress={{}}
          onResume={onResume}
          onOpenEditor={vi.fn()}
        />,
      );
    });

    const panel = container.querySelector('[data-testid="director-failed-shots"]');
    expect(panel?.textContent).toContain('失败镜头 3 · 2 类原因');
    expect(panel?.textContent).toContain('供给端幻觉');
    expect(panel?.textContent).toContain('素材错配');
    expect(panel?.textContent).toContain('质量门禁阻断');
    expect(panel?.textContent).not.toContain('Error invoking remote method');
    expect(panel?.textContent).toContain('seg-12');
    expect(panel?.querySelector('[data-error-count="2"]')).not.toBeNull();
    expect(panel?.textContent?.match(/质量门禁阻断/gu)).toHaveLength(1);

    const retry = [...(panel?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.includes('重试失败镜头'));
    expect(retry).toBeTruthy();
    act(() => retry?.click());
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('历史结果只读时保留失败原因，但不允许重新制作', () => {
    const onResume = vi.fn();
    act(() => {
      root.render(
        <DirectorExecutionPanel
          projectDir="/tmp/project"
          production={createQualityBlockedState()}
          working={false}
          progress={{}}
          onResume={onResume}
          onOpenEditor={vi.fn()}
          readOnly
        />,
      );
    });

    const panel = container.querySelector('[data-testid="director-failed-shots"]');
    expect(panel?.textContent).toContain('失败镜头 3 · 2 类原因');
    expect(panel?.textContent).not.toContain('重试失败镜头');
    expect(container.textContent).not.toContain('继续制作');
    expect(onResume).not.toHaveBeenCalled();
  });

  it('旧版 approvedPlan 保留失败原因，但隐藏继续和重试入口', () => {
    const onResume = vi.fn();
    act(() => {
      root.render(
        <DirectorExecutionPanel
          projectDir="/tmp/project"
          production={createQualityBlockedState('2', '2')}
          working={false}
          progress={{}}
          onResume={onResume}
          onOpenEditor={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain('失败镜头 3 · 2 类原因');
    expect(container.textContent).not.toContain('继续制作');
    expect(container.textContent).not.toContain('重试失败镜头');
    expect(onResume).not.toHaveBeenCalled();
  });
});
