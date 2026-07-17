import { describe, expect, it } from 'vitest';
import { getAISettingsIssue } from '../src/lib/ai-settings';
import type { AISettings, LLMProvider } from '../src/types/ai';

function makeProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    id: 'p1',
    name: 'OpenAI',
    type: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    models: ['gpt-4o'],
    ...overrides,
  };
}

function makeSettings(overrides: Partial<AISettings> = {}): AISettings {
  return {
    llmProviders: [],
    defaultProviderId: null,
    defaultModel: null,
    ...overrides,
  } as AISettings;
}

describe('getAISettingsIssue', () => {
  it('returns a clear message when settings are missing', () => {
    expect(getAISettingsIssue(null)).toBe('请先完成 AI 配置后再开始分析');
  });

  it('requires at least one configured LLM provider', () => {
    expect(getAISettingsIssue(makeSettings())).toBe('请先配置文本生成服务');
  });

  it('requires a model when neither defaultModel nor provider models exist', () => {
    expect(
      getAISettingsIssue(
        makeSettings({
          llmProviders: [makeProvider({ models: [] })],
          defaultProviderId: 'p1',
          defaultModel: null,
        }),
      ),
    ).toBe('请先填写模型名称');
  });

  it('passes when the default provider and model are configured', () => {
    expect(
      getAISettingsIssue(
        makeSettings({
          llmProviders: [makeProvider()],
          defaultProviderId: 'p1',
          defaultModel: 'gpt-4o',
        }),
      ),
    ).toBeNull();
  });
});
