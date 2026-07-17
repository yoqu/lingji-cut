import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import type { DirectorPlan, ProjectProductionState } from '../src/types/director';

const runProduction = vi.fn();
vi.mock('../src/lib/director-production-client', () => ({
  runDirectorProductionClient: (...args: unknown[]) => runProduction(...args),
}));

import { runAutoDirectorOrchestrator } from '../src/lib/auto-director-orchestrator';

function plan(): DirectorPlan {
  return {
    revision: 1, inputFingerprint: 'source', summary: '摘要', keywords: [], segments: [],
    motionBible: {
      visualThesis: '命题', rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
      carrierPlan: [], styleRules: { paletteUse: '蓝', typographyUse: '短标题' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '封面', composition: '居中' },
    audioDirection: { bgmStyle: '克制', energy: 2, soundDensity: 'balanced' },
    warnings: [], createdAt: 1, updatedAt: 1,
  };
}

function projectJson(production: ProjectProductionState): string {
  return JSON.stringify({ version: 3, production });
}

describe('auto director orchestrator', () => {
  const api = {
    loadProject: vi.fn(),
    onDirectorPlanProgress: vi.fn(() => vi.fn()),
    startDirectorPlan: vi.fn(),
    approveDirectorPlanAndStartProduction: vi.fn(),
    resumeProduction: vi.fn(),
    generateAICardForSegment: vi.fn(),
    regenerateCoverPrompt: vi.fn(),
    generateCoverImages: vi.fn(),
    createSunoMusic: vi.fn(),
    createSunoSound: vi.fn(),
  };

  beforeEach(() => {
    runProduction.mockReset();
    Object.values(api).forEach((mock) => mock.mockReset());
    api.onDirectorPlanProgress.mockImplementation(() => vi.fn());
    Object.assign(globalThis, { window: { electronAPI: api } });
    const empty = createEmptyProductionState(1);
    api.loadProject.mockResolvedValue(projectJson(empty));
    api.startDirectorPlan.mockResolvedValue({
      ...empty,
      draftPlan: plan(),
      workflow: { ...empty.workflow, stage: 'director-review', activeTaskId: 'task-1' },
    });
  });

  it('stops at director review without starting any production track', async () => {
    const result = await runAutoDirectorOrchestrator({
      projectDir: '/project', entries: [], settings: {} as never,
      taskId: 'task-1', mode: 'director', startAt: 'director',
    });
    expect(result.checkpoint).toBe('director-review');
    expect(api.approveDirectorPlanAndStartProduction).not.toHaveBeenCalled();
    expect(runProduction).not.toHaveBeenCalled();
    expect(api.generateAICardForSegment).not.toHaveBeenCalled();
    expect(api.regenerateCoverPrompt).not.toHaveBeenCalled();
    expect(api.generateCoverImages).not.toHaveBeenCalled();
    expect(api.createSunoMusic).not.toHaveBeenCalled();
    expect(api.createSunoSound).not.toHaveBeenCalled();
  });

  it('auto-approves the director checkpoint before invoking the shared runner', async () => {
    const approved = {
      ...createEmptyProductionState(2),
      approvedPlan: { ...plan(), approvedAt: 2 },
      workflow: {
        ...createEmptyProductionState(2).workflow,
        mode: 'auto' as const,
        stage: 'production-running' as const,
        activeTaskId: 'task-1',
      },
    };
    const complete = {
      ...approved,
      workflow: { ...approved.workflow, stage: 'complete' as const, animaticApprovedAt: 3 },
    };
    api.approveDirectorPlanAndStartProduction.mockResolvedValue(approved);
    runProduction.mockResolvedValue(complete);
    const result = await runAutoDirectorOrchestrator({
      projectDir: '/project', entries: [], settings: {} as never,
      taskId: 'task-1', mode: 'auto', startAt: 'director',
    });
    expect(api.approveDirectorPlanAndStartProduction).toHaveBeenCalledWith('/project', 1, 'task-1');
    expect(runProduction).toHaveBeenCalledOnce();
    expect(api.startDirectorPlan.mock.invocationCallOrder[0])
      .toBeLessThan(api.approveDirectorPlanAndStartProduction.mock.invocationCallOrder[0]);
    expect(api.approveDirectorPlanAndStartProduction.mock.invocationCallOrder[0])
      .toBeLessThan(runProduction.mock.invocationCallOrder[0]);
    expect(result.checkpoint).toBe('complete');
  });

  it('stops at the new draft when revising an already approved plan', async () => {
    const existing = {
      ...createEmptyProductionState(2),
      approvedPlan: { ...plan(), approvedAt: 2 },
      workflow: {
        ...createEmptyProductionState(2).workflow,
        stage: 'complete' as const,
      },
    };
    const revised = {
      ...existing,
      draftPlan: { ...plan(), revision: 2, inputFingerprint: 'source-2' },
      workflow: {
        ...existing.workflow,
        stage: 'director-review' as const,
        activeTaskId: 'task-2',
      },
    };
    api.loadProject.mockResolvedValue(projectJson(existing));
    api.startDirectorPlan.mockResolvedValue(revised);

    const result = await runAutoDirectorOrchestrator({
      projectDir: '/project', entries: [], settings: {} as never,
      taskId: 'task-2', mode: 'director', startAt: 'director',
    });

    expect(result).toMatchObject({
      checkpoint: 'director-review',
      production: { draftPlan: { revision: 2 }, approvedPlan: { revision: 1 } },
    });
    expect(api.resumeProduction).not.toHaveBeenCalled();
    expect(runProduction).not.toHaveBeenCalled();
  });
});
