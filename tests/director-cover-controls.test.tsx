// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDirectorCoverControls } from '../src/components/director/useDirectorCoverControls';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import { useAIStore } from '../src/store/ai';
import type { AIAnalysisResult, CoverCandidate } from '../src/types/ai';
import type { DirectorPlan, ProjectProductionState } from '../src/types/director';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function plan(revision = 2): DirectorPlan {
  return {
    revision, approvedAt: 2, inputFingerprint: `source-${revision}`,
    summary: '摘要', keywords: [], segments: [],
    motionBible: {
      visualThesis: '命题', rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
      carrierPlan: [], styleRules: { paletteUse: '蓝', typographyUse: '短' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    coverDirection: { prompt: `批准 v${revision} 封面提示词`, composition: '居中' },
    audioDirection: { bgmStyle: '', energy: 2, soundDensity: 'balanced' },
    warnings: [], createdAt: 1, updatedAt: 1,
  };
}

function production(stage: ProjectProductionState['workflow']['stage'] = 'animatic-review') {
  const state = createEmptyProductionState(1);
  const approvedPlan = plan();
  return {
    ...state,
    approvedPlan,
    workflow: {
      ...state.workflow,
      stage,
      activeTaskId: 'task-current',
    },
    outputs: {
      ...state.outputs,
      cover: { status: 'current' as const, directorRevision: approvedPlan.revision, updatedAt: 1 },
    },
  };
}

function analysis(revision: number, prompt: string): AIAnalysisResult {
  return {
    segments: [], cards: [], coverPrompts: [prompt], summary: '', keywords: [],
    coverPromptProvenance: {
      directorRevision: revision,
      fingerprint: `cover-prompt-${revision}`,
      generatedAt: 1,
      modifiedByUser: false,
    },
  };
}

function candidate(id: string, revision?: number): CoverCandidate {
  return {
    id, prompt: id, imageUrl: `/${id}.png`, selected: false,
    ...(revision == null ? {} : {
      generationProvenance: {
        directorRevision: revision,
        fingerprint: `cover-${revision}`,
        generatedAt: 1,
        modifiedByUser: false,
      },
    }),
  };
}

let latest: ReturnType<typeof useDirectorCoverControls>;
let currentProduction: ProjectProductionState;

function Harness({ locked = false }: { locked?: boolean }) {
  latest = useDirectorCoverControls('/project', currentProduction, locked);
  return null;
}

describe('director cover revision and write guards', () => {
  let container: HTMLDivElement;
  let root: Root;
  const api = {
    saveProjectSection: vi.fn(async () => undefined),
    mutateProjectProduction: vi.fn(async () => currentProduction),
    regenerateCoverPrompt: vi.fn(),
    generateCoverImages: vi.fn(),
    loadGlobalSettings: vi.fn(),
    saveGlobalSettings: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    currentProduction = production();
    useAIStore.setState({ analysisResult: null, coverCandidates: [] });
    Object.assign(window, { electronAPI: api });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('只暴露当前 approved revision 的提示词与封面候选', () => {
    useAIStore.setState({
      analysisResult: analysis(1, '旧 revision 提示词'),
      coverCandidates: [candidate('old', 1), candidate('current', 2), candidate('legacy')],
    });
    act(() => root.render(<Harness />));

    expect(latest.coverPrompt).toBe('批准 v2 封面提示词');
    expect(latest.coverCandidates.map((item) => item.id)).toEqual(['current']);

    act(() => useAIStore.setState({ analysisResult: analysis(2, '当前 revision 提示词') }));
    expect(latest.coverPrompt).toBe('当前 revision 提示词');
  });

  it('生成封面时不会把旧 revision 的隐藏提示词发给图片服务', async () => {
    useAIStore.setState({
      analysisResult: analysis(1, '旧 revision 提示词'),
      coverCandidates: [candidate('old', 1)],
    });
    api.loadGlobalSettings.mockResolvedValue(JSON.stringify({
      aiSettings: {
        imageProviders: [{
          id: 'image-provider',
          name: 'Image Provider',
          type: 'custom',
          baseUrl: 'https://example.test',
          apiKey: 'test',
          models: ['image-model'],
        }],
        defaultImageProviderId: 'image-provider',
        defaultImageModel: 'image-model',
      },
    }));
    api.generateCoverImages.mockResolvedValue([candidate('generated')]);
    act(() => root.render(<Harness />));

    await act(async () => latest.generateCovers());

    expect(api.generateCoverImages).toHaveBeenCalledWith(expect.objectContaining({
      prompts: ['批准 v2 封面提示词'],
    }));
  });

  it('保存提示词与选择封面都携带 task/revision guard', async () => {
    useAIStore.setState({
      analysisResult: analysis(2, '当前提示词'),
      coverCandidates: [candidate('current', 2)],
    });
    act(() => root.render(<Harness />));

    await act(async () => latest.savePrompt('人工修改提示词'));
    const savedPrompt = JSON.parse(api.saveProjectSection.mock.calls[0][2] as string);
    expect(savedPrompt.analysisResult).toMatchObject({
      coverPrompts: ['人工修改提示词'],
      coverPromptProvenance: { directorRevision: 2, modifiedByUser: true },
    });
    expect(api.saveProjectSection.mock.calls[0][3]).toEqual({
      expectedDirectorRevision: 2,
      expectedTaskId: 'task-current',
    });
    expect(api.mutateProjectProduction.mock.calls[0][1]).toMatchObject({
      kind: 'set-output', output: 'cover',
      expectedDirectorRevision: 2, expectedTaskId: 'task-current',
    });

    vi.clearAllMocks();
    await act(async () => latest.selectCover('current'));
    expect(api.saveProjectSection.mock.calls[0][3]).toEqual({
      expectedDirectorRevision: 2,
      expectedTaskId: 'task-current',
    });
    expect(api.mutateProjectProduction.mock.calls[0][1]).toMatchObject({
      kind: 'set-output', output: 'cover',
      expectedDirectorRevision: 2, expectedTaskId: 'task-current',
    });
  });

  it('production-running 或外部 working 时所有手动写入口都是 no-op', async () => {
    currentProduction = production('production-running');
    useAIStore.setState({
      analysisResult: analysis(2, '当前提示词'),
      coverCandidates: [candidate('current', 2)],
    });
    act(() => root.render(<Harness locked />));

    await act(async () => {
      await Promise.all([
        latest.savePrompt('不应保存'),
        latest.selectCover('current'),
        latest.rewritePrompt(),
        latest.generateCovers(),
      ]);
    });

    expect(latest.locked).toBe(true);
    expect(api.saveProjectSection).not.toHaveBeenCalled();
    expect(api.mutateProjectProduction).not.toHaveBeenCalled();
    expect(api.regenerateCoverPrompt).not.toHaveBeenCalled();
    expect(api.generateCoverImages).not.toHaveBeenCalled();
    expect(useAIStore.getState().analysisResult?.coverPrompts).toEqual(['当前提示词']);
  });

  it('guard 拒绝旧任务写入时不提前污染 renderer store', async () => {
    useAIStore.setState({ analysisResult: analysis(2, '当前提示词'), coverCandidates: [] });
    api.saveProjectSection.mockRejectedValueOnce(new Error('制作任务已变化'));
    act(() => root.render(<Harness />));

    await expect(latest.savePrompt('旧任务提示词')).rejects.toThrow('制作任务已变化');
    expect(useAIStore.getState().analysisResult?.coverPrompts).toEqual(['当前提示词']);
  });

  it('封面请求返回前进入只读状态时丢弃旧 epoch 结果', async () => {
    useAIStore.setState({ analysisResult: analysis(2, '当前提示词'), coverCandidates: [] });
    api.loadGlobalSettings.mockResolvedValue(JSON.stringify({
      aiSettings: {
        imageProviders: [{
          id: 'image-provider', name: 'Image Provider', type: 'custom',
          baseUrl: 'https://example.test', apiKey: 'test', models: ['image-model'],
        }],
        defaultImageProviderId: 'image-provider',
        defaultImageModel: 'image-model',
      },
    }));
    let finishGeneration: ((value: CoverCandidate[]) => void) | undefined;
    api.generateCoverImages.mockImplementationOnce(() => new Promise<CoverCandidate[]>((resolve) => {
      finishGeneration = resolve;
    }));
    act(() => root.render(<Harness />));

    let pending!: Promise<void>;
    act(() => { pending = latest.generateCovers(); });
    await vi.waitFor(() => expect(api.generateCoverImages).toHaveBeenCalledTimes(1));
    act(() => root.render(<Harness locked />));
    await act(async () => {
      finishGeneration?.([candidate('stale-generated')]);
      await pending;
    });

    expect(api.saveProjectSection).not.toHaveBeenCalled();
    expect(api.mutateProjectProduction).not.toHaveBeenCalled();
    expect(useAIStore.getState().coverCandidates).toEqual([]);
  });
});
