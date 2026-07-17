import { loadProjectFile } from '../project-file';
import { GenerationError } from './generation-error';
import { resolveProject } from './context';
import type { DirectorPlan, ProjectProductionState } from '../../src/types/director';
import { createEmptyProductionState } from '../../src/lib/director-workflow';

export const DIRECTOR_APPROVAL_REQUIRED = 'director_approval_required';

export async function requireApprovedDirectorPlan(projectPath: string): Promise<DirectorPlan> {
  await resolveProject(projectPath);
  const project = await loadProjectFile(projectPath);
  const plan = project.production?.approvedPlan;
  if (!plan?.approvedAt) {
    throw new GenerationError(
      DIRECTOR_APPROVAL_REQUIRED,
      '导演方案尚未批准，请先运行 director plan 并在确认后执行 director approve。',
    );
  }
  return plan;
}

export async function getDirectorProductionState(
  projectPath: string,
): Promise<ProjectProductionState> {
  await resolveProject(projectPath);
  const project = await loadProjectFile(projectPath);
  return project.production ?? createEmptyProductionState();
}
