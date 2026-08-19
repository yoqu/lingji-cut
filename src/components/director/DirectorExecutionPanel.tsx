import {
  AlertTriangle,
  AudioLines,
  Ban,
  CheckCircle2,
  Clock3,
  Film,
  ImageIcon,
  Layers3,
  ListVideo,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { createPersistedAIState } from '../../lib/ai-persistence';
import type { DirectorProductionProgress } from '../../lib/director-production-client';
import { canResumeProduction } from '../../lib/director-workflow';
import { registerProductionSaveGuard } from '../../lib/production-save-guard';
import { formatTime, getFileNameFromPath, toFileSrc } from '../../lib/utils';
import { useAIStore } from '../../store/ai';
import { useTimelineStore } from '../../store/timeline';
import type { AIAnalysisCardError, AICard, MediaCardContent } from '../../types/ai';
import {
  resolveDirectorFallbackPolicy,
  resolveDirectorRenderStrategy,
  type DirectorRenderStrategy,
  type DirectorSegmentPlan,
  type ProjectProductionState,
} from '../../types/director';
import type { FootageCompositionInput, FootagePlacement } from '../../types/footage';
import { Alert, Button, PillGroup, Spinner, Textarea } from '../../ui';
import { AICardList } from '../AICardList';
import { ProductionPanel } from '../production/ProductionPanel';
import styles from './DirectorExecutionPanel.module.css';
import { useDirectorCoverControls } from './useDirectorCoverControls';

type ExecutionView = 'cards' | 'cover' | 'audio' | 'quality';
type ShotResultStatus = 'ready' | 'working' | 'pending' | 'fallback' | 'blocked' | 'failed' | 'skipped';

interface ShotExecutionResult {
  segmentId: string;
  index: number;
  title: string;
  summary: string;
  startMs: number;
  endMs: number;
  plannedStrategy: DirectorRenderStrategy;
  actualStrategy: DirectorRenderStrategy;
  status: ShotResultStatus;
  detail: string;
  fallbackReason?: string;
  card?: AICard;
  placement?: FootagePlacement;
  compositionInputs: FootageCompositionInput[];
  hasOutput: boolean;
}

interface GroupedCardError {
  message: string;
  errors: AIAnalysisCardError[];
}

interface VisualTrackFailure {
  track: 'cards' | 'footage';
  label: string;
  message: string;
}

export function DirectorExecutionPanel({
  projectDir,
  production,
  working,
  progress,
  onResume,
  onOpenEditor,
  readOnly = false,
}: {
  projectDir: string;
  production: ProjectProductionState;
  working: boolean;
  progress: Partial<Record<DirectorProductionProgress['track'] | 'director', DirectorProductionProgress>>;
  onResume: () => void;
  onOpenEditor: () => void;
  readOnly?: boolean;
}) {
  const [view, setView] = useState<ExecutionView>('cards');
  const activeView = readOnly && (view === 'audio' || view === 'quality') ? 'cards' : view;
  const deleteCard = useAIStore((state) => state.deleteCard);
  const coverLocked = readOnly || working || production.workflow.stage === 'production-running';
  const cover = useDirectorCoverControls(projectDir, production, coverLocked);
  const { analysisResult, coverCandidates } = cover;
  const canResume = canResumeProduction(production);
  const approvedRevision = production.approvedPlan?.revision;
  const cardsOutputStatus = production.outputs.cards.status;
  const cardsOutputMatches = approvedRevision != null
    && production.outputs.cards.directorRevision === approvedRevision
    && ['generating', 'current', 'failed'].includes(production.outputs.cards.status);
  const footageOutputMatches = approvedRevision != null
    && production.outputs.footage?.directorRevision === approvedRevision
    && ['generating', 'current', 'failed'].includes(production.outputs.footage.status)
    && production.footage?.generationProvenance?.directorRevision === approvedRevision;
  const rawCards = analysisResult?.cards ?? [];
  const rawCardErrors = analysisResult?.cardErrors ?? [];
  const rawFootagePlacements = production.footage?.placements ?? [];
  const rawCompositionInputs = production.footage?.compositionInputs ?? [];
  const cards = cardsOutputMatches
    ? rawCards.filter((card) => card.generationProvenance?.directorRevision === approvedRevision)
    : [];
  // Headless 制作完成前不会覆盖 aiAnalysis；generating 期间磁盘上的错误仍属于上一版。
  const cardErrors = cardsOutputMatches && cardsOutputStatus !== 'generating' ? rawCardErrors : [];
  const groupedCardErrors = groupCardErrors(cardErrors);
  const visualTrackFailures: VisualTrackFailure[] = [
    cardsOutputMatches
      && production.outputs.cards.status === 'failed'
      && production.outputs.cards.error?.trim()
      ? {
          track: 'cards' as const,
          label: '画面',
          message: canonicalProductionErrorMessage(production.outputs.cards.error),
        }
      : null,
    footageOutputMatches
      && production.outputs.footage?.status === 'failed'
      && production.outputs.footage.error?.trim()
      ? {
          track: 'footage' as const,
          label: '素材',
          message: canonicalProductionErrorMessage(production.outputs.footage.error),
        }
      : null,
  ].filter((failure): failure is VisualTrackFailure => failure !== null);
  const planSegments = production.approvedPlan?.segments ?? [];
  const footagePlacements = footageOutputMatches ? rawFootagePlacements : [];
  const compositionInputs = footageOutputMatches ? rawCompositionInputs : [];
  const staleVisualArtifactsHidden = rawCards.length > cards.length
    || rawCardErrors.length > cardErrors.length
    || (
    (rawFootagePlacements.length > 0 || rawCompositionInputs.length > 0) && !footageOutputMatches
  );
  const hasCanonicalShotPlan = planSegments.length > 0
    || footagePlacements.length > 0
    || compositionInputs.length > 0;
  const visibleProduction: ProjectProductionState = {
    ...production,
    footage: footageOutputMatches ? production.footage : null,
    outputs: {
      ...production.outputs,
      cards: cardsOutputMatches
        ? production.outputs.cards
        : { status: 'empty', directorRevision: approvedRevision, updatedAt: production.updatedAt },
      footage: footageOutputMatches
        ? production.outputs.footage
        : { status: 'empty', directorRevision: approvedRevision, updatedAt: production.updatedAt },
    },
  };
  const shotResults = buildShotExecutionResults(visibleProduction, cards, cardErrors, working);
  const enabledResults = shotResults.filter((result) => result.status !== 'skipped');
  const failedCount = enabledResults.filter((result) => result.status === 'failed').length;
  const blockedCount = enabledResults.filter((result) => result.status === 'blocked').length;
  const pendingCount = enabledResults.filter((result) => (
    result.status === 'pending' || result.status === 'working'
  )).length;
  const fallbackCount = enabledResults.filter((result) => result.status === 'fallback').length;
  const motionOutputCount = enabledResults.filter((result) => (
    result.card?.type === 'motion' && result.actualStrategy === 'motion-card'
    && result.status !== 'failed' && result.status !== 'blocked'
  )).length;
  const imageCardOutputCount = enabledResults.filter((result) => (
    result.card?.type === 'image' && result.actualStrategy === 'motion-card'
    && result.status !== 'failed' && result.status !== 'blocked'
  )).length;
  const videoCardOutputCount = enabledResults.filter((result) => (
    result.card?.type === 'video' && result.actualStrategy === 'motion-card'
    && result.status !== 'failed' && result.status !== 'blocked'
  )).length;
  const footageOutputCount = enabledResults.filter((result) => (
    Boolean(result.placement) && result.actualStrategy === 'standalone-media'
    && result.status !== 'failed' && result.status !== 'blocked'
  )).length;
  const compositeOutputCount = enabledResults.filter((result) => (
    Boolean(result.card) && result.actualStrategy === 'agent-composite'
    && result.status === 'ready'
  )).length;
  const inspectedCandidateCount = planSegments.reduce((total, segment) => (
    total + (segment.assetDecisions?.filter((decision) => decision.inspected === true).length ?? 0)
  ), 0);
  const footageQueryCount = planSegments.filter((segment) => Boolean(segment.footageQuery?.trim())).length;
  const frozenAssetCount = new Set([
    ...footagePlacements.map((placement) => placement.sourcePath),
    ...compositionInputs.map((input) => input.asset.path),
  ].filter(Boolean)).size;
  const plannedAllMotion = planSegments.some((segment) => segment.enabled)
    && planSegments.filter((segment) => segment.enabled)
      .every((segment) => (
        resolveDirectorRenderStrategy(segment) === 'motion-card'
        && (segment.visualType == null || segment.visualType === 'motion')
      ));
  const completedOnlyAsMotion = motionOutputCount > 0
    && imageCardOutputCount === 0
    && videoCardOutputCount === 0
    && footageOutputCount === 0
    && compositeOutputCount === 0
    && enabledResults.every((result) => (
      !result.hasOutput || result.actualStrategy === 'motion-card'
    ));
  const showMotionOnlyWarning = !working
    && footageOutputCount === 0
    && compositeOutputCount === 0
    && (enabledResults.some((result) => result.hasOutput) ? completedOnlyAsMotion : plannedAllMotion);
  const productionGuard = production.approvedPlan
    ? { expectedDirectorRevision: production.approvedPlan.revision }
    : {};
  const removeCard = async (cardId: string) => {
    const releaseGuard = registerProductionSaveGuard(productionGuard);
    try {
      await deleteCard(cardId);
      const ai = useAIStore.getState();
      useTimelineStore.getState().removeAICardOverlaysBySourceIds([cardId]);
      await window.electronAPI.saveProjectSection(
        projectDir,
        'aiAnalysis',
        JSON.stringify(createPersistedAIState(ai.analysisResult, ai.coverCandidates)),
        productionGuard,
      );
    } finally {
      releaseGuard();
    }
  };

  return (
    <section className={styles.root} aria-label="制作执行">
      <div className={styles.header}>
        <div>
          <span>{readOnly ? '历史结果 · 只读' : '制作执行'}</span>
          <strong>导演方案 v{production.approvedPlan?.revision}</strong>
        </div>
        <div className={styles.headerActions}>
          {!readOnly && !working && canResume ? (
            <Button variant="primary" size="sm" onClick={onResume} title="补生成失败镜头并重排时间线">继续制作</Button>
          ) : null}
          {!readOnly && production.workflow.stage === 'animatic-review' ? (
            <Button variant="primary" size="sm" onClick={onOpenEditor}>进入编辑器审查</Button>
          ) : null}
        </div>
      </div>

      {working && !readOnly ? <div className={styles.progressGrid}>
        {(['footage', 'cards', 'cover', 'highlights', 'audio', 'timeline'] as const).map((track) => (
          <div key={track} className={styles.progressItem}>
            <span>{TRACK_LABELS[track]}</span>
            <div><i style={{ width: `${progress[track]?.percent ?? 0}%` }} /></div>
            <small>{progress[track]?.message ?? '等待开始'}</small>
          </div>
        ))}
      </div> : null}

      <PillGroup
        fullWidth
        wrap={false}
        value={activeView}
        onChange={setView}
        items={readOnly
          ? [
              { value: 'cards', label: <><ListVideo size={13} />画面</> },
              { value: 'cover', label: <><ImageIcon size={13} />封面</> },
            ]
          : [
              { value: 'cards', label: <><ListVideo size={13} />画面</> },
              { value: 'cover', label: <><ImageIcon size={13} />封面</> },
              { value: 'audio', label: <><AudioLines size={13} />声音</> },
              { value: 'quality', label: <><ShieldCheck size={13} />质检</> },
            ]}
      />

      <div className={styles.content}>
        {activeView === 'cards' ? (
          <>
            {staleVisualArtifactsHidden ? (
              <Alert variant="warning">已隐藏不属于当前批准 v{approvedRevision} 的旧画面产物，重新制作后再显示。</Alert>
            ) : null}
            {hasCanonicalShotPlan ? (
              <section
                className={styles.resultSummary}
                data-state={working
                  ? 'working'
                  : failedCount + blockedCount > 0
                    ? 'danger'
                    : showMotionOnlyWarning || fallbackCount > 0
                      ? 'warning'
                      : pendingCount > 0
                        ? 'pending'
                        : 'ready'}
                data-testid="director-result-summary"
              >
                <div className={styles.resultSummaryLead}>
                  {working
                    ? <Clock3 size={17} />
                    : failedCount + blockedCount > 0
                      ? <XCircle size={17} />
                      : showMotionOnlyWarning || fallbackCount > 0
                        ? <AlertTriangle size={17} />
                        : pendingCount > 0
                          ? <Clock3 size={17} />
                          : <CheckCircle2 size={17} />}
                  <div>
                    <strong>{working
                      ? '正在按导演方案制作'
                      : failedCount + blockedCount > 0
                        ? '部分镜头没有形成可用画面'
                        : showMotionOnlyWarning
                          ? motionOutputCount > 0
                            ? '画面已生成，但媒介结构异常'
                            : '批准方案的媒介结构异常'
                          : fallbackCount > 0
                            ? '画面已生成，包含明确退路'
                            : pendingCount > 0
                              ? '仍有镜头未产出'
                              : '导演镜头已形成制作结果'}</strong>
                    <span>以批准方案为基准核对实际卡片、素材和组合结果</span>
                  </div>
                </div>
                <div className={styles.resultMetrics} aria-label="镜头结果统计">
                  <span data-strategy="motion-card"><Sparkles size={12} />Motion {motionOutputCount}</span>
                  <span data-kind="image"><ImageIcon size={12} />图片卡 {imageCardOutputCount}</span>
                  <span data-kind="video"><Film size={12} />视频卡 {videoCardOutputCount}</span>
                  <span data-strategy="standalone-media"><Film size={12} />真实素材 {footageOutputCount}</span>
                  <span data-strategy="agent-composite"><Layers3 size={12} />Agent Composite {compositeOutputCount}</span>
                  {fallbackCount > 0 ? <span data-status="fallback">回退 {fallbackCount}</span> : null}
                  {failedCount > 0 ? <span data-status="failed">失败 {failedCount}</span> : null}
                  {blockedCount > 0 ? <span data-status="blocked">阻塞 {blockedCount}</span> : null}
                </div>
                <div className={styles.assetAudit}>
                  <span>搜材镜头 {footageQueryCount}</span>
                  <span>已检视候选 {inspectedCandidateCount}</span>
                  <span>冻结素材 {frozenAssetCount}</span>
                </div>
              </section>
            ) : null}

            {showMotionOnlyWarning ? (
              <section className={styles.motionOnlyWarning} data-testid="director-motion-only-warning">
                <AlertTriangle size={18} />
                <div>
                  <strong>{motionOutputCount > 0
                    ? '当前结果仍然全部是 Motion'
                    : '批准方案仍然全部是 Motion'}</strong>
                  <span>
                    实际上屏真实素材 0，Agent Composite 0。零组合说明只能解释导演选择，不能代表媒介结果通过。
                  </span>
                </div>
              </section>
            ) : null}

            {cardErrors.length > 0 || visualTrackFailures.length > 0 ? (
              <section className={styles.failedPanel} data-testid="director-failed-shots">
                <div className={styles.failedHeader}>
                  <span>
                    失败镜头 {cardErrors.length > 0 ? cardErrors.length : failedCount}
                    {' · '}{groupedCardErrors.length + visualTrackFailures.length} 类原因（时间线已暂停排布）
                  </span>
                  {!readOnly && canResume ? (
                    <Button
                      variant="accent"
                      size="xs"
                      onClick={onResume}
                      disabled={working}
                      title="增量补生成失败镜头；全部通过后自动重排时间线"
                    >
                      <RefreshCw size={12} />重试失败镜头
                    </Button>
                  ) : null}
                </div>
                <ul className={styles.failedList}>
                  {visualTrackFailures.map((failure) => (
                    <li key={`track-${failure.track}`} data-track-error={failure.track}>
                      <div>
                        <strong>{failure.message}</strong>
                        <small>{failure.label}轨</small>
                      </div>
                      <span>{failure.label}轨未完成，当前版本不能视为可用结果</span>
                    </li>
                  ))}
                  {groupedCardErrors.map((group) => (
                    <li key={group.message} data-error-count={group.errors.length}>
                      <div>
                        <strong>{group.message}</strong>
                        <small>{group.errors.length} 个镜头</small>
                      </div>
                      <span>{errorShotLabels(group.errors)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {(hasCanonicalShotPlan || readOnly) && shotResults.length > 0 ? (
              <ShotResultGrid
                results={shotResults}
                projectDir={projectDir}
                onOpenEditor={onOpenEditor}
                readOnly={readOnly}
              />
            ) : cards.length > 0 && !readOnly ? (
              <AICardList
                cards={cards}
                onToggleEnabled={(cardId) => useAIStore.getState().toggleCardEnabled(cardId)}
                onDeleteCard={(cardId) => void removeCard(cardId)}
                onEditCard={onOpenEditor}
                onSelect={onOpenEditor}
              />
            ) : <Empty text={working ? '正在按导演方案生成画面' : '尚未生成画面'} />}
          </>
        ) : null}
        {activeView === 'cover' ? <div className={styles.coverWorkspace}>
          <div className={styles.coverActions}>
            <Button variant="secondary" size="sm" onClick={() => void cover.rewritePrompt()} disabled={cover.locked || Boolean(cover.busy) || !analysisResult || cover.entries.length === 0}>
              {cover.busy === 'prompt' ? <Spinner size={13} /> : <RefreshCw size={13} />}重写描述
            </Button>
            <Button variant="primary" size="sm" onClick={() => void cover.generateCovers()} disabled={cover.locked || Boolean(cover.busy) || !cover.coverPrompt.trim()}>
              {cover.busy === 'images' ? <Spinner size={13} /> : <ImageIcon size={13} />}{coverCandidates.length > 0 ? '重新生成封面' : '生成封面'}
            </Button>
          </div>
          {cover.error ? <Alert variant="destructive">{cover.error}</Alert> : null}
          <label className={styles.promptField}>
            <span>封面生成描述</span>
            <Textarea
              key={`${approvedRevision ?? 'none'}:${cover.coverPrompt}`}
              defaultValue={cover.coverPrompt}
              rows={4}
              resize="vertical"
              disabled={cover.locked}
              onBlur={(event) => void cover.savePrompt(event.target.value)}
            />
          </label>
          {coverCandidates.length > 0 ? <div className={styles.coverGrid}>
            {coverCandidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className={styles.coverButton}
                data-selected={candidate.selected}
                aria-pressed={candidate.selected}
                aria-label={`选择封面候选：${candidate.prompt || candidate.id}`}
                disabled={cover.locked}
                onClick={() => void cover.selectCover(candidate.id)}
              >
                {candidate.imageUrl ? <img src={coverSrc(candidate.imageUrl)} alt={candidate.prompt || '封面候选'} /> : <span>{candidate.error ?? '生成失败'}</span>}
              </button>
            ))}
          </div> : <Empty text={working ? '正在生成封面候选' : '尚未生成封面'} />}
        </div> : null}
        {!readOnly && activeView === 'audio' ? <ProductionPanel projectDir={projectDir} compact={false} fixedView="audio" /> : null}
        {!readOnly && activeView === 'quality' ? <ProductionPanel projectDir={projectDir} compact={false} fixedView="quality" /> : null}
      </div>
    </section>
  );
}

function buildShotExecutionResults(
  production: ProjectProductionState,
  cards: AICard[],
  cardErrors: AIAnalysisCardError[],
  working: boolean,
): ShotExecutionResult[] {
  const planSegments = production.approvedPlan?.segments ?? [];
  const cardsBySegment = new Map(cards.map((card) => [card.segmentId, card]));
  const errorsBySegment = new Map<string, AIAnalysisCardError[]>();
  for (const error of cardErrors) {
    const group = errorsBySegment.get(error.segmentId) ?? [];
    group.push(error);
    errorsBySegment.set(error.segmentId, group);
  }
  const placementsBySegment = new Map(
    (production.footage?.placements ?? []).map((placement) => [placement.segmentId, placement]),
  );
  const compositionBySegment = new Map<string, FootageCompositionInput[]>();
  for (const input of production.footage?.compositionInputs ?? []) {
    const group = compositionBySegment.get(input.segmentId) ?? [];
    group.push(input);
    compositionBySegment.set(input.segmentId, group);
  }
  const footageFallbacks = new Set(
    (production.footage?.fallbacks ?? []).map((fallback) => fallback.segmentId),
  );
  const blockedSegments = new Set(production.footage?.blockedSegmentIds ?? []);
  const seen = new Set<string>();
  const rows: Array<{ segment?: DirectorSegmentPlan; segmentId: string; index: number }> = [];

  planSegments.forEach((segment, index) => {
    seen.add(segment.id);
    rows.push({ segment, segmentId: segment.id, index });
  });
  cards.forEach((card) => {
    if (seen.has(card.segmentId)) return;
    seen.add(card.segmentId);
    rows.push({ segmentId: card.segmentId, index: rows.length });
  });
  for (const placement of production.footage?.placements ?? []) {
    if (seen.has(placement.segmentId)) continue;
    seen.add(placement.segmentId);
    rows.push({ segmentId: placement.segmentId, index: placement.segmentIndex });
  }
  for (const input of production.footage?.compositionInputs ?? []) {
    if (seen.has(input.segmentId)) continue;
    seen.add(input.segmentId);
    rows.push({ segmentId: input.segmentId, index: input.segmentIndex });
  }

  return rows.map(({ segment, segmentId, index }) => {
    const card = cardsBySegment.get(segmentId);
    const placement = placementsBySegment.get(segmentId);
    const inputs = compositionBySegment.get(segmentId) ?? [];
    const errors = errorsBySegment.get(segmentId) ?? [];
    const plannedStrategy = segment
      ? resolveDirectorRenderStrategy(segment)
      : placement
        ? 'standalone-media'
        : card?.renderStrategy ?? (inputs.length > 0 ? 'agent-composite' : 'motion-card');
    const report = card?.motionCard?.productionReport;
    const fallbackPolicy = segment ? resolveDirectorFallbackPolicy(segment) : 'motion';
    const reportFallback = report?.fallbackUsed === true;
    const fallbackDecision = segment?.fallbackDecision;
    let actualStrategy: DirectorRenderStrategy = plannedStrategy;

    if (placement) {
      actualStrategy = 'standalone-media';
    } else if (card?.renderStrategy) {
      actualStrategy = card.renderStrategy;
    } else if (inputs.length > 0) {
      actualStrategy = 'agent-composite';
    }
    if (reportFallback) {
      if (fallbackPolicy === 'motion') actualStrategy = 'motion-card';
      if (fallbackPolicy === 'standalone-media') actualStrategy = 'standalone-media';
    } else if (!card && !placement && fallbackDecision) {
      actualStrategy = fallbackDecision.to;
    } else if (!card && footageFallbacks.has(segmentId)) {
      actualStrategy = 'motion-card';
    }

    const blocked = segment?.strategyStatus === 'blocked' || blockedSegments.has(segmentId);
    const reportFailed = report?.status === 'failed'
      || report?.renderOk === false
      || (reportFallback && fallbackPolicy === 'block');
    const hasOutput = Boolean(card || placement);
    const usedFallback = segment?.strategyStatus === 'fallback'
      || Boolean(fallbackDecision)
      || footageFallbacks.has(segmentId)
      || reportFallback
      || (hasOutput && actualStrategy !== plannedStrategy);
    const outputTrack = actualStrategy === 'standalone-media' ? 'footage' : 'cards';
    const outputFailed = production.outputs[outputTrack]?.status === 'failed';
    let status: ShotResultStatus;
    if (segment?.enabled === false) {
      status = 'skipped';
    } else if (blocked) {
      status = 'blocked';
    } else if (errors.length > 0 || reportFailed || (!hasOutput && outputFailed)) {
      status = 'failed';
    } else if (hasOutput && usedFallback) {
      status = 'fallback';
    } else if (hasOutput) {
      status = 'ready';
    } else if (working) {
      status = 'working';
    } else {
      status = 'pending';
    }

    const title = segment?.title?.trim()
      || card?.title?.trim()
      || (placement ? getFileNameFromPath(placement.sourcePath) : segmentId);
    const startMs = segment?.startMs ?? card?.startMs ?? placement?.startMs ?? inputs[0]?.startMs ?? 0;
    const endMs = segment?.endMs
      ?? card?.endMs
      ?? (placement ? placement.startMs + placement.durationMs : undefined)
      ?? (inputs[0] ? inputs[0].startMs + inputs[0].durationMs : undefined)
      ?? startMs;

    return {
      segmentId,
      index,
      title,
      summary: segment?.summary ?? cardPreviewText(card),
      startMs,
      endMs,
      plannedStrategy,
      actualStrategy,
      status,
      detail: shotResultDetail({ status, card, placement, inputs, actualStrategy }),
      fallbackReason: usedFallback
        ? fallbackDecision?.reason
          ?? (reportFallback ? `Agent 合成未通过，按 ${fallbackPolicy} 退路执行` : '素材轨未采用候选，已执行导演退路')
        : undefined,
      card,
      placement,
      compositionInputs: inputs,
      hasOutput,
    };
  });
}

function ShotResultGrid({
  results,
  projectDir,
  onOpenEditor,
  readOnly,
}: {
  results: ShotExecutionResult[];
  projectDir: string;
  onOpenEditor: () => void;
  readOnly: boolean;
}) {
  return (
    <div className={styles.shotGrid} data-testid="director-shot-results">
      {results.map((result) => {
        const strategy = SHOT_STRATEGY_META[result.actualStrategy];
        const status = SHOT_STATUS_META[result.status];
        const StrategyIcon = strategy.Icon;
        const StatusIcon = status.Icon;
        const previewSrc = resultPreviewSrc(result, projectDir);
        const outputLabel = result.actualStrategy === 'motion-card' && result.card?.type === 'image'
          ? '图片卡'
          : result.actualStrategy === 'motion-card' && result.card?.type === 'video'
            ? '视频卡'
            : strategy.label;
        return (
          <button
            key={result.segmentId}
            type="button"
            className={styles.shotCard}
            data-testid="director-shot-result"
            data-strategy={result.actualStrategy}
            data-status={result.status}
            data-read-only={readOnly}
            disabled={readOnly}
            onClick={readOnly ? undefined : onOpenEditor}
            title={readOnly ? `历史结果（只读）：${result.title}` : `在编辑器中查看：${result.title}`}
          >
            <span className={styles.shotPreview}>
              {previewSrc ? <img src={previewSrc} alt="" loading="lazy" /> : <StrategyIcon size={30} />}
              <span className={styles.shotIndex}>#{result.index + 1}</span>
            </span>
            <span className={styles.shotContent}>
              <span className={styles.shotTopline}>
                <span className={styles.strategyBadge} data-strategy={result.actualStrategy}>
                  <StrategyIcon size={12} />{result.hasOutput ? outputLabel : `计划 ${strategy.label}`}
                </span>
                {result.plannedStrategy !== result.actualStrategy ? (
                  <span className={styles.plannedStrategy}>
                    原计划 {SHOT_STRATEGY_META[result.plannedStrategy].label}
                  </span>
                ) : null}
                <span className={styles.shotTime}>
                  {formatTime(result.startMs)}–{formatTime(result.endMs)}
                </span>
              </span>
              <strong>{result.title}</strong>
              {result.summary ? <span className={styles.shotSummary}>{result.summary}</span> : null}
              <span className={styles.shotDetail}>{result.detail}</span>
              {result.fallbackReason ? (
                <span className={styles.fallbackReason}>{result.fallbackReason}</span>
              ) : null}
            </span>
            <span className={styles.shotStatus} data-status={result.status}>
              <StatusIcon size={13} />{status.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function shotResultDetail({
  status,
  card,
  placement,
  inputs,
  actualStrategy,
}: {
  status: ShotResultStatus;
  card?: AICard;
  placement?: FootagePlacement;
  inputs: FootageCompositionInput[];
  actualStrategy: DirectorRenderStrategy;
}): string {
  if (status === 'failed') return '制作失败，详见上方原因汇总';
  if (status === 'blocked') return '导演策略已阻塞，未生成替代 Motion 卡';
  if (status === 'skipped') return '本镜头未启用';
  if (placement) {
    return `${placement.kind === 'video' ? '视频' : '图片'}素材 · ${getFileNameFromPath(placement.sourcePath)}`;
  }
  if (card && actualStrategy === 'agent-composite') {
    const assetCount = Math.max(inputs.length, card.assetBindings?.length ?? 0);
    return `Agent 组件已合成 ${assetCount} 项真实素材`;
  }
  if (card) {
    if (card.type === 'image') return '生成图片卡已完成';
    if (card.type === 'video') return '生成视频卡已完成';
    return 'Motion 卡已完成';
  }
  if (inputs.length > 0) return `已冻结 ${inputs.length} 项素材，组合组件尚未产出`;
  if (status === 'working') return '等待当前制作轨产出';
  return actualStrategy === 'standalone-media' ? '真实素材尚未上屏' : '尚未生成画面';
}

function resultPreviewSrc(result: ShotExecutionResult, projectDir: string): string | null {
  if (result.placement) {
    const value = result.placement.thumbnailFile
      ?? (result.placement.kind === 'image' ? result.placement.sourcePath : undefined);
    return value ? projectMediaSrc(value, projectDir) : null;
  }
  const input = result.compositionInputs.find((item) => item.asset.thumbnailFile)
    ?? result.compositionInputs.find((item) => item.asset.kind === 'image');
  if (input) {
    return projectMediaSrc(input.asset.thumbnailFile ?? input.asset.path, projectDir);
  }
  const binding = result.card?.assetBindings?.find((item) => item.thumbnailFile)
    ?? result.card?.assetBindings?.find((item) => (
      item.kind === 'image' || /\.(?:avif|gif|jpe?g|png|webp)$/iu.test(item.filePath)
    ));
  if (binding) return projectMediaSrc(binding.thumbnailFile ?? binding.filePath, projectDir);
  const media = mediaCardContent(result.card);
  const mediaPath = media?.mediaType === 'video'
    ? media.posterPath ?? media.assetPath
    : media?.assetPath;
  return mediaPath ? projectMediaSrc(mediaPath, projectDir) : null;
}

function mediaCardContent(card?: AICard): MediaCardContent | null {
  if (!card?.content || typeof card.content !== 'object' || !('mediaType' in card.content)) return null;
  return card.content as MediaCardContent;
}

function cardPreviewText(card?: AICard): string {
  if (!card) return '';
  if (typeof card.content === 'string') return card.content;
  const media = mediaCardContent(card);
  if (media) return media.prompt;
  return '';
}

function projectMediaSrc(value: string, projectDir: string): string {
  if (/^(file|https?):\/\//u.test(value) || value.startsWith('/') || /^[a-zA-Z]:[\\/]/u.test(value)) {
    return toFileSrc(value);
  }
  return toFileSrc(`${projectDir.replace(/[\\/]$/u, '')}/${value.replace(/^[\\/]/u, '')}`);
}

function groupCardErrors(errors: AIAnalysisCardError[]): GroupedCardError[] {
  const groups = new Map<string, AIAnalysisCardError[]>();
  for (const error of errors) {
    const message = canonicalCardErrorMessage(error);
    const group = groups.get(message) ?? [];
    group.push(error);
    groups.set(message, group);
  }
  return [...groups.entries()].map(([message, groupedErrors]) => ({ message, errors: groupedErrors }));
}

function canonicalCardErrorMessage(error: AIAnalysisCardError): string {
  return canonicalProductionErrorMessage(error.message, error.segmentId);
}

function canonicalProductionErrorMessage(value: string, segmentId?: string): string {
  let message = value.trim() || '未知制作错误';
  message = message
    .replace(/^Error invoking remote method '[^']+':\s*/u, '')
    .replace(/^[A-Za-z][A-Za-z0-9_]*Error:\s*/u, '');
  if (segmentId) {
    const escapedId = segmentId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    message = message.replace(new RegExp(`镜头\\s+${escapedId}`, 'gu'), '该镜头');
  }
  return message;
}

function errorShotLabels(errors: AIAnalysisCardError[]): string {
  const labels = errors.map((error) => {
    const shot = error.segmentTitle ?? error.segmentId;
    return typeof error.segmentIndex === 'number' ? `第 ${error.segmentIndex + 1} 段 · ${shot}` : shot;
  });
  const visible = labels.slice(0, 6);
  return labels.length > visible.length
    ? `${visible.join('、')}，另 ${labels.length - visible.length} 个镜头`
    : visible.join('、');
}

const TRACK_LABELS = { footage: '素材', cards: '画面', cover: '封面', highlights: '高亮', audio: '声音', timeline: '排布' } as const;

const SHOT_STRATEGY_META = {
  'motion-card': { label: 'Motion', Icon: Sparkles },
  'standalone-media': { label: '真实素材', Icon: Film },
  'agent-composite': { label: 'Agent Composite', Icon: Layers3 },
} satisfies Record<DirectorRenderStrategy, { label: string; Icon: typeof Sparkles }>;

const SHOT_STATUS_META = {
  ready: { label: '完成', Icon: CheckCircle2 },
  working: { label: '生成中', Icon: Clock3 },
  pending: { label: '未产出', Icon: Clock3 },
  fallback: { label: '已回退', Icon: AlertTriangle },
  blocked: { label: '已阻塞', Icon: Ban },
  failed: { label: '失败', Icon: XCircle },
  skipped: { label: '未启用', Icon: Ban },
} satisfies Record<ShotResultStatus, { label: string; Icon: typeof Sparkles }>;

function Empty({ text }: { text: string }) {
  return <div className={styles.empty}>{text}</div>;
}

function coverSrc(value: string): string {
  return /^(file|https?):\/\//u.test(value) ? value : toFileSrc(value);
}
