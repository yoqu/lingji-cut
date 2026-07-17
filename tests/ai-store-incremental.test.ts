import { beforeEach, describe, expect, it } from 'vitest';
import { useAIStore, DEFAULT_INCREMENTAL_ANALYSIS } from '../src/store/ai';
import type { AICard } from '../src/types/ai';

function makeCard(segmentId: string, title = `card-${segmentId}`): AICard {
  return {
    id: `id-${segmentId}`,
    segmentId,
    type: 'data',
    title,
    content: '',
    startMs: 0,
    endMs: 1000,
    displayDurationMs: 1000,
    displayMode: 'fullscreen',
    template: 'default',
    enabled: true,
    style: {} as AICard['style'],
  };
}

describe('AI store — incremental analysis slice', () => {
  beforeEach(() => {
    useAIStore.getState().clearAnalysis();
    useAIStore.getState().endIncrementalAnalysis();
  });

  it('default state is inactive with empty skeletons and cards', () => {
    expect(useAIStore.getState().incrementalAnalysis).toEqual(DEFAULT_INCREMENTAL_ANALYSIS);
  });

  it('beginIncrementalAnalysis sets active + pending skeletons in planned order', () => {
    useAIStore.getState().beginIncrementalAnalysis([
      { segmentId: 's1', title: 'First' },
      { segmentId: 's2', title: 'Second' },
      { segmentId: 's3', title: 'Third' },
    ]);

    const inc = useAIStore.getState().incrementalAnalysis;
    expect(inc.active).toBe(true);
    expect(inc.cards).toEqual([]);
    expect(inc.skeletons).toEqual([
      { segmentId: 's1', title: 'First', status: 'pending' },
      { segmentId: 's2', title: 'Second', status: 'pending' },
      { segmentId: 's3', title: 'Third', status: 'pending' },
    ]);
  });

  it('setPlannedAnalysisResult persists structure without cards', () => {
    useAIStore.getState().setPlannedAnalysisResult({
      segments: [
        { id: 's1', title: 'First', summary: 'one', startMs: 0, endMs: 1000 },
        { id: 's2', title: 'Second', summary: 'two', startMs: 1000, endMs: 2000 },
      ],
      coverPrompts: ['cover'],
      summary: 'program summary',
      keywords: ['alpha'],
      globalPrompt: 'global',
    });

    const result = useAIStore.getState().analysisResult;
    expect(result?.segments.map((segment) => segment.id)).toEqual(['s1', 's2']);
    expect(result?.cards).toEqual([]);
    expect(result?.summary).toBe('program summary');
    expect(result?.keywords).toEqual(['alpha']);
    expect(result?.globalPrompt).toBe('global');
  });

  it('upsertAnalyzedCard keeps cards ordered by planned index even when arriving out of order', () => {
    useAIStore.getState().beginIncrementalAnalysis([
      { segmentId: 's1', title: 'First' },
      { segmentId: 's2', title: 'Second' },
      { segmentId: 's3', title: 'Third' },
    ]);

    // Arrive out of order: s3, then s1, then s2
    useAIStore.getState().upsertAnalyzedCard(makeCard('s3'));
    useAIStore.getState().upsertAnalyzedCard(makeCard('s1'));
    useAIStore.getState().upsertAnalyzedCard(makeCard('s2'));

    const inc = useAIStore.getState().incrementalAnalysis;
    expect(inc.cards.map((c) => c.segmentId)).toEqual(['s1', 's2', 's3']);
    // matching skeletons removed; none left
    expect(inc.skeletons).toEqual([]);
  });

  it('upsertAnalyzedCard also merges streamed cards into the persisted analysis result', () => {
    useAIStore.getState().setPlannedAnalysisResult({
      segments: [
        { id: 's1', title: 'First', summary: 'one', startMs: 0, endMs: 1000 },
        { id: 's2', title: 'Second', summary: 'two', startMs: 1000, endMs: 2000 },
      ],
      coverPrompts: [],
      summary: '',
      keywords: [],
    });
    useAIStore.getState().beginIncrementalAnalysis([
      { segmentId: 's1', title: 'First' },
      { segmentId: 's2', title: 'Second' },
    ]);

    useAIStore.getState().upsertAnalyzedCard(makeCard('s2'));
    useAIStore.getState().upsertAnalyzedCard(makeCard('s1'));

    expect(
      useAIStore.getState().analysisResult?.cards.map((card) => card.segmentId),
    ).toEqual(['s1', 's2']);
  });

  it('upsertAnalyzedCard removes only the matching skeleton', () => {
    useAIStore.getState().beginIncrementalAnalysis([
      { segmentId: 's1', title: 'First' },
      { segmentId: 's2', title: 'Second' },
    ]);
    useAIStore.getState().upsertAnalyzedCard(makeCard('s2'));

    const inc = useAIStore.getState().incrementalAnalysis;
    expect(inc.skeletons.map((s) => s.segmentId)).toEqual(['s1']);
    expect(inc.cards.map((c) => c.segmentId)).toEqual(['s2']);
  });

  it('re-upserting the same segmentId replaces rather than duplicates', () => {
    useAIStore.getState().beginIncrementalAnalysis([
      { segmentId: 's1', title: 'First' },
      { segmentId: 's2', title: 'Second' },
    ]);
    useAIStore.getState().upsertAnalyzedCard(makeCard('s1', 'old'));
    useAIStore.getState().upsertAnalyzedCard(makeCard('s1', 'new'));

    const inc = useAIStore.getState().incrementalAnalysis;
    expect(inc.cards).toHaveLength(1);
    expect(inc.cards[0].segmentId).toBe('s1');
    expect(inc.cards[0].title).toBe('new');
  });

  it('markAnalyzedCardFailed flips skeleton to failed and adds no card', () => {
    useAIStore.getState().beginIncrementalAnalysis([
      { segmentId: 's1', title: 'First' },
      { segmentId: 's2', title: 'Second' },
    ]);
    useAIStore.getState().markAnalyzedCardFailed('s2');

    const inc = useAIStore.getState().incrementalAnalysis;
    expect(inc.cards).toEqual([]);
    expect(inc.skeletons).toEqual([
      { segmentId: 's1', title: 'First', status: 'pending' },
      { segmentId: 's2', title: 'Second', status: 'failed' },
    ]);
  });

  it('endIncrementalAnalysis resets everything to default', () => {
    useAIStore.getState().beginIncrementalAnalysis([
      { segmentId: 's1', title: 'First' },
    ]);
    useAIStore.getState().upsertAnalyzedCard(makeCard('s1'));
    useAIStore.getState().endIncrementalAnalysis();

    expect(useAIStore.getState().incrementalAnalysis).toEqual(DEFAULT_INCREMENTAL_ANALYSIS);
  });
});
