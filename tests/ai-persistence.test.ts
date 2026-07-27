import { describe, expect, it } from 'vitest';
import {
  createPersistedAIState,
  mergeCoverCandidatesFromScannedAssets,
  parsePersistedAIState,
  removeCardsInResult,
  setAllCardsEnabledInResult,
  selectCoverCandidate,
  toggleCardEnabledInResult,
  updateCardInResult,
} from '../src/lib/ai-persistence';
import type { AIAnalysisResult } from '../src/types/ai';

const baseAnalysisResult = {
  segments: [
    {
      id: 'seg-1',
      title: '本期要点',
      summary: '这一段主要概括节目主旨',
      startMs: 0,
      endMs: 45_000,
      transcriptExcerpt: '这里是这一段的核心字幕摘录',
    },
  ],
  cards: [
    {
      id: 'card-1',
      segmentId: 'seg-1',
      type: 'summary',
      title: '本期要点',
      content: '重点内容',
      startMs: 0,
      endMs: 45_000,
      displayDurationMs: 5_000,
      displayMode: 'fullscreen',
      template: 'summary-default',
      enabled: true,
      cardPrompt: '做成更像商业海报',
      style: {
        primaryColor: '#6366f1',
        backgroundColor: '#0f172a',
        fontSize: 48,
      },
    },
  ],
  coverPrompts: ['封面提示词'],
  summary: '播客总结',
  keywords: ['AI'],
  globalPrompt: '整体偏商业分析风',
} as AIAnalysisResult;

describe('AI persistence helpers', () => {
  it('rejects the legacy ai-analysis.json shape without versioned wrapper', () => {
    const persisted = parsePersistedAIState(baseAnalysisResult);

    expect(persisted).toBeNull();
  });

  it('migrates legacy text card types (summary/data/...) to motion on load', () => {
    const persisted = parsePersistedAIState({
      version: 3,
      analysisResult: baseAnalysisResult,
      coverCandidates: [],
    });

    expect(persisted?.analysisResult?.cards[0]?.type).toBe('motion');
  });

  it('round-trips the persisted ai state with cover candidates under version 3', () => {
    const persisted = createPersistedAIState(baseAnalysisResult, [
      {
        id: 'cover-1',
        prompt: '播客封面',
        imageUrl: '/tmp/cover-1.png',
        selected: true,
      },
    ]);

    expect(persisted.version).toBe(3);
    expect(parsePersistedAIState(persisted)).toEqual(persisted);
  });

  it('round-trips persisted motion cards', () => {
    const persisted = createPersistedAIState(baseAnalysisResult, [], [
      {
        id: 'motion-1',
        segmentId: 'motion-1',
        type: 'motion',
        title: '动画卡片',
        content: '动画卡片内容',
        startMs: 0,
        endMs: 5_000,
        displayDurationMs: 5_000,
        displayMode: 'fullscreen',
        template: 'motion-default',
        enabled: true,
        style: {
          primaryColor: '#7df9ff',
          backgroundColor: '#151922',
          fontSize: 48,
        },
        renderMode: 'motion-card',
        motionCard: {
          prompt: '做一个标题放大动画',
          html: '<div><script>window.__lingjiMotionTimelines = window.__lingjiMotionTimelines || []; window.__lingjiMotionTimelines.push(gsap.timeline({ paused: true }));</script></div>',
          compiledAt: 1,
          retryCount: 0,
        },
      },
    ]);

    expect(persisted.version).toBe(3);
    expect(parsePersistedAIState(persisted)).toEqual(persisted);
  });

  it('rejects persisted ai state when segments are missing', () => {
    const persisted = {
      version: 2,
      analysisResult: {
        cards: baseAnalysisResult.cards,
        coverPrompts: baseAnalysisResult.coverPrompts,
        summary: baseAnalysisResult.summary,
        keywords: baseAnalysisResult.keywords,
        globalPrompt: baseAnalysisResult.globalPrompt,
      },
      coverCandidates: [],
    };

    expect(parsePersistedAIState(persisted)).toBeNull();
  });

  it('rejects persisted ai state when card segmentId is missing', () => {
    const persisted = {
      version: 2,
      analysisResult: {
        ...baseAnalysisResult,
        cards: baseAnalysisResult.cards.map(({ segmentId: _segmentId, ...card }) => card),
      },
      coverCandidates: [],
    };

    expect(parsePersistedAIState(persisted)).toBeNull();
  });

  it('updates cards and cover selection without mutating the original state', () => {
    const toggled = toggleCardEnabledInResult(baseAnalysisResult, 'card-1');
    const updated = updateCardInResult(toggled, 'card-1', { title: '新的标题' });
    const enabledAll = setAllCardsEnabledInResult(
      {
        ...baseAnalysisResult,
        cards: [
          ...baseAnalysisResult.cards,
          {
            ...baseAnalysisResult.cards[0],
            id: 'card-2',
            segmentId: 'seg-1',
            enabled: false,
          },
        ],
      },
      true,
    );
    const selected = selectCoverCandidate(
      [
        { id: 'cover-1', prompt: 'A', imageUrl: '/tmp/1.png', selected: false },
        { id: 'cover-2', prompt: 'B', imageUrl: '/tmp/2.png', selected: true },
      ],
      'cover-1',
    );

    expect(baseAnalysisResult.cards[0]?.enabled).toBe(true);
    expect(toggled?.cards[0]?.enabled).toBe(false);
    expect(updated?.cards[0]?.title).toBe('新的标题');
    expect(updated?.cards[0]?.cardPrompt).toBe('做成更像商业海报');
    expect(enabledAll?.cards.every((card) => card.enabled)).toBe(true);
    expect(selected.map((candidate) => candidate.selected)).toEqual([true, false]);
  });

  it('removes cards by id without mutating the original result', () => {
    const resultWithTwoCards: AIAnalysisResult = {
      ...baseAnalysisResult,
      cards: [
        ...baseAnalysisResult.cards,
        {
          ...baseAnalysisResult.cards[0],
          id: 'card-2',
          segmentId: 'seg-1',
          title: '第二张卡',
        },
      ],
    };

    const removed = removeCardsInResult(resultWithTwoCards, ['card-1']);

    expect(resultWithTwoCards.cards).toHaveLength(2);
    expect(removed?.cards.map((card) => card.id)).toEqual(['card-2']);
  });

  it('merges scanned cover directory images back into cover candidates', () => {
    const merged = mergeCoverCandidatesFromScannedAssets(
      '/tmp/project',
      [
        {
          id: 'cover-existing',
          prompt: '旧封面',
          imageUrl: '/tmp/project/covers/existing.png',
          selected: true,
        },
        {
          id: 'cover-error',
          prompt: '失败封面',
          imageUrl: '',
          selected: false,
          error: '下载失败',
        },
      ],
      [
        {
          path: '/tmp/project/covers/existing.png',
          type: 'image',
          durationMs: 5_000,
        },
        {
          path: '/tmp/project/covers/new-cover.png',
          type: 'image',
          durationMs: 5_000,
        },
        {
          path: '/tmp/project/cover/legacy-cover.webp',
          type: 'image',
          durationMs: 5_000,
        },
        {
          path: '/tmp/project/assets/not-a-cover.png',
          type: 'image',
          durationMs: 5_000,
        },
        {
          path: '/tmp/project/covers/intro.mp4',
          type: 'video',
          durationMs: 8_000,
        },
      ],
      '封面提示词',
    );

    expect(merged).toHaveLength(4);
    expect(merged.find((candidate) => candidate.id === 'cover-existing')?.selected).toBe(true);
    expect(merged.some((candidate) => candidate.imageUrl === '/tmp/project/covers/new-cover.png')).toBe(
      true,
    );
    expect(
      merged.some((candidate) => candidate.imageUrl === '/tmp/project/cover/legacy-cover.webp'),
    ).toBe(true);
    expect(
      merged.some((candidate) => candidate.imageUrl === '/tmp/project/assets/not-a-cover.png'),
    ).toBe(false);
    expect(
      merged.find((candidate) => candidate.imageUrl === '/tmp/project/covers/new-cover.png')?.prompt,
    ).toBe('封面提示词');
  });

  it('selects the first scanned cover when no existing candidate is selected', () => {
    const merged = mergeCoverCandidatesFromScannedAssets(
      '/tmp/project',
      [],
      [
        {
          path: '/tmp/project/covers/cover-a.png',
          type: 'image',
          durationMs: 5_000,
        },
        {
          path: '/tmp/project/covers/cover-b.png',
          type: 'image',
          durationMs: 5_000,
        },
      ],
      '扫描封面',
    );

    expect(merged).toHaveLength(2);
    expect(merged.map((candidate) => candidate.selected)).toEqual([true, false]);
  });
});
