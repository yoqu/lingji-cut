import { describe, it, expect } from 'vitest';
import { migrateToProviders } from '../src/lib/llm/provider-utils';
import type { AISettings, LLMProvider } from '../src/types/ai';

const baseSettings: AISettings = {
  llmProviders: [],
  defaultProviderId: null,
  defaultModel: null,
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: '',
  enableThinking: true,
  minimaxApiKey: '',
  minimaxVoiceId: 'male-qn-qingse',
  minimaxSpeed: 1.0,
};

describe('migrateToProviders', () => {
  it('providers 已存在但缺少 enableThinking 时回填全局 enableThinking', () => {
    const existing: LLMProvider = {
      id: 'existing-id',
      name: 'Existing',
      type: 'openai_compatible',
      baseUrl: 'https://api.example.com',
      apiKey: 'key',
      models: ['gpt-4'],
    };
    const settings: AISettings = {
      ...baseSettings,
      enableThinking: false,
      llmProviders: [existing],
      defaultProviderId: 'existing-id',
      defaultModel: 'gpt-4',
    };
    const result = migrateToProviders(settings);
    expect(result.llmProviders).toHaveLength(1);
    expect(result.llmProviders[0].enableThinking).toBe(false);
  });

  it('providers 自身已设置 enableThinking 时不被全局值覆盖', () => {
    const existing: LLMProvider = {
      id: 'existing-id',
      name: 'Existing',
      type: 'openai_compatible',
      baseUrl: 'https://api.example.com',
      apiKey: 'key',
      models: ['gpt-4'],
      enableThinking: true,
    };
    const settings: AISettings = {
      ...baseSettings,
      enableThinking: false,
      llmProviders: [existing],
      defaultProviderId: 'existing-id',
      defaultModel: 'gpt-4',
    };
    const result = migrateToProviders(settings);
    expect(result).toBe(settings);
    expect(result.llmProviders[0].enableThinking).toBe(true);
  });

  it('把旧版 Kimi Coding 内置预设迁移到官方最新模型列表', () => {
    const settings: AISettings = {
      ...baseSettings,
      llmProviders: [{
        id: 'kimi-id',
        name: 'Kimi Coding',
        type: 'openai_compatible',
        baseUrl: 'https://api.kimi.com/coding',
        apiKey: 'sk-test',
        models: ['k2p7', 'kimi-k2-thinking', 'kimi-for-coding'],
        defaultModel: 'k2p7',
        enableThinking: true,
        pi: { builtinProviderId: 'kimi-coding' },
      }],
      defaultProviderId: 'kimi-id',
      defaultModel: 'k2p7',
    };

    const result = migrateToProviders(settings);

    expect(result.llmProviders[0]).toMatchObject({
      baseUrl: 'https://api.kimi.com/coding/v1',
      models: ['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed'],
      defaultModel: 'k3',
    });
    expect(result.defaultModel).toBe('k3');
  });

  it('保留用户自定义的 Kimi Coding 模型列表', () => {
    const settings: AISettings = {
      ...baseSettings,
      llmProviders: [{
        id: 'kimi-id',
        name: 'Kimi Coding',
        type: 'openai_compatible',
        baseUrl: 'https://api.kimi.com/coding',
        apiKey: 'sk-test',
        models: ['my-kimi-alias'],
        enableThinking: true,
        pi: { builtinProviderId: 'kimi-coding' },
      }],
      defaultProviderId: 'kimi-id',
      defaultModel: 'my-kimi-alias',
    };

    const result = migrateToProviders(settings);

    expect(result.llmProviders[0].baseUrl).toBe('https://api.kimi.com/coding/v1');
    expect(result.llmProviders[0].models).toEqual(['my-kimi-alias']);
    expect(result.defaultModel).toBe('my-kimi-alias');
  });

  it('当 llmBaseUrl 为空时返回空 providers', () => {
    const settings: AISettings = { ...baseSettings, llmBaseUrl: '' };
    const result = migrateToProviders(settings);
    expect(result.llmProviders).toHaveLength(0);
    expect(result.defaultProviderId).toBeNull();
    expect(result.defaultModel).toBeNull();
  });

  it('从旧字段创建一个默认 provider', () => {
    const settings: AISettings = {
      ...baseSettings,
      llmBaseUrl: 'https://api.deepseek.com/v1',
      llmApiKey: 'sk-test',
      llmModel: 'deepseek-chat',
    };
    const result = migrateToProviders(settings);
    expect(result.llmProviders).toHaveLength(1);
    const provider = result.llmProviders[0];
    expect(provider.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(provider.apiKey).toBe('sk-test');
    expect(provider.models).toEqual(['deepseek-chat']);
    expect(result.defaultProviderId).toBe(provider.id);
    expect(result.defaultModel).toBe('deepseek-chat');
  });

  it('从 baseUrl 推断 provider 名称 - DeepSeek', () => {
    const settings: AISettings = {
      ...baseSettings,
      llmBaseUrl: 'https://api.deepseek.com/v1',
      llmApiKey: 'sk-test',
      llmModel: 'deepseek-chat',
    };
    const result = migrateToProviders(settings);
    expect(result.llmProviders[0].name).toBe('DeepSeek');
  });

  it('从 baseUrl 推断 provider 名称 - OpenAI', () => {
    const settings: AISettings = {
      ...baseSettings,
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'sk-test',
      llmModel: 'gpt-4',
    };
    const result = migrateToProviders(settings);
    expect(result.llmProviders[0].name).toBe('OpenAI');
  });

  it('从 baseUrl 推断 provider 名称 - Moonshot/Kimi', () => {
    const settings: AISettings = {
      ...baseSettings,
      llmBaseUrl: 'https://api.moonshot.cn/v1',
      llmApiKey: 'sk-test',
      llmModel: 'moonshot-v1-8k',
    };
    const result = migrateToProviders(settings);
    expect(result.llmProviders[0].name).toBe('Moonshot');
  });

  it('无法识别的 baseUrl 使用域名作为名称', () => {
    const settings: AISettings = {
      ...baseSettings,
      llmBaseUrl: 'https://my-custom-llm.example.com/v1',
      llmApiKey: 'sk-test',
      llmModel: 'custom-model',
    };
    const result = migrateToProviders(settings);
    expect(result.llmProviders[0].name).toBe('example');
  });

  it('无效 URL 回退到 Custom', () => {
    const settings: AISettings = {
      ...baseSettings,
      llmBaseUrl: 'not-a-valid-url',
      llmApiKey: 'sk-test',
      llmModel: 'model',
    };
    const result = migrateToProviders(settings);
    expect(result.llmProviders[0].name).toBe('Custom');
  });

  it('从 baseUrl 推断 LM Studio 类型', () => {
    const settings: AISettings = {
      ...baseSettings,
      llmBaseUrl: 'http://localhost:1234/v1',
      llmApiKey: '',
      llmModel: 'qwen2.5-7b-instruct',
    };
    const result = migrateToProviders(settings);
    expect(result.llmProviders[0].type).toBe('lmstudio');
    expect(result.llmProviders[0].name).toBe('LM Studio');
  });

  it('迁移时把全局 enableThinking 拷贝到新 provider', () => {
    const settings: AISettings = {
      ...baseSettings,
      enableThinking: false,
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'sk-test',
      llmModel: 'gpt-4o',
    };
    const result = migrateToProviders(settings);
    expect(result.llmProviders[0].enableThinking).toBe(false);
  });

  it('llmModel 为空时 models 数组为空', () => {
    const settings: AISettings = {
      ...baseSettings,
      llmBaseUrl: 'https://api.deepseek.com/v1',
      llmApiKey: 'sk-test',
      llmModel: '',
    };
    const result = migrateToProviders(settings);
    expect(result.llmProviders[0].models).toHaveLength(0);
    expect(result.defaultModel).toBeNull();
  });

  it('把已下线的 anthropic 类型 provider 重映射为 minimax', () => {
    const legacy: LLMProvider = {
      id: 'anthropic-id',
      name: 'Anthropic',
      type: 'anthropic' as never,
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'key',
      models: ['claude-sonnet-4-6'],
      enableThinking: true,
    };
    const settings: AISettings = {
      ...baseSettings,
      llmProviders: [legacy],
      defaultProviderId: 'anthropic-id',
      defaultModel: 'claude-sonnet-4-6',
    };
    const result = migrateToProviders(settings);
    expect(result.llmProviders).toHaveLength(1);
    expect(result.llmProviders[0].type).toBe('minimax');
    expect(result.llmProviders[0].id).toBe('anthropic-id');
    expect(result.defaultProviderId).toBe('anthropic-id');
  });

  it('剔除 claude_code_acp provider 并把默认指向回退到首个剩余 provider', () => {
    const acp: LLMProvider = {
      id: 'acp-id',
      name: 'Claude Code ACP',
      type: 'claude_code_acp' as never,
      baseUrl: '',
      apiKey: '',
      models: ['claude-code-default'],
      enableThinking: true,
    };
    const remaining: LLMProvider = {
      id: 'openai-id',
      name: 'OpenAI',
      type: 'openai_compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      models: ['gpt-4o'],
      enableThinking: true,
    };
    const settings: AISettings = {
      ...baseSettings,
      llmProviders: [acp, remaining],
      defaultProviderId: 'acp-id',
      defaultModel: 'claude-code-default',
    };
    const result = migrateToProviders(settings);
    expect(result.llmProviders).toHaveLength(1);
    expect(result.llmProviders[0].id).toBe('openai-id');
    expect(result.defaultProviderId).toBe('openai-id');
  });
});
