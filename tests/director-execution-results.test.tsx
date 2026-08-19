// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectorExecutionPanel } from '../src/components/director/DirectorExecutionPanel';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import type { AIAnalysisResult, AICard, CoverCandidate } from '../src/types/ai';
import type { DirectorPlan, DirectorSegmentPlan, ProjectProductionState } from '../src/types/director';
import type { FootageCompositionInput, FootagePlacement } from '../src/types/footage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const coverState = vi.hoisted(() => ({
  analysisResult: null as AIAnalysisResult | null,
  coverCandidates: [] as CoverCandidate[],
  coverPrompt: '',
  entries: [] as Array<{ index: number; startMs: number; endMs: number; text: string }>,
  busy: null as 'prompt' | 'images' | null,
  error: null as string | null,
  locked: false,
  savePrompt: vi.fn(),
  selectCover: vi.fn(),
  rewritePrompt: vi.fn(),
  generateCovers: vi.fn(),
}));

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
    analysisResult: coverState.analysisResult,
    coverCandidates: coverState.coverCandidates,
    coverPrompt: coverState.coverPrompt,
    entries: coverState.entries,
    busy: coverState.busy,
    error: coverState.error,
    locked: coverState.locked || externallyLocked,
    savePrompt: coverState.savePrompt,
    selectCover: coverState.selectCover,
    rewritePrompt: coverState.rewritePrompt,
    generateCovers: coverState.generateCovers,
  }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  coverState.analysisResult = null;
  coverState.coverCandidates = [];
  coverState.coverPrompt = '';
  coverState.entries = [];
  coverState.busy = null;
  coverState.error = null;
  coverState.locked = false;
  vi.restoreAllMocks();
});

function segment(id: string, patch: Partial<DirectorSegmentPlan> = {}): DirectorSegmentPlan {
  return {
    id,
    title: `镜头 ${id}`,
    summary: `镜头 ${id} 的核心信息`,
    startMs: 0,
    endMs: 4_000,
    semanticType: 'explanation',
    complexityLevel: 'medium',
    visualizationScore: 80,
    pacingNeed: 'steady',
    keywords: [],
    entities: [],
    enabled: true,
    purpose: 'explain',
    carrier: 'concept',
    intensity: 2,
    rationale: '测试镜头',
    renderStrategy: 'motion-card',
    ...patch,
  };
}

function plan(segments: DirectorSegmentPlan[], patch: Partial<DirectorPlan> = {}): DirectorPlan {
  return {
    revision: 3,
    inputFingerprint: 'director-results',
    summary: '节目摘要',
    keywords: [],
    segments,
    motionBible: {
      visualThesis: '真实素材和动态图形共同服务观点',
      rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
      carrierPlan: [],
      styleRules: { paletteUse: '克制', typographyUse: '短标题' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '封面', composition: '居中' },
    audioDirection: { bgmStyle: '克制', energy: 2, soundDensity: 'balanced' },
    warnings: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function card(segmentId: string, patch: Partial<AICard> = {}): AICard {
  return {
    id: `card-${segmentId}`,
    segmentId,
    type: 'motion',
    title: `镜头 ${segmentId}`,
    content: '核心内容',
    startMs: 0,
    endMs: 4_000,
    displayDurationMs: 4_000,
    displayMode: 'fullscreen',
    template: 'motion',
    enabled: true,
    style: { primaryColor: '#fff', backgroundColor: '#111', fontSize: 40 },
    renderStrategy: 'motion-card',
    generationProvenance: {
      directorRevision: 3,
      fingerprint: `card-${segmentId}-revision-3`,
      generatedAt: 100,
      modifiedByUser: false,
    },
    ...patch,
  };
}

function placement(): FootagePlacement {
  return {
    segmentIndex: 1,
    segmentId: 'seg-media',
    overlayId: 'footage-media',
    startMs: 4_000,
    durationMs: 4_000,
    sourcePath: '/library/factory-line.mp4',
    kind: 'video',
    trimStartMs: 1_000,
    score: 0.81,
    thumbnailFile: '/library/factory-line.jpg',
  };
}

function compositionInput(): FootageCompositionInput {
  return {
    segmentIndex: 2,
    segmentId: 'seg-composite',
    startMs: 8_000,
    durationMs: 4_000,
    usage: 'required',
    asset: {
      id: 'asset-composite',
      filename: 'vehicle-road.mp4',
      path: '/library/vehicle-road.mp4',
      kind: 'video',
      score: 0.73,
      thumbnailFile: '/library/vehicle-road.jpg',
    },
  };
}

function productionState(
  approvedPlan: DirectorPlan,
  options: { placements?: FootagePlacement[]; compositionInputs?: FootageCompositionInput[] } = {},
): ProjectProductionState {
  const state = createEmptyProductionState(100);
  return {
    ...state,
    approvedPlan,
    footage: {
      placements: options.placements ?? [],
      compositionInputs: options.compositionInputs ?? [],
      claimedSegmentIds: (options.placements ?? []).map((item) => item.segmentId),
      fallbacks: [],
      generationProvenance: {
        directorRevision: approvedPlan.revision,
        fingerprint: `footage-${approvedPlan.revision}`,
        generatedAt: 100,
        modifiedByUser: false,
      },
    },
    workflow: { ...state.workflow, stage: 'animatic-review' },
    outputs: {
      ...state.outputs,
      cards: { status: 'current', directorRevision: approvedPlan.revision, updatedAt: 100 },
      footage: { status: 'current', directorRevision: approvedPlan.revision, updatedAt: 100 },
    },
  };
}

function renderPanel(
  production: ProjectProductionState,
  onOpenEditor = vi.fn(),
  working = false,
  readOnly = false,
) {
  act(() => {
    root.render(
      <DirectorExecutionPanel
        projectDir="/tmp/project"
        production={production}
        working={working}
        progress={{}}
        onResume={vi.fn()}
        onOpenEditor={onOpenEditor}
        readOnly={readOnly}
      />,
    );
  });
  return onOpenEditor;
}

describe('导演制作统一镜头结果', () => {
  it('按批准方案合并 Motion、真实素材与 Agent Composite 的实际产物', () => {
    const approvedPlan = plan([
      segment('seg-motion'),
      segment('seg-media', {
        title: '生产线实拍', startMs: 4_000, endMs: 8_000,
        visualType: 'footage', renderStrategy: 'standalone-media', footageQuery: '汽车 工厂 生产线',
        assetDecisions: [{ candidateId: 'media-1', decision: 'selected', reason: '画面相关', inspected: true }],
      }),
      segment('seg-composite', {
        title: '车辆与信息层', startMs: 8_000, endMs: 12_000,
        visualType: 'footage', renderStrategy: 'agent-composite', fallbackPolicy: 'block',
        footageQuery: '车辆 道路',
      }),
    ]);
    coverState.analysisResult = {
      segments: [],
      cards: [
        card('seg-motion'),
        card('seg-composite', { renderStrategy: 'agent-composite' }),
      ],
      coverPrompts: [],
      summary: '',
      keywords: [],
    };
    const onOpenEditor = renderPanel(productionState(approvedPlan, {
      placements: [placement()],
      compositionInputs: [compositionInput()],
    }));

    const results = [...container.querySelectorAll<HTMLElement>('[data-testid="director-shot-result"]')];
    expect(results).toHaveLength(3);
    expect(results.map((item) => item.dataset.strategy)).toEqual([
      'motion-card', 'standalone-media', 'agent-composite',
    ]);
    expect(results[1].textContent).toContain('factory-line.mp4');
    expect(results[2].textContent).toContain('Agent Composite');
    expect(results[2].textContent).toContain('Agent 组件已合成 1 项真实素材');
    expect(results[2].textContent).not.toContain('Motion 卡已完成');

    const summary = container.querySelector('[data-testid="director-result-summary"]')!;
    expect(summary.getAttribute('data-state')).toBe('ready');
    expect(summary.textContent).toContain('Motion 1');
    expect(summary.textContent).toContain('真实素材 1');
    expect(summary.textContent).toContain('Agent Composite 1');
    expect(summary.textContent).toContain('搜材镜头 2');
    expect(summary.textContent).toContain('已检视候选 1');
    expect(summary.textContent).toContain('冻结素材 2');

    act(() => results[2].click());
    expect(onOpenEditor).toHaveBeenCalledTimes(1);
  });

  it('历史结果只读时不进入编辑器，也不展示声音、质检和当前版本操作', () => {
    const approvedPlan = plan([segment('seg-motion')]);
    coverState.analysisResult = {
      segments: [],
      cards: [card('seg-motion')],
      coverPrompts: ['历史封面描述'],
      summary: '',
      keywords: [],
    };
    coverState.coverPrompt = '历史封面描述';
    coverState.entries = [{ index: 1, startMs: 0, endMs: 1_000, text: '字幕' }];
    coverState.coverCandidates = [{
      id: 'cover-history', prompt: '历史候选', imageUrl: '/cover.png', selected: false,
    }];
    const onOpenEditor = renderPanel(productionState(approvedPlan), vi.fn(), false, true);

    expect(container.textContent).toContain('历史结果 · 只读');
    expect(container.textContent).not.toContain('进入编辑器审查');
    const tabLabels = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .map((button) => button.textContent?.trim());
    expect(tabLabels).not.toContain('声音');
    expect(tabLabels).not.toContain('质检');

    const result = container.querySelector<HTMLButtonElement>('[data-testid="director-shot-result"]')!;
    expect(result.disabled).toBe(true);
    expect(result.dataset.readOnly).toBe('true');
    act(() => result.click());
    expect(onOpenEditor).not.toHaveBeenCalled();

    const coverTab = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '封面')!;
    act(() => coverTab.click());
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label^="选择封面候选"]')?.disabled).toBe(true);
    expect([...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('重写描述'))?.disabled).toBe(true);
    expect([...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('生成封面'))?.disabled).toBe(true);
  });

  it('全 Motion 即使有零组合说明也显示黄色异常，不显示绿色通过', () => {
    const approvedPlan = plan([
      segment('seg-1'),
      segment('seg-2', { startMs: 4_000, endMs: 8_000 }),
    ], {
      zeroCompositeReason: '导演认为本期无需组合素材，但这不是制作结果的通过条件。',
    });
    coverState.analysisResult = {
      segments: [],
      cards: [card('seg-1'), card('seg-2')],
      coverPrompts: [],
      summary: '',
      keywords: [],
    };
    renderPanel(productionState(approvedPlan));

    const warning = container.querySelector('[data-testid="director-motion-only-warning"]')!;
    expect(warning.textContent).toContain('当前结果仍然全部是 Motion');
    expect(warning.textContent).toContain('实际上屏真实素材 0，Agent Composite 0');
    const summary = container.querySelector('[data-testid="director-result-summary"]')!;
    expect(summary.getAttribute('data-state')).toBe('warning');
    expect(summary.textContent).toContain('搜材镜头 0');
    expect(summary.textContent).toContain('已检视候选 0');
    expect(summary.textContent).toContain('冻结素材 0');
  });

  it('Motion 制作轨产出的图片卡按实际媒介展示，不误报为全 Motion 动画', () => {
    const approvedPlan = plan([segment('seg-image', { visualType: 'image' })]);
    coverState.analysisResult = {
      segments: [],
      cards: [card('seg-image', {
        type: 'image',
        content: {
          mediaType: 'image',
          assetPath: 'ai-cards/card-seg-image/image.png',
          aspectRatio: '16:9',
          prompt: '汽车制造细节',
          providerId: 'image-provider',
          model: 'image-model',
          generationStatus: 'ready',
        },
      })],
      coverPrompts: [],
      summary: '',
      keywords: [],
    };
    renderPanel(productionState(approvedPlan));

    const result = container.querySelector('[data-testid="director-shot-result"]')!;
    expect(result.textContent).toContain('图片卡');
    expect(result.textContent).toContain('生成图片卡已完成');
    expect(container.querySelector('[data-testid="director-motion-only-warning"]')).toBeNull();
    const summary = container.querySelector('[data-testid="director-result-summary"]')!;
    expect(summary.textContent).toContain('Motion 0');
    expect(summary.textContent).toContain('图片卡 1');
  });

  it('Motion 制作轨产出视频卡时不重复计入 Motion 动画', () => {
    const approvedPlan = plan([segment('seg-video', { visualType: 'video' })]);
    coverState.analysisResult = {
      segments: [],
      cards: [card('seg-video', {
        type: 'video',
        content: {
          mediaType: 'video',
          assetPath: 'ai-cards/card-seg-video/video.mp4',
          durationMs: 4_000,
          generationStatus: 'ready',
        },
      })],
      coverPrompts: [],
      summary: '',
      keywords: [],
    };
    renderPanel(productionState(approvedPlan));

    const summary = container.querySelector('[data-testid="director-result-summary"]')!;
    expect(summary.textContent).toContain('Motion 0');
    expect(summary.textContent).toContain('视频卡 1');
    expect(container.querySelector('[data-testid="director-motion-only-warning"]')).toBeNull();
  });

  it('在同一结果网格中明确展示回退、阻塞和失败状态', () => {
    const approvedPlan = plan([
      segment('seg-fallback', {
        renderStrategy: 'agent-composite', visualType: 'footage', fallbackPolicy: 'motion',
        strategyStatus: 'fallback',
        fallbackDecision: {
          from: 'agent-composite', to: 'motion-card', reason: '组合审片未通过', explicit: true,
        },
      }),
      segment('seg-blocked', {
        startMs: 4_000, endMs: 8_000, renderStrategy: 'agent-composite', visualType: 'footage',
        fallbackPolicy: 'block', strategyStatus: 'blocked', blockedReason: '缺少已检视素材',
      }),
      segment('seg-failed', { startMs: 8_000, endMs: 12_000 }),
    ]);
    coverState.analysisResult = {
      segments: [],
      cards: [card('seg-fallback')],
      coverPrompts: [],
      summary: '',
      keywords: [],
      cardErrors: [{ segmentId: 'seg-failed', message: '素材冻结未就绪' }],
    };
    const production = productionState(approvedPlan);
    production.footage!.blockedSegmentIds = ['seg-blocked'];
    renderPanel(production);

    const byId = new Map(
      [...container.querySelectorAll<HTMLElement>('[data-testid="director-shot-result"]')]
        .map((item) => [item.title.replace('在编辑器中查看：', ''), item]),
    );
    expect(byId.get('镜头 seg-fallback')?.dataset.status).toBe('fallback');
    expect(byId.get('镜头 seg-fallback')?.dataset.strategy).toBe('motion-card');
    expect(byId.get('镜头 seg-fallback')?.textContent).toContain('原计划 Agent Composite');
    expect(byId.get('镜头 seg-blocked')?.dataset.status).toBe('blocked');
    expect(byId.get('镜头 seg-failed')?.dataset.status).toBe('failed');
  });

  it('隐藏旧 revision 的卡片与素材产物，只展示当前方案的待制作状态', () => {
    const approvedPlan = plan([
      segment('seg-current'),
      segment('seg-media', {
        startMs: 4_000,
        endMs: 8_000,
        visualType: 'footage',
        renderStrategy: 'standalone-media',
      }),
    ]);
    coverState.analysisResult = {
      segments: [],
      cards: [card('seg-current')],
      coverPrompts: [],
      summary: '',
      keywords: [],
      cardErrors: [{ segmentId: 'seg-current', message: '旧方案失败' }],
    };
    const production = productionState(approvedPlan, { placements: [placement()] });
    production.outputs.cards.directorRevision = approvedPlan.revision - 1;
    production.outputs.footage!.directorRevision = approvedPlan.revision - 1;
    renderPanel(production);

    expect(container.textContent).toContain(`已隐藏不属于当前批准 v${approvedPlan.revision} 的旧画面产物`);
    expect(container.textContent).not.toContain('factory-line.mp4');
    expect(container.textContent).not.toContain('旧方案失败');
    const results = [...container.querySelectorAll<HTMLElement>('[data-testid="director-shot-result"]')];
    expect(results).toHaveLength(2);
    expect(results.every((item) => item.dataset.status === 'pending')).toBe(true);
    expect(container.querySelector('[data-testid="director-result-summary"]')?.textContent).toContain('真实素材 0');
  });

  it('当前卡片存在但素材轨没有任何旧产物时，不误报隐藏旧产物', () => {
    const approvedPlan = plan([segment('seg-current')]);
    coverState.analysisResult = {
      segments: [],
      cards: [card('seg-current')],
      coverPrompts: [],
      summary: '',
      keywords: [],
    };
    const production = productionState(approvedPlan);
    production.outputs.footage = {
      status: 'empty',
      directorRevision: approvedPlan.revision - 1,
      updatedAt: 100,
    };
    renderPanel(production);

    expect(container.textContent).not.toContain('已隐藏不属于当前批准');
    expect(container.querySelector('[data-testid="director-shot-result"]')?.dataset.status).toBe('ready');
  });

  it('新 revision 正在制作时不把旧卡片、旧错误和旧素材算作当前结果', () => {
    const approvedPlan = plan([
      segment('seg-current'),
      segment('seg-media', {
        startMs: 4_000,
        endMs: 8_000,
        visualType: 'footage',
        renderStrategy: 'standalone-media',
      }),
    ]);
    coverState.analysisResult = {
      segments: [],
      cards: [card('seg-current', {
        generationProvenance: {
          directorRevision: approvedPlan.revision - 1,
          fingerprint: 'old-card',
          generatedAt: 90,
          modifiedByUser: false,
        },
      })],
      coverPrompts: [],
      summary: '',
      keywords: [],
      cardErrors: [{ segmentId: 'seg-current', message: '上一版制作失败' }],
    };
    const production = productionState(approvedPlan, { placements: [placement()] });
    production.outputs.cards.status = 'generating';
    production.outputs.footage!.status = 'generating';
    production.footage!.generationProvenance!.directorRevision = approvedPlan.revision - 1;
    renderPanel(production, vi.fn(), true);

    expect(container.textContent).toContain(`已隐藏不属于当前批准 v${approvedPlan.revision} 的旧画面产物`);
    expect(container.textContent).not.toContain('上一版制作失败');
    expect(container.textContent).not.toContain('factory-line.mp4');
    const results = [...container.querySelectorAll<HTMLElement>('[data-testid="director-shot-result"]')];
    expect(results).toHaveLength(2);
    expect(results.every((item) => item.dataset.status === 'working')).toBe(true);
    const summary = container.querySelector('[data-testid="director-result-summary"]')!;
    expect(summary.textContent).toContain('Motion 0');
    expect(summary.textContent).toContain('真实素材 0');
  });

  it('当前画面轨失败时隐藏上一版 Motion 卡，并展示真实轨错误', () => {
    const approvedPlan = plan([
      segment('seg-current', {
        visualType: 'footage',
        renderStrategy: 'agent-composite',
        fallbackPolicy: 'block',
      }),
    ]);
    coverState.analysisResult = {
      segments: [],
      cards: [card('seg-current', {
        generationProvenance: {
          directorRevision: approvedPlan.revision - 1,
          fingerprint: 'previous-motion-card',
          generatedAt: 90,
          modifiedByUser: false,
        },
      })],
      coverPrompts: [],
      summary: '',
      keywords: [],
    };
    const production = productionState(approvedPlan);
    production.workflow = {
      ...production.workflow,
      stage: 'quality-blocked',
      error: '画面生成服务中断',
    };
    production.outputs.cards = {
      status: 'failed',
      directorRevision: approvedPlan.revision,
      updatedAt: 110,
      error: "Error invoking remote method 'generate-cards': GenerationError: 画面生成服务中断",
    };
    renderPanel(production);

    expect(container.textContent).toContain(`已隐藏不属于当前批准 v${approvedPlan.revision} 的旧画面产物`);
    const result = container.querySelector<HTMLElement>('[data-testid="director-shot-result"]')!;
    expect(result.dataset.status).toBe('failed');
    expect(result.dataset.strategy).toBe('agent-composite');
    expect(result.textContent).toContain('计划 Agent Composite');
    expect(result.textContent).not.toContain('Motion 卡已完成');

    const summary = container.querySelector('[data-testid="director-result-summary"]')!;
    expect(summary.textContent).toContain('Motion 0');
    expect(summary.textContent).toContain('Agent Composite 0');
    const failures = container.querySelector('[data-testid="director-failed-shots"]')!;
    expect(failures.textContent).toContain('失败镜头 1 · 1 类原因');
    expect(failures.textContent).toContain('画面生成服务中断');
    expect(failures.textContent).toContain('画面轨未完成，当前版本不能视为可用结果');
    expect(failures.textContent).not.toContain('Error invoking remote method');
  });

  it('封面提示词重写或切换 revision 后输入框同步新值，不保留旧 defaultValue', () => {
    const approvedPlan = plan([segment('seg-current')]);
    coverState.analysisResult = {
      segments: [], cards: [], coverPrompts: ['旧提示词'], summary: '', keywords: [],
    };
    coverState.coverPrompt = '旧提示词';
    coverState.entries = [{ index: 1, startMs: 0, endMs: 1_000, text: '字幕' }];
    const current = productionState(approvedPlan);
    renderPanel(current);
    const coverTab = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '封面')!;
    act(() => coverTab.click());
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('旧提示词');

    coverState.coverPrompt = '重写后的提示词';
    renderPanel(current);
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('重写后的提示词');

    const nextPlan = { ...approvedPlan, revision: approvedPlan.revision + 1 };
    coverState.coverPrompt = '新 revision 提示词';
    renderPanel(productionState(nextPlan));
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('新 revision 提示词');
  });

  it('制作中禁用封面重写、生成、保存和选择', () => {
    const approvedPlan = plan([segment('seg-current')]);
    coverState.analysisResult = {
      segments: [], cards: [], coverPrompts: ['当前提示词'], summary: '', keywords: [],
    };
    coverState.coverPrompt = '当前提示词';
    coverState.entries = [{ index: 1, startMs: 0, endMs: 1_000, text: '字幕' }];
    coverState.coverCandidates = [{
      id: 'cover-current', prompt: '当前候选', imageUrl: '/cover.png', selected: false,
    }];
    const current = productionState(approvedPlan);
    current.workflow.stage = 'production-running';
    renderPanel(current, vi.fn(), true);
    const coverTab = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '封面')!;
    act(() => coverTab.click());

    const rewrite = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('重写描述'))!;
    const generate = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('生成封面'))!;
    const candidateButton = container.querySelector<HTMLButtonElement>('[aria-label^="选择封面候选"]')!;
    const prompt = container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(rewrite.disabled).toBe(true);
    expect(generate.disabled).toBe(true);
    expect(candidateButton.disabled).toBe(true);
    expect(prompt.disabled).toBe(true);

    act(() => {
      rewrite.click();
      generate.click();
      candidateButton.click();
      prompt.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    });
    expect(coverState.rewritePrompt).not.toHaveBeenCalled();
    expect(coverState.generateCovers).not.toHaveBeenCalled();
    expect(coverState.selectCover).not.toHaveBeenCalled();
    expect(coverState.savePrompt).not.toHaveBeenCalled();
  });
});
