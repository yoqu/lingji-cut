import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createAIConfigSnapshot,
  hasUnsavedAIConfigChanges,
  normalizeProviderDrafts,
  normalizeProviderSelection,
  validateProviderDraft,
} from '../src/components/settings/ai-config-utils';
import type { LLMProvider } from '../src/types/ai';

function createProvider(overrides?: Partial<LLMProvider>): LLMProvider {
  return {
    id: 'provider-1',
    name: 'OpenAI',
    type: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-demo',
    models: ['gpt-4.1'],
    ...overrides,
  };
}

describe('ai-config-utils', () => {
  it('flags all required provider fields when they are missing', () => {
    expect(
      validateProviderDraft(
        createProvider({
          name: '   ',
          baseUrl: '  ',
          apiKey: '',
          models: [],
        }),
      ),
    ).toEqual({
      name: '请输入 Provider 名称',
      baseUrl: '请输入 Base URL',
      apiKey: '请输入 API Key',
      models: '请至少添加一个模型',
    });
  });

  it('normalizes default selection to the active provider first model', () => {
    const primary = createProvider({ id: 'primary', models: ['gpt-4.1', 'gpt-4o-mini'] });
    const backup = createProvider({ id: 'backup', name: 'Backup', models: ['claude-3-7-sonnet'] });

    expect(
      normalizeProviderSelection([primary, backup], 'missing-provider', 'missing-model'),
    ).toEqual({
      defaultProviderId: 'primary',
      defaultModel: 'gpt-4.1',
    });

    expect(
      normalizeProviderSelection([primary, backup], 'backup', 'missing-model'),
    ).toEqual({
      defaultProviderId: 'backup',
      defaultModel: 'claude-3-7-sonnet',
    });
  });

  it('prefers the active provider defaultModel over the model-list first item', () => {
    const primary = createProvider({
      id: 'primary',
      models: ['gpt-4.1', 'gpt-4o-mini'],
      defaultModel: 'gpt-4o-mini',
    });

    // 调用方偏好缺失时，应回退到 provider.defaultModel 而非列表首项
    expect(normalizeProviderSelection([primary], 'primary', null)).toEqual({
      defaultProviderId: 'primary',
      defaultModel: 'gpt-4o-mini',
    });
  });

  it('drops a provider defaultModel that is not in its model list', () => {
    const normalized = normalizeProviderDrafts([
      createProvider({ models: ['gpt-4.1'], defaultModel: 'ghost-model' }),
    ])[0];
    expect(normalized.defaultModel).toBeUndefined();
  });

  it('keeps and trims a valid provider defaultModel', () => {
    const normalized = normalizeProviderDrafts([
      createProvider({ models: ['gpt-4.1', 'gpt-4o-mini'], defaultModel: ' gpt-4o-mini ' }),
    ])[0];
    expect(normalized.defaultModel).toBe('gpt-4o-mini');
  });

  it('detects unsaved AI config changes from normalized snapshots', () => {
    const baseSnapshot = createAIConfigSnapshot({
      providers: [createProvider()],
      defaultProviderId: 'provider-1',
      defaultModel: 'gpt-4.1',
    });

    expect(
      hasUnsavedAIConfigChanges(
        baseSnapshot,
        createAIConfigSnapshot({
          providers: [createProvider()],
          defaultProviderId: 'provider-1',
          defaultModel: 'gpt-4.1',
        }),
      ),
    ).toBe(false);

    expect(
      hasUnsavedAIConfigChanges(
        baseSnapshot,
        createAIConfigSnapshot({
          providers: [createProvider({ name: 'Other Provider' })],
          defaultProviderId: 'provider-1',
          defaultModel: 'gpt-4.1',
        }),
      ),
    ).toBe(true);
  });

  it('treats per-provider enableThinking change as an unsaved diff', () => {
    const baseSnapshot = createAIConfigSnapshot({
      providers: [createProvider({ enableThinking: true })],
      defaultProviderId: 'provider-1',
      defaultModel: 'gpt-4.1',
    });

    expect(
      hasUnsavedAIConfigChanges(
        baseSnapshot,
        createAIConfigSnapshot({
          providers: [createProvider({ enableThinking: false })],
          defaultProviderId: 'provider-1',
          defaultModel: 'gpt-4.1',
        }),
      ),
    ).toBe(true);
  });

  it('normalizes pi projection settings and includes them in snapshots', () => {
    const provider = createProvider({
      pi: {
        api: 'openai-responses',
        authHeader: true,
        headers: {
          ' x-proxy-key ': ' $PROXY_KEY ',
          empty: '',
        },
        compat: {
          supportsDeveloperRole: true,
          supportsReasoningEffort: false,
          maxTokensField: 'max_completion_tokens',
          thinkingFormat: 'qwen',
        },
        model: {
          input: ['text', 'image'],
          contextWindow: 262144.8,
          maxTokens: 32768,
          cost: { input: 1.2, output: 3.4 },
          thinkingLevelMap: { low: null, high: ' high ', xhigh: 'max' },
        },
      },
    });

    const normalized = normalizeProviderDrafts([provider])[0];
    expect(normalized.pi).toEqual({
      api: 'openai-responses',
      authHeader: true,
      headers: { 'x-proxy-key': '$PROXY_KEY' },
      compat: {
        supportsDeveloperRole: true,
        supportsReasoningEffort: false,
        maxTokensField: 'max_completion_tokens',
        thinkingFormat: 'qwen',
      },
      model: {
        input: ['text', 'image'],
        contextWindow: 262144,
        maxTokens: 32768,
        cost: { input: 1.2, output: 3.4 },
        thinkingLevelMap: { low: null, high: 'high', xhigh: 'max' },
      },
    });

    const baseSnapshot = createAIConfigSnapshot({
      providers: [createProvider()],
      defaultProviderId: 'provider-1',
      defaultModel: 'gpt-4.1',
    });
    const piSnapshot = createAIConfigSnapshot({
      providers: [provider],
      defaultProviderId: 'provider-1',
      defaultModel: 'gpt-4.1',
    });

    expect(hasUnsavedAIConfigChanges(baseSnapshot, piSnapshot)).toBe(true);
  });

  it('expands pi built-in provider drafts from the preset metadata', () => {
    const normalized = normalizeProviderDrafts([
      createProvider({
        name: '   ',
        type: 'openai_compatible',
        baseUrl: '',
        apiKey: ' sk-live ',
        models: [],
        pi: { builtinProviderId: 'openai' },
      }),
    ])[0];

    expect(normalized).toMatchObject({
      name: 'OpenAI',
      type: 'openai_compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-live',
      models: ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-mini'],
      pi: { builtinProviderId: 'openai' },
    });
    expect(validateProviderDraft(normalized)).toEqual({});
  });

  it('treats LM Studio providers as not requiring base URL or API key', () => {
    expect(
      validateProviderDraft(
        createProvider({
          type: 'lmstudio',
          name: 'LM Studio',
          baseUrl: '',
          apiKey: '',
          models: ['llama-3.2-3b'],
        }),
      ),
    ).toEqual({});
  });

  it('wires an unsaved-change guard into AIConfigTab and settings navigation', () => {
    const aiConfigSource = readFileSync(
      new URL('../src/components/settings/AIConfigTab.tsx', import.meta.url),
      'utf8',
    );
    const settingsSource = readFileSync(
      new URL('../src/pages/Settings.tsx', import.meta.url),
      'utf8',
    );

    expect(aiConfigSource).toContain('useSettingsTabGuard');
    expect(aiConfigSource).toContain('onRegisterLeaveGuard');
    // 新的封面图像生成 Section 应使用 ImageProviderListSection
    expect(aiConfigSource).toContain('ImageProviderListSection');
    expect(aiConfigSource).toContain('封面图像生成');
    expect(aiConfigSource).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}:8330\b/);
    expect(settingsSource).toContain('tabLeaveGuardRef');
    expect(settingsSource).toContain('onRegisterLeaveGuard');
  });
});
