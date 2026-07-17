import { describe, expect, it, vi } from 'vitest';
import { createDirectorPlan } from '../src/lib/director-planning';
import { generateCardsFromDirectorPlan } from '../src/lib/director-production';
import type { AISettings, AICard } from '../src/types/ai';

const settings = { cardGenerationConcurrency: 2 } as AISettings;
const entries = [{ index: 1, startMs: 0, endMs: 5_000, text: '第一段内容' }];

describe('createDirectorPlan', () => {
  it('stops after planning and Motion Bible without invoking card generation', async () => {
    const planSegments = vi.fn(async () => ({
      segments: [{
        id: 'seg-1', title: '第一段', summary: '解释内容', startMs: 0, endMs: 5_000,
        semanticType: 'explanation' as const, complexityLevel: 'medium' as const,
        visualizationScore: 80, pacingNeed: 'steady' as const, keywords: [], entities: [],
        visualType: 'motion' as const,
      }],
      coverPrompts: ['知识视频封面'], summary: '节目摘要', keywords: ['知识'],
    }));
    const generateBible = vi.fn(async () => ({
      visualThesis: '清晰解释观点',
      rhythm: { density: 'balanced' as const, heavySegments: [], quietSegments: [] },
      carrierPlan: [{ segmentId: 'seg-1', preferredCarrier: 'process', intensity: 2 as const, reason: '解释流程' }],
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
      summary: '节目摘要',
      globalPrompt: '保持克制',
      segments: [{ id: 'seg-1', carrier: 'process', intensity: 2, purpose: 'explain' }],
      coverDirection: { prompt: '知识视频封面' },
      createdAt: 100,
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
    expect(result.cards[0].generationProvenance).toMatchObject({
      directorRevision: 1,
      generatedAt: 120,
      modifiedByUser: false,
    });
    expect(result.motionBible).toEqual(director.motionBible);
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
