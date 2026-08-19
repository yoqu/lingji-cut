import type { SrtEntry } from '../types';
import type { AISettings } from '../types/ai';
import type { DirectorPlan, ProjectProductionState } from '../types/director';
import { useAIStore } from '../store/ai';
import { useTimelineStore } from '../store/timeline';
import { buildDirectorExecutionPlan } from './production-plan';
import { syncDirectorPlanMotionBible } from './director-workflow';
import { runDirectorAudioTrack, type DirectorAudioTrackResult } from './director-audio-track';
import { createAutoRunTelemetry } from './telemetry/auto-run';
import { commitDirectorProductionArtifacts, type DirectorCoverTrackResult } from './director-production-persistence';
import { registerProductionSaveGuard } from './production-save-guard';
import {
  isDirectorProductionCancellation,
} from './director-production';
import {
  generateCardsTrack,
  generateCoverTrack,
  generateFootageTrack,
  generateHighlightsTrack,
  manualMergeCount,
} from './director-production-tracks';
import type { AIAnalysisResult } from '../types/ai';
import type { FootageTrackResult } from '../types/footage';

export interface DirectorProductionProgress {
  track: 'cards' | 'cover' | 'audio' | 'highlights' | 'footage' | 'timeline';
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
  signal?: AbortSignal;
  /** UI 主动暂停时复用同一个持久化 Promise，避免 renderer 与 client 双写暂停态。 */
  pauseProduction?: () => Promise<ProjectProductionState>;
  telemetryRunId?: string;
}

function cancellationRequested(options: DirectorProductionClientOptions): boolean {
  return options.signal?.aborted === true || options.shouldCancel?.() === true;
}

function cancellationError(): Error {
  const error = new Error('制作已暂停');
  error.name = 'AbortError';
  return error;
}

function throwIfCancellationRequested(options: DirectorProductionClientOptions): void {
  if (cancellationRequested(options)) throw cancellationError();
}

function isProductionConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === 'director_task_conflict'
    || code === 'director_revision_conflict'
    || error.name === 'ProductionTaskConflictError'
    || error.name === 'ProductionRevisionConflictError'
    || error.message.includes('制作任务已变化')
    || error.message.includes('导演方案版本已变化');
}

async function pauseDirectorProduction(
  options: DirectorProductionClientOptions,
  plan: DirectorPlan,
): Promise<ProjectProductionState> {
  if (options.pauseProduction) return options.pauseProduction();
  try {
    return await window.electronAPI.cancelProduction(options.projectDir, options.taskId, plan.revision);
  } catch (error) {
    // 其它 renderer 控制入口可能已先把同一任务暂停。旧 task guard 的冲突不应再
    // 被上层解释成制作失败；只在磁盘确实已经是本修订版暂停态时接纳该结果。
    if (!isProductionConflict(error)) throw error;
    const project = JSON.parse(await window.electronAPI.loadProject(options.projectDir)) as {
      production?: ProjectProductionState;
    };
    const current = project.production;
    if (
      current?.workflow.stage === 'production-paused'
      && current.approvedPlan?.revision === plan.revision
    ) return current;
    throw error;
  }
}

function guard(options: DirectorProductionClientOptions, plan: DirectorPlan) {
  return {
    expectedDirectorRevision: plan.revision,
    expectedTaskId: options.taskId,
  };
}

function resolveExecution(options: DirectorProductionClientOptions, plan: DirectorPlan) {
  const current = options.production.execution;
  if (current?.generationProvenance?.directorRevision === plan.revision) {
    return { ...current, motionBible: syncDirectorPlanMotionBible(plan) };
  }
  const next = buildDirectorExecutionPlan(
    plan,
    useTimelineStore.getState().timeline.podcast.durationMs,
  );
  return current && options.production.pendingImpact?.audio === false
    ? { ...next, audioPlan: current.audioPlan }
    : next;
}

async function stageFootageForCardGeneration(
  options: DirectorProductionClientOptions,
  plan: DirectorPlan,
  footage: FootageTrackResult,
): Promise<void> {
  if (footage.reused) return;
  await window.electronAPI.mutateProjectProduction(options.projectDir, {
    kind: 'set-footage',
    footage: {
      placements: footage.placements,
      compositionInputs: footage.compositionInputs ?? [],
      claimedSegmentIds: footage.claimedSegmentIds,
      fallbacks: footage.fallbacks,
      blockedSegmentIds: footage.blockedSegmentIds ?? [],
      generationProvenance: {
        directorRevision: plan.revision,
        fingerprint: `footage-${plan.inputFingerprint}-${plan.revision}`,
        generatedAt: Date.now(),
        modifiedByUser: false,
      },
    },
    ...guard(options, plan),
  });
  await window.electronAPI.mutateProjectProduction(options.projectDir, {
    kind: 'set-output',
    output: 'footage',
    state: {
      status: footage.error ? 'failed' : 'current',
      directorRevision: plan.revision,
      updatedAt: Date.now(),
      error: footage.error,
    },
    ...guard(options, plan),
  });
}

async function runTracks(
  options: DirectorProductionClientOptions,
  plan: DirectorPlan,
  execution: ReturnType<typeof resolveExecution>,
  telemetry: ReturnType<typeof createAutoRunTelemetry> | null,
): Promise<{
  analysis: AIAnalysisResult;
  cover: DirectorCoverTrackResult;
  audio: DirectorAudioTrackResult;
  footage: FootageTrackResult;
}> {
  throwIfCancellationRequested(options);
  const ai = useAIStore.getState();
  const shouldRunAudio = options.production.pendingImpact
    ? options.production.pendingImpact.audio
    : options.production.outputs.audio.status !== 'current';
  // footage 轨先跑完再开四轨并行：认领检索只是几次本机 HTTP（秒级），相对 cards 轨
  // 分钟级 LLM 可忽略；换来确定性的认领名单——cards 轨据此跳过已认领段、为未认领段
  // 按 footageFallback 出卡。若两轨并发，同一段可能既出卡又上素材，或 footage 段
  // 白跑一轮昂贵的 motion 卡 LLM。该轨失败不影响其他轨（内部永不抛错）。
  const footage = await generateFootageTrack(options, plan, telemetry);
  throwIfCancellationRequested(options);
  // 卡片 IPC 只接受已落盘且 current 的冻结素材。先按顺序盖章素材与 output，
  // 再启动卡片轨，避免 renderer 调用方用自报 fingerprint 绕过批准产物。
  await stageFootageForCardGeneration(options, plan, footage);
  throwIfCancellationRequested(options);
  const [analysis, cover, audio] = await Promise.all([
    generateCardsTrack(options, plan, ai.analysisResult, footage),
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
  return { analysis, cover, audio, footage };
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
    footagePlacements: tracks.footage.placements.length,
    footageCompositionInputs: tracks.footage.compositionInputs?.length ?? 0,
    footageBlockedSegments: tracks.footage.blockedSegmentIds?.length ?? 0,
    footageUnavailable: tracks.footage.unavailable === true,
    footageError: tracks.footage.error ?? null,
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
    footage: tracks.footage,
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
    tracks: ['cards', 'cover', 'audio', 'highlights', 'footage'],
  });
  const protectedCards = manualMergeCount(
    options.production,
    useAIStore.getState().analysisResult?.cards ?? [],
    plan,
  );
  const execution = resolveExecution(options, plan);
  let tracks: Awaited<ReturnType<typeof runTracks>>;
  try {
    throwIfCancellationRequested(options);
    await window.electronAPI.mutateProjectProduction(options.projectDir, {
      kind: 'set-execution',
      execution,
      ...guard(options, plan),
    });
    tracks = await runTracks(options, plan, execution, telemetry);
  } catch (error) {
    if (cancellationRequested(options) || isDirectorProductionCancellation(error)) {
      telemetry?.event('production.cancelled', {
        taskId: options.taskId,
        directorRevision: plan.revision,
      });
      return pauseDirectorProduction(options, plan);
    }
    throw error;
  }
  emitTrackSummary(telemetry, options, plan, tracks);
  if (cancellationRequested(options)) {
    return pauseDirectorProduction(options, plan);
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
