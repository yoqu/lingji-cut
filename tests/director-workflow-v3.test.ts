import { describe, expect, it } from 'vitest';
import {
  canResumeProduction,
  compareDirectorPlans,
  createDirectorInputFingerprint,
  createEmptyProductionState,
  migrateLegacyProductionState,
} from '../src/lib/director-workflow';
import { generateCardsFromDirectorPlan } from '../src/lib/director-production';
import type { DirectorPlan, ProjectProductionState } from '../src/types/director';
import { createDefaultTimeline } from '../src/types';
import type { AICard, AIAnalysisResult } from '../src/types/ai';

function plan(overrides: Partial<DirectorPlan> = {}): DirectorPlan {
  return {
    revision: 1,
    inputFingerprint: 'source-a',
    summary: '整期摘要',
    keywords: ['AI', '产业'],
    segments: [
      {
        id: 'seg-1',
        title: '第一段',
        summary: '解释背景',
        startMs: 0,
        endMs: 6_000,
        semanticType: 'explanation',
        complexityLevel: 'medium',
        visualizationScore: 80,
        pacingNeed: 'steady',
        keywords: ['背景'],
        entities: [],
        visualType: 'motion',
        enabled: true,
        purpose: 'explain',
        carrier: 'process',
        intensity: 2,
        rationale: '按因果关系展开',
      },
      {
        id: 'seg-2',
        title: '第二段',
        summary: '强调结论',
        startMs: 6_000,
        endMs: 12_000,
        semanticType: 'data',
        complexityLevel: 'high',
        visualizationScore: 92,
        pacingNeed: 'accent',
        keywords: ['结论'],
        entities: [],
        visualType: 'motion',
        enabled: true,
        purpose: 'evidence',
        carrier: 'data-hero',
        intensity: 3,
        rationale: '突出核心数字',
      },
    ],
    motionBible: {
      visualThesis: '克制的信息动效',
      rhythm: { density: 'balanced', heavySegments: ['seg-2'], quietSegments: [] },
      carrierPlan: [
        { segmentId: 'seg-1', preferredCarrier: 'process', intensity: 2, reason: '解释' },
        { segmentId: 'seg-2', preferredCarrier: 'data-hero', intensity: 3, reason: '强调' },
      ],
      styleRules: { paletteUse: '系统蓝', typographyUse: '短标题' },
      transitionRules: { default: 'push', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '突出产业变化的知识视频封面', composition: '主体居中' },
    audioDirection: { bgmStyle: '克制、现代', energy: 2, soundDensity: 'balanced' },
    warnings: [],
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

describe('director workflow v3 contract', () => {
  it('creates a stable fingerprint and changes it when source inputs drift', () => {
    const first = createDirectorInputFingerprint({
      entries: [{ index: 1, startMs: 0, endMs: 1_000, text: 'hello' }],
      globalPrompt: 'clean',
      stylePresetId: 'editorial-eink',
    });
    const same = createDirectorInputFingerprint({
      entries: [{ index: 1, startMs: 0, endMs: 1_000, text: 'hello' }],
      globalPrompt: 'clean',
      stylePresetId: 'editorial-eink',
    });
    const changed = createDirectorInputFingerprint({
      entries: [{ index: 1, startMs: 0, endMs: 1_000, text: 'changed' }],
      globalPrompt: 'clean',
      stylePresetId: 'editorial-eink',
    });
    expect(same).toBe(first);
    expect(changed).not.toBe(first);
  });

  it('marks only cover output stale for a cover-direction-only revision', () => {
    const before = plan();
    const after = plan({
      revision: 2,
      coverDirection: { ...before.coverDirection, composition: '左文右图' },
    });
    expect(compareDirectorPlans(before, after)).toEqual({
      allCards: false,
      segmentIds: [],
      cover: true,
      audio: false,
      timeline: false,
      quality: true,
      reasons: ['cover-direction'],
    });
  });

  it('selectively invalidates one card and timeline for a segment carrier change', () => {
    const before = plan();
    const after = plan({
      revision: 2,
      segments: before.segments.map((segment) =>
        segment.id === 'seg-1' ? { ...segment, carrier: 'comparison' } : segment,
      ),
    });
    expect(compareDirectorPlans(before, after)).toMatchObject({
      allCards: false,
      segmentIds: ['seg-1'],
      cover: false,
      audio: false,
      timeline: true,
      quality: true,
    });
  });

  it('invalidates all downstream outputs for a global visual strategy change', () => {
    const before = plan();
    const after = plan({
      revision: 2,
      motionBible: {
        ...before.motionBible,
        styleRules: { ...before.motionBible.styleRules, paletteUse: '黑白高对比' },
      },
    });
    expect(compareDirectorPlans(before, after)).toMatchObject({
      allCards: true,
      cover: true,
      audio: true,
      timeline: true,
      quality: true,
    });
  });

  it('migrates generated v2 analysis into an approved protected revision', () => {
    const analysis: AIAnalysisResult = {
      segments: plan().segments,
      cards: [{
        id: 'card-1', segmentId: 'seg-1', type: 'summary', title: '第一段', content: '内容',
        startMs: 0, endMs: 6_000, displayDurationMs: 6_000, displayMode: 'fullscreen',
        template: 'default', enabled: true,
        style: { primaryColor: '#fff', backgroundColor: '#111', fontSize: 48 },
      }],
      coverPrompts: ['封面'], summary: '整期摘要', keywords: ['AI'], motionBible: plan().motionBible,
    };
    const migrated = migrateLegacyProductionState({
      analysisResult: analysis,
      legacyPlan: null,
      timeline: createDefaultTimeline(),
      mode: 'director',
      now: 200,
    });
    expect(migrated.version).toBe(3);
    expect(migrated.approvedPlan?.revision).toBe(1);
    expect(migrated.draftPlan).toBeNull();
    expect(migrated.workflow.stage).toBe('animatic-review');
    expect(migrated.legacyProtected).toBe(true);
  });

  it('creates a clean empty v3 workspace', () => {
    expect(createEmptyProductionState(300)).toMatchObject({
      version: 3,
      draftPlan: null,
      approvedPlan: null,
      execution: null,
      workflow: { mode: 'director', stage: 'idle' },
      pendingImpact: null,
      legacyProtected: false,
    });
  });

  it('keeps the previous card when regeneration fails', async () => {
    const previous: AICard = {
      id: 'stable-card-id',
      segmentId: 'seg-1',
      type: 'summary',
      title: '人工确认过的旧卡片',
      content: '旧结果必须保留到新结果成功',
      startMs: 0,
      endMs: 6_000,
      displayDurationMs: 6_000,
      displayMode: 'fullscreen',
      template: 'default',
      enabled: true,
      style: { primaryColor: '#fff', backgroundColor: '#111', fontSize: 48 },
      generationProvenance: {
        directorRevision: 1,
        fingerprint: 'old-card',
        generatedAt: 100,
        modifiedByUser: false,
      },
    };
    const result = await generateCardsFromDirectorPlan(
      [],
      { ...plan({ revision: 2 }), approvedAt: 200 },
      { cardGenerationConcurrency: 1 } as never,
      {
        existingCards: [previous],
        segmentIds: ['seg-1'],
        generateCard: async () => {
          throw new Error('provider unavailable');
        },
      },
    );

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toBe(previous);
    expect(result.cardErrors).toEqual([
      expect.objectContaining({ segmentId: 'seg-1', message: 'provider unavailable' }),
    ]);
  });

  it('canResumeProduction 覆盖暂停/出错/质检阻断与 refining 失败产出', () => {
    const base = createEmptyProductionState(100);
    const approved = { ...base, approvedPlan: plan() };
    const withStage = (stage: ProjectProductionState['workflow']['stage']) => ({
      ...approved,
      workflow: { ...approved.workflow, stage },
    });

    expect(canResumeProduction(base)).toBe(false);
    expect(canResumeProduction(withStage('production-paused'))).toBe(true);
    expect(canResumeProduction(withStage('error'))).toBe(true);
    expect(canResumeProduction(withStage('quality-blocked'))).toBe(true);
    expect(canResumeProduction(withStage('animatic-review'))).toBe(false);
    expect(canResumeProduction(withStage('refining'))).toBe(false);
    expect(canResumeProduction({
      ...withStage('refining'),
      outputs: {
        ...approved.outputs,
        timeline: { status: 'failed', updatedAt: 100, error: '21 个镜头未通过质量门禁' },
      },
    })).toBe(true);
  });
});
