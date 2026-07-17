import { describe, expect, it } from 'vitest';
import { buildMediaReuseKey, findReusableMediaAssets } from '../src/lib/media-asset-resolution';
import type { AssetLibraryFile, AssetRecord } from '../src/types/assets';
import type { MediaAssetRequest } from '../src/types/production';
import { DEFAULT_ASSET_TREATMENT } from '../src/types/assets';

function audioAsset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: 'bgm-1',
    name: '克制知识播客背景音乐',
    kind: 'audio',
    role: 'bgm',
    sourceType: 'ai-generated',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    files: { original: '/assets/bgm.mp3' },
    metadata: {
      durationMs: 210_000,
      contentHash: 'sha256:a',
      byteSize: 10,
      audio: { loopable: true, energy: 2 },
      quality: { status: 'passed' },
    },
    semantic: { tags: ['知识', '克制'], topics: ['播客'], style: ['现代'], usableAs: ['bgm'] },
    treatment: DEFAULT_ASSET_TREATMENT,
    usage: { projectRefs: [], favorite: true, usageCount: 2 },
    ...overrides,
  };
}

function request(): MediaAssetRequest {
  const base = {
    kind: 'audio' as const,
    role: 'bgm',
    query: '克制的知识播客背景音乐',
    reusePolicy: 'prefer-library' as const,
    constraints: { durationRangeMs: [180_000, 260_000] as [number, number], loopable: true, energy: 2 as const },
  };
  return { id: 'req-1', ...base, reuseKey: buildMediaReuseKey(base) };
}

describe('media asset resolution', () => {
  it('同 reuseKey 的合格音频达到自动复用阈值', () => {
    const req = request();
    const library: AssetLibraryFile = {
      version: 2,
      libraryId: 'default',
      settings: { rootDir: '/assets', defaultImportMode: 'copy', defaultProjectReferenceMode: 'reference-global' },
      assets: [audioAsset({ metadata: { ...audioAsset().metadata, reuseKey: req.reuseKey } })],
      updatedAt: '2026-07-11T00:00:00.000Z',
    };
    const candidates = findReusableMediaAssets(req, library);
    expect(candidates[0].score).toBeGreaterThanOrEqual(75);
    expect(candidates[0].reasons).toContain('生成规格完全一致');
  });

  it('弃用或时长不合格素材不会参与匹配', () => {
    const req = request();
    const library: AssetLibraryFile = {
      version: 2,
      libraryId: 'default',
      settings: { rootDir: '/assets', defaultImportMode: 'copy', defaultProjectReferenceMode: 'reference-global' },
      assets: [audioAsset({ usage: { projectRefs: [], favorite: false, deprecated: true } })],
      updatedAt: '2026-07-11T00:00:00.000Z',
    };
    expect(findReusableMediaAssets(req, library)).toEqual([]);
  });

  it('AI 生成素材未通过质检时不会参与匹配', () => {
    const req = request();
    const pending = audioAsset({
      metadata: { ...audioAsset().metadata, reuseKey: req.reuseKey, quality: { status: 'pending' } },
    });
    const library: AssetLibraryFile = {
      version: 2,
      libraryId: 'default',
      settings: { rootDir: '/assets', defaultImportMode: 'copy', defaultProjectReferenceMode: 'reference-global' },
      assets: [pending],
      updatedAt: '2026-07-11T00:00:00.000Z',
    };
    expect(findReusableMediaAssets(req, library)).toEqual([]);
  });

  it('缺少必需音频元数据时保留为人工候选但禁止自动复用', () => {
    const base = request();
    const req: MediaAssetRequest = {
      ...base,
      constraints: { ...base.constraints, transientType: 'whoosh' },
    };
    const candidate = findReusableMediaAssets(req, {
      version: 2,
      libraryId: 'default',
      settings: { rootDir: '/assets', defaultImportMode: 'copy', defaultProjectReferenceMode: 'reference-global' },
      assets: [audioAsset({ metadata: { ...audioAsset().metadata, reuseKey: req.reuseKey } })],
      updatedAt: '2026-07-11T00:00:00.000Z',
    })[0];
    expect(candidate.score).toBe(74);
    expect(candidate.reasons).toContain('瞬态类型元数据缺失');
  });

  it('能量、瞬态类型和情绪标签参与匹配解释', () => {
    const base = request();
    const req: MediaAssetRequest = {
      ...base,
      constraints: {
        ...base.constraints,
        mood: ['克制'],
        energy: 2,
        transientType: 'impact',
      },
    };
    const asset = audioAsset({
      metadata: {
        ...audioAsset().metadata,
        reuseKey: req.reuseKey,
        audio: { loopable: true, energy: 2, transientType: 'impact' },
      },
    });
    const candidate = findReusableMediaAssets(req, {
      version: 2,
      libraryId: 'default',
      settings: { rootDir: '/assets', defaultImportMode: 'copy', defaultProjectReferenceMode: 'reference-global' },
      assets: [asset],
      updatedAt: '2026-07-11T00:00:00.000Z',
    })[0];
    expect(candidate.score).toBeGreaterThanOrEqual(75);
    expect(candidate.reasons).toEqual(expect.arrayContaining([
      '能量一致',
      '瞬态类型一致',
      '命中 1 个情绪标签',
    ]));
  });

  it('可循环素材允许长于请求区间并在使用时裁切', () => {
    const req = request();
    const long = audioAsset({
      metadata: { ...audioAsset().metadata, durationMs: 300_000, reuseKey: req.reuseKey },
    });
    const candidates = findReusableMediaAssets(req, {
      version: 2,
      libraryId: 'default',
      settings: { rootDir: '/assets', defaultImportMode: 'copy', defaultProjectReferenceMode: 'reference-global' },
      assets: [long],
      updatedAt: '2026-07-11T00:00:00.000Z',
    });
    expect(candidates).toHaveLength(1);
  });
});
