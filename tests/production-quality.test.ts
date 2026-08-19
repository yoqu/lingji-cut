import { describe, expect, it } from 'vitest';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import { buildMotionCardProductionReport } from '../src/lib/motion-production-report';
import { evaluateProductionQuality } from '../src/lib/production-quality';
import { createDefaultProjectData } from '../src/lib/project-persistence';
import {
  createDefaultAudioOverlayData,
  createDefaultTimeline,
  DEFAULT_AI_CARDS_TRACK_ID,
} from '../src/types';
import {
  buildAICardTimelineDraft,
  type AICard,
  type AICardOverlayData,
} from '../src/types/ai';
import { DEFAULT_ASSET_TREATMENT, type CardAssetBinding } from '../src/types/assets';
import type { DirectorFallbackPolicy, DirectorPlan } from '../src/types/director';
import { DEFAULT_AUDIO_PLAN } from '../src/types/production';

const REQUIRED_ASSET = {
  id: 'asset-required',
  filename: 'factory.mp4',
  path: '/library/factory.mp4',
  kind: 'video' as const,
  score: 0.95,
};
const REQUIRED_FINGERPRINT = 'stat:1024:123456';

function requiredBinding(overrides: Partial<CardAssetBinding> = {}): CardAssetBinding {
  return {
    slot: 'media-1',
    assetId: REQUIRED_ASSET.id,
    filePath: REQUIRED_ASSET.path,
    kind: 'video',
    usage: 'required',
    required: true,
    fileFingerprint: REQUIRED_FINGERPRINT,
    treatment: DEFAULT_ASSET_TREATMENT,
    placement: { x: 0, y: 0, width: 1920, height: 1080 },
    ...overrides,
  };
}

function motionCard(overrides: Partial<AICard> = {}): AICard {
  return {
    id: 'card-1',
    segmentId: 'seg-1',
    type: 'motion',
    title: '组合镜头',
    content: '内容',
    startMs: 0,
    endMs: 4_000,
    displayDurationMs: 4_000,
    displayMode: 'fullscreen',
    template: 'default',
    enabled: true,
    style: { primaryColor: '#fff', backgroundColor: '#000', fontSize: 40 },
    renderStrategy: 'agent-composite',
    assetBindings: [requiredBinding()],
    motionCard: {
      compiledAt: 1,
      prompt: 'test',
      retryCount: 0,
      productionReport: buildMotionCardProductionReport({
        renderOk: true,
        visualReviewAvailable: true,
      }),
    },
    ...overrides,
  };
}

function compositePlan(fallbackPolicy: DirectorFallbackPolicy = 'block'): DirectorPlan {
  return {
    revision: 1,
    approvedAt: 10,
    inputFingerprint: 'fingerprint',
    summary: '摘要',
    keywords: [],
    segments: [{
      id: 'seg-1',
      title: '组合镜头',
      summary: '真实素材组合',
      startMs: 0,
      endMs: 4_000,
      semanticType: 'explanation',
      complexityLevel: 'medium',
      visualizationScore: 80,
      pacingNeed: 'steady',
      keywords: [],
      entities: [],
      visualType: 'footage',
      enabled: true,
      purpose: 'explain',
      carrier: 'footage',
      intensity: 2,
      renderStrategy: 'agent-composite',
      compositionAssets: [{ asset: REQUIRED_ASSET, usage: 'required' }],
      fallbackPolicy,
      rationale: '需要真实素材与动态图形共同表达',
    }],
    motionBible: {
      visualThesis: 'test',
      rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
      carrierPlan: [],
      styleRules: { paletteUse: 'test', typographyUse: 'test' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '', composition: '' },
    audioDirection: { bgmStyle: '', energy: 2, soundDensity: 'balanced' },
    warnings: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function projectWithComposite(card: AICard | null, fallbackPolicy: DirectorFallbackPolicy = 'block') {
  const project = createDefaultProjectData();
  const plan = compositePlan(fallbackPolicy);
  project.aiAnalysis.analysisResult = {
    segments: [],
    cards: card ? [card] : [],
    coverPrompts: [],
    summary: '',
    keywords: [],
    motionBible: plan.motionBible,
  };
  const production = createEmptyProductionState();
  production.approvedPlan = plan;
  production.workflow = { ...production.workflow, stage: 'complete' };
  for (const output of Object.keys(production.outputs) as Array<keyof typeof production.outputs>) {
    production.outputs[output] = {
      status: 'current',
      directorRevision: plan.revision,
      updatedAt: 10,
    };
  }
  project.production = production;
  return project;
}

function timelineForProject(project: ReturnType<typeof createDefaultProjectData>) {
  const timeline = createDefaultTimeline();
  for (const card of project.aiAnalysis.analysisResult?.cards ?? []) {
    const draft = buildAICardTimelineDraft(
      card,
      project.aiAnalysis.analysisResult?.motionBible,
    );
    timeline.overlays.push({
      id: `overlay-${card.id}`,
      type: 'image',
      assetPath: '',
      trackId: DEFAULT_AI_CARDS_TRACK_ID,
      startMs: draft.startMs,
      durationMs: draft.durationMs,
      position: { x: 0, y: 0, width: timeline.width, height: timeline.height },
      overlayType: 'ai-card',
      aiCardData: draft.aiCardData,
    });
  }
  for (const placement of project.production?.footage?.placements ?? []) {
    timeline.overlays.push({
      id: placement.overlayId,
      type: placement.kind,
      assetPath: placement.sourcePath,
      trackId: DEFAULT_AI_CARDS_TRACK_ID,
      startMs: placement.startMs,
      durationMs: placement.durationMs,
      trimStartMs: placement.trimStartMs,
      position: { x: 0, y: 0, width: timeline.width, height: timeline.height },
      overlayType: 'media',
      footageData: {
        segmentId: placement.segmentId,
        score: placement.score,
        thumbnailFile: placement.thumbnailFile,
        cameraMove: placement.cameraMove,
        mediaRole: placement.mediaRole,
      },
    });
  }
  return timeline;
}

function auditedMotionCard(): AICard {
  const card = motionCard({
    content: '当前视觉内容',
    template: 'current-template',
    displayMode: 'fullscreen',
    style: { primaryColor: '#ffffff', backgroundColor: '#000000', fontSize: 40 },
    generationProvenance: {
      directorRevision: 1,
      fingerprint: 'card-current',
      generatedAt: 10,
      modifiedByUser: false,
    },
  });
  return {
    ...card,
    motionCard: {
      ...card.motionCard!,
      tsx: 'export default function CurrentVisual(){ return null; }\n',
      storyboard: {
        claim: '当前分镜',
        carrier: 'concept',
        scene: '当前场景',
        beats: [],
      },
    },
  };
}

describe('production quality gate', () => {
  it.each([
    ['quality-blocked', 'production-workflow-quality-blocked'],
    ['error', 'production-workflow-failed'],
  ] as const)('制作流程处于 %s 时不允许导出旧时间线', (stage, code) => {
    const project = projectWithComposite(motionCard());
    project.production!.workflow = {
      ...project.production!.workflow,
      stage,
      error: '制作未收口',
    };

    const report = evaluateProductionQuality(project, timelineForProject(project));

    expect(report.exportAllowed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code, severity: 'error' }));
  });

  it('制作产物失败或过期时不允许导出', () => {
    const project = projectWithComposite(motionCard());
    project.production!.outputs.cards = {
      status: 'failed', directorRevision: 1, updatedAt: 20, error: '一个镜头失败',
    };
    project.production!.outputs.audio = {
      status: 'stale', directorRevision: 1, updatedAt: 20,
    };

    const report = evaluateProductionQuality(project, timelineForProject(project));

    expect(report.exportAllowed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'production-output-failed',
      'production-output-stale',
    ]));
  });

  it('制作产物属于旧导演修订时不允许导出', () => {
    const project = projectWithComposite(motionCard());
    project.production!.outputs.timeline = {
      status: 'current', directorRevision: 0, updatedAt: 20,
    };

    const report = evaluateProductionQuality(project, timelineForProject(project));

    expect(report.exportAllowed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'production-output-revision-stale',
      severity: 'error',
    }));
  });

  it('分段生成错误未清除时不允许用旧时间线导出', () => {
    const project = createDefaultProjectData();
    project.aiAnalysis.analysisResult = {
      segments: [], cards: [], coverPrompts: [], summary: '', keywords: [],
      cardErrors: [{ segmentId: 'seg-failed', segmentTitle: '失败镜头', message: '审片未通过' }],
    };

    const report = evaluateProductionQuality(project, createDefaultTimeline());

    expect(report.exportAllowed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'card-generation-failed',
      shotId: 'seg-failed',
    }));
  });

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

  it('Agent 合成未完成多模态审片时阻止质量导出', () => {
    const card = motionCard({
      motionCard: {
        compiledAt: 1,
        prompt: 'test',
        retryCount: 0,
        productionReport: buildMotionCardProductionReport({
          renderOk: true,
          visualReviewAvailable: false,
          unavailableReason: 'reviewer 无法读取关键帧',
        }),
      },
    });
    const project = projectWithComposite(card);
    const report = evaluateProductionQuality(project, timelineForProject(project));

    expect(report.exportAllowed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'visual-review-unavailable',
      severity: 'error',
      shotId: card.id,
    }));
  });

  it('当前 Agent 合成卡与时间线载体一致时允许导出', () => {
    const project = projectWithComposite(motionCard());

    const report = evaluateProductionQuality(project, timelineForProject(project));

    expect(report.exportAllowed).toBe(true);
    expect(report.issues.map((issue) => issue.code)).not.toContain('agent-composite-output-missing');
  });

  it.each<Array<[string, (data: AICardOverlayData) => void]>>([
    ['TSX', (data) => {
      data.motionCard = {
        ...data.motionCard!,
        tsx: 'export default function OldVisual(){ return null; }',
      };
    }],
    ['content', (data) => { data.content = '旧视觉内容'; }],
    ['style', (data) => { data.style = { ...data.style, primaryColor: '#ff0000' }; }],
    ['template', (data) => { data.template = 'old-template'; }],
    ['displayMode', (data) => { data.displayMode = 'pip'; }],
    ['assetBindings', (data) => {
      data.assetBindings = data.assetBindings?.map((binding) => ({
        ...binding,
        filePath: '/library/old-factory.mp4',
      }));
    }],
    ['storyboard', (data) => {
      data.motionCard = {
        ...data.motionCard!,
        storyboard: { ...data.motionCard!.storyboard!, claim: '旧分镜' },
      };
    }],
    ['provenance', (data) => {
      data.generationProvenance = {
        ...data.generationProvenance!,
        fingerprint: 'card-old',
      };
    }],
    ['motionBible', (data) => {
      data.motionBible = {
        ...data.motionBible!,
        transitionRules: {
          ...data.motionBible!.transitionRules,
          default: 'hard-cut',
        },
      };
    }],
  ])('时间线仍持有旧 %s 视觉载荷时阻止导出', (_field, mutate) => {
    const project = projectWithComposite(auditedMotionCard());
    const timeline = JSON.parse(JSON.stringify(timelineForProject(project))) as ReturnType<typeof createDefaultTimeline>;
    mutate(timeline.overlays[0].aiCardData!);

    const report = evaluateProductionQuality(project, timeline);

    expect(report.exportAllowed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'agent-composite-output-missing',
      severity: 'error',
    }));
  });

  it('忽略已外置 TSX 的路径与审片缓存路径差异', () => {
    const project = projectWithComposite(auditedMotionCard());
    const timeline = JSON.parse(JSON.stringify(timelineForProject(project))) as ReturnType<typeof createDefaultTimeline>;
    const motionCard = timeline.overlays[0].aiCardData!.motionCard!;
    motionCard.tsx = motionCard.tsx?.replace(/\n/gu, '\r\n');
    motionCard.tsxPath = 'ai-cards/overlay-card-1/motionCard.tsx';
    motionCard.productionReport = {
      ...motionCard.productionReport!,
      contactSheetPath: '/cache/old-contact-sheet.png',
      contactSheetCacheKey: 'old-cache-key',
    };

    const report = evaluateProductionQuality(project, timeline);

    expect(report.exportAllowed).toBe(true);
    expect(report.issues.map((issue) => issue.code)).not.toContain('agent-composite-output-missing');
  });

  it('Agent 合成缺少生产审片报告时阻止质量导出', () => {
    const card = motionCard({ motionCard: undefined });
    const project = projectWithComposite(card);
    const report = evaluateProductionQuality(project, timelineForProject(project));

    expect(report.exportAllowed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'visual-review-pending',
      severity: 'error',
      shotId: card.id,
    }));
  });

  it('旧 Motion 卡未完成多模态审片仍只告警，兼容既有项目', () => {
    const project = createDefaultProjectData();
    project.aiAnalysis.analysisResult = {
      segments: [], coverPrompts: [], summary: '', keywords: [],
      cards: [motionCard({
        renderStrategy: undefined,
        assetBindings: undefined,
        motionCard: {
          compiledAt: 1,
          prompt: 'test',
          retryCount: 0,
          productionReport: buildMotionCardProductionReport({
            renderOk: true,
            visualReviewAvailable: false,
          }),
        },
      })],
    };

    const report = evaluateProductionQuality(project, createDefaultTimeline());

    expect(report.exportAllowed).toBe(true);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'visual-review-unavailable',
      severity: 'warning',
    }));
  });

  it('Agent 合成缺少导演锁定的必用素材绑定时阻止质量导出', () => {
    const card = motionCard({ assetBindings: [] });
    const project = projectWithComposite(card);
    const report = evaluateProductionQuality(project, timelineForProject(project));

    expect(report.exportAllowed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'required-composite-media-missing',
      severity: 'error',
      shotId: card.id,
    }));
  });

  it('必用素材未通过 BoundMedia 出现在关键帧时阻止质量导出', () => {
    const card = motionCard({
      motionCard: {
        compiledAt: 1,
        prompt: 'test',
        retryCount: 0,
        productionReport: buildMotionCardProductionReport({
          renderOk: true,
          visualReviewAvailable: true,
          layoutIssues: [{
            severity: 'error',
            code: 'required-composite-media-not-visible',
            message: '必用素材未出现在任何关键帧',
          }],
        }),
      },
    });
    const project = projectWithComposite(card);
    const report = evaluateProductionQuality(project, timelineForProject(project));

    expect(report.exportAllowed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'required-composite-media-not-visible',
      severity: 'error',
      shotId: card.id,
    }));
  });

  it('必用素材的真实可见面积未完成探针验证时阻止质量导出', () => {
    const card = motionCard({
      motionCard: {
        compiledAt: 1,
        prompt: 'test',
        retryCount: 0,
        productionReport: buildMotionCardProductionReport({
          renderOk: true,
          visualReviewAvailable: true,
          layoutIssues: [{
            severity: 'error',
            code: 'required-composite-visibility-unverified',
            message: '无法确认必用素材的真实可见面积',
          }],
        }),
      },
    });
    const project = projectWithComposite(card);
    const report = evaluateProductionQuality(project, timelineForProject(project));

    expect(report.exportAllowed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'required-composite-visibility-unverified',
      severity: 'error',
      shotId: card.id,
    }));
  });

  it('显式 motion fallback 进入质量报告但不阻止导出', () => {
    const card = motionCard({
      renderStrategy: 'motion-card',
      assetBindings: undefined,
    });
    const project = projectWithComposite(card, 'motion');
    const report = evaluateProductionQuality(project, timelineForProject(project));

    expect(report.exportAllowed).toBe(true);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'shot-fallback',
      severity: 'warning',
      message: expect.stringContaining('motion'),
    }));
  });

  it('只有卡片数据但未按 motion fallback 进入时间线时仍阻止导出', () => {
    const card = motionCard({ renderStrategy: 'motion-card', assetBindings: undefined });
    const project = projectWithComposite(card, 'motion');

    const report = evaluateProductionQuality(project, createDefaultTimeline());

    expect(report.exportAllowed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'agent-composite-output-missing',
      severity: 'error',
    }));
  });

  it('完成审片的 Agent 合成卡未进入当前时间线时仍阻止导出', () => {
    const project = projectWithComposite(motionCard());

    const report = evaluateProductionQuality(project, createDefaultTimeline());

    expect(report.exportAllowed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'agent-composite-output-missing',
      severity: 'error',
    }));
  });

  it('显式 standalone-media fallback 进入质量报告但不阻止导出', () => {
    const project = projectWithComposite(null, 'standalone-media');
    project.production!.footage = {
      placements: [{
        segmentIndex: 0,
        segmentId: 'seg-1',
        overlayId: 'footage-seg-1',
        startMs: 0,
        durationMs: 4_000,
        sourcePath: REQUIRED_ASSET.path,
        fileFingerprint: REQUIRED_FINGERPRINT,
        kind: 'video',
        trimStartMs: 0,
        score: REQUIRED_ASSET.score,
      }],
      compositionInputs: [],
      claimedSegmentIds: ['seg-1'],
      fallbacks: [],
    };
    const report = evaluateProductionQuality(project, timelineForProject(project));

    expect(report.exportAllowed).toBe(true);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'shot-fallback',
      severity: 'warning',
      message: expect.stringContaining('standalone-media'),
    }));
  });

  it('只有 footage placement 数据但没有对应时间线素材时不认定 standalone fallback', () => {
    const project = projectWithComposite(null, 'standalone-media');
    project.production!.footage = {
      placements: [{
        segmentIndex: 0,
        segmentId: 'seg-1',
        overlayId: 'footage-seg-1',
        startMs: 0,
        durationMs: 4_000,
        sourcePath: REQUIRED_ASSET.path,
        fileFingerprint: REQUIRED_FINGERPRINT,
        kind: 'video',
        trimStartMs: 0,
        score: REQUIRED_ASSET.score,
      }],
      compositionInputs: [],
      claimedSegmentIds: ['seg-1'],
      fallbacks: [],
    };

    const report = evaluateProductionQuality(project, createDefaultTimeline());

    expect(report.exportAllowed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'agent-composite-output-missing',
      severity: 'error',
    }));
  });

  it('block 策略下出现 Agent fallback 时阻止质量导出', () => {
    const card = motionCard({
      motionCard: {
        compiledAt: 1,
        prompt: 'test',
        retryCount: 0,
        productionReport: buildMotionCardProductionReport({
          renderOk: true,
          visualReviewAvailable: true,
          fallbackUsed: true,
        }),
      },
    });
    const project = projectWithComposite(card);
    const report = evaluateProductionQuality(project, timelineForProject(project));

    expect(report.exportAllowed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'shot-fallback',
      severity: 'error',
    }));
  });

  it('显式 motion fallback 不因缺少多模态审片再次阻断', () => {
    const card = motionCard({
      renderStrategy: 'motion-card',
      assetBindings: undefined,
      motionCard: {
        compiledAt: 1,
        prompt: 'test',
        retryCount: 0,
        productionReport: buildMotionCardProductionReport({
          renderOk: true,
          visualReviewAvailable: false,
          fallbackUsed: true,
        }),
      },
    });
    const project = projectWithComposite(card, 'motion');
    project.production!.footage = {
      placements: [],
      compositionInputs: [{
        segmentIndex: 0,
        segmentId: 'seg-1',
        startMs: 0,
        durationMs: 4_000,
        asset: REQUIRED_ASSET,
        usage: 'required',
        fileFingerprint: REQUIRED_FINGERPRINT,
      }],
      claimedSegmentIds: [],
      fallbacks: [],
    };
    const report = evaluateProductionQuality(
      project,
      timelineForProject(project),
      undefined,
      { currentByPath: new Map([[REQUIRED_ASSET.path, 'stat:changed']]) },
    );

    expect(report.exportAllowed).toBe(true);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'shot-fallback',
      severity: 'warning',
    }));
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'visual-review-unavailable',
      severity: 'warning',
    }));
    expect(report.issues.map((issue) => issue.code)).not.toContain('frozen-media-changed');
  });

  it('冻结组合素材在导出前被替换时阻止质量导出', () => {
    const project = projectWithComposite(motionCard());
    const report = evaluateProductionQuality(
      project,
      timelineForProject(project),
      undefined,
      { currentByPath: new Map([[REQUIRED_ASSET.path, 'stat:2048:999999']]) },
    );

    expect(report.exportAllowed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'frozen-media-changed',
      severity: 'error',
    }));
  });

  it('冻结组合素材已删除时阻止质量导出', () => {
    const project = projectWithComposite(motionCard());
    const report = evaluateProductionQuality(
      project,
      timelineForProject(project),
      undefined,
      { currentByPath: new Map([[REQUIRED_ASSET.path, null]]) },
    );

    expect(report.exportAllowed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'frozen-media-missing',
      severity: 'error',
    }));
  });

  it('旧组合产物缺少冻结指纹时要求重新制作', () => {
    const project = projectWithComposite(motionCard({
      assetBindings: [requiredBinding({ fileFingerprint: undefined })],
    }));
    const report = evaluateProductionQuality(project, timelineForProject(project));

    expect(report.exportAllowed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'frozen-media-fingerprint-missing',
      severity: 'error',
    }));
  });
});
