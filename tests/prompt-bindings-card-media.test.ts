import { describe, expect, it } from 'vitest';
import { resolvePromptBinding } from '../src/lib/llm/binding-resolver';
import type {
  AISettings,
  PromptBindingMap,
  VideoProvider,
  ImageProvider,
  LLMProvider,
} from '../src/types/ai';

const llm: LLMProvider = {
  id: 'llm1',
  name: 'llm1',
  type: 'openai_compatible',
  baseUrl: '',
  apiKey: '',
  models: ['gpt-x'],
};

function makeSettings(overrides: Partial<AISettings> = {}): AISettings {
  return {
    llmProviders: [llm],
    defaultProviderId: 'llm1',
    defaultModel: 'gpt-x',
    llmBaseUrl: '',
    llmApiKey: '',
    llmModel: '',
    minimaxApiKey: '',
    minimaxVoiceId: '',
    minimaxSpeed: 1,
    imageProviders: [],
    defaultImageProviderId: null,
    defaultImageModel: null,
    videoProviders: [],
    defaultVideoProviderId: null,
    defaultVideoModel: null,
    promptBindings: {},
    ...overrides,
  } as AISettings;
}

describe('binding-resolver: card.image / card.video', () => {
  it('card.image 回退到默认 image provider', () => {
    const img: ImageProvider = {
      id: 'img1', name: 'img1', type: 'apimart',
      baseUrl: '', apiKey: '', models: ['m1'],
    };
    const settings = makeSettings({
      imageProviders: [img],
      defaultImageProviderId: 'img1',
      defaultImageModel: 'm1',
    });
    const r = resolvePromptBinding('card.image', settings, null);
    expect(r.imageProvider?.id).toBe('img1');
    expect(r.imageModel).toBe('m1');
  });

  it('card.video 优先项目级 binding', () => {
    const v1: VideoProvider = {
      id: 'v1', name: 'v1', type: 'vidu',
      baseUrl: '', apiKey: '', models: ['vidu-2'],
    };
    const v2: VideoProvider = {
      id: 'v2', name: 'v2', type: 'vidu',
      baseUrl: '', apiKey: '', models: ['vidu-1'],
    };
    const settings = makeSettings({
      videoProviders: [v1, v2],
      defaultVideoProviderId: 'v1',
      defaultVideoModel: 'vidu-2',
    });
    const projectBindings: PromptBindingMap = {
      'card.video': {
        providerId: null,
        model: null,
        videoProviderId: 'v2',
        videoModel: 'vidu-1',
      },
    };
    const r = resolvePromptBinding('card.video', settings, projectBindings);
    expect(r.videoProvider?.id).toBe('v2');
    expect(r.videoModel).toBe('vidu-1');
  });

  it('card.video 无任何视频 provider 时抛 VIDEO_PROVIDER_MISSING', () => {
    const settings = makeSettings();
    expect(() => resolvePromptBinding('card.video', settings, null)).toThrow(/未绑定视频生成服务/);
  });
});
