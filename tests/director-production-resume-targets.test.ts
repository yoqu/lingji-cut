import { beforeEach, describe, expect, it } from 'vitest';
import {
  generateCoverTrack,
  generationTargets,
  stableCoverPrompts,
} from '../src/lib/director-production-tracks';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import type { DirectorChangeImpact, DirectorPlan, ProjectProductionState } from '../src/types/director';
import type { AICard, CoverCandidate } from '../src/types/ai';
import { useAIStore } from '../src/store/ai';

function plan(): DirectorPlan {
  return {
    revision: 2,
    segments: [
      { id: 'seg-1', enabled: true },
      { id: 'seg-2', enabled: true },
      { id: 'seg-3', enabled: true },
      { id: 'seg-4', enabled: false },
    ],
  } as unknown as DirectorPlan;
}

function card(segmentId: string, overrides: Partial<NonNullable<AICard['generationProvenance']>> = {}): AICard {
  return {
    segmentId,
    generationProvenance: {
      directorRevision: 2,
      fingerprint: `card-${segmentId}`,
      generatedAt: 100,
      modifiedByUser: false,
      ...overrides,
    },
  } as AICard;
}

function noopImpact(): DirectorChangeImpact {
  return {
    allCards: false,
    segmentIds: [],
    cover: false,
    audio: false,
    timeline: false,
    quality: false,
    reasons: [],
  };
}

function production(overrides: {
  impact?: DirectorChangeImpact | null;
  cardsStatus?: 'current' | 'failed';
}): ProjectProductionState {
  const base = createEmptyProductionState(100);
  return {
    ...base,
    approvedPlan: plan(),
    pendingImpact: overrides.impact ?? null,
    outputs: {
      ...base.outputs,
      cards: { status: overrides.cardsStatus ?? 'failed', updatedAt: 100 },
    },
  };
}

describe('恢复制作的镜头补生成目标', () => {
  it('no-op pendingImpact 不屏蔽缺卡镜头：失败镜头始终重试', () => {
    const targets = generationTargets(
      plan(),
      production({ impact: noopImpact() }),
      [card('seg-1'), card('seg-2')],
    );
    expect(targets).toEqual(['seg-3']);
  });

  it('impact 指定段与缺卡镜头取并集', () => {
    const targets = generationTargets(
      plan(),
      production({ impact: { ...noopImpact(), segmentIds: ['seg-1'] } }),
      [card('seg-1', { directorRevision: 1 }), card('seg-2')],
    );
    expect(targets).toEqual(['seg-1', 'seg-3']);
  });

  it('无 impact 且 cards 产出 current 时不重生成', () => {
    const targets = generationTargets(
      plan(),
      production({ impact: null, cardsStatus: 'current' }),
      [card('seg-1'), card('seg-2'), card('seg-3')],
    );
    expect(targets).toEqual([]);
  });

  it('人工精修卡不参与重生成', () => {
    const targets = generationTargets(
      plan(),
      production({ impact: noopImpact() }),
      [card('seg-1', { modifiedByUser: true, directorRevision: 1 }), card('seg-2')],
    );
    expect(targets).toEqual(['seg-3']);
  });
});

describe('恢复制作的封面提示词', () => {
  beforeEach(() => {
    useAIStore.setState({ analysisResult: null, coverCandidates: [] });
  });

  it('复用当前导演版本封面时保留实际生成提示词，不退回导演草稿', async () => {
    const currentPlan = plan();
    currentPlan.coverDirection = { prompt: '导演草稿提示词', composition: '居中' };
    const currentCover: CoverCandidate = {
      id: 'cover-current',
      prompt: '已经生成并用于 16:9 封面的提示词',
      imageUrl: '/project/covers/current.png',
      selected: true,
      aspectRatio: '16:9',
      generationProvenance: {
        directorRevision: currentPlan.revision,
        fingerprint: 'cover-current',
        generatedAt: 100,
        modifiedByUser: false,
      },
    };
    useAIStore.setState({
      analysisResult: {
        segments: currentPlan.segments,
        cards: [],
        coverPrompts: ['导演草稿提示词'],
        summary: '',
        keywords: [],
      },
      coverCandidates: [currentCover],
    });

    const result = await generateCoverTrack({
      projectDir: '/project',
      production: production({ impact: { ...noopImpact(), cover: true } }),
      entries: [],
      settings: {} as never,
      taskId: 'resume-cover',
    }, currentPlan, [currentCover]);

    expect(result.prompts).toEqual(['已经生成并用于 16:9 封面的提示词']);
    expect(result.candidates).toEqual([currentCover]);
  });

  it('卡片快照优先保留选中的 16:9 实际生成提示词', () => {
    const currentPlan = plan();
    currentPlan.coverDirection = { prompt: '导演草稿提示词', composition: '居中' };
    useAIStore.setState({
      analysisResult: {
        segments: currentPlan.segments,
        cards: [],
        coverPrompts: ['被覆盖的规划提示词'],
        summary: '',
        keywords: [],
      },
      coverCandidates: [{
        id: 'cover-selected',
        prompt: '第一版 16:9 实际提示词',
        imageUrl: '/project/covers/selected.png',
        selected: true,
        aspectRatio: '16:9',
      }],
    });

    expect(stableCoverPrompts(currentPlan, useAIStore.getState().analysisResult)).toEqual([
      '第一版 16:9 实际提示词',
    ]);
  });
});
