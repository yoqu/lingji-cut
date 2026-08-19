import type { AIAnalysisResult, CoverCandidate } from '../types/ai';
import { buildAICardTimelineDraft } from '../types/ai';
import {
  resolveDirectorRenderStrategy,
  type DirectorPlan,
  type ProjectProductionState,
} from '../types/director';
import { DEFAULT_AI_CARDS_TRACK_ID, type OverlayItem } from '../types';
import type { FootagePlacement, FootageTrackResult } from '../types/footage';
import { useAIStore } from '../store/ai';
import { useTimelineStore } from '../store/timeline';
import { createPersistedAIState } from './ai-persistence';
import type { DirectorAudioTrackResult } from './director-audio-track';
import type { AutoRunTelemetry } from './telemetry/auto-run';
import { syncDirectorPlanMotionBible } from './director-workflow';

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
  footage: FootageTrackResult;
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

function footageBlocksTimeline(options: CommitProductionArtifactsOptions): boolean {
  return Boolean(
    options.footage.error
    && options.plan.segments.some((segment) => (
      segment.enabled && resolveDirectorRenderStrategy(segment) !== 'motion-card'
    )),
  );
}

async function persistAnalysis(options: CommitProductionArtifactsOptions): Promise<AIAnalysisResult> {
  const existingPromptProvenance = options.analysis.coverPromptProvenance;
  const coverPromptProvenance = (
    existingPromptProvenance?.directorRevision === options.plan.revision
    && options.analysis.coverPrompts[0]?.trim() === options.cover.prompts[0]?.trim()
  )
    ? existingPromptProvenance
    : {
        directorRevision: options.plan.revision,
        fingerprint: `cover-prompt-${options.plan.inputFingerprint}-${options.plan.revision}`,
        generatedAt: Date.now(),
        modifiedByUser: false,
      };
  const finalAnalysis = {
    ...options.analysis,
    coverPrompts: options.cover.prompts,
    coverPromptProvenance,
    motionBible: syncDirectorPlanMotionBible(options.plan),
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
  const execution = {
    ...options.audio.execution,
    motionBible: analysis.motionBible ?? syncDirectorPlanMotionBible(options.plan),
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
  if (analysis.cardErrors?.length || footageBlocksTimeline(options)) {
    await window.electronAPI.mutateProjectProduction(options.projectDir, {
      kind: 'set-output', output: 'timeline',
      state: {
        status: 'failed', directorRevision: revision, updatedAt: now,
        error: analysis.cardErrors?.length
          ? `${analysis.cardErrors.length} 个镜头未通过质量门禁，时间线未替换`
          : `素材轨失败，时间线未替换：${options.footage.error}`,
      },
      ...guard(options),
    });
  }
  // footage 产物状态：轨实际执行过（含不可用 / 出错）才盖章。
  // 不可用 / 出错记 failed——恢复制作时会重新检索；正常（含 0 命中）记 current 供复用。
  if (options.footage.ran) {
    await window.electronAPI.mutateProjectProduction(options.projectDir, {
      kind: 'set-output', output: 'footage',
      state: {
        status: options.footage.error ? 'failed' : 'current',
        directorRevision: revision,
        updatedAt: now,
        error: options.footage.unavailable
          ? '素材库（KaCut）不可用，footage 段已退回出卡'
          : options.footage.error,
      },
      ...guard(options),
    });
  }
}

/** footage placements → 时间线 overlay（全屏、visual-2 轨；视频带裁剪起点）。 */
export function buildFootageOverlay(
  placement: FootagePlacement,
  size: { width: number; height: number },
): OverlayItem {
  const position = placement.composition === 'media-window'
    ? {
        x: Math.round(size.width * 0.08),
        y: Math.round(size.height * 0.08),
        width: Math.round(size.width * 0.84),
        height: Math.round(size.height * 0.84),
      }
    : placement.composition === 'split'
      ? {
          x: Math.round(size.width * 0.5),
          y: 0,
          width: Math.round(size.width * 0.5),
          height: size.height,
        }
      : { x: 0, y: 0, width: size.width, height: size.height };
  return {
    id: placement.overlayId,
    type: placement.kind,
    assetPath: placement.sourcePath,
    trackId: DEFAULT_AI_CARDS_TRACK_ID,
    startMs: placement.startMs,
    durationMs: placement.durationMs,
    position,
    overlayType: 'media',
    trimStartMs: placement.kind === 'video' ? placement.trimStartMs : undefined,
    footageData: {
      segmentId: placement.segmentId,
      score: placement.score,
      thumbnailFile: placement.thumbnailFile,
      cameraMove: placement.cameraMove,
      mediaRole: placement.mediaRole,
    },
  };
}

/** footage 产物随制作产物一起持久化（风格对齐 cards/cover/audio 的 provenance）。 */
async function persistFootageState(
  options: CommitProductionArtifactsOptions,
): Promise<void> {
  if (!options.footage.ran && !options.footage.reused) return;
  await window.electronAPI.mutateProjectProduction(options.projectDir, {
    kind: 'set-footage',
    footage: {
      placements: options.footage.placements,
      compositionInputs: options.footage.compositionInputs ?? [],
      claimedSegmentIds: options.footage.claimedSegmentIds,
      fallbacks: options.footage.fallbacks,
      blockedSegmentIds: options.footage.blockedSegmentIds ?? [],
      generationProvenance: {
        directorRevision: options.plan.revision,
        fingerprint: `footage-${options.plan.inputFingerprint}-${options.plan.revision}`,
        generatedAt: Date.now(),
        modifiedByUser: false,
      },
    },
    ...guard(options),
  });
}

async function persistTimeline(
  options: CommitProductionArtifactsOptions,
  analysis: AIAnalysisResult,
): Promise<void> {
  if (!options.replaceTimeline || analysis.cardErrors?.length || footageBlocksTimeline(options)) return;
  const timeline = useTimelineStore.getState();
  const previousTimeline = timeline.timeline;
  const previousIds = timeline.timeline.overlays
    .filter((overlay) => overlay.overlayType === 'ai-card')
    .map((overlay) => overlay.aiCardData?.sourceCardId)
    .filter((id): id is string => Boolean(id));
  try {
    // footage 素材 overlay 与卡片同批原子替换（同一次 set()，单条撤销历史；
    // visual-2 轨，按 startMs 排序；已认领段没有卡片 overlay，二者互斥）。
    const { width, height } = timeline.timeline;
    timeline.replaceAICardsOnTimeline(
      analysis.cards
        .filter((card) => card.enabled)
        .map((card) => buildAICardTimelineDraft(card, analysis.motionBible)),
      previousIds,
      {
        skipAutosave: true,
        footageOverlays: options.footage.placements.map((placement) =>
          buildFootageOverlay(placement, { width, height })),
      },
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
  if (footageBlocksTimeline(options)) {
    const error = `素材轨未完成，非 Motion 镜头尚未确认：${options.footage.error}`;
    options.telemetry?.event('checkpoint.waiting', {
      checkpoint: 'quality-blocked', taskId: options.taskId,
      directorRevision: options.plan.revision,
      error: options.footage.error,
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
  await persistFootageState(options);
  await persistTimeline(options, analysis);
  return completeCheckpoints(options, analysis);
}
