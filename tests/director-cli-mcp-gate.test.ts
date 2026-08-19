import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerPipelineMcpTools } from '../electron/pipeline/tools/register';
import { createDefaultProjectData } from '../src/lib/project-persistence';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import type { DirectorPlan } from '../src/types/director';
import type { MotionProductionPlan } from '../src/types/production';
import { DEFAULT_CARD_STYLE, type AICard } from '../src/types/ai';
import { runDirectorProductionHeadless } from '../electron/pipeline/director-production-run';
import { loadProjectFile } from '../electron/project-file';
import type { GenerationRunCtx } from '../electron/pipeline/headless-generation';
import { buildDirectorExecutionPlan } from '../src/lib/production-plan';

class FakeMcpServer {
  tools = new Map<string, { handler: (args: Record<string, unknown>) => unknown }>();
  registerTool(
    name: string,
    _definition: unknown,
    handler: (args: Record<string, unknown>) => unknown,
  ): void {
    this.tools.set(name, { handler });
  }
}

function projectWithoutApproval(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-director-gate-'));
  const project = createDefaultProjectData();
  project.production = createEmptyProductionState(100);
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
  return dir;
}

function directorPlan(revision = 1): DirectorPlan {
  return {
    revision,
    inputFingerprint: 'source-a',
    title: '测试作品标题是否合规',
    summary: '本测试验证导演模式批准后按既定顺序执行素材、卡片、封面、声音与时间线制作，并持久化审核检查点。',
    keywords: [],
    segments: [{
      id: 'seg-1',
      title: '测试镜头',
      summary: '测试字幕对应的有效镜头',
      startMs: 0,
      endMs: 1_000,
      semanticType: 'narration',
      complexityLevel: 'low',
      visualizationScore: 30,
      pacingNeed: 'steady',
      keywords: [],
      entities: [],
      visualType: 'motion',
      enabled: true,
      purpose: 'context',
      carrier: 'concept',
      intensity: 1,
      renderStrategy: 'motion-card',
      rationale: '为测试提供可执行导演镜头',
    }],
    motionBible: {
      visualThesis: '克制的信息动效',
      rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
      carrierPlan: [],
      styleRules: { paletteUse: '系统蓝', typographyUse: '短标题' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '封面方向，主标题“测试作品标题是否合规”', composition: '居中' },
    audioDirection: { bgmStyle: '克制', energy: 2, soundDensity: 'balanced' },
    warnings: [],
    zeroCompositeReason: '本测试草案仅验证 Motion 镜头的制作流程，不需要真实素材与信息层同场表达。',
    agentPlanning: {
      roleVersion: '5', workflowVersion: '5', completedAt: 1,
      toolCalls: 12, repairRounds: 0,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function projectWithDraft(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-director-production-'));
  const project = createDefaultProjectData();
  project.production = {
    ...createEmptyProductionState(100),
    draftPlan: directorPlan(),
    workflow: {
      ...createEmptyProductionState(100).workflow,
      stage: 'director-review',
    },
  };
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
  writeFileSync(path.join(dir, 'podcast-subtitles.srt'), '1\n00:00:00,000 --> 00:00:01,000\n测试字幕\n');
  return dir;
}

function generationContext(
  projectPath: string,
  signal: AbortSignal = new AbortController().signal,
): GenerationRunCtx {
  return {
    projectPath,
    userDataPath: path.join(projectPath, 'user-data'),
    params: { revision: 1 },
    handle: {
      taskId: 'task-director-1',
      signal,
      update: vi.fn(),
      log: vi.fn(),
    },
  };
}

describe('director CLI/MCP gate', () => {
  it('registers plan/status/approve tools', () => {
    const server = new FakeMcpServer();
    registerPipelineMcpTools(server as never, () => null, () => '/tmp/user-data');
    expect(server.tools.has('lingji_director_plan')).toBe(true);
    expect(server.tools.has('lingji_director_status')).toBe(true);
    expect(server.tools.has('lingji_director_approve')).toBe(true);
  });

  it.each([
    'lingji_generate_cover_prompts',
    'lingji_generate_cover_images',
    'lingji_generate_covers',
    'lingji_regenerate_card',
    'lingji_regenerate_card_media',
    'lingji_sculpt_card',
    'lingji_convert_card',
  ])('%s rejects before task creation when no plan is approved', async (toolName) => {
    const dir = projectWithoutApproval();
    const server = new FakeMcpServer();
    registerPipelineMcpTools(server as never, () => null, () => '/tmp/user-data');
    try {
      const result = (await server.tools.get(toolName)!.handler({
        projectPath: dir,
        cardId: 'card-1',
        to: 'motion',
      })) as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        code: 'director_approval_required',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('status returns the persisted V3 workflow state', async () => {
    const dir = projectWithoutApproval();
    const server = new FakeMcpServer();
    registerPipelineMcpTools(server as never, () => null, () => '/tmp/user-data');
    try {
      const result = (await server.tools.get('lingji_director_status')!.handler({
        projectPath: dir,
      })) as { content: Array<{ text: string }> };
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        version: 3,
        workflow: { stage: 'idle' },
        approvedPlan: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('director approve runs each production track once and persists the Animatic checkpoint', async () => {
    const dir = projectWithDraft();
    const calls: string[] = [];
    const cards = vi.fn(async () => {
      calls.push('cards');
      return {
        segments: [], cards: [], coverPrompts: ['封面方向'], summary: '摘要', keywords: [],
      };
    });
    const covers = vi.fn(async () => {
      calls.push('cover');
      return { prompts: ['封面方向'], candidates: [] };
    });
    const audio = vi.fn(async ({ execution }: { execution: MotionProductionPlan }) => {
      calls.push('audio');
      return { execution, placements: [], outcome: 'disabled' as const, reusedSounds: 0 };
    });
    const highlights = vi.fn(async () => {
      calls.push('highlights');
      return [];
    });
    try {
      const result = await runDirectorProductionHeadless(generationContext(dir), {
        cards: cards as never,
        covers: covers as never,
        audio: audio as never,
        highlights: highlights as never,
      });
      expect(calls.filter((call) => call === 'cards')).toHaveLength(1);
      expect(calls.filter((call) => call === 'cover')).toHaveLength(1);
      expect(calls.filter((call) => call === 'audio')).toHaveLength(1);
      expect(calls.filter((call) => call === 'highlights')).toHaveLength(1);
      expect(calls.indexOf('cover')).toBeGreaterThan(calls.indexOf('cards'));
      expect(result.workflow.stage).toBe('animatic-review');
      expect(result.outputs).toMatchObject({
        cards: { status: 'current' },
        cover: { status: 'current' },
        audio: { status: 'current' },
        footage: { status: 'current', directorRevision: 1 },
        timeline: { status: 'current' },
      });
      const persisted = (await loadProjectFile(dir)).production;
      expect(persisted?.pendingImpact).toBeNull();
      expect(persisted?.footage).toMatchObject({
        placements: [],
        compositionInputs: [],
        claimedSegmentIds: [],
        fallbacks: [],
        generationProvenance: {
          directorRevision: 1,
          fingerprint: 'footage-source-a-1',
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('director approve rejects a v2 draft before CLI/MCP production tracks start', async () => {
    const dir = projectWithDraft();
    const project = await loadProjectFile(dir);
    project.production!.draftPlan!.agentPlanning = {
      ...project.production!.draftPlan!.agentPlanning!,
      roleVersion: '2',
      workflowVersion: '2',
    };
    writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
    const cards = vi.fn();

    try {
      await expect(runDirectorProductionHeadless(
        generationContext(dir),
        { cards: cards as never },
      )).rejects.toThrow('旧版导演草案不能直接批准（角色 v2 · 工作流 v2）');
      expect(cards).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stages fresh headless footage provenance before the cards track starts', async () => {
    const dir = projectWithDraft();
    const assetPath = path.join(dir, 'approved-material.png');
    writeFileSync(assetPath, 'approved-material');
    const project = await loadProjectFile(dir);
    const draft = project.production!.draftPlan!;
    draft.segments[0] = {
      ...draft.segments[0],
      renderStrategy: 'agent-composite',
      visualType: 'image',
      compositionIntent: {
        narrativeGoal: '真实素材与解释同场',
        focalPriority: '先看素材',
        temporalRelationship: '素材先出现，图形随后解释',
        mustShow: ['真实素材'],
        avoid: ['纯文字替代'],
      },
      compositionAssets: [{
        asset: {
          id: 'approved-material', filename: 'approved-material.png', path: assetPath,
          kind: 'image', score: 1,
        },
        usage: 'required',
      }],
      mediaIndispensability: '真实素材提供不可替代的对象证据',
      graphicsIndispensability: '图形层提供素材无法表达的解释关系',
      assetDecisions: [{
        candidateId: 'approved-material',
        decision: 'selected',
        reason: '已预览并确认素材适合该镜头',
        inspected: true,
      }],
      fallbackPolicy: 'block',
    };
    writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
    const cards = vi.fn(async () => {
      const staged = await loadProjectFile(dir);
      expect(staged.production?.outputs.footage).toMatchObject({
        status: 'current',
        directorRevision: 1,
      });
      expect(staged.production?.footage).toMatchObject({
        compositionInputs: [expect.objectContaining({
          segmentId: 'seg-1',
          asset: expect.objectContaining({ id: 'approved-material', path: assetPath }),
          fileFingerprint: expect.stringMatching(/^stat:/),
        })],
        generationProvenance: {
          directorRevision: 1,
          fingerprint: 'footage-source-a-1',
          modifiedByUser: false,
          generatedAt: expect.any(Number),
        },
      });
      return {
        segments: draft.segments,
        cards: [],
        coverPrompts: ['封面方向'],
        summary: draft.summary,
        keywords: draft.keywords,
      };
    });
    try {
      await runDirectorProductionHeadless(generationContext(dir), {
        cards: cards as never,
        covers: vi.fn(async () => ({ prompts: ['封面方向'], candidates: [] })) as never,
        audio: vi.fn(async ({ execution }: { execution: MotionProductionPlan }) => ({
          execution, placements: [], outcome: 'disabled' as const, reusedSounds: 0,
        })) as never,
        highlights: vi.fn(async () => []) as never,
      });
      expect(cards).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the previous timeline and enters quality-blocked when cards report segment failures', async () => {
    const dir = projectWithDraft();
    const beforeTimeline = (await loadProjectFile(dir)).timeline;
    const cards = vi.fn(async () => ({
      segments: [],
      cards: [],
      coverPrompts: ['封面方向'],
      summary: '摘要',
      keywords: [],
      cardErrors: [{
        segmentId: 'seg-failed',
        segmentTitle: '失败镜头',
        segmentIndex: 0,
        totalSegments: 1,
        message: '卡片质量门禁未通过',
      }],
    }));
    try {
      const result = await runDirectorProductionHeadless(generationContext(dir), {
        cards: cards as never,
        covers: vi.fn(async () => ({ prompts: [], candidates: [] })) as never,
        audio: vi.fn(async ({ execution }: { execution: MotionProductionPlan }) => ({
          execution, placements: [], outcome: 'disabled' as const, reusedSounds: 0,
        })) as never,
        highlights: vi.fn(async () => []) as never,
      });

      const persisted = await loadProjectFile(dir);
      expect(result.workflow.stage).toBe('quality-blocked');
      expect(result.outputs.cards.status).toBe('failed');
      expect(result.outputs.timeline).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('时间线未替换'),
      });
      expect(persisted.timeline).toEqual(beforeTimeline);
      expect(persisted.production?.pendingImpact).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not commit the timeline when the whole cards track fails', async () => {
    const dir = projectWithDraft();
    const beforeTimeline = (await loadProjectFile(dir)).timeline;
    try {
      const result = await runDirectorProductionHeadless(generationContext(dir), {
        cards: vi.fn(async () => { throw new Error('provider unavailable'); }) as never,
        covers: vi.fn(async () => ({ prompts: [], candidates: [] })) as never,
        audio: vi.fn(async ({ execution }: { execution: MotionProductionPlan }) => ({
          execution, placements: [], outcome: 'disabled' as const, reusedSounds: 0,
        })) as never,
        highlights: vi.fn(async () => []) as never,
      });

      const persisted = await loadProjectFile(dir);
      expect(result.workflow).toMatchObject({
        stage: 'quality-blocked',
        error: expect.stringContaining('provider unavailable'),
      });
      expect(result.outputs.timeline.status).toBe('failed');
      expect(persisted.timeline).toEqual(beforeTimeline);
      expect(persisted.production?.pendingImpact).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps non-Motion footage failures recoverable instead of entering animatic review', async () => {
    const dir = projectWithDraft();
    const project = createDefaultProjectData();
    const production = createEmptyProductionState(100);
    const approvedPlan = directorPlan();
    approvedPlan.segments[0] = {
      ...approvedPlan.segments[0],
      visualType: 'footage',
      renderStrategy: 'standalone-media',
      footageQuery: '测试真实素材',
    };
    project.production = {
      ...production,
      approvedPlan,
      pendingImpact: {
        allCards: true, segmentIds: [], cover: true, audio: true,
        timeline: true, quality: true, reasons: ['initial-approval'],
      },
      workflow: { ...production.workflow, stage: 'production-paused' },
    };
    writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
    const userDataPath = path.join(dir, 'user-data');
    mkdirSync(userDataPath, { recursive: true });
    writeFileSync(path.join(userDataPath, 'settings.json'), JSON.stringify({
      aiSettings: { kacut: { enabled: true, baseUrl: 'http://127.0.0.1:8765' } },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 }) as Response));
    const beforeTimeline = (await loadProjectFile(dir)).timeline;

    try {
      const result = await runDirectorProductionHeadless(generationContext(dir), {
        cards: vi.fn(async () => ({
          segments: approvedPlan.segments,
          cards: [],
          coverPrompts: ['封面方向'],
          summary: '摘要',
          keywords: [],
        })) as never,
        covers: vi.fn(async () => ({ prompts: [], candidates: [] })) as never,
        audio: vi.fn(async ({ execution }: { execution: MotionProductionPlan }) => ({
          execution, placements: [], outcome: 'disabled' as const, reusedSounds: 0,
        })) as never,
        highlights: vi.fn(async () => []) as never,
      });

      const persisted = await loadProjectFile(dir);
      expect(result.workflow).toMatchObject({
        stage: 'quality-blocked',
        error: expect.stringContaining('素材轨未完成'),
      });
      expect(result.outputs.footage).toMatchObject({
        status: 'failed',
        error: expect.any(String),
      });
      expect(result.outputs.timeline).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('时间线未替换'),
      });
      expect(persisted.timeline).toEqual(beforeTimeline);
      expect(persisted.production?.pendingImpact).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resumes a paused approved revision and only runs stale tracks', async () => {
    const dir = projectWithDraft();
    const project = createDefaultProjectData();
    const production = createEmptyProductionState(100);
    project.production = {
      ...production,
      approvedPlan: { ...directorPlan(), approvedAt: 50 },
      workflow: { ...production.workflow, stage: 'production-paused' },
      outputs: {
        cards: { status: 'current', directorRevision: 1, updatedAt: 50 },
        cover: { status: 'current', directorRevision: 1, updatedAt: 50 },
        audio: { status: 'stale', directorRevision: 1, updatedAt: 60 },
        timeline: { status: 'stale', directorRevision: 1, updatedAt: 60 },
      },
    };
    writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
    const cards = vi.fn();
    const covers = vi.fn();
    const audio = vi.fn(async ({ execution }: { execution: MotionProductionPlan }) => ({
      execution, placements: [], outcome: 'disabled' as const, reusedSounds: 0,
    }));
    const highlights = vi.fn(async () => []);
    try {
      const result = await runDirectorProductionHeadless(generationContext(dir), {
        cards: cards as never, covers: covers as never,
        audio: audio as never, highlights: highlights as never,
      });
      expect(cards).not.toHaveBeenCalled();
      expect(covers).not.toHaveBeenCalled();
      expect(audio).toHaveBeenCalledTimes(1);
      expect(highlights).toHaveBeenCalledTimes(1);
      expect(result.workflow.stage).toBe('animatic-review');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a paused v2 approvedPlan before headless resume starts any track', async () => {
    const dir = projectWithDraft();
    const project = createDefaultProjectData();
    const production = createEmptyProductionState(100);
    const legacy = directorPlan();
    legacy.agentPlanning = { ...legacy.agentPlanning!, roleVersion: '2', workflowVersion: '2' };
    project.production = {
      ...production,
      approvedPlan: { ...legacy, approvedAt: 50 },
      workflow: { ...production.workflow, stage: 'production-paused' },
    };
    writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
    const cards = vi.fn();
    const covers = vi.fn();
    const audio = vi.fn();
    const highlights = vi.fn();

    try {
      await expect(runDirectorProductionHeadless(generationContext(dir), {
        cards: cards as never, covers: covers as never,
        audio: audio as never, highlights: highlights as never,
      })).rejects.toThrow('旧版导演方案不能继续制作（角色 v2 · 工作流 v2）');
      expect(cards).not.toHaveBeenCalled();
      expect(covers).not.toHaveBeenCalled();
      expect(audio).not.toHaveBeenCalled();
      expect(highlights).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('headless 恢复同版本旧 execution 时补齐批准方案的 Agent 合成字段', async () => {
    const dir = projectWithDraft();
    const project = createDefaultProjectData();
    const production = createEmptyProductionState(100);
    const basePlan = directorPlan();
    const compositionIntent = {
      narrativeGoal: '真实道路画面建立证据，图形负责结论',
      focalPriority: '先看道路，再看排名',
      temporalRelationship: '中段进入结论',
      mustShow: ['世界第91位'],
      avoid: ['广告式陈列'],
    };
    const approvedPlan: DirectorPlan = {
      ...basePlan,
      approvedAt: 50,
      segments: [{
        id: 'seg-1', title: '道路与排名', summary: '长期积累形成结果',
        startMs: 0, endMs: 1_000, semanticType: 'data', complexityLevel: 'high',
        visualizationScore: 90, pacingNeed: 'accent', keywords: ['排名'], entities: [],
        visualType: 'footage', footageQuery: '城市道路 车辆行驶', footageFallback: 'motion',
        enabled: true, purpose: 'evidence', carrier: 'data-hero', intensity: 3,
        renderStrategy: 'agent-composite', compositionIntent, fallbackPolicy: 'block',
        compositionAssets: [{
          asset: {
            id: 'road-video', filename: 'road.mp4', path: '/library/road.mp4',
            kind: 'video', score: 0.9,
          },
          usage: 'required',
          trimStartMs: 2_000,
        }],
        rationale: '真实画面与排名结论共同完成叙事',
      }],
      motionBible: {
        ...basePlan.motionBible,
        carrierPlan: [{
          segmentId: 'seg-1', visualType: 'footage', preferredCarrier: 'data-hero',
          intensity: 3, renderStrategy: 'agent-composite', compositionIntent,
          fallbackPolicy: 'block', mediaQuery: '城市道路 车辆行驶', footageFallback: 'motion',
          reason: '真实画面与排名结论共同完成叙事',
        }],
      },
    };
    const staleExecution = buildDirectorExecutionPlan(approvedPlan, 1_000);
    staleExecution.motionBible = {
      ...staleExecution.motionBible,
      carrierPlan: [{
        segmentId: 'seg-1', visualType: 'footage', preferredCarrier: 'footage',
        intensity: 3, reason: '旧 execution 尚未记录合成字段',
      }],
    };
    project.production = {
      ...production,
      approvedPlan,
      execution: staleExecution,
      workflow: { ...production.workflow, stage: 'production-paused' },
      outputs: {
        cards: { status: 'current', directorRevision: 1, updatedAt: 50 },
        cover: { status: 'current', directorRevision: 1, updatedAt: 50 },
        audio: { status: 'stale', directorRevision: 1, updatedAt: 60 },
        timeline: { status: 'current', directorRevision: 1, updatedAt: 50 },
        footage: { status: 'current', directorRevision: 1, updatedAt: 50 },
      },
    };
    writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
    const audio = vi.fn(async ({ execution }: { execution: MotionProductionPlan }) => ({
      execution, placements: [], outcome: 'disabled' as const, reusedSounds: 0,
    }));
    try {
      const result = await runDirectorProductionHeadless(generationContext(dir), {
        cards: vi.fn() as never,
        covers: vi.fn() as never,
        audio: audio as never,
        highlights: vi.fn() as never,
      });

      expect(audio.mock.calls[0]?.[0].execution.motionBible.carrierPlan[0]).toMatchObject({
        renderStrategy: 'agent-composite',
        compositionIntent,
        fallbackPolicy: 'block',
      });
      expect(result.execution?.motionBible.carrierPlan[0]).toMatchObject({
        renderStrategy: 'agent-composite',
        compositionIntent,
        fallbackPolicy: 'block',
      });
      expect((await loadProjectFile(dir)).production?.execution?.motionBible.carrierPlan[0]).toMatchObject({
        renderStrategy: 'agent-composite',
        compositionIntent,
        fallbackPolicy: 'block',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists production-paused when a running approval task is canceled', async () => {
    const dir = projectWithDraft();
    const controller = new AbortController();
    const cards = vi.fn(async () => {
      controller.abort();
      return { segments: [], cards: [], coverPrompts: [], summary: '摘要', keywords: [] };
    });
    const covers = vi.fn(async () => ({ prompts: [], candidates: [] }));
    const audio = vi.fn(async ({ execution }: { execution: MotionProductionPlan }) => ({
      execution, placements: [], outcome: 'disabled' as const, reusedSounds: 0,
    }));
    const highlights = vi.fn(async () => []);
    try {
      await expect(runDirectorProductionHeadless(generationContext(dir, controller.signal), {
        cards: cards as never, covers: covers as never,
        audio: audio as never, highlights: highlights as never,
      })).rejects.toMatchObject({ name: 'AbortError' });
      const production = (await loadProjectFile(dir)).production!;
      expect(production.workflow.stage).toBe('production-paused');
      expect(Object.values(production.outputs).every((output) => output.status === 'stale')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves manually refined cards and reports a merge requirement instead of overwriting', async () => {
    const dir = projectWithDraft();
    const project = createDefaultProjectData();
    const production = createEmptyProductionState(100);
    const protectedCard: AICard = {
      id: 'manual-card', segmentId: 'seg-manual', type: 'motion', title: '人工精修', content: '保留',
      startMs: 0, endMs: 1_000, displayDurationMs: 1_000, displayMode: 'fullscreen',
      template: 'default', enabled: true, style: DEFAULT_CARD_STYLE.motion,
      generationProvenance: {
        directorRevision: 0, fingerprint: 'manual', generatedAt: 1, modifiedByUser: true,
      },
    };
    project.production = {
      ...production,
      draftPlan: directorPlan(),
      workflow: { ...production.workflow, stage: 'director-review' },
    };
    project.aiAnalysis = {
      analysisResult: {
        segments: [], cards: [protectedCard], coverPrompts: [], summary: '摘要', keywords: [],
      },
      coverCandidates: [],
    };
    writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
    const cards = vi.fn();
    try {
      const result = await runDirectorProductionHeadless(generationContext(dir), {
        cards: cards as never,
        covers: vi.fn(async () => ({ prompts: [], candidates: [] })) as never,
        audio: vi.fn(async ({ execution }: { execution: MotionProductionPlan }) => ({
          execution, placements: [], outcome: 'disabled' as const, reusedSounds: 0,
        })) as never,
        highlights: vi.fn(async () => []) as never,
      });
      expect(cards).not.toHaveBeenCalled();
      expect(result.outputs.cards).toMatchObject({ status: 'failed' });
      expect(result.outputs.cards.error).toContain('人工精修镜头需人工合并');
      expect((await loadProjectFile(dir)).aiAnalysis?.analysisResult?.cards[0].title).toBe('人工精修');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
