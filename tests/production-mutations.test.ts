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
    summary: '摘要',
    keywords: [],
    segments: [],
    motionBible: {
      visualThesis: '视觉命题',
      rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
      carrierPlan: [],
      styleRules: { paletteUse: '系统蓝', typographyUse: '短标题' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '封面', composition: '居中' },
    audioDirection: { bgmStyle: '克制', energy: 2, soundDensity: 'balanced' },
    warnings: [],
    createdAt: 10,
    updatedAt: 10,
  };
}

describe('production mutations', () => {
  it('replaces a draft without mutating the approved revision', () => {
    const base = { ...createEmptyProductionState(1), approvedPlan: draft(1) };
    const next = applyProductionMutation(base, { kind: 'replace-draft', plan: draft(2) }, 20);
    expect(next.draftPlan?.revision).toBe(2);
    expect(next.approvedPlan?.revision).toBe(1);
    expect(next.workflow.stage).toBe('director-review');
  });

  it('approves the expected draft and starts production atomically', () => {
    const base = { ...createEmptyProductionState(1), draftPlan: draft(1) };
    const next = applyProductionMutation(base, { kind: 'approve-draft', expectedRevision: 1 }, 30);
    expect(next.draftPlan).toBeNull();
    expect(next.approvedPlan).toMatchObject({ revision: 1, approvedAt: 30 });
    expect(next.workflow).toMatchObject({ stage: 'production-running', directorApprovedAt: 30 });
    expect(next.outputs.cards.status).toBe('generating');
  });

  it('rejects stale approvals with an explicit revision conflict', () => {
    const base = { ...createEmptyProductionState(1), draftPlan: draft(2) };
    expect(() => applyProductionMutation(
      base,
      { kind: 'approve-draft', expectedRevision: 1 },
      30,
    )).toThrow(ProductionRevisionConflictError);
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
    const next = applyProductionMutation(approved, {
      kind: 'approve-animatic', complete: true,
      expectedDirectorRevision: 1,
      expectedTaskId: 'task-1',
    }, 4);
    expect(next.workflow).toMatchObject({ stage: 'complete', animaticApprovedAt: 4 });
  });

  it('turns in-flight outputs stale when production is paused', () => {
    const base = createEmptyProductionState(1);
    base.outputs.cards = { status: 'generating', directorRevision: 1, updatedAt: 2 };
    base.outputs.cover = { status: 'current', directorRevision: 1, updatedAt: 2 };
    const next = applyProductionMutation(base, {
      kind: 'set-workflow', stage: 'production-paused',
    }, 3);
    expect(next.outputs.cards.status).toBe('stale');
    expect(next.outputs.cover.status).toBe('current');
  });
});
