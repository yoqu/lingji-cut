import path from 'node:path';
import type { ProjectData } from '../src/lib/project-persistence';
import type { PipelineTask } from './pipeline/types';
import {
  loadProjectFile,
  mutateProjectProduction,
} from './project-file';

type TaskSnapshot = Pick<PipelineTask, 'projectPath' | 'status'>;

export interface ProductionStartupRecoveryOptions {
  getTask: (taskId: string) => TaskSnapshot | undefined;
  loadProject?: (projectDir: string) => Promise<ProjectData>;
  pauseProduction?: (
    projectDir: string,
    guard: { expectedDirectorRevision?: number; expectedTaskId?: string },
  ) => Promise<ProjectData['production']>;
  onRecovered?: (projectDir: string, taskId?: string) => void;
  onError?: (projectDir: string, error: unknown) => void;
}

function taskIsLive(task: TaskSnapshot | undefined, projectDir: string): boolean {
  if (!task || (task.status !== 'pending' && task.status !== 'running')) return false;
  return path.resolve(task.projectPath) === path.resolve(projectDir);
}

export function createProductionStartupRecovery(
  options: ProductionStartupRecoveryOptions,
): (projectDir: string) => Promise<ProjectData> {
  const loadProject = options.loadProject ?? loadProjectFile;
  const pauseProduction = options.pauseProduction ?? (async (projectDir, guard) => (
    mutateProjectProduction(projectDir, {
      kind: 'set-workflow',
      stage: 'production-paused',
      ...guard,
    })
  ));
  const completed = new Set<string>();
  const inFlight = new Map<string, Promise<ProjectData>>();

  return async (projectDir: string): Promise<ProjectData> => {
    const projectKey = path.resolve(projectDir);
    if (completed.has(projectKey)) return loadProject(projectDir);
    const existing = inFlight.get(projectKey);
    if (existing) return existing;

    const recovery = (async () => {
      try {
        const project = await loadProject(projectDir);
        const production = project.production;
        if (production?.workflow.stage !== 'production-running') return project;
        const taskId = production.workflow.activeTaskId;
        if (taskId && taskIsLive(options.getTask(taskId), projectDir)) return project;
        const paused = await pauseProduction(projectDir, {
          expectedDirectorRevision: production.approvedPlan?.revision,
          expectedTaskId: taskId,
        });
        options.onRecovered?.(projectDir, taskId);
        return { ...project, production: paused };
      } catch (error) {
        options.onError?.(projectDir, error);
        return loadProject(projectDir);
      } finally {
        completed.add(projectKey);
        inFlight.delete(projectKey);
      }
    })();
    inFlight.set(projectKey, recovery);
    return recovery;
  };
}
