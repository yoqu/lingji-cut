import { coverAspectRatio, type AICard, type AIAnalysisResult, type CoverCandidate } from '../types/ai';
import {
  resolveDirectorFallbackPolicy,
  resolveDirectorRenderStrategy,
  type DirectorPlan,
  type ProjectProductionState,
} from '../types/director';
import {
  EMPTY_FOOTAGE_TRACK_RESULT,
  type DirectorCompositionAsset,
  type FootageCompositionInput,
  type FootagePlacement,
  type FootageTrackResult,
  type KacutClip,
} from '../types/footage';
import { decideFootageMatch } from './footage-match';
import {
  areFootageArtifactsCurrent,
  freezeFootageCompositionInput,
  freezeFootagePlacement,
  isFootageCompositionInputCurrent,
  type FootageFingerprintReader,
} from './footage-fingerprint';
import { useAIStore } from '../store/ai';
import { createPersistedAIState } from './ai-persistence';
import { generateCardsFromDirectorPlan } from './director-production';
import { generateSubtitleHighlights } from './subtitle-highlight-runner';
import { useTimelineStore } from '../store/timeline';
import type { DirectorProductionClientOptions } from './director-production-client';
import type { DirectorCoverTrackResult } from './director-production-persistence';
import type { AutoRunTelemetry } from './telemetry/auto-run';
import { syncDirectorPlanMotionBible } from './director-workflow';

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
  forcedSegmentIds: Iterable<string> = [],
): string[] | undefined {
  if (production.legacyProtected) return [];
  const forced = new Set(forcedSegmentIds);
  const impact = production.pendingImpact;
  if (!impact && production.outputs.cards.status === 'current' && forced.size === 0) return [];
  const enabled = plan.segments.filter((segment) => segment.enabled).map((segment) => segment.id);
  // 缺卡（生成失败）的镜头永远是补生成候选：不能被 no-op pendingImpact（segmentIds 为空）
  // 屏蔽，否则 quality-blocked 后的恢复制作会空转，失败镜头永远得不到重试。
  const missing = enabled.filter((id) => !existingCards.some((card) => card.segmentId === id));
  const requested = !impact || impact.allCards
    ? enabled
    : [...new Set([...impact.segmentIds, ...missing])];
  return [...new Set([...requested, ...[...forced].filter((id) => enabled.includes(id))])].filter((segmentId) => {
    const card = existingCards.find((item) => item.segmentId === segmentId);
    return !card?.generationProvenance?.modifiedByUser
      && (forced.has(segmentId) || card?.generationProvenance?.directorRevision !== plan.revision);
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
    motionBible: syncDirectorPlanMotionBible(plan),
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
  footage: FootageTrackResult = EMPTY_FOOTAGE_TRACK_RESULT,
): Promise<AIAnalysisResult> {
  // footage 认领协调（名单由先跑的 footage 轨确定，理由见 runTracks 注释）：
  // - 已认领段从出卡目标剔除——该段由素材上屏，不再出卡，同一段不重复出现卡和 footage；
  // - 未认领的 footage 段按 footageFallback 视觉形态出卡（'image' 走现有 image 卡片管线）。
  const claimed = new Set(footage.claimedSegmentIds);
  const blocked = new Set(footage.blockedSegmentIds ?? []);
  const visualTypeOverrides = new Map(
    footage.fallbacks.map((fallback) => [fallback.segmentId, fallback.visualType] as const),
  );
  const renderStrategyOverrides = new Map(
    footage.fallbacks.map((fallback) => [fallback.segmentId, 'motion-card'] as const),
  );
  const compositionInputs = new Map<string, FootageCompositionInput[]>();
  for (const input of footage.compositionInputs ?? []) {
    const inputs = compositionInputs.get(input.segmentId) ?? [];
    inputs.push(input);
    compositionInputs.set(input.segmentId, inputs);
  }
  const applyStandaloneCompositeFallbacks = async (analysis: AIAnalysisResult): Promise<AIAnalysisResult> => {
    if (!analysis.cardErrors?.length) return analysis;
    const recovered = new Set<string>();
    for (const error of analysis.cardErrors) {
      const segmentIndex = plan.segments.findIndex((segment) => segment.id === error.segmentId);
      const segment = plan.segments[segmentIndex];
      if (
        !segment
        || resolveDirectorRenderStrategy(segment) !== 'agent-composite'
        || resolveDirectorFallbackPolicy(segment) !== 'standalone-media'
      ) continue;
      const inputs = compositionInputs.get(segment.id) ?? [];
      const primary = inputs.find((input) => input.usage === 'required') ?? inputs[0];
      if (!primary) continue;
      if (!(await isFootageCompositionInputCurrent(primary, (filePath) => (
        window.electronAPI.getLocalFileFingerprint({ filePath, baseDir: options.projectDir })
      )))) continue;
      if (!footage.placements.some((placement) => placement.segmentId === segment.id)) {
        footage.placements.push(placementFromAsset(segment, segmentIndex, primary));
        footage.placements.sort((left, right) => left.startMs - right.startMs);
      }
      if (!footage.claimedSegmentIds.includes(segment.id)) footage.claimedSegmentIds.push(segment.id);
      claimed.add(segment.id);
      recovered.add(segment.id);
    }
    if (recovered.size === 0) return analysis;
    const remainingErrors = analysis.cardErrors.filter((error) => !recovered.has(error.segmentId));
    return {
      ...analysis,
      cardErrors: remainingErrors.length > 0 ? remainingErrors : undefined,
    };
  };
  // 已认领段若残留旧卡（方案修订把 motion/image 段改成 footage），一并剔除，
  // 保证提交产物里同一段不重复出现卡和 footage。
  const finalizeRouting = async (analysis: AIAnalysisResult): Promise<AIAnalysisResult> => {
    analysis = await applyStandaloneCompositeFallbacks(analysis);
    const routedCards = analysis.cards.filter((card) => (
      !claimed.has(card.segmentId) && !blocked.has(card.segmentId)
    ));
    if (blocked.size === 0) {
      return routedCards.length === analysis.cards.length ? analysis : { ...analysis, cards: routedCards };
    }
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
    return { ...analysis, cards: routedCards, cardErrors: [...existingErrors, ...blockedErrors] };
  };
  // 素材轨重跑会刷新整条组合输入；即使导演 impact 只点名一段，也不能让其它段沿用旧 assetBindings。
  const forcedCompositeTargets = footage.ran
    ? [
        ...compositionInputs.keys(),
        ...footage.fallbacks
          .filter((fallback) => fallback.renderStrategy === 'motion-card')
          .map((fallback) => fallback.segmentId),
      ]
    : [];
  const segmentIds = generationTargets(
    plan,
    options.production,
    existing?.cards ?? [],
    forcedCompositeTargets,
  )
    ?.filter((segmentId) => !claimed.has(segmentId) && !blocked.has(segmentId));
  if (segmentIds?.length === 0) return finalizeRouting(existing ?? emptyAnalysis(plan));
  const persistedCards = new Map((existing?.cards ?? []).map((card) => [card.segmentId, card]));
  const generated = await generateCardsFromDirectorPlan(options.entries, plan, options.settings, {
    existingCards: existing?.cards,
    segmentIds,
    visualTypeOverrides,
    renderStrategyOverrides,
    compositionInputs,
    shouldCancel: options.shouldCancel,
    signal: options.signal,
    generateCard: async (_entries, _planning, segment, settings, cardOptions) =>
      window.electronAPI.generateAICardForSegment({
        projectDir: options.projectDir,
        entries: options.entries,
        segment,
        settings,
        globalPrompt: plan.globalPrompt,
        programSummary: plan.summary,
        keywords: plan.keywords,
        motionBible: cardOptions?.motionBible ?? syncDirectorPlanMotionBible(plan),
        projectBindings: useAIStore.getState().projectBindings,
        segmentIndex: cardOptions?.segmentIndex,
        totalSegments: cardOptions?.totalSegments,
        prevSegment: cardOptions?.prevSegment,
        nextSegment: cardOptions?.nextSegment,
        visualType: cardOptions?.visualType,
        renderStrategy: cardOptions?.renderStrategy,
        compositionIntent: cardOptions?.compositionIntent,
        compositionInputs: cardOptions?.compositionInputs,
        fallbackPolicy: cardOptions?.fallbackPolicy,
        approvedFallbackExecution: cardOptions?.approvedFallbackExecution,
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
  return finalizeRouting({
    ...generated,
    coverPrompts: stableCoverPrompts(plan, existing),
  });
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
    workTitle: plan.title,
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

// ─────────────────────────────────────────────────────────────
// footage 轨（第五条并行轨）：导演方案里 visualType='footage' 的段，
// 通过本机 KaCut MCP 服务检索素材库真实素材，命中即作为视频/图片 overlay 上屏，
// 替代该段的 motion 卡片。KaCut 不可用时优雅降级（退 footageFallback 出卡），
// 本轨任何失败都不影响其他轨——函数对外契约是永不抛错。
// ─────────────────────────────────────────────────────────────

const FOOTAGE_SEARCH_LIMIT = 5;

/** 未认领段统一退路：该段 footageFallback（缺省 motion）。 */
function fallbackVisualType(segment: { footageFallback?: 'image' | 'motion' }): 'image' | 'motion' {
  return segment.footageFallback === 'image' ? 'image' : 'motion';
}

function validCompositionAssets(
  segment: DirectorPlan['segments'][number],
): DirectorCompositionAsset[] {
  const hasExplicitAssets = Array.isArray(segment.compositionAssets)
    && segment.compositionAssets.length > 0;
  const explicit = Array.isArray(segment.compositionAssets)
    ? segment.compositionAssets.filter((input) => (
        input
        && (input.usage === 'required' || input.usage === 'optional')
        && input.asset?.path?.trim()
        && (input.asset.kind === 'video' || input.asset.kind === 'image')
      ))
    : [];
  if (resolveDirectorRenderStrategy(segment) === 'standalone-media') {
    const required = explicit.find((input) => input.usage === 'required');
    if (required) return [required];
    if (hasExplicitAssets) return [];
  }
  if (explicit.length > 0) return explicit;
  const selected = segment.selectedFootage;
  return selected?.path?.trim() && (selected.kind === 'video' || selected.kind === 'image')
    ? [{ asset: selected, usage: 'required' }]
    : [];
}

function assetTrimStartMs(input: DirectorCompositionAsset): number {
  if (input.asset.kind !== 'video') return 0;
  if (Number.isFinite(input.trimStartMs)) return Math.max(0, Math.round(input.trimStartMs ?? 0));
  return Math.max(0, Math.round((input.asset.matchedSegmentStart ?? 0) * 1_000));
}

function compositionInput(
  segment: DirectorPlan['segments'][number],
  segmentIndex: number,
  input: DirectorCompositionAsset,
): FootageCompositionInput {
  return {
    segmentIndex,
    segmentId: segment.id,
    startMs: segment.startMs,
    durationMs: Math.max(1, Math.round(segment.endMs - segment.startMs)),
    asset: input.asset,
    usage: input.usage,
    trimStartMs: assetTrimStartMs(input),
  };
}

function placementFromAsset(
  segment: DirectorPlan['segments'][number],
  segmentIndex: number,
  input: DirectorCompositionAsset & { fileFingerprint?: string },
): FootagePlacement {
  const { asset } = input;
  return {
    segmentIndex,
    segmentId: segment.id,
    overlayId: `footage-${segment.id}`,
    startMs: segment.startMs,
    durationMs: Math.max(1, Math.round(segment.endMs - segment.startMs)),
    sourcePath: asset.path,
    fileFingerprint: input.fileFingerprint,
    kind: asset.kind,
    trimStartMs: assetTrimStartMs(input),
    score: Number.isFinite(asset.score) ? asset.score : 0,
    thumbnailFile: asset.thumbnailFile,
    composition: segment.composition,
    cameraMove: segment.cameraMove,
    mediaRole: segment.mediaRole,
  };
}

export async function generateFootageTrack(
  options: DirectorProductionClientOptions,
  plan: DirectorPlan,
  telemetry: AutoRunTelemetry | null,
): Promise<FootageTrackResult> {
  const readFingerprint: FootageFingerprintReader = (filePath) =>
    window.electronAPI.getLocalFileFingerprint({ filePath, baseDir: options.projectDir });
  const footageSegments = plan.segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => (
      segment.enabled && resolveDirectorRenderStrategy(segment) !== 'motion-card'
    ));
  if (footageSegments.length === 0 || options.production.legacyProtected) {
    return EMPTY_FOOTAGE_TRACK_RESULT;
  }
  const applyMissingAssetFallbacks = (
    targets: typeof footageSegments,
    fallbacks: FootageTrackResult['fallbacks'],
    blockedSegmentIds: string[],
  ) => {
    for (const { segment } of targets) {
      if (resolveDirectorRenderStrategy(segment) === 'agent-composite') {
        if (resolveDirectorFallbackPolicy(segment) === 'motion') {
          fallbacks.push({
            segmentId: segment.id,
            visualType: 'motion',
            renderStrategy: 'motion-card',
          });
        } else {
          blockedSegmentIds.push(segment.id);
        }
        continue;
      }
      if (
        segment.renderStrategy === 'standalone-media'
        && segment.compositionAssets?.some((binding) => binding.usage === 'required')
      ) {
        blockedSegmentIds.push(segment.id);
        continue;
      }
      fallbacks.push({
        segmentId: segment.id,
        visualType: fallbackVisualType(segment),
      });
    }
  };

  // 恢复制作：产物 current 且 provenance 匹配本修订版时整份复用，不重新检索 KaCut。
  // 存在卡片级 impact（方案修订影响分段）时重新检索——检索是本机 HTTP，成本可忽略。
  const impact = options.production.pendingImpact;
  const cardsImpacted = Boolean(impact && (impact.allCards || impact.segmentIds.length > 0));
  const persisted = options.production.footage;
  const expectedFingerprint = `footage-${plan.inputFingerprint}-${plan.revision}`;
  const persistedFilesCurrent = persisted
    ? await areFootageArtifactsCurrent(
        persisted.placements,
        persisted.compositionInputs ?? [],
        readFingerprint,
      )
    : false;
  if (
    !cardsImpacted
    && persisted
    && persistedFilesCurrent
    && options.production.outputs.footage?.status === 'current'
    && options.production.outputs.footage.directorRevision === plan.revision
    && persisted.generationProvenance?.directorRevision === plan.revision
    && persisted.generationProvenance.fingerprint === expectedFingerprint
  ) {
    return {
      ran: false,
      reused: true,
      placements: persisted.placements,
      compositionInputs: persisted.compositionInputs ?? [],
      claimedSegmentIds: persisted.claimedSegmentIds,
      fallbacks: persisted.fallbacks,
      blockedSegmentIds: persisted.blockedSegmentIds ?? [],
    };
  }

  const startedAt = Date.now();
  telemetry?.event('stage.start', { stage: 'footage', segments: footageSegments.length });
  const emitStageEnd = (extra: Record<string, unknown>) =>
    telemetry?.event('stage.end', { stage: 'footage', durationMs: Date.now() - startedAt, ...extra });

  const manualAssets = new Map(
    footageSegments.map(({ segment }) => [segment.id, validCompositionAssets(segment)] as const),
  );
  const manualTargets = footageSegments.filter(({ segment }) => (
    (manualAssets.get(segment.id)?.length ?? 0) > 0
  ));
  const manualIds = new Set(manualTargets.map(({ segment }) => segment.id));
  const automaticTargets = footageSegments.filter(({ segment }) => !manualIds.has(segment.id));
  const placements: FootagePlacement[] = [];
  const compositionInputs: FootageCompositionInput[] = [];
  const claimedSegmentIds: string[] = [];
  const fallbacks: FootageTrackResult['fallbacks'] = [];
  const blockedSegmentIds: string[] = [];
  let matched = 0;
  const reportProgress = (message: string) => {
    matched += 1;
    options.onProgress?.({
      track: 'footage',
      percent: Math.round((matched / footageSegments.length) * 100),
      message,
    });
  };

  for (const { segment, index } of manualTargets) {
    const assets = manualAssets.get(segment.id) ?? [];
    const frozenAssets = await Promise.all(assets.map(async (asset) => {
      const frozen = await freezeFootageCompositionInput(
        compositionInput(segment, index, asset),
        readFingerprint,
      );
      return { asset, frozen };
    }));
    const requiredInvalid = frozenAssets.some(({ asset, frozen }) => asset.usage === 'required' && !frozen);
    const validInputs = frozenAssets.flatMap(({ frozen }) => frozen ? [frozen] : []);
    if (requiredInvalid || validInputs.length === 0) {
      applyMissingAssetFallbacks([{ segment, index }], fallbacks, blockedSegmentIds);
      telemetry?.event('footage.match', {
        segmentIndex: index,
        segmentId: segment.id,
        query: segment.footageQuery?.trim() ?? '',
        topScore: null,
        decision: 'none',
        manuallySelected: true,
        error: requiredInvalid ? '必用素材不存在或已变化' : '已选素材不可用',
      });
      reportProgress(`已选素材失效 ${matched + 1}/${footageSegments.length}`);
      continue;
    }
    const selected = validInputs[0].asset;
    if (resolveDirectorRenderStrategy(segment) === 'agent-composite') {
      compositionInputs.push(...validInputs);
    } else {
      const primary = validInputs.find((asset) => asset.usage === 'required') ?? validInputs[0];
      const placement = await freezeFootagePlacement(
        placementFromAsset(segment, index, primary),
        readFingerprint,
      );
      if (!placement) {
        applyMissingAssetFallbacks([{ segment, index }], fallbacks, blockedSegmentIds);
        reportProgress(`已选素材失效 ${matched + 1}/${footageSegments.length}`);
        continue;
      }
      placements.push(placement);
      claimedSegmentIds.push(segment.id);
    }
    telemetry?.event('footage.match', {
      segmentIndex: index,
      segmentId: segment.id,
      query: segment.footageQuery?.trim() ?? '',
      topScore: selected.score,
      decision: 'adopt',
      manuallySelected: true,
      assetId: selected.id,
      kind: selected.kind,
    });
    reportProgress(`采用已选素材 ${matched + 1}/${footageSegments.length}`);
  }

  if (automaticTargets.length === 0) {
    emitStageEnd({ ok: true, adopted: placements.length, fallbacks: 0, manuallySelected: placements.length });
    return {
      ran: true,
      placements,
      compositionInputs,
      claimedSegmentIds,
      fallbacks,
      blockedSegmentIds,
    };
  }

  const kacut = options.settings.kacut;
  const baseUrl = kacut?.baseUrl?.trim() ?? '';
  if (!kacut?.enabled || !baseUrl) {
    // 人工选择不依赖服务；只有尚未选择的段按导演退路出卡。
    applyMissingAssetFallbacks(automaticTargets, fallbacks, blockedSegmentIds);
    emitStageEnd({ ok: true, skipped: 'disabled', adopted: placements.length, manuallySelected: placements.length });
    return {
      ran: true,
      placements,
      compositionInputs,
      claimedSegmentIds,
      fallbacks,
      blockedSegmentIds,
    };
  }

  // 健康检查只做一次；不可用记一次 kacut.unavailable 后整轨跳过。
  try {
    await window.electronAPI.kacutHealth(baseUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    telemetry?.event('kacut.unavailable', { error: message });
    emitStageEnd({
      ok: true,
      unavailable: true,
      adopted: placements.length,
      manuallySelected: manualTargets.length,
    });
    options.onProgress?.({ track: 'footage', percent: 100, message: '素材库不可用，段落退回出卡' });
    applyMissingAssetFallbacks(automaticTargets, fallbacks, blockedSegmentIds);
    return {
      ran: true,
      unavailable: true,
      error: message,
      placements,
      compositionInputs,
      claimedSegmentIds,
      fallbacks,
      blockedSegmentIds,
    };
  }

  try {
    await Promise.all(automaticTargets.map(async ({ segment, index }) => {
      const fallbackType = fallbackVisualType(segment);
      const query = segment.footageQuery?.trim() ?? '';
      let top: KacutClip | null = null;
      let topKind: 'video' | 'image' = 'video';
      let searchError: string | undefined;
      if (query) {
        try {
          // kind 优先 video；无命中（空数组，不算错误）再试 image。
          const videos = await window.electronAPI.kacutSearchClips({
            baseUrl, query, kind: 'video', limit: FOOTAGE_SEARCH_LIMIT,
          });
          if (videos.length > 0) {
            top = [...videos].sort((a, b) => b.score - a.score)[0];
          } else {
            const images = await window.electronAPI.kacutSearchClips({
              baseUrl, query, kind: 'image', limit: FOOTAGE_SEARCH_LIMIT,
            });
            topKind = 'image';
            top = images.length > 0 ? [...images].sort((a, b) => b.score - a.score)[0] : null;
          }
        } catch (error) {
          searchError = error instanceof Error ? error.message : String(error);
        }
      }
      const verdict = decideFootageMatch(top?.score ?? null, fallbackType);
      telemetry?.event('footage.match', {
        segmentIndex: index,
        segmentId: segment.id,
        query,
        topScore: top?.score ?? null,
        decision: verdict.decision,
        ...(searchError ? { error: searchError } : {}),
      });
      reportProgress(`检索素材 ${matched + 1}/${footageSegments.length}`);
      if (verdict.decision === 'adopt' && top) {
        const matchedAsset: DirectorCompositionAsset = {
          usage: 'required',
          asset: {
            id: top.id,
            filename: top.filename,
            path: top.path,
            kind: topKind,
            score: top.score,
            durationSec: top.durationSec,
            thumbnailFile: top.thumbnailFile,
            matchedSegmentStart: top.matchedSegmentStart,
            pixelWidth: top.pixelWidth,
            pixelHeight: top.pixelHeight,
          },
        };
        if (resolveDirectorRenderStrategy(segment) === 'agent-composite') {
          const input = await freezeFootageCompositionInput(
            compositionInput(segment, index, matchedAsset),
            readFingerprint,
          );
          if (input) compositionInputs.push(input);
          else applyMissingAssetFallbacks([{ segment, index }], fallbacks, blockedSegmentIds);
        } else {
          const placement = await freezeFootagePlacement(
            placementFromAsset(segment, index, matchedAsset),
            readFingerprint,
          );
          if (placement) {
            placements.push(placement);
            claimedSegmentIds.push(segment.id);
          } else {
            applyMissingAssetFallbacks([{ segment, index }], fallbacks, blockedSegmentIds);
          }
        }
      } else {
        applyMissingAssetFallbacks([{ segment, index }], fallbacks, blockedSegmentIds);
      }
    }));
    const segmentOrder = new Map(footageSegments.map(({ segment, index }) => [segment.id, index]));
    placements.sort((a, b) => a.startMs - b.startMs);
    compositionInputs.sort((a, b) => a.startMs - b.startMs);
    claimedSegmentIds.sort((a, b) => (segmentOrder.get(a) ?? 0) - (segmentOrder.get(b) ?? 0));
    fallbacks.sort((a, b) => (segmentOrder.get(a.segmentId) ?? 0) - (segmentOrder.get(b.segmentId) ?? 0));
    blockedSegmentIds.sort((a, b) => (segmentOrder.get(a) ?? 0) - (segmentOrder.get(b) ?? 0));
    emitStageEnd({
      ok: true,
      adopted: placements.length,
      fallbacks: fallbacks.length,
      manuallySelected: manualTargets.length,
    });
    return {
      ran: true,
      placements,
      compositionInputs,
      claimedSegmentIds,
      fallbacks,
      blockedSegmentIds,
    };
  } catch (error) {
    // footage 轨绝不影响其他轨：保留已经确认的放置，其余段按退路出卡。
    const message = error instanceof Error ? error.message : String(error);
    const completedIds = new Set([
      ...claimedSegmentIds,
      ...compositionInputs.map((input) => input.segmentId),
      ...fallbacks.map((fallback) => fallback.segmentId),
      ...blockedSegmentIds,
    ]);
    applyMissingAssetFallbacks(
      automaticTargets.filter(({ segment }) => !completedIds.has(segment.id)),
      fallbacks,
      blockedSegmentIds,
    );
    emitStageEnd({ ok: false, error: message });
    return {
      ran: true,
      error: message,
      placements,
      compositionInputs,
      claimedSegmentIds,
      fallbacks,
      blockedSegmentIds,
    };
  }
}
