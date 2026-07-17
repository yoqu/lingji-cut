import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHeadlessDirectorTimeline } from '../electron/pipeline/director-headless-timeline';
import { runDirectorAudioTrack } from '../src/lib/director-audio-track';
import { createDirectorPlan } from '../src/lib/director-planning';
import { buildDirectorExecutionPlan } from '../src/lib/production-plan';
import { createDefaultAudioOverlayData, createDefaultTimeline, type OverlayItem } from '../src/types';
import type { AISettings } from '../src/types/ai';
import type { DirectorPlan } from '../src/types/director';
import { useTimelineStore } from '../src/store/timeline';

function directorPlan(options: {
  bgmEnabled?: boolean;
  soundEffectsEnabled?: boolean;
} = {}): DirectorPlan {
  const segment = {
    id: 'seg-1', title: '重点', summary: '重点内容', startMs: 0, endMs: 10_000,
    semanticType: 'data' as const, complexityLevel: 'medium' as const,
    visualizationScore: 90, pacingNeed: 'accent' as const, keywords: [], entities: [],
    visualType: 'motion' as const, enabled: true, purpose: 'evidence' as const,
    carrier: 'data-hero', intensity: 3 as const, rationale: '突出证据',
  };
  return {
    revision: 1, inputFingerprint: 'audio-options', summary: '摘要', keywords: [],
    segments: [segment],
    motionBible: {
      visualThesis: '命题', rhythm: { density: 'balanced', heavySegments: ['seg-1'], quietSegments: [] },
      carrierPlan: [], styleRules: { paletteUse: '蓝', typographyUse: '短标题' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '封面', composition: '居中' },
    audioDirection: {
      bgmStyle: '克制', energy: 2, soundDensity: 'balanced',
      bgmEnabled: options.bgmEnabled,
      soundEffectsEnabled: options.soundEffectsEnabled,
    },
    warnings: [], createdAt: 1, updatedAt: 1, approvedAt: 2,
  };
}

function audioOverlay(id: string, role: 'bgm' | 'sfx', cueId?: string): OverlayItem {
  return {
    id, type: 'audio', assetPath: `/audio/${id}.mp3`, trackId: 'audio',
    startMs: 0, durationMs: 1_000, position: { x: 0, y: 0, width: 0, height: 0 },
    audioData: { ...createDefaultAudioOverlayData(1_000), role, cueId },
  };
}

describe('director audio options', () => {
  beforeEach(() => {
    useTimelineStore.getState().setTimeline(createDefaultTimeline());
  });

  it('new director plans explicitly enable BGM and sound effects by default', async () => {
    const result = await createDirectorPlan(
      [{ index: 1, startMs: 0, endMs: 1_000, text: '内容' }],
      {} as AISettings,
      {
        planSegments: async () => ({ segments: [], coverPrompts: [], summary: '摘要', keywords: [] }),
        generateBible: async () => directorPlan().motionBible,
      },
    );
    expect(result.audioDirection).toMatchObject({ bgmEnabled: true, soundEffectsEnabled: true });
  });

  it('omits disabled BGM and sound-effect cues from the execution plan', () => {
    const legacyCompatible = buildDirectorExecutionPlan(directorPlan(), 10_000);
    expect(legacyCompatible.audioPlan.bgm).toHaveLength(1);
    expect(legacyCompatible.audioPlan.sfx).toHaveLength(1);

    const disabled = buildDirectorExecutionPlan(
      directorPlan({ bgmEnabled: false, soundEffectsEnabled: false }),
      10_000,
    );
    expect(disabled.audioPlan.bgm).toEqual([]);
    expect(disabled.audioPlan.stingers).toEqual([]);
    expect(disabled.audioPlan.sfx).toEqual([]);
    expect(disabled.shots[0].audioCueIds).toEqual([]);

    const effectsOnly = buildDirectorExecutionPlan(
      directorPlan({ bgmEnabled: false, soundEffectsEnabled: true }),
      10_000,
    );
    expect(effectsOnly.audioPlan.bgm).toEqual([]);
    expect(effectsOnly.audioPlan.sfx).toHaveLength(1);
  });

  it('does not call audio providers when both audio options are disabled', async () => {
    const searchReusableMediaAssets = vi.fn(async () => []);
    Object.assign(globalThis, { window: { electronAPI: { searchReusableMediaAssets } } });
    const timeline = createDefaultTimeline();
    timeline.overlays.push(
      audioOverlay('generated-bgm', 'bgm', 'bgm-main'),
      audioOverlay('manual-audio', 'sfx'),
    );
    useTimelineStore.getState().setTimeline(timeline);
    const execution = buildDirectorExecutionPlan(
      directorPlan({ bgmEnabled: false, soundEffectsEnabled: false }),
      10_000,
    );
    const result = await runDirectorAudioTrack({
      projectDir: '/project', durationMs: 10_000, execution,
      settings: { audioGeneration: { enabled: true } } as AISettings,
    });
    expect(searchReusableMediaAssets).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'disabled', reusedSounds: 0 });
    expect(useTimelineStore.getState().timeline.overlays.map((overlay) => overlay.id)).toEqual([
      'manual-audio',
    ]);
  });

  it('removes disabled generated audio while preserving manually added audio', () => {
    const current = createDefaultTimeline();
    current.overlays.push(
      audioOverlay('generated-bgm', 'bgm', 'bgm-main'),
      audioOverlay('generated-sfx', 'sfx', 'sfx-1'),
      audioOverlay('manual-audio', 'sfx'),
    );
    const plan = directorPlan({ bgmEnabled: false, soundEffectsEnabled: false });
    const result = buildHeadlessDirectorTimeline({
      current,
      analysis: { segments: [], cards: [], coverPrompts: [], summary: '', keywords: [] },
      plan,
      highlights: [],
      audioPlacements: [],
    });
    expect(result.overlays.map((overlay) => overlay.id)).toEqual(['manual-audio']);
  });
});
