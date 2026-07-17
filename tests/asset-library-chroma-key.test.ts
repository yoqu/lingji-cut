import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyAssetUpdatePatch,
  auditAssetLibraryState,
  chromaKeyAsset,
  deleteAssetLibraryAsset,
  normalizeResolvableAssetLibrary,
  replaceOriginalWithProcessedAsset,
  sampleAssetColor,
  scanProjectAssetRecords,
} from '../electron/asset-library';
import {
  decodePng,
  encodePng,
  type PngImage,
} from '../electron/green-screen-keyer';
import {
  DEFAULT_ASSET_TREATMENT,
  EMPTY_ASSET_SEMANTIC,
  type AssetLibraryFile,
  type ProjectAssetManifest,
} from '../src/types/assets';

const trashItemMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('electron', () => ({
  dialog: {},
  ipcMain: { handle: vi.fn() },
  nativeImage: {
    createFromBuffer: vi.fn(() => ({
      isEmpty: () => true,
      toPNG: () => Buffer.alloc(0),
    })),
  },
  shell: {
    trashItem: trashItemMock,
  },
}));

let tempDir = '';

function pixelOffset(image: PngImage, x: number, y: number): number {
  return (y * image.width + x) * 4;
}

function setPixel(image: PngImage, x: number, y: number, rgba: [number, number, number, number]) {
  const offset = pixelOffset(image, x, y);
  image.rgba[offset] = rgba[0];
  image.rgba[offset + 1] = rgba[1];
  image.rgba[offset + 2] = rgba[2];
  image.rgba[offset + 3] = rgba[3];
}

describe('asset-library chroma key flow', () => {
  afterEach(async () => {
    trashItemMock.mockClear();
    if (!tempDir) return;
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('更新音频角色和检索元数据时保留其他技术信息', () => {
    const asset = {
      id: 'audio_1', name: 'manual-bgm', kind: 'audio' as const, role: 'audio' as const,
      sourceType: 'manual-import' as const, createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z', files: { original: '/tmp/audio.wav' },
      metadata: {
        contentHash: 'sha256:test', byteSize: 1, durationMs: 90_000,
        audio: { integratedLufs: -18, loopable: false },
      },
      semantic: { ...EMPTY_ASSET_SEMANTIC }, treatment: DEFAULT_ASSET_TREATMENT,
      usage: { projectRefs: [], favorite: false },
    };
    const updated = applyAssetUpdatePatch(asset, {
      role: 'bgm',
      audio: { loopable: true, bpm: 92, energy: 2, key: 'C minor' },
    });
    expect(updated.role).toBe('bgm');
    expect(updated.metadata.audio).toMatchObject({
      integratedLufs: -18,
      loopable: true,
      bpm: 92,
      energy: 2,
      key: 'C minor',
    });
  });

  it('为已入库图片生成抠图文件并持久化 processed 路径', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'asset-library-key-'));
    const originalPath = path.join(tempDir, 'originals', 'images', 'asset_1.png');
    await mkdir(path.dirname(originalPath), { recursive: true });
    const source: PngImage = {
      width: 10,
      height: 10,
      rgba: Buffer.alloc(10 * 10 * 4),
    };
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        setPixel(source, x, y, [0, 220, 0, 255]);
      }
    }
    for (let y = 3; y <= 6; y += 1) {
      for (let x = 3; x <= 6; x += 1) {
        setPixel(source, x, y, [190, 40, 45, 255]);
      }
    }
    await writeFile(originalPath, encodePng(source));

    const library: AssetLibraryFile = {
      version: 2,
      libraryId: 'default',
      settings: {
        rootDir: tempDir,
        defaultImportMode: 'copy',
        defaultProjectReferenceMode: 'reference-global',
      },
      assets: [
        {
          id: 'asset_1',
          name: '绿幕柜体',
          kind: 'image',
          role: 'object',
          sourceType: 'manual-import',
          sourceUri: originalPath,
          createdAt: '2026-07-09T00:00:00.000Z',
          updatedAt: '2026-07-09T00:00:00.000Z',
          files: {
            original: originalPath,
            processed: originalPath,
            thumbnail: originalPath,
            mask: null,
          },
          metadata: {
            width: 10,
            height: 10,
            contentHash: 'sha256:test',
            byteSize: 1,
          },
          semantic: EMPTY_ASSET_SEMANTIC,
          treatment: DEFAULT_ASSET_TREATMENT,
          usage: {
            projectRefs: [],
            favorite: false,
          },
        },
      ],
      updatedAt: '2026-07-09T00:00:00.000Z',
    };
    await writeFile(path.join(tempDir, 'library.json'), JSON.stringify(library, null, 2));

    const sampled = await sampleAssetColor({ assetId: 'asset_1', xRatio: 0, yRatio: 0 }, tempDir);
    expect(sampled.keyColor).toBe('#00dc00');

    const result = await chromaKeyAsset({ assetId: 'asset_1', keyColor: sampled.keyColor }, tempDir);
    expect(result.outputPath).toContain(path.join('processed', 'cutouts'));
    expect((await stat(result.outputPath)).isFile()).toBe(true);
    expect(result.byteSize).toBeGreaterThan(0);

    const output = decodePng(await readFile(result.outputPath));
    expect(output.width).toBeLessThan(source.width);
    expect(output.rgba[3]).toBeLessThanOrEqual(8);
    expect(output.rgba[pixelOffset(output, Math.floor(output.width / 2), Math.floor(output.height / 2)) + 3]).toBeGreaterThan(200);

    const saved = JSON.parse(await readFile(path.join(tempDir, 'library.json'), 'utf-8')) as AssetLibraryFile;
    expect(saved.assets[0].files.processed).toBe(result.outputPath);
    expect(saved.assets[0].metadata.hasAlpha).toBe(true);
    expect(saved.assets[0].metadata.processedByteSize).toBe(result.byteSize);
    expect(saved.assets[0].metadata.processedColorKey).toBe('#00dc00');
  });

  it('支持把处理结果提升为原图并保留旧原图路径', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'asset-library-replace-original-'));
    const originalPath = path.join(tempDir, 'originals', 'images', 'asset_1.png');
    const processedPath = path.join(tempDir, 'processed', 'cutouts', 'asset_1-cutout.png');
    await mkdir(path.dirname(originalPath), { recursive: true });
    await mkdir(path.dirname(processedPath), { recursive: true });

    const original: PngImage = {
      width: 8,
      height: 8,
      rgba: Buffer.alloc(8 * 8 * 4, 255),
    };
    const processed: PngImage = {
      width: 4,
      height: 4,
      rgba: Buffer.alloc(4 * 4 * 4, 0),
    };
    for (let y = 0; y < processed.height; y += 1) {
      for (let x = 0; x < processed.width; x += 1) {
        setPixel(processed, x, y, [190, 40, 45, 255]);
      }
    }
    await writeFile(originalPath, encodePng(original));
    await writeFile(processedPath, encodePng(processed));

    const library: AssetLibraryFile = {
      version: 2,
      libraryId: 'default',
      settings: {
        rootDir: tempDir,
        defaultImportMode: 'copy',
        defaultProjectReferenceMode: 'reference-global',
      },
      assets: [
        {
          id: 'asset_1',
          name: '绿幕柜体',
          kind: 'image',
          role: 'object',
          sourceType: 'manual-import',
          sourceUri: originalPath,
          createdAt: '2026-07-09T00:00:00.000Z',
          updatedAt: '2026-07-09T00:00:00.000Z',
          files: {
            original: originalPath,
            processed: processedPath,
            thumbnail: processedPath,
            mask: null,
          },
          metadata: {
            width: 8,
            height: 8,
            contentHash: 'sha256:old',
            byteSize: 1,
            processedAt: '2026-07-09T01:00:00.000Z',
            processedByteSize: 2,
            processedColorKey: '#00ff00',
          },
          semantic: EMPTY_ASSET_SEMANTIC,
          treatment: DEFAULT_ASSET_TREATMENT,
          usage: {
            projectRefs: [],
            favorite: false,
          },
        },
      ],
      updatedAt: '2026-07-09T00:00:00.000Z',
    };
    await writeFile(path.join(tempDir, 'library.json'), JSON.stringify(library, null, 2));

    const result = await replaceOriginalWithProcessedAsset('asset_1', tempDir);
    const originalStat = await stat(originalPath);
    expect(result.asset.files.original).toBe(originalPath);
    expect(result.asset.files.thumbnail).toBe(originalPath);
    expect(result.asset.files.processed).toBe(processedPath);
    expect(result.asset.metadata.previousOriginalPath).toContain(path.join('originals', 'backups'));
    expect(result.asset.metadata.originalReplacedAt).toBeTruthy();
    expect(result.asset.metadata.width).toBe(4);
    expect(result.asset.metadata.height).toBe(4);
    expect(result.asset.metadata.byteSize).toBe(originalStat.size);
    expect(result.asset.metadata.contentHash).toMatch(/^sha256:/);
    expect(decodePng(await readFile(originalPath)).width).toBe(4);
    expect(decodePng(await readFile(result.asset.metadata.previousOriginalPath!)).width).toBe(8);

    const saved = JSON.parse(await readFile(path.join(tempDir, 'library.json'), 'utf-8')) as AssetLibraryFile;
    expect(saved.assets[0].files.original).toBe(originalPath);
    expect(saved.assets[0].metadata.previousOriginalPath).toBe(result.asset.metadata.previousOriginalPath);
  });

  it('修复旧替换逻辑已把原图指到处理目录的资产', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'asset-library-repair-original-'));
    const originalPath = path.join(tempDir, 'originals', 'images', 'asset_1.png');
    const processedPath = path.join(tempDir, 'processed', 'cutouts', 'asset_1-cutout.png');
    await mkdir(path.dirname(originalPath), { recursive: true });
    await mkdir(path.dirname(processedPath), { recursive: true });

    await writeFile(originalPath, encodePng({ width: 8, height: 8, rgba: Buffer.alloc(8 * 8 * 4, 255) }));
    await writeFile(processedPath, encodePng({ width: 4, height: 4, rgba: Buffer.alloc(4 * 4 * 4, 255) }));
    const library: AssetLibraryFile = {
      version: 2,
      libraryId: 'default',
      settings: {
        rootDir: tempDir,
        defaultImportMode: 'copy',
        defaultProjectReferenceMode: 'reference-global',
      },
      assets: [
        {
          id: 'asset_1',
          name: '绿幕柜体',
          kind: 'image',
          role: 'object',
          sourceType: 'manual-import',
          sourceUri: originalPath,
          createdAt: '2026-07-09T00:00:00.000Z',
          updatedAt: '2026-07-09T00:00:00.000Z',
          files: {
            original: processedPath,
            processed: processedPath,
            thumbnail: processedPath,
            mask: null,
          },
          metadata: {
            width: 4,
            height: 4,
            contentHash: 'sha256:old',
            byteSize: 1,
            previousOriginalPath: originalPath,
          },
          semantic: EMPTY_ASSET_SEMANTIC,
          treatment: DEFAULT_ASSET_TREATMENT,
          usage: {
            projectRefs: [],
            favorite: false,
          },
        },
      ],
      updatedAt: '2026-07-09T00:00:00.000Z',
    };
    await writeFile(path.join(tempDir, 'library.json'), JSON.stringify(library, null, 2));

    const result = await replaceOriginalWithProcessedAsset('asset_1', tempDir);
    expect(result.asset.files.original).toBe(originalPath);
    expect(result.asset.files.original).not.toBe(processedPath);
    expect(decodePng(await readFile(originalPath)).width).toBe(4);
  });

  it('删除资产时移除库记录、当前项目引用并回收库内文件', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'asset-library-delete-'));
    const projectDir = path.join(tempDir, 'project');
    const originalPath = path.join(tempDir, 'originals', 'images', 'asset_1.png');
    const processedPath = path.join(tempDir, 'processed', 'cutouts', 'asset_1.png');
    const externalPath = path.join(tmpdir(), 'external-source.png');
    await mkdir(path.dirname(originalPath), { recursive: true });
    await mkdir(path.dirname(processedPath), { recursive: true });
    await mkdir(path.join(projectDir, 'assets'), { recursive: true });
    await writeFile(originalPath, encodePng({ width: 2, height: 2, rgba: Buffer.alloc(2 * 2 * 4, 255) }));
    await writeFile(processedPath, encodePng({ width: 1, height: 1, rgba: Buffer.alloc(1 * 1 * 4, 255) }));

    const library: AssetLibraryFile = {
      version: 2,
      libraryId: 'default',
      settings: {
        rootDir: tempDir,
        defaultImportMode: 'copy',
        defaultProjectReferenceMode: 'reference-global',
      },
      assets: [
        {
          id: 'asset_1',
          name: '待删除资产',
          kind: 'image',
          role: 'object',
          sourceType: 'manual-import',
          sourceUri: externalPath,
          createdAt: '2026-07-09T00:00:00.000Z',
          updatedAt: '2026-07-09T00:00:00.000Z',
          files: {
            original: originalPath,
            processed: processedPath,
            thumbnail: processedPath,
            mask: null,
          },
          metadata: {
            width: 2,
            height: 2,
            contentHash: 'sha256:test',
            byteSize: 1,
          },
          semantic: EMPTY_ASSET_SEMANTIC,
          treatment: DEFAULT_ASSET_TREATMENT,
          usage: {
            projectRefs: [projectDir],
            favorite: false,
          },
        },
        {
          id: 'asset_2',
          name: '保留资产',
          kind: 'image',
          role: 'object',
          sourceType: 'manual-import',
          createdAt: '2026-07-09T00:00:00.000Z',
          updatedAt: '2026-07-09T00:00:00.000Z',
          files: {
            original: path.join(tempDir, 'originals', 'images', 'asset_2.png'),
            processed: null,
            thumbnail: null,
            mask: null,
          },
          metadata: {
            contentHash: 'sha256:keep',
            byteSize: 1,
          },
          semantic: EMPTY_ASSET_SEMANTIC,
          treatment: DEFAULT_ASSET_TREATMENT,
          usage: {
            projectRefs: [],
            favorite: false,
          },
        },
      ],
      updatedAt: '2026-07-09T00:00:00.000Z',
    };
    const manifest: ProjectAssetManifest = {
      version: 2,
      projectDir,
      assetRefs: [
        {
          assetId: 'asset_1',
          scope: 'global',
          globalLibraryId: 'default',
          snapshotPath: null,
          addedAt: '2026-07-09T00:00:00.000Z',
          usedBy: [{ type: 'motion-card', id: 'card_1', slot: 'hero' }],
        },
      ],
      generationRequests: [
        {
          id: 'request_1',
          slot: 'hero',
          query: '柜体',
          role: 'object',
          importance: 'primary',
          reusePolicy: 'generate-if-missing',
          visualTreatment: 'editorial-realist-cutout',
          prompt: '生成柜体',
          status: 'accepted',
          resultAssetId: 'asset_1',
          generatedFilePath: originalPath,
          createdAt: '2026-07-09T00:00:00.000Z',
          updatedAt: '2026-07-09T00:00:00.000Z',
        },
      ],
      updatedAt: '2026-07-09T00:00:00.000Z',
    };
    await writeFile(path.join(tempDir, 'library.json'), JSON.stringify(library, null, 2));
    await writeFile(path.join(projectDir, 'assets', 'manifest.json'), JSON.stringify(manifest, null, 2));

    const result = await deleteAssetLibraryAsset({ assetId: 'asset_1', projectDir }, tempDir);
    expect(result.library.assets.map((asset) => asset.id)).toEqual(['asset_2']);
    expect(result.projectManifest?.assetRefs).toEqual([]);
    expect(result.projectManifest?.generationRequests[0].status).toBe('pending');
    expect(result.projectManifest?.generationRequests[0].resultAssetId).toBeUndefined();
    expect(result.projectManifest?.generationRequests[0].generatedFilePath).toBeUndefined();
    expect(result.trashedFiles.sort()).toEqual([originalPath, processedPath].sort());
    expect(trashItemMock).toHaveBeenCalledWith(originalPath);
    expect(trashItemMock).toHaveBeenCalledWith(processedPath);
    expect(trashItemMock).not.toHaveBeenCalledWith(externalPath);
  });

  it('扫描项目目录图片并支持直接抠图和替换项目原图', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'asset-library-project-local-'));
    const libraryRoot = path.join(tempDir, 'library');
    const projectDir = path.join(tempDir, 'project');
    const originalPath = path.join(projectDir, 'ai-cards', 'card_1', 'image.png');
    await mkdir(path.dirname(originalPath), { recursive: true });
    const source: PngImage = {
      width: 10,
      height: 10,
      rgba: Buffer.alloc(10 * 10 * 4),
    };
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        setPixel(source, x, y, [0, 220, 0, 255]);
      }
    }
    for (let y = 3; y <= 6; y += 1) {
      for (let x = 3; x <= 6; x += 1) {
        setPixel(source, x, y, [190, 40, 45, 255]);
      }
    }
    await writeFile(originalPath, encodePng(source));

    const scanned = await scanProjectAssetRecords(projectDir);
    expect(scanned).toHaveLength(1);
    expect(scanned[0]).toMatchObject({
      sourceType: 'project-local',
      files: { original: originalPath },
    });

    const sampled = await sampleAssetColor({
      assetId: scanned[0].id,
      projectDir,
      xRatio: 0,
      yRatio: 0,
    }, libraryRoot);
    const keyed = await chromaKeyAsset({
      assetId: scanned[0].id,
      projectDir,
      keyColor: sampled.keyColor,
    }, libraryRoot);
    expect(keyed.outputPath).toBe(path.join(projectDir, 'ai-cards', 'card_1', 'image-cutout.png'));
    expect(keyed.library.assets.find((asset) => asset.id === scanned[0].id)?.sourceType).toBe('project-local');

    const replaced = await replaceOriginalWithProcessedAsset(scanned[0].id, libraryRoot, projectDir);
    expect(replaced.asset.files.original).toBe(originalPath);
    expect(replaced.asset.metadata.previousOriginalPath).toContain(path.join('assets', 'backups'));
    expect(decodePng(await readFile(originalPath)).width).toBeLessThan(source.width);
    expect(decodePng(await readFile(replaced.asset.metadata.previousOriginalPath!)).width).toBe(source.width);
  });

  it('审计资产健康状态并为解析过滤不可用文件', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'asset-library-health-'));
    const okPath = path.join(tempDir, 'originals', 'images', 'ok.png');
    const processedMissingPath = path.join(tempDir, 'processed', 'cutouts', 'missing-cutout.png');
    const gonePath = path.join(tempDir, 'originals', 'images', 'gone.png');
    await mkdir(path.dirname(okPath), { recursive: true });
    await writeFile(okPath, encodePng({ width: 2, height: 2, rgba: Buffer.alloc(2 * 2 * 4, 255) }));

    const library: AssetLibraryFile = {
      version: 2,
      libraryId: 'default',
      settings: {
        rootDir: tempDir,
        defaultImportMode: 'copy',
        defaultProjectReferenceMode: 'reference-global',
      },
      assets: [
        {
          id: 'asset_ok',
          name: '可用资产',
          kind: 'image',
          role: 'object',
          sourceType: 'manual-import',
          createdAt: '2026-07-09T00:00:00.000Z',
          updatedAt: '2026-07-09T00:00:00.000Z',
          files: {
            original: okPath,
            processed: processedMissingPath,
            thumbnail: null,
            mask: null,
          },
          metadata: {
            contentHash: 'sha256:ok',
            byteSize: 1,
          },
          semantic: EMPTY_ASSET_SEMANTIC,
          treatment: DEFAULT_ASSET_TREATMENT,
          usage: {
            projectRefs: [],
            favorite: false,
          },
        },
        {
          id: 'asset_gone',
          name: '缺失资产',
          kind: 'image',
          role: 'object',
          sourceType: 'manual-import',
          createdAt: '2026-07-09T00:00:00.000Z',
          updatedAt: '2026-07-09T00:00:00.000Z',
          files: {
            original: gonePath,
            processed: null,
            thumbnail: null,
            mask: null,
          },
          metadata: {
            contentHash: 'sha256:gone',
            byteSize: 1,
          },
          semantic: EMPTY_ASSET_SEMANTIC,
          treatment: DEFAULT_ASSET_TREATMENT,
          usage: {
            projectRefs: [],
            favorite: false,
          },
        },
      ],
      updatedAt: '2026-07-09T00:00:00.000Z',
    };
    const manifest: ProjectAssetManifest = {
      version: 2,
      projectDir: tempDir,
      assetRefs: [
        {
          assetId: 'asset_missing_ref',
          scope: 'global',
          globalLibraryId: 'default',
          snapshotPath: null,
          addedAt: '2026-07-09T00:00:00.000Z',
          usedBy: [],
        },
      ],
      generationRequests: [
        {
          id: 'request_1',
          slot: 'hero',
          query: '缺失结果',
          role: 'object',
          importance: 'primary',
          reusePolicy: 'generate-if-missing',
          visualTreatment: 'editorial-realist-cutout',
          prompt: '生成缺失结果',
          status: 'accepted',
          resultAssetId: 'asset_missing_result',
          generatedFilePath: path.join(tempDir, 'assets', 'generated', 'missing.png'),
          createdAt: '2026-07-09T00:00:00.000Z',
          updatedAt: '2026-07-09T00:00:00.000Z',
        },
      ],
      updatedAt: '2026-07-09T00:00:00.000Z',
    };

    const health = await auditAssetLibraryState(library, manifest);
    expect(health?.ok).toBe(false);
    expect(health?.missingFiles).toBe(3);
    expect(health?.missingRefs).toBe(1);
    expect(health?.issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining([
        'missing-processed',
        'missing-original',
        'missing-project-ref',
        'missing-generation-result',
      ]),
    );

    const normalized = await normalizeResolvableAssetLibrary(library);
    expect(normalized.assets.map((asset) => asset.id)).toEqual(['asset_ok']);
    expect(normalized.assets[0].files.processed).toBeNull();
  });
});
