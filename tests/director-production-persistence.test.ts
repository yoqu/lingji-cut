import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateCards = vi.fn();
const generateHighlights = vi.fn();
const runAudioTrack = vi.fn();

vi.mock('../src/lib/director-production', () => ({
  generateCardsFromDirectorPlan: (...args: unknown[]) => generateCards(...args),
}));
vi.mock('../src/lib/subtitle-highlight-runner', () => ({
  generateSubtitleHighlights: (...args: unknown[]) => generateHighlights(...args),
}));
vi.mock('../src/lib/director-audio-track', () => ({
  runDirectorAudioTrack: (...args: unknown[]) => runAudioTrack(...args),
}));

import {
  createDefaultTimeline,
  createVisualTrack,
  type OverlayItem,
} from '../src/types';
import {
  buildAICardOverlayData,
  type AICard,
  type AIAnalysisResult,
} from '../src/types/ai';
import type { DirectorChangeImpact, DirectorPlan, ProjectProductionState } from '../src/types/director';
import { useAIStore } from '../src/store/ai';
import { useTimelineStore } from '../src/store/timeline';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import { applyProductionMutation, type ProductionMutation } from '../src/lib/production-mutations';
import { buildDirectorExecutionPlan } from '../src/lib/production-plan';
import { runDirectorProductionClient } from '../src/lib/director-production-client';
import { commitDirectorProductionArtifacts } from '../src/lib/director-production-persistence';

function directorPlan(revision = 2): DirectorPlan {
  const segments = ['seg-1', 'seg-2'].map((id, index) => ({
    id, title: `第${index + 1}段`, summary: `摘要${index + 1}`,
    startMs: index * 6_000, endMs: (index + 1) * 6_000,
    semanticType: 'explanation' as const, complexityLevel: 'medium' as const,
    visualizationScore: 80, pacingNeed: 'steady' as const, keywords: [], entities: [],
    visualType: 'motion' as const, enabled: true, purpose: 'explain',
    carrier: 'process', intensity: 2, rationale: '解释内容',
  }));
  return {
    revision, inputFingerprint: `source-${revision}`, summary: '整期摘要', keywords: [], segments,
    motionBible: {
      visualThesis: '克制的信息动效',
      rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
      carrierPlan: segments.map((segment) => ({
        segmentId: segment.id, preferredCarrier: 'process', intensity: 2, reason: '解释',
      })),
      styleRules: { paletteUse: '系统蓝', typographyUse: '短标题' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '封面方向', composition: '居中' },
    audioDirection: { bgmStyle: '克制', energy: 2, soundDensity: 'balanced' },
    warnings: [], createdAt: 100, updatedAt: 100, approvedAt: 200,
  };
}

function card(segmentId: string, modifiedByUser: boolean, revision = 1): AICard {
  const index = segmentId === 'seg-1' ? 0 : 1;
  return {
    id: `card-${segmentId}`, segmentId, type: 'summary', title: segmentId, content: '内容',
    startMs: index * 6_000, endMs: (index + 1) * 6_000, displayDurationMs: 6_000,
    displayMode: 'pip', template: 'default', enabled: true,
    style: { primaryColor: '#fff', backgroundColor: '#111', fontSize: 48 },
    generationProvenance: {
      directorRevision: revision, fingerprint: `card-${revision}-${segmentId}`,
      generatedAt: 100, modifiedByUser,
    },
  };
}

function analysis(cards: AICard[], plan: DirectorPlan): AIAnalysisResult {
  return {
    segments: plan.segments, cards, coverPrompts: [plan.coverDirection.prompt],
    summary: plan.summary, keywords: plan.keywords, motionBible: plan.motionBible,
  };
}

function runningState(
  plan: DirectorPlan,
  mode: 'auto' | 'director',
  impact: DirectorChangeImpact | null,
): ProjectProductionState {
  const state = createEmptyProductionState(100);
  return {
    ...state,
    approvedPlan: plan,
    pendingImpact: impact,
    workflow: {
      ...state.workflow, mode, stage: 'production-running', activeTaskId: 'task-1', updatedAt: 100,
    },
  };
}

describe('director production persistence', () => {
  let persisted: ProjectProductionState;
  let now: number;
  const api = {
    saveProjectSection: vi.fn(),
    mutateProjectProduction: vi.fn(),
    regenerateCoverPrompt: vi.fn(),
    generateCoverImages: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    generateHighlights.mockResolvedValue([]);
    api.saveProjectSection.mockResolvedValue(undefined);
    api.mutateProjectProduction.mockImplementation(
      async (_projectDir: string, mutation: ProductionMutation) => {
        persisted = applyProductionMutation(persisted, mutation, now++);
        return persisted;
      },
    );
    Object.assign(globalThis, { window: { electronAPI: api } });
    useAIStore.setState({ analysisResult: null, coverCandidates: [] });
    useTimelineStore.getState().setTimeline(createDefaultTimeline());
    now = 1_000;
  });

  it('protects manual cards and reports that they need a manual merge', async () => {
    const plan = directorPlan();
    const protectedCard = card('seg-1', true);
    const generatedCard = card('seg-2', false, plan.revision);
    const currentAnalysis = analysis([protectedCard, card('seg-2', false)], plan);
    const generatedAnalysis = analysis([protectedCard, generatedCard], plan);
    const impact: DirectorChangeImpact = {
      allCards: true, segmentIds: [], cover: false, audio: false,
      timeline: false, quality: true, reasons: ['global-style'],
    };
    persisted = runningState(plan, 'director', impact);
    useAIStore.setState({ analysisResult: currentAnalysis, coverCandidates: [] });
    generateCards.mockResolvedValue(generatedAnalysis);

    const result = await runDirectorProductionClient({
      projectDir: '/project', production: persisted, entries: [], settings: {} as never,
      taskId: 'task-1',
    });

    expect(generateCards.mock.calls[0]?.[3]).toMatchObject({ segmentIds: ['seg-2'] });
    expect(result.outputs.cards).toMatchObject({
      status: 'failed',
      error: '1 个人工精修镜头需人工合并',
    });
    expect(useAIStore.getState().analysisResult?.cards).toContain(protectedCard);
    expect(api.regenerateCoverPrompt).not.toHaveBeenCalled();
    expect(api.generateCoverImages).not.toHaveBeenCalled();
    expect(runAudioTrack).not.toHaveBeenCalled();
  });

  it('preserves resolved audio assets when a new revision does not affect audio', async () => {
    const plan = directorPlan(2);
    const currentAnalysis = analysis([
      card('seg-1', false, plan.revision),
      card('seg-2', false, plan.revision),
    ], plan);
    const impact: DirectorChangeImpact = {
      allCards: false, segmentIds: [], cover: false, audio: false,
      timeline: false, quality: false, reasons: [],
    };
    persisted = runningState(plan, 'director', impact);
    const previousExecution = buildDirectorExecutionPlan(directorPlan(1), 12_000);
    previousExecution.audioPlan.bgm[0].assetId = 'asset-bgm';
    persisted.execution = previousExecution;
    useAIStore.setState({ analysisResult: currentAnalysis, coverCandidates: [] });
    generateCards.mockResolvedValue(currentAnalysis);

    const result = await runDirectorProductionClient({
      projectDir: '/project', production: persisted, entries: [], settings: {} as never,
      taskId: 'task-1',
    });

    expect(runAudioTrack).not.toHaveBeenCalled();
    expect(result.execution?.generationProvenance?.directorRevision).toBe(2);
    expect(result.execution?.audioPlan.bgm[0].assetId).toBe('asset-bgm');
  });

  it('atomically updates a stable card overlay without changing its id or placement', async () => {
    const plan = directorPlan();
    const updatedCard = { ...card('seg-1', false, plan.revision), title: '更新后的内容' };
    const previousOverlay: OverlayItem = {
      id: 'overlay-stable', type: 'image', assetPath: '', trackId: 'visual-2',
      startMs: updatedCard.startMs, durationMs: updatedCard.displayDurationMs,
      position: { x: 123, y: 234, width: 640, height: 360 },
      overlayType: 'ai-card',
      aiCardData: buildAICardOverlayData({ ...updatedCard, title: '旧内容' }, plan.motionBible),
    };
    const timeline = createDefaultTimeline();
    timeline.podcast.durationMs = 12_000;
    timeline.tracks.push(createVisualTrack(2, 2));
    timeline.overlays.push(previousOverlay);
    useTimelineStore.getState().setTimeline(timeline);
    persisted = runningState(plan, 'director', null);

    await commitDirectorProductionArtifacts({
      projectDir: '/project', taskId: 'task-1', plan,
      analysis: analysis([updatedCard], plan),
      cover: { prompts: [], candidates: [] },
      audio: {
        execution: buildDirectorExecutionPlan(plan, 12_000), outcome: 'disabled', reusedSounds: 0,
      },
      replaceTimeline: true, manualMergeCount: 0, telemetry: null,
    });

    const state = useTimelineStore.getState();
    const overlay = state.timeline.overlays.find((item) => item.id === 'overlay-stable');
    expect(state.historyPast).toHaveLength(1);
    expect(overlay).toMatchObject({
      id: 'overlay-stable', trackId: 'visual-2', startMs: 0,
      position: previousOverlay.position,
      aiCardData: { sourceCardId: updatedCard.id, title: '更新后的内容' },
    });
  });

  it('persists Animatic review before automatically approving completion', async () => {
    const plan = directorPlan();
    persisted = runningState(plan, 'auto', null);

    const result = await commitDirectorProductionArtifacts({
      projectDir: '/project', taskId: 'task-1', plan,
      analysis: analysis([], plan), cover: { prompts: [], candidates: [] },
      audio: {
        execution: buildDirectorExecutionPlan(plan, 12_000), outcome: 'disabled', reusedSounds: 0,
      },
      replaceTimeline: false, manualMergeCount: 0, telemetry: null,
    });

    const mutations = api.mutateProjectProduction.mock.calls
      .map((call) => call[1] as ProductionMutation);
    const reviewIndex = mutations.findIndex(
      (mutation) => mutation.kind === 'set-workflow' && mutation.stage === 'animatic-review',
    );
    const approvalIndex = mutations.findIndex((mutation) => mutation.kind === 'approve-animatic');
    expect(reviewIndex).toBeGreaterThan(-1);
    expect(approvalIndex).toBeGreaterThan(reviewIndex);
    expect(result.workflow).toMatchObject({ stage: 'complete', animaticApprovedAt: expect.any(Number) });
  });

  it('有镜头未通过质量门禁时阻断在 quality-blocked 且不替换时间线', async () => {
    const plan = directorPlan();
    persisted = runningState(plan, 'director', {
      allCards: true, segmentIds: [], cover: false, audio: false,
      timeline: true, quality: true, reasons: ['initial-approval'],
    });
    const failed: AIAnalysisResult = {
      ...analysis([], plan),
      cardErrors: [{
        segmentId: 'seg-1', segmentTitle: '第一段', segmentIndex: 0,
        totalSegments: 2, message: 'Motion Card 质量门禁阻断',
      }],
    };
    const timelineBefore = useTimelineStore.getState().timeline;

    const result = await commitDirectorProductionArtifacts({
      projectDir: '/project', taskId: 'task-1', plan,
      analysis: failed, cover: { prompts: [], candidates: [] },
      audio: {
        execution: buildDirectorExecutionPlan(plan, 12_000), outcome: 'disabled', reusedSounds: 0,
      },
      replaceTimeline: true, manualMergeCount: 0, telemetry: null,
    });

    expect(result.workflow).toMatchObject({ stage: 'quality-blocked' });
    expect(result.outputs.cards.status).toBe('failed');
    expect(result.outputs.timeline.status).toBe('failed');
    expect(useTimelineStore.getState().timeline).toBe(timelineBefore);
    expect(api.saveProjectSection.mock.calls.some((call) => call[1] === 'timeline')).toBe(false);
  });
});
