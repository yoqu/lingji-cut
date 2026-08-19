import { describe, expect, it, vi } from 'vitest';
import { loadAISettings } from '../src/store/ai';

describe('loadAISettings 视频字段迁移', () => {
  it('settings 缺 videoProviders 三件套时补默认', async () => {
    const legacy = {
      llmProviders: [],
      defaultProviderId: null,
      defaultModel: null,
      minimaxApiKey: '',
      minimaxVoiceId: '',
      minimaxSpeed: 1,
      imageProviders: [],
      defaultImageProviderId: null,
      defaultImageModel: null,
      promptBindings: {},
    };
    vi.stubGlobal('window', {
      electronAPI: {
        loadGlobalSettings: vi.fn().mockResolvedValue(JSON.stringify({ aiSettings: legacy })),
        saveGlobalSettings: vi.fn().mockResolvedValue(undefined),
      },
    });

    const settings = await loadAISettings();
    expect(settings).not.toBeNull();
    expect(settings!.videoProviders).toEqual([]);
    expect(settings!.defaultVideoProviderId).toBeNull();
    expect(settings!.defaultVideoModel).toBeNull();
  });

  it('加载时剔除账号体系遗留的 lingji-fallback 托管 provider', async () => {
    const leftover = {
      llmProviders: [
        {
          id: 'lingji-fallback-llm',
          name: '灵机剪影网关',
          type: 'openai_compatible',
          baseUrl: 'https://lingji.qushenma.com/v1',
          apiKey: 'lj_old',
          models: ['gpt-4o-mini'],
        },
        {
          id: 'openai-local',
          name: 'OpenAI',
          type: 'openai_compatible',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          models: ['gpt-4o'],
        },
      ],
      defaultProviderId: 'lingji-fallback-llm',
      defaultModel: 'gpt-4o-mini',
      imageProviders: [
        {
          id: 'lingji-fallback-image',
          name: '灵机剪影图片',
          type: 'openai_image',
          baseUrl: 'https://lingji.qushenma.com',
          apiKey: 'lj_old',
          models: ['gpt-image-1'],
        },
      ],
      defaultImageProviderId: 'lingji-fallback-image',
      ttsProviders: [
        {
          id: 'lingji-fallback-tts',
          name: '灵机剪影语音',
          type: 'minimax',
          baseUrl: 'https://lingji.qushenma.com',
          apiKey: 'lj_old',
          models: ['speech-2.8-hd'],
        },
      ],
      defaultTtsProviderId: 'lingji-fallback-tts',
      videoProviders: [
        {
          id: 'lingji-fallback-video',
          name: '灵机剪影视频',
          type: 'vidu',
          baseUrl: 'https://lingji.qushenma.com',
          apiKey: 'lj_old',
          models: ['lingji-video'],
        },
      ],
      defaultVideoProviderId: 'lingji-fallback-video',
    };
    vi.stubGlobal('window', {
      electronAPI: {
        loadGlobalSettings: vi.fn().mockResolvedValue(JSON.stringify({ aiSettings: leftover })),
        saveGlobalSettings: vi.fn().mockResolvedValue(undefined),
      },
    });

    const settings = await loadAISettings();
    expect(settings).not.toBeNull();
    expect(settings!.llmProviders.map((p) => p.id)).toEqual(['openai-local']);
    expect(settings!.defaultProviderId).toBe('openai-local');
    expect(settings!.imageProviders).toEqual([]);
    expect(settings!.defaultImageProviderId).toBeNull();
    expect(settings!.ttsProviders.map((p) => p.id)).toEqual(['tts-provider-minimax-default']);
    expect(settings!.defaultTtsProviderId).toBe('tts-provider-minimax-default');
    expect(settings!.videoProviders).toEqual([]);
    expect(settings!.defaultVideoProviderId).toBeNull();
  });
});
