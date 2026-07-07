import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createPersistedAIState,
  removeCardsInResult,
  setAllCardsEnabledInResult,
  selectCoverCandidate,
  toggleCardEnabledInResult,
} from '../lib/ai-persistence';
import { getAISettingsIssue } from '../lib/ai-settings';
import { createAnalyzeProgressBridge } from '../lib/analyze-progress-bridge';
import type { ManualCardKind } from '../lib/manual-card-types';
import { useAIStore, loadAISettings } from '../store/ai';
import { useTaskProgressStore } from '../store/task-progress';
import { getProjectDir, useTimelineStore } from '../store/timeline';
import {
  buildAICardTimelineDraft,
  coverAspectRatio,
  type AICard,
  type AIAnalysisCardError,
  type AIAnalysisResult,
  type CoverCandidate,
} from '../types/ai';
import { AICardList, type AICardPlacement, type AICardSkeleton } from './AICardList';
import { AppIcon } from './AppIcon';
import { AICoverPanel } from './AICoverPanel';
import { CoverEditorModal } from './CoverEditorModal';
import { SubtitleCardDialog } from './SubtitleCardDialog';
import type {
  CoverEditState,
  CoverSaveMode,
} from '../lib/cover-editor/contracts';
import {
  ActionBar,
  Alert,
  Badge,
  Button,
  Spinner,
  StepIndicator,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '../ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/components/dropdown-menu';
import { createAutoRunTelemetry } from '../lib/telemetry/auto-run';
import styles from './AIPanel.module.css';

interface AIPanelProps {
  compact: boolean;
  railHeight?: number;
  inspectedCardId?: string | null;
  onClearInspector?: () => void;
  onOpenCardInspector?: (cardId: string) => void;
  onOpenSettings?: () => void;
}

type AITabKey = 'cards' | 'cover';

const TAB_META: Record<AITabKey, { label: string; shortLabel: string }> = {
  cards: { label: '内容卡片', shortLabel: '卡片' },
  cover: { label: '封面', shortLabel: '封面' },
};
const SUB_TABS: AITabKey[] = ['cards', 'cover'];
// 稳定空引用：非增量阶段传给 AICardList 的 skeletons，避免每次渲染新建数组。
const NO_SKELETONS: AICardSkeleton[] = [];

export function AIPanel({
  compact,
  railHeight: _railHeight,
  inspectedCardId = null,
  onClearInspector,
  onOpenCardInspector,
  onOpenSettings,
}: AIPanelProps) {
  const {
    srtEntries,
    timeline,
    addAICardsToTimeline,
    removeAICardOverlaysBySourceIds,
    setGlobalBackground,
  } = useTimelineStore();
  const {
  analysisResult,
  isAnalyzing,
  analysisError,
  coverCandidates,
  isGeneratingCovers,
  incrementalAnalysis,
  activeTab: storeActiveTab,
  setAnalysisResult,
  setAnalyzing,
  setAnalysisError,
  setCoverCandidates,
  selectCover,
  setGeneratingCovers,
  setActiveTab,
} = useAIStore();
  const [activeTab, setActiveTabLocal] = useState<AITabKey>(storeActiveTab);
  const [manualMediaDialogInitial, setManualMediaDialogInitial] = useState<{
    text: string;
    startMs: number;
    endMs: number;
    kind?: ManualCardKind;
    title?: string;
    insertToTimeline?: boolean;
    allowedKinds?: ManualCardKind[];
    requireText?: boolean;
  } | null>(null);

  useEffect(() => {
    setActiveTabLocal(storeActiveTab);
  }, [storeActiveTab]);

  const handleTabChange = useCallback(
    (tab: AITabKey) => {
      setActiveTabLocal(tab);
      setActiveTab(tab);
    },
    [setActiveTab],
  );

  const [isRegeneratingCoverPrompt, setIsRegeneratingCoverPrompt] = useState(false);
  const [retryingSegmentIds, setRetryingSegmentIds] = useState<Set<string>>(() => new Set());
  const [isRetryingAllFailedCards, setIsRetryingAllFailedCards] = useState(false);
  const [globalPromptDraft, setGlobalPromptDraft] = useState('');
  const [aiSettingsIssue, setAISettingsIssue] = useState<string | null>(() =>
    getAISettingsIssue(null),
  );

  useEffect(() => {
    let cancelled = false;

    void loadAISettings()
      .then((settings) => {
        if (!cancelled) {
          setAISettingsIssue(getAISettingsIssue(settings));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAISettingsIssue(getAISettingsIssue(null));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const enabledCount = analysisResult?.cards.filter((card) => card.enabled).length ?? 0;
  const failedCardErrors = analysisResult?.cardErrors ?? [];
  const isRetryingAnyFailedCard = retryingSegmentIds.size > 0 || isRetryingAllFailedCards;
  const enabledCardIds =
    analysisResult?.cards.filter((card) => card.enabled).map((card) => card.id) ?? [];
  const selectedCount = enabledCardIds.length;
  const selectedCoverCandidate =
    coverCandidates.find((candidate) => candidate.selected) ?? coverCandidates[0] ?? null;

  const cardPlacements = (timeline.overlays ?? []).reduce<Record<string, AICardPlacement>>(
    (placements, overlay) => {
      if (overlay.overlayType !== 'ai-card') {
        return placements;
      }

      const sourceCardId = overlay.aiCardData?.sourceCardId;
      if (!sourceCardId || placements[sourceCardId]) {
        return placements;
      }

      const track = timeline.tracks?.find((item) => item.id === overlay.trackId);
      placements[sourceCardId] = {
        trackId: overlay.trackId,
        trackLabel: track?.label ?? overlay.trackId,
      };
      return placements;
    },
    {},
  );

  useEffect(() => {
    setGlobalPromptDraft(analysisResult?.globalPrompt ?? '');
  }, [analysisResult?.globalPrompt]);

  // 落盘由 store/ai.ts 订阅自动完成；这里仅返回规范化快照供调用方回灌。
  const persistAIState = useCallback(
    async (
      result: AIAnalysisResult | null,
      candidates: CoverCandidate[],
    ) => createPersistedAIState(result, candidates),
    [],
  );

  const handleToggleEnabled = useCallback(
    (cardId: string) => {
      const nextResult = toggleCardEnabledInResult(analysisResult, cardId);
      if (!nextResult) {
        return;
      }

      setAnalysisResult(nextResult);
      void persistAIState(nextResult, coverCandidates).then((persistedState) => {
        if (persistedState.analysisResult) {
          setAnalysisResult(persistedState.analysisResult);
        }
        setCoverCandidates(persistedState.coverCandidates);
      });
    },
    [analysisResult, coverCandidates, persistAIState, setAnalysisResult, setCoverCandidates],
  );

  const handleSelectCover = useCallback(
    (candidateId: string) => {
      const nextCandidates = selectCoverCandidate(coverCandidates, candidateId);
      selectCover(candidateId);
      void persistAIState(analysisResult, nextCandidates).then((persistedState) => {
        if (persistedState.analysisResult) {
          setAnalysisResult(persistedState.analysisResult);
        }
        setCoverCandidates(persistedState.coverCandidates);
      });
    },
    [analysisResult, coverCandidates, persistAIState, selectCover, setAnalysisResult, setCoverCandidates],
  );

  const handlePersistedCovers = useCallback(
    async (candidates: CoverCandidate[], result: AIAnalysisResult | null = analysisResult) => {
      const persistedState = await persistAIState(result, candidates);
      if (persistedState.analysisResult) {
        setAnalysisResult(persistedState.analysisResult);
      }
      setCoverCandidates(persistedState.coverCandidates);
    },
    [analysisResult, persistAIState, setAnalysisResult, setCoverCandidates],
  );

  const handleSaveCoverPrompt = useCallback(
    async (prompts: string[]) => {
      const nextPrompts = prompts.map((prompt) => prompt.trim()).filter(Boolean).slice(0, 1);
      if (nextPrompts.length === 0) {
        setAnalysisError('封面提示词不能为空');
        throw new Error('封面提示词不能为空');
      }

      if (!analysisResult) {
        setAnalysisError('当前没有可保存的 AI 分析结果');
        throw new Error('当前没有可保存的 AI 分析结果');
      }

      const nextResult: AIAnalysisResult = {
        ...analysisResult,
        coverPrompts: nextPrompts,
      };
      setAnalysisError(null);
      setAnalysisResult(nextResult);
      const persistedState = await persistAIState(nextResult, coverCandidates);
      const persistedResult = persistedState.analysisResult ?? nextResult;
      setAnalysisResult(persistedResult);
      setCoverCandidates(persistedState.coverCandidates);
      return persistedResult;
    },
    [
      analysisResult,
      coverCandidates,
      persistAIState,
      setAnalysisError,
      setAnalysisResult,
      setCoverCandidates,
    ],
  );

  const handleAddCoverToTimeline = useCallback(
    (candidateId: string) => {
      const candidate = coverCandidates.find((item) => item.id === candidateId);
      if (!candidate?.imageUrl) {
        return;
      }

      setGlobalBackground(candidate.imageUrl);
    },
    [coverCandidates, setGlobalBackground],
  );

  const [editingCoverId, setEditingCoverId] = useState<string | null>(null);
  const editingCandidate =
    coverCandidates.find((c) => c.id === editingCoverId) ?? null;

  const handleOpenCoverEditor = useCallback((candidateId: string) => {
    setEditingCoverId(candidateId);
  }, []);

  const handleCloseCoverEditor = useCallback(() => {
    setEditingCoverId(null);
  }, []);

  const handleCoverEditSave = useCallback(
    async ({
      mode,
      dataUrl,
      edits,
    }: {
      mode: CoverSaveMode;
      dataUrl: string;
      edits: CoverEditState;
    }) => {
      if (!editingCandidate) return;
      const projectDir = getProjectDir();
      if (!projectDir) return;
      const api = window.electronAPI;
      if (!api?.saveCoverEdit) return;
      const result = await api.saveCoverEdit({
        projectDir,
        sourceCandidateId: editingCandidate.id,
        sourceImageUrl: editingCandidate.imageUrl,
        sourcePrompt: editingCandidate.prompt,
        dataUrl,
        edits,
        mode,
      });
      const store = useAIStore.getState();
      if (mode === 'append') {
        store.appendCoverCandidate({
          id: result.candidateId,
          prompt: editingCandidate.prompt,
          imageUrl: result.imageUrl,
          selected: false,
          editedFrom: result.editedFrom,
          edits,
          createdAt: result.createdAt,
        });
      } else {
        // 覆盖模式：imageUrl 保持纯路径；用 createdAt 驱动 React 重渲染 + `<img>` src 的缓存破坏查询串
        store.replaceCoverCandidate(editingCandidate.id, {
          imageUrl: result.imageUrl,
          edits,
          createdAt: result.createdAt,
        });
      }
      setEditingCoverId(null);
    },
    [editingCandidate],
  );

  // 同步重入锁：防止分析进行中再次触发（如反复点击头部刷新按钮）导致并发多条分析任务、
  // 底部进度条出现多个「内容卡片分析」。设为 ref 而非依赖 isAnalyzing 状态，避免 setAnalyzing
  // 异步生效前的竞态窗口。
  const analyzeInFlightRef = useRef(false);

  const handleAnalyze = useCallback(async () => {
    const settings = await loadAISettings();
    const settingsIssue = getAISettingsIssue(settings);
    if (settingsIssue) {
      setAISettingsIssue(settingsIssue);
      setAnalysisError(settingsIssue);
      onOpenSettings?.();
      return;
    }
    if (!settings) {
      setAISettingsIssue(getAISettingsIssue(null));
      setAnalysisError('请先完成 AI 配置');
      onOpenSettings?.();
      return;
    }

    setAISettingsIssue(null);

    if (!timeline.podcast.srtPath) {
      setAnalysisError('请先导入 SRT 字幕文件');
      return;
    }

    // 已有分析在跑则忽略本次触发（此处到进入 try 之间无 await，置位是原子的）。
    if (analyzeInFlightRef.current) return;
    analyzeInFlightRef.current = true;

    setAnalysisError(null);
    setAnalyzing(true);

    const analyzeTaskId = `ai-analyze-cards-${Date.now()}`;
    useTaskProgressStore.getState().startTask({
      id: analyzeTaskId,
      category: 'ai-analyze',
      label: analysisResult ? '内容卡片重新分析' : '内容卡片分析',
      // planning 阶段先用 streaming（脉冲）表明在跑；进入卡片阶段后桥会切换为 determinate。
      mode: 'streaming',
      progress: 0,
      phase: analysisResult ? '重新组织卡片' : '规划分段与封面提示词…',
      level: 2,
      canCancel: false,
    });

    // 订阅 analyze-progress，实时把 planning 心跳 / 卡片 0..N 进度喂给统一进度条。
    // 复用与一键流水线相同的进度映射逻辑（src/lib/analyze-progress-bridge）。
    const progressBridge = createAnalyzeProgressBridge(analyzeTaskId, {
      subscribe: (callback) => window.electronAPI.onAnalyzeProgress(callback),
      updateTask: (id, patch) => useTaskProgressStore.getState().updateTask(id, patch),
      cardTasks: {
        startTask: (input) => useTaskProgressStore.getState().startTask(input),
        updateTask: (id, patch) => useTaskProgressStore.getState().updateTask(id, patch),
        completeTask: (id) => useTaskProgressStore.getState().completeTask(id),
        failTask: (id, error) => useTaskProgressStore.getState().failTask(id, error),
        hasTask: (id) => useTaskProgressStore.getState().tasks.has(id),
      },
    });

    // 增量呈现：planning 完成→铺骨架；每张卡片完成→填充内容区并自动落轨。
    // 卡片失败沿用既有 analyze-progress(card.status==='failed') 把骨架标记为失败态。
    const oldCardSourceIds = analysisResult?.cards.map((card) => card.id) ?? [];
    let clearedOldCards = false;
    const unsubscribePlanning = window.electronAPI.onAnalyzePlanningDone(
      (planning) => {
        // 重分析：planning 成功后先移除旧 AI 卡，再按新分段增量重建，避免新旧重叠。
        if (!clearedOldCards) {
          clearedOldCards = true;
          if (oldCardSourceIds.length > 0) {
            useTimelineStore
              .getState()
              .removeAICardOverlaysBySourceIds(oldCardSourceIds);
          }
        }
        useAIStore.getState().beginIncrementalAnalysis(
          planning.segments.map((segment) => ({
            segmentId: segment.id,
            title: segment.title,
          })),
        );
      },
    );
    const unsubscribeCardDone = window.electronAPI.onAnalyzeCardCompleted(
      ({ card }) => {
        useAIStore.getState().upsertAnalyzedCard(card);
        // 默认「生成好一条就进入轨道一条」：enabled 卡片即时落轨；
        // coalesceHistory 把整轮增量落轨合并为一次可撤销操作。
        if (card.enabled) {
          useTimelineStore
            .getState()
            .appendAICardToTimeline(buildAICardTimelineDraft(card), {
              coalesceHistory: true,
            });
        }
      },
    );
    const unsubscribeFailed = window.electronAPI.onAnalyzeProgress((progress) => {
      if (progress.card?.status === 'failed' && progress.card.segmentId) {
        useAIStore.getState().markAnalyzedCardFailed(progress.card.segmentId);
      }
    });

    try {
      const projectDir = getProjectDir();
      // 手动分析同样落 auto-run jsonl（与一键流水线同一套耗时观测），排查"慢/失败"时直接读日志。
      // run.start 会把 LATEST.txt 指到本次 runId。
      const tel = createAutoRunTelemetry(`autorun-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
      tel.event('run.start', { source: 'ai-panel-analyze', entries: srtEntries.length });
      const runStartedAt = Date.now();
      const result = (await window.electronAPI.analyzeSrt({
        projectDir: projectDir ?? undefined,
        entries: srtEntries,
        settings,
        globalPrompt: globalPromptDraft.trim() || undefined,
        projectBindings: useAIStore.getState().projectBindings,
        telemetryRunId: tel.runId,
        feedId: analyzeTaskId,
      })) as AIAnalysisResult;
      tel.event('run.end', {
        ok: true,
        totalDurationMs: Date.now() - runStartedAt,
        cards: result.cards?.length ?? 0,
        cardErrors: result.cardErrors?.length ?? 0,
      });
      const persistedState = await persistAIState(result, []);
      setAnalysisResult(persistedState.analysisResult ?? result);
      setCoverCandidates(persistedState.coverCandidates);
      // 部分失败时仍视为完成（成功段已入库），把失败列表用 inline 提示告知用户
      const failedCount = result.cardErrors?.length ?? 0;
      if (failedCount > 0) {
        const sample = result.cardErrors!
          .slice(0, 3)
          .map(
            (e) =>
              `第 ${(e.segmentIndex ?? 0) + 1} 段「${e.segmentTitle ?? e.segmentId}」`,
          )
          .join('、');
        const more = failedCount > 3 ? ` 等共 ${failedCount} 段` : '';
        const reasons = Array.from(
          new Set(
            result.cardErrors!
              .map((e) => e.message?.trim())
              .filter((message): message is string => Boolean(message)),
          ),
        )
          .slice(0, 2)
          .join('；');
        setAnalysisError(
          `${sample}${more} 卡片生成失败${reasons ? `：${reasons}` : ''}。可在下方失败段列表中重试。`,
        );
      }
      useTaskProgressStore.getState().completeTask(analyzeTaskId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '分析失败';
      setAnalysisError(errorMessage);
      useTaskProgressStore.getState().failTask(analyzeTaskId, errorMessage);
    } finally {
      // 解除增量订阅，避免泄漏到下一次分析。
      unsubscribePlanning();
      unsubscribeCardDone();
      unsubscribeFailed();
      // 清理瞬态骨架；已落轨的真实卡片按约定保留（取消/报错也保留已生成成果）。
      useAIStore.getState().endIncrementalAnalysis();
      // 停止心跳并解除 analyze-progress 订阅，避免泄漏到下一次分析。
      progressBridge.dispose();
      setAnalyzing(false);
      analyzeInFlightRef.current = false;
    }
  }, [
    analysisResult,
    globalPromptDraft,
    persistAIState,
    setAnalysisError,
    setAnalysisResult,
    setAnalyzing,
    setCoverCandidates,
    srtEntries,
    timeline.podcast.srtPath,
  ]);

  const buildRetriedResult = useCallback(
    (
      baseResult: AIAnalysisResult,
      error: AIAnalysisCardError,
      card: AICard,
    ): AIAnalysisResult => {
      const nextCards = [
        ...baseResult.cards.filter((item) => item.segmentId !== error.segmentId),
        card,
      ].sort((a, b) => a.startMs - b.startMs);
      const nextCardErrors = (baseResult.cardErrors ?? []).filter(
        (item) => item.segmentId !== error.segmentId,
      );

      return {
        ...baseResult,
        cards: nextCards,
        cardErrors: nextCardErrors.length > 0 ? nextCardErrors : undefined,
      };
    },
    [],
  );

  const handleRetryFailedSegment = useCallback(
    async (error: AIAnalysisCardError, opts?: { skipPersist?: boolean }) => {
      const currentResult = useAIStore.getState().analysisResult ?? analysisResult;
      if (!currentResult) {
        return null;
      }

      const segmentIndex = currentResult.segments.findIndex(
        (segment) => segment.id === error.segmentId,
      );
      const segment = segmentIndex >= 0 ? currentResult.segments[segmentIndex] : null;
      if (!segment) {
        setAnalysisError(`找不到失败段「${error.segmentTitle ?? error.segmentId}」，请重新分析内容。`);
        return null;
      }

      const settings = await loadAISettings();
      const settingsIssue = getAISettingsIssue(settings);
      if (settingsIssue) {
        setAISettingsIssue(settingsIssue);
        setAnalysisError(settingsIssue);
        onOpenSettings?.();
        return null;
      }
      if (!settings) {
        setAISettingsIssue(getAISettingsIssue(null));
        setAnalysisError('请先完成 AI 配置');
        onOpenSettings?.();
        return null;
      }

      if (srtEntries.length === 0) {
        setAnalysisError('当前没有可用于重试生成卡片的字幕内容');
        return null;
      }

      const retryTaskId = `ai-retry-card-${error.segmentId}-${Date.now()}`;
      setRetryingSegmentIds((prev) => new Set(prev).add(error.segmentId));
      setAnalysisError(null);
      useTaskProgressStore.getState().startTask({
        id: retryTaskId,
        category: 'ai-analyze',
        label: '失败段卡片重试',
        mode: 'indeterminate',
        progress: 0,
        phase: `生成「${segment.title || error.segmentTitle || error.segmentId}」`,
        level: 2,
        canCancel: false,
      });

      try {
        const projectDir = getProjectDir();
        const card = await window.electronAPI.generateAICardForSegment({
          projectDir: projectDir ?? undefined,
          entries: srtEntries,
          segment,
          settings,
          globalPrompt: currentResult.globalPrompt,
          programSummary: currentResult.summary,
          keywords: currentResult.keywords,
          projectBindings: useAIStore.getState().projectBindings,
          segmentIndex,
          totalSegments: currentResult.segments.length,
          prevSegment: segmentIndex > 0 ? currentResult.segments[segmentIndex - 1] : undefined,
          nextSegment:
            segmentIndex + 1 < currentResult.segments.length
              ? currentResult.segments[segmentIndex + 1]
              : undefined,
          visualType: (() => {
            const value = (segment as { visualType?: unknown }).visualType;
            return value === 'image' || value === 'motion' ? value : undefined;
          })(),
          feedId: retryTaskId,
        });
        const latestResult = useAIStore.getState().analysisResult ?? currentResult;
        const nextResult = buildRetriedResult(latestResult, error, card);
        setAnalysisResult(nextResult);
        useTaskProgressStore.getState().completeTask(retryTaskId);
        // 批量重试跳过单卡落盘：多段并行下逐卡 persist 会相互覆盖（后写覆盖先写），
        // 内存态合并是同步的（单线程累积安全），由调用方在并发池排空后统一落盘一次。
        if (opts?.skipPersist) {
          return nextResult;
        }
        const persistedState = await persistAIState(nextResult, coverCandidates);
        const persistedResult = persistedState.analysisResult ?? nextResult;
        setAnalysisResult(persistedResult);
        setCoverCandidates(persistedState.coverCandidates);
        return persistedResult;
      } catch (retryError) {
        const message =
          retryError instanceof Error ? retryError.message : '失败段卡片重试失败';
        const latestResult = useAIStore.getState().analysisResult ?? currentResult;
        const nextCardErrors = (latestResult.cardErrors ?? []).map((item) =>
          item.segmentId === error.segmentId ? { ...item, message } : item,
        );
        const nextResult = {
          ...latestResult,
          cardErrors: nextCardErrors.length > 0 ? nextCardErrors : undefined,
        };
        setAnalysisResult(nextResult);
        // 批量重试同样跳过单卡落盘，交由并发池排空后统一落盘（含剩余错误态）。
        if (!opts?.skipPersist) {
          void persistAIState(nextResult, coverCandidates).then((persistedState) => {
            if (persistedState.analysisResult) {
              setAnalysisResult(persistedState.analysisResult);
            }
            setCoverCandidates(persistedState.coverCandidates);
          });
        }
        setAnalysisError(
          `第 ${(error.segmentIndex ?? segmentIndex) + 1} 段「${
            error.segmentTitle ?? segment.title
          }」重试失败：${message}`,
        );
        useTaskProgressStore.getState().failTask(retryTaskId, message);
        return null;
      } finally {
        setRetryingSegmentIds((prev) => {
          const next = new Set(prev);
          next.delete(error.segmentId);
          return next;
        });
      }
    },
    [
      analysisResult,
      buildRetriedResult,
      coverCandidates,
      onOpenSettings,
      persistAIState,
      setAnalysisError,
      setAnalysisResult,
      setCoverCandidates,
      srtEntries,
    ],
  );

  const handleRetryAllFailedSegments = useCallback(async () => {
    const currentErrors = useAIStore.getState().analysisResult?.cardErrors ?? failedCardErrors;
    if (currentErrors.length === 0) {
      return;
    }

    setIsRetryingAllFailedCards(true);
    try {
      // 并发池：与首次生成一致（shared cursor + Promise.all）。并发数取
      // settings.cardGenerationConcurrency（默认 4，与 ai-analysis 一致）。逐卡仅做内存态
      // 累积（同步合并，单线程下不会互相覆盖），落盘推迟到全部完成后统一一次，
      // 避免并行 persist 后写覆盖先写。
      const settings = await loadAISettings();
      const rawConcurrency = settings?.cardGenerationConcurrency;
      const concurrency =
        typeof rawConcurrency === 'number' && Number.isFinite(rawConcurrency)
          ? Math.max(1, Math.floor(rawConcurrency))
          : 4;

      let cursor = 0;
      const runOne = async (): Promise<void> => {
        while (true) {
          const i = cursor;
          cursor += 1;
          if (i >= currentErrors.length) return;
          const error = currentErrors[i];
          const latestErrors = useAIStore.getState().analysisResult?.cardErrors ?? [];
          if (!latestErrors.some((item) => item.segmentId === error.segmentId)) {
            continue;
          }
          await handleRetryFailedSegment(error, { skipPersist: true });
        }
      };
      const workerCount = Math.min(concurrency, currentErrors.length);
      await Promise.all(Array.from({ length: workerCount }, () => runOne()));

      // 并发池排空后统一落盘一次（内存态已累积全部成功卡与剩余错误态）。
      const finalResult = useAIStore.getState().analysisResult;
      if (finalResult) {
        const persistedState = await persistAIState(finalResult, coverCandidates);
        if (persistedState.analysisResult) {
          setAnalysisResult(persistedState.analysisResult);
        }
        setCoverCandidates(persistedState.coverCandidates);
      }
    } finally {
      setIsRetryingAllFailedCards(false);
    }
  }, [
    coverCandidates,
    failedCardErrors,
    handleRetryFailedSegment,
    persistAIState,
    setAnalysisResult,
    setCoverCandidates,
  ]);

  const handleApplyToTimeline = useCallback(() => {
    if (!analysisResult) {
      return;
    }

    addAICardsToTimeline(
      analysisResult.cards
        .filter((card) => card.enabled)
        .map(buildAICardTimelineDraft),
    );
  }, [addAICardsToTimeline, analysisResult]);

  const handleGenerateCovers = useCallback(
    async (prompts: string[]) => {
      const settings = await loadAISettings();
      const hasImageProvider =
        !!settings &&
        settings.imageProviders.length > 0 &&
        !!settings.defaultImageProviderId;
      if (!hasImageProvider) {
        setAnalysisError('请先在 AI 配置中添加至少一个图像生成 Provider');
        onOpenSettings?.();
        return;
      }

      const projectDir = getProjectDir();
      if (!projectDir) {
        return;
      }

      setGeneratingCovers(true);
      try {
        const nextResult = await handleSaveCoverPrompt(prompts);
        const candidates = await window.electronAPI.generateCoverImages({
          prompts,
          settings,
          projectDir,
          projectBindings: useAIStore.getState().projectBindings,
        });
        await handlePersistedCovers(candidates, nextResult);
      } catch (error) {
        console.error('封面生成失败:', error);
        if (error instanceof Error) {
          setAnalysisError(error.message);
        }
      } finally {
        setGeneratingCovers(false);
      }
    },
    [
      handlePersistedCovers,
      handleSaveCoverPrompt,
      setGeneratingCovers,
      setAnalysisError,
    ],
  );

  const handleRegenerateCoverPrompt = useCallback(async () => {
    if (!analysisResult) {
      return;
    }

    const settings = await loadAISettings();
    const settingsIssue = getAISettingsIssue(settings);
    if (settingsIssue) {
      setAISettingsIssue(settingsIssue);
      setAnalysisError(settingsIssue);
      onOpenSettings?.();
      return;
    }
    if (!settings) {
      setAISettingsIssue(getAISettingsIssue(null));
      setAnalysisError('请先完成 AI 配置');
      onOpenSettings?.();
      return;
    }

    setAISettingsIssue(null);

    if (srtEntries.length === 0) {
      setAnalysisError('当前没有可用于生成封面提示词的字幕内容');
      return;
    }

    setIsRegeneratingCoverPrompt(true);
    setAnalysisError(null);

    try {
      const projectDir = getProjectDir();
      const prompts = await window.electronAPI.regenerateCoverPrompt({
        entries: srtEntries,
        settings,
        globalPrompt: analysisResult.globalPrompt,
        currentPrompt: analysisResult.coverPrompts[0],
        projectDir: projectDir ?? undefined,
        projectBindings: useAIStore.getState().projectBindings,
      });
      const nextResult = {
        ...analysisResult,
        coverPrompts: prompts,
      };
      setAnalysisResult(nextResult);
      const persistedState = await persistAIState(nextResult, []);
      setAnalysisResult(persistedState.analysisResult ?? nextResult);
      setCoverCandidates([]);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : '封面提示词重生成失败');
    } finally {
      setIsRegeneratingCoverPrompt(false);
    }
  }, [
    analysisResult,
    persistAIState,
    setAnalysisError,
    setAnalysisResult,
    setCoverCandidates,
    srtEntries,
  ]);

  const handleGlobalPromptBlur = useCallback(() => {
    const normalizedPrompt = globalPromptDraft.trim();
    const currentPrompt = analysisResult?.globalPrompt ?? '';
    if (normalizedPrompt === currentPrompt || !analysisResult) {
      return;
    }

    const nextResult = {
      ...analysisResult,
      globalPrompt: normalizedPrompt || undefined,
    };
    setAnalysisResult(nextResult);
    void persistAIState(nextResult, coverCandidates).then((persistedState) => {
      if (persistedState.analysisResult) {
        setAnalysisResult(persistedState.analysisResult);
      }
      setCoverCandidates(persistedState.coverCandidates);
    });
  }, [analysisResult, coverCandidates, globalPromptDraft, persistAIState, setAnalysisResult, setCoverCandidates]);

  const handleSelectAllCards = useCallback(() => {
    if (!analysisResult?.cards.length) {
      return;
    }

    const shouldEnableAll = analysisResult.cards.some((card) => !card.enabled);
    const nextResult = setAllCardsEnabledInResult(analysisResult, shouldEnableAll);
    if (!nextResult) {
      return;
    }

    setAnalysisResult(nextResult);
    void persistAIState(nextResult, coverCandidates).then((persistedState) => {
      if (persistedState.analysisResult) {
        setAnalysisResult(persistedState.analysisResult);
      }
      setCoverCandidates(persistedState.coverCandidates);
    });
  }, [analysisResult, coverCandidates, persistAIState, setAnalysisResult, setCoverCandidates]);

  const handleDeleteCards = useCallback(
    (cardIds: string[]) => {
      const nextResult = removeCardsInResult(analysisResult, cardIds);
      if (!nextResult) {
        return;
      }

      setAnalysisResult(nextResult);
      if (inspectedCardId && cardIds.includes(inspectedCardId)) {
        onClearInspector?.();
      }
      removeAICardOverlaysBySourceIds(cardIds);
      void persistAIState(nextResult, coverCandidates).then((persistedState) => {
        if (persistedState.analysisResult) {
          setAnalysisResult(persistedState.analysisResult);
        }
        setCoverCandidates(persistedState.coverCandidates);
      });
    },
    [
      analysisResult,
      coverCandidates,
      inspectedCardId,
      onClearInspector,
      persistAIState,
      removeAICardOverlaysBySourceIds,
      setAnalysisResult,
      setCoverCandidates,
    ],
  );

  const handleOpenManualMediaDialog = useCallback(
    (mediaType: 'image' | 'video') => {
      const durationMs = mediaType === 'image' ? 5000 : 6000;
      setManualMediaDialogInitial({
        text: '',
        startMs: 0,
        endMs: durationMs,
        kind: mediaType,
        title: mediaType === 'image' ? '手动图片卡' : '手动视频卡',
        insertToTimeline: false,
        allowedKinds: ['image', 'video'],
        requireText: false,
      });
    },
    [],
  );

  const hasSrtEntries = srtEntries.length > 0;
  const analyzeButtonDisabled = !hasSrtEntries || isAnalyzing;
  const hasGeneratedCards = (analysisResult?.cards.length ?? 0) > 0;
  const isCardListEmpty = Boolean(analysisResult && !hasGeneratedCards);
  // 增量呈现进行中：内容区改用 incrementalAnalysis（骨架 + 已填充真实卡），
  // 替代「等整轮结束才一次性出现」。结束后回落到 analysisResult.cards。
  const showingIncremental = incrementalAnalysis.active;
  const displayCards = showingIncremental
    ? incrementalAnalysis.cards
    : analysisResult?.cards ?? [];
  const displaySkeletons = showingIncremental
    ? incrementalAnalysis.skeletons
    : NO_SKELETONS;
  const showCardGenerationState =
    (!analysisResult || !hasGeneratedCards) && !showingIncremental;
  const allCardsSelected = hasGeneratedCards && enabledCount === (analysisResult?.cards.length ?? 0);
  const analysisHeadline = analysisResult ? '正在重新分析内容卡片' : '正在拆解字幕与生成卡片';
  const analysisDescription = analysisResult
    ? '正在根据最新字幕和提示词重新组织结构，完成后会自动刷新当前卡片列表。'
    : '正在解析字幕、提炼重点并生成可编辑卡片，这通常需要几十秒。';
  const analysisOverlayTitle = analysisResult
    ? 'AI 正在重新生成当前内容卡片'
    : 'AI 正在生成首批内容卡片';
  const analysisOverlayText = analysisResult
    ? '当前卡片区会暂时锁定，分析完成后将自动替换成新的卡片结果。'
    : '请稍候，AI 会先解析字幕，再提炼重点并生成可编辑卡片。';
  const generationStateBadgeLabel = isAnalyzing
    ? 'AI 正在工作'
    : isCardListEmpty
      ? '卡片已清空'
      : '准备生成内容卡片';
  const generationStateText = isAnalyzing
    ? `已载入 ${srtEntries.length} 条字幕，正在为你拆解结构与重点`
    : srtEntries.length === 0
      ? '请先导入 SRT 字幕文件'
      : isCardListEmpty
        ? `内容卡片已全部删除，当前仍有 ${srtEntries.length} 条字幕可重新分析生成`
        : `已加载 ${srtEntries.length} 条字幕，点击分析`;
  const analysisSteps = [
    { label: '解析字幕', status: 'active' as const },
    { label: '提炼重点', status: 'active' as const },
    { label: '生成卡片', status: 'active' as const },
  ];
  const analyzeButtonLabel = isAnalyzing
    ? '分析中...'
    : aiSettingsIssue
      ? '前往系统设置'
      : isCardListEmpty
        ? '重新生成卡片'
        : '分析内容';

  return (
    <aside
      className={styles.root}
      data-agent-zone="ai-panel"
      data-ai-panel-root="true"
      data-ai-panel-tab={activeTab}
      data-compact={compact ? 'true' : 'false'}
    >
      <div className={styles.header} data-ai-panel-header="true">
        <div className={styles.headerMain}>
          <span className={styles.headerIcon}>
            <AppIcon name="brain" size={14} />
          </span>
          <span className={styles.headerTitle}>AI 分析</span>
          {hasGeneratedCards ? (
            <Badge color="#0A84FF" size="xs" className={styles.headerBadge}>
              已选 {enabledCount}/{analysisResult?.cards.length ?? 0}
            </Badge>
          ) : null}
        </div>
        <div className={styles.headerActions}>
          <Button.Icon
            variant="ghost"
            className={styles.iconButton}
            data-ai-analyze-trigger="header"
            onClick={() => void handleAnalyze()}
            disabled={analyzeButtonDisabled}
            aria-label={analysisResult ? '重新分析' : '分析内容'}
            title={analysisResult ? '重新分析' : '分析内容'}
          >
            {isAnalyzing ? <Spinner size={12} color="#EBEBF599" /> : <AppIcon name="refresh-cw" size={14} />}
          </Button.Icon>
          <Button.Icon
            variant="ghost"
            className={styles.iconButton}
            onClick={onOpenSettings}
            aria-label="打开 AI 全局设置"
            title="打开 AI 全局设置"
          >
            <AppIcon name="settings-2" size={14} />
          </Button.Icon>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => handleTabChange(value as AITabKey)}
        className={styles.tabsShell}
      >
        <TabsList className={styles.subTabs}>
          {SUB_TABS.map((tab) => (
            <TabsTrigger
              key={tab}
              value={tab}
              className={joinClassNames(
                styles.subTab,
                activeTab === tab ? styles.subTabActive : '',
              )}
            >
              {compact ? TAB_META[tab].shortLabel : TAB_META[tab].label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className={styles.body}>
          <TabsContent value="cards" className={styles.tabContent}>
            <section className={styles.promptSection}>
              <label className={styles.promptLabel}>整体创作提示词</label>
              <div className={styles.promptCard}>
                <Textarea
                  value={globalPromptDraft}
                  onChange={(event) => setGlobalPromptDraft(event.target.value)}
                  onBlur={handleGlobalPromptBlur}
                  placeholder="描述你想要的纵深风格和内容方向..."
                  rows={3}
                  size="sm"
                  resize="none"
                  className={styles.promptTextarea}
                />
              </div>
            </section>

            {analysisError ? (
              <div className={styles.errorWrap}>
                <Alert variant="destructive">{analysisError}</Alert>
              </div>
            ) : null}

            {failedCardErrors.length > 0 ? (
              <section className={styles.failedCardPanel} data-ai-card-errors="true">
                <div className={styles.failedCardHeader}>
                  <div className={styles.failedCardTitleGroup}>
                    <Badge variant="secondary" size="xs" className={styles.failedCardBadge}>
                      失败段 {failedCardErrors.length}
                    </Badge>
                    <div className={styles.failedCardTitle}>卡片生成失败，可单独重试</div>
                  </div>
                  <Button
                    variant="accent"
                    size="xs"
                    className={styles.failedCardRetryAllButton}
                    onClick={() => void handleRetryAllFailedSegments()}
                    disabled={isAnalyzing || isRetryingAnyFailedCard}
                    loading={isRetryingAllFailedCards}
                    loadingText="重试中"
                    data-ai-retry-card-errors-all="true"
                  >
                    重试全部
                  </Button>
                </div>
                <div className={styles.failedCardList}>
                  {failedCardErrors.map((error) => {
                    const segment = analysisResult?.segments.find(
                      (item) => item.id === error.segmentId,
                    );
                    const index = error.segmentIndex ?? (
                      segment
                        ? analysisResult?.segments.findIndex((item) => item.id === error.segmentId)
                        : -1
                    );
                    const displayIndex = typeof index === 'number' && index >= 0 ? index + 1 : null;
                    const title = error.segmentTitle ?? segment?.title ?? error.segmentId;
                    const isRetrying = retryingSegmentIds.has(error.segmentId);
                    return (
                      <article
                        key={error.segmentId}
                        className={styles.failedCardItem}
                        data-ai-card-error-item={error.segmentId}
                      >
                        <div className={styles.failedCardMeta}>
                          <div className={styles.failedCardName}>
                            {`${displayIndex ? `第 ${displayIndex} 段` : '失败段'}「${title}」`}
                          </div>
                          <div className={styles.failedCardMessage}>{error.message}</div>
                        </div>
                        <Button
                          variant="secondary"
                          size="xs"
                          className={styles.failedCardRetryButton}
                          onClick={() => void handleRetryFailedSegment(error)}
                          disabled={isAnalyzing || isRetryingAllFailedCards || isRetrying}
                          loading={isRetrying}
                          loadingText="生成中"
                          data-ai-retry-card-error={error.segmentId}
                        >
                          <AppIcon name="refresh-cw" size={12} />
                          重试
                        </Button>
                      </article>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {showCardGenerationState ? (
              <section className={styles.emptyState} aria-busy={isAnalyzing}>
                <Badge variant="glass" size="xs" className={styles.stateBadge}>
                  {generationStateBadgeLabel}
                </Badge>
                <div className={styles.emptyStateText}>{generationStateText}</div>
                {aiSettingsIssue ? <div className={styles.hintText}>{aiSettingsIssue}</div> : null}
                <div className={styles.emptyStateActions}>
                  <Button
                    variant="primary"
                    size="sm"
                    className={styles.primaryButton}
                    onClick={() => void handleAnalyze()}
                    disabled={analyzeButtonDisabled}
                  >
                    {isAnalyzing ? (
                      <>
                        <Spinner size={12} color="#FFFFFF" />
                        {analyzeButtonLabel}
                      </>
                    ) : (
                      <>
                        <AppIcon name={aiSettingsIssue ? 'settings-2' : 'sparkles'} size={14} />
                        {analyzeButtonLabel}
                      </>
                    )}
                  </Button>
                  <div className={styles.manualMediaActions}>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleOpenManualMediaDialog('image')}
                      disabled={isAnalyzing}
                    >
                      <AppIcon name="image" size={14} />
                      图片卡
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleOpenManualMediaDialog('video')}
                      disabled={isAnalyzing}
                    >
                      <AppIcon name="film" size={14} />
                      视频卡
                    </Button>
                  </div>
                </div>

                {isAnalyzing ? (
                  <div className={styles.analysisStatus}>
                    <div className={styles.analysisStatusTitle}>{analysisHeadline}</div>
                    <div className={styles.analysisStatusText}>{analysisDescription}</div>
                    <StepIndicator steps={analysisSteps} />
                  </div>
                ) : null}
              </section>
            ) : null}

            {hasGeneratedCards || showingIncremental ? (
              <section className={styles.cardsSection}>
                <ActionBar
                  className={styles.actionBar}
                  data-ai-action-bar="true"
                  start={
                    <Button
                      variant="secondary"
                      size="xs"
                      onClick={handleSelectAllCards}
                    >
                      {allCardsSelected ? '取消全选' : '全选'}
                    </Button>
                  }
                  center={
                    <div className={styles.selectionSummary} data-ai-selection-summary="true">
                      {selectedCount} / {analysisResult?.cards.length ?? 0} 已选
                    </div>
                  }
                  end={
                    <div className={styles.actionBarEnd}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="secondary"
                            size="xs"
                            className={styles.addCardButton}
                            disabled={isAnalyzing}
                          >
                            <AppIcon name="plus" size={12} />
                            新增
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" sideOffset={4}>
                          <DropdownMenuItem
                            onSelect={() => {
                              handleOpenManualMediaDialog('image');
                            }}
                          >
                            <AppIcon name="image" size={14} />
                            <span>新增图片卡</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              handleOpenManualMediaDialog('video');
                            }}
                          >
                            <AppIcon name="film" size={14} />
                            <span>新增视频卡</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <Button
                        variant="destructive"
                        size="xs"
                        onClick={() => handleDeleteCards(enabledCardIds)}
                        disabled={selectedCount === 0 || isAnalyzing}
                      >
                        删除已选
                      </Button>
                    </div>
                  }
                />

                <div className={styles.analysisWorkspace}>
                  {analysisResult && hasGeneratedCards && isAnalyzing ? (
                    <div className={styles.analysisBanner}>
                      <Badge variant="secondary" size="xs" className={styles.analysisBannerBadge}>
                        重新分析中
                      </Badge>
                      <div className={styles.analysisBannerTitle}>{analysisOverlayTitle}</div>
                      <div className={styles.analysisBannerText}>{analysisOverlayText}</div>
                    </div>
                  ) : null}

                  <div className={joinClassNames(styles.workspaceContent, isAnalyzing ? styles.workspaceContentDimmed : '')}>
                    <AICardList
                      cards={displayCards}
                      skeletons={displaySkeletons}
                      placements={cardPlacements}
                      onToggleEnabled={handleToggleEnabled}
                      onDeleteCard={(cardId) => handleDeleteCards([cardId])}
                      onEditCard={(cardId) => onOpenCardInspector?.(cardId)}
                      onSelect={(cardId) => onOpenCardInspector?.(cardId)}
                    />
                  </div>
                </div>
              </section>
            ) : null}
          </TabsContent>

          <TabsContent value="cover" className={styles.tabContent}>
            <AICoverPanel
              coverPrompts={analysisResult?.coverPrompts ?? []}
              // 编辑器封面面板只展示 16:9（整期封面）；4:3 / 3:4 由「发布视频」选项卡管理。
              candidates={coverCandidates.filter((c) => coverAspectRatio(c) === '16:9')}
              isGenerating={isGeneratingCovers}
              isRegeneratingPrompt={isRegeneratingCoverPrompt}
              selectedCandidateId={selectedCoverCandidate?.id}
              onGenerateCovers={handleGenerateCovers}
              onSavePrompt={handleSaveCoverPrompt}
              onRegeneratePrompt={handleRegenerateCoverPrompt}
              onSelectCover={handleSelectCover}
              onAddToTimeline={handleAddCoverToTimeline}
              onEditCover={handleOpenCoverEditor}
            />
          </TabsContent>
        </div>
      </Tabs>

      {activeTab === 'cards' && hasGeneratedCards ? (
        <div className={styles.footer}>
          <Button
            variant="primary"
            size="sm"
            className={styles.footerButton}
            data-ai-footer-button="true"
            onClick={handleApplyToTimeline}
            disabled={enabledCount === 0 || isAnalyzing}
          >
            <AppIcon name="arrow-up-to-line" size={14} />
            <span>上轨 {enabledCount}</span>
          </Button>
        </div>
      ) : null}

      {editingCandidate ? (
        <CoverEditorModal
          open
          candidateId={editingCandidate.id}
          imageUrl={editingCandidate.imageUrl}
          prompt={editingCandidate.prompt}
          initialEdits={editingCandidate.edits}
          timelineSize={{ width: timeline.width, height: timeline.height }}
          onClose={handleCloseCoverEditor}
          onSaveRequested={handleCoverEditSave}
        />
      ) : null}
      <SubtitleCardDialog
        open={Boolean(manualMediaDialogInitial)}
        onOpenChange={(open) => {
          if (!open) {
            setManualMediaDialogInitial(null);
          }
        }}
        initial={manualMediaDialogInitial}
        onGenerated={(cardId) => {
          const latestResult = useAIStore.getState().analysisResult;
          if (latestResult) {
            setAnalysisResult(latestResult);
          }
          setManualMediaDialogInitial(null);
          if (cardId) {
            onOpenCardInspector?.(cardId);
          }
        }}
      />
    </aside>
  );
}

function joinClassNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}
