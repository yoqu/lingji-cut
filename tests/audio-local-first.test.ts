import { describe, expect, it, vi } from 'vitest';
import { resolveOrGenerateAudioAsset } from '../src/lib/audio-gen/local-first';
import type { AssetLibraryFile, AssetRecord } from '../src/types/assets';
import type { MediaAssetRequest } from '../src/types/production';

function asset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: 'audio-1',
    name: '克制知识播客背景音乐',
    kind: 'audio',
    role: 'bgm',
    sourceType: 'ai-generated',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    files: { original: '/library/audio.mp3' },
    metadata: {
      contentHash: 'sha256:file',
      byteSize: 100,
      durationMs: 180_000,
      reuseKey: 'audio:bgm:exact',
      audio: { loopable: true, energy: 2 },
      quality: { status: 'passed' },
    },
    semantic: { tags: ['克制', '知识', '播客'], topics: [], style: [], usableAs: ['bgm'] },
    treatment: {
      profile: 'editorial-realist-cutout',
      lighting: '',
      palette: '',
      shadow: '',
      perspective: '',
    },
    usage: { projectRefs: [], favorite: false, usageCount: 0 },
    ...overrides,
  };
}

function library(assets: AssetRecord[]): AssetLibraryFile {
  return {
    version: 2,
    libraryId: 'test',
    settings: {
      rootDir: '/library',
      defaultImportMode: 'copy',
      defaultProjectReferenceMode: 'reference-global',
    },
    assets,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function request(reuseKey = 'audio:bgm:exact'): MediaAssetRequest {
  return {
    id: 'bgm-main',
    kind: 'audio',
    role: 'bgm',
    query: '克制知识播客背景音乐',
    reusePolicy: 'prefer-library',
    constraints: { durationRangeMs: [120_000, 240_000], loopable: true },
    reuseKey,
    required: true,
  };
}

function deps() {
  return {
    createMusic: vi.fn(async () => ({ taskId: 'task-1' })),
    createSound: vi.fn(async () => ({ taskId: 'sound-1' })),
    getTask: vi.fn(async () => ({
      taskId: 'task-1',
      state: 'succeeded' as const,
      vendorStatus: 'SUCCESS',
      candidates: [],
    })),
    materialize: vi.fn(async () => [asset({ id: 'generated' })]),
    sleep: vi.fn(async () => undefined),
  };
}

describe('resolveOrGenerateAudioAsset', () => {
  it('同 reuseKey 命中时直接复用且不调用 SunoAPI', async () => {
    const api = deps();
    const result = await resolveOrGenerateAudioAsset({
      request: request(),
      library: library([asset()]),
      mode: 'auto',
      deps: api,
    });

    expect(result.kind).toBe('reused');
    expect(api.createMusic).not.toHaveBeenCalled();
    expect(api.materialize).not.toHaveBeenCalled();
  });

  it('缺失时只提交一次并在成功后物化入库', async () => {
    const api = deps();
    const result = await resolveOrGenerateAudioAsset({
      request: request('audio:bgm:missing'),
      library: library([]),
      mode: 'auto',
      pollIntervalMs: 1,
      timeoutMs: 100,
      deps: api,
    });

    expect(result.kind).toBe('generated');
    expect(api.createMusic).toHaveBeenCalledTimes(1);
    expect(api.getTask).toHaveBeenCalledTimes(1);
    expect(api.materialize).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      audio: { energy: undefined, transientType: undefined },
    }));
  });

  it('同 reuseKey 并发缺失时共享同一个生成任务', async () => {
    const api = deps();
    let release: (() => void) | undefined;
    api.getTask.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({
        taskId: 'task-1',
        state: 'succeeded' as const,
        vendorStatus: 'SUCCESS',
        candidates: [],
      });
    }));
    const args = {
      request: request('audio:bgm:concurrent'),
      library: library([]),
      mode: 'auto' as const,
      pollIntervalMs: 1,
      timeoutMs: 100,
      deps: api,
    };
    const first = resolveOrGenerateAudioAsset(args);
    const second = resolveOrGenerateAudioAsset(args);
    await vi.waitFor(() => expect(api.createMusic).toHaveBeenCalledTimes(1));
    release?.();
    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(right);
    expect(api.materialize).toHaveBeenCalledTimes(1);
  });

  it('导演模式将中等匹配交给用户确认而不是生成', async () => {
    const api = deps();
    const medium = asset({
      name: '候选音乐',
      metadata: { ...asset().metadata, reuseKey: undefined },
      semantic: { tags: ['克制', '知识'], topics: [], style: [], usableAs: ['bgm'] },
      usage: { projectRefs: [], favorite: true, usageCount: 0 },
    });
    const mediumRequest = { ...request('audio:bgm:different'), query: '克制 知识' };
    const result = await resolveOrGenerateAudioAsset({
      request: mediumRequest,
      library: library([medium]),
      mode: 'director',
      deps: api,
    });

    expect(result.kind).toBe('needs-review');
    expect(api.createMusic).not.toHaveBeenCalled();
  });
});
