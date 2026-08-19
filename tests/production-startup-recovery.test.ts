import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProductionStartupRecovery } from '../electron/production-startup-recovery';
import { loadProjectFile, saveProjectSection } from '../electron/project-file';
import { createDefaultProjectData, type ProjectData } from '../src/lib/project-persistence';
import { applyProductionMutation } from '../src/lib/production-mutations';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import type { DirectorPlan, ProjectProductionState } from '../src/types/director';

function runningProject(): ProjectData {
  const production = createEmptyProductionState(1);
  production.approvedPlan = { revision: 3 } as DirectorPlan;
  production.workflow = {
    ...production.workflow,
    stage: 'production-running',
    activeTaskId: 'task-old',
    updatedAt: 10,
  };
  production.outputs.footage = { status: 'generating', directorRevision: 3, updatedAt: 10 };
  return { ...createDefaultProjectData(), production };
}

function recoveryHarness(projectDir: string, initial = runningProject()) {
  let project = initial;
  const loadProject = vi.fn(async () => project);
  const pauseProduction = vi.fn(async (
    _projectDir: string,
    guard: { expectedDirectorRevision?: number; expectedTaskId?: string },
  ) => {
    const production = applyProductionMutation(project.production as ProjectProductionState, {
      kind: 'set-workflow',
      stage: 'production-paused',
      ...guard,
    }, 20);
    project = { ...project, production };
    return production;
  });
  return { projectDir, loadProject, pauseProduction, current: () => project };
}

describe('production startup recovery', () => {
  it('persists orphan recovery through the real project mutation path', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'production-recovery-'));
    try {
      await loadProjectFile(projectDir);
      const project = runningProject();
      await saveProjectSection(projectDir, 'production', project.production);
      const load = createProductionStartupRecovery({ getTask: () => undefined });

      const recovered = await load(projectDir);

      expect(recovered.production?.workflow.stage).toBe('production-paused');
      expect(recovered.production?.outputs.footage.status).toBe('stale');
      const persisted = JSON.parse(await fs.readFile(path.join(projectDir, 'project.json'), 'utf-8'));
      expect(persisted.production.workflow.stage).toBe('production-paused');
      expect(persisted.production.outputs.footage.status).toBe('stale');
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('pauses an orphan production-running task and settles generating outputs', async () => {
    const harness = recoveryHarness('/tmp/orphan-project');
    const load = createProductionStartupRecovery({
      loadProject: harness.loadProject,
      pauseProduction: harness.pauseProduction,
      getTask: () => undefined,
    });

    const project = await load(harness.projectDir);

    expect(harness.pauseProduction).toHaveBeenCalledWith(harness.projectDir, {
      expectedDirectorRevision: 3,
      expectedTaskId: 'task-old',
    });
    expect(project.production?.workflow.stage).toBe('production-paused');
    expect(project.production?.workflow.activeTaskId).toBeUndefined();
    expect(project.production?.outputs.footage).toEqual({
      status: 'stale', directorRevision: 3, updatedAt: 20, error: undefined,
    });
  });

  it('keeps production-running when PipelineService still owns the active task', async () => {
    const harness = recoveryHarness('/tmp/live-project');
    const load = createProductionStartupRecovery({
      loadProject: harness.loadProject,
      pauseProduction: harness.pauseProduction,
      getTask: () => ({ projectPath: harness.projectDir, status: 'running' }),
    });

    const project = await load(harness.projectDir);

    expect(harness.pauseProduction).not.toHaveBeenCalled();
    expect(project.production?.workflow.stage).toBe('production-running');
    expect(project.production?.outputs.footage.status).toBe('generating');
  });

  it('treats a terminal or wrong-project task record as orphaned', async () => {
    const terminal = recoveryHarness('/tmp/terminal-project');
    const loadTerminal = createProductionStartupRecovery({
      loadProject: terminal.loadProject,
      pauseProduction: terminal.pauseProduction,
      getTask: () => ({ projectPath: terminal.projectDir, status: 'succeeded' }),
    });
    await loadTerminal(terminal.projectDir);
    expect(terminal.pauseProduction).toHaveBeenCalledOnce();

    const wrongProject = recoveryHarness('/tmp/wrong-project');
    const loadWrongProject = createProductionStartupRecovery({
      loadProject: wrongProject.loadProject,
      pauseProduction: wrongProject.pauseProduction,
      getTask: () => ({ projectPath: '/tmp/another-project', status: 'running' }),
    });
    await loadWrongProject(wrongProject.projectDir);
    expect(wrongProject.pauseProduction).toHaveBeenCalledOnce();
  });

  it('checks liveness only on the first project load so renderer hot reload cannot pause a live run', async () => {
    const harness = recoveryHarness('/tmp/renderer-project');
    let task: { projectPath: string; status: 'running' } | undefined = {
      projectPath: harness.projectDir,
      status: 'running',
    };
    const getTask = vi.fn(() => task);
    const load = createProductionStartupRecovery({
      loadProject: harness.loadProject,
      pauseProduction: harness.pauseProduction,
      getTask,
    });

    await load(harness.projectDir);
    task = undefined;
    const hotReload = await load(harness.projectDir);

    expect(getTask).toHaveBeenCalledOnce();
    expect(harness.pauseProduction).not.toHaveBeenCalled();
    expect(hotReload.production?.workflow.stage).toBe('production-running');
  });
});
