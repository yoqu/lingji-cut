import { describe, expect, it } from 'vitest';
import type { AISettings } from '../src/types/ai';
import { migrateImageProviders, migrateImageProvidersV2 } from '../src/lib/llm/migrate-image-providers';

function baseSettings(): AISettings {
  return {
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
}

describe('migrateImageProviders', () => {
  it('已迁移（imageProviders 非空）时直接返回，幂等', () => {
    const s: AISettings = {
      ...baseSettings(),
      imageProviders: [{
        id: 'x', name: 'X', type: 'custom',
        baseUrl: 'u', apiKey: 'k', models: ['m'],
        extras: {},
      }],
    };
    expect(migrateImageProviders(s)).toBe(s);
  });

  it('imageProviders 缺失：补空列表与默认值', () => {
    const s = { ...baseSettings(), imageProviders: undefined } as unknown as AISettings;
    const next = migrateImageProviders(s);
    expect(next.imageProviders).toEqual([]);
    expect(next.defaultImageProviderId).toBeNull();
    expect(next.defaultImageModel).toBeNull();
  });

  it('已是空 imageProviders + 默认值：返回同引用（幂等）', () => {
    const s = baseSettings();
    expect(migrateImageProviders(s)).toBe(s);
  });
});

describe('migrateImageProvidersV2', () => {
  it('extras 缺失 → 补 extras: {}', () => {
    const s: AISettings = {
      ...baseSettings(),
      imageProviders: [{
        id: 'jimeng-default',
        name: '即梦',
        type: 'jimeng',
        baseUrl: 'https://api.jimeng.com',
        apiKey: 'sess-abc',
        models: ['jimeng-5.0'],
        // extras 故意不提供
      }],
      defaultImageProviderId: 'jimeng-default',
      defaultImageModel: 'jimeng-5.0',
    };
    const next = migrateImageProvidersV2(s);
    expect(next.imageProviders[0].extras).toEqual({});
  });

  it('imageProviders 为空 → 直接返回同引用（不变）', () => {
    const s = baseSettings();
    expect(migrateImageProvidersV2(s)).toBe(s);
  });

  it("type='openai_image' + models=[] → 自动填 ['gpt-image-1']", () => {
    const s: AISettings = {
      ...baseSettings(),
      imageProviders: [{
        id: 'oi-1',
        name: 'OpenAI Image',
        type: 'openai_image',
        baseUrl: '',
        apiKey: 'sk-xxx',
        models: [],
      }],
      defaultImageProviderId: 'oi-1',
      defaultImageModel: null,
    };
    const next = migrateImageProvidersV2(s);
    expect(next.imageProviders[0].models).toEqual(['gpt-image-1']);
  });

  it("type='wanx' + models=['custom'] → 不覆盖（保留用户自定义）", () => {
    const s: AISettings = {
      ...baseSettings(),
      imageProviders: [{
        id: 'wanx-1',
        name: 'WanX',
        type: 'wanx',
        baseUrl: '',
        apiKey: 'k',
        models: ['custom'],
      }],
      defaultImageProviderId: 'wanx-1',
      defaultImageModel: 'custom',
    };
    const next = migrateImageProvidersV2(s);
    expect(next.imageProviders[0].models).toEqual(['custom']);
  });
});
