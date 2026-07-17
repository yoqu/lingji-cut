import type { SrtEntry } from '../types';
import type { AISettings } from '../types/ai';
import type { DirectorPlan, ProjectProductionState } from '../types/director';
import { useAIStore } from '../store/ai';
import { useTimelineStore } from '../store/timeline';
import { buildDirectorExecutionPlan } from './production-plan';
import { runDirectorAudioTrack, type DirectorAudioTrackResult } from './director-audio-track';
import { createAutoRunTelemetry } from './telemetry/auto-run';
import { commitDirectorProductionArtifacts, type DirectorCoverTrackResult } from './director-production-persistence';
import { registerProductionSaveGuard } from './production-save-guard';
import {
  generateCardsTrack,
  generateCoverTrack,
  generateHighlightsTrack,
  manualMergeCount,
} from './director-production-tracks';
import type { AIAnalysisResult } from '../types/ai';

export interface DirectorProductionProgress {
  track: 'cards' | 'cover' | 'audio' | 'highlights' | 'timeline';
  percent: number;
  message: string;
}

export interface DirectorProductionClientOptions {
  projectDir: string;
  production: ProjectProductionState;
  entries: SrtEntry[];
  settings: AISettings;
  taskId: string;
  onProgress?: (progress: DirectorProductionProgress) => void;
  shouldCancel?: () => boolean;
  telemetryRunId?: string;
}

function guard(options: DirectorProductionClientOptions, plan: DirectorPlan) {
  return {
    expectedDirectorRevision: plan.revision,
    expectedTaskId: options.taskId,
  };
}

function resolveExecution(options: DirectorProductionClientOptions, plan: DirectorPlan) {
  const current = options.production.execution;
  if (current?.generationProvenance?.directorRevision === plan.revision) return current;
  const next = buildDirectorExecutionPlan(
    plan,
    useTimelineStore.getState().timeline.podcast.durationMs,
  );
  return current && options.production.pendingImpact?.audio === false
    ? { ...next, audioPlan: current.audioPlan }
    : next;
}

async function runTracks(
  options: DirectorProductionClientOptions,
  plan: DirectorPlan,
  execution: ReturnType<typeof resolveExecution>,
): Promise<{
  analysis: AIAnalysisResult;
  cover: DirectorCoverTrackResult;
  audio: DirectorAudioTrackResult;
}> {
  const ai = useAIStore.getState();
  const shouldRunAudio = options.production.pendingImpact
    ? options.production.pendingImpact.audio
    : options.production.outputs.audio.status !== 'current';
  const [analysis, cover, audio] = await Promise.all([
    generateCardsTrack(options, plan, ai.analysisResult),
    generateCoverTrack(options, plan, ai.coverCandidates),
    shouldRunAudio
      ? runDirectorAudioTrack({
          projectDir: options.projectDir,
          durationMs: useTimelineStore.getState().timeline.podcast.durationMs,
          settings: options.settings,
          execution,
          shouldCancel: options.shouldCancel,
          onProgress: (percent, message) => options.onProgress?.({ track: 'audio', percent, message }),
        })
      : Promise.resolve({ execution, outcome: 'disabled', reusedSounds: 0 } as DirectorAudioTrackResult),
    generateHighlightsTrack(options),
  ]).then(([cards, covers, audioResult]) => [cards, covers, audioResult] as const);
  return { analysis, cover, audio };
}

function emitTrackSummary(
  telemetry: ReturnType<typeof createAutoRunTelemetry> | null,
  options: DirectorProductionClientOptions,
  plan: DirectorPlan,
  tracks: Awaited<ReturnType<typeof runTracks>>,
): void {
  telemetry?.event('production.tracks.end', {
    taskId: options.taskId,
    directorRevision: plan.revision,
    cardErrors: tracks.analysis.cardErrors?.length ?? 0,
    coverError: tracks.cover.error ?? null,
    audioOutcome: tracks.audio.outcome,
    audioError: tracks.audio.error ?? null,
  });
}

function shouldReplaceTimeline(options: DirectorProductionClientOptions): boolean {
  // 时间线产出非 current（质量门禁失败/过期）时必须重排，不受 no-op impact 屏蔽。
  if (options.production.outputs.timeline.status !== 'current') return true;
  return options.production.pendingImpact?.timeline === true;
}

async function commitTracks(
  options: DirectorProductionClientOptions,
  plan: DirectorPlan,
  tracks: Awaited<ReturnType<typeof runTracks>>,
  manualMergeCount: number,
  telemetry: ReturnType<typeof createAutoRunTelemetry> | null,
): Promise<ProjectProductionState> {
  return commitDirectorProductionArtifacts({
    projectDir: options.projectDir,
    taskId: options.taskId,
    plan,
    analysis: tracks.analysis,
    cover: tracks.cover,
    audio: tracks.audio,
    replaceTimeline: shouldReplaceTimeline(options),
    manualMergeCount,
    telemetry,
  });
}

async function executeDirectorProduction(
  options: DirectorProductionClientOptions,
  plan: DirectorPlan,
): Promise<ProjectProductionState> {
  const telemetry = options.telemetryRunId ? createAutoRunTelemetry(options.telemetryRunId) : null;
  telemetry?.event('production.tracks.start', {
    taskId: options.taskId,
    directorRevision: plan.revision,
    impact: options.production.pendingImpact,
    tracks: ['cards', 'cover', 'audio', 'highlights'],
  });
  const protectedCards = manualMergeCount(
    options.production,
    useAIStore.getState().analysisResult?.cards ?? [],
    plan,
  );
  const execution = resolveExecution(options, plan);
  await window.electronAPI.mutateProjectProduction(options.projectDir, {
    kind: 'set-execution',
    execution,
    ...guard(options, plan),
  });
  const tracks = await runTracks(options, plan, execution);
  emitTrackSummary(telemetry, options, plan, tracks);
  if (options.shouldCancel?.()) {
    return window.electronAPI.cancelProduction(options.projectDir, options.taskId, plan.revision);
  }
  return commitTracks(options, plan, tracks, protectedCards, telemetry);
}

export async function runDirectorProductionClient(
  options: DirectorProductionClientOptions,
): Promise<ProjectProductionState> {
  const plan = options.production.approvedPlan;
  if (!plan) throw new Error('导演方案尚未批准');
  const releaseSaveGuard = registerProductionSaveGuard(guard(options, plan));
  try {
    return await executeDirectorProduction(options, plan);
  } finally {
    releaseSaveGuard();
  }
}
