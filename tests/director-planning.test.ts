import { describe, expect, it, vi } from 'vitest';
import { createDirectorPlan } from '../src/lib/director-planning';
import { generateCardsFromDirectorPlan } from '../src/lib/director-production';
import type { AISettings, AICard } from '../src/types/ai';
import type { DirectorPlan } from '../src/types/director';
import type { FootageCompositionInput } from '../src/types/footage';

const settings = { cardGenerationConcurrency: 2 } as AISettings;
const entries = [{ index: 1, startMs: 0, endMs: 5_000, text: '第一段内容' }];

function cancellationPlan(count = 5): DirectorPlan {
  const segments = Array.from({ length: count }, (_, index) => ({
    id: `seg-${index + 1}`, title: `第${index + 1}段`, summary: '解释内容',
    startMs: index * 1_000, endMs: (index + 1) * 1_000,
    semanticType: 'explanation' as const, complexityLevel: 'medium' as const,
    visualizationScore: 80, pacingNeed: 'steady' as const, keywords: [], entities: [],
    visualType: 'motion' as const, enabled: true, purpose: 'explain',
    carrier: 'concept', intensity: 2 as const, rationale: '测试取消调度',
  }));
  return {
    revision: 1, approvedAt: 10, inputFingerprint: 'cancel', summary: '摘要', keywords: [], segments,
    motionBible: {
      visualThesis: '命题', rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
      carrierPlan: [], styleRules: { paletteUse: '蓝', typographyUse: '短' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '', composition: '' },
    audioDirection: { bgmStyle: '', energy: 2, soundDensity: 'balanced' },
    warnings: [], createdAt: 1, updatedAt: 1,
  };
}

describe('createDirectorPlan', () => {
  it('stops after planning and Motion Bible without invoking card generation', async () => {
    const planSegments = vi.fn(async () => ({
      segments: [{
        id: 'seg-1', title: '第一段', summary: '解释内容', startMs: 0, endMs: 5_000,
        semanticType: 'explanation' as const, complexityLevel: 'medium' as const,
        visualizationScore: 80, pacingNeed: 'steady' as const, keywords: [], entities: [],
        visualType: 'motion' as const,
      }],
      title: '世界第91位不是突然发生的',
      coverPrompts: ['16:9 知识视频封面，画面主标题“世界第91位不是突然发生的”'],
      summary: '节目摘要', keywords: ['知识'],
      warnings: ['灵机素材库连接失败：fetch failed'],
    }));
    const generateBible = vi.fn(async () => ({
      visualThesis: '清晰解释观点',
      rhythm: { density: 'balanced' as const, heavySegments: [], quietSegments: [] },
      carrierPlan: [{
        segmentId: 'seg-1', visualType: 'image' as const, preferredCarrier: 'image',
        intensity: 2 as const, composition: 'media-window' as const,
        cameraMove: 'push-in' as const, mediaRole: 'demonstration' as const,
        reason: '展示具体对象',
      }],
      styleRules: { paletteUse: '系统蓝', typographyUse: '短标题' },
      transitionRules: { default: 'push' as const, matchCutCandidates: [] },
    }));
    const result = await createDirectorPlan(entries, settings, {
      revision: 2,
      globalPrompt: '保持克制',
      stylePresetId: 'editorial-eink',
      planSegments,
      generateBible,
      now: 100,
    });
    expect(planSegments).toHaveBeenCalledTimes(1);
    expect(generateBible).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      revision: 2,
      title: '世界第91位不是突然发生的',
      summary: '节目摘要',
      globalPrompt: '保持克制',
      segments: [{
        id: 'seg-1', visualType: 'image', carrier: 'image', intensity: 2,
        purpose: 'explain', composition: 'media-window', cameraMove: 'push-in',
      }],
      coverDirection: { prompt: '16:9 知识视频封面，画面主标题“世界第91位不是突然发生的”' },
      audioDirection: { bgmEnabled: true },
      warnings: ['灵机素材库连接失败：fetch failed'],
      createdAt: 100,
    });

    const noBgm = await createDirectorPlan(entries, settings, {
      planSegments, generateBible, bgmEnabled: false, now: 100,
    });
    expect(noBgm.audioDirection.bgmEnabled).toBe(false);
  });

  it('把 AI 导演的 agent-composite 决策写入可审核镜头方案', async () => {
    const planSegments = vi.fn(async () => ({
      segments: [{
        id: 'seg-1', title: '工厂积累', summary: '真实生产线与观点共同论证', startMs: 0, endMs: 5_000,
        semanticType: 'explanation' as const, complexityLevel: 'medium' as const,
        visualizationScore: 85, pacingNeed: 'accent' as const, keywords: ['工厂'], entities: [],
        visualType: 'footage' as const, footageQuery: '汽车 工厂 生产线', footageFallback: 'motion' as const,
      }],
      coverPrompts: ['封面'], summary: '节目摘要', keywords: ['工厂'],
    }));
    const compositionIntent = {
      narrativeGoal: '用真实生产线支撑长期主义观点',
      focalPriority: '生产线动作优先',
      temporalRelationship: '观点在中段进入',
      mustShow: ['生产线'],
      avoid: ['广告式陈列'],
    };
    const generateBible = vi.fn(async () => ({
      visualThesis: '真实证据与观点共同推进',
      rhythm: { density: 'balanced' as const, heavySegments: ['seg-1'], quietSegments: [] },
      carrierPlan: [{
        segmentId: 'seg-1', visualType: 'footage' as const,
        renderStrategy: 'agent-composite' as const,
        preferredCarrier: 'concept', intensity: 3 as const,
        cameraMove: 'tracking' as const, mediaRole: 'evidence' as const,
        mediaQuery: '汽车 工厂 生产线', footageFallback: 'motion' as const,
        compositionIntent, fallbackPolicy: 'block' as const,
        reason: '素材与观点各自提供信息',
      }],
      styleRules: { paletteUse: '系统蓝', typographyUse: '短标题' },
      transitionRules: { default: 'hard-cut' as const, matchCutCandidates: [] },
    }));

    const result = await createDirectorPlan(entries, settings, { planSegments, generateBible, now: 100 });

    expect(result.segments[0]).toMatchObject({
      visualType: 'footage',
      renderStrategy: 'agent-composite',
      carrier: 'concept',
      composition: undefined,
      compositionIntent,
      fallbackPolicy: 'block',
      footageQuery: '汽车 工厂 生产线',
    });
  });
});

describe('generateCardsFromDirectorPlan', () => {
  it('generates cards only from the approved plan and stamps provenance', async () => {
    const director = await createDirectorPlan(entries, settings, {
      planSegments: async () => ({
        segments: [{
          id: 'seg-1', title: '第一段', summary: '解释内容', startMs: 0, endMs: 5_000,
          semanticType: 'explanation', complexityLevel: 'medium', visualizationScore: 80,
          pacingNeed: 'steady', keywords: [], entities: [], visualType: 'motion',
        }],
        coverPrompts: ['封面'], summary: '摘要', keywords: [],
      }),
      generateBible: async () => ({
        visualThesis: '命题', rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
        carrierPlan: [], styleRules: { paletteUse: '蓝', typographyUse: '短' },
        transitionRules: { default: 'crossfade', matchCutCandidates: [] },
      }),
      now: 100,
    });
    const generated: AICard = {
      id: 'new-card', segmentId: 'seg-1', type: 'summary', title: '第一段', content: '内容',
      startMs: 0, endMs: 5_000, displayDurationMs: 5_000, displayMode: 'fullscreen',
      template: 'default', enabled: true,
      style: { primaryColor: '#fff', backgroundColor: '#111', fontSize: 48 },
    };
    const generateCard = vi.fn(async () => generated);
    const result = await generateCardsFromDirectorPlan(entries, { ...director, approvedAt: 110 }, settings, {
      generateCard,
      now: 120,
    });
    expect(generateCard).toHaveBeenCalledTimes(1);
    expect(generateCard.mock.calls[0]?.[4]).not.toHaveProperty('compositionInputs');
    expect(result.cards[0].generationProvenance).toMatchObject({
      directorRevision: 1,
      generatedAt: 120,
      modifiedByUser: false,
    });
    expect(result.motionBible).toMatchObject({
      ...director.motionBible,
      carrierPlan: [{
        segmentId: 'seg-1',
        visualType: 'motion',
        preferredCarrier: 'concept',
        composition: 'graphic',
        cameraMove: 'static',
      }],
    });
  });

  it('routes agent-composite independently from visualType and passes locked composition inputs', async () => {
    const segment = {
      id: 'seg-1', title: '第一段', summary: '真实素材组合', startMs: 0, endMs: 5_000,
      semanticType: 'explanation', complexityLevel: 'medium', visualizationScore: 80,
      pacingNeed: 'steady', keywords: [], entities: [], visualType: 'image',
      enabled: true, purpose: 'explain', carrier: 'footage', intensity: 2, rationale: '',
      renderStrategy: 'agent-composite',
      compositionIntent: {
        narrativeGoal: '用真实画面支撑观点', focalPriority: '人物动作',
        temporalRelationship: '素材先出现，数据随后进入', mustShow: ['人物'], avoid: ['纯文字铺满'],
      },
      fallbackPolicy: 'block',
    } as const;
    const plan = {
      revision: 1, approvedAt: 10, inputFingerprint: 'x', summary: '摘要', keywords: [],
      segments: [segment],
      motionBible: {
        visualThesis: '命题', rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
        carrierPlan: [], styleRules: { paletteUse: '蓝', typographyUse: '短' },
        transitionRules: { default: 'crossfade', matchCutCandidates: [] },
      },
      coverDirection: { prompt: '', composition: '' },
      audioDirection: { bgmStyle: '', energy: 2, soundDensity: 'balanced' },
      warnings: [], createdAt: 1, updatedAt: 1,
    } as DirectorPlan;
    const input: FootageCompositionInput = {
      segmentIndex: 0, segmentId: 'seg-1', startMs: 0, durationMs: 5_000,
      usage: 'required', trimStartMs: 1_000,
      asset: {
        id: 'asset-1', filename: 'factory.mp4', path: '/library/factory.mp4',
        kind: 'video', score: 0.9,
      },
    };
    const generated: AICard = {
      id: 'card-1', segmentId: 'seg-1', type: 'motion', title: '第一段', content: '内容',
      startMs: 0, endMs: 5_000, displayDurationMs: 5_000, displayMode: 'fullscreen',
      template: 'default', enabled: true,
      style: { primaryColor: '#fff', backgroundColor: '#111', fontSize: 48 },
    };
    const generateCard = vi.fn(async () => generated);

    await generateCardsFromDirectorPlan(entries, plan, settings, {
      generateCard,
      compositionInputs: new Map([['seg-1', [input]]]),
    });

    expect(generateCard).toHaveBeenCalledWith(
      entries,
      plan,
      segment,
      settings,
      expect.objectContaining({
        visualType: 'image',
        renderStrategy: 'agent-composite',
        fallbackPolicy: 'block',
        compositionInputs: [input],
        compositionIntent: segment.compositionIntent,
      }),
    );

    const motionFallbackPlan = {
      ...plan,
      segments: [{ ...segment, fallbackPolicy: 'motion' as const }],
    } as DirectorPlan;
    const retryGenerateCard = vi.fn()
      .mockRejectedValueOnce(new Error('composite failed'))
      .mockResolvedValueOnce(generated);
    const retryResult = await generateCardsFromDirectorPlan(entries, motionFallbackPlan, settings, {
      generateCard: retryGenerateCard,
      compositionInputs: new Map([['seg-1', [input]]]),
    });
    expect(retryResult.cardErrors).toBeUndefined();
    expect(retryGenerateCard).toHaveBeenCalledTimes(2);
    expect(retryGenerateCard).toHaveBeenNthCalledWith(
      2,
      entries,
      motionFallbackPlan,
      motionFallbackPlan.segments[0],
      settings,
      expect.objectContaining({
        visualType: 'motion',
        renderStrategy: 'motion-card',
        compositionInputs: [],
        fallbackPolicy: 'block',
        approvedFallbackExecution: 'motion',
      }),
    );

    const directFallbackGenerateCard = vi.fn(async () => generated);
    await generateCardsFromDirectorPlan(entries, motionFallbackPlan, settings, {
      generateCard: directFallbackGenerateCard,
      renderStrategyOverrides: new Map([['seg-1', 'motion-card']]),
      compositionInputs: new Map([['seg-1', []]]),
    });
    expect(directFallbackGenerateCard).toHaveBeenCalledWith(
      entries,
      motionFallbackPlan,
      motionFallbackPlan.segments[0],
      settings,
      expect.objectContaining({
        renderStrategy: 'motion-card',
        compositionInputs: [],
        fallbackPolicy: 'block',
        approvedFallbackExecution: 'motion',
      }),
    );
  });

  it('暂停后不再领取下一批镜头，也不把未完成镜头记入 cardErrors', async () => {
    const plan = cancellationPlan();
    let cancelled = false;
    const pending: Array<() => void> = [];
    const generateCard = vi.fn((
      _entries: unknown,
      _plan: unknown,
      segment: DirectorPlan['segments'][number],
    ) => new Promise<AICard>((resolve) => {
      pending.push(() => resolve({
        id: `card-${segment.id}`, segmentId: segment.id, type: 'summary', title: segment.title,
        content: '内容', startMs: segment.startMs, endMs: segment.endMs,
        displayDurationMs: segment.endMs - segment.startMs, displayMode: 'fullscreen',
        template: 'default', enabled: true,
        style: { primaryColor: '#fff', backgroundColor: '#111', fontSize: 48 },
      }));
    }));

    const running = generateCardsFromDirectorPlan(entries, plan, settings, {
      generateCard: generateCard as never,
      shouldCancel: () => cancelled,
    });
    await vi.waitFor(() => expect(generateCard).toHaveBeenCalledTimes(2));
    cancelled = true;
    pending.splice(0).forEach((resolve) => resolve());

    const result = await running;
    expect(generateCard).toHaveBeenCalledTimes(2);
    expect(result.cards).toHaveLength(0);
    expect(result.cardErrors).toBeUndefined();
  });

  it('AbortError 会终止卡片调度并原样上抛，不会变成镜头失败', async () => {
    const plan = cancellationPlan(3);
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const generateCard = vi.fn().mockRejectedValue(abortError);

    await expect(generateCardsFromDirectorPlan(entries, plan, {
      ...settings,
      cardGenerationConcurrency: 1,
    }, {
      generateCard,
    })).rejects.toBe(abortError);
    expect(generateCard).toHaveBeenCalledTimes(1);
  });

  it('refuses to generate from an unapproved plan', async () => {
    const plan = {
      revision: 1, inputFingerprint: 'x', summary: '', keywords: [], segments: [],
      motionBible: {
        visualThesis: '', rhythm: { density: 'balanced' as const, heavySegments: [], quietSegments: [] },
        carrierPlan: [], styleRules: { paletteUse: '', typographyUse: '' },
        transitionRules: { default: 'crossfade' as const, matchCutCandidates: [] },
      },
      coverDirection: { prompt: '', composition: '' },
      audioDirection: { bgmStyle: '', energy: 2 as const, soundDensity: 'balanced' as const },
      warnings: [], createdAt: 1, updatedAt: 1,
    };
    await expect(generateCardsFromDirectorPlan(entries, plan, settings)).rejects.toMatchObject({
      code: 'director_approval_required',
    });
  });
});
