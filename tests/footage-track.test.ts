import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateFootageTrack } from '../src/lib/director-production-tracks';
import { decideFootageMatch } from '../src/lib/footage-match';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import { buildDefaultAISettings } from '../src/store/ai';
import type { DirectorPlan, DirectorSegmentPlan, ProjectProductionState } from '../src/types/director';
import type { DirectorProductionClientOptions } from '../src/lib/director-production-client';
import type { AutoRunTelemetry } from '../src/lib/telemetry/auto-run';
import type { KacutClip } from '../src/types/footage';

const BASE_URL = 'http://127.0.0.1:8765';

function footageSegment(
  id: string,
  overrides: Partial<DirectorSegmentPlan> = {},
): DirectorSegmentPlan {
  return {
    id,
    title: id,
    summary: id,
    startMs: 0,
    endMs: 5_000,
    semanticType: 'narration',
    complexityLevel: 'medium',
    visualizationScore: 50,
    pacingNeed: 'steady',
    keywords: [],
    entities: [],
    enabled: true,
    purpose: 'explain',
    carrier: 'concept',
    intensity: 2,
    rationale: '',
    visualType: 'footage',
    footageQuery: '城市 夜景',
    ...overrides,
  } as DirectorSegmentPlan;
}

function plan(segments: DirectorSegmentPlan[], revision = 3): DirectorPlan {
  return { revision, approvedAt: 100, inputFingerprint: 'x', segments } as unknown as DirectorPlan;
}

function production(overrides: Partial<ProjectProductionState> = {}): ProjectProductionState {
  return { ...createEmptyProductionState(100), ...overrides };
}

function options(
  segments: DirectorSegmentPlan[],
  prodOverrides: Partial<ProjectProductionState> = {},
): { options: DirectorProductionClientOptions; plan: DirectorPlan } {
  const thePlan = plan(segments);
  const settings = { ...buildDefaultAISettings(), kacut: { enabled: true, baseUrl: BASE_URL } };
  return {
    plan: thePlan,
    options: {
      projectDir: '/tmp/project',
      production: production({ approvedPlan: thePlan, ...prodOverrides }),
      entries: [],
      settings,
      taskId: 'task-1',
    },
  };
}

function clip(score: number, kind: 'video' | 'image' = 'video', extra: Partial<KacutClip> = {}): KacutClip {
  return {
    id: `clip-${score}`,
    filename: 'material.mp4',
    path: '/library/material.mp4',
    kind,
    score,
    ...extra,
  };
}

function telemetry() {
  const events: Array<{ kind: string; extra?: Record<string, unknown> }> = [];
  const tel: AutoRunTelemetry = {
    runId: 'test-run',
    event: (kind, extra) => {
      events.push({ kind, extra });
    },
    stage: async (_name, fn) => fn(),
    timer: () => () => undefined,
  };
  return { tel, events };
}

function stubKacutRpc(handlers: {
  health?: () => Promise<boolean>;
  search?: (args: { baseUrl: string; query: string; kind?: string; limit?: number }) => Promise<KacutClip[]>;
  fingerprint?: (args: { filePath: string; baseDir?: string }) => Promise<string | null>;
}) {
  const kacutHealth = vi.fn(handlers.health ?? (async () => true));
  const kacutSearchClips = vi.fn(
    handlers.search ?? (async () => []),
  );
  const getLocalFileFingerprint = vi.fn(
    handlers.fingerprint ?? (async ({ filePath }) => `fingerprint:${filePath}`),
  );
  vi.stubGlobal('window', {
    electronAPI: { kacutHealth, kacutSearchClips, getLocalFileFingerprint },
  });
  return { kacutHealth, kacutSearchClips, getLocalFileFingerprint };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decideFootageMatch 决策矩阵', () => {
  it('≥0.7 adopt；其余分数与无结果都严格按导演 fallback 降级', () => {
    expect(decideFootageMatch(0.75)).toEqual({ decision: 'adopt', cardVisualType: null });
    expect(decideFootageMatch(0.7)).toEqual({ decision: 'adopt', cardVisualType: null });
    expect(decideFootageMatch(0.5, 'image')).toEqual({ decision: 'fallback-image', cardVisualType: 'image' });
    expect(decideFootageMatch(0.5, 'motion')).toEqual({ decision: 'fallback-motion', cardVisualType: 'motion' });
    expect(decideFootageMatch(0.4)).toEqual({ decision: 'fallback-motion', cardVisualType: 'motion' });
    expect(decideFootageMatch(0.2, 'image')).toEqual({ decision: 'fallback-image', cardVisualType: 'image' });
    expect(decideFootageMatch(null, 'image')).toEqual({ decision: 'none', cardVisualType: 'image' });
  });
});

describe('generateFootageTrack 决策矩阵', () => {
  it('0.75 → adopt：产出 placement（含 matchedSegmentStart 换算的 trimStartMs）并认领该段', async () => {
    const segments = [
      footageSegment('seg-1'),
      footageSegment('seg-2', { startMs: 5_000, endMs: 10_000 }),
    ];
    const { options: opts, plan: thePlan } = options(segments);
    const rpc = stubKacutRpc({
      search: async () => [clip(0.75, 'video', { matchedSegmentStart: 3.2 }), clip(0.5)],
    });
    const { tel, events } = telemetry();

    const result = await generateFootageTrack(opts, thePlan, tel);

    expect(result.ran).toBe(true);
    expect(result.claimedSegmentIds).toEqual(['seg-1', 'seg-2']);
    expect(result.fallbacks).toEqual([]);
    expect(result.placements).toHaveLength(2);
    const first = result.placements[0];
    expect(first).toMatchObject({
      segmentId: 'seg-1',
      overlayId: 'footage-seg-1',
      startMs: 0,
      durationMs: 5_000,
      sourcePath: '/library/material.mp4',
      kind: 'video',
      trimStartMs: 3_200,
      score: 0.75,
    });
    // video 命中后不再尝试 image
    expect(rpc.kacutSearchClips.mock.calls.every(([args]) => args.kind === 'video')).toBe(true);
    const matchEvents = events.filter((event) => event.kind === 'footage.match');
    expect(matchEvents).toHaveLength(2);
    expect(matchEvents[0].extra).toMatchObject({ segmentId: 'seg-1', topScore: 0.75, decision: 'adopt' });
    expect(events.some((event) => event.kind === 'stage.start' && event.extra?.stage === 'footage')).toBe(true);
    expect(events.some((event) => event.kind === 'stage.end' && event.extra?.stage === 'footage')).toBe(true);
  });

  it('人工选择直接采用：低于自动阈值也不再健康检查或重新检索', async () => {
    const segments = [footageSegment('seg-1', {
      selectedFootage: {
        id: 'manual-1', filename: 'manual.mp4', path: '/library/manual.mp4',
        kind: 'video', score: 0.2, durationSec: 20, matchedSegmentStart: 6.4,
        thumbnailFile: '/library/manual-thumb.jpg',
      },
    })];
    const { options: opts, plan: thePlan } = options(segments);
    opts.settings.kacut = { enabled: false, baseUrl: BASE_URL };
    const rpc = stubKacutRpc({ search: async () => [clip(0.99)] });
    const { tel, events } = telemetry();

    const result = await generateFootageTrack(opts, thePlan, tel);

    expect(result.ran).toBe(true);
    expect(result.claimedSegmentIds).toEqual(['seg-1']);
    expect(result.fallbacks).toEqual([]);
    expect(result.placements[0]).toMatchObject({
      sourcePath: '/library/manual.mp4', kind: 'video', score: 0.2, trimStartMs: 6_400,
    });
    expect(rpc.kacutHealth).not.toHaveBeenCalled();
    expect(rpc.kacutSearchClips).not.toHaveBeenCalled();
    expect(events.find((event) => event.kind === 'footage.match')?.extra).toMatchObject({
      segmentId: 'seg-1', decision: 'adopt', manuallySelected: true, assetId: 'manual-1',
    });
  });

  it('standalone-media 的旧 optional-only 计划不作为人工目标强制上屏', async () => {
    const optional = {
      asset: {
        id: 'optional-1', filename: 'optional.mp4', path: '/library/optional.mp4',
        kind: 'video' as const, score: 0.95,
      },
      usage: 'optional' as const,
    };
    const segments = [footageSegment('seg-1', {
      renderStrategy: 'standalone-media',
      compositionAssets: [optional],
      selectedFootage: optional.asset,
      footageFallback: 'motion',
    })];
    const { options: opts, plan: thePlan } = options(segments);
    opts.settings.kacut = { enabled: false, baseUrl: BASE_URL };
    const rpc = stubKacutRpc({});

    const result = await generateFootageTrack(opts, thePlan, null);

    expect(result.placements).toEqual([]);
    expect(result.claimedSegmentIds).toEqual([]);
    expect(result.fallbacks).toEqual([{ segmentId: 'seg-1', visualType: 'motion' }]);
    expect(rpc.getLocalFileFingerprint).not.toHaveBeenCalled();
  });

  it('standalone-media 已批准的 required 素材失效时阻止制作，不静默退回 Motion', async () => {
    const required = {
      asset: {
        id: 'required-1', filename: 'required.mp4', path: '/library/missing.mp4',
        kind: 'video' as const, score: 0.9,
      },
      usage: 'required' as const,
    };
    const { options: opts, plan: thePlan } = options([footageSegment('seg-1', {
      renderStrategy: 'standalone-media',
      compositionAssets: [required],
      selectedFootage: required.asset,
    })]);
    opts.settings.kacut = { enabled: false, baseUrl: BASE_URL };
    stubKacutRpc({ fingerprint: async () => null });

    const result = await generateFootageTrack(opts, thePlan, null);

    expect(result.placements).toEqual([]);
    expect(result.fallbacks).toEqual([]);
    expect(result.blockedSegmentIds).toEqual(['seg-1']);
  });

  it('agent-composite 把锁定素材交给卡片 Agent，不认领卡片也不生成独立素材 overlay', async () => {
    const segments = [footageSegment('seg-1', {
      renderStrategy: 'agent-composite',
      fallbackPolicy: 'block',
      compositionAssets: [{
        asset: {
          id: 'manual-1', filename: 'manual.mp4', path: '/library/manual.mp4',
          kind: 'video', score: 0.2, matchedSegmentStart: 6.4,
        },
        usage: 'required',
        trimStartMs: 1_250,
      }],
    })];
    const { options: opts, plan: thePlan } = options(segments);
    opts.settings.kacut = { enabled: false, baseUrl: BASE_URL };
    const rpc = stubKacutRpc({});

    const result = await generateFootageTrack(opts, thePlan, null);

    expect(result.placements).toEqual([]);
    expect(result.claimedSegmentIds).toEqual([]);
    expect(result.compositionInputs).toEqual([expect.objectContaining({
      segmentId: 'seg-1',
      usage: 'required',
      trimStartMs: 1_250,
      asset: expect.objectContaining({ id: 'manual-1', path: '/library/manual.mp4' }),
    })]);
    expect(result.blockedSegmentIds).toEqual([]);
    expect(rpc.kacutHealth).not.toHaveBeenCalled();
    expect(rpc.kacutSearchClips).not.toHaveBeenCalled();
  });

  it('agent-composite 缺素材时默认 block，不静默退成纯 Motion', async () => {
    const segments = [footageSegment('seg-1', {
      renderStrategy: 'agent-composite',
      fallbackPolicy: undefined,
      selectedFootage: undefined,
      compositionAssets: [],
    })];
    const { options: opts, plan: thePlan } = options(segments);
    opts.settings.kacut = { enabled: false, baseUrl: BASE_URL };
    stubKacutRpc({});

    const result = await generateFootageTrack(opts, thePlan, null);

    expect(result.fallbacks).toEqual([]);
    expect(result.blockedSegmentIds).toEqual(['seg-1']);
    expect(result.claimedSegmentIds).toEqual([]);
  });

  it('0.5 → 按 footageFallback 降级（image 走 image 卡，motion 走 motion 卡）', async () => {
    const segments = [
      footageSegment('seg-1', { footageFallback: 'image' }),
      footageSegment('seg-2', { footageFallback: 'motion', startMs: 5_000, endMs: 10_000 }),
    ];
    const { options: opts, plan: thePlan } = options(segments);
    stubKacutRpc({ search: async () => [clip(0.5)] });
    const { tel, events } = telemetry();

    const result = await generateFootageTrack(opts, thePlan, tel);

    expect(result.claimedSegmentIds).toEqual([]);
    expect(result.placements).toEqual([]);
    expect(result.fallbacks).toEqual([
      { segmentId: 'seg-1', visualType: 'image' },
      { segmentId: 'seg-2', visualType: 'motion' },
    ]);
    const decisions = events
      .filter((event) => event.kind === 'footage.match')
      .map((event) => event.extra?.decision);
    expect(decisions).toEqual(['fallback-image', 'fallback-motion']);
  });

  it('0.2 → fallback-motion；无结果 → none（退 motion）', async () => {
    const segments = [
      footageSegment('seg-1'),
      footageSegment('seg-2', { startMs: 5_000, endMs: 10_000, footageQuery: '不存在的场景' }),
    ];
    const { options: opts, plan: thePlan } = options(segments);
    const rpc = stubKacutRpc({
      search: async (args) => (args.query.includes('城市') ? [clip(0.2)] : []),
    });
    const { tel, events } = telemetry();

    const result = await generateFootageTrack(opts, thePlan, tel);

    expect(result.fallbacks).toEqual([
      { segmentId: 'seg-1', visualType: 'motion' },
      { segmentId: 'seg-2', visualType: 'motion' },
    ]);
    const decisions = events
      .filter((event) => event.kind === 'footage.match')
      .map((event) => event.extra?.decision);
    expect(decisions).toEqual(['fallback-motion', 'none']);
    // 无命中的段 video 空结果后尝试了 image
    const kinds = rpc.kacutSearchClips.mock.calls.map(([args]) => args.kind);
    expect(kinds).toContain('image');
  });

  it('video 无命中再试 image：image 高分可 adopt，trimStartMs 恒 0', async () => {
    const segments = [footageSegment('seg-1')];
    const { options: opts, plan: thePlan } = options(segments);
    stubKacutRpc({
      search: async (args) =>
        args.kind === 'image' ? [clip(0.9, 'image', { path: '/library/photo.png' })] : [],
    });
    const { tel } = telemetry();

    const result = await generateFootageTrack(opts, thePlan, tel);

    expect(result.claimedSegmentIds).toEqual(['seg-1']);
    expect(result.placements[0]).toMatchObject({ kind: 'image', trimStartMs: 0, sourcePath: '/library/photo.png' });
  });

  it('KaCut 不可用：记一次 kacut.unavailable 后整轨跳过，全部段退 motion', async () => {
    const segments = [
      footageSegment('seg-1'),
      footageSegment('seg-2', { startMs: 5_000, endMs: 10_000 }),
    ];
    const { options: opts, plan: thePlan } = options(segments);
    const rpc = stubKacutRpc({ health: async () => Promise.reject(new Error('kacut 连接被拒')) });
    const { tel, events } = telemetry();

    const result = await generateFootageTrack(opts, thePlan, tel);

    expect(result.unavailable).toBe(true);
    expect(result.error).toContain('kacut');
    expect(result.claimedSegmentIds).toEqual([]);
    expect(result.fallbacks).toEqual([
      { segmentId: 'seg-1', visualType: 'motion' },
      { segmentId: 'seg-2', visualType: 'motion' },
    ]);
    const unavailableEvents = events.filter((event) => event.kind === 'kacut.unavailable');
    expect(unavailableEvents).toHaveLength(1);
    expect(unavailableEvents[0]).not.toHaveProperty('baseUrl');
    expect(rpc.kacutSearchClips).not.toHaveBeenCalled();
  });

  it('kacut 设置关闭：不检索，全部段按 footageFallback 退回出卡', async () => {
    const segments = [footageSegment('seg-1', { footageFallback: 'image' })];
    const { options: opts, plan: thePlan } = options(segments);
    opts.settings.kacut = { enabled: false, baseUrl: BASE_URL };
    const rpc = stubKacutRpc({});

    const result = await generateFootageTrack(opts, thePlan, null);

    expect(result.ran).toBe(true);
    expect(result.fallbacks).toEqual([{ segmentId: 'seg-1', visualType: 'image' }]);
    expect(rpc.kacutHealth).not.toHaveBeenCalled();
  });

  it('无 footage 段 / legacy 保护：直接返回空结果', async () => {
    const motion = footageSegment('seg-1', { visualType: 'motion', footageQuery: undefined });
    const { options: opts, plan: thePlan } = options([motion]);
    const rpc = stubKacutRpc({});
    const { tel, events } = telemetry();

    const empty = await generateFootageTrack(opts, thePlan, tel);
    expect(empty).toMatchObject({ ran: false, placements: [], claimedSegmentIds: [], fallbacks: [] });

    const legacy = await generateFootageTrack(
      { ...opts, production: production({ approvedPlan: thePlan, legacyProtected: true }) },
      plan([footageSegment('seg-1')]),
      tel,
    );
    expect(legacy.ran).toBe(false);
    expect(rpc.kacutHealth).not.toHaveBeenCalled();
    expect(events.filter((event) => event.kind === 'stage.start')).toHaveLength(0);
  });

  it('产物 current 且 revision 匹配、无卡片 impact：整份复用，不重新检索', async () => {
    const segments = [footageSegment('seg-1')];
    const thePlan = plan(segments);
    const persisted = {
      placements: [{
        segmentIndex: 0,
        segmentId: 'seg-1',
        overlayId: 'footage-seg-1',
        startMs: 0,
        durationMs: 5_000,
        sourcePath: '/library/old.mp4',
        fileFingerprint: 'fingerprint:/library/old.mp4',
        kind: 'video' as const,
        trimStartMs: 100,
        score: 0.9,
      }],
      claimedSegmentIds: ['seg-1'],
      fallbacks: [],
      generationProvenance: {
        directorRevision: 3,
        fingerprint: 'footage-x-3',
        generatedAt: 50,
        modifiedByUser: false,
      },
    };
    const prod = production({
      approvedPlan: thePlan,
      footage: persisted,
      pendingImpact: null,
    });
    prod.outputs.footage = { status: 'current', directorRevision: 3, updatedAt: 60 };
    const opts: DirectorProductionClientOptions = {
      projectDir: '/tmp/project',
      production: prod,
      entries: [],
      settings: { ...buildDefaultAISettings(), kacut: { enabled: true, baseUrl: BASE_URL } },
      taskId: 'task-1',
    };
    const rpc = stubKacutRpc({});

    const result = await generateFootageTrack(opts, thePlan, null);

    expect(result.reused).toBe(true);
    expect(result.placements).toEqual(persisted.placements);
    expect(result.claimedSegmentIds).toEqual(['seg-1']);
    expect(rpc.kacutHealth).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'output revision 错误',
      mutate: (prod: ProjectProductionState) => {
        prod.outputs.footage.directorRevision = 2;
      },
    },
    {
      label: 'output revision 缺失',
      mutate: (prod: ProjectProductionState) => {
        delete (prod.outputs.footage as { directorRevision?: number }).directorRevision;
      },
    },
    {
      label: 'provenance fingerprint 错误',
      mutate: (prod: ProjectProductionState) => {
        prod.footage!.generationProvenance!.fingerprint = 'footage-other-source-3';
      },
    },
    {
      label: 'provenance fingerprint 缺失',
      mutate: (prod: ProjectProductionState) => {
        delete (prod.footage!.generationProvenance as { fingerprint?: string }).fingerprint;
      },
    },
  ])('$label 时拒绝复用并重新检索', async ({ mutate }) => {
    const segments = [footageSegment('seg-1')];
    const thePlan = plan(segments);
    const prod = production({
      approvedPlan: thePlan,
      footage: {
        placements: [{
          segmentIndex: 0,
          segmentId: 'seg-1',
          overlayId: 'footage-seg-1',
          startMs: 0,
          durationMs: 5_000,
          sourcePath: '/library/old.mp4',
          fileFingerprint: 'fingerprint:/library/old.mp4',
          kind: 'video',
          trimStartMs: 100,
          score: 0.9,
        }],
        claimedSegmentIds: ['seg-1'],
        fallbacks: [],
        generationProvenance: {
          directorRevision: 3,
          fingerprint: 'footage-x-3',
          generatedAt: 50,
          modifiedByUser: false,
        },
      },
      pendingImpact: null,
    });
    prod.outputs.footage = { status: 'current', directorRevision: 3, updatedAt: 60 };
    mutate(prod);
    const opts: DirectorProductionClientOptions = {
      projectDir: '/tmp/project',
      production: prod,
      entries: [],
      settings: { ...buildDefaultAISettings(), kacut: { enabled: true, baseUrl: BASE_URL } },
      taskId: 'task-1',
    };
    const rpc = stubKacutRpc({ search: async () => [clip(0.8)] });

    const result = await generateFootageTrack(opts, thePlan, null);

    expect(result.reused).toBeUndefined();
    expect(result.placements[0]).toMatchObject({
      sourcePath: '/library/material.mp4',
      fileFingerprint: 'fingerprint:/library/material.mp4',
    });
    expect(rpc.kacutHealth).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: '旧产物没有指纹', frozen: undefined, current: 'fingerprint:/library/old.mp4' },
    { label: '同路径文件已被替换', frozen: 'fingerprint:/library/old.mp4', current: 'fingerprint:/library/old.mp4:changed' },
    { label: '源文件已删除', frozen: 'fingerprint:/library/old.mp4', current: null },
  ])('$label 时拒绝复用并重新检索', async ({ frozen, current }) => {
    const segments = [footageSegment('seg-1')];
    const thePlan = plan(segments);
    const persistedPlacement = {
      segmentIndex: 0,
      segmentId: 'seg-1',
      overlayId: 'footage-seg-1',
      startMs: 0,
      durationMs: 5_000,
      sourcePath: '/library/old.mp4',
      ...(frozen ? { fileFingerprint: frozen } : {}),
      kind: 'video' as const,
      trimStartMs: 100,
      score: 0.9,
    };
    const prod = production({
      approvedPlan: thePlan,
      footage: {
        placements: [persistedPlacement],
        claimedSegmentIds: ['seg-1'],
        fallbacks: [],
        generationProvenance: {
          directorRevision: 3,
          fingerprint: 'footage-x-3',
          generatedAt: 50,
          modifiedByUser: false,
        },
      },
      pendingImpact: null,
    });
    prod.outputs.footage = { status: 'current', directorRevision: 3, updatedAt: 60 };
    const opts: DirectorProductionClientOptions = {
      projectDir: '/tmp/project',
      production: prod,
      entries: [],
      settings: { ...buildDefaultAISettings(), kacut: { enabled: true, baseUrl: BASE_URL } },
      taskId: 'task-1',
    };
    const rpc = stubKacutRpc({
      search: async () => [clip(0.8)],
      fingerprint: async ({ filePath }) => (
        filePath === '/library/old.mp4' ? current : `fingerprint:${filePath}`
      ),
    });

    const result = await generateFootageTrack(opts, thePlan, null);

    expect(result.reused).toBeUndefined();
    expect(result.claimedSegmentIds).toEqual(['seg-1']);
    expect(result.placements[0]).toMatchObject({
      sourcePath: '/library/material.mp4',
      fileFingerprint: 'fingerprint:/library/material.mp4',
    });
    expect(rpc.kacutHealth).toHaveBeenCalledTimes(1);
  });

  it('有卡片级 impact 时忽略持久化产物，重新检索', async () => {
    const segments = [footageSegment('seg-1')];
    const thePlan = plan(segments);
    const prod = production({
      approvedPlan: thePlan,
      footage: {
        placements: [],
        claimedSegmentIds: ['seg-1'],
        fallbacks: [],
        generationProvenance: {
          directorRevision: 3, fingerprint: 'f', generatedAt: 50, modifiedByUser: false,
        },
      },
      pendingImpact: {
        allCards: true, segmentIds: [], cover: false, audio: false, timeline: true, quality: true, reasons: [],
      },
    });
    prod.outputs.footage = { status: 'current', directorRevision: 3, updatedAt: 60 };
    const opts: DirectorProductionClientOptions = {
      projectDir: '/tmp/project',
      production: prod,
      entries: [],
      settings: { ...buildDefaultAISettings(), kacut: { enabled: true, baseUrl: BASE_URL } },
      taskId: 'task-1',
    };
    const rpc = stubKacutRpc({ search: async () => [clip(0.8)] });

    const result = await generateFootageTrack(opts, thePlan, null);

    expect(result.reused).toBeUndefined();
    expect(result.ran).toBe(true);
    expect(rpc.kacutHealth).toHaveBeenCalled();
    expect(result.claimedSegmentIds).toEqual(['seg-1']);
  });
});
