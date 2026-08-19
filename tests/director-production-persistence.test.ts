import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateCards = vi.fn();
const generateHighlights = vi.fn();
const runAudioTrack = vi.fn();

vi.mock('../src/lib/director-production', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/director-production')>(),
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
import { EMPTY_FOOTAGE_TRACK_RESULT } from '../src/types/footage';
import type { MotionProductionPlan } from '../src/types/production';

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
    cancelProduction: vi.fn(),
    loadProject: vi.fn(),
    regenerateCoverPrompt: vi.fn(),
    generateCoverImages: vi.fn(),
    getLocalFileFingerprint: vi.fn(async () => 'stat:1:1'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    generateCards.mockReset();
    generateHighlights.mockReset();
    runAudioTrack.mockReset();
    generateHighlights.mockResolvedValue([]);
    api.saveProjectSection.mockResolvedValue(undefined);
    api.mutateProjectProduction.mockImplementation(
      async (_projectDir: string, mutation: ProductionMutation) => {
        persisted = applyProductionMutation(persisted, mutation, now++);
        return persisted;
      },
    );
    api.cancelProduction.mockImplementation(async (
      _projectDir: string,
      taskId?: string,
      directorRevision?: number,
    ) => {
      persisted = applyProductionMutation(persisted, {
        kind: 'set-workflow',
        stage: 'production-paused',
        expectedTaskId: taskId,
        expectedDirectorRevision: directorRevision,
      }, now++);
      return persisted;
    });
    api.loadProject.mockImplementation(async () => JSON.stringify({ production: persisted }));
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

  it('AbortError 只落一次暂停态，不会被提交为 workflow error', async () => {
    const plan = directorPlan(2);
    const currentAnalysis = analysis([], plan);
    persisted = runningState(plan, 'director', {
      allCards: true, segmentIds: [], cover: false, audio: false,
      timeline: false, quality: true, reasons: ['initial-approval'],
    });
    useAIStore.setState({ analysisResult: currentAnalysis, coverCandidates: [] });
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    generateCards.mockRejectedValue(abortError);
    const pauseProduction = vi.fn(async () => {
      persisted = applyProductionMutation(persisted, {
        kind: 'set-workflow',
        stage: 'production-paused',
        expectedTaskId: 'task-1',
        expectedDirectorRevision: plan.revision,
      }, now++);
      return persisted;
    });

    const result = await runDirectorProductionClient({
      projectDir: '/project', production: persisted, entries: [], settings: {} as never,
      taskId: 'task-1', pauseProduction,
    });

    expect(pauseProduction).toHaveBeenCalledTimes(1);
    expect(api.cancelProduction).not.toHaveBeenCalled();
    expect(result.workflow.stage).toBe('production-paused');
    expect(api.mutateProjectProduction.mock.calls.some((call) => {
      const mutation = call[1] as ProductionMutation;
      return mutation.kind === 'set-workflow' && mutation.stage === 'error';
    })).toBe(false);
  });

  it('passes the approved director title explicitly into cover prompt generation', async () => {
    const plan = { ...directorPlan(2), title: '世界第91位不是突然发生的' };
    const currentAnalysis = analysis([
      card('seg-1', false, plan.revision),
      card('seg-2', false, plan.revision),
    ], plan);
    persisted = runningState(plan, 'director', {
      allCards: false, segmentIds: [], cover: true, audio: false,
      timeline: false, quality: true, reasons: ['work-title'],
    });
    useAIStore.setState({ analysisResult: currentAnalysis, coverCandidates: [] });
    api.regenerateCoverPrompt.mockResolvedValue(['封面提示词']);
    api.generateCoverImages.mockResolvedValue([{
      id: 'cover-1', prompt: '封面提示词', imageUrl: '/cover.png', selected: true,
    }]);

    await runDirectorProductionClient({
      projectDir: '/project', production: persisted,
      entries: [{ index: 1, startMs: 0, endMs: 1_000, text: '字幕' }],
      settings: {} as never, taskId: 'task-1',
    });

    expect(api.regenerateCoverPrompt).toHaveBeenCalledWith(expect.objectContaining({
      workTitle: plan.title,
      currentPrompt: plan.coverDirection.prompt,
    }));
    expect(useAIStore.getState().analysisResult?.coverPromptProvenance).toMatchObject({
      directorRevision: plan.revision,
      fingerprint: `cover-prompt-${plan.inputFingerprint}-${plan.revision}`,
      modifiedByUser: false,
    });
  });

  it('persists current frozen footage before starting card generation', async () => {
    const plan = directorPlan(2);
    plan.segments[0] = {
      ...plan.segments[0],
      visualType: 'footage',
      renderStrategy: 'agent-composite',
      compositionIntent: {
        narrativeGoal: '让真实画面承载结论',
        focalPriority: '产品主体优先',
        temporalRelationship: '先素材后观点',
        mustShow: ['产品主体'],
        avoid: ['纯文字卡'],
      },
      compositionAssets: [{
        asset: {
          id: 'asset-1', filename: 'asset.mp4', path: '/library/asset.mp4',
          kind: 'video', score: 0.95,
        },
        usage: 'required',
        trimStartMs: 500,
      }],
      fallbackPolicy: 'block',
    };
    const currentAnalysis = analysis([], plan);
    persisted = runningState(plan, 'director', {
      allCards: true, segmentIds: [], cover: false, audio: false,
      timeline: false, quality: true, reasons: ['initial-approval'],
    });
    useAIStore.setState({ analysisResult: currentAnalysis, coverCandidates: [] });
    generateCards.mockImplementation(async () => {
      expect(persisted.outputs.footage).toMatchObject({
        status: 'current',
        directorRevision: plan.revision,
      });
      expect(persisted.footage?.generationProvenance).toMatchObject({
        directorRevision: plan.revision,
        fingerprint: `footage-${plan.inputFingerprint}-${plan.revision}`,
      });
      expect(persisted.footage?.compositionInputs).toEqual([
        expect.objectContaining({
          segmentId: 'seg-1',
          fileFingerprint: 'stat:1:1',
          asset: expect.objectContaining({ id: 'asset-1' }),
        }),
      ]);
      return currentAnalysis;
    });

    await runDirectorProductionClient({
      projectDir: '/project', production: persisted, entries: [], settings: {} as never,
      taskId: 'task-1',
    });

    expect(generateCards).toHaveBeenCalledTimes(1);
  });

  it('persists an empty current footage artifact before generating an all-Motion plan', async () => {
    const plan = directorPlan(2);
    const currentAnalysis = analysis([], plan);
    persisted = runningState(plan, 'director', {
      allCards: true, segmentIds: [], cover: false, audio: false,
      timeline: false, quality: true, reasons: ['initial-approval'],
    });
    useAIStore.setState({ analysisResult: currentAnalysis, coverCandidates: [] });
    generateCards.mockImplementation(async () => {
      expect(persisted.outputs.footage).toMatchObject({
        status: 'current',
        directorRevision: plan.revision,
      });
      expect(persisted.footage).toMatchObject({
        placements: [],
        compositionInputs: [],
        claimedSegmentIds: [],
        fallbacks: [],
        generationProvenance: {
          directorRevision: plan.revision,
          fingerprint: `footage-${plan.inputFingerprint}-${plan.revision}`,
        },
      });
      return currentAnalysis;
    });

    await runDirectorProductionClient({
      projectDir: '/project', production: persisted, entries: [], settings: {} as never,
      taskId: 'task-1',
    });

    expect(generateCards).toHaveBeenCalledTimes(1);
  });

  it('persists a disabled-KaCut motion fallback as current before card generation', async () => {
    const plan = directorPlan(2);
    plan.segments[0] = {
      ...plan.segments[0],
      visualType: 'footage',
      renderStrategy: 'agent-composite',
      compositionIntent: {
        narrativeGoal: '检索不可用时按批准方案退回 Motion',
        focalPriority: '观点优先',
        temporalRelationship: '素材缺失后使用抽象解释',
        mustShow: ['核心观点'],
        avoid: ['伪造真实素材'],
      },
      fallbackPolicy: 'motion',
    };
    const currentAnalysis = analysis([], plan);
    persisted = runningState(plan, 'director', {
      allCards: true, segmentIds: [], cover: false, audio: false,
      timeline: false, quality: true, reasons: ['initial-approval'],
    });
    useAIStore.setState({ analysisResult: currentAnalysis, coverCandidates: [] });
    generateCards.mockImplementation(async () => {
      expect(persisted.outputs.footage).toMatchObject({
        status: 'current',
        directorRevision: plan.revision,
      });
      expect(persisted.footage).toMatchObject({
        placements: [],
        compositionInputs: [],
        fallbacks: [{
          segmentId: 'seg-1',
          visualType: 'motion',
          renderStrategy: 'motion-card',
        }],
        generationProvenance: {
          directorRevision: plan.revision,
          fingerprint: `footage-${plan.inputFingerprint}-${plan.revision}`,
          modifiedByUser: false,
          generatedAt: expect.any(Number),
        },
      });
      return currentAnalysis;
    });

    await runDirectorProductionClient({
      projectDir: '/project', production: persisted, entries: [], settings: {} as never,
      taskId: 'task-1',
    });

    expect(generateCards).toHaveBeenCalledTimes(1);
  });

  it('刷新同版本旧 execution 的 Agent 合成字段后再交给 renderer 轨道', async () => {
    const plan = directorPlan();
    const compositionIntent = {
      narrativeGoal: '道路实拍建立可信度，图形给出结论',
      focalPriority: '先看车辆，再看排名',
      temporalRelationship: '中段叠加结论',
      mustShow: ['世界第91位'],
      avoid: ['广告式产品陈列'],
    };
    plan.segments[0] = {
      ...plan.segments[0],
      visualType: 'footage',
      carrier: 'data-hero',
      renderStrategy: 'agent-composite',
      compositionIntent,
      fallbackPolicy: 'block',
      compositionAssets: [{
        asset: {
          id: 'road-video', filename: 'road.mp4', path: '/library/road.mp4',
          kind: 'video', score: 0.9,
        },
        usage: 'required',
        trimStartMs: 2_000,
      }],
    };
    const staleExecution = buildDirectorExecutionPlan(plan, 12_000);
    staleExecution.motionBible = {
      ...staleExecution.motionBible,
      carrierPlan: staleExecution.motionBible.carrierPlan.map((directive) => directive.segmentId === 'seg-1' ? {
        segmentId: directive.segmentId,
        visualType: 'footage',
        preferredCarrier: 'footage',
        intensity: directive.intensity,
        reason: '旧 execution 尚未记录合成字段',
      } : directive),
    };
    persisted = runningState(plan, 'director', null);
    persisted.execution = staleExecution;
    persisted.outputs = {
      cards: { status: 'current', directorRevision: plan.revision, updatedAt: 100 },
      cover: { status: 'current', directorRevision: plan.revision, updatedAt: 100 },
      audio: { status: 'stale', directorRevision: plan.revision, updatedAt: 100 },
      timeline: { status: 'current', directorRevision: plan.revision, updatedAt: 100 },
      footage: { status: 'current', directorRevision: plan.revision, updatedAt: 100 },
    };
    useAIStore.setState({ analysisResult: analysis([], plan), coverCandidates: [] });
    generateCards.mockResolvedValue(analysis([], plan));
    runAudioTrack.mockImplementation(async ({ execution }: { execution: MotionProductionPlan }) => ({
      execution, outcome: 'disabled' as const, reusedSounds: 0,
    }));

    const result = await runDirectorProductionClient({
      projectDir: '/project', production: persisted, entries: [], settings: {} as never,
      taskId: 'task-1',
    });

    expect(runAudioTrack.mock.calls[0]?.[0].execution.motionBible.carrierPlan[0]).toMatchObject({
      renderStrategy: 'agent-composite',
      compositionIntent,
      fallbackPolicy: 'block',
    });
    expect(result.execution?.motionBible.carrierPlan[0]).toMatchObject({
      renderStrategy: 'agent-composite',
      compositionIntent,
      fallbackPolicy: 'block',
    });
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
      footage: EMPTY_FOOTAGE_TRACK_RESULT,
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

  it('persists the approved shot directions as the execution source of truth', async () => {
    const plan = directorPlan();
    plan.segments[0] = {
      ...plan.segments[0],
      carrier: 'quote',
      composition: 'split',
      cameraMove: 'pan-right',
      transition: 'hard-cut',
      rationale: '导演台最终调整',
    };
    persisted = runningState(plan, 'director', null);
    const execution = buildDirectorExecutionPlan(plan, 12_000);

    await commitDirectorProductionArtifacts({
      projectDir: '/project', taskId: 'task-1', plan,
      analysis: analysis([card('seg-1', false, plan.revision)], plan),
      cover: { prompts: [], candidates: [] },
      audio: { execution, outcome: 'disabled', reusedSounds: 0 },
      footage: EMPTY_FOOTAGE_TRACK_RESULT,
      replaceTimeline: false, manualMergeCount: 0, telemetry: null,
    });

    expect(useAIStore.getState().analysisResult?.motionBible?.carrierPlan[0]).toMatchObject({
      segmentId: 'seg-1',
      preferredCarrier: 'quote',
      composition: 'split',
      cameraMove: 'pan-right',
      transition: 'hard-cut',
    });
    expect(persisted.execution?.shots.find((shot) => shot.segmentId === 'seg-1')).toMatchObject({
      carrier: 'quote',
      composition: 'split',
      cameraMove: 'pan-right',
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
      footage: EMPTY_FOOTAGE_TRACK_RESULT,
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
      footage: EMPTY_FOOTAGE_TRACK_RESULT,
      replaceTimeline: true, manualMergeCount: 0, telemetry: null,
    });

    expect(result.workflow).toMatchObject({ stage: 'quality-blocked' });
    expect(result.outputs.cards.status).toBe('failed');
    expect(result.outputs.timeline.status).toBe('failed');
    expect(useTimelineStore.getState().timeline).toBe(timelineBefore);
    expect(api.saveProjectSection.mock.calls.some((call) => call[1] === 'timeline')).toBe(false);
  });

  it('非 Motion 镜头的素材轨失败时阻断且不提交缺素材时间线', async () => {
    const plan = directorPlan();
    plan.segments[0] = {
      ...plan.segments[0],
      visualType: 'footage',
      renderStrategy: 'standalone-media',
    };
    persisted = runningState(plan, 'director', {
      allCards: true, segmentIds: [], cover: false, audio: false,
      timeline: true, quality: true, reasons: ['initial-approval'],
    });
    const timelineBefore = useTimelineStore.getState().timeline;

    const result = await commitDirectorProductionArtifacts({
      projectDir: '/project', taskId: 'task-1', plan,
      analysis: analysis([card('seg-2', false, plan.revision)], plan),
      cover: { prompts: [], candidates: [] },
      audio: {
        execution: buildDirectorExecutionPlan(plan, 12_000), outcome: 'disabled', reusedSounds: 0,
      },
      footage: {
        ran: true,
        error: 'kacut 请求超时',
        placements: [],
        compositionInputs: [],
        claimedSegmentIds: [],
        fallbacks: [],
        blockedSegmentIds: [],
      },
      replaceTimeline: true, manualMergeCount: 0, telemetry: null,
    });

    expect(result.workflow).toMatchObject({
      stage: 'quality-blocked',
      error: expect.stringContaining('非 Motion 镜头尚未确认'),
    });
    expect(result.outputs.footage.status).toBe('failed');
    expect(result.outputs.timeline).toMatchObject({
      status: 'failed', error: expect.stringContaining('素材轨失败'),
    });
    expect(useTimelineStore.getState().timeline).toBe(timelineBefore);
    expect(api.saveProjectSection.mock.calls.some((call) => call[1] === 'timeline')).toBe(false);
  });
});
