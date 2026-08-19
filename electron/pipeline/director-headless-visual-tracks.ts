import { createPersistedAIState } from '../../src/lib/ai-persistence';
import type { SrtEntry } from '../../src/types';
import type { AIAnalysisResult, AISettings, CoverCandidate } from '../../src/types/ai';
import {
  resolveDirectorFallbackPolicy,
  resolveDirectorRenderStrategy,
  type ProjectProductionState,
} from '../../src/types/director';
import { loadProjectFile, saveProjectSection } from '../project-file';
import type { GenerationRunCtx } from './headless-generation';
import { runHeadlessDirectorCover } from './director-headless-cover';
import { runAnalyzeHeadless } from './runs/analyze-run';
import { syncDirectorPlanMotionBible } from '../../src/lib/director-workflow';
import type { ProductionMutationGuard } from '../../src/lib/production-mutations';
import { EMPTY_FOOTAGE_TRACK_RESULT, type FootageTrackResult } from '../../src/types/footage';
import { isFootageCompositionInputCurrent } from '../../src/lib/footage-fingerprint';
import { readLocalFileFingerprint } from '../footage/file-fingerprint';
import path from 'node:path';

function productionGuard(
  production: ProjectProductionState,
  taskId: string,
): ProductionMutationGuard {
  return {
    expectedDirectorRevision: production.approvedPlan!.revision,
    expectedTaskId: taskId,
  };
}

export function needsProductionTrack(
  production: ProjectProductionState,
  track: 'cards' | 'cover' | 'audio' | 'timeline',
): boolean {
  const impact = production.pendingImpact;
  if (!impact) return production.outputs[track].status !== 'current';
  if (track === 'cards') return impact.allCards || impact.segmentIds.length > 0;
  return impact[track];
}

function analysisFallback(production: ProjectProductionState): AIAnalysisResult {
  const plan = production.approvedPlan!;
  return {
    segments: plan.segments,
    cards: [],
    coverPrompts: plan.coverDirection.prompt ? [plan.coverDirection.prompt] : [],
    summary: plan.summary,
    keywords: plan.keywords,
    globalPrompt: plan.globalPrompt,
    motionBible: syncDirectorPlanMotionBible(plan),
  };
}

export async function runHeadlessCardsTrack(options: {
  ctx: GenerationRunCtx;
  production: ProjectProductionState;
  cards: typeof runAnalyzeHeadless;
  footage?: FootageTrackResult;
}): Promise<{ analysis: AIAnalysisResult; error?: string }> {
  const { ctx, production, cards } = options;
  const footage = options.footage ?? EMPTY_FOOTAGE_TRACK_RESULT;
  const claimed = new Set(footage.claimedSegmentIds);
  const blocked = new Set(footage.blockedSegmentIds ?? []);
  const applyStandaloneCompositeFallbacks = async (analysis: AIAnalysisResult): Promise<AIAnalysisResult> => {
    if (!analysis.cardErrors?.length) return analysis;
    const plan = production.approvedPlan!;
    const recovered = new Set<string>();
    for (const error of analysis.cardErrors) {
      const segmentIndex = plan.segments.findIndex((segment) => segment.id === error.segmentId);
      const segment = plan.segments[segmentIndex];
      if (
        !segment
        || resolveDirectorRenderStrategy(segment) !== 'agent-composite'
        || resolveDirectorFallbackPolicy(segment) !== 'standalone-media'
      ) continue;
      const inputs = (footage.compositionInputs ?? []).filter((input) => input.segmentId === segment.id);
      const primary = inputs.find((input) => input.usage === 'required') ?? inputs[0];
      if (!primary) continue;
      const current = await isFootageCompositionInputCurrent(primary, (filePath) => (
        readLocalFileFingerprint(path.isAbsolute(filePath) ? filePath : path.resolve(ctx.projectPath, filePath))
      ));
      if (!current) continue;
      if (!footage.placements.some((placement) => placement.segmentId === segment.id)) {
        footage.placements.push({
          segmentIndex,
          segmentId: segment.id,
          overlayId: `footage-${segment.id}`,
          startMs: segment.startMs,
          durationMs: Math.max(1, Math.round(segment.endMs - segment.startMs)),
          sourcePath: primary.asset.path,
          fileFingerprint: primary.fileFingerprint,
          kind: primary.asset.kind,
          trimStartMs: primary.asset.kind === 'video'
            ? Math.max(0, Math.round(primary.trimStartMs ?? 0))
            : 0,
          score: Number.isFinite(primary.asset.score) ? primary.asset.score : 0,
          thumbnailFile: primary.asset.thumbnailFile,
          composition: segment.composition,
          cameraMove: segment.cameraMove,
          mediaRole: segment.mediaRole,
        });
        footage.placements.sort((left, right) => left.startMs - right.startMs);
      }
      if (!footage.claimedSegmentIds.includes(segment.id)) footage.claimedSegmentIds.push(segment.id);
      claimed.add(segment.id);
      recovered.add(segment.id);
    }
    if (recovered.size === 0) return analysis;
    const remainingErrors = analysis.cardErrors.filter((error) => !recovered.has(error.segmentId));
    return { ...analysis, cardErrors: remainingErrors.length > 0 ? remainingErrors : undefined };
  };
  const finalizeRouting = async (analysis: AIAnalysisResult): Promise<AIAnalysisResult> => {
    analysis = await applyStandaloneCompositeFallbacks(analysis);
    const remaining = analysis.cards.filter((card) => (
      !claimed.has(card.segmentId) && !blocked.has(card.segmentId)
    ));
    if (blocked.size === 0) {
      return remaining.length === analysis.cards.length ? analysis : { ...analysis, cards: remaining };
    }
    const plan = production.approvedPlan!;
    const existingErrors = (analysis.cardErrors ?? []).filter((error) => !blocked.has(error.segmentId));
    const blockedErrors = plan.segments.flatMap((segment, segmentIndex) => (
      blocked.has(segment.id)
        ? [{
            segmentId: segment.id,
            segmentTitle: segment.title,
            segmentIndex,
            totalSegments: plan.segments.length,
            message: '组合镜头缺少可用的必需素材，fallbackPolicy=block。',
          }]
        : []
    ));
    return { ...analysis, cards: remaining, cardErrors: [...existingErrors, ...blockedErrors] };
  };
  const finalizeRoutingAndPersist = async (analysis: AIAnalysisResult): Promise<AIAnalysisResult> => {
    const finalAnalysis = await finalizeRouting(analysis);
    if (finalAnalysis === analysis) return analysis;
    const latest = await loadProjectFile(ctx.projectPath);
    await saveProjectSection(ctx.projectPath, 'aiAnalysis', createPersistedAIState(
      finalAnalysis,
      latest.aiAnalysis?.coverCandidates ?? [],
    ), productionGuard(production, ctx.handle.taskId));
    return finalAnalysis;
  };
  const project = await loadProjectFile(ctx.projectPath);
  const existing = project.aiAnalysis?.analysisResult ?? analysisFallback(production);
  if (!needsProductionTrack(production, 'cards')) {
    const analysis = await finalizeRoutingAndPersist(existing);
    return {
      analysis,
      error: analysis.cardErrors?.length ? `${analysis.cardErrors.length} 个镜头生成失败` : undefined,
    };
  }
  const manual = existing.cards.filter((card) => card.generationProvenance?.modifiedByUser).length;
  if (manual > 0) return { analysis: existing, error: `${manual} 个人工精修镜头需人工合并` };
  try {
    const analysis = await cards({
      ...ctx,
      params: {
        ...ctx.params,
        useApprovedPlan: true,
        claimedFootageSegmentIds: footage.claimedSegmentIds,
        footageFallbacks: footage.fallbacks,
        footageCompositionInputs: footage.compositionInputs ?? [],
        blockedFootageSegmentIds: footage.blockedSegmentIds ?? [],
      },
    });
    const finalAnalysis = await finalizeRoutingAndPersist(analysis);
    return {
      analysis: finalAnalysis,
      error: finalAnalysis.cardErrors?.length
        ? `${finalAnalysis.cardErrors.length} 个镜头生成失败`
        : undefined,
    };
  } catch (error) {
    return {
      analysis: await finalizeRoutingAndPersist(existing),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runHeadlessCoverTrack(options: {
  ctx: GenerationRunCtx;
  production: ProjectProductionState;
  entries: SrtEntry[];
  settings: AISettings;
  analysis: AIAnalysisResult;
  covers: typeof runHeadlessDirectorCover;
  assertActive: () => Promise<void>;
}): Promise<{ candidates: CoverCandidate[]; error?: string }> {
  const { ctx, production, entries, settings, analysis, covers } = options;
  const project = await loadProjectFile(ctx.projectPath);
  const existing = project.aiAnalysis?.coverCandidates ?? [];
  if (!needsProductionTrack(production, 'cover')) return { candidates: existing };
  const manual = existing.filter((candidate) => candidate.generationProvenance?.modifiedByUser).length;
  if (manual > 0) return { candidates: existing, error: `${manual} 个人工精修封面需人工合并` };
  try {
    const plan = production.approvedPlan!;
    const result = await covers({
      projectPath: ctx.projectPath,
      userDataPath: ctx.userDataPath,
      taskId: ctx.handle.taskId,
      signal: ctx.handle.signal,
      entries,
      settings,
      plan,
      analysis,
      onProgress: (percent, message) => ctx.handle.update({ phase: message, percent }),
    });
    const generatedAt = Date.now();
    const provenanced = result.candidates.map((candidate) => ({
      ...candidate,
      generationProvenance: {
        directorRevision: plan.revision,
        fingerprint: `cover-${plan.inputFingerprint}-${plan.revision}`,
        generatedAt,
        modifiedByUser: false,
      },
    }));
    await options.assertActive();
    const latest = await loadProjectFile(ctx.projectPath);
    await saveProjectSection(ctx.projectPath, 'aiAnalysis', createPersistedAIState(
      { ...(latest.aiAnalysis?.analysisResult ?? analysis), coverPrompts: result.prompts },
      provenanced,
    ), productionGuard(production, ctx.handle.taskId));
    return { candidates: provenanced };
  } catch (error) {
    return { candidates: existing, error: error instanceof Error ? error.message : String(error) };
  }
}
