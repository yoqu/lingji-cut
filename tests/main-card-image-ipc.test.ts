import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
    generate: async () => ({
      images: [
        {
          base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
          mimeType: 'image/png',
        },
      ],
    }),
  }),
}));

import { handleGenerateCardImage } from '../electron/card-media-handlers';

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
    await stat(path.join(projectDir, result.assetPath!));
    const meta = JSON.parse(
      await readFile(path.join(projectDir, 'ai-cards', 'c1', 'meta.json'), 'utf8'),
    );
    expect(meta.prompt).toBe('a cat');
    expect(onProgress).toHaveBeenCalled();
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
