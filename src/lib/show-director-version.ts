import type { DirectorPlan } from '../types/director';

export const MIN_SHOW_DIRECTOR_ROLE_VERSION = 5;
export const MIN_SHOW_DIRECTOR_WORKFLOW_VERSION = 5;

export interface ShowDirectorPlanVersion {
  role: string;
  workflow: string;
}

export function resolveShowDirectorPlanVersion(
  plan: Pick<DirectorPlan, 'agentPlanning'>,
): ShowDirectorPlanVersion {
  return {
    role: plan.agentPlanning?.roleVersion?.trim() || '未记录',
    workflow: plan.agentPlanning?.workflowVersion?.trim() || '未记录',
  };
}

export function isCurrentShowDirectorPlan(
  plan: Pick<DirectorPlan, 'agentPlanning'>,
): boolean {
  const version = resolveShowDirectorPlanVersion(plan);
  const role = Number.parseInt(version.role, 10);
  const workflow = Number.parseInt(version.workflow, 10);
  return Number.isFinite(role)
    && role >= MIN_SHOW_DIRECTOR_ROLE_VERSION
    && Number.isFinite(workflow)
    && workflow >= MIN_SHOW_DIRECTOR_WORKFLOW_VERSION;
}

export function legacyShowDirectorPlanVersion(
  plan: Pick<DirectorPlan, 'agentPlanning'>,
): ShowDirectorPlanVersion | null {
  return isCurrentShowDirectorPlan(plan) ? null : resolveShowDirectorPlanVersion(plan);
}
