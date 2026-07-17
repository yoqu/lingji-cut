import { describe, expect, it } from 'vitest';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import { evaluateProductionQuality } from '../src/lib/production-quality';
import { createDefaultProjectData } from '../src/lib/project-persistence';
import { createDefaultAudioOverlayData, createDefaultTimeline } from '../src/types';
import { DEFAULT_AUDIO_PLAN } from '../src/types/production';

describe('production quality gate', () => {
  it('必需 BGM 未本地化时阻止质量导出', () => {
    const project = createDefaultProjectData();
    project.production = {
      ...createEmptyProductionState(),
      execution: {
        version: 2,
        motionBible: {
          visualThesis: 'test',
          rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
          carrierPlan: [],
          styleRules: { paletteUse: 'test', typographyUse: 'test' },
          transitionRules: { default: 'crossfade', matchCutCandidates: [] },
        },
        sequences: [],
        shots: [],
        audioPlan: {
          ...DEFAULT_AUDIO_PLAN,
          bgm: [{
            id: 'bgm-main', role: 'bgm', query: '主 BGM', startMs: 0, required: true, reuseKey: 'audio:bgm:1',
          }],
        },
      },
    };
    const report = evaluateProductionQuality(project, createDefaultTimeline());
    expect(report.exportAllowed).toBe(false);
    expect(report.issues[0].code).toBe('required-audio-missing');
  });

  it('时间线已有同 cueId 的本地声音时允许质量导出', () => {
    const project = createDefaultProjectData();
    project.production = {
      ...createEmptyProductionState(),
      execution: {
        version: 2,
        motionBible: {
          visualThesis: 'test',
          rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
          carrierPlan: [],
          styleRules: { paletteUse: 'test', typographyUse: 'test' },
          transitionRules: { default: 'crossfade', matchCutCandidates: [] },
        },
        sequences: [],
        shots: [],
        audioPlan: {
          ...DEFAULT_AUDIO_PLAN,
          bgm: [{
            id: 'bgm-main', role: 'bgm', query: '主 BGM', startMs: 0, required: true, reuseKey: 'audio:bgm:1',
          }],
        },
      },
    };
    const timeline = createDefaultTimeline();
    timeline.overlays.push({
      id: 'bgm-overlay', type: 'audio', assetPath: '/project/assets/bgm.mp3', trackId: 'audio',
      startMs: 0, durationMs: 10_000, position: { x: 0, y: 0, width: 0, height: 0 },
      audioData: {
        ...createDefaultAudioOverlayData(10_000),
        cueId: 'bgm-main',
        role: 'bgm',
      },
    });

    const report = evaluateProductionQuality(project, timeline);

    expect(report.exportAllowed).toBe(true);
    expect(report.issues.map((issue) => issue.code)).not.toContain('required-audio-missing');
  });

  it('远程 URL 不允许进入质量导出', () => {
    const project = createDefaultProjectData();
    const timeline = createDefaultTimeline();
    timeline.overlays.push({
      id: 'remote', type: 'video', assetPath: 'https://cdn.example/video.mp4', trackId: 'visual-1',
      startMs: 0, durationMs: 1_000, position: { x: 0, y: 0, width: 100, height: 100 },
    });
    const report = evaluateProductionQuality(project, timeline);
    expect(report.exportAllowed).toBe(false);
    expect(report.remoteAssetCount).toBe(1);
  });

  it('母带响度或 True Peak 超标时阻止质量导出', () => {
    const project = createDefaultProjectData();
    project.production = {
      ...createEmptyProductionState(),
      execution: {
        version: 2,
        motionBible: {
          visualThesis: 'test',
          rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
          carrierPlan: [],
          styleRules: { paletteUse: 'test', typographyUse: 'test' },
          transitionRules: { default: 'crossfade', matchCutCandidates: [] },
        },
        sequences: [],
        shots: [],
        audioPlan: DEFAULT_AUDIO_PLAN,
      },
    };
    const report = evaluateProductionQuality(project, createDefaultTimeline(), {
      integratedLufs: -18,
      truePeakDbtp: 0.2,
    });
    expect(report.exportAllowed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual([
      'master-loudness-out-of-range',
      'master-true-peak-exceeded',
    ]);
  });

  it('媒体镜头还没有生成本地素材时阻止质量导出', () => {
    const project = createDefaultProjectData();
    project.aiAnalysis.analysisResult = {
      segments: [], coverPrompts: [], summary: '', keywords: [],
      cards: [{
        id: 'media-1', segmentId: 'seg-1', type: 'video', title: '待生成镜头',
        content: {
          mediaType: 'video', assetPath: null, aspectRatio: '16:9', prompt: 'test',
          providerId: null, model: null, generationStatus: 'idle',
        },
        startMs: 0, endMs: 4_000, displayDurationMs: 4_000, displayMode: 'fullscreen',
        template: 'default', enabled: true,
        style: { primaryColor: '#fff', backgroundColor: '#000', fontSize: 40 },
      }],
    };
    const report = evaluateProductionQuality(project, createDefaultTimeline());
    expect(report.exportAllowed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain('shot-asset-missing');
  });

  it('章节与重点声音超过每分钟四次时给出密度告警', () => {
    const project = createDefaultProjectData();
    project.production = {
      ...createEmptyProductionState(),
      execution: {
        version: 2,
        motionBible: {
          visualThesis: 'test',
          rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
          carrierPlan: [],
          styleRules: { paletteUse: 'test', typographyUse: 'test' },
          transitionRules: { default: 'crossfade', matchCutCandidates: [] },
        },
        sequences: [],
        shots: [],
        audioPlan: {
          ...DEFAULT_AUDIO_PLAN,
          stingers: Array.from({ length: 5 }, (_, index) => ({
            id: `stinger-${index}`, role: 'stinger' as const, query: 'test',
            startMs: index * 10_000, required: false, reuseKey: `audio:stinger:${index}`,
          })),
        },
      },
    };
    const timeline = createDefaultTimeline();
    timeline.podcast.durationMs = 60_000;

    const report = evaluateProductionQuality(project, timeline);
    expect(report.exportAllowed).toBe(true);
    expect(report.issues.map((issue) => issue.code)).toContain('audio-cue-density-high');
  });
});
