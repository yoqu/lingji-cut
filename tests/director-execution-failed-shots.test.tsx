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
  useDirectorCoverControls: () => ({
    analysisResult: {
      segments: [],
      cards: [],
      coverPrompts: [],
      summary: '',
      keywords: [],
      cardErrors: [
        { segmentId: 'seg-07', segmentTitle: '供给端幻觉', segmentIndex: 2, message: '质量门禁阻断' },
        { segmentId: 'seg-12', message: '生成超时' },
      ],
    },
    coverCandidates: [],
    entries: [],
    busy: null,
    error: null,
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

function createQualityBlockedState(): ProjectProductionState {
  const state = createEmptyProductionState(100);
  return {
    ...state,
    approvedPlan: { revision: 2 } as ProjectProductionState['approvedPlan'],
    workflow: { ...state.workflow, stage: 'quality-blocked' },
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
    expect(panel?.textContent).toContain('失败镜头 2');
    expect(panel?.textContent).toContain('供给端幻觉');
    expect(panel?.textContent).toContain('质量门禁阻断');
    expect(panel?.textContent).toContain('seg-12');

    const retry = [...(panel?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.includes('重试失败镜头'));
    expect(retry).toBeTruthy();
    act(() => retry?.click());
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
