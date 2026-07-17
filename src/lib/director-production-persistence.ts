import type { AIAnalysisResult, CoverCandidate } from '../types/ai';
import { buildAICardTimelineDraft } from '../types/ai';
import type { DirectorPlan, ProjectProductionState } from '../types/director';
import { useAIStore } from '../store/ai';
import { useTimelineStore } from '../store/timeline';
import { createPersistedAIState } from './ai-persistence';
import type { DirectorAudioTrackResult } from './director-audio-track';
import { buildMotionProductionPlan } from './production-plan';
import type { AutoRunTelemetry } from './telemetry/auto-run';

export interface DirectorCoverTrackResult {
  prompts: string[];
  candidates: CoverCandidate[];
  error?: string;
  manualMergeCount?: number;
}

interface CommitProductionArtifactsOptions {
  projectDir: string;
  taskId: string;
  plan: DirectorPlan;
  analysis: AIAnalysisResult;
  cover: DirectorCoverTrackResult;
  audio: DirectorAudioTrackResult;
  replaceTimeline: boolean;
  manualMergeCount: number;
  telemetry: AutoRunTelemetry | null;
}

function guard(options: CommitProductionArtifactsOptions) {
  return {
    expectedDirectorRevision: options.plan.revision,
    expectedTaskId: options.taskId,
  };
}

async function persistAnalysis(options: CommitProductionArtifactsOptions): Promise<AIAnalysisResult> {
  const finalAnalysis = {
    ...options.analysis,
    coverPrompts: options.cover.prompts,
    motionBible: options.plan.motionBible,
  };
  useAIStore.getState().setAnalysisResult(finalAnalysis);
  useAIStore.getState().setCoverCandidates(options.cover.candidates);
  await window.electronAPI.saveProjectSection(
    options.projectDir,
    'aiAnalysis',
    JSON.stringify(createPersistedAIState(finalAnalysis, options.cover.candidates)),
    guard(options),
  );
  return finalAnalysis;
}

async function persistExecution(
  options: CommitProductionArtifactsOptions,
  analysis: AIAnalysisResult,
): Promise<ProjectProductionState> {
  const durationMs = useTimelineStore.getState().timeline.podcast.durationMs;
  const execution = {
    ...buildMotionProductionPlan(analysis, durationMs),
    audioPlan: options.audio.execution.audioPlan,
    generationProvenance: {
      directorRevision: options.plan.revision,
      fingerprint: `execution-${options.plan.inputFingerprint}-${options.plan.revision}`,
      generatedAt: Date.now(),
      modifiedByUser: false,
    },
  };
  return window.electronAPI.mutateProjectProduction(options.projectDir, {
    kind: 'set-execution', execution, ...guard(options),
  });
}

async function persistOutputStates(
  options: CommitProductionArtifactsOptions,
  analysis: AIAnalysisResult,
): Promise<void> {
  const revision = options.plan.revision;
  const now = Date.now();
  await Promise.all([
    window.electronAPI.mutateProjectProduction(options.projectDir, {
      kind: 'set-output', output: 'cards',
      state: {
        status: analysis.cardErrors?.length || options.manualMergeCount > 0 ? 'failed' : 'current',
        directorRevision: revision, updatedAt: now,
        error: options.manualMergeCount > 0
          ? `${options.manualMergeCount} 个人工精修镜头需人工合并`
          : analysis.cardErrors?.length
            ? `${analysis.cardErrors.length} 个镜头生成失败`
            : undefined,
      },
      ...guard(options),
    }),
    window.electronAPI.mutateProjectProduction(options.projectDir, {
      kind: 'set-output', output: 'cover',
      state: {
        status: options.cover.error || options.cover.manualMergeCount ? 'failed' : 'current',
        directorRevision: revision,
        updatedAt: now,
        error: options.cover.manualMergeCount
          ? `${options.cover.manualMergeCount} 个人工精修封面需人工合并`
          : options.cover.error,
      },
      ...guard(options),
    }),
    window.electronAPI.mutateProjectProduction(options.projectDir, {
      kind: 'set-output', output: 'audio',
      state: {
        status: options.audio.error || options.audio.outcome === 'needs-review' ? 'failed' : 'current',
        directorRevision: revision, updatedAt: now,
        error: options.audio.error
          ?? (options.audio.outcome === 'needs-review' ? '声音生成结果需要人工确认' : undefined),
      },
      ...guard(options),
    }),
  ]);
  if (analysis.cardErrors?.length) {
    await window.electronAPI.mutateProjectProduction(options.projectDir, {
      kind: 'set-output', output: 'timeline',
      state: {
        status: 'failed', directorRevision: revision, updatedAt: now,
        error: `${analysis.cardErrors.length} 个镜头未通过质量门禁，时间线未替换`,
      },
      ...guard(options),
    });
  }
}

async function persistTimeline(
  options: CommitProductionArtifactsOptions,
  analysis: AIAnalysisResult,
): Promise<void> {
  if (!options.replaceTimeline || analysis.cardErrors?.length) return;
  const timeline = useTimelineStore.getState();
  const previousTimeline = timeline.timeline;
  const previousIds = timeline.timeline.overlays
    .filter((overlay) => overlay.overlayType === 'ai-card')
    .map((overlay) => overlay.aiCardData?.sourceCardId)
    .filter((id): id is string => Boolean(id));
  try {
    timeline.replaceAICardsOnTimeline(
      analysis.cards
        .filter((card) => card.enabled)
        .map((card) => buildAICardTimelineDraft(card, options.plan.motionBible)),
      previousIds,
      { skipAutosave: true },
    );
    await window.electronAPI.saveProjectSection(
      options.projectDir,
      'timeline',
      JSON.stringify(useTimelineStore.getState().timeline),
      guard(options),
    );
  } catch (error) {
    timeline.applyExternalTimeline(previousTimeline);
    throw error;
  }
  await window.electronAPI.mutateProjectProduction(options.projectDir, {
    kind: 'set-output', output: 'timeline',
    state: { status: 'current', directorRevision: options.plan.revision, updatedAt: Date.now() },
    ...guard(options),
  });
}

async function completeCheckpoints(
  options: CommitProductionArtifactsOptions,
  analysis: AIAnalysisResult,
): Promise<ProjectProductionState> {
  if (analysis.cardErrors?.length) {
    const error = `${analysis.cardErrors.length} 个镜头未通过质量门禁，请修复后恢复制作`;
    options.telemetry?.event('checkpoint.waiting', {
      checkpoint: 'quality-blocked', taskId: options.taskId,
      directorRevision: options.plan.revision,
      errors: analysis.cardErrors.length,
    });
    return window.electronAPI.mutateProjectProduction(options.projectDir, {
      kind: 'set-workflow', stage: 'quality-blocked', error,
      taskId: options.taskId, ...guard(options),
    });
  }
  let production = await window.electronAPI.mutateProjectProduction(options.projectDir, {
    kind: 'set-impact', impact: null, ...guard(options),
  });
  production = await window.electronAPI.mutateProjectProduction(options.projectDir, {
    kind: 'set-workflow', stage: 'animatic-review', taskId: options.taskId, ...guard(options),
  });
  if (production.workflow.mode === 'director') {
    options.telemetry?.event('checkpoint.waiting', {
      checkpoint: 'animatic-review', taskId: options.taskId,
      directorRevision: options.plan.revision,
    });
    return production;
  }
  const completed = await window.electronAPI.mutateProjectProduction(options.projectDir, {
    kind: 'approve-animatic', complete: true, ...guard(options),
  });
  options.telemetry?.event('checkpoint.auto-approved', {
    checkpoint: 'animatic-review', taskId: options.taskId,
    directorRevision: options.plan.revision,
  });
  return completed;
}

export async function commitDirectorProductionArtifacts(
  options: CommitProductionArtifactsOptions,
): Promise<ProjectProductionState> {
  const analysis = await persistAnalysis(options);
  await persistExecution(options, analysis);
  await persistOutputStates(options, analysis);
  await persistTimeline(options, analysis);
  return completeCheckpoints(options, analysis);
}
