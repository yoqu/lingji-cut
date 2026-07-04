import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import {
  scanProjectDirectory,
  planAssetNormalization,
  normalizeAssetPaths,
  importProject,
  ImportProjectError,
} from '../electron/project-import';
import type { ProjectData } from '../src/lib/project-persistence';
import type { TimelineData } from '../src/types';

function makeTimeline(overrides: Partial<TimelineData> = {}): TimelineData {
  return {
    version: 2,
    fps: 30,
    width: 1920,
    height: 1080,
    podcast: { audioPath: '', srtPath: '', durationMs: 0 },
    tracks: [],
    overlays: [],
    subtitle: {
      fontSize: 48,
      color: '#fff',
      position: 'bottom',
      highlightEnabled: false,
      highlightBackgroundColor: '#000',
      highlightTextColor: '#fff',
      highlightPaddingX: 0,
      highlightPaddingY: 0,
      highlightRadius: 0,
      highlightAnimation: 'none',
      maxCharsPerEntry: 35,
      autoResegment: true,
    },
    ...overrides,
  };
}

function makeProjectData(timeline: TimelineData | null): ProjectData {
  return {
    version: 1,
    createdAt: '2026-04-21T00:00:00.000Z',
    updatedAt: '2026-04-21T00:00:00.000Z',
    timeline,
    aiAnalysis: {
      analysisResult: null,
      coverCandidates: [],
    },
    script: {
      templateId: 'news-broadcast',
      annotations: [],
      reviewState: 'idle',
      lastReviewedDocVersion: 0,
    },
  };
}

describe('scanProjectDirectory', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-project-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('S1 complete：识别 project.json', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'project.json'),
      JSON.stringify(makeProjectData(null)),
    );
    const result = await scanProjectDirectory(tmpDir);
    expect(result.scenario).toBe('complete');
    expect(result.detectedFiles.some((f) => f.kind === 'projectJson')).toBe(true);
    expect(result.projectName).toBe(path.basename(tmpDir));
  });

  it('只有 timeline.json：不再识别为旧版项目', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'timeline.json'),
      JSON.stringify({ tracks: [], overlays: [] }),
    );
    const result = await scanProjectDirectory(tmpDir);
    expect(result.scenario).toBe('unrecognized');
  });

  it('S3 mediaOnly：只有 podcast-audio.mp3', async () => {
    await fs.writeFile(path.join(tmpDir, 'podcast-audio.mp3'), Buffer.from([0x00]));
    const result = await scanProjectDirectory(tmpDir);
    expect(result.scenario).toBe('mediaOnly');
  });

  it('S3 mediaOnly：只有 script.md', async () => {
    await fs.writeFile(path.join(tmpDir, 'script.md'), '# hello');
    const result = await scanProjectDirectory(tmpDir);
    expect(result.scenario).toBe('mediaOnly');
  });

  it('S4 unrecognized：空目录', async () => {
    const result = await scanProjectDirectory(tmpDir);
    expect(result.scenario).toBe('unrecognized');
    expect(result.blockReason).toBeTruthy();
  });

  it('S4 unrecognized：仅无关文件', async () => {
    await fs.writeFile(path.join(tmpDir, 'random.txt'), 'x');
    const result = await scanProjectDirectory(tmpDir);
    expect(result.scenario).toBe('unrecognized');
  });

  it('忽略 node_modules / .git / release', async () => {
    await fs.mkdir(path.join(tmpDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'trash.txt'), 'x');
    await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.git', 'HEAD'), 'x');
    await fs.writeFile(path.join(tmpDir, 'script.md'), '# x');
    const result = await scanProjectDirectory(tmpDir);
    expect(
      result.detectedFiles.some((f) => f.relativePath.includes('node_modules')),
    ).toBe(false);
    expect(result.detectedFiles.some((f) => f.relativePath.startsWith('.git'))).toBe(false);
  });

  it('正确分类 covers / ai-cards / imports/douyin 子目录文件', async () => {
    await fs.writeFile(path.join(tmpDir, 'project.json'), JSON.stringify(makeProjectData(null)));
    await fs.mkdir(path.join(tmpDir, 'covers'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'covers', 'a.png'), Buffer.from([0]));
    await fs.mkdir(path.join(tmpDir, 'ai-cards'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'ai-cards', 'c1.json'), '{}');
    await fs.mkdir(path.join(tmpDir, 'imports/douyin/v1'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'imports/douyin/v1/video.mp4'), Buffer.from([0]));

    const result = await scanProjectDirectory(tmpDir);
    const kinds = new Set(result.detectedFiles.map((f) => f.kind));
    expect(kinds.has('coverImage')).toBe(true);
    expect(kinds.has('aiCard')).toBe(true);
    expect(kinds.has('douyinImport')).toBe(true);
  });

  it('timelineItemCount 基于 overlays 长度', async () => {
    const timeline = makeTimeline({
      overlays: [
        {
          id: 'o1',
          type: 'video',
          assetPath: '/x.mp4',
          trackId: 'visual-1',
          startMs: 0,
          durationMs: 1000,
          position: { x: 0, y: 0, width: 100, height: 100 },
        },
        {
          id: 'o2',
          type: 'text',
          assetPath: '',
          trackId: 'visual-1',
          startMs: 1000,
          durationMs: 1000,
          position: { x: 0, y: 0, width: 100, height: 100 },
        },
      ],
    });
    await fs.writeFile(
      path.join(tmpDir, 'project.json'),
      JSON.stringify(makeProjectData(timeline)),
    );
    const result = await scanProjectDirectory(tmpDir);
    expect(result.timelineItemCount).toBe(2);
  });
});

describe('planAssetNormalization', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-project-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('统计 intact / fixable / missing', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.mp4'), Buffer.from([0]));
    await fs.writeFile(path.join(tmpDir, 'b.mp4'), Buffer.from([0]));
    const absA = path.join(tmpDir, 'a.mp4');
    const summary = planAssetNormalization(tmpDir, [
      { kind: 'overlayAsset', refId: 'o1', originalPath: absA },
      { kind: 'overlayAsset', refId: 'o2', originalPath: '/Users/alice/old/b.mp4' },
      { kind: 'overlayAsset', refId: 'o3', originalPath: '/Users/alice/old/missing.mp4' },
    ]);
    expect(summary.totalReferences).toBe(3);
    expect(summary.intactCount).toBe(1);
    expect(summary.fixableCount).toBe(1);
    expect(summary.missingCount).toBe(1);
    expect(summary.missingItems[0].basename).toBe('missing.mp4');
  });

  it('空列表：返回零值', () => {
    const summary = planAssetNormalization(tmpDir, []);
    expect(summary.totalReferences).toBe(0);
    expect(summary.missingItems).toHaveLength(0);
  });
});

describe('normalizeAssetPaths', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-project-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('绝对路径存在：不修改', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.mp4'), Buffer.from([0]));
    const absPath = path.join(tmpDir, 'a.mp4');
    const data = makeProjectData(
      makeTimeline({
        overlays: [
          {
            id: 'o1',
            type: 'video',
            assetPath: absPath,
            trackId: 'visual-1',
            startMs: 0,
            durationMs: 1000,
            position: { x: 0, y: 0, width: 100, height: 100 },
          },
        ],
      }),
    );
    const { data: fixed, fixReport, changed } = normalizeAssetPaths(data, tmpDir);
    expect(changed).toBe(false);
    expect(fixReport.fixed).toHaveLength(0);
    expect(fixReport.missing).toHaveLength(0);
    expect(fixed.timeline?.overlays[0].assetPath).toBe(absPath);
  });

  it('绝对路径失效但 basename 命中：修复', async () => {
    await fs.mkdir(path.join(tmpDir, 'imports/douyin/v1'), { recursive: true });
    const newPath = path.join(tmpDir, 'imports/douyin/v1/clip.mp4');
    await fs.writeFile(newPath, Buffer.from([0]));
    const data = makeProjectData(
      makeTimeline({
        overlays: [
          {
            id: 'o1',
            type: 'video',
            assetPath: '/Users/alice/oldproject/imports/douyin/v1/clip.mp4',
            trackId: 'visual-1',
            startMs: 0,
            durationMs: 1000,
            position: { x: 0, y: 0, width: 100, height: 100 },
          },
        ],
      }),
    );
    const { data: fixed, fixReport, changed } = normalizeAssetPaths(data, tmpDir);
    expect(changed).toBe(true);
    expect(fixReport.fixed).toHaveLength(1);
    expect(fixed.timeline?.overlays[0].assetPath).toBe(newPath);
  });

  it('basename 无匹配：记入 missing', () => {
    const data = makeProjectData(
      makeTimeline({
        overlays: [
          {
            id: 'o1',
            type: 'video',
            assetPath: '/Users/alice/missing.mp4',
            trackId: 'visual-1',
            startMs: 0,
            durationMs: 1000,
            position: { x: 0, y: 0, width: 100, height: 100 },
          },
        ],
      }),
    );
    const { fixReport, changed } = normalizeAssetPaths(data, tmpDir);
    expect(changed).toBe(false);
    expect(fixReport.missing).toHaveLength(1);
    expect(fixReport.missing[0].basename).toBe('missing.mp4');
  });

  it('podcast.audioPath 与 srtPath 均被修复', async () => {
    await fs.writeFile(path.join(tmpDir, 'podcast-audio.mp3'), Buffer.from([0]));
    await fs.writeFile(path.join(tmpDir, 'podcast-subtitles.srt'), Buffer.from([0]));
    const data = makeProjectData(
      makeTimeline({
        podcast: {
          audioPath: '/Users/alice/oldproject/podcast-audio.mp3',
          srtPath: '/Users/alice/oldproject/podcast-subtitles.srt',
          durationMs: 0,
        },
      }),
    );
    const { data: fixed, fixReport } = normalizeAssetPaths(data, tmpDir);
    expect(fixReport.fixed).toHaveLength(2);
    expect(fixed.timeline?.podcast.audioPath).toBe(path.join(tmpDir, 'podcast-audio.mp3'));
    expect(fixed.timeline?.podcast.srtPath).toBe(path.join(tmpDir, 'podcast-subtitles.srt'));
  });

  it('多个同名文件：选路径最浅', async () => {
    await fs.writeFile(path.join(tmpDir, 'clip.mp4'), Buffer.from([0]));
    await fs.mkdir(path.join(tmpDir, 'sub/deep'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'sub/deep/clip.mp4'), Buffer.from([0]));
    const data = makeProjectData(
      makeTimeline({
        overlays: [
          {
            id: 'o1',
            type: 'video',
            assetPath: '/old/clip.mp4',
            trackId: 'visual-1',
            startMs: 0,
            durationMs: 1000,
            position: { x: 0, y: 0, width: 100, height: 100 },
          },
        ],
      }),
    );
    const { data: fixed } = normalizeAssetPaths(data, tmpDir);
    expect(fixed.timeline?.overlays[0].assetPath).toBe(path.join(tmpDir, 'clip.mp4'));
  });

  it('相对路径能 resolve 到 projectDir 下：保持不变', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.mp4'), Buffer.from([0]));
    const data = makeProjectData(
      makeTimeline({
        overlays: [
          {
            id: 'o1',
            type: 'video',
            assetPath: 'a.mp4',
            trackId: 'visual-1',
            startMs: 0,
            durationMs: 1000,
            position: { x: 0, y: 0, width: 100, height: 100 },
          },
        ],
      }),
    );
    const { data: fixed, changed } = normalizeAssetPaths(data, tmpDir);
    expect(changed).toBe(false);
    expect(fixed.timeline?.overlays[0].assetPath).toBe('a.mp4');
  });

  it('timeline 为 null：无动作', () => {
    const data = makeProjectData(null);
    const { fixReport, changed } = normalizeAssetPaths(data, tmpDir);
    expect(changed).toBe(false);
    expect(fixReport.fixed).toHaveLength(0);
  });
});

describe('importProject', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-project-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('S1 完整项目：修复素材路径并持久化到 project.json', async () => {
    await fs.writeFile(path.join(tmpDir, 'clip.mp4'), Buffer.from([0]));
    const timeline = makeTimeline({
      overlays: [
        {
          id: 'o1',
          type: 'video',
          assetPath: '/old/clip.mp4',
          trackId: 'visual-1',
          startMs: 0,
          durationMs: 1000,
          position: { x: 0, y: 0, width: 100, height: 100 },
        },
      ],
    });
    await fs.writeFile(
      path.join(tmpDir, 'project.json'),
      JSON.stringify(makeProjectData(timeline)),
    );

    const result = await importProject({ projectDir: tmpDir, acceptMissingAssets: false });
    expect(result.scenario).toBe('complete');
    expect(result.fixReport.fixed).toHaveLength(1);

    const after = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'project.json'), 'utf-8'),
    ) as ProjectData;
    expect(after.timeline?.overlays[0].assetPath).toBe(path.join(tmpDir, 'clip.mp4'));
  });

  it('unrecognized 空目录：抛 ImportProjectError', async () => {
    await expect(
      importProject({ projectDir: tmpDir, acceptMissingAssets: false }),
    ).rejects.toMatchObject({ code: 'unrecognized' });
  });

  it('missing 未勾选：抛错；勾选：成功', async () => {
    const timeline = makeTimeline({
      overlays: [
        {
          id: 'o1',
          type: 'video',
          assetPath: '/old/missing.mp4',
          trackId: 'visual-1',
          startMs: 0,
          durationMs: 1000,
          position: { x: 0, y: 0, width: 100, height: 100 },
        },
      ],
    });
    await fs.writeFile(
      path.join(tmpDir, 'project.json'),
      JSON.stringify(makeProjectData(timeline)),
    );

    await expect(
      importProject({ projectDir: tmpDir, acceptMissingAssets: false }),
    ).rejects.toMatchObject({ code: 'missing_assets' });

    const result = await importProject({ projectDir: tmpDir, acceptMissingAssets: true });
    expect(result.fixReport.missing).toHaveLength(1);
  });

  it('只有 timeline.json：按无法识别拒绝导入', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'timeline.json'),
      JSON.stringify(makeTimeline()),
    );
    await expect(
      importProject({ projectDir: tmpDir, acceptMissingAssets: false }),
    ).rejects.toMatchObject({ code: 'unrecognized' });
  });

  it('S3 mediaOnly：创建骨架 project.json', async () => {
    await fs.writeFile(path.join(tmpDir, 'podcast-audio.mp3'), Buffer.from([0]));
    await fs.writeFile(path.join(tmpDir, 'script.md'), '# x');
    const result = await importProject({ projectDir: tmpDir, acceptMissingAssets: false });
    expect(result.scenario).toBe('mediaOnly');
    expect(result.fixReport.fixed).toHaveLength(0);
    const exists = await fs
      .access(path.join(tmpDir, 'project.json'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });
});
