import { describe, expect, it } from 'vitest';
import {
  applyProductionMutation,
  ProductionRevisionConflictError,
  ProductionTaskConflictError,
} from '../src/lib/production-mutations';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import type { DirectorPlan } from '../src/types/director';

function draft(revision = 1): DirectorPlan {
  return {
    revision,
    inputFingerprint: `source-${revision}`,
    title: '测试作品标题是否合规',
    summary: '本测试验证导演模式的原子审批、版本门禁和后续制作状态是否按预期一致更新。',
    keywords: [],
    segments: [{
      id: 'seg-1',
      title: '第一镜头',
      summary: '建立主题',
      startMs: 0,
      endMs: 5_000,
      semanticType: 'explanation',
      complexityLevel: 'medium',
      visualizationScore: 70,
      pacingNeed: 'steady',
      keywords: [],
      entities: [],
      visualType: 'motion',
      enabled: true,
      purpose: 'context',
      carrier: 'concept',
      intensity: 2,
      rationale: '测试有效导演方案的原子审批',
    }],
    motionBible: {
      visualThesis: '视觉命题',
      rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
      carrierPlan: [],
      styleRules: { paletteUse: '系统蓝', typographyUse: '短标题' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '封面，主标题“测试作品标题是否合规”', composition: '居中' },
    audioDirection: { bgmStyle: '克制', energy: 2, soundDensity: 'balanced' },
    warnings: [],
    zeroCompositeReason: '本测试草案仅验证 Motion 镜头的原子审批契约，不需要真实素材与信息层同场表达。',
    agentPlanning: {
      roleVersion: '5', workflowVersion: '5', completedAt: 10,
      toolCalls: 12, repairRounds: 0,
    },
    createdAt: 10,
    updatedAt: 10,
  };
}

describe('production mutations', () => {
  it('replaces a draft without mutating the approved revision', () => {
    const empty = createEmptyProductionState(1);
    const base = {
      ...empty,
      approvedPlan: draft(1),
      outputs: {
        ...empty.outputs,
        cards: {
          status: 'failed' as const,
          directorRevision: 1,
          updatedAt: 12,
          error: '28 个镜头生成失败',
        },
        footage: {
          status: 'generating' as const,
          directorRevision: 1,
          updatedAt: 11,
          error: '旧任务仍在保存',
        },
      },
      workflow: {
        ...empty.workflow,
        stage: 'error' as const,
        activeTaskId: 'failed-production',
        error: '素材产物尚未就绪',
        failedStage: 'production-running' as const,
      },
    };
    const next = applyProductionMutation(base, { kind: 'replace-draft', plan: draft(2) }, 20);
    expect(next.draftPlan?.revision).toBe(2);
    expect(next.approvedPlan?.revision).toBe(1);
    expect(next.workflow.stage).toBe('director-review');
    expect(next.workflow.activeTaskId).toBeUndefined();
    expect(next.workflow.error).toBeUndefined();
    expect(next.workflow.failedStage).toBeUndefined();
    expect(next.outputs.footage).toEqual({
      status: 'stale',
      directorRevision: 1,
      updatedAt: 20,
      error: undefined,
    });
    expect(next.outputs.cards).toEqual(base.outputs.cards);
  });

  it('approves the expected draft and starts production atomically', () => {
    const base = { ...createEmptyProductionState(1), draftPlan: draft(1) };
    const next = applyProductionMutation(base, { kind: 'approve-draft', expectedRevision: 1 }, 30);
    expect(next.draftPlan).toBeNull();
    expect(next.approvedPlan).toMatchObject({ revision: 1, approvedAt: 30 });
    expect(next.workflow).toMatchObject({ stage: 'production-running', directorApprovedAt: 30 });
    expect(next.outputs.cards.status).toBe('generating');
  });

  it.each([
    ['v2', { roleVersion: '2', workflowVersion: '2' }, '角色 v2 · 工作流 v2'],
    ['无版本', undefined, '角色 v未记录 · 工作流 v未记录'],
    ['仅工作流过旧', { roleVersion: '5', workflowVersion: '4' }, '角色 v5 · 工作流 v4'],
  ])('在 director 模式的原子审批边界拒绝%s Show Director 草案', (_label, version, expected) => {
    const legacy = draft(1);
    legacy.agentPlanning = version
      ? {
          ...legacy.agentPlanning!,
          ...version,
        }
      : undefined;
    const base = { ...createEmptyProductionState(1), draftPlan: legacy };

    expect(() => applyProductionMutation(
      base,
      { kind: 'approve-draft', expectedRevision: 1 },
      30,
    )).toThrow(`旧版导演草案不能直接批准（${expected}）`);
  });

  it('保留 auto 模式对旧版草案的兼容审批', () => {
    const legacy = { ...draft(1), agentPlanning: undefined };
    const empty = createEmptyProductionState(1);
    const base = {
      ...empty,
      draftPlan: legacy,
      workflow: { ...empty.workflow, mode: 'auto' as const },
    };

    const next = applyProductionMutation(base, { kind: 'approve-draft', expectedRevision: 1 }, 30);
    expect(next.approvedPlan).toMatchObject({ revision: 1, approvedAt: 30 });
  });

  it.each([
    ['v2', { roleVersion: '2', workflowVersion: '2' }, '角色 v2 · 工作流 v2'],
    ['无版本', undefined, '角色 v未记录 · 工作流 v未记录'],
  ])('在 director 模式的共享 mutation 边界拒绝继续%s approvedPlan', (_label, version, expected) => {
    const approved = draft(1);
    approved.agentPlanning = version
      ? { ...approved.agentPlanning!, ...version }
      : undefined;
    const empty = createEmptyProductionState(1);
    const base = {
      ...empty,
      approvedPlan: { ...approved, approvedAt: 20 },
      workflow: { ...empty.workflow, stage: 'production-paused' as const },
    };

    expect(() => applyProductionMutation(base, {
      kind: 'set-workflow', stage: 'production-running', taskId: 'resume-task',
    }, 30)).toThrow(`旧版导演方案不能继续制作（${expected}）`);
  });

  it('保留 auto 模式对旧版 approvedPlan 的继续制作兼容', () => {
    const legacy = { ...draft(1), agentPlanning: undefined, approvedAt: 20 };
    const empty = createEmptyProductionState(1);
    const base = {
      ...empty,
      approvedPlan: legacy,
      workflow: { ...empty.workflow, mode: 'auto' as const, stage: 'production-paused' as const },
    };

    const next = applyProductionMutation(base, {
      kind: 'set-workflow', stage: 'production-running', taskId: 'resume-task',
    }, 30);
    expect(next.workflow).toMatchObject({ mode: 'auto', stage: 'production-running', activeTaskId: 'resume-task' });
  });

  it('rejects approval when a legacy draft has no title or intro to recover', () => {
    const invalid = { ...draft(1), title: undefined, summary: '', segments: [] };
    const base = { ...createEmptyProductionState(1), draftPlan: invalid };

    expect(() => applyProductionMutation(
      base,
      { kind: 'approve-draft', expectedRevision: 1 },
      30,
    )).toThrow('导演方案缺少作品标题');
  });

  it('rejects stale approvals with an explicit revision conflict', () => {
    const base = { ...createEmptyProductionState(1), draftPlan: draft(2) };
    expect(() => applyProductionMutation(
      base,
      { kind: 'approve-draft', expectedRevision: 1 },
      30,
    )).toThrow(ProductionRevisionConflictError);
  });

  it('rejects standalone media that was not previewed and selected before approval', () => {
    const invalid = draft(1);
    invalid.segments[0] = {
      ...invalid.segments[0],
      visualType: 'footage',
      renderStrategy: 'standalone-media',
      carrier: 'footage',
    };
    const base = { ...createEmptyProductionState(1), draftPlan: invalid };

    expect(() => applyProductionMutation(
      base,
      { kind: 'approve-draft', expectedRevision: 1 },
      30,
    )).toThrow('必须预览并选定一项必用素材');
  });

  it('revalidates edited Agent composite fields at the atomic approval boundary', () => {
    const invalid = draft(1);
    invalid.segments[0] = {
      ...invalid.segments[0],
      visualType: 'footage',
      renderStrategy: 'agent-composite',
      carrier: 'concept',
      compositionAssets: [{
        usage: 'required',
        asset: { id: 'asset-1', filename: 'factory.mp4', path: '/library/factory.mp4', kind: 'video', score: 0.9 },
      }],
      assetDecisions: [{
        candidateId: 'asset-1', decision: 'selected', reason: '已预览', inspected: true,
      }],
      fallbackPolicy: 'block',
      compositionIntent: undefined,
      mediaIndispensability: '真实动作提供证据',
      graphicsIndispensability: '图形解释提供结论',
    };
    const base = { ...createEmptyProductionState(1), draftPlan: invalid };

    expect(() => applyProductionMutation(
      base,
      { kind: 'approve-draft', expectedRevision: 1 },
      30,
    )).toThrow('合成意图不完整');
  });

  it('updates one output without losing concurrent output state', () => {
    const base = createEmptyProductionState(1);
    base.outputs.cover = { status: 'current', directorRevision: 1, updatedAt: 2 };
    const next = applyProductionMutation(base, {
      kind: 'set-output',
      output: 'cards',
      state: { status: 'failed', directorRevision: 1, updatedAt: 3, error: 'one card failed' },
    }, 4);
    expect(next.outputs.cover.status).toBe('current');
    expect(next.outputs.cards).toMatchObject({ status: 'failed', error: 'one card failed' });
  });

  it('invalidates cards and timeline atomically without changing their director revision', () => {
    const base = createEmptyProductionState(1);
    base.outputs.cards = { status: 'current', directorRevision: 3, updatedAt: 2 };
    base.outputs.timeline = { status: 'current', directorRevision: 3, updatedAt: 2 };
    base.outputs.cover = { status: 'current', directorRevision: 3, updatedAt: 2 };

    const next = applyProductionMutation(base, {
      kind: 'invalidate-outputs',
      outputs: ['cards', 'timeline'],
    }, 4);

    expect(next.outputs.cards).toEqual({ status: 'stale', directorRevision: 3, updatedAt: 4, error: undefined });
    expect(next.outputs.timeline).toEqual({ status: 'stale', directorRevision: 3, updatedAt: 4, error: undefined });
    expect(next.outputs.cover).toEqual(base.outputs.cover);
  });

  it('sets auto/director mode together with the persisted workflow stage', () => {
    const next = applyProductionMutation(createEmptyProductionState(1), {
      kind: 'set-workflow',
      mode: 'auto',
      stage: 'director-planning',
      taskId: 'task-1',
    }, 4);
    expect(next.workflow).toMatchObject({
      mode: 'auto',
      stage: 'director-planning',
      activeTaskId: 'task-1',
    });
  });

  it('rejects late artifact commits from an old revision or task', () => {
    const base = applyProductionMutation(
      { ...createEmptyProductionState(1), draftPlan: draft(2) },
      { kind: 'approve-draft', expectedRevision: 2, taskId: 'task-2' },
      2,
    );
    expect(() => applyProductionMutation(base, {
      kind: 'set-output', output: 'cards',
      state: { status: 'current', directorRevision: 1, updatedAt: 3 },
      expectedDirectorRevision: 1,
      expectedTaskId: 'task-2',
    }, 3)).toThrow(ProductionRevisionConflictError);
    expect(() => applyProductionMutation(base, {
      kind: 'set-output', output: 'cards',
      state: { status: 'current', directorRevision: 2, updatedAt: 3 },
      expectedDirectorRevision: 2,
      expectedTaskId: 'task-1',
    }, 3)).toThrow(ProductionTaskConflictError);
  });

  it('persists the automatic Animatic approval checkpoint before completion', () => {
    const approved = applyProductionMutation(
      { ...createEmptyProductionState(1), draftPlan: draft(1) },
      { kind: 'approve-draft', expectedRevision: 1, taskId: 'task-1' },
      2,
    );
    const review = applyProductionMutation(approved, {
      kind: 'set-workflow', stage: 'animatic-review', taskId: 'task-1',
      expectedDirectorRevision: 1,
      expectedTaskId: 'task-1',
    }, 3);
    expect(review.workflow.activeTaskId).toBeUndefined();
    const next = applyProductionMutation(review, {
      kind: 'approve-animatic', complete: true,
      expectedDirectorRevision: 1,
      expectedTaskId: 'task-1',
    }, 4);
    expect(next.workflow).toMatchObject({ stage: 'complete', animaticApprovedAt: 4 });
  });

  it('ends the active task when production reaches quality-blocked', () => {
    const base = createEmptyProductionState(1);
    base.workflow = {
      ...base.workflow,
      stage: 'production-running',
      activeTaskId: 'task-1',
    };
    base.outputs.cards = { status: 'generating', directorRevision: 1, updatedAt: 2 };

    const next = applyProductionMutation(base, {
      kind: 'set-workflow',
      stage: 'quality-blocked',
      taskId: 'task-1',
      error: '卡片质量门禁未通过',
    }, 3);

    expect(next.workflow).toMatchObject({
      stage: 'quality-blocked', error: '卡片质量门禁未通过', failedStage: 'production-running',
    });
    expect(next.workflow.activeTaskId).toBeUndefined();
    expect(next.outputs.cards.status).toBe('stale');
  });

  it('turns in-flight outputs stale when production is paused', () => {
    const base = createEmptyProductionState(1);
    base.workflow = {
      ...base.workflow,
      stage: 'production-running',
      activeTaskId: 'task-1',
      error: '旧错误',
      failedStage: 'director-planning',
    };
    base.outputs.cards = { status: 'generating', directorRevision: 1, updatedAt: 2 };
    base.outputs.footage = {
      status: 'generating', directorRevision: 1, updatedAt: 2, error: '未完成',
    };
    base.outputs.cover = { status: 'current', directorRevision: 1, updatedAt: 2 };
    const next = applyProductionMutation(base, {
      kind: 'set-workflow', stage: 'production-paused', taskId: 'must-not-remain-active',
    }, 3);
    expect(next.outputs.cards).toEqual({
      status: 'stale', directorRevision: 1, updatedAt: 3, error: undefined,
    });
    expect(next.outputs.footage).toEqual({
      status: 'stale', directorRevision: 1, updatedAt: 3, error: undefined,
    });
    expect(next.outputs.cover.status).toBe('current');
    expect(next.workflow).toMatchObject({ stage: 'production-paused' });
    expect(next.workflow.activeTaskId).toBeUndefined();
    expect(next.workflow.error).toBeUndefined();
    expect(next.workflow.failedStage).toBeUndefined();
  });

  it('settles every in-flight output atomically when production enters error', () => {
    const base = createEmptyProductionState(1);
    base.workflow = {
      ...base.workflow,
      stage: 'production-running',
      activeTaskId: 'task-1',
    };
    base.outputs.cards = {
      status: 'generating', directorRevision: 1, updatedAt: 2, error: '旧卡片错误',
    };
    base.outputs.footage = { status: 'generating', directorRevision: 1, updatedAt: 2 };
    base.outputs.audio = { status: 'failed', directorRevision: 1, updatedAt: 2, error: '音频失败' };

    const next = applyProductionMutation(base, {
      kind: 'set-workflow', stage: 'error', taskId: 'task-1', error: '制作失败',
    }, 3);

    expect(next.outputs.cards).toEqual({
      status: 'stale', directorRevision: 1, updatedAt: 3, error: undefined,
    });
    expect(next.outputs.footage).toEqual({
      status: 'stale', directorRevision: 1, updatedAt: 3, error: undefined,
    });
    expect(next.outputs.audio).toEqual(base.outputs.audio);
    expect(next.workflow).toMatchObject({
      stage: 'error', error: '制作失败', failedStage: 'production-running',
    });
    expect(next.workflow.activeTaskId).toBeUndefined();
  });

  it('repairs legacy generating output state on any mutation outside production-running', () => {
    const base = createEmptyProductionState(1);
    base.workflow = { ...base.workflow, stage: 'director-review' };
    base.outputs.footage = { status: 'generating', directorRevision: 1, updatedAt: 2 };

    const next = applyProductionMutation(base, {
      kind: 'set-output',
      output: 'cards',
      state: { status: 'generating', directorRevision: 2, updatedAt: 3 },
    }, 4);

    expect(next.outputs.footage).toEqual({
      status: 'stale', directorRevision: 1, updatedAt: 4, error: undefined,
    });
    expect(next.outputs.cards).toEqual({
      status: 'stale', directorRevision: 2, updatedAt: 4, error: undefined,
    });
  });

  it('keeps in-flight output state while a production task is still running', () => {
    const base = createEmptyProductionState(1);
    base.workflow = {
      ...base.workflow,
      stage: 'production-running',
      activeTaskId: 'task-1',
    };

    const next = applyProductionMutation(base, {
      kind: 'set-output',
      output: 'footage',
      state: { status: 'generating', directorRevision: 1, updatedAt: 2 },
      expectedTaskId: 'task-1',
    }, 3);

    expect(next.outputs.footage).toEqual({
      status: 'generating', directorRevision: 1, updatedAt: 2,
    });
  });
});
