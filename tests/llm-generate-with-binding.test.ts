import { describe, expect, it, vi } from 'vitest';
import type { AISettings, LLMProvider } from '../src/types/ai';
import type { ResolvedBinding } from '../src/lib/llm/binding-resolver';

// 流式调用：让 bind().stream() 返回单 chunk 的 async iterable
function asAsyncIterable(...chunks: Array<{ content: unknown }>) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= chunks.length) return { value: undefined, done: true } as const;
          return { value: chunks[i++], done: false } as const;
        },
        async return() {
          return { value: undefined, done: true } as const;
        },
      };
    },
  };
}

vi.mock('../src/lib/llm/model', () => {
  return {
    createChatModelFromProvider: vi.fn(() => ({
      bind: () => ({
        invoke: async () => ({ content: '{"k":2}' }),
        stream: async () => asAsyncIterable({ content: '{"k":2}' }),
      }),
      invoke: async () => ({ content: 'hello-binding' }),
      stream: async () => asAsyncIterable({ content: 'hello-binding' }),
    })),
  };
});

import { generateStructuredData, generateText } from '../src/lib/llm';
import { createChatModelFromProvider } from '../src/lib/llm/model';

const provider: LLMProvider = {
  id: 'A',
  name: 'A',
  type: 'openai_compatible',
  baseUrl: 'b',
  apiKey: 'k',
  models: ['m'],
};
const settings: AISettings = {
  llmProviders: [provider],
  defaultProviderId: 'A',
  defaultModel: 'm',
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: '',
  jimengApiUrl: '',
  jimengSessionId: '',
  minimaxApiKey: '',
  minimaxVoiceId: '',
  minimaxSpeed: 1,
  imageProviders: [],
  defaultImageProviderId: null,
  defaultImageModel: null,
  promptBindings: {},
};
const binding: ResolvedBinding = { provider, model: 'm' };

describe('generate with optional binding', () => {
  it('不传 binding：回落到默认 provider 并走 createChatModelFromProvider', async () => {
    const r = await generateStructuredData(settings, 'sys', 'usr');
    expect(r).toEqual({ k: 2 });
    expect(createChatModelFromProvider).toHaveBeenCalledWith(provider, 'm');
  });

  it('不传 binding 且没有可用 provider：抛出配置引导错误', async () => {
    const empty: AISettings = { ...settings, llmProviders: [], defaultProviderId: null, defaultModel: null };
    await expect(generateStructuredData(empty, 'sys', 'usr')).rejects.toThrow(
      '请先在「设置 → AI」中配置 LLM Provider 与模型',
    );
  });

  it('传 binding：走 createChatModelFromProvider 并由 provider 自身决定 thinking 模式', async () => {
    const r = await generateStructuredData(settings, 'sys', 'usr', binding);
    expect(r).toEqual({ k: 2 });
    // pickModel 不再注入 enableThinking 参数，让 model.ts 内部读 provider.enableThinking
    expect(createChatModelFromProvider).toHaveBeenCalledWith(provider, 'm');
  });

  it('generateText 同样支持 binding 参数', async () => {
    const r = await generateText(settings, 'sys', 'usr', binding);
    expect(r).toBe('hello-binding');
  });
});
