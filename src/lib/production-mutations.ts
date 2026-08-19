import type {
  DirectorChangeImpact,
  DirectorPlan,
  DirectorWorkflowStage,
  FootageProductionState,
  ProductionOutputKey,
  ProductionOutputState,
  ProjectProductionState,
} from '../types/director';
import type { MotionProductionPlan } from '../types/production';
import { alignCoverPromptTitle } from './cover-title';
import { compareDirectorPlans } from './director-workflow';
import { firstDirectorPlanApprovalError } from './director-plan-validation';
import { legacyShowDirectorPlanVersion } from './show-director-version';

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
  | ({ kind: 'invalidate-outputs'; outputs: ProductionOutputKey[] } & ProductionMutationGuard)
  | ({ kind: 'set-footage'; footage: FootageProductionState | null } & ProductionMutationGuard)
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

export function normalizeProductionStateInvariant(
  state: ProjectProductionState,
  now: number,
): ProjectProductionState {
  let outputs = state.outputs;
  if (state.workflow.stage !== 'production-running') {
    for (const outputKey of Object.keys(state.outputs) as ProductionOutputKey[]) {
      const output = state.outputs[outputKey];
      if (output.status !== 'generating') continue;
      if (outputs === state.outputs) outputs = { ...state.outputs };
      outputs[outputKey] = {
        ...output,
        status: 'stale',
        updatedAt: now,
        error: undefined,
      };
    }
  }
  const clearFailureState = state.workflow.stage === 'director-review'
    || state.workflow.stage === 'production-paused'
    || state.workflow.stage === 'animatic-review'
    || state.workflow.stage === 'idle'
    || state.workflow.stage === 'refining'
    || state.workflow.stage === 'complete';
  const clearTask = clearFailureState
    || state.workflow.stage === 'quality-blocked'
    || state.workflow.stage === 'error';
  const needsWorkflowCleanup = (clearTask && state.workflow.activeTaskId !== undefined)
    || (clearFailureState && (state.workflow.error !== undefined || state.workflow.failedStage !== undefined));
  const workflow = needsWorkflowCleanup
    ? {
        ...state.workflow,
        activeTaskId: clearTask ? undefined : state.workflow.activeTaskId,
        error: clearFailureState ? undefined : state.workflow.error,
        failedStage: clearFailureState ? undefined : state.workflow.failedStage,
      }
    : state.workflow;
  if (outputs === state.outputs && workflow === state.workflow) return state;
  return { ...state, outputs, workflow };
}

function normalizeDirectorPlanMetadata(plan: DirectorPlan): DirectorPlan {
  const summary = plan.summary.trim()
    || plan.segments.map((segment) => segment.summary.trim()).filter(Boolean).slice(0, 2).join('；')
    || plan.segments.find((segment) => segment.title.trim())?.title.trim()
    || '';
  const title = plan.title?.trim() || '';
  return {
    ...plan,
    title: title || undefined,
    summary,
    coverDirection: {
      ...plan.coverDirection,
      prompt: alignCoverPromptTitle(plan.coverDirection.prompt, title),
    },
  };
}

function assertCurrentShowDirectorPlan(
  mode: ProjectProductionState['workflow']['mode'],
  plan: DirectorPlan | null,
  action: 'approve' | 'resume',
): void {
  if (mode !== 'director' || !plan) return;
  const legacyVersion = legacyShowDirectorPlanVersion(plan);
  if (!legacyVersion) return;
  const operation = action === 'approve' ? '草案不能直接批准' : '方案不能继续制作';
  throw new Error(
    `旧版导演${operation}（角色 v${legacyVersion.role} · 工作流 v${legacyVersion.workflow}），请先用当前导演重新编排`);
}

function approveDraft(
  state: ProjectProductionState,
  expectedRevision: number,
  taskId: string | undefined,
  now: number,
): ProjectProductionState {
  const storedDraft = state.draftPlan;
  const draft = storedDraft ? normalizeDirectorPlanMetadata(storedDraft) : null;
  if (!draft || draft.revision !== expectedRevision) {
    throw new ProductionRevisionConflictError(expectedRevision, draft?.revision ?? null);
  }
  assertCurrentShowDirectorPlan(state.workflow.mode, draft, 'approve');
  if (!draft.title?.trim()) throw new Error('导演方案缺少作品标题，请先补充后再批准');
  if (!draft.summary.trim()) throw new Error('导演方案缺少作品简介，请先补充后再批准');
  if (!draft.coverDirection.prompt.trim()) throw new Error('导演方案缺少封面方向，请先补充后再批准');
  const validationError = firstDirectorPlanApprovalError(draft);
  if (validationError) throw new Error(validationError);
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
      // footage 产物跟随分段内容失效（与 cards 同一信号）；旧项目缺该 key 时补空态。
      footage: outputStatus(
        state.outputs.footage ?? { status: 'empty', updatedAt: now },
        impact.allCards || impact.segmentIds.length > 0,
        draft.revision,
        now,
      ),
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
  if (
    mutation.kind === 'approve-animatic'
    && state.workflow.stage === 'animatic-review'
    && state.workflow.activeTaskId == null
  ) {
    assertProductionMutationGuard(state, {
      expectedDirectorRevision: mutation.expectedDirectorRevision,
    });
    return;
  }
  assertProductionMutationGuard(state, mutation);
}

export function applyProductionMutation(
  state: ProjectProductionState,
  mutation: ProductionMutation,
  now = Date.now(),
): ProjectProductionState {
  assertMutationGuard(state, mutation);
  if (mutation.kind === 'approve-draft') {
    return normalizeProductionStateInvariant(
      approveDraft(state, mutation.expectedRevision, mutation.taskId, now),
      now,
    );
  }
  if (mutation.kind === 'replace-draft') {
    const plan = normalizeDirectorPlanMetadata(mutation.plan);
    return normalizeProductionStateInvariant({
      ...state,
      draftPlan: { ...plan, updatedAt: now },
      workflow: {
        ...state.workflow,
        stage: 'director-review',
        activeTaskId: undefined,
        error: undefined,
        failedStage: undefined,
        updatedAt: now,
      },
      updatedAt: now,
    }, now);
  }
  if (mutation.kind === 'set-workflow') {
    const mode = mutation.mode ?? state.workflow.mode;
    if (mutation.stage === 'production-running') {
      assertCurrentShowDirectorPlan(mode, state.approvedPlan, 'resume');
    }
    const paused = mutation.stage === 'production-paused';
    return normalizeProductionStateInvariant({
      ...state,
      workflow: {
        ...state.workflow,
        mode,
        stage: mutation.stage,
        activeTaskId: paused ? undefined : mutation.taskId,
        error: paused ? undefined : mutation.error,
        failedStage: paused ? undefined : mutation.error ? state.workflow.stage : undefined,
        updatedAt: now,
      },
      updatedAt: now,
    }, now);
  }
  if (mutation.kind === 'set-execution') {
    return normalizeProductionStateInvariant(
      { ...state, execution: mutation.execution, updatedAt: now },
      now,
    );
  }
  if (mutation.kind === 'set-output') {
    return normalizeProductionStateInvariant({
      ...state,
      outputs: { ...state.outputs, [mutation.output]: mutation.state },
      updatedAt: now,
    }, now);
  }
  if (mutation.kind === 'invalidate-outputs') {
    const outputs = { ...state.outputs };
    for (const output of new Set(mutation.outputs)) {
      outputs[output] = {
        ...outputs[output],
        status: 'stale',
        updatedAt: now,
        error: undefined,
      };
    }
    return normalizeProductionStateInvariant({ ...state, outputs, updatedAt: now }, now);
  }
  if (mutation.kind === 'set-footage') {
    return normalizeProductionStateInvariant(
      { ...state, footage: mutation.footage, updatedAt: now },
      now,
    );
  }
  if (mutation.kind === 'set-impact') {
    return normalizeProductionStateInvariant(
      { ...state, pendingImpact: mutation.impact, updatedAt: now },
      now,
    );
  }
  if (mutation.kind === 'approve-animatic') {
    return normalizeProductionStateInvariant({
      ...state,
      workflow: {
        ...state.workflow,
        stage: mutation.complete ? 'complete' : 'refining',
        animaticApprovedAt: now,
        activeTaskId: undefined,
        error: undefined,
        failedStage: undefined,
        updatedAt: now,
      },
      updatedAt: now,
    }, now);
  }
  return normalizeProductionStateInvariant(
    { ...state, legacyProtected: mutation.protected, updatedAt: now },
    now,
  );
}
