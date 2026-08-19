import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveProject,
  setActiveProjectPath,
  HeadlessProjectContext,
} from '../electron/pipeline/context';
import { createDefaultProjectData } from '../src/lib/project-persistence';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import { createDefaultTimeline } from '../src/types';
import type { DirectorPlan } from '../src/types/director';

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'lingji-ctx-'));
}

const VALID_PROJECT_JSON = JSON.stringify({
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  timeline: null,
  aiAnalysis: { analysisResult: null, coverCandidates: [] },
  script: {
    templateId: 'x',
    annotations: [],
    reviewState: 'idle',
    lastReviewedDocVersion: 0,
  },
});

function guardedProject(revision: number, taskId?: string) {
  const project = createDefaultProjectData();
  const production = createEmptyProductionState(100);
  const approvedPlan: DirectorPlan = {
    revision,
    inputFingerprint: `source-${revision}`,
    title: '并发写入测试',
    summary: '验证旧的后台制作任务不能覆盖已经取消或换版后的项目内容。',
    keywords: [],
    segments: [{
      id: 'seg-1', title: '镜头', summary: '测试镜头', startMs: 0, endMs: 1_000,
      semanticType: 'narration', complexityLevel: 'low', visualizationScore: 10,
      pacingNeed: 'steady', keywords: [], entities: [], visualType: 'motion',
      enabled: true, purpose: 'context', carrier: 'concept', intensity: 1,
      renderStrategy: 'motion-card', rationale: '测试',
    }],
    motionBible: {
      visualThesis: '测试',
      rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
      carrierPlan: [],
      styleRules: { paletteUse: '测试', typographyUse: '测试' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '测试封面', composition: '居中' },
    audioDirection: { bgmStyle: '', energy: 1, soundDensity: 'balanced' },
    warnings: [], createdAt: 1, updatedAt: 1, approvedAt: 1,
  };
  project.production = {
    ...production,
    approvedPlan,
    workflow: { ...production.workflow, stage: 'production-running', activeTaskId: taskId },
  };
  return project;
}

describe('resolveProject', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp();
    setActiveProjectPath(null);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws project_not_found when directory does not exist', async () => {
    await expect(
      resolveProject('/nonexistent/dir/lingji-' + Date.now()),
    ).rejects.toMatchObject({ code: 'project_not_found' });
  });

  it('returns headless context for non-active project', async () => {
    writeFileSync(path.join(dir, 'project.json'), VALID_PROJECT_JSON);
    const ctx = await resolveProject(dir);
    expect(ctx.mode).toBe('headless');
    expect(ctx.projectPath).toBe(dir);
    if (ctx.mode === 'headless') {
      expect(ctx.headless).toBeInstanceOf(HeadlessProjectContext);
    }
  });

  it('returns active context when path matches setActiveProjectPath', async () => {
    writeFileSync(path.join(dir, 'project.json'), VALID_PROJECT_JSON);
    setActiveProjectPath(dir);
    const ctx = await resolveProject(dir);
    expect(ctx.mode).toBe('active');
  });
});

describe('HeadlessProjectContext', () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('saveSection writes through the existing write lock and merges section', async () => {
    writeFileSync(path.join(dir, 'project.json'), VALID_PROJECT_JSON);
    const ctx = new HeadlessProjectContext(dir);
    await ctx.saveSection('script', {
      templateId: 'news-broadcast',
      annotations: [],
      reviewState: 'idle',
      lastReviewedDocVersion: 0,
    });
    const re = await ctx.loadProjectData();
    expect(re.script.templateId).toBe('news-broadcast');
  });

  it('rejects an old task aiAnalysis write after production is canceled', async () => {
    const project = guardedProject(1);
    writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
    const ctx = new HeadlessProjectContext(dir);

    await expect(ctx.saveSection('aiAnalysis', {
      analysisResult: {
        segments: [], cards: [], coverPrompts: [], summary: '旧任务结果', keywords: [],
      },
      coverCandidates: [],
    }, {
      expectedDirectorRevision: 1,
      expectedTaskId: 'task-old',
    })).rejects.toMatchObject({ code: 'director_task_conflict' });

    expect((await ctx.loadProjectData()).aiAnalysis.analysisResult).toBeNull();
  });

  it('rejects an old revision timeline write after the director plan is replaced', async () => {
    const project = guardedProject(2, 'task-new');
    writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
    const ctx = new HeadlessProjectContext(dir);

    await expect(ctx.saveSection('timeline', createDefaultTimeline(), {
      expectedDirectorRevision: 1,
      expectedTaskId: 'task-old',
    })).rejects.toMatchObject({ code: 'director_revision_conflict' });

    expect((await ctx.loadProjectData()).timeline).toBeNull();
  });
});
