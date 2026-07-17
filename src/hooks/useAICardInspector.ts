import { useCallback, useMemo, useState } from 'react';
import { getAISettingsIssue } from '../lib/ai-settings';
import {
  createPersistedAIState,
  removeCardInResult,
  updateCardInResult,
} from '../lib/ai-persistence';
import { getAICardSequenceLabel } from '../lib/ai-card-inspector';
import { loadAISettings, useAIStore } from '../store/ai';
import { useTaskProgressStore } from '../store/task-progress';
import { getProjectDir, useTimelineStore } from '../store/timeline';
import { buildAICardTimelineDraft, type AICard, type CoverCandidate } from '../types/ai';

export function useAICardInspector(cardId: string | null) {
  const {
    analysisError,
    analysisResult,
    coverCandidates,
    setAnalysisError,
    setAnalysisResult,
    setCoverCandidates,
  } = useAIStore();
  const { addAICardsToTimeline, removeAICardOverlaysBySourceIds, srtEntries, timeline } = useTimelineStore();
  const [isRegeneratingCard, setIsRegeneratingCard] = useState(false);

  const card = useMemo(
    () => analysisResult?.cards.find((item) => item.id === cardId) ?? null,
    [analysisResult, cardId],
  );
  const isPlacedOnTimeline = useMemo(
    () =>
      Boolean(
        cardId &&
          timeline.overlays.some(
            (overlay) =>
              overlay.overlayType === 'ai-card' && overlay.aiCardData?.sourceCardId === cardId,
          ),
      ),
    [cardId, timeline.overlays],
  );
  const cardSequenceLabel = useMemo(
    () => getAICardSequenceLabel(analysisResult?.cards, cardId),
    [analysisResult?.cards, cardId],
  );
  const storyboardCueOptions = useMemo(() => {
    if (!card) return [];
    return srtEntries
      .filter((entry) => entry.startMs >= card.startMs && entry.startMs < card.endMs)
      .sort((a, b) => a.startMs - b.startMs)
      .map((entry, index) => ({
        index,
        startMs: entry.startMs - card.startMs,
        text: entry.text,
      }));
  }, [card, srtEntries]);

  // 落盘由 store/ai.ts 订阅自动完成；这里仅返回规范化快照供调用方回灌。
  const persistAIState = useCallback(
    async (result: typeof analysisResult, candidates: CoverCandidate[]) =>
      createPersistedAIState(result, candidates),
    [],
  );

  const saveCard = useCallback(
    (targetCardId: string, updates: Partial<AICard>) => {
      const nextResult = updateCardInResult(analysisResult, targetCardId, updates);
      if (!nextResult) {
        return;
      }

      setAnalysisError(null);
      setAnalysisResult(nextResult);
      void persistAIState(nextResult, coverCandidates).then((persistedState) => {
        const persistedResult = persistedState.analysisResult ?? nextResult;
        setAnalysisResult(persistedResult);
        setCoverCandidates(persistedState.coverCandidates);
        const updatedCard = persistedResult.cards.find((item) => item.id === targetCardId);
        if (
          updatedCard &&
          timeline.overlays.some(
            (overlay) =>
              overlay.overlayType === 'ai-card' &&
              overlay.aiCardData?.sourceCardId === targetCardId,
          )
        ) {
          addAICardsToTimeline([buildAICardTimelineDraft(updatedCard, persistedResult.motionBible)]);
        }
      });
    },
    [
      addAICardsToTimeline,
      analysisResult,
      coverCandidates,
      persistAIState,
      setAnalysisError,
      setAnalysisResult,
      setCoverCandidates,
      timeline.overlays,
    ],
  );

  const regenerateCard = useCallback(
    async (
      draftUpdates: Partial<AICard>,
      options: { refineExistingMotion?: boolean } = {},
    ) => {
      if (!card || !analysisResult) {
        return null;
      }

      const settings = await loadAISettings();
      const settingsIssue = getAISettingsIssue(settings);
      if (settingsIssue) {
        setAnalysisError(settingsIssue);
        return null;
      }
      if (!settings) {
        setAnalysisError('请先完成 AI 配置');
        return null;
      }

      setAnalysisError(null);
      setIsRegeneratingCard(true);

      const regenerateTaskId = `ai-regenerate-card-${card.id}-${Date.now()}`;
      useTaskProgressStore.getState().startTask({
        id: regenerateTaskId,
        category: 'ai-analyze',
        label: `重新生成 Motion 卡片：${card.title}`,
        mode: 'indeterminate',
        progress: 0,
        phase: '生成 Motion 卡片',
        level: 2,
        canCancel: false,
      });

      try {
        const draftCard = {
          ...card,
          ...draftUpdates,
          id: card.id,
        };
        const segment = analysisResult.segments.find((item) => item.id === draftCard.segmentId);
        if (!segment) {
          setAnalysisError('未找到卡片对应的段落信息');
          useTaskProgressStore.getState().failTask(regenerateTaskId, '未找到卡片对应的段落信息');
          return null;
        }
        const regeneratedCard = await window.electronAPI.regenerateAICard({
          entries: srtEntries,
          card: draftCard,
          segment,
          settings,
          globalPrompt: analysisResult.globalPrompt?.trim() || undefined,
          cardPrompt: draftCard.cardPrompt,
          programSummary: analysisResult.summary,
          keywords: analysisResult.keywords,
          motionBible: analysisResult.motionBible,
          projectDir: getProjectDir() ?? undefined,
          projectBindings: useAIStore.getState().projectBindings,
          feedId: regenerateTaskId,
          refineExistingMotion: options.refineExistingMotion === true,
        });

        const nextResult = updateCardInResult(analysisResult, card.id, {
          ...draftUpdates,
          ...regeneratedCard,
        });
        if (!nextResult) {
          return null;
        }

        const persistedState = await persistAIState(nextResult, coverCandidates);
        const persistedResult = persistedState.analysisResult ?? nextResult;
        setAnalysisResult(persistedResult);
        setCoverCandidates(persistedState.coverCandidates);
        const persistedCard = persistedResult.cards.find((item) => item.id === card.id);

        if (
          persistedCard &&
          timeline.overlays.some(
            (overlay) =>
              overlay.overlayType === 'ai-card' &&
              overlay.aiCardData?.sourceCardId === card.id,
          )
        ) {
          addAICardsToTimeline([buildAICardTimelineDraft(persistedCard, persistedResult.motionBible)]);
        }

        useTaskProgressStore.getState().completeTask(regenerateTaskId);
        return persistedCard ?? null;
      } catch (error) {
        console.error('单卡重生成失败:', error);
        const errorMessage = error instanceof Error ? error.message : '单卡重生成失败';
        setAnalysisError(errorMessage);
        useTaskProgressStore.getState().failTask(regenerateTaskId, errorMessage);
        return null;
      } finally {
        setIsRegeneratingCard(false);
      }
    },
    [
      addAICardsToTimeline,
      analysisResult,
      card,
      coverCandidates,
      persistAIState,
      setAnalysisError,
      setAnalysisResult,
      setCoverCandidates,
      srtEntries,
      timeline.overlays,
    ],
  );

  const generateAnimationDirection = useCallback(
    async (targetCard: AICard): Promise<string> => {
      if (!analysisResult) {
        return '';
      }

      const settings = await loadAISettings();
      const settingsIssue = getAISettingsIssue(settings);
      if (settingsIssue) {
        setAnalysisError(settingsIssue);
        throw new Error(settingsIssue);
      }
      if (!settings) {
        const issue = '请先完成 AI 配置';
        setAnalysisError(issue);
        throw new Error(issue);
      }

      const segment = analysisResult.segments.find((item) => item.id === targetCard.segmentId);
      if (!segment) {
        const issue = '未找到卡片对应的段落信息';
        setAnalysisError(issue);
        throw new Error(issue);
      }

      setAnalysisError(null);

      const directionTaskId = `ai-generate-animation-direction-${targetCard.id}-${Date.now()}`;
      useTaskProgressStore.getState().startTask({
        id: directionTaskId,
        category: 'ai-analyze',
        label: `生成动画指导：${targetCard.title}`,
        mode: 'indeterminate',
        progress: 0,
        phase: '生成动画指导',
        level: 2,
        canCancel: false,
      });

      try {
        const text = await window.electronAPI.generateAnimationDirection({
          entries: srtEntries,
          segment,
          settings,
          globalPrompt: analysisResult.globalPrompt?.trim() || undefined,
          cardPrompt: targetCard.cardPrompt,
          programSummary: analysisResult.summary,
          keywords: analysisResult.keywords,
          motionBible: analysisResult.motionBible,
          projectDir: getProjectDir() ?? undefined,
          projectBindings: useAIStore.getState().projectBindings,
        });
        useTaskProgressStore.getState().completeTask(directionTaskId);
        return text;
      } catch (error) {
        console.error('生成动画指导失败:', error);
        const errorMessage = error instanceof Error ? error.message : '生成动画指导失败';
        setAnalysisError(errorMessage);
        useTaskProgressStore.getState().failTask(directionTaskId, errorMessage);
        throw error instanceof Error ? error : new Error(errorMessage);
      }
    },
    [analysisResult, setAnalysisError, srtEntries],
  );

  const deleteCard = useCallback(() => {
    if (!card || !analysisResult) {
      return;
    }

    const nextResult = removeCardInResult(analysisResult, card.id);
    if (!nextResult) {
      return;
    }

    setAnalysisError(null);
    setAnalysisResult(nextResult);
    removeAICardOverlaysBySourceIds([card.id]);

    void persistAIState(nextResult, coverCandidates).then((persistedState) => {
      const persistedResult = persistedState.analysisResult ?? nextResult;
      setAnalysisResult(persistedResult);
      setCoverCandidates(persistedState.coverCandidates);
    });
  }, [
    analysisResult,
    card,
    coverCandidates,
    persistAIState,
    removeAICardOverlaysBySourceIds,
    setAnalysisError,
    setAnalysisResult,
    setCoverCandidates,
  ]);

  return {
    card,
    cardSequenceLabel,
    deleteCard,
    errorMessage: analysisError,
    generateAnimationDirection,
    isPlacedOnTimeline,
    isRegeneratingCard,
    regenerateCard,
    saveCard,
    storyboardCueOptions,
  };
}
