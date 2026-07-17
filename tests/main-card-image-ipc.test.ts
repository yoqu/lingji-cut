import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mockImagePayload = vi.hoisted(() => ({
  base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
  prompt: '',
}));

vi.mock('../src/lib/image-gen/registry', () => ({
  getImageProvider: () => ({
    type: 'apimart',
    capabilities: {
      aspectRatios: ['16:9'],
      maxN: 1,
      supportsImageToImage: false,
      isAsync: false,
      defaultModels: ['m1'],
    },
    generate: async (request: { prompt: string }) => {
      mockImagePayload.prompt = request.prompt;
      return ({
      images: [
        {
          base64: mockImagePayload.base64,
          mimeType: 'image/png',
        },
      ],
      });
    },
  }),
}));

import { handleGenerateCardImage } from '../electron/card-media-handlers';
import {
  decodePng,
  encodePng,
  type PngImage,
} from '../electron/green-screen-keyer';

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

function makeSettingsWithProvider(): any {
  return {
    imageProviders: [
      { id: 'p1', name: 'p1', type: 'apimart', baseUrl: '', apiKey: '', models: ['m1'] },
    ],
    defaultImageProviderId: 'p1',
    defaultImageModel: 'm1',
    videoProviders: [],
    defaultVideoProviderId: null,
    defaultVideoModel: null,
    promptBindings: {},
    llmProviders: [
      { id: 'l1', name: 'l1', type: 'openai_compatible', baseUrl: '', apiKey: '', models: ['m'] },
    ],
    defaultProviderId: 'l1',
    defaultModel: 'm',
    llmBaseUrl: '',
    llmApiKey: '',
    llmModel: '',
    minimaxApiKey: '',
    minimaxVoiceId: '',
    minimaxSpeed: 1,
  };
}

describe('handleGenerateCardImage', () => {
  let projectDir = '';
  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'cardimg-'));
    mockImagePayload.base64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    mockImagePayload.prompt = '';
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('生成并落地 image.png + meta.json，返回 ready MediaCardContent', async () => {
    const onProgress = vi.fn();
    const result = await handleGenerateCardImage(
      {
        projectDir,
        cardId: 'c1',
        prompt: 'a cat',
        aspectRatio: '16:9',
        providerId: 'p1',
        model: 'm1',
      },
      {
        settings: makeSettingsWithProvider(),
        projectBindings: null,
        onProgress,
      },
    );
    expect(result.assetPath).toBe(path.join('ai-cards', 'c1', 'image.png'));
    expect(result.generationStatus).toBe('ready');
    expect(result.mediaType).toBe('image');
    expect(result.providerId).toBe('p1');
    expect(result.backgroundRemoval).toBe('none');
    expect(result.originalAssetPath).toBe(result.assetPath);
    expect(result.cutoutStatus).toBe('not-requested');
    await stat(path.join(projectDir, result.assetPath!));
    const meta = JSON.parse(
      await readFile(path.join(projectDir, 'ai-cards', 'c1', 'meta.json'), 'utf8'),
    );
    expect(meta.prompt).toBe('a cat');
    expect(onProgress).toHaveBeenCalled();
  });

  it('生成绿幕图片后自动写入 image-cutout.png 并返回抠图路径', async () => {
    const image: PngImage = {
      width: 10,
      height: 10,
      rgba: Buffer.alloc(10 * 10 * 4),
    };
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        setPixel(image, x, y, [0, 255, 0, 255]);
      }
    }
    for (let y = 3; y <= 6; y += 1) {
      for (let x = 3; x <= 6; x += 1) {
        setPixel(image, x, y, [190, 40, 45, 255]);
      }
    }
    mockImagePayload.base64 = encodePng(image).toString('base64');

    const result = await handleGenerateCardImage(
      {
        projectDir,
        cardId: 'c1',
        prompt: 'a green screen prop',
        negativePrompt: '文字、水印',
        backgroundRemoval: 'green-screen',
        aspectRatio: '16:9',
        providerId: 'p1',
        model: 'm1',
      },
      {
        settings: makeSettingsWithProvider(),
        projectBindings: null,
        onProgress: vi.fn(),
      },
    );

    expect(result.assetPath).toBe(path.join('ai-cards', 'c1', 'image-cutout.png'));
    expect(result.cutoutStatus).toBe('ready');
    expect(mockImagePayload.prompt).toContain('纯绿色背景');
    expect(mockImagePayload.prompt).toContain('避免出现：文字、水印');
    await stat(path.join(projectDir, 'ai-cards', 'c1', 'image.png'));
    const cutout = decodePng(await readFile(path.join(projectDir, result.assetPath!)));
    expect(cutout.width).toBeLessThan(image.width);
    expect(cutout.rgba[3]).toBeLessThanOrEqual(8);
    const meta = JSON.parse(
      await readFile(path.join(projectDir, 'ai-cards', 'c1', 'meta.json'), 'utf8'),
    );
    expect(meta.extras).toMatchObject({
      originalAssetPath: path.join('ai-cards', 'c1', 'image.png'),
      cutoutAssetPath: path.join('ai-cards', 'c1', 'image-cutout.png'),
      autoCutout: true,
    });
  });

  it('未配置 image provider 时抛错', async () => {
    const settings = makeSettingsWithProvider();
    settings.imageProviders = [];
    settings.defaultImageProviderId = null;
    settings.defaultImageModel = null;
    await expect(
      handleGenerateCardImage(
        {
          projectDir,
          cardId: 'c1',
          prompt: 'a cat',
          aspectRatio: '16:9',
        },
        { settings, projectBindings: null, onProgress: () => {} },
      ),
    ).rejects.toThrow();
  });
});
