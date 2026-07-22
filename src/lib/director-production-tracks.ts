import { coverAspectRatio, type AICard, type AIAnalysisResult, type CoverCandidate } from '../types/ai';
import type { DirectorPlan, ProjectProductionState } from '../types/director';
import { useAIStore } from '../store/ai';
import { createPersistedAIState } from './ai-persistence';
import { generateCardsFromDirectorPlan } from './director-production';
import { generateSubtitleHighlights } from './subtitle-highlight-runner';
import { useTimelineStore } from '../store/timeline';
import type { DirectorProductionClientOptions } from './director-production-client';
import type { DirectorCoverTrackResult } from './director-production-persistence';

function guard(options: DirectorProductionClientOptions, plan: DirectorPlan) {
  return {
    expectedDirectorRevision: plan.revision,
    expectedTaskId: options.taskId,
  };
}

export function generationTargets(
  plan: DirectorPlan,
  production: ProjectProductionState,
  existingCards: AICard[],
): string[] | undefined {
  if (production.legacyProtected) return [];
  const impact = production.pendingImpact;
  if (!impact && production.outputs.cards.status === 'current') return [];
  const enabled = plan.segments.filter((segment) => segment.enabled).map((segment) => segment.id);
  // 缺卡（生成失败）的镜头永远是补生成候选：不能被 no-op pendingImpact（segmentIds 为空）
  // 屏蔽，否则 quality-blocked 后的恢复制作会空转，失败镜头永远得不到重试。
  const missing = enabled.filter((id) => !existingCards.some((card) => card.segmentId === id));
  const requested = !impact || impact.allCards
    ? enabled
    : [...new Set([...impact.segmentIds, ...missing])];
  return requested.filter((segmentId) => {
    const card = existingCards.find((item) => item.segmentId === segmentId);
    return !card?.generationProvenance?.modifiedByUser
      && card?.generationProvenance?.directorRevision !== plan.revision;
  });
}

export function manualMergeCount(
  production: ProjectProductionState,
  cards: AICard[],
  plan: DirectorPlan,
): number {
  const impact = production.pendingImpact;
  const impactedIds = impact?.allCards ? null : new Set(impact?.segmentIds ?? []);
  return cards.filter((card) => (
    card.generationProvenance?.modifiedByUser
    && (impact
      ? impactedIds == null || impactedIds.has(card.segmentId)
      : card.generationProvenance.directorRevision !== plan.revision)
  )).length;
}

function emptyAnalysis(plan: DirectorPlan): AIAnalysisResult {
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

export function stableCoverPrompts(plan: DirectorPlan, analysis: AIAnalysisResult | null): string[] {
  const selectedPrompt = useAIStore.getState().coverCandidates.find((candidate) => (
    candidate.selected
    && coverAspectRatio(candidate) === '16:9'
    && candidate.prompt.trim().length > 0
  ))?.prompt.trim();
  if (selectedPrompt) return [selectedPrompt];

  const persisted = analysis?.coverPrompts.map((prompt) => prompt.trim()).filter(Boolean) ?? [];
  if (persisted.length > 0) return persisted;
  return plan.coverDirection.prompt ? [plan.coverDirection.prompt] : [];
}

async function persistCardSnapshot(
  options: DirectorProductionClientOptions,
  plan: DirectorPlan,
  cards: Map<string, AICard>,
): Promise<void> {
  const currentAnalysis = useAIStore.getState().analysisResult;
  const snapshot = {
    ...emptyAnalysis(plan),
    coverPrompts: stableCoverPrompts(plan, currentAnalysis),
    cards: [...cards.values()].sort((left, right) => left.startMs - right.startMs),
  };
  useAIStore.getState().setAnalysisResult(snapshot);
  await window.electronAPI.saveProjectSection(
    options.projectDir,
    'aiAnalysis',
    JSON.stringify(createPersistedAIState(snapshot, useAIStore.getState().coverCandidates)),
    guard(options, plan),
  );
}

export async function generateCardsTrack(
  options: DirectorProductionClientOptions,
  plan: DirectorPlan,
  existing: AIAnalysisResult | null,
): Promise<AIAnalysisResult> {
  const segmentIds = generationTargets(plan, options.production, existing?.cards ?? []);
  if (segmentIds?.length === 0) return existing ?? emptyAnalysis(plan);
  const persistedCards = new Map((existing?.cards ?? []).map((card) => [card.segmentId, card]));
  const generated = await generateCardsFromDirectorPlan(options.entries, plan, options.settings, {
    existingCards: existing?.cards,
    segmentIds,
    generateCard: async (_entries, _planning, segment, settings, cardOptions) =>
      window.electronAPI.generateAICardForSegment({
        projectDir: options.projectDir,
        entries: options.entries,
        segment,
        settings,
        globalPrompt: plan.globalPrompt,
        programSummary: plan.summary,
        keywords: plan.keywords,
        motionBible: plan.motionBible,
        projectBindings: useAIStore.getState().projectBindings,
        segmentIndex: cardOptions?.segmentIndex,
        totalSegments: cardOptions?.totalSegments,
        prevSegment: cardOptions?.prevSegment,
        nextSegment: cardOptions?.nextSegment,
        visualType: cardOptions?.visualType,
        qualityMode: 'director',
        feedId: options.taskId,
        telemetryRunId: options.telemetryRunId,
      }),
    onProgress: (progress) => options.onProgress?.({
      track: 'cards',
      percent: progress.percent,
      message: progress.message ?? '生成内容卡片',
    }),
    onCardGenerated: async (card) => {
      persistedCards.set(card.segmentId, card);
      await persistCardSnapshot(options, plan, persistedCards);
    },
  });
  return {
    ...generated,
    coverPrompts: stableCoverPrompts(plan, existing),
  };
}

function coverDecision(
  options: DirectorProductionClientOptions,
  plan: DirectorPlan,
  existing: CoverCandidate[],
) {
  const protectedCandidates = existing.filter(
    (candidate) => candidate.generationProvenance?.modifiedByUser,
  );
  const hasCurrent = existing.some(
    (candidate) => candidate.generationProvenance?.directorRevision === plan.revision,
  );
  const impact = options.production.pendingImpact;
  return {
    protectedCandidates,
    manualMergeCount: impact?.cover || options.production.outputs.cover.status === 'failed'
      ? protectedCandidates.length
      : 0,
    shouldGenerate: !options.production.legacyProtected
      && !hasCurrent
      && (impact ? impact.cover : options.production.outputs.cover.status !== 'current'),
  };
}

function preservedCoverPrompts(plan: DirectorPlan, existing: CoverCandidate[]): string[] {
  const currentRevisionPrompts = existing
    .filter((candidate) => candidate.generationProvenance?.directorRevision === plan.revision)
    .map((candidate) => candidate.prompt.trim())
    .filter(Boolean);
  if (currentRevisionPrompts.length > 0) return [...new Set(currentRevisionPrompts)];

  const persistedPrompts = useAIStore.getState().analysisResult?.coverPrompts
    .map((prompt) => prompt.trim())
    .filter(Boolean) ?? [];
  if (persistedPrompts.length > 0) return persistedPrompts;

  return plan.coverDirection.prompt ? [plan.coverDirection.prompt] : [];
}

async function materializeCovers(
  options: DirectorProductionClientOptions,
  plan: DirectorPlan,
  protectedCandidates: CoverCandidate[],
): Promise<Pick<DirectorCoverTrackResult, 'prompts' | 'candidates'>> {
  options.onProgress?.({ track: 'cover', percent: 10, message: '生成封面提示词' });
  const prompts = await window.electronAPI.regenerateCoverPrompt({
    entries: options.entries,
    settings: options.settings,
    globalPrompt: plan.globalPrompt,
    currentPrompt: plan.coverDirection.prompt,
    projectDir: options.projectDir,
    projectBindings: useAIStore.getState().projectBindings,
  });
  if (options.shouldCancel?.()) return { prompts, candidates: protectedCandidates };
  options.onProgress?.({ track: 'cover', percent: 45, message: '生成封面图' });
  const raw = await window.electronAPI.generateCoverImages({
    prompts,
    settings: options.settings,
    projectDir: options.projectDir,
    projectBindings: useAIStore.getState().projectBindings,
    telemetryRunId: options.telemetryRunId,
  });
  const now = Date.now();
  const candidates = [...protectedCandidates, ...raw.map((candidate) => ({
    ...candidate,
    generationProvenance: {
      directorRevision: plan.revision,
      fingerprint: `cover-${plan.inputFingerprint}-${plan.revision}`,
      generatedAt: now,
      modifiedByUser: false,
    },
  }))];
  useAIStore.getState().setCoverCandidates(candidates);
  await window.electronAPI.saveProjectSection(
    options.projectDir,
    'aiAnalysis',
    JSON.stringify(createPersistedAIState(useAIStore.getState().analysisResult, candidates)),
    guard(options, plan),
  );
  return { prompts, candidates };
}

export async function generateCoverTrack(
  options: DirectorProductionClientOptions,
  plan: DirectorPlan,
  existing: CoverCandidate[],
): Promise<DirectorCoverTrackResult> {
  const decision = coverDecision(options, plan, existing);
  const fallback = {
    prompts: preservedCoverPrompts(plan, existing),
    candidates: existing,
    manualMergeCount: decision.manualMergeCount,
  };
  if (!decision.shouldGenerate) return fallback;
  try {
    const generated = await materializeCovers(options, plan, decision.protectedCandidates);
    options.onProgress?.({ track: 'cover', percent: 100, message: `已生成 ${generated.candidates.length} 张封面` });
    return { ...generated, manualMergeCount: decision.manualMergeCount };
  } catch (error) {
    return { ...fallback, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function generateHighlightsTrack(
  options: DirectorProductionClientOptions,
): Promise<void> {
  if (!options.production.pendingImpact && options.production.outputs.timeline.status === 'current') return;
  // 高亮只依赖字幕内容：已有结果直接复用，避免恢复制作每次都重跑一遍 LLM 高亮。
  if ((useTimelineStore.getState().timeline.subtitleHighlights ?? []).length > 0) return;
  try {
    const highlights = await generateSubtitleHighlights(options.entries, options.settings, {
      concurrency: 4,
      shouldCancel: options.shouldCancel,
      onProgress: (progress) => options.onProgress?.({
        track: 'highlights',
        percent: progress.percent,
        message: `字幕高亮 ${progress.batchIndex}/${progress.batchTotal}`,
      }),
    });
    if (highlights.length > 0 && !options.shouldCancel?.()) {
      const timeline = useTimelineStore.getState();
      timeline.setSubtitleHighlights(highlights);
      timeline.updateSubtitleStyle({ highlightEnabled: true });
    }
  } catch {
    options.onProgress?.({ track: 'highlights', percent: 100, message: '字幕高亮跳过' });
  }
}
