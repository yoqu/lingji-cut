import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../src/lib/video-gen/registry', () => ({
  getVideoProvider: () => ({
    type: 'vidu',
    capabilities: {
      aspectRatios: ['16:9'],
      durationOptions: [4, 6, 8],
      maxResolution: '1080p',
      supportsImageToVideo: false,
      isAsync: true,
      defaultModels: ['vidu-2'],
    },
    generate: async () => ({
      videoUrl: 'http://example.com/v.mp4',
      posterUrl: 'http://example.com/p.jpg',
      durationMs: 6000,
      width: 1920,
      height: 1080,
    }),
  }),
}));

const fetchMock = vi.fn(async (url: string) => {
  if (url.endsWith('v.mp4')) {
    return new Response(Buffer.from([0, 1, 2, 3]), { status: 200 });
  }
  if (url.endsWith('p.jpg')) {
    return new Response(Buffer.from([4, 5, 6]), { status: 200 });
  }
  return new Response('', { status: 404 });
});

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

import { handleGenerateCardVideo } from '../electron/card-media-handlers';

function makeSettingsWithVideoProvider(): any {
  return {
    videoProviders: [
      { id: 'v1', name: 'v1', type: 'vidu', baseUrl: '', apiKey: '', models: ['vidu-2'] },
    ],
    defaultVideoProviderId: 'v1',
    defaultVideoModel: 'vidu-2',
    imageProviders: [],
    defaultImageProviderId: null,
    defaultImageModel: null,
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
    promptBindings: {},
  };
}

describe('handleGenerateCardVideo', () => {
  let projectDir = '';
  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'cardvid-'));
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('生成视频 + 海报 + meta', async () => {
    const result = await handleGenerateCardVideo(
      {
        projectDir,
        cardId: 'c1',
        prompt: 'a cat',
        aspectRatio: '16:9',
        durationSeconds: 6,
        providerId: 'v1',
        model: 'vidu-2',
      },
      {
        settings: makeSettingsWithVideoProvider(),
        projectBindings: null,
        onProgress: () => {},
      },
    );
    expect(result.assetPath).toBe(path.join('ai-cards', 'c1', 'video.mp4'));
    expect(result.posterPath).toBe(path.join('ai-cards', 'c1', 'poster.jpg'));
    expect(result.mediaDurationMs).toBe(6000);
    expect(result.generationStatus).toBe('ready');
    await stat(path.join(projectDir, result.assetPath!));
    await stat(path.join(projectDir, result.posterPath!));
    const meta = JSON.parse(
      await readFile(path.join(projectDir, 'ai-cards', 'c1', 'meta.json'), 'utf8'),
    );
    expect(meta.mediaType).toBe('video');
    expect(meta.mediaDurationMs).toBe(6000);
  });
});
