import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveAssetRequestsForProject } from '../electron/asset-library';
import type { StoryboardAssetRequest } from '../src/types/assets';

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
    trashItem: vi.fn(async () => undefined),
  },
}));

let tempDir = '';

async function makeProject(): Promise<{ projectDir: string; libraryRootDir: string }> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'lingji-manual-assets-'));
  const projectDir = path.join(tempDir, 'project');
  const libraryRootDir = path.join(tempDir, 'library');
  await mkdir(projectDir, { recursive: true });
  return { projectDir, libraryRootDir };
}

function assetRequest(overrides: Partial<StoryboardAssetRequest> = {}): StoryboardAssetRequest {
  return {
    slot: 'archive_prop',
    query: '旧档案袋',
    role: 'object',
    importance: 'primary',
    reusePolicy: 'generate-if-missing',
    visualTreatment: 'editorial-realist-cutout',
    ...overrides,
  };
}

describe('resolveAssetRequestsForProject 手动素材约定', () => {
  afterEach(async () => {
    if (!tempDir) return;
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('卡目录存在 <slot>.png 时直接绑定用户文件，不再匹配素材库 / 触发 AI 生成', async () => {
    const { projectDir, libraryRootDir } = await makeProject();
    const cardDir = path.join(projectDir, 'ai-cards', 'card-1');
    await mkdir(cardDir, { recursive: true });
    await writeFile(path.join(cardDir, 'archive_prop.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const generateMissing = vi.fn(async () => {
      throw new Error('不应触发生成');
    });

    const result = await resolveAssetRequestsForProject({
      projectDir,
      libraryRootDir,
      sourceCardId: 'card-1',
      requests: [assetRequest()],
      generateMissing,
    });

    expect(generateMissing).not.toHaveBeenCalled();
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]).toMatchObject({
      slot: 'archive_prop',
      assetId: 'manual:ai-cards/card-1/archive_prop.png',
      filePath: 'ai-cards/card-1/archive_prop.png',
    });
    expect(result.generationRequests).toHaveLength(0);
    expect(result.activity?.manual).toBe(1);
    expect(result.activity?.requested).toBe(1);
  });

  it('序号约定 asset-1.png 映射到第一个资产请求', async () => {
    const { projectDir, libraryRootDir } = await makeProject();
    const cardDir = path.join(projectDir, 'ai-cards', 'card-9');
    await mkdir(cardDir, { recursive: true });
    await writeFile(path.join(cardDir, 'asset-1.jpg'), Buffer.from([0xff, 0xd8]));

    const result = await resolveAssetRequestsForProject({
      projectDir,
      libraryRootDir,
      sourceCardId: 'card-9',
      requests: [assetRequest({ slot: 'some_slot_name' })],
    });

    expect(result.bindings[0]?.filePath).toBe('ai-cards/card-9/asset-1.jpg');
    expect(result.activity?.manual).toBe(1);
  });

  it('仅命中部分请求：其余请求仍走素材库匹配 / AI 生成；生成失败时确定性剔除该资产', async () => {
    const { projectDir, libraryRootDir } = await makeProject();
    const cardDir = path.join(projectDir, 'ai-cards', 'card-2');
    await mkdir(cardDir, { recursive: true });
    await writeFile(path.join(cardDir, 'archive_prop.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const generated: string[] = [];
    const result = await resolveAssetRequestsForProject({
      projectDir,
      libraryRootDir,
      sourceCardId: 'card-2',
      requests: [
        assetRequest(),
        assetRequest({ slot: 'chip_sample', query: '芯片样品', role: 'object' }),
      ],
      generateMissing: vi.fn(async (request) => {
        generated.push(request.slot);
        throw new Error('image provider 超时');
      }),
    });

    // 手动请求未进生成队列；第二个请求走了生成并失败 → 不进 bindings（卡片降级渲染）
    expect(generated).toEqual(['chip_sample']);
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]?.assetId).toBe('manual:ai-cards/card-2/archive_prop.png');
    expect(result.activity?.manual).toBe(1);
    expect(result.activity?.failed).toBe(1);
    expect(result.activity?.generated).toBe(0);
  });

  it('无卡目录时回退正常解析流程（库未命中 → 进入生成队列）', async () => {
    const { projectDir, libraryRootDir } = await makeProject();
    const result = await resolveAssetRequestsForProject({
      projectDir,
      libraryRootDir,
      sourceCardId: 'card-absent',
      requests: [assetRequest()],
    });
    expect(result.bindings).toHaveLength(0);
    expect(result.generationRequests).toHaveLength(1);
    expect(result.activity?.manual).toBe(0);
  });
});
