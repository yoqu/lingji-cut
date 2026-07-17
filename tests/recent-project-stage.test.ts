import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deriveProjectStage } from '../electron/recent-projects';
import {
  createDefaultProjectData,
  resolvePublishedPlatforms,
  type ProjectData,
  type PublishHistoryEntry,
} from '../src/lib/project-persistence';

function historyEntry(overrides: Partial<PublishHistoryEntry>): PublishHistoryEntry {
  return {
    id: 'h1',
    publishedAt: 1000,
    fileName: 'a.mp4',
    filePath: '/tmp/a.mp4',
    shared: { title: 't', desc: '', tags: [] },
    targets: [{ accountId: 'douyin_a', platform: 'douyin', accountName: 'a' }],
    results: { douyin_a: { state: 'success' } },
    overallState: 'success',
    ...overrides,
  };
}

describe('resolvePublishedPlatforms', () => {
  it('prefers explicit publishedPlatforms field', () => {
    const data = {
      publish: { publishedPlatforms: { bilibili: 42 } },
    } as unknown as ProjectData;
    expect(resolvePublishedPlatforms(data)).toEqual({ bilibili: 42 });
  });

  it('backfills from history success results for legacy projects', () => {
    const data = {
      publish: {
        history: [
          historyEntry({}),
          historyEntry({
            id: 'h2',
            publishedAt: 2000,
            targets: [
              { accountId: 'douyin_a', platform: 'douyin', accountName: 'a' },
              { accountId: 'kuaishou_b', platform: 'kuaishou', accountName: 'b' },
            ],
            results: {
              douyin_a: { state: 'success' },
              kuaishou_b: { state: 'failed' },
            },
            overallState: 'partial',
          }),
        ],
      },
    } as unknown as ProjectData;
    // 失败的平台不算已发布；同平台取最近成功时间
    expect(resolvePublishedPlatforms(data)).toEqual({ douyin: 2000 });
  });
});

describe('deriveProjectStage', () => {
  it('marks published projects with platform list', () => {
    const data = createDefaultProjectData();
    data.publish = {
      title: '',
      desc: '',
      tagsInput: '',
      thumbnail: '',
      publishedPlatforms: { douyin: 1, bilibili: 2 },
    };
    expect(deriveProjectStage('/nonexistent', data)).toEqual({
      stage: 'published',
      publishedPlatforms: ['douyin', 'bilibili'],
    });
  });

  it('falls back to editing when timeline exists', () => {
    const data = createDefaultProjectData();
    data.timeline = { tracks: [] } as unknown as ProjectData['timeline'];
    expect(deriveProjectStage('/nonexistent', data)).toEqual({ stage: 'editing' });
  });

  it('derives script/original/new from disk artifacts', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-stage-'));
    try {
      expect(deriveProjectStage(dir, null)).toEqual({ stage: 'new' });
      writeFileSync(path.join(dir, 'original.md'), '素材');
      expect(deriveProjectStage(dir, null)).toEqual({ stage: 'original' });
      writeFileSync(path.join(dir, 'script.md'), '口播稿');
      expect(deriveProjectStage(dir, null)).toEqual({ stage: 'script' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
