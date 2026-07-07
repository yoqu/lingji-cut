import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AISettings } from '../src/types/ai';

const { invokeMock, bindInvokeMock, bindStreamMock, bindMock, streamMock, chatOpenAIMock } =
  vi.hoisted(() => {
    const invoke = vi.fn();
    const bindInvoke = vi.fn();
    const bindStream = vi.fn();
    const bind = vi.fn(() => ({
      invoke: bindInvoke,
      stream: bindStream,
    }));
    const stream = vi.fn();
    const chatOpenAI = vi.fn().mockImplementation(() => ({
      invoke,
      bind,
      stream,
    }));

    return {
      invokeMock: invoke,
      bindInvokeMock: bindInvoke,
      bindStreamMock: bindStream,
      bindMock: bind,
      streamMock: stream,
      chatOpenAIMock: chatOpenAI,
    };
  });

// 帮 generateStructuredData 的流式 mock 构造一次性 chunk 流
function asAsyncIterable(...chunks: Array<{ content: unknown }>): AsyncIterable<{ content: unknown }> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= chunks.length) return { value: undefined, done: true } as const;
          const value = chunks[i++];
          return { value, done: false } as const;
        },
        async return() {
          return { value: undefined, done: true } as const;
        },
      };
    },
  };
}

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: chatOpenAIMock,
}));

import { generateStructuredData, generateText } from '../src/lib/llm';
import { parseLLMJsonResponse } from '../src/lib/llm/content';

function makeSettings(providerOverrides: Record<string, unknown> = {}): AISettings {
  return {
    llmProviders: [
      {
        id: 'p1',
        name: 'Test',
        type: 'openai_compatible',
        baseUrl: 'https://example.com/v1/',
        apiKey: 'test-key',
        models: ['qwen3.6-plus'],
        ...providerOverrides,
      },
    ],
    defaultProviderId: 'p1',
    defaultModel: 'qwen3.6-plus',
  } as AISettings;
}

const BASE_SETTINGS: AISettings = makeSettings();

describe('llm-client langchain adapter', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    bindInvokeMock.mockReset();
    bindStreamMock.mockReset();
    bindMock.mockClear();
    streamMock.mockReset();
    chatOpenAIMock.mockClear();
  });

  it('passes provider enableThinking=false via modelKwargs and uses json mode binding via stream', async () => {
    bindStreamMock.mockResolvedValue(asAsyncIterable({ content: '{"ok":true}' }));

    await generateStructuredData(
      makeSettings({ enableThinking: false }),
      '系统提示',
      '用户输入',
    );

    expect(chatOpenAIMock).toHaveBeenCalledTimes(1);
    expect(chatOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-key',
        model: 'qwen3.6-plus',
        temperature: 0.3,
        configuration: {
          apiKey: 'test-key',
          baseURL: 'https://example.com/v1',
        },
        modelKwargs: {
          enable_thinking: false,
        },
      }),
    );
    expect(bindMock).toHaveBeenCalledWith({
      response_format: { type: 'json_object' },
    });
    expect(bindStreamMock).toHaveBeenCalledTimes(1);
    expect(bindStreamMock.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: '系统提示' }),
        expect.objectContaining({ content: '用户输入' }),
      ]),
    );
  });

  it('does not inject modelKwargs when thinking mode is enabled for plain text generation', async () => {
    invokeMock.mockResolvedValue({
      content: '最终答案',
    });

    await generateText(
      makeSettings({ enableThinking: true }),
      '系统提示',
      '用户输入',
    );

    expect(chatOpenAIMock).toHaveBeenCalledTimes(1);
    const config = chatOpenAIMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config.modelKwargs).toBeUndefined();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: '系统提示' }),
        expect.objectContaining({ content: '用户输入' }),
      ]),
    );
  });

  it('parses fenced json blocks for structured output compatibility', () => {
    expect(parseLLMJsonResponse('```json\n{"cards":[]}\n```')).toEqual({ cards: [] });
  });

  it('parses the first JSON object even when the model adds surrounding prose', () => {
    expect(parseLLMJsonResponse('好的，以下是结果：\n{"cards":[],"summary":"ok"}\n请查收')).toEqual({
      cards: [],
      summary: 'ok',
    });
  });

  it('returns null for invalid structured output', () => {
    expect(parseLLMJsonResponse('not json')).toBeNull();
  });

  it('throws when plain text generation returns empty content', async () => {
    invokeMock.mockResolvedValue({ content: '' });

    await expect(generateText(BASE_SETTINGS, '系统提示', '用户输入')).rejects.toThrow('LLM 返回空内容');
  });
});
