import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessFootageTrack } from '../electron/pipeline/director-headless-footage';
import { buildHeadlessDirectorTimeline } from '../electron/pipeline/director-headless-timeline';
import {
  runHeadlessCardsTrack,
  runHeadlessCoverTrack,
} from '../electron/pipeline/director-headless-visual-tracks';
import { readLocalFileFingerprint } from '../electron/footage/file-fingerprint';
import { loadProjectFile, saveProjectSection } from '../electron/project-file';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import { createDefaultProjectData } from '../src/lib/project-persistence';
import {
  DEFAULT_AI_CARDS_TRACK_ID,
  createDefaultTimeline,
  createVisualTrack,
} from '../src/types';
import { buildAICardTimelineDraft, DEFAULT_CARD_STYLE, type AICard } from '../src/types/ai';
import type { DirectorPlan } from '../src/types/director';
import type { AISettings } from '../src/types/ai';

const settings = {
  kacut: { enabled: true, baseUrl: 'http://127.0.0.1:8765' },
} as AISettings;

const readableFingerprint = async (filePath: string) => `fingerprint:${filePath}`;

function plan(): DirectorPlan {
  return {
    revision: 1,
    inputFingerprint: 'fingerprint',
    summary: '总结',
    keywords: [],
    segments: [{
      id: 'seg-1', title: '工厂', summary: '生产线', startMs: 1_000, endMs: 6_000,
      transcriptExcerpt: '工厂生产线正在运转。', semanticType: 'narration',
      complexityLevel: 'medium', visualizationScore: 70, pacingNeed: 'steady',
      keywords: [], entities: [], visualType: 'footage', footageQuery: '汽车 工厂 生产线',
      footageFallback: 'motion', enabled: true, purpose: 'context', carrier: 'footage', intensity: 2,
      composition: 'full-bleed', cameraMove: 'tracking', mediaRole: 'context', rationale: '真实场景',
    }],
    motionBible: {
      visualThesis: '真实素材与图形协同',
      rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
      carrierPlan: [],
      styleRules: { paletteUse: '系统色', typographyUse: '短标题' },
      transitionRules: { default: 'hard-cut', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '', composition: '' },
    audioDirection: { bgmStyle: '', energy: 2, soundDensity: 'balanced' },
    warnings: [], createdAt: 1, updatedAt: 1, approvedAt: 1,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('headless 导演素材轨', () => {
  it('先检索并认领素材，返回可供最终时间线原子合成的 placement', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0', id: 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify([{
              id: 'clip-1', filename: 'factory.mp4', path: '/library/factory.mp4',
              kind: 'video', score: 0.86, matchedSegmentStart: 12.5,
            }]) }],
          },
        }),
      } as Response;
    }));

    const result = await runHeadlessFootageTrack({
      production: createEmptyProductionState(),
      plan: plan(),
      settings,
      readFingerprint: readableFingerprint,
    });

    expect(result.claimedSegmentIds).toEqual(['seg-1']);
    expect(result.placements[0]).toMatchObject({
      sourcePath: '/library/factory.mp4',
      trimStartMs: 12_500,
      composition: 'full-bleed',
      cameraMove: 'tracking',
    });
  });

  it('人工选择直接采用，低分素材也不访问 KaCut 服务', async () => {
    const directorPlan = plan();
    directorPlan.segments[0].selectedFootage = {
      id: 'manual-clip', filename: 'chosen.mp4', path: '/library/chosen.mp4',
      kind: 'video', score: 0.18, matchedSegmentStart: 9.25,
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runHeadlessFootageTrack({
      production: createEmptyProductionState(),
      plan: directorPlan,
      settings: { ...settings, kacut: { enabled: false, baseUrl: settings.kacut!.baseUrl } },
      readFingerprint: readableFingerprint,
    });

    expect(result.ran).toBe(true);
    expect(result.claimedSegmentIds).toEqual(['seg-1']);
    expect(result.placements[0]).toMatchObject({
      sourcePath: '/library/chosen.mp4', score: 0.18, trimStartMs: 9_250,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('仅复用 output revision 与规范 provenance fingerprint 都匹配的素材产物', async () => {
    const directorPlan = plan();
    directorPlan.segments[0].selectedFootage = {
      id: 'persisted-clip', filename: 'material.mp4', path: '/library/material.mp4',
      kind: 'video', score: 0.9,
    };
    const base = createEmptyProductionState();
    const makeProduction = () => ({
      ...base,
      approvedPlan: directorPlan,
      outputs: {
        ...base.outputs,
        footage: { status: 'current' as const, directorRevision: 1, updatedAt: 10 },
      },
      footage: {
        placements: [{
          segmentIndex: 0, segmentId: 'seg-1', overlayId: 'footage-seg-1',
          startMs: 1_000, durationMs: 5_000, sourcePath: '/library/material.mp4',
          fileFingerprint: 'fingerprint:/library/material.mp4', kind: 'video' as const,
          trimStartMs: 0, score: 0.9,
        }],
        compositionInputs: [],
        claimedSegmentIds: ['seg-1'],
        fallbacks: [],
        generationProvenance: {
          directorRevision: 1,
          fingerprint: 'footage-fingerprint-1',
          generatedAt: 10,
        },
      },
    });

    const current = await runHeadlessFootageTrack({
      production: makeProduction(),
      plan: directorPlan,
      settings,
      readFingerprint: readableFingerprint,
    });
    expect(current).toMatchObject({ ran: false, reused: true });

    const wrongOutputRevision = makeProduction();
    wrongOutputRevision.outputs.footage.directorRevision = 2;
    const rerunForOutputRevision = await runHeadlessFootageTrack({
      production: wrongOutputRevision,
      plan: directorPlan,
      settings,
      readFingerprint: readableFingerprint,
    });
    expect(rerunForOutputRevision.reused).not.toBe(true);
    expect(rerunForOutputRevision.ran).toBe(true);

    const missingOutputRevision = makeProduction();
    delete (missingOutputRevision.outputs.footage as { directorRevision?: number }).directorRevision;
    const rerunForMissingOutputRevision = await runHeadlessFootageTrack({
      production: missingOutputRevision,
      plan: directorPlan,
      settings,
      readFingerprint: readableFingerprint,
    });
    expect(rerunForMissingOutputRevision.reused).not.toBe(true);
    expect(rerunForMissingOutputRevision.ran).toBe(true);

    const wrongFingerprint = makeProduction();
    wrongFingerprint.footage.generationProvenance.fingerprint = 'footage-other-source-1';
    const rerunForFingerprint = await runHeadlessFootageTrack({
      production: wrongFingerprint,
      plan: directorPlan,
      settings,
      readFingerprint: readableFingerprint,
    });
    expect(rerunForFingerprint.reused).not.toBe(true);
    expect(rerunForFingerprint.ran).toBe(true);

    const missingFingerprint = makeProduction();
    delete (missingFingerprint.footage.generationProvenance as { fingerprint?: string }).fingerprint;
    const rerunForMissingFingerprint = await runHeadlessFootageTrack({
      production: missingFingerprint,
      plan: directorPlan,
      settings,
      readFingerprint: readableFingerprint,
    });
    expect(rerunForMissingFingerprint.reused).not.toBe(true);
    expect(rerunForMissingFingerprint.ran).toBe(true);
  });

  it('standalone-media 的旧 optional-only 计划不作为人工目标强制上屏', async () => {
    const directorPlan = plan();
    const optional = {
      asset: {
        id: 'optional-clip', filename: 'optional.mp4', path: '/library/optional.mp4',
        kind: 'video' as const, score: 0.95,
      },
      usage: 'optional' as const,
    };
    directorPlan.segments[0].renderStrategy = 'standalone-media';
    directorPlan.segments[0].compositionAssets = [optional];
    directorPlan.segments[0].selectedFootage = optional.asset;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runHeadlessFootageTrack({
      production: createEmptyProductionState(),
      plan: directorPlan,
      settings: { ...settings, kacut: { enabled: false, baseUrl: settings.kacut!.baseUrl } },
      readFingerprint: readableFingerprint,
    });

    expect(result.placements).toEqual([]);
    expect(result.claimedSegmentIds).toEqual([]);
    expect(result.fallbacks).toEqual([{ segmentId: 'seg-1', visualType: 'motion' }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('standalone-media 已批准的 required 素材失效时阻止制作，不静默退回 Motion', async () => {
    const directorPlan = plan();
    const required = {
      asset: {
        id: 'required-clip', filename: 'required.mp4', path: '/library/missing.mp4',
        kind: 'video' as const, score: 0.9,
      },
      usage: 'required' as const,
    };
    directorPlan.segments[0].renderStrategy = 'standalone-media';
    directorPlan.segments[0].compositionAssets = [required];
    directorPlan.segments[0].selectedFootage = required.asset;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runHeadlessFootageTrack({
      production: createEmptyProductionState(),
      plan: directorPlan,
      settings: { ...settings, kacut: { enabled: false, baseUrl: settings.kacut!.baseUrl } },
      readFingerprint: async () => null,
    });

    expect(result.placements).toEqual([]);
    expect(result.fallbacks).toEqual([]);
    expect(result.blockedSegmentIds).toEqual(['seg-1']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('agent-composite 只产出 composition input，卡片保持未认领且时间线没有额外素材层', async () => {
    const directorPlan = plan();
    directorPlan.segments[0].renderStrategy = 'agent-composite';
    directorPlan.segments[0].fallbackPolicy = 'block';
    directorPlan.segments[0].compositionAssets = [{
      asset: {
        id: 'manual-clip', filename: 'chosen.mp4', path: '/library/chosen.mp4',
        kind: 'video', score: 0.18, matchedSegmentStart: 9.25,
      },
      usage: 'required',
      trimStartMs: 2_000,
    }];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runHeadlessFootageTrack({
      production: createEmptyProductionState(),
      plan: directorPlan,
      settings: { ...settings, kacut: { enabled: false, baseUrl: settings.kacut!.baseUrl } },
      readFingerprint: readableFingerprint,
    });

    expect(result.placements).toEqual([]);
    expect(result.claimedSegmentIds).toEqual([]);
    expect(result.compositionInputs).toEqual([expect.objectContaining({
      segmentId: 'seg-1', trimStartMs: 2_000,
      asset: expect.objectContaining({ id: 'manual-clip' }),
    })]);
    expect(fetchMock).not.toHaveBeenCalled();

    const timeline = buildHeadlessDirectorTimeline({
      current: createDefaultTimeline(),
      analysis: {
        segments: directorPlan.segments,
        cards: [card('seg-1')],
        coverPrompts: [], summary: '总结', keywords: [],
      },
      plan: directorPlan,
      highlights: [],
      audioPlacements: [],
      footagePlacements: result.placements,
    });
    expect(timeline.overlays.filter((overlay) => overlay.footageData)).toEqual([]);
    expect(timeline.overlays.filter((overlay) => overlay.aiCardData?.segmentId === 'seg-1')).toHaveLength(1);
  });

  it('连接失败时不中断其它制作轨，按导演 fallback 返回', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 }) as Response));
    const result = await runHeadlessFootageTrack({
      production: createEmptyProductionState(),
      plan: plan(),
      settings,
      readFingerprint: readableFingerprint,
    });
    expect(result).toMatchObject({
      unavailable: true,
      claimedSegmentIds: [],
      fallbacks: [{ segmentId: 'seg-1', visualType: 'motion' }],
    });
  });

  it('KaCut 关闭时仍把已决策的 fallback 标记为本轮有效素材产物', async () => {
    const result = await runHeadlessFootageTrack({
      production: createEmptyProductionState(),
      plan: plan(),
      settings: { ...settings, kacut: { enabled: false, baseUrl: settings.kacut!.baseUrl } },
      readFingerprint: readableFingerprint,
    });

    expect(result.ran).toBe(true);
    expect(result.fallbacks).toEqual([{ segmentId: 'seg-1', visualType: 'motion' }]);
  });

  it('单个素材检索失败时只降级该段，不丢弃其它已命中的真实素材', async () => {
    const directorPlan = plan();
    directorPlan.segments[0].footageQuery = '故障 查询';
    directorPlan.segments.push({
      ...directorPlan.segments[0],
      id: 'seg-2',
      title: '城市',
      startMs: 6_000,
      endMs: 10_000,
      footageQuery: '城市 夜景',
    });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      const body = JSON.parse(String(init?.body)) as {
        params?: { arguments?: { query?: string } };
      };
      if (body.params?.arguments?.query === '故障 查询') {
        return { ok: false, status: 500 } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0', id: 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify([{
              id: 'clip-2', filename: 'city.mp4', path: '/library/city.mp4',
              kind: 'video', score: 0.9,
            }]) }],
          },
        }),
      } as Response;
    }));

    const result = await runHeadlessFootageTrack({
      production: createEmptyProductionState(),
      plan: directorPlan,
      settings,
      readFingerprint: readableFingerprint,
    });

    expect(result.claimedSegmentIds).toEqual(['seg-2']);
    expect(result.placements).toEqual([expect.objectContaining({ segmentId: 'seg-2' })]);
    expect(result.fallbacks).toEqual([{ segmentId: 'seg-1', visualType: 'motion' }]);
  });

  it('在卡片轨启动前传入认领名单和失败退路，避免先生成再删除', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingji-headless-footage-'));
    const directorPlan = plan();
    const base = createEmptyProductionState();
    const production = {
      ...base,
      approvedPlan: directorPlan,
      workflow: { ...base.workflow, stage: 'production-running' as const, activeTaskId: 'task-1' },
      pendingImpact: {
        allCards: true, segmentIds: [], cover: false, audio: false,
        timeline: true, quality: true, reasons: ['initial-approval'],
      },
    };
    const project = createDefaultProjectData();
    project.production = production;
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
    const cards = vi.fn(async (ctx: { params?: Record<string, unknown> }) => ({
      segments: directorPlan.segments,
      cards: [card('seg-1')],
      coverPrompts: [], summary: directorPlan.summary, keywords: [],
    }));

    try {
      const result = await runHeadlessCardsTrack({
        ctx: {
          projectPath: dir,
          userDataPath: dir,
          params: { revision: 1 },
          handle: {
            taskId: 'task-1', signal: new AbortController().signal,
            update: vi.fn(), log: vi.fn(),
          },
        },
        production,
        cards: cards as never,
        footage: {
          ran: true,
          placements: [],
          claimedSegmentIds: ['seg-1'],
          fallbacks: [{ segmentId: 'seg-2', visualType: 'image' }],
        },
      });

      expect(cards.mock.calls[0]?.[0].params).toMatchObject({
        useApprovedPlan: true,
        claimedFootageSegmentIds: ['seg-1'],
        footageFallbacks: [{ segmentId: 'seg-2', visualType: 'image' }],
      });
      expect(result.analysis.cards).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('组合 Agent 失败时按 standalone-media 策略改为独立素材，不保留失败卡', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingji-headless-composite-fallback-'));
    const assetPath = join(dir, 'factory.mp4');
    writeFileSync(assetPath, 'approved-footage');
    const fileFingerprint = (await readLocalFileFingerprint(assetPath))!;
    const directorPlan = plan();
    directorPlan.segments[0].renderStrategy = 'agent-composite';
    directorPlan.segments[0].fallbackPolicy = 'standalone-media';
    const base = createEmptyProductionState();
    const production = {
      ...base,
      approvedPlan: directorPlan,
      workflow: { ...base.workflow, stage: 'production-running' as const, activeTaskId: 'task-1' },
      pendingImpact: {
        allCards: true, segmentIds: [], cover: false, audio: false,
        timeline: true, quality: true, reasons: ['initial-approval'],
      },
    };
    const project = createDefaultProjectData();
    project.production = production;
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
    const cards = vi.fn(async () => ({
      segments: directorPlan.segments,
      cards: [card('seg-1')],
      cardErrors: [{
        segmentId: 'seg-1', segmentTitle: '工厂', segmentIndex: 0,
        totalSegments: 1, message: 'Agent 合成失败',
      }],
      coverPrompts: [], summary: directorPlan.summary, keywords: [],
    }));
    const footage = {
      ran: true,
      placements: [],
      claimedSegmentIds: [],
      fallbacks: [],
      compositionInputs: [{
        segmentIndex: 0, segmentId: 'seg-1', startMs: 1_000, durationMs: 5_000,
        usage: 'required' as const, trimStartMs: 2_000, fileFingerprint,
        asset: {
          id: 'clip-1', filename: 'factory.mp4', path: assetPath,
          kind: 'video' as const, score: 0.9,
        },
      }],
    };

    try {
      const result = await runHeadlessCardsTrack({
        ctx: {
          projectPath: dir,
          userDataPath: dir,
          handle: {
            taskId: 'task-1', signal: new AbortController().signal,
            update: vi.fn(), log: vi.fn(),
          },
        },
        production,
        cards: cards as never,
        footage,
      });

      expect(result.error).toBeUndefined();
      expect(result.analysis.cardErrors).toBeUndefined();
      expect(result.analysis.cards).toEqual([]);
      expect(footage.claimedSegmentIds).toEqual(['seg-1']);
      expect(footage.placements).toEqual([expect.objectContaining({
        segmentId: 'seg-1', sourcePath: assetPath, fileFingerprint, trimStartMs: 2_000,
      })]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('standalone-media fallback 不会用已替换的同路径素材清除卡片错误', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingji-headless-composite-stale-'));
    const assetPath = join(dir, 'factory.mp4');
    writeFileSync(assetPath, 'approved-footage');
    const fileFingerprint = (await readLocalFileFingerprint(assetPath))!;
    writeFileSync(assetPath, 'replacement-footage-with-different-size');
    const directorPlan = plan();
    directorPlan.segments[0].renderStrategy = 'agent-composite';
    directorPlan.segments[0].fallbackPolicy = 'standalone-media';
    const base = createEmptyProductionState();
    const production = {
      ...base,
      approvedPlan: directorPlan,
      pendingImpact: {
        allCards: true, segmentIds: [], cover: false, audio: false,
        timeline: true, quality: true, reasons: ['initial-approval'],
      },
    };
    const project = createDefaultProjectData();
    project.production = production;
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
    const cards = vi.fn(async () => ({
      segments: directorPlan.segments,
      cards: [card('seg-1')],
      cardErrors: [{
        segmentId: 'seg-1', segmentTitle: '工厂', segmentIndex: 0,
        totalSegments: 1, message: 'Agent 合成失败',
      }],
      coverPrompts: [], summary: directorPlan.summary, keywords: [],
    }));
    const footage = {
      ran: true,
      placements: [],
      claimedSegmentIds: [],
      fallbacks: [],
      compositionInputs: [{
        segmentIndex: 0, segmentId: 'seg-1', startMs: 1_000, durationMs: 5_000,
        usage: 'required' as const, trimStartMs: 2_000, fileFingerprint,
        asset: {
          id: 'clip-1', filename: 'factory.mp4', path: assetPath,
          kind: 'video' as const, score: 0.9,
        },
      }],
    };

    try {
      const result = await runHeadlessCardsTrack({
        ctx: {
          projectPath: dir,
          userDataPath: dir,
          handle: {
            taskId: 'task-1', signal: new AbortController().signal,
            update: vi.fn(), log: vi.fn(),
          },
        },
        production,
        cards: cards as never,
        footage,
      });

      expect(result.error).toBe('1 个镜头生成失败');
      expect(result.analysis.cardErrors).toHaveLength(1);
      expect(footage.claimedSegmentIds).toEqual([]);
      expect(footage.placements).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('卡片轨复用旧产物时也会持久化移除已被素材认领的旧卡', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingji-headless-footage-reuse-'));
    const directorPlan = plan();
    const base = createEmptyProductionState();
    const production = {
      ...base,
      approvedPlan: directorPlan,
      workflow: { ...base.workflow, stage: 'production-running' as const, activeTaskId: 'task-1' },
      outputs: {
        ...base.outputs,
        cards: { status: 'current' as const, directorRevision: 1, updatedAt: 100 },
      },
    };
    const project = createDefaultProjectData();
    project.production = production;
    project.aiAnalysis = {
      analysisResult: {
        segments: directorPlan.segments,
        cards: [card('seg-1')],
        coverPrompts: [], summary: directorPlan.summary, keywords: [],
      },
      coverCandidates: [],
    };
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
    const cards = vi.fn();

    try {
      const result = await runHeadlessCardsTrack({
        ctx: {
          projectPath: dir,
          userDataPath: dir,
          handle: {
            taskId: 'task-1', signal: new AbortController().signal,
            update: vi.fn(), log: vi.fn(),
          },
        },
        production,
        cards: cards as never,
        footage: {
          ran: true,
          placements: [],
          claimedSegmentIds: ['seg-1'],
          fallbacks: [],
        },
      });

      expect(cards).not.toHaveBeenCalled();
      expect(result.analysis.cards).toEqual([]);
      const saved = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf-8'));
      expect(saved.aiAnalysis.analysisResult.cards).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('封面生成结束前任务被取消时不覆盖现有封面', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingji-headless-cover-cancel-'));
    const directorPlan = plan();
    const base = createEmptyProductionState();
    const production = {
      ...base,
      approvedPlan: directorPlan,
      workflow: { ...base.workflow, stage: 'production-running' as const, activeTaskId: 'task-old' },
    };
    const project = createDefaultProjectData();
    project.production = production;
    project.aiAnalysis = {
      analysisResult: {
        segments: directorPlan.segments,
        cards: [], coverPrompts: ['现有提示词'], summary: directorPlan.summary, keywords: [],
      },
      coverCandidates: [{
        id: 'cover-existing', prompt: '现有提示词', imageUrl: '/covers/existing.png', selected: true,
      }],
    };
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project));

    try {
      const result = await runHeadlessCoverTrack({
        ctx: {
          projectPath: dir,
          userDataPath: dir,
          handle: {
            taskId: 'task-old', signal: new AbortController().signal,
            update: vi.fn(), log: vi.fn(),
          },
        },
        production,
        entries: [],
        settings,
        analysis: project.aiAnalysis.analysisResult!,
        covers: vi.fn(async () => {
          const latest = await loadProjectFile(dir);
          await saveProjectSection(dir, 'production', {
            ...latest.production!,
            workflow: { ...latest.production!.workflow, stage: 'production-paused', activeTaskId: undefined },
          });
          return {
            prompts: ['旧任务新提示词'],
            candidates: [{
              id: 'cover-stale', prompt: '旧任务新提示词', imageUrl: '/covers/stale.png', selected: true,
            }],
          };
        }) as never,
        // 故意不做锁外预检，直接验证 saveProjectSection 写锁内的 task guard。
        assertActive: async () => {},
      });

      expect(result.error).toContain('制作任务已变化');
      const saved = await loadProjectFile(dir);
      expect(saved.production?.workflow.stage).toBe('production-paused');
      expect(saved.aiAnalysis.coverCandidates.map((candidate) => candidate.id)).toEqual(['cover-existing']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function card(segmentId: string): AICard {
  return {
    id: `card-${segmentId}`,
    segmentId,
    type: 'motion',
    title: segmentId,
    content: '内容',
    startMs: segmentId === 'seg-1' ? 1_000 : 6_000,
    endMs: segmentId === 'seg-1' ? 6_000 : 10_000,
    displayDurationMs: 4_000,
    displayMode: 'fullscreen',
    template: 'default',
    enabled: true,
    style: DEFAULT_CARD_STYLE.motion,
  };
}

describe('headless 导演时间线合成', () => {
  it('一次提交替换旧素材，并确保认领段不会同时保留卡片', () => {
    const timeline = createDefaultTimeline();
    timeline.tracks.push(createVisualTrack(2, 2));
    const claimedCard = card('seg-1');
    const claimedDraft = buildAICardTimelineDraft(claimedCard);
    timeline.overlays.push(
      {
        id: 'old-footage', type: 'video', assetPath: '/library/old.mp4',
        trackId: DEFAULT_AI_CARDS_TRACK_ID, startMs: 0, durationMs: 1_000,
        position: { x: 0, y: 0, width: 1920, height: 1080 },
        overlayType: 'media', footageData: { segmentId: 'old-seg', score: 0.8 },
      },
      {
        id: 'old-claimed-card', type: 'image', assetPath: '',
        trackId: DEFAULT_AI_CARDS_TRACK_ID,
        startMs: claimedDraft.startMs, durationMs: claimedDraft.durationMs,
        position: { x: 0, y: 0, width: 1920, height: 1080 },
        overlayType: 'ai-card', aiCardData: claimedDraft.aiCardData,
      },
    );

    const result = buildHeadlessDirectorTimeline({
      current: timeline,
      analysis: {
        segments: plan().segments,
        cards: [card('seg-2')],
        coverPrompts: [], summary: '总结', keywords: [],
      },
      plan: plan(),
      highlights: [],
      audioPlacements: [],
      footagePlacements: [{
        segmentIndex: 0,
        segmentId: 'seg-1',
        overlayId: 'new-footage',
        startMs: 1_000,
        durationMs: 5_000,
        sourcePath: '/library/new.mp4',
        kind: 'video',
        trimStartMs: 2_000,
        score: 0.9,
        composition: 'full-bleed',
        cameraMove: 'tracking',
        mediaRole: 'context',
      }],
    });

    expect(result.overlays.some((overlay) => overlay.id === 'old-footage')).toBe(false);
    expect(result.overlays).toContainEqual(expect.objectContaining({
      id: 'new-footage',
      trackId: DEFAULT_AI_CARDS_TRACK_ID,
      footageData: expect.objectContaining({ segmentId: 'seg-1', cameraMove: 'tracking' }),
    }));
    expect(result.overlays.filter((overlay) => overlay.aiCardData?.segmentId === 'seg-1')).toEqual([]);
    expect(result.overlays.filter((overlay) => overlay.aiCardData?.segmentId === 'seg-2')).toHaveLength(1);
  });
});
