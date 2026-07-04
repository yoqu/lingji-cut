import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadProjectFile, saveProjectSection } from '../electron/project-file';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proj-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('loadProjectFile', () => {
  it('空目录返回默认 ProjectData', async () => {
    const data = await loadProjectFile(tmpDir);
    expect(data.version).toBe(1);
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
    expect(data.timeline?.podcast?.audioPath).toBe('/test.mp3');
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
    // 不再 rewrite-on-open：磁盘原文保持不变
    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'project.json'), 'utf-8'));
    expect(raw.updatedAt).toBe('2026-01-01T00:00:00.000Z');
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
});

describe('saveProjectSection', () => {
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
