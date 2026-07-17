// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorAnimaticReviewBar } from '../src/components/EditorAnimaticReviewBar';
import { EditorShotNavigator } from '../src/components/EditorShotNavigator';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import type { ProjectProductionState } from '../src/types/director';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const addAICardsToTimeline = vi.hoisted(() => vi.fn());

vi.mock('../src/store/ai', () => ({
  useAIStore: (selector: (state: unknown) => unknown) => selector({
    analysisResult: {
      cards: [
        { id: 'card-b', title: '第二镜头', startMs: 8_000, endMs: 12_000, enabled: true, type: 'image' },
        { id: 'card-a', title: '第一镜头', startMs: 1_000, endMs: 5_000, enabled: true, type: 'motion' },
      ],
    },
  }),
}));

vi.mock('../src/store/timeline', () => ({
  useTimelineStore: (selector: (state: unknown) => unknown) => selector({
    timeline: {
      overlays: [{ overlayType: 'ai-card', aiCardData: { sourceCardId: 'card-a' } }],
    },
    addAICardsToTimeline,
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
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('编辑器导演职责边界', () => {
  it('镜头导航按时间排序并把选中镜头交给 Inspector', () => {
    const onSelectCard = vi.fn();
    act(() => {
      root.render(
        <EditorShotNavigator
          compact={false}
          inspectedCardId="card-a"
          onSelectCard={onSelectCard}
          onOpenDirector={vi.fn()}
        />,
      );
    });

    const shots = [...container.querySelectorAll<HTMLButtonElement>('nav[aria-label="镜头列表"] button')];
    expect(shots.map((shot) => shot.textContent)).toEqual([
      expect.stringContaining('第一镜头'),
      expect.stringContaining('第二镜头'),
    ]);
    expect(shots[0]?.getAttribute('aria-current')).toBe('true');
    act(() => shots[0]?.click());
    expect(onSelectCard).toHaveBeenCalledWith('card-a', 1_000);
  });

  it('镜头导航提供手动排布入口，把未上轨镜头批量放入时间线', () => {
    act(() => {
      root.render(
        <EditorShotNavigator
          compact={false}
          onSelectCard={vi.fn()}
          onOpenDirector={vi.fn()}
        />,
      );
    });

    const placeButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="shot-navigator-place-all"]',
    );
    expect(placeButton?.textContent).toContain('排布 1');

    act(() => placeButton?.click());
    expect(addAICardsToTimeline).toHaveBeenCalledTimes(1);
    const drafts = addAICardsToTimeline.mock.calls[0][0] as Array<{ sourceCardId: string }>;
    expect(drafts.map((draft) => draft.sourceCardId)).toEqual(['card-b']);
  });

  it('Animatic 批准通过 V3 production mutation 进入精修阶段', async () => {
    const production = createAnimaticReviewState();
    const next = {
      ...production,
      workflow: { ...production.workflow, stage: 'refining' as const },
    };
    const mutateProjectProduction = vi.fn(async () => next);
    Object.assign(window, {
      electronAPI: {
        loadProject: vi.fn(async () => JSON.stringify({ version: 3, production })),
        onProjectUpdated: vi.fn(() => () => undefined),
        mutateProjectProduction,
      },
    });

    await act(async () => {
      root.render(<EditorAnimaticReviewBar projectDir="/tmp/project" onOpenDirector={vi.fn()} />);
    });
    const approve = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('批准 Animatic'));
    expect(approve).toBeTruthy();

    await act(async () => approve?.click());
    expect(mutateProjectProduction).toHaveBeenCalledWith('/tmp/project', {
      kind: 'approve-animatic',
      complete: false,
    });
  });
});

function createAnimaticReviewState(): ProjectProductionState {
  const state = createEmptyProductionState(100);
  return {
    ...state,
    approvedPlan: { revision: 2 } as ProjectProductionState['approvedPlan'],
    workflow: { ...state.workflow, stage: 'animatic-review' },
  };
}
