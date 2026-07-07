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
});
