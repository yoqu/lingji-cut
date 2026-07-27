import { describe, expect, it } from 'vitest';
import {
  buildAssetGenerationRequest,
  buildManualAssetBinding,
  manualCardAssetCandidateNames,
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

describe('手动素材约定（卡目录用户文件优先）', () => {
  it('manualCardAssetCandidateNames：slot 名各扩展名在前，序号名兜底', () => {
    const names = manualCardAssetCandidateNames(request(), 0);
    expect(names[0]).toBe('archive_prop.png');
    expect(names).toContain('archive_prop.webp');
    expect(names).toContain('asset-1.png');
    // slot 名全部优先于序号名
    expect(names.indexOf('archive_prop.webp')).toBeLessThan(names.indexOf('asset-1.png'));
    expect(names.indexOf('asset-2.png')).toBe(-1);
  });

  it('manualCardAssetCandidateNames：序号为 assets 数组内 1 基下标', () => {
    const names = manualCardAssetCandidateNames(request({ slot: 'chip' }), 2);
    expect(names[0]).toBe('chip.png');
    expect(names).toContain('asset-3.png');
  });

  it('buildManualAssetBinding：placement/motion 与库资产绑定同源，treatment 取分镜声明', () => {
    const manual = buildManualAssetBinding(
      request({ revealBeat: 2, visualTreatment: 'documentary-desk' }),
      'ai-cards/card-1/archive_prop.png',
      0,
    );
    const fromLibrary = resolveStoryboardAssets({
      requests: [request({ revealBeat: 2 })],
      library: library([asset({})]),
      projectManifest: null,
    }).bindings[0]!;

    expect(manual.slot).toBe('archive_prop');
    expect(manual.assetId).toBe('manual:ai-cards/card-1/archive_prop.png');
    expect(manual.filePath).toBe('ai-cards/card-1/archive_prop.png');
    expect(manual.request?.query).toBe('旧档案袋');
    // placement / motion 与库资产解析结果一致（同一 bindingShell）
    expect(manual.placement).toEqual(fromLibrary.placement);
    expect(manual.motion).toEqual({ ...fromLibrary.motion, revealBeat: 2 });
    // treatment 用分镜声明的处理风格；库资产用资产自身 treatment
    expect(manual.treatment.profile).toBe('documentary-desk');
    expect(manual.treatment.shadow).toBe(DEFAULT_ASSET_TREATMENT.shadow);
  });

  it('buildManualAssetBinding：background 角色按全幅底图处理', () => {
    const manual = buildManualAssetBinding(
      request({ role: 'background', importance: 'ambient' }),
      'ai-cards/card-1/asset-1.jpg',
      1,
    );
    expect(manual.placement.depth).toBe('background');
    expect(manual.placement.width).toBe(1920);
    expect(manual.motion?.enter).toBe('fade-in');
    expect(manual.motion?.exit).toBe('fade-out');
  });
});

describe('layout 感知 placement（与 SafeLayout 网格严格对齐，1920×1080 基准）', () => {
  it('layout=asset-led：主资产通栏左格 x192/y86/w974/h778，无旋转（边缘严格对齐）', () => {
    const result = resolveStoryboardAssets({
      requests: [request({ placementHint: '左侧通栏' })],
      library: library([asset({ id: 'archive' })]),
      projectManifest: projectManifest(['archive']),
      layout: 'asset-led',
    });

    expect(result.bindings[0].placement).toEqual({
      referenceWidth: 1920,
      referenceHeight: 1080,
      x: 192,
      y: 86,
      width: 974,
      height: 778,
      opacity: 0.96,
      depth: 'foreground',
    });
    // 贴齐内容盒：左缘 192 = W*0.1，底缘 86+778 = 864 = H*0.8（字幕安全区之外）
    expect(result.bindings[0].placement.y + (result.bindings[0].placement.height ?? 0)).toBe(864);
  });

  it('layout=asset-aside：主资产右格 x1091/w637（修掉 x1260/w540 旧近似），bottom hint 下移', () => {
    const top = resolveStoryboardAssets({
      requests: [request({ placementHint: '右侧' })],
      library: library([asset({ id: 'archive' })]),
      projectManifest: projectManifest(['archive']),
      layout: 'asset-aside',
    });
    expect(top.bindings[0].placement).toMatchObject({
      x: 1091,
      y: 210,
      width: 637,
      rotation: 2,
      opacity: 0.96,
      depth: 'foreground',
    });
    // 贴齐 asset-aside 右格：1091.27→1728（内容盒右缘 W*0.9）
    expect(top.bindings[0].placement.x + top.bindings[0].placement.width).toBe(1728);

    const bottom = resolveStoryboardAssets({
      requests: [request({ placementHint: '右下角' })],
      library: library([asset({ id: 'archive' })]),
      projectManifest: projectManifest(['archive']),
      layout: 'asset-aside',
    });
    expect(bottom.bindings[0].placement.y).toBe(320);
  });

  it('缺省 layout：保持旧行为（placementHint 推导落点，不对齐网格）', () => {
    const result = resolveStoryboardAssets({
      requests: [request({ placementHint: '右侧' })],
      library: library([asset({ id: 'archive' })]),
      projectManifest: projectManifest(['archive']),
    });
    expect(result.bindings[0].placement).toMatchObject({ x: 1260, y: 210, width: 540, rotation: 2 });
  });

  it('secondary / ambient 资产不受 layout 影响（只有 primary 对齐网格）', () => {
    const result = resolveStoryboardAssets({
      requests: [request({ importance: 'secondary' })],
      library: library([asset({ id: 'archive' })]),
      projectManifest: projectManifest(['archive']),
      layout: 'asset-led',
    });
    expect(result.bindings[0].placement).toMatchObject({ x: 150, width: 340, depth: 'midground' });
  });

  it('手动素材约定同样按 layout 对齐 placement（与库资产同源）', () => {
    const manual = buildManualAssetBinding(
      request({ placementHint: '右侧' }),
      'ai-cards/card-1/archive_prop.png',
      0,
      'asset-led',
    );
    expect(manual.placement).toMatchObject({ x: 192, y: 86, width: 974, height: 778 });
  });
});
