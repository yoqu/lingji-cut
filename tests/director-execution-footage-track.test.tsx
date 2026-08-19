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
    analysisResult: null,
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

function runningState(): ProjectProductionState {
  const state = createEmptyProductionState(100);
  return {
    ...state,
    approvedPlan: { revision: 3 } as ProjectProductionState['approvedPlan'],
    workflow: { ...state.workflow, stage: 'production-running' },
  };
}

describe('制作执行进度 footage 轨', () => {
  it('制作中显示素材轨进度与消息', () => {
    act(() => {
      root.render(
        <DirectorExecutionPanel
          projectDir="/tmp/project"
          production={runningState()}
          working
          progress={{
            footage: { track: 'footage', percent: 40, message: '正在检索素材 2/5' },
          }}
          onResume={vi.fn()}
          onOpenEditor={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain('素材');
    expect(container.textContent).toContain('正在检索素材 2/5');
    // 既有四轨标签仍然渲染
    for (const label of ['画面', '封面', '高亮', '声音', '排布']) {
      expect(container.textContent).toContain(label);
    }
  });
});
