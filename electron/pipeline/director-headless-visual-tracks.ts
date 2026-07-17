import { createPersistedAIState } from '../../src/lib/ai-persistence';
import type { SrtEntry } from '../../src/types';
import type { AIAnalysisResult, AISettings, CoverCandidate } from '../../src/types/ai';
import type { ProjectProductionState } from '../../src/types/director';
import { loadProjectFile, saveProjectSection } from '../project-file';
import type { GenerationRunCtx } from './headless-generation';
import { runHeadlessDirectorCover } from './director-headless-cover';
import { runAnalyzeHeadless } from './runs/analyze-run';

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
    motionBible: plan.motionBible,
  };
}

export async function runHeadlessCardsTrack(options: {
  ctx: GenerationRunCtx;
  production: ProjectProductionState;
  cards: typeof runAnalyzeHeadless;
}): Promise<{ analysis: AIAnalysisResult; error?: string }> {
  const { ctx, production, cards } = options;
  const project = await loadProjectFile(ctx.projectPath);
  const existing = project.aiAnalysis?.analysisResult ?? analysisFallback(production);
  if (!needsProductionTrack(production, 'cards')) return { analysis: existing };
  const manual = existing.cards.filter((card) => card.generationProvenance?.modifiedByUser).length;
  if (manual > 0) return { analysis: existing, error: `${manual} 个人工精修镜头需人工合并` };
  try {
    const analysis = await cards({ ...ctx, params: { ...ctx.params, useApprovedPlan: true } });
    return {
      analysis,
      error: analysis.cardErrors?.length ? `${analysis.cardErrors.length} 个镜头生成失败` : undefined,
    };
  } catch (error) {
    return { analysis: existing, error: error instanceof Error ? error.message : String(error) };
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
    ));
    return { candidates: provenanced };
  } catch (error) {
    return { candidates: existing, error: error instanceof Error ? error.message : String(error) };
  }
}
