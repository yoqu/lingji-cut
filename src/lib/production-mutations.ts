import type {
  DirectorChangeImpact,
  DirectorPlan,
  DirectorWorkflowStage,
  ProductionOutputKey,
  ProductionOutputState,
  ProjectProductionState,
} from '../types/director';
import type { MotionProductionPlan } from '../types/production';
import { compareDirectorPlans } from './director-workflow';

export interface ProductionMutationGuard {
  expectedDirectorRevision?: number;
  expectedTaskId?: string;
}

export type ProductionMutation =
  | { kind: 'replace-draft'; plan: DirectorPlan }
  | { kind: 'approve-draft'; expectedRevision: number; taskId?: string }
  | ({
      kind: 'set-workflow';
      stage: DirectorWorkflowStage;
      mode?: ProjectProductionState['workflow']['mode'];
      taskId?: string;
      error?: string;
    } & ProductionMutationGuard)
  | ({ kind: 'set-execution'; execution: MotionProductionPlan | null } & ProductionMutationGuard)
  | ({ kind: 'set-output'; output: ProductionOutputKey; state: ProductionOutputState } & ProductionMutationGuard)
  | ({ kind: 'set-impact'; impact: DirectorChangeImpact | null } & ProductionMutationGuard)
  | ({ kind: 'approve-animatic'; complete: boolean } & ProductionMutationGuard)
  | { kind: 'set-legacy-protection'; protected: boolean };

export class ProductionRevisionConflictError extends Error {
  readonly code = 'director_revision_conflict';

  constructor(expected: number, actual: number | null) {
    super(`导演方案版本已变化：期望 v${expected}，当前为 ${actual == null ? '无草案' : `v${actual}`}`);
    this.name = 'ProductionRevisionConflictError';
  }
}

export class ProductionTaskConflictError extends Error {
  readonly code = 'director_task_conflict';

  constructor(expected: string, actual?: string) {
    super(`制作任务已变化：期望 ${expected}，当前为 ${actual ?? '无活动任务'}`);
    this.name = 'ProductionTaskConflictError';
  }
}

function initialImpact(): DirectorChangeImpact {
  return {
    allCards: true,
    segmentIds: [],
    cover: true,
    audio: true,
    timeline: true,
    quality: true,
    reasons: ['initial-approval'],
  };
}

function outputStatus(
  current: ProductionOutputState,
  affected: boolean,
  revision: number,
  now: number,
): ProductionOutputState {
  return affected
    ? { status: 'generating', directorRevision: revision, updatedAt: now }
    : current;
}

function approveDraft(
  state: ProjectProductionState,
  expectedRevision: number,
  taskId: string | undefined,
  now: number,
): ProjectProductionState {
  const draft = state.draftPlan;
  if (!draft || draft.revision !== expectedRevision) {
    throw new ProductionRevisionConflictError(expectedRevision, draft?.revision ?? null);
  }
  const impact = state.approvedPlan ? compareDirectorPlans(state.approvedPlan, draft) : initialImpact();
  const approvedPlan = { ...draft, approvedAt: now, updatedAt: now };
  return {
    ...state,
    draftPlan: null,
    approvedPlan,
    pendingImpact: impact,
    workflow: {
      ...state.workflow,
      stage: 'production-running',
      updatedAt: now,
      directorApprovedAt: now,
      activeTaskId: taskId,
      error: undefined,
      failedStage: undefined,
    },
    outputs: {
      cards: outputStatus(state.outputs.cards, impact.allCards || impact.segmentIds.length > 0, draft.revision, now),
      cover: outputStatus(state.outputs.cover, impact.cover, draft.revision, now),
      audio: outputStatus(state.outputs.audio, impact.audio, draft.revision, now),
      timeline: outputStatus(state.outputs.timeline, impact.timeline, draft.revision, now),
    },
    updatedAt: now,
  };
}

export function assertProductionMutationGuard(
  state: ProjectProductionState,
  guard: ProductionMutationGuard,
): void {
  if (
    guard.expectedDirectorRevision == null
    && guard.expectedTaskId == null
  ) return;
  if (
    guard.expectedDirectorRevision != null
    && state.approvedPlan?.revision !== guard.expectedDirectorRevision
  ) {
    throw new ProductionRevisionConflictError(
      guard.expectedDirectorRevision,
      state.approvedPlan?.revision ?? null,
    );
  }
  if (
    guard.expectedTaskId
    && state.workflow.activeTaskId !== guard.expectedTaskId
  ) {
    throw new ProductionTaskConflictError(
      guard.expectedTaskId,
      state.workflow.activeTaskId,
    );
  }
}

function assertMutationGuard(
  state: ProjectProductionState,
  mutation: ProductionMutation,
): void {
  if (
    !('expectedDirectorRevision' in mutation)
    && !('expectedTaskId' in mutation)
  ) return;
  assertProductionMutationGuard(state, mutation);
}

export function applyProductionMutation(
  state: ProjectProductionState,
  mutation: ProductionMutation,
  now = Date.now(),
): ProjectProductionState {
  assertMutationGuard(state, mutation);
  if (mutation.kind === 'approve-draft') {
    return approveDraft(state, mutation.expectedRevision, mutation.taskId, now);
  }
  if (mutation.kind === 'replace-draft') {
    return {
      ...state,
      draftPlan: { ...mutation.plan, updatedAt: now },
      workflow: { ...state.workflow, stage: 'director-review', updatedAt: now },
      updatedAt: now,
    };
  }
  if (mutation.kind === 'set-workflow') {
    const outputs = mutation.stage === 'production-paused'
      ? Object.fromEntries(Object.entries(state.outputs).map(([key, output]) => [
          key,
          output.status === 'generating' ? { ...output, status: 'stale', updatedAt: now } : output,
        ])) as ProjectProductionState['outputs']
      : state.outputs;
    return {
      ...state,
      outputs,
      workflow: {
        ...state.workflow,
        mode: mutation.mode ?? state.workflow.mode,
        stage: mutation.stage,
        activeTaskId: mutation.taskId,
        error: mutation.error,
        failedStage: mutation.error ? state.workflow.stage : undefined,
        updatedAt: now,
      },
      updatedAt: now,
    };
  }
  if (mutation.kind === 'set-execution') {
    return { ...state, execution: mutation.execution, updatedAt: now };
  }
  if (mutation.kind === 'set-output') {
    return {
      ...state,
      outputs: { ...state.outputs, [mutation.output]: mutation.state },
      updatedAt: now,
    };
  }
  if (mutation.kind === 'set-impact') {
    return { ...state, pendingImpact: mutation.impact, updatedAt: now };
  }
  if (mutation.kind === 'approve-animatic') {
    return {
      ...state,
      workflow: {
        ...state.workflow,
        stage: mutation.complete ? 'complete' : 'refining',
        animaticApprovedAt: now,
        activeTaskId: undefined,
        updatedAt: now,
      },
      updatedAt: now,
    };
  }
  return { ...state, legacyProtected: mutation.protected, updatedAt: now };
}
