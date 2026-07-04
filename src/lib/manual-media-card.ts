import type { AICard, AICardDisplayMode, AICardMediaType, AIAnalysisResult } from '../types/ai';
import { buildAICardTimelineDraft } from '../types/ai';
import { useAIStore } from '../store/ai';
import { useTimelineStore } from '../store/timeline';

export interface ManualMediaCardInput {
  mediaType: AICardMediaType;
  segmentId: string;
  title?: string;
  prompt?: string;
  startMs?: number;
  endMs?: number;
  displayDurationMs?: number;
  displayMode?: AICardDisplayMode;
  insertToTimeline?: boolean;
}

function clampMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : fallback;
}

function patchManualCardTiming(card: AICard, input: ManualMediaCardInput): AICard {
  const startMs = clampMs(input.startMs, card.startMs);
  const fallbackEndMs = Math.max(startMs, card.endMs);
  const endMs = clampMs(input.endMs, fallbackEndMs);
  const displayDurationMs =
    Number.isFinite(input.displayDurationMs) && (input.displayDurationMs as number) > 0
      ? Math.round(input.displayDurationMs as number)
      : card.displayDurationMs;

  return {
    ...card,
    title: input.title?.trim() || card.title,
    startMs,
    endMs: Math.max(startMs, endMs),
    displayDurationMs,
  };
}

function replaceCard(result: AIAnalysisResult | null, card: AICard): AIAnalysisResult {
  const base: AIAnalysisResult = result ?? {
    segments: [],
    cards: [],
    coverPrompts: [],
    summary: '',
    keywords: [],
  };

  return {
    ...base,
    cards: base.cards.map((item) => (item.id === card.id ? card : item)),
  };
}

export async function createManualMediaCard(input: ManualMediaCardInput): Promise<AICard> {
  const aiStore = useAIStore.getState();
  const create =
    input.mediaType === 'image'
      ? aiStore.createImageCard(input.segmentId, {
          prompt: input.prompt,
          aspectRatio: '16:9',
          displayMode: input.displayMode ?? 'fullscreen',
        })
      : aiStore.createVideoCard(input.segmentId, {
          prompt: input.prompt,
          aspectRatio: '16:9',
          displayMode: input.displayMode ?? 'fullscreen',
          durationSeconds:
            Number.isFinite(input.displayDurationMs) && (input.displayDurationMs as number) > 0
              ? Math.max(1, Math.round((input.displayDurationMs as number) / 1000))
              : undefined,
        });

  const createdCard = await create;
  const patchedCard = patchManualCardTiming(createdCard, input);

  if (patchedCard !== createdCard) {
    useAIStore.getState().setAnalysisResult(
      replaceCard(useAIStore.getState().analysisResult, patchedCard),
    );
  }

  if (input.insertToTimeline ?? true) {
    useTimelineStore.getState().addAICardsToTimeline([buildAICardTimelineDraft(patchedCard)]);
  }

  return patchedCard;
}
