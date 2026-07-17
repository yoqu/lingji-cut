import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    summary: '摘要',
    keywords: [],
    segments: [],
    motionBible: {
      visualThesis: '克制的信息动效',
      rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
      carrierPlan: [],
      styleRules: { paletteUse: '系统蓝', typographyUse: '短标题' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '封面方向', composition: '居中' },
    audioDirection: { bgmStyle: '克制', energy: 2, soundDensity: 'balanced' },
    warnings: [],
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
        timeline: { status: 'current' },
      });
      expect((await loadProjectFile(dir)).production?.pendingImpact).toBeNull();
    } finally {
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
