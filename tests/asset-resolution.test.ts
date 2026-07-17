import { describe, expect, it } from 'vitest';
import {
  buildAssetGenerationRequest,
  resolveStoryboardAssets,
} from '../src/lib/asset-resolution';
import {
  DEFAULT_ASSET_TREATMENT,
  type AssetLibraryFile,
  type AssetRecord,
  type ProjectAssetManifest,
  type StoryboardAssetRequest,
} from '../src/types/assets';

const asset = (overrides: Partial<AssetRecord>): AssetRecord => ({
  id: 'asset-1',
  name: '旧档案袋',
  kind: 'image',
  role: 'object',
  sourceType: 'manual-import',
  createdAt: '2026-07-08T00:00:00.000Z',
  updatedAt: '2026-07-08T00:00:00.000Z',
  files: {
    original: '/tmp/archive.png',
    processed: '/tmp/archive-cutout.png',
    thumbnail: '/tmp/archive-thumb.png',
    mask: null,
  },
  metadata: {
    width: 800,
    height: 600,
    contentHash: 'sha256:test',
    byteSize: 1024,
  },
  semantic: {
    tags: ['档案袋'],
    topics: ['教育'],
    style: ['写实'],
    usableAs: ['foreground-object'],
  },
  treatment: DEFAULT_ASSET_TREATMENT,
  usage: {
    projectRefs: [],
    favorite: false,
  },
  ...overrides,
});

const library = (assets: AssetRecord[]): AssetLibraryFile => ({
  version: 2,
  libraryId: 'default',
  settings: {
    rootDir: '/tmp/library',
    defaultImportMode: 'copy',
    defaultProjectReferenceMode: 'reference-global',
  },
  assets,
  updatedAt: '2026-07-08T00:00:00.000Z',
});

const projectManifest = (
  assetIds: string[] = [],
  overrides: Partial<ProjectAssetManifest> = {},
): ProjectAssetManifest => ({
  version: 1,
  projectDir: '/tmp/project',
  assetRefs: assetIds.map((assetId) => ({
    assetId,
    scope: 'global',
    globalLibraryId: 'default',
    snapshotPath: null,
    addedAt: '2026-07-08T00:00:00.000Z',
    usedBy: [],
  })),
  generationRequests: [],
  updatedAt: '2026-07-08T00:00:00.000Z',
  ...overrides,
});

const request = (overrides: Partial<StoryboardAssetRequest> = {}): StoryboardAssetRequest => ({
  slot: 'archive_prop',
  query: '旧档案袋',
  role: 'object',
  importance: 'primary',
  reusePolicy: 'prefer-library',
  visualTreatment: 'editorial-realist-cutout',
  placementHint: '放在左下角作为前景物件',
  ...overrides,
});

describe('resolveStoryboardAssets', () => {
  it('优先把 storyboard 资产请求匹配到素材库并生成绑定', () => {
    const result = resolveStoryboardAssets({
      requests: [request()],
      library: library([asset({ id: 'archive' })]),
      projectManifest: projectManifest(['archive']),
      sourceCardId: 'card-1',
    });

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]).toMatchObject({
      slot: 'archive_prop',
      assetId: 'archive',
      filePath: '/tmp/archive-cutout.png',
      placement: {
        depth: 'foreground',
      },
      motion: {
        enter: 'fade-up-soft',
        emphasis: 'subtle-parallax',
      },
    });
    expect(result.generationRequests).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0);
  });

  it('缺少匹配素材时为 generate-if-missing 创建待生成请求', () => {
    const result = resolveStoryboardAssets({
      requests: [request({ query: '芯片样品', reusePolicy: 'generate-if-missing' })],
      library: library([]),
      projectManifest: projectManifest(),
      sourceCardId: 'card-2',
    });

    expect(result.bindings).toHaveLength(0);
    expect(result.generationRequests).toHaveLength(1);
    expect(result.generationRequests[0]).toMatchObject({
      slot: 'archive_prop',
      query: '芯片样品',
      status: 'pending',
      sourceCardId: 'card-2',
    });
    expect(result.generationRequests[0].prompt).toContain('绿幕');
  });

  it('manual-only 缺少匹配时进入 unresolved 而不自动生成', () => {
    const result = resolveStoryboardAssets({
      requests: [request({ query: '绝版书封面', reusePolicy: 'manual-only' })],
      library: library([]),
      projectManifest: projectManifest(),
    });

    expect(result.bindings).toHaveLength(0);
    expect(result.generationRequests).toHaveLength(0);
    expect(result.unresolved[0].query).toBe('绝版书封面');
  });

  it('背景资产生成完整场景而不是绿幕物件', () => {
    const result = resolveStoryboardAssets({
      requests: [request({
        query: '旧档案室',
        role: 'background',
        reusePolicy: 'generate-if-missing',
      })],
      library: library([]),
      projectManifest: projectManifest(),
    });

    expect(result.generationRequests[0]?.prompt).toContain('完整画面');
    expect(result.generationRequests[0]?.prompt).toContain('不要绿幕背景');
  });

  it('复用同一卡片已确认入库的生成结果，避免 always-generate 重复生成', () => {
    const result = resolveStoryboardAssets({
      requests: [request({ reusePolicy: 'always-generate' })],
      library: library([asset({ id: 'generated-archive' })]),
      projectManifest: projectManifest(['generated-archive'], {
        generationRequests: [
          {
            id: 'asset_gen_done',
            slot: 'archive_prop',
            query: '旧档案袋',
            role: 'object',
            importance: 'primary',
            reusePolicy: 'always-generate',
            visualTreatment: 'editorial-realist-cutout',
            prompt: '生成旧档案袋',
            status: 'accepted',
            sourceCardId: 'card-1',
            resultAssetId: 'generated-archive',
            generatedFilePath: '/tmp/archive.png',
            createdAt: '2026-07-08T00:00:00.000Z',
            updatedAt: '2026-07-08T00:00:00.000Z',
          },
        ],
      }),
      sourceCardId: 'card-1',
    });

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].assetId).toBe('generated-archive');
    expect(result.generationRequests).toHaveLength(0);
  });

  it('待确认的自动生成结果可立即用于当前卡片且不会重复生成', () => {
    const result = resolveStoryboardAssets({
      requests: [request({ reusePolicy: 'always-generate' })],
      library: library([asset({ id: 'ready-archive' })]),
      projectManifest: projectManifest(['ready-archive'], {
        generationRequests: [{
          id: 'asset_gen_ready',
          slot: 'archive_prop',
          query: '旧档案袋',
          role: 'object',
          importance: 'primary',
          reusePolicy: 'always-generate',
          visualTreatment: 'editorial-realist-cutout',
          prompt: '生成旧档案袋',
          status: 'ready',
          sourceCardId: 'card-1',
          resultAssetId: 'ready-archive',
          createdAt: '2026-07-08T00:00:00.000Z',
          updatedAt: '2026-07-08T00:00:00.000Z',
        }],
      }),
      sourceCardId: 'card-1',
    });

    expect(result.bindings[0]?.assetId).toBe('ready-archive');
    expect(result.generationRequests).toHaveLength(0);
  });

  it('项目本地扫描资产不写入 manifest 也会参与匹配并获得项目加权', () => {
    const result = resolveStoryboardAssets({
      requests: [request()],
      library: library([
        asset({
          id: 'global-weak',
          name: '旧档案袋',
          semantic: {
            tags: [],
            topics: [],
            style: ['写实'],
            usableAs: ['foreground-object'],
          },
        }),
        asset({
          id: 'project-local',
          name: '旧档案袋',
          sourceType: 'project-local',
          files: {
            original: '/tmp/project/ai-cards/c1/image.png',
            processed: '/tmp/project/ai-cards/c1/image-cutout.png',
            thumbnail: '/tmp/project/ai-cards/c1/image-cutout.png',
            mask: null,
          },
        }),
      ]),
      projectManifest: projectManifest(),
      sourceCardId: 'card-1',
    });

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]).toMatchObject({
      assetId: 'project-local',
      filePath: '/tmp/project/ai-cards/c1/image-cutout.png',
    });
  });
});

describe('buildAssetGenerationRequest', () => {
  it('生成可入队的资产请求 payload', () => {
    const generated = buildAssetGenerationRequest(
      request({ negativePrompt: '不要文字、水印、手部' }),
      'card-3',
    );

    expect(generated.id).toMatch(/^asset_gen_/);
    expect(generated.status).toBe('pending');
    expect(generated.prompt).toContain('旧档案袋');
    expect(generated.prompt).toContain('避免：不要文字、水印、手部');
  });

  it('diagram-prop 使用明显非写实的卡通编辑插画提示', () => {
    const generated = buildAssetGenerationRequest(
      request({
        query: '上市敲钟的象征性场景',
        visualTreatment: 'diagram-prop',
      }),
      'card-news',
    );

    expect(generated.prompt).toContain('卡通编辑插画');
    expect(generated.prompt).toContain('不可被误认为真实照片或新闻现场');
    expect(generated.prompt).not.toContain('低饱和写实摄影');
  });
});
