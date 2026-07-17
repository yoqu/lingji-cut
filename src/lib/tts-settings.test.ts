import { describe, expect, it } from 'vitest';
import type { AISettings } from '../types/ai';
import { normalizeTTSSettings, resolveDefaultTTSConfig } from './tts-settings';

function baseSettings(overrides: Partial<AISettings> = {}): AISettings {
  return {
    llmProviders: [],
    defaultProviderId: null,
    defaultModel: null,
    llmBaseUrl: '',
    llmApiKey: '',
    llmModel: '',
    minimaxApiKey: 'legacy-key',
    minimaxVoiceId: 'male-qn-qingse',
    minimaxSpeed: 1.2,
    minimaxVol: 1.1,
    minimaxPitch: 2,
    minimaxEmotion: 'happy',
    minimaxModel: 'speech-2.8-hd',
    ttsProviders: [],
    defaultTtsProviderId: null,
    defaultTtsVoiceId: null,
    ttsVoices: [],
    imageProviders: [],
    defaultImageProviderId: null,
    defaultImageModel: null,
    videoProviders: [],
    defaultVideoProviderId: null,
    defaultVideoModel: null,
    promptBindings: {},
    ...overrides,
  };
}

describe('normalizeTTSSettings', () => {
  it('migrates legacy MiniMax fields into a default provider and voice', () => {
    const settings = normalizeTTSSettings(baseSettings());

    expect(settings.ttsProviders).toHaveLength(1);
    expect(settings.ttsProviders[0]).toMatchObject({
      name: 'MiniMax 默认口播',
      type: 'minimax',
      apiKey: 'legacy-key',
      models: ['speech-2.8-hd'],
    });
    expect(settings.ttsVoices).toHaveLength(1);
    expect(settings.ttsVoices[0]).toMatchObject({
      source: 'system',
      providerType: 'minimax',
      voiceId: 'male-qn-qingse',
      params: {
        speed: 1.2,
        vol: 1.1,
        pitch: 2,
        emotion: 'happy',
      },
    });
    expect(settings.defaultTtsProviderId).toBe(settings.ttsProviders[0].id);
    expect(settings.defaultTtsVoiceId).toBe(settings.ttsVoices[0].id);
  });

  it('updates the legacy default service name to the current product wording', () => {
    const settings = normalizeTTSSettings(
      baseSettings({
        ttsProviders: [{
          id: 'tts-provider-minimax-default',
          name: 'MiniMax 默认 TTS',
          type: 'minimax',
          baseUrl: 'https://api.minimaxi.com',
          apiKey: 'key',
          models: ['speech-2.8-hd'],
        }],
        defaultTtsProviderId: 'tts-provider-minimax-default',
      }),
    );

    expect(settings.ttsProviders[0]?.name).toBe('MiniMax 默认口播');
  });

  it('resolves the default provider from the default voice provider', () => {
    const settings = normalizeTTSSettings(
      baseSettings({
        ttsProviders: [
          {
            id: 'mimo',
            name: 'MiMo',
            type: 'xiaomi_mimo',
            baseUrl: 'https://api.xiaomimimo.com',
            apiKey: 'key',
            models: ['mimo-v2.5-tts-voiceclone'],
          },
        ],
        ttsVoices: [
          {
            id: 'voice',
            name: '克隆音色',
            providerId: 'mimo',
            providerType: 'xiaomi_mimo',
            model: 'mimo-v2.5-tts-voiceclone',
            source: 'cloned',
            referenceAudioPath: '/tmp/ref.mp3',
            params: { speed: 1 },
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        defaultTtsProviderId: 'mimo',
        defaultTtsVoiceId: 'voice',
      }),
    );

    const resolved = resolveDefaultTTSConfig(settings);

    expect(resolved.provider?.id).toBe('mimo');
    expect(resolved.voice?.id).toBe('voice');
  });
});
