import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadProjectFile, mutateProjectProduction, saveProjectSection } from '../electron/project-file';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import type { DirectorPlan } from '../src/types/director';

let tmpDir: string;

function directorPlan(revision: number): DirectorPlan {
  return {
    revision,
    inputFingerprint: `source-${revision}`,
    summary: '摘要',
    keywords: [],
    segments: [],
    motionBible: {
      visualThesis: '命题',
      rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
      carrierPlan: [],
      styleRules: { paletteUse: '蓝', typographyUse: '短标题' },
      transitionRules: { default: 'crossfade', matchCutCandidates: [] },
    },
    coverDirection: { prompt: '封面', composition: '居中' },
    audioDirection: { bgmStyle: '克制', energy: 2, soundDensity: 'balanced' },
    warnings: [],
    createdAt: 1,
    updatedAt: 1,
    approvedAt: 1,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proj-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('loadProjectFile', () => {
  it('空目录返回默认 ProjectData', async () => {
    const data = await loadProjectFile(tmpDir);
    expect(data.version).toBe(3);
    expect(data.timeline).toBeNull();
  });

  it('已有 project.json 则读取', async () => {
    const existing = {
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      timeline: {
        podcast: { audioPath: '/test.mp3', srtPath: '', durationMs: 0 },
        overlays: [],
        subtitleConfig: {},
        globalBackground: '',
      },
      aiAnalysis: { analysisResult: null, coverCandidates: [] },
      script: {
        templateId: 't',
        annotations: [],
        reviewState: 'idle',
        lastReviewedDocVersion: 0,
      },
    };
    await fs.writeFile(path.join(tmpDir, 'project.json'), JSON.stringify(existing));
    const data = await loadProjectFile(tmpDir);
    expect(data.version).toBe(3);
    expect(data.timeline?.podcast?.audioPath).toBe('/test.mp3');
    expect(await fs.readFile(path.join(tmpDir, 'project.v1.backup.json'), 'utf-8')).toContain('"version":1');
  });

  it('读入旧 project.json 时内存态剥离已废弃的 motionCards / storyboardPlan 字段（不回写磁盘）', async () => {
    const existing = {
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      timeline: null,
      aiAnalysis: {
        analysisResult: null,
        coverCandidates: [],
        motionCards: [{ id: 'motion-legacy' }],
        storyboardPlan: { segments: [], suggestions: [], summary: '', generatedAt: 0 },
      },
      script: {
        templateId: 't',
        annotations: [],
        reviewState: 'idle',
        lastReviewedDocVersion: 0,
      },
    };
    await fs.writeFile(path.join(tmpDir, 'project.json'), JSON.stringify(existing));

    const data = await loadProjectFile(tmpDir);

    expect(data.aiAnalysis).toEqual({
      analysisResult: null,
      coverCandidates: [],
    });
    // V1 -> V3 会一次性备份并重写；废弃字段不会进入新文件。
    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'project.json'), 'utf-8'));
    expect(raw.version).toBe(3);
    expect(raw.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(raw.aiAnalysis.motionCards).toBeUndefined();
  });

  it('不再迁移旧 sidecar 文件：只有 timeline.json 时按空目录处理', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'timeline.json'),
      JSON.stringify({
        podcast: { audioPath: '/old.mp3', srtPath: '/old.srt', durationMs: 5000 },
        overlays: [],
      }),
    );

    const data = await loadProjectFile(tmpDir);
    expect(data.timeline).toBeNull();

    const files = await fs.readdir(tmpDir);
    expect(files).toContain('project.json');
    // 旧文件不再被读取或删除
    expect(files).toContain('timeline.json');
  });

  it('加载导演审查项目时持久清理上一制作任务的 generating 中间态', async () => {
    await loadProjectFile(tmpDir);
    const production = createEmptyProductionState(1);
    production.draftPlan = directorPlan(2);
    production.approvedPlan = directorPlan(1);
    production.workflow = {
      ...production.workflow,
      stage: 'director-review',
      updatedAt: 20,
      activeTaskId: 'director-production-old',
      error: '28 个镜头未通过质量门禁',
      failedStage: 'production-running',
    };
    production.outputs.footage = {
      status: 'generating', directorRevision: 1, updatedAt: 10, error: '旧任务仍在保存',
    };
    await saveProjectSection(tmpDir, 'production', production);

    const project = await loadProjectFile(tmpDir);

    expect(project.production?.outputs.footage).toEqual({
      status: 'stale', directorRevision: 1, updatedAt: 20, error: undefined,
    });
    expect(project.production?.workflow.activeTaskId).toBeUndefined();
    expect(project.production?.workflow.error).toBeUndefined();
    expect(project.production?.workflow.failedStage).toBeUndefined();
    const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, 'project.json'), 'utf-8'));
    expect(persisted.production.outputs.footage).toEqual({
      status: 'stale', directorRevision: 1, updatedAt: 20,
    });
    expect(persisted.production.workflow.activeTaskId).toBeUndefined();
    expect(persisted.production.workflow.error).toBeUndefined();
    expect(persisted.production.workflow.failedStage).toBeUndefined();
  });

  it('加载期间保留仍标记为 production-running 的制作中状态', async () => {
    await loadProjectFile(tmpDir);
    const production = createEmptyProductionState(1);
    production.approvedPlan = directorPlan(1);
    production.workflow = {
      ...production.workflow,
      stage: 'production-running',
      updatedAt: 20,
      activeTaskId: 'director-production-live',
    };
    production.outputs.footage = { status: 'generating', directorRevision: 1, updatedAt: 10 };
    await saveProjectSection(tmpDir, 'production', production);

    const project = await loadProjectFile(tmpDir);

    expect(project.production?.workflow.activeTaskId).toBe('director-production-live');
    expect(project.production?.outputs.footage.status).toBe('generating');
  });
});

describe('mutateProjectProduction', () => {
  it('serializes concurrent output mutations without losing sibling state', async () => {
    await loadProjectFile(tmpDir);
    await Promise.all([
      mutateProjectProduction(tmpDir, {
        kind: 'set-output',
        output: 'cards',
        state: { status: 'current', directorRevision: 1, updatedAt: 10 },
      }),
      mutateProjectProduction(tmpDir, {
        kind: 'set-output',
        output: 'cover',
        state: { status: 'failed', directorRevision: 1, updatedAt: 11, error: 'cover failed' },
      }),
    ]);
    const project = await loadProjectFile(tmpDir);
    expect(project.production?.outputs.cards.status).toBe('current');
    expect(project.production?.outputs.cover).toMatchObject({ status: 'failed', error: 'cover failed' });
  });

  it('normalizes legacy review state before checking a late production task guard', async () => {
    await loadProjectFile(tmpDir);
    const production = createEmptyProductionState(1);
    production.draftPlan = directorPlan(2);
    production.approvedPlan = directorPlan(1);
    production.workflow = {
      ...production.workflow,
      stage: 'director-review',
      updatedAt: 20,
      activeTaskId: 'director-production-old',
      error: '上一轮制作失败',
      failedStage: 'production-running',
    };
    production.outputs.footage = { status: 'generating', directorRevision: 1, updatedAt: 10 };
    await saveProjectSection(tmpDir, 'production', production);

    await expect(mutateProjectProduction(tmpDir, {
      kind: 'set-output',
      output: 'footage',
      state: { status: 'current', directorRevision: 1, updatedAt: 30 },
      expectedDirectorRevision: 1,
      expectedTaskId: 'director-production-old',
    })).rejects.toThrow('制作任务已变化');

    const project = await loadProjectFile(tmpDir);
    expect(project.production?.outputs.footage.status).toBe('stale');
    expect(project.production?.workflow.activeTaskId).toBeUndefined();
  });

  it('validates the latest project snapshot inside the production write lock', async () => {
    await loadProjectFile(tmpDir);
    await saveProjectSection(tmpDir, 'meta', { title: 'newer input' });

    await expect(mutateProjectProduction(tmpDir, {
      kind: 'set-output',
      output: 'cards',
      state: { status: 'current', directorRevision: 1, updatedAt: 10 },
    }, (current) => {
      if (current.meta?.title === 'newer input') throw new Error('snapshot changed');
    })).rejects.toThrow('snapshot changed');

    const project = await loadProjectFile(tmpDir);
    expect(project.production).toBeUndefined();
  });

  it('saves a director draft title and intro into project and publish metadata atomically', async () => {
    await loadProjectFile(tmpDir);
    const plan = {
      ...directorPlan(2),
      title: '世界第91位不是突然发生的',
      summary: '从全球排名回看长期积累，这不是一次突然的跃升。',
    };

    await mutateProjectProduction(tmpDir, { kind: 'replace-draft', plan });

    const project = await loadProjectFile(tmpDir);
    expect(project.production?.draftPlan?.title).toBe(plan.title);
    expect(project.production?.draftPlan?.coverDirection.prompt).toContain(`“${plan.title}”`);
    expect(project.meta?.title).toBe(plan.title);
    expect(project.publish?.title).toBe(plan.title);
    expect(project.publish?.desc).toBe(plan.summary);
  });

  it('does not overwrite project metadata when saving a legacy draft without title', async () => {
    await loadProjectFile(tmpDir);
    await saveProjectSection(tmpDir, 'meta', { title: '已有作品标题' });
    await saveProjectSection(tmpDir, 'publish', {
      title: '已有作品标题', desc: '已有简介', tagsInput: '', thumbnail: '',
    });

    await mutateProjectProduction(tmpDir, { kind: 'replace-draft', plan: directorPlan(2) });

    const project = await loadProjectFile(tmpDir);
    expect(project.meta?.title).toBe('已有作品标题');
    expect(project.publish?.title).toBe('已有作品标题');
    expect(project.publish?.desc).toBe('已有简介');
  });

  it('keeps a manually edited publish intro when saving a titled director draft', async () => {
    await loadProjectFile(tmpDir);
    await saveProjectSection(tmpDir, 'publish', {
      title: '旧标题', desc: '发布台人工修改的简介', tagsInput: '', thumbnail: '',
    });
    const plan = {
      ...directorPlan(2),
      title: '世界第91位不是突然发生的',
      summary: '导演新生成的简介',
    };

    await mutateProjectProduction(tmpDir, { kind: 'replace-draft', plan });

    const project = await loadProjectFile(tmpDir);
    expect(project.publish?.title).toBe(plan.title);
    expect(project.publish?.desc).toBe('发布台人工修改的简介');
  });
});

describe('saveProjectSection', () => {
  it('拒绝过期制作任务覆盖当前导演版本的产物', async () => {
    const production = createEmptyProductionState(1);
    production.approvedPlan = directorPlan(2);
    production.workflow = {
      ...production.workflow,
      stage: 'production-running',
      activeTaskId: 'task-current',
    };
    await saveProjectSection(tmpDir, 'production', production);
    await saveProjectSection(tmpDir, 'aiAnalysis', {
      analysisResult: null,
      coverCandidates: [{ id: 'current', prompt: '当前封面', imageUrl: '/current.png', selected: true }],
    });

    await expect(saveProjectSection(tmpDir, 'aiAnalysis', {
      analysisResult: null,
      coverCandidates: [{ id: 'stale', prompt: '过期封面', imageUrl: '/stale.png', selected: true }],
    }, {
      expectedDirectorRevision: 1,
      expectedTaskId: 'task-stale',
    })).rejects.toThrow(/版本已变化|任务已变化/);

    const project = await loadProjectFile(tmpDir);
    expect(project.aiAnalysis.coverCandidates[0]?.id).toBe('current');
  });

  it('拒绝把旧 MotionProductionPlan 直接覆盖到 V3 production', async () => {
    await loadProjectFile(tmpDir);
    await expect(saveProjectSection(tmpDir, 'production', {
      version: 2,
      shots: [],
    })).rejects.toThrow('production_schema_invalid');
    const project = await loadProjectFile(tmpDir);
    expect(project.production).toBeUndefined();
  });

  it('写入 timeline 段并保留其他段', async () => {
    await loadProjectFile(tmpDir);
    const newTimeline = {
      podcast: { audioPath: '/new.mp3', srtPath: '', durationMs: 0 },
      overlays: [],
      subtitleConfig: {},
      globalBackground: '',
    };
    await saveProjectSection(tmpDir, 'timeline', newTimeline);
    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'project.json'), 'utf-8'));
    expect(raw.timeline.podcast.audioPath).toBe('/new.mp3');
    expect(raw.aiAnalysis).toBeDefined();
    expect(raw.script).toBeDefined();
  });

  it('project.json 损坏时拒绝保存，不清空其它段，并备份原文', async () => {
    // 模拟 torn write / 损坏：文件存在但不是合法 JSON
    const corrupt = '{ "version": 1, "timeline": { "overlays": [  // 截断';
    await fs.writeFile(path.join(tmpDir, 'project.json'), corrupt);

    await expect(
      saveProjectSection(tmpDir, 'publish', {
        title: 't',
        desc: '',
        tagsInput: '',
        thumbnail: '',
        overrides: {},
      }),
    ).rejects.toThrow(/损坏|并发写入/);

    // 损坏原文未被默认工程覆盖
    expect(await fs.readFile(path.join(tmpDir, 'project.json'), 'utf-8')).toBe(corrupt);
    // 备份文件已生成
    const files = await fs.readdir(tmpDir);
    expect(files.some((f) => f.startsWith('project.json.corrupt-'))).toBe(true);
  });

  it('loadProjectFile 遇到损坏文件抛错而非静默重置', async () => {
    await fs.writeFile(path.join(tmpDir, 'project.json'), '{ not valid json');
    await expect(loadProjectFile(tmpDir)).rejects.toThrow(/损坏|并发写入/);
    // 原文保留，备份生成
    expect(await fs.readFile(path.join(tmpDir, 'project.json'), 'utf-8')).toBe('{ not valid json');
    const files = await fs.readdir(tmpDir);
    expect(files.some((f) => f.startsWith('project.json.corrupt-'))).toBe(true);
  });

  it('并发写入不损坏文件', async () => {
    await loadProjectFile(tmpDir);
    await Promise.all([
      saveProjectSection(tmpDir, 'timeline', {
        podcast: { audioPath: '/a.mp3', srtPath: '', durationMs: 0 },
        overlays: [],
        subtitleConfig: {},
        globalBackground: '',
      }),
      saveProjectSection(tmpDir, 'aiAnalysis', {
        analysisResult: null,
        coverCandidates: [{ id: '1', prompt: 'p', imageUrl: '/img.png', selected: true }],
      }),
      saveProjectSection(tmpDir, 'script', {
        templateId: 'custom',
        annotations: [],
        reviewState: 'idle',
        lastReviewedDocVersion: 0,
      }),
    ]);
    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'project.json'), 'utf-8'));
    expect(raw.timeline.podcast.audioPath).toBe('/a.mp3');
    expect(raw.aiAnalysis.coverCandidates).toHaveLength(1);
    expect(raw.script.templateId).toBe('custom');
  });
});
