// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectorWorkbench } from '../src/pages/DirectorWorkbench';
import { MotionProvider } from '../src/ui/lib/motion';
import type { DirectorPlan, ProjectProductionState } from '../src/types/director';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const generatePlan = vi.fn(async () => undefined);
const saveDraft = vi.fn(async () => undefined);
const approveAndProduce = vi.fn(async () => undefined);
let workspaceWorking = false;
let workspacePlanning = false;
let workspaceProducing = false;
let workspaceError: string | null = null;
let workspaceDraftSaveStatus: 'idle' | 'saving' | 'saved' | 'error' = 'idle';

function draftPlan(): DirectorPlan {
  return {
    revision: 1,
    inputFingerprint: 'draft',
    title: '世界第91位不是突然发生的',
    summary: '从具体产品与长期积累出发，说明全球排名背后真正值得关注的产业变化与时间力量。',
    keywords: ['汽车'],
    userPrompt: '优先使用真实汽车素材',
    globalPrompt: '优先使用真实汽车素材',
    segments: [{
      id: 'seg-1', title: '汽车观点', summary: '解释观点', startMs: 0, endMs: 5_000,
      semanticType: 'narration', complexityLevel: 'medium', visualizationScore: 60,
      pacingNeed: 'steady', keywords: ['汽车'], entities: [], visualType: 'motion',
      enabled: true, purpose: 'explain', carrier: 'concept', intensity: 3,
      composition: 'graphic', cameraMove: 'static', mediaRole: 'context', rationale: '测试',
    }],
    motionBible: {
      visualThesis: '视觉命题',
      rhythm: { density: 'balanced', heavySegments: ['seg-1'], quietSegments: [] },
      carrierPlan: [],
      styleRules: { paletteUse: '蓝', typographyUse: '短标题' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '封面', composition: '居中' },
    audioDirection: {
      bgmEnabled: false, soundEffectsEnabled: false,
      bgmStyle: '', energy: 1, soundDensity: 'quiet',
    },
    warnings: [],
    zeroCompositeReason: '逐段检查后，本测试草案仅验证版本门禁，不包含需要素材与信息层同场表达的镜头。',
    agentPlanning: {
      roleVersion: '5', workflowVersion: '5', completedAt: 1,
      toolCalls: 12, repairRounds: 0,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

const production: ProjectProductionState = {
  version: 3,
  draftPlan: draftPlan(),
  approvedPlan: null,
  execution: null,
  workflow: { mode: 'director', stage: 'director-review', updatedAt: 1 },
  pendingImpact: null,
  outputs: {
    cards: { status: 'empty', updatedAt: 1 },
    cover: { status: 'empty', updatedAt: 1 },
    audio: { status: 'empty', updatedAt: 1 },
    timeline: { status: 'empty', updatedAt: 1 },
    footage: { status: 'empty', updatedAt: 1 },
  },
  legacyProtected: false,
  updatedAt: 1,
};

vi.mock('../src/hooks/useDirectorWorkspace', () => ({
  useDirectorWorkspace: () => ({
    production,
    loading: false,
    working: workspaceWorking,
    planning: workspacePlanning,
    producing: workspaceProducing,
    cancelling: false,
    error: workspaceError,
    progress: {},
    draftSaveStatus: workspaceDraftSaveStatus,
    generatePlan,
    saveDraft,
    approveAndProduce,
    resume: vi.fn(),
    cancel: vi.fn(),
    approveAnimatic: vi.fn(),
    reload: vi.fn(),
  }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  generatePlan.mockClear();
  saveDraft.mockClear();
  approveAndProduce.mockClear();
  production.draftPlan = draftPlan();
  production.approvedPlan = null;
  production.workflow = { mode: 'director', stage: 'director-review', updatedAt: 1 };
  workspaceWorking = false;
  workspacePlanning = false;
  workspaceProducing = false;
  workspaceError = null;
  workspaceDraftSaveStatus = 'idle';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('导演台重新编排', () => {
  it('展示并允许审核作品标题与简介', async () => {
    await act(async () => {
      root.render(
        <MotionProvider>
          <DirectorWorkbench projectDir="/tmp/project" setPage={vi.fn()} />
        </MotionProvider>,
      );
    });

    expect(container.textContent).toContain('作品标题');
    expect(container.textContent).toContain('作品简介');
    expect(container.textContent).toContain('正在审阅的导演草案');
    expect(container.textContent).toContain('下方内容只是导演规划，批准后才会开始生成真实画面');
    expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('世界第91位不是突然发生的');
  });

  it('有已批准版本时明确区分当前成片与正在编辑的草案', async () => {
    production.approvedPlan = { ...draftPlan(), revision: 1 };
    production.draftPlan = { ...draftPlan(), revision: 2 };
    await act(async () => {
      root.render(
        <MotionProvider>
          <DirectorWorkbench projectDir="/tmp/project" setPage={vi.fn()} />
        </MotionProvider>,
      );
    });

    expect(container.textContent).toContain('草案 v2');
    expect(container.textContent).toContain('当前成片仍使用批准 v1');
    expect(container.textContent).not.toContain('当前批准方案v1');
  });

  it('明确提示旧导演引擎方案，并从提示区直接重新编排', async () => {
    production.draftPlan = {
      ...draftPlan(),
      revision: 2,
      agentPlanning: {
        roleVersion: '2', workflowVersion: '2', completedAt: 2,
        toolCalls: 18, repairRounds: 1,
      },
    };
    await act(async () => {
      root.render(
        <MotionProvider>
          <DirectorWorkbench projectDir="/tmp/project" setPage={vi.fn()} />
        </MotionProvider>,
      );
    });

    const warning = container.querySelector('[data-testid="legacy-director-plan-warning"]')!;
    expect(warning.textContent).toContain('草案 v2 是方案修订号，不是导演引擎版本');
    expect(warning.textContent).toContain('角色 v2 · 工作流 v2');
    const approveButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('批准并开始制作'))!;
    expect(approveButton.disabled).toBe(true);
    const replanButton = [...warning.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('用当前导演重新编排'))!;
    await act(async () => replanButton.click());
    expect(generatePlan).toHaveBeenCalledWith('优先使用真实汽车素材');
  });

  it('最老的无版本方案和仅角色版本落后都必须重新编排，不能直接批准', async () => {
    production.draftPlan = { ...draftPlan(), agentPlanning: undefined };
    await act(async () => {
      root.render(
        <MotionProvider>
          <DirectorWorkbench projectDir="/tmp/project" setPage={vi.fn()} />
        </MotionProvider>,
      );
    });

    let warning = container.querySelector('[data-testid="legacy-director-plan-warning"]')!;
    expect(warning.textContent).toContain('角色 v未记录 · 工作流 v未记录');
    let approveButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('批准并开始制作'))!;
    expect(approveButton.disabled).toBe(true);
    expect(approveButton.title).toContain('重新编排旧版草案');

    production.draftPlan = {
      ...draftPlan(),
      agentPlanning: {
        roleVersion: '2', workflowVersion: '5', completedAt: 2,
        toolCalls: 18, repairRounds: 1,
      },
    };
    await act(async () => {
      root.render(
        <MotionProvider>
          <DirectorWorkbench projectDir="/tmp/project" setPage={vi.fn()} />
        </MotionProvider>,
      );
    });

    warning = container.querySelector('[data-testid="legacy-director-plan-warning"]')!;
    expect(warning.textContent).toContain('角色 v2 · 工作流 v5');
    approveButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('批准并开始制作'))!;
    expect(approveButton.disabled).toBe(true);
  });

  it('新版角色与工作流方案不显示旧版门禁', async () => {
    await act(async () => {
      root.render(
        <MotionProvider>
          <DirectorWorkbench projectDir="/tmp/project" setPage={vi.fn()} />
        </MotionProvider>,
      );
    });

    expect(container.querySelector('[data-testid="legacy-director-plan-warning"]')).toBeNull();
    const approveButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('批准并开始制作'))!;
    expect(approveButton.disabled).toBe(false);
  });

  it('已有批准方案重新编排时只显示规划态，不误显示制作轨和暂停按钮', async () => {
    production.approvedPlan = { ...draftPlan(), revision: 1, approvedAt: 2 };
    production.draftPlan = { ...draftPlan(), revision: 2 };
    workspaceWorking = true;
    workspacePlanning = true;
    workspaceProducing = false;

    await act(async () => {
      root.render(
        <MotionProvider>
          <DirectorWorkbench projectDir="/tmp/project" setPage={vi.fn()} />
        </MotionProvider>,
      );
    });

    expect(container.textContent).not.toContain('暂停制作');
    expect(container.textContent).not.toContain('正在按导演方案制作');
    expect(container.textContent).not.toContain('等待开始');
    expect(container.textContent).not.toContain('旧批准 v1 的制作结果');
    expect(container.textContent).toContain('导演规划中');
    const replanButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((item) => item.textContent?.includes('重新编排'))!;
    expect(replanButton.disabled).toBe(true);
  });

  it('Pi 导演规划中镜头详情只读，关闭不会保存旧草案', async () => {
    workspaceWorking = true;
    workspacePlanning = true;

    await act(async () => {
      root.render(
        <MotionProvider>
          <DirectorWorkbench projectDir="/tmp/project" setPage={vi.fn()} />
        </MotionProvider>,
      );
    });

    const shotCard = container.querySelector<HTMLButtonElement>('[data-testid="director-shot-card"]')!;
    await act(async () => shotCard.click());
    expect(container.querySelector<HTMLFieldSetElement>('[data-testid="director-shot-editor"] fieldset')?.disabled).toBe(true);

    const doneButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '完成')!;
    await act(async () => doneButton.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 320)));

    expect(saveDraft).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="director-shot-editor"]')).toBeNull();
  });

  it('审阅新草案时默认收起旧批准版本的失败结果，按需才展开', async () => {
    production.approvedPlan = { ...draftPlan(), revision: 1, approvedAt: 2 };
    production.draftPlan = { ...draftPlan(), revision: 2 };
    production.workflow = { ...production.workflow, stage: 'animatic-review' };

    await act(async () => {
      root.render(
        <MotionProvider>
          <DirectorWorkbench projectDir="/tmp/project" setPage={vi.fn()} />
        </MotionProvider>,
      );
    });

    expect(container.textContent).toContain('旧批准 v1 的制作结果');
    expect(container.textContent).toContain('不属于当前草案 v2');
    expect(container.textContent).not.toContain('制作执行');

    const showButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((item) => item.textContent?.includes('查看旧版结果'))!;
    await act(async () => showButton.click());

    expect(container.textContent).toContain('历史结果 · 只读');
    expect(container.textContent).toContain('导演方案 v1');
    expect(container.textContent).not.toContain('进入编辑器审查');
    const executionTabs = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .map((button) => button.textContent?.trim());
    expect(executionTabs).not.toContain('声音');
    expect(executionTabs).not.toContain('质检');
  });

  it('导演草案 revision 变化后再次默认收起旧版结果', async () => {
    production.approvedPlan = { ...draftPlan(), revision: 1, approvedAt: 2 };
    production.draftPlan = { ...draftPlan(), revision: 2 };

    await act(async () => {
      root.render(
        <MotionProvider>
          <DirectorWorkbench projectDir="/tmp/project" setPage={vi.fn()} />
        </MotionProvider>,
      );
    });
    const showButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((item) => item.textContent?.includes('查看旧版结果'))!;
    await act(async () => showButton.click());
    expect(container.textContent).toContain('历史结果 · 只读');

    production.draftPlan = { ...draftPlan(), revision: 3 };
    await act(async () => {
      root.render(
        <MotionProvider>
          <DirectorWorkbench projectDir="/tmp/project" setPage={vi.fn()} />
        </MotionProvider>,
      );
    });

    expect(container.textContent).toContain('不属于当前草案 v3');
    expect(container.textContent).not.toContain('历史结果 · 只读');
    expect(container.textContent).toContain('查看旧版结果');
  });

  it('修改作品标题时同步导演草案中的封面标题', async () => {
    await act(async () => {
      root.render(
        <MotionProvider>
          <DirectorWorkbench projectDir="/tmp/project" setPage={vi.fn()} />
        </MotionProvider>,
      );
    });
    const titleInput = [...container.querySelectorAll<HTMLInputElement>('input')]
      .find((input) => input.value === '世界第91位不是突然发生的')!;

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        titleInput,
        '世界第91位来自长期积累',
      );
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const coverPrompt = [...container.querySelectorAll<HTMLTextAreaElement>('textarea')]
      .find((textarea) => textarea.value.includes('画面唯一文字标题'))?.value;
    expect(coverPrompt).toContain('“世界第91位来自长期积累”');
    expect(coverPrompt).not.toContain('世界第91位不是突然发生的');
  });

  it('草案存在时可用原创作要求一键重新生成镜头分配', async () => {
    await act(async () => {
      root.render(
        <MotionProvider>
          <DirectorWorkbench projectDir="/tmp/project" setPage={vi.fn()} />
        </MotionProvider>,
      );
    });
    const button = [...container.querySelectorAll('button')]
      .find((item) => item.textContent?.includes('重新编排'));
    expect(button).toBeDefined();

    await act(async () => button!.click());

    expect(generatePlan).toHaveBeenCalledWith('优先使用真实汽车素材');
  });

  it('不会把 AI 自己生成的整片方向当成用户要求回注重新编排', async () => {
    production.draftPlan = {
      ...draftPlan(),
      userPrompt: undefined,
      globalPrompt: '抽象车辆、非写实 MG，全片优先使用 Motion 卡',
    };
    await act(async () => {
      root.render(
        <MotionProvider>
          <DirectorWorkbench projectDir="/tmp/project" setPage={vi.fn()} />
        </MotionProvider>,
      );
    });

    const button = [...container.querySelectorAll('button')]
      .find((item) => item.textContent?.includes('重新编排'))!;
    await act(async () => button.click());

    expect(generatePlan).toHaveBeenCalledWith(undefined);
  });

  it('重新编排会等待未保存草案落盘后再启动 Pi 导演', async () => {
    let finishSave: (() => void) | undefined;
    saveDraft.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    await act(async () => {
      root.render(
        <MotionProvider>
          <DirectorWorkbench projectDir="/tmp/project" setPage={vi.fn()} />
        </MotionProvider>,
      );
    });
    const titleInput = [...container.querySelectorAll<HTMLInputElement>('input')]
      .find((input) => input.value === '世界第91位不是突然发生的')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        titleInput,
        '世界第91位来自长期积累',
      );
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const button = [...container.querySelectorAll('button')]
      .find((item) => item.textContent?.includes('重新编排'))!;

    act(() => button.click());
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(generatePlan).not.toHaveBeenCalled();

    await act(async () => finishSave?.());
    expect(generatePlan).toHaveBeenCalledWith('优先使用真实汽车素材');
  });

  it('草案保存失败时优先显示失败状态，不被未保存提示覆盖', async () => {
    workspaceDraftSaveStatus = 'error';
    workspaceError = '写入项目文件失败';
    await act(async () => {
      root.render(
        <MotionProvider>
          <DirectorWorkbench projectDir="/tmp/project" setPage={vi.fn()} />
        </MotionProvider>,
      );
    });

    const titleInput = [...container.querySelectorAll<HTMLInputElement>('input')]
      .find((input) => input.value === '世界第91位不是突然发生的')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        titleInput,
        '世界第91位来自长期积累',
      );
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.textContent).toContain('导演草案保存失败，修改仍保留在当前页面');
    expect(container.textContent).not.toContain('导演草案有未保存修改');
    expect(container.textContent).toContain('写入项目文件失败');
  });

  it('Agent 合成镜头未选素材时禁止批准制作', async () => {
    production.draftPlan = {
      ...draftPlan(),
      segments: [{
        ...draftPlan().segments[0],
        visualType: 'footage',
        renderStrategy: 'agent-composite',
        compositionAssets: [],
        compositionIntent: {
          narrativeGoal: '让真实汽车素材与观点形成同场论证',
          focalPriority: '先看真实汽车，再读观点关系',
          temporalRelationship: '素材先建立，信息层随后回应并收束',
          mustShow: ['真实汽车素材', '观点关系'],
          avoid: ['伪造事实画面'],
        },
        mediaIndispensability: '真实汽车素材提供不可替代的对象证据。',
        graphicsIndispensability: '信息层提供素材本身无法表达的观点关系。',
        fallbackPolicy: 'block',
      }],
    };

    await act(async () => {
      root.render(
        <MotionProvider>
          <DirectorWorkbench projectDir="/tmp/project" setPage={vi.fn()} />
        </MotionProvider>,
      );
    });

    const approveButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((item) => item.textContent?.includes('批准并开始制作'))!;
    expect(approveButton.disabled).toBe(true);
    expect(container.textContent).toContain('镜头“汽车观点”缺少必用真实素材');

    await act(async () => approveButton.click());
    expect(approveAndProduce).not.toHaveBeenCalled();
  });
});
