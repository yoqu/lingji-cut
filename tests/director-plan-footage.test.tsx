// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectorPlanEditor } from '../src/components/director/DirectorPlanEditor';
import { MotionProvider } from '../src/ui/lib/motion';
import type { DirectorPlan, DirectorSegmentPlan } from '../src/types/director';
import type { FootagePlacement, KacutClip } from '../src/types/footage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function footageSegment(patch: Partial<DirectorSegmentPlan> = {}): DirectorSegmentPlan {
  return {
    id: 'seg-1', title: '夜色城市', summary: '段落摘要', startMs: 0, endMs: 5_000,
    semanticType: 'narration', complexityLevel: 'low', visualizationScore: 40,
    pacingNeed: 'steady', keywords: [], entities: [],
    enabled: true, purpose: 'context', carrier: 'concept', intensity: 2, rationale: '理由',
    visualType: 'footage', footageQuery: '城市夜景 车流', footageFallback: 'image',
    ...patch,
  };
}

function plan(segments: DirectorSegmentPlan[]): DirectorPlan {
  return {
    revision: 1, inputFingerprint: 'footage-ui', summary: '摘要', keywords: [], segments,
    motionBible: {
      visualThesis: '视觉命题', rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
      carrierPlan: [], styleRules: { paletteUse: '蓝', typographyUse: '短标题' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '封面', composition: '居中' },
    audioDirection: {
      bgmEnabled: false, soundEffectsEnabled: false,
      bgmStyle: '克制', energy: 2, soundDensity: 'balanced',
    },
    warnings: [], createdAt: 1, updatedAt: 1,
  };
}

function placement(patch: Partial<FootagePlacement> = {}): FootagePlacement {
  return {
    segmentIndex: 0, segmentId: 'seg-1', overlayId: 'ov-1',
    startMs: 0, durationMs: 5_000, sourcePath: '/library/city-night.mp4',
    kind: 'video', trimStartMs: 12_000, score: 0.85,
    thumbnailFile: '/library/thumbs/city-night.jpg',
    ...patch,
  };
}

function Harness({ placements }: { placements: FootagePlacement[] }) {
  const [value, setValue] = useState(() => plan([footageSegment()]));
  return (
    <MotionProvider>
      <DirectorPlanEditor
        plan={value}
        selectedSegmentId={null}
        onSelectSegment={() => undefined}
        onChange={setValue}
        footagePlacements={placements}
      />
    </MotionProvider>
  );
}

async function openShotCard(index = 0) {
  const cards = container.querySelectorAll<HTMLButtonElement>('[data-testid="director-shot-card"]');
  expect(cards.length).toBeGreaterThan(index);
  await act(async () => cards[index].click());
}

let container: HTMLDivElement;
let root: Root;
let originalElectronAPI: typeof window.electronAPI;

beforeEach(() => {
  originalElectronAPI = window.electronAPI;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: originalElectronAPI,
  });
  vi.restoreAllMocks();
});

describe('导演方案审查 footage 段展示', () => {
  it('无 placement：卡片展示执行策略，独立素材详情不展示不支持的失败退路', async () => {
    act(() => root.render(<Harness placements={[]} />));

    const card = container.querySelector('[data-testid="director-shot-card"]')!;
    expect(card.textContent).toContain('素材');
    expect(card.textContent).toContain('城市夜景 车流');
    expect(container.querySelector('[data-testid="director-shot-editor"]')).toBeNull();

    await openShotCard();

    const panel = container.querySelector('[data-testid="footage-segment-panel"]')!;
    const queryInput = panel.querySelector<HTMLInputElement>('input[aria-label="素材检索词"]')!;
    expect(queryInput.value).toBe('城市夜景 车流');
    expect(container.textContent).not.toContain('制作失败退路');
    expect(container.textContent).not.toContain('回退 Motion');
    expect(panel.textContent).toContain('尚未选入素材；请先检索、预览并选择：城市夜景 车流');
    expect(panel.querySelector('img')).toBeNull();
  });

  it('有 placement：卡片和详情显示缩略图、文件名与匹配度百分比', async () => {
    act(() => root.render(<Harness placements={[placement()]} />));

    const card = container.querySelector('[data-testid="director-shot-card"]')!;
    expect(card.textContent).toContain('city-night.mp4');
    expect(card.querySelector('img')?.getAttribute('src')).toBe('file:///library/thumbs/city-night.jpg');

    await openShotCard();

    const panel = container.querySelector('[data-testid="footage-segment-panel"]')!;
    expect(panel.textContent).toContain('city-night.mp4');
    expect(panel.textContent).toContain('匹配度 85%');
    expect(panel.textContent).not.toContain('尚未人工选择');

    const img = panel.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('file:///library/thumbs/city-night.jpg');
  });

  it('placement 属于其他段时不展示匹配结果', async () => {
    act(() => root.render(<Harness placements={[placement({ segmentId: 'seg-other' })]} />));

    await openShotCard();

    const panel = container.querySelector('[data-testid="footage-segment-panel"]')!;
    expect(panel.textContent).toContain('尚未选入素材；请先检索、预览并选择：城市夜景 车流');
  });

  it('Motion 段也可先检索和预览素材，不必先盲选执行策略', async () => {
    function MotionHarness() {
      const [value, setValue] = useState(() => plan([footageSegment({ visualType: 'motion', footageQuery: undefined })]));
      return (
        <MotionProvider>
          <DirectorPlanEditor
            plan={value}
            selectedSegmentId={null}
            onSelectSegment={() => undefined}
            onChange={setValue}
            footagePlacements={[placement()]}
          />
        </MotionProvider>
      );
    }
    act(() => root.render(<MotionHarness />));
    await openShotCard();
    const panel = container.querySelector('[data-testid="footage-segment-panel"]')!;
    expect(panel).not.toBeNull();
    expect(panel.querySelector<HTMLInputElement>('input[aria-label="素材检索词"]')?.value).toBe('夜色城市');
    expect(panel.textContent).toContain('采用时直接切换为独立素材或 Agent 合成');
  });

  it('素材联动关闭时禁用导演台检索，并在全 Motion 审计中明确原因', async () => {
    function DisabledKacutHarness() {
      const [value, setValue] = useState(() => plan([
        footageSegment({ visualType: 'motion', footageQuery: undefined, footageFallback: undefined }),
      ]));
      return (
        <MotionProvider>
          <DirectorPlanEditor
            plan={value}
            selectedSegmentId={null}
            onSelectSegment={() => undefined}
            onChange={setValue}
            kacutEnabled={false}
          />
        </MotionProvider>
      );
    }

    act(() => root.render(<DisabledKacutHarness />));
    expect(container.querySelector('[data-testid="director-plan-motion-only-warning"]')?.textContent)
      .toContain('素材联动当前未启用');

    await openShotCard();
    const panel = container.querySelector('[data-testid="footage-segment-panel"]')!;
    const searchButton = panel.querySelector<HTMLButtonElement>('button[aria-label="检索视频和图片素材"]')!;
    expect(searchButton.disabled).toBe(true);
    expect(panel.textContent).toContain('素材联动未启用，当前导演不会检索新的本机素材');
  });

  it('同时展示全片分镜卡片，点击指定卡片才进入详情', async () => {
    function OverviewHarness() {
      const [value, setValue] = useState(() => plan([
        footageSegment(),
        footageSegment({ id: 'seg-2', title: '车间机械臂', visualType: 'motion', carrier: 'process', startMs: 5_000, endMs: 10_000 }),
        footageSegment({ id: 'seg-3', title: '产品出发', visualType: 'image', carrier: 'image', startMs: 10_000, endMs: 15_000 }),
      ]));
      return (
        <MotionProvider>
          <DirectorPlanEditor
            plan={value}
            selectedSegmentId={null}
            onSelectSegment={() => undefined}
            onChange={setValue}
          />
        </MotionProvider>
      );
    }

    act(() => root.render(<OverviewHarness />));

    const cards = container.querySelectorAll('[data-testid="director-shot-card"]');
    expect(cards).toHaveLength(3);
    expect(container.querySelector('[data-testid="director-shot-editor"]')).toBeNull();
    expect(container.textContent).toContain('画面类型：Motion 动画 1 · 图片卡 1 · 视频素材 1 · 图片素材 0 · Agent 合成 0');
    expect(cards[2].getAttribute('data-render-strategy')).toBe('motion-card');
    expect(cards[2].textContent).toContain('图片卡');
    expect(container.querySelector('[data-testid="director-plan-motion-only-warning"]')).toBeNull();

    await openShotCard(1);

    const editor = container.querySelector('[data-testid="director-shot-editor"]')!;
    expect(editor).not.toBeNull();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('镜头 2 · 车间机械臂');
    expect(editor.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('车间机械臂');
  });

  it('全片均为 Motion 时在导演检查中显示重新编排风险', () => {
    function MotionOnlyHarness() {
      const [value, setValue] = useState(() => plan([
        footageSegment({ visualType: 'motion', footageQuery: undefined, footageFallback: undefined }),
        footageSegment({ id: 'seg-2', title: '观点解释', visualType: 'motion', footageQuery: undefined, footageFallback: undefined }),
      ]));
      return (
        <MotionProvider>
          <DirectorPlanEditor
            plan={value}
            selectedSegmentId={null}
            onSelectSegment={() => undefined}
            onChange={setValue}
          />
        </MotionProvider>
      );
    }

    act(() => root.render(<MotionOnlyHarness />));

    expect(container.textContent).toContain('全片均为 Motion，请重新编排媒介');
    expect(container.querySelector('[data-testid="director-plan-motion-only-warning"]')?.textContent)
      .toContain('视频素材 0、图片画面 0、Agent 合成 0');
    expect(container.querySelector('[data-testid="director-plan-motion-only-warning"]')?.textContent)
      .toContain('该草案没有可核对的新版素材审计');
  });

  it('全 Motion 即使有零组合审计也只显示黄色异常，不伪装成绿色通过', () => {
    function MotionAuditHarness() {
      const [value, setValue] = useState(() => ({
        ...plan([footageSegment({ visualType: 'motion', renderStrategy: 'motion-card' })]),
        zeroCompositeReason: '本期没有需要来源特定证据的镜头',
      }));
      return (
        <MotionProvider>
          <DirectorPlanEditor
            plan={value}
            selectedSegmentId={null}
            onSelectSegment={() => undefined}
            onChange={setValue}
          />
        </MotionProvider>
      );
    }

    act(() => root.render(<MotionAuditHarness />));

    const row = [...container.querySelectorAll<HTMLElement>('[data-state]')]
      .find((item) => item.textContent?.includes('零组合审计'))!;
    expect(row.dataset.state).toBe('warning');
  });

  it('阻塞的 Agent 合成缺少必用素材时不会被标记为素材就绪', () => {
    function BlockedCompositeHarness() {
      const [value, setValue] = useState(() => plan([footageSegment({
        renderStrategy: 'agent-composite',
        strategyStatus: 'blocked',
        blockedReason: '等待可信素材',
        compositionAssets: [],
      })]));
      return (
        <MotionProvider>
          <DirectorPlanEditor
            plan={value}
            selectedSegmentId={null}
            onSelectSegment={() => undefined}
            onChange={setValue}
          />
        </MotionProvider>
      );
    }

    act(() => root.render(<BlockedCompositeHarness />));

    const row = [...container.querySelectorAll<HTMLElement>('[data-state]')]
      .find((item) => item.textContent?.includes('部分 Agent 合成镜头等待选材或审阅'))!;
    expect(row.dataset.state).toBe('error');
    expect(container.textContent).not.toContain('Agent 合成镜头均已选入并审阅必用素材');
  });

  it('Agent 合成绑定了必用素材但没有审阅记录时不会被标记为就绪', () => {
    function UnreviewedCompositeHarness() {
      const [value, setValue] = useState(() => plan([footageSegment({
        renderStrategy: 'agent-composite',
        strategyStatus: 'ready',
        compositionAssets: [{
          asset: {
            id: 'unreviewed-video', filename: 'unreviewed.mp4', path: '/library/unreviewed.mp4',
            kind: 'video', score: 0.88,
          },
          usage: 'required',
        }],
        assetDecisions: [],
      })]));
      return (
        <MotionProvider>
          <DirectorPlanEditor
            plan={value}
            selectedSegmentId={null}
            onSelectSegment={() => undefined}
            onChange={setValue}
          />
        </MotionProvider>
      );
    }

    act(() => root.render(<UnreviewedCompositeHarness />));

    const row = [...container.querySelectorAll<HTMLElement>('[data-state]')]
      .find((item) => item.textContent?.includes('部分 Agent 合成镜头等待选材或审阅'))!;
    expect(row.dataset.state).toBe('error');
    expect(container.textContent).not.toContain('Agent 合成镜头均已选入并审阅必用素材');
  });

  it('总览明确展示重新编排保护，并可一次解除整片与镜头锁定', async () => {
    let latest: DirectorPlan | null = null;
    function LockedHarness() {
      const [value, setValue] = useState(() => ({
        ...plan([
          footageSegment({ userLocks: { strategy: true, assets: true } }),
          footageSegment({
            id: 'seg-2', startMs: 5_000, endMs: 10_000,
            userLocks: { direction: true },
          }),
        ]),
        userLocks: { title: true, cover: true },
      }));
      latest = value;
      return (
        <MotionProvider>
          <DirectorPlanEditor
            plan={value}
            selectedSegmentId={null}
            onSelectSegment={() => undefined}
            onChange={setValue}
          />
        </MotionProvider>
      );
    }

    act(() => root.render(<LockedHarness />));

    const summary = container.querySelector('[data-testid="director-plan-lock-summary"]')!;
    expect(summary.textContent).toContain('2 个整片字段、2 个镜头中的 3 项手工修改');
    const cards = container.querySelectorAll('[data-testid="director-shot-card"]');
    expect(cards[0].textContent).toContain('策略、素材');
    expect(cards[1].textContent).toContain('镜头语言');

    const clearButton = [...summary.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('解除全部保护'))!;
    await act(async () => clearButton.click());

    expect(latest!.userLocks).toBeUndefined();
    expect(latest!.segments.every((segment) => segment.userLocks == null)).toBe(true);
    expect(container.querySelector('[data-testid="director-plan-lock-summary"]')).toBeNull();
  });
});

describe('导演方案 footage 段编辑', () => {
  function EditableHarness({ initial, onLatest, placements = [], onCommit, readOnly = false }: {
    initial: DirectorSegmentPlan;
    onLatest: (plan: DirectorPlan) => void;
    placements?: FootagePlacement[];
    onCommit?: (plan: DirectorPlan) => void;
    readOnly?: boolean;
  }) {
    const [value, setValue] = useState(() => plan([initial]));
    onLatest(value);
    return (
      <MotionProvider>
        <DirectorPlanEditor
          plan={value}
          selectedSegmentId={null}
          onSelectSegment={() => undefined}
          onChange={setValue}
          onCommit={onCommit}
          readOnly={readOnly}
          footagePlacements={placements}
        />
      </MotionProvider>
    );
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('从 Motion 卡切到独立素材：同步兼容 visualType 并用镜头标题预填检索词', async () => {
    let latest: DirectorPlan | null = null;
    act(() => root.render(
      <EditableHarness
        initial={footageSegment({ visualType: 'motion', footageQuery: undefined, footageFallback: undefined })}
        onLatest={(planValue) => { latest = planValue; }}
      />,
    ));

    await openShotCard();

    const pill = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '独立素材')!;
    await act(async () => pill.click());

    expect(latest!.segments[0].visualType).toBe('footage');
    expect(latest!.segments[0].renderStrategy).toBe('standalone-media');
    expect(latest!.segments[0].footageQuery).toBe('夜色城市');
    expect(latest!.segments[0].userLocks).toEqual({ strategy: true });
  });

  it('Motion 段预览候选后可直接采用为 Agent 合成，并同时锁定策略与素材', async () => {
    let latest: DirectorPlan | null = null;
    const video: KacutClip = {
      id: 'motion-video', filename: 'road-context.mp4', path: '/library/road-context.mp4',
      kind: 'video', score: 0.55, durationSec: 12, pixelWidth: 1920, pixelHeight: 1080,
      thumbnailFile: '/library/road-context.jpg', matchedSegmentStart: 2,
    };
    const kacutSearchClips = vi.fn(async (args: { kind?: string }) => args.kind === 'video' ? [video] : []);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: { kacutSearchClips } as unknown as typeof window.electronAPI,
    });
    act(() => root.render(
      <EditableHarness
        initial={footageSegment({ visualType: 'motion', footageQuery: undefined, footageFallback: undefined })}
        onLatest={(planValue) => { latest = planValue; }}
      />,
    ));
    await openShotCard();

    const panel = container.querySelector('[data-testid="footage-segment-panel"]')!;
    await act(async () => panel.querySelector<HTMLButtonElement>('button[aria-label="检索视频和图片素材"]')!.click());
    await act(async () => panel.querySelector<HTMLButtonElement>('[data-testid="footage-candidate-motion-video"]')!.click());
    const adopt = panel.querySelector<HTMLButtonElement>('button[aria-label="用于 Agent 合成 road-context.mp4"]')!;
    expect(adopt).not.toBeNull();
    await act(async () => adopt.click());

    expect(latest!.segments[0]).toMatchObject({
      visualType: 'footage',
      renderStrategy: 'agent-composite',
      footageQuery: '夜色城市',
      fallbackPolicy: 'block',
      userLocks: { strategy: true, assets: true },
      compositionAssets: [{
        asset: { id: 'motion-video', path: '/library/road-context.mp4' },
        usage: 'required',
        trimStartMs: 2_000,
      }],
    });
    expect(latest!.segments[0].compositionIntent?.narrativeGoal).toBe('理由');
  });

  it('修改检索词不会锁定素材，Agent 合成可单独编辑失败退路', async () => {
    let latest: DirectorPlan | null = null;
    act(() => root.render(
      <EditableHarness
        initial={footageSegment({ renderStrategy: 'agent-composite' })}
        onLatest={(planValue) => { latest = planValue; }}
      />,
    ));

    await openShotCard();

    const panel = container.querySelector('[data-testid="footage-segment-panel"]')!;
    const queryInput = panel.querySelector<HTMLInputElement>('input[aria-label="素材检索词"]')!;
    await act(async () => setInputValue(queryInput, '火箭 发射'));
    expect(latest!.segments[0].footageQuery).toBe('火箭 发射');
    expect(latest!.segments[0].userLocks?.assets).not.toBe(true);

    const motionPill = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '回退 Motion')!;
    await act(async () => motionPill.click());
    expect(latest!.segments[0].footageFallback).toBe('motion');
    expect(latest!.segments[0].userLocks).toEqual({ strategy: true });
  });

  it.each(['blocked', 'fallback'] as const)('切换执行策略会解除 %s 状态并清理旧原因', async (strategyStatus) => {
    let latest: DirectorPlan | null = null;
    act(() => root.render(
      <EditableHarness
        initial={footageSegment({
          renderStrategy: 'agent-composite',
          strategyStatus,
          blockedReason: strategyStatus === 'blocked' ? '等待可信素材' : undefined,
          fallbackDecision: strategyStatus === 'fallback' ? {
            from: 'agent-composite',
            to: 'motion-card',
            reason: '旧退路',
            explicit: true,
          } : undefined,
        })}
        onLatest={(planValue) => { latest = planValue; }}
      />,
    ));
    await openShotCard();

    const standalonePill = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '独立素材')!;
    await act(async () => standalonePill.click());

    expect(latest!.segments[0].strategyStatus).toBe('ready');
    expect(latest!.segments[0].blockedReason).toBeUndefined();
    expect(latest!.segments[0].fallbackDecision).toBeUndefined();
    expect(latest!.segments[0].userLocks).toEqual({ strategy: true });
  });

  it('修改镜头文本只锁定镜头语言，不隐式锁定策略或素材', async () => {
    let latest: DirectorPlan | null = null;
    act(() => root.render(
      <EditableHarness initial={footageSegment()} onLatest={(planValue) => { latest = planValue; }} />,
    ));
    await openShotCard();
    const titleInput = [...container.querySelectorAll<HTMLInputElement>('input')]
      .find((input) => input.value === '夜色城市')!;

    await act(async () => setInputValue(titleInput, '真实道路夜景'));

    expect(latest!.segments[0].title).toBe('真实道路夜景');
    expect(latest!.segments[0].userLocks).toEqual({ direction: true });
  });

  it('上次制作素材可直接预览并采用到当前方案', async () => {
    let latest: DirectorPlan | null = null;
    const previousPlacement = placement();
    act(() => root.render(
      <EditableHarness
        initial={footageSegment()}
        placements={[previousPlacement]}
        onLatest={(planValue) => { latest = planValue; }}
      />,
    ));

    await openShotCard();
    const panel = container.querySelector('[data-testid="footage-segment-panel"]')!;
    const previewButton = panel.querySelector<HTMLButtonElement>('button[aria-label="预览 city-night.mp4"]')!;
    const adoptButton = panel.querySelector<HTMLButtonElement>('button[aria-label="采用 city-night.mp4"]')!;
    expect(previewButton).not.toBeNull();
    expect(adoptButton).not.toBeNull();

    await act(async () => previewButton.click());
    const video = panel.querySelector<HTMLVideoElement>('[data-testid="footage-asset-preview"] video')!;
    expect(video.getAttribute('src')).toBe('file:///library/city-night.mp4');
    await act(async () => video.dispatchEvent(new Event('loadedmetadata')));
    expect(video.currentTime).toBe(12);

    await act(async () => adoptButton.click());
    expect(latest!.segments[0].compositionAssets).toMatchObject([{
      asset: { id: 'placement:ov-1', filename: 'city-night.mp4', path: '/library/city-night.mp4', kind: 'video' },
      usage: 'required',
      trimStartMs: 12_000,
    }]);
    expect(latest!.segments[0].selectedFootage).toMatchObject({
      id: 'placement:ov-1', path: '/library/city-night.mp4', matchedSegmentStart: 12,
    });
  });

  it('图片 placement 点击预览后展示原图', async () => {
    let latest: DirectorPlan | null = null;
    act(() => root.render(
      <EditableHarness
        initial={footageSegment()}
        placements={[placement({
          overlayId: 'ov-image',
          sourcePath: '/library/city-night.jpg',
          kind: 'image',
          trimStartMs: 0,
          thumbnailFile: undefined,
        })]}
        onLatest={(planValue) => { latest = planValue; }}
      />,
    ));

    await openShotCard();
    const panel = container.querySelector('[data-testid="footage-segment-panel"]')!;
    await act(async () => panel.querySelector<HTMLButtonElement>('button[aria-label="预览 city-night.jpg"]')!.click());
    expect(panel.querySelector('[data-testid="footage-asset-preview"] img')?.getAttribute('src')).toBe('file:///library/city-night.jpg');
    expect(latest!.segments[0].compositionAssets).toBeUndefined();
  });

  it('切到 Motion 卡时保留素材池但不再把素材作为独立画面', async () => {
    let latest: DirectorPlan | null = null;
    act(() => root.render(
      <EditableHarness
        initial={footageSegment({
          selectedFootage: {
            id: 'selected-1', filename: 'selected.jpg', path: '/library/selected.jpg',
            kind: 'image', score: 0.9,
          },
        })}
        onLatest={(planValue) => { latest = planValue; }}
      />,
    ));
    await openShotCard();

    const motionPill = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Motion 卡')!;
    await act(async () => motionPill.click());

    expect(latest!.segments[0].visualType).toBe('motion');
    expect(latest!.segments[0].renderStrategy).toBe('motion-card');
    expect(latest!.segments[0].selectedFootage).toBeUndefined();
    expect(latest!.segments[0].compositionAssets).toHaveLength(1);
    expect(latest!.segments[0].compositionAssets?.[0].asset.id).toBe('selected-1');

    const compositePill = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Agent 合成')!;
    await act(async () => compositePill.click());
    expect(latest!.segments[0].renderStrategy).toBe('agent-composite');
    expect(latest!.segments[0].compositionIntent?.narrativeGoal).toBe('理由');
    expect(latest!.segments[0].fallbackPolicy).toBe('block');
    expect(latest!.segments[0].compositionAssets).toHaveLength(1);

    const standalonePill = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '独立素材')!;
    await act(async () => standalonePill.click());
    expect(latest!.segments[0].renderStrategy).toBe('standalone-media');
    expect(latest!.segments[0].selectedFootage?.id).toBe('selected-1');
  });

  it('Agent 合成同时展示视频与图片候选，可维护必用/可选素材池和视频起点', async () => {
    let latest: DirectorPlan | null = null;
    const video: KacutClip = {
      id: 'video-1', filename: 'city-drive.mp4', path: '/library/city-drive.mp4',
      kind: 'video', score: 0.36, durationSec: 18.2, pixelWidth: 1920, pixelHeight: 1080,
      thumbnailFile: '/library/thumbs/city-drive.jpg', matchedSegmentStart: 4.5,
    };
    const image: KacutClip = {
      id: 'image-1', filename: 'city-night.jpg', path: '/library/city-night.jpg',
      kind: 'image', score: 0.88, pixelWidth: 3840, pixelHeight: 2160,
    };
    const kacutSearchClips = vi.fn(async (args: { kind?: string }) => args.kind === 'video' ? [video] : [image]);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: { kacutSearchClips } as unknown as typeof window.electronAPI,
    });

    act(() => root.render(
      <EditableHarness
        initial={footageSegment({
          visualType: 'motion', renderStrategy: 'agent-composite', carrier: 'data-hero',
        })}
        onLatest={(planValue) => { latest = planValue; }}
      />,
    ));
    await openShotCard();

    const panel = container.querySelector('[data-testid="footage-segment-panel"]')!;
    const searchButton = panel.querySelector<HTMLButtonElement>('button[aria-label="检索视频和图片素材"]')!;
    await act(async () => searchButton.click());

    expect(kacutSearchClips).toHaveBeenCalledTimes(2);
    expect(kacutSearchClips.mock.calls.map(([args]) => args.kind).sort()).toEqual(['image', 'video']);
    expect(panel.querySelectorAll(
      '[data-testid^="footage-candidate-"]:not([data-testid="footage-candidate-list"])',
    )).toHaveLength(2);
    expect(panel.textContent).toContain('city-drive.mp4');
    expect(panel.textContent).toContain('city-night.jpg');
    expect(panel.querySelector('[data-testid="footage-candidate-video-1"]')?.getAttribute('aria-label')).toContain('city-drive.mp4');
    expect(panel.querySelector('[data-testid="footage-candidate-image-1"]')?.getAttribute('aria-label')).toContain('city-night.jpg');

    await act(async () => panel.querySelector<HTMLButtonElement>('[data-testid="footage-candidate-video-1"]')!.click());
    let preview = panel.querySelector('[data-testid="footage-asset-preview"]')!;
    const candidateVideo = preview.querySelector<HTMLVideoElement>('video')!;
    expect(candidateVideo.getAttribute('src')).toBe('file:///library/city-drive.mp4');
    expect(preview.textContent).toContain('18 秒 · 1920×1080');
    await act(async () => candidateVideo.dispatchEvent(new Event('loadedmetadata')));
    expect(candidateVideo.currentTime).toBe(4.5);

    await act(async () => panel.querySelector<HTMLButtonElement>('[data-testid="footage-candidate-image-1"]')!.click());
    preview = panel.querySelector('[data-testid="footage-asset-preview"]')!;
    expect(preview.querySelector('img')?.getAttribute('src')).toBe('file:///library/city-night.jpg');
    const optionalButton = [...preview.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '加入可选')!;
    expect(optionalButton.getAttribute('aria-label')).toContain('city-night.jpg');
    await act(async () => optionalButton.click());
    expect(latest!.segments[0].compositionAssets).toMatchObject([{
      asset: { id: 'image-1', path: '/library/city-night.jpg' }, usage: 'optional',
    }]);

    await act(async () => panel.querySelector<HTMLButtonElement>('[data-testid="footage-candidate-video-1"]')!.click());
    const chooseButton = [...panel.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '设为必用')!;
    expect(chooseButton.getAttribute('aria-label')).toContain('city-drive.mp4');
    await act(async () => chooseButton.click());
    expect(latest!.segments[0].compositionAssets).toHaveLength(2);
    expect(latest!.segments[0].compositionAssets?.find((binding) => binding.asset.id === 'video-1')).toMatchObject({
      usage: 'required', trimStartMs: 4_500,
    });
    expect(latest!.segments[0].selectedFootage).toBeUndefined();
    expect(panel.querySelectorAll('[data-testid="selected-footage-asset"]')).toHaveLength(2);
    expect(panel.textContent).toContain('必用素材');
    expect(panel.textContent).toContain('可选素材');
    expect(panel.querySelector('button[aria-label="预览 city-drive.mp4"]')).not.toBeNull();
    expect(panel.querySelector('button[aria-label="移除 city-drive.mp4"]')).not.toBeNull();
    const selectedVideo = [...panel.querySelectorAll('[data-testid="selected-footage-asset"]')]
      .find((item) => item.textContent?.includes('city-drive.mp4'))!;
    expect([...selectedVideo.querySelectorAll('button')].some((button) => button.textContent?.includes('必用 city-drive.mp4'))).toBe(true);

    const trimInput = panel.querySelector<HTMLInputElement>('input[aria-label="city-drive.mp4 素材起点秒"]')!;
    await act(async () => setInputValue(trimInput, '7.2'));
    expect(latest!.segments[0].compositionAssets?.find((binding) => binding.asset.id === 'video-1')?.trimStartMs).toBe(7_200);

    await act(async () => setInputValue(trimInput, '99'));
    expect(trimInput.max).toBe('18.2');
    expect(latest!.segments[0].compositionAssets?.find((binding) => binding.asset.id === 'video-1')?.trimStartMs).toBe(18_200);
    const selectedPreviewVideo = panel.querySelector<HTMLVideoElement>('[data-testid="footage-asset-preview"] video')!;
    await act(async () => selectedPreviewVideo.dispatchEvent(new Event('loadedmetadata')));
    expect(selectedPreviewVideo.currentTime).toBe(18.2);

    const queryInput = panel.querySelector<HTMLInputElement>('input[aria-label="素材检索词"]')!;
    await act(async () => setInputValue(queryInput, '新的 检索词'));
    expect(latest!.segments[0].compositionAssets).toHaveLength(2);
    expect(panel.querySelector('[data-testid="footage-candidate-list"]')).toBeNull();
  });

  it('导演台顺序检索视频与图片，避免素材服务冷启动时并发挤压', async () => {
    let releaseVideo: ((clips: KacutClip[]) => void) | undefined;
    const videoPending = new Promise<KacutClip[]>((resolve) => { releaseVideo = resolve; });
    const kacutSearchClips = vi.fn((args: { kind?: string }) => (
      args.kind === 'video' ? videoPending : Promise.resolve([])
    ));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: { kacutSearchClips } as unknown as typeof window.electronAPI,
    });
    act(() => root.render(<EditableHarness initial={footageSegment()} onLatest={() => undefined} />));
    await openShotCard();

    const search = container.querySelector<HTMLButtonElement>('button[aria-label="检索视频和图片素材"]')!;
    act(() => search.click());
    await act(async () => Promise.resolve());
    expect(kacutSearchClips).toHaveBeenCalledTimes(1);
    expect(kacutSearchClips.mock.calls[0][0].kind).toBe('video');

    await act(async () => releaseVideo?.([]));
    expect(kacutSearchClips).toHaveBeenCalledTimes(2);
    expect(kacutSearchClips.mock.calls[1][0].kind).toBe('image');
  });

  it('素材服务失败时只显示连接错误，不误报为零候选', async () => {
    const kacutSearchClips = vi.fn(async () => {
      throw new Error('素材服务暂时不可用');
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: { kacutSearchClips } as unknown as typeof window.electronAPI,
    });
    act(() => root.render(<EditableHarness initial={footageSegment()} onLatest={() => undefined} />));
    await openShotCard();

    const panel = container.querySelector('[data-testid="footage-segment-panel"]')!;
    await act(async () => panel.querySelector<HTMLButtonElement>('button[aria-label="检索视频和图片素材"]')!.click());

    expect(panel.textContent).toContain('素材服务暂时不可用');
    expect(panel.textContent).not.toContain('没有找到可预览的视频或图片素材');
  });

  it('独立素材只保留一个必用素材，新选择替换旧素材且不展示 optional 操作', async () => {
    let latest: DirectorPlan | null = null;
    const image: KacutClip = {
      id: 'image-new', filename: 'new-scene.jpg', path: '/library/new-scene.jpg',
      kind: 'image', score: 0.91, pixelWidth: 3840, pixelHeight: 2160,
    };
    const kacutSearchClips = vi.fn(async (args: { kind?: string }) => args.kind === 'image' ? [image] : []);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: { kacutSearchClips } as unknown as typeof window.electronAPI,
    });
    act(() => root.render(
      <EditableHarness
        initial={footageSegment({
          compositionAssets: [{
            asset: {
              id: 'old-video', filename: 'old.mp4', path: '/library/old.mp4',
              kind: 'video', score: 0.8,
            },
            usage: 'required',
          }],
          strategyStatus: 'blocked',
          blockedReason: '旧素材已经失效',
          fallbackDecision: {
            from: 'standalone-media',
            to: 'motion-card',
            reason: '旧退路',
            explicit: true,
          },
        })}
        onLatest={(planValue) => { latest = planValue; }}
      />,
    ));
    await openShotCard();
    const panel = container.querySelector('[data-testid="footage-segment-panel"]')!;
    expect(panel.textContent).not.toContain('加入可选');
    expect(panel.textContent).not.toContain('可选素材');
    await act(async () => panel.querySelector<HTMLButtonElement>('button[aria-label="检索视频和图片素材"]')!.click());
    await act(async () => panel.querySelector<HTMLButtonElement>('[data-testid="footage-candidate-image-new"]')!.click());
    const choose = panel.querySelector<HTMLButtonElement>('button[aria-label="设为必用 new-scene.jpg"]')!;
    await act(async () => choose.click());

    expect(latest!.segments[0].compositionAssets).toEqual([expect.objectContaining({
      usage: 'required',
      asset: expect.objectContaining({ id: 'image-new', path: '/library/new-scene.jpg' }),
    })]);
    expect(latest!.segments[0].selectedFootage?.id).toBe('image-new');
    expect(latest!.segments[0].strategyStatus).toBe('ready');
    expect(latest!.segments[0].blockedReason).toBeUndefined();
    expect(latest!.segments[0].fallbackDecision).toBeUndefined();
    expect(latest!.segments[0].userLocks?.assets).toBe(true);
    const updatedPanel = document.body.querySelector('[data-testid="footage-segment-panel"]')!;
    expect(updatedPanel.querySelectorAll('[data-testid="selected-footage-asset"]')).toHaveLength(1);
    expect(updatedPanel.textContent).not.toContain('old.mp4');
  });

  it('从 Agent 合成切到独立素材时只保留首选素材并规范为 required', async () => {
    let latest: DirectorPlan | null = null;
    act(() => root.render(
      <EditableHarness
        initial={footageSegment({
          visualType: 'motion', renderStrategy: 'agent-composite', carrier: 'data-hero',
          compositionAssets: [
            {
              asset: { id: 'optional-1', filename: 'optional.jpg', path: '/library/optional.jpg', kind: 'image', score: 0.9 },
              usage: 'optional',
            },
            {
              asset: { id: 'required-1', filename: 'required.mp4', path: '/library/required.mp4', kind: 'video', score: 0.8 },
              usage: 'required',
              trimStartMs: 1_500,
            },
          ],
        })}
        onLatest={(planValue) => { latest = planValue; }}
      />,
    ));
    await openShotCard();
    const standalonePill = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '独立素材')!;
    await act(async () => standalonePill.click());

    expect(latest!.segments[0].compositionAssets).toEqual([expect.objectContaining({
      usage: 'required',
      trimStartMs: 1_500,
      asset: expect.objectContaining({ id: 'required-1' }),
    })]);
    expect(latest!.segments[0].selectedFootage).toMatchObject({
      id: 'required-1', matchedSegmentStart: 1.5,
    });
  });

  it('Agent 合成卡展示核心状态，详情可编辑开放语义意图和执行退路', async () => {
    let latest: DirectorPlan | null = null;
    act(() => root.render(
      <EditableHarness
        initial={footageSegment({
          visualType: 'motion',
          renderStrategy: 'agent-composite',
          mediaRole: 'evidence',
          carrier: 'data-hero',
          compositionIntent: {
            narrativeGoal: '真实道路画面建立可信度，Motion 只负责给出结论',
            focalPriority: '先看车辆，再看观点',
            temporalRelationship: '中段进入结论',
            mustShow: ['世界第91位'],
            avoid: ['广告式陈列'],
          },
          compositionAssets: [{
            asset: {
              id: 'locked-1', filename: 'road.mp4', path: '/library/road.mp4', kind: 'video', score: 0.72,
              thumbnailFile: '/library/road.jpg',
            },
            usage: 'required',
            trimStartMs: 2_000,
          }],
          fallbackPolicy: 'block',
        })}
        onLatest={(planValue) => { latest = planValue; }}
      />,
    ));

    const card = container.querySelector('[data-testid="director-shot-card"]')!;
    expect(card.getAttribute('data-render-strategy')).toBe('agent-composite');
    expect(card.textContent).toContain('Agent 合成');
    expect(card.textContent).toContain('必用素材 1');
    expect(card.textContent).toContain('真实道路画面建立可信度');
    expect(card.textContent).toContain('事实证据');

    await openShotCard();
    const intentEditor = container.querySelector('[data-testid="composition-intent-editor"]')!;
    expect(intentEditor).not.toBeNull();
    const mustShow = intentEditor.querySelector<HTMLTextAreaElement>('textarea[aria-label="必须呈现"]')!;
    const mediaIndispensability = intentEditor.querySelector<HTMLTextAreaElement>('textarea[aria-label="素材不可替代"]')!;
    const graphicsIndispensability = intentEditor.querySelector<HTMLTextAreaElement>('textarea[aria-label="信息层不可替代"]')!;
    const textareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      textareaSetter.call(mustShow, '世界第91位\n长期积累');
      mustShow.dispatchEvent(new Event('input', { bubbles: true }));
      textareaSetter.call(mediaIndispensability, '真实道路中的车辆状态不能由抽象图形替代');
      mediaIndispensability.dispatchEvent(new Event('input', { bubbles: true }));
      textareaSetter.call(graphicsIndispensability, '排名结论和因果关系必须由信息层补充');
      graphicsIndispensability.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(latest!.segments[0].compositionIntent?.mustShow).toEqual(['世界第91位', '长期积累']);
    expect(latest!.segments[0].mediaIndispensability).toBe('真实道路中的车辆状态不能由抽象图形替代');
    expect(latest!.segments[0].graphicsIndispensability).toBe('排名结论和因果关系必须由信息层补充');

    const fallback = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '仅保留素材')!;
    await act(async () => fallback.click());
    expect(latest!.segments[0].fallbackPolicy).toBe('standalone-media');
    expect(latest!.motionBible.carrierPlan[0]).toMatchObject({
      segmentId: 'seg-1',
      renderStrategy: 'agent-composite',
      compositionIntent: { mustShow: ['世界第91位', '长期积累'] },
      fallbackPolicy: 'standalone-media',
    });
  });

  it('完成编辑时提交包含最新修改的导演方案', async () => {
    let latest: DirectorPlan | null = null;
    let committed: DirectorPlan | null = null;
    let finishCommit: (() => void) | undefined;
    act(() => root.render(
      <EditableHarness
        initial={footageSegment()}
        onLatest={(planValue) => { latest = planValue; }}
        onCommit={(planValue) => new Promise<void>((resolve) => {
          committed = planValue;
          finishCommit = resolve;
        })}
      />,
    ));

    await openShotCard();
    const panel = container.querySelector('[data-testid="footage-segment-panel"]')!;
    const queryInput = panel.querySelector<HTMLInputElement>('input[aria-label="素材检索词"]')!;
    await act(async () => setInputValue(queryInput, '道路 实拍'));
    expect(latest!.segments[0].footageQuery).toBe('道路 实拍');

    const doneButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '完成')!;
    act(() => doneButton.click());
    expect(container.querySelector('[data-testid="director-shot-editor"]')).not.toBeNull();
    expect(container.textContent).toContain('保存中…');
    await act(async () => finishCommit?.());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 320)));
    expect(container.querySelector('[data-testid="director-shot-editor"]')).toBeNull();
    expect(committed!.segments[0].footageQuery).toBe('道路 实拍');
  });

  it('只查看镜头详情后关闭不会保存整份导演草案', async () => {
    const onCommit = vi.fn();
    act(() => root.render(
      <EditableHarness
        initial={footageSegment()}
        onLatest={() => undefined}
        onCommit={onCommit}
      />,
    ));

    await openShotCard();
    const doneButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '完成')!;
    await act(async () => doneButton.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 320)));

    expect(onCommit).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="director-shot-editor"]')).toBeNull();
  });

  it('导演任务运行时镜头详情只读，关闭不会提交旧草案', async () => {
    const onCommit = vi.fn();
    let latest: DirectorPlan | null = null;
    act(() => root.render(
      <EditableHarness
        initial={footageSegment()}
        onLatest={(planValue) => { latest = planValue; }}
        onCommit={onCommit}
        readOnly
      />,
    ));

    await openShotCard();
    const queryInput = container.querySelector<HTMLInputElement>('input[aria-label="素材检索词"]')!;
    expect(container.querySelector<HTMLFieldSetElement>('fieldset')?.disabled).toBe(true);
    await act(async () => setInputValue(queryInput, '不应写入'));
    expect(latest!.segments[0].footageQuery).toBe('城市夜景 车流');
    const doneButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '完成')!;
    await act(async () => doneButton.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 320)));

    expect(onCommit).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="director-shot-editor"]')).toBeNull();
  });
});
