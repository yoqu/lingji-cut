import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AISettings } from '../src/types/ai';

const { streamMock, invokeMock, bindMock, chatOpenAIMock } = vi.hoisted(() => {
  const stream = vi.fn();
  const invoke = vi.fn();
  const bind = vi.fn();
  const chatOpenAI = vi.fn().mockImplementation(() => ({
    stream,
    invoke,
    bind,
  }));

  return {
    streamMock: stream,
    invokeMock: invoke,
    bindMock: bind,
    chatOpenAIMock: chatOpenAI,
  };
});

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: chatOpenAIMock,
}));

import { streamText } from '../src/lib/llm';

function makeSettings(providerOverrides: Record<string, unknown> = {}): AISettings {
  return {
    llmProviders: [
      {
        id: 'p1',
        name: 'Test',
        type: 'openai_compatible',
        baseUrl: 'https://example.com/v1',
        apiKey: 'test-key',
        models: ['gpt-4o-mini'],
        ...providerOverrides,
      },
    ],
    defaultProviderId: 'p1',
    defaultModel: 'gpt-4o-mini',
  } as AISettings;
}

const TEST_SETTINGS: AISettings = makeSettings();

describe('streamText', () => {
  beforeEach(() => {
    streamMock.mockReset();
    invokeMock.mockReset();
    bindMock.mockReset();
    chatOpenAIMock.mockClear();
  });

  it('streams text chunks from LangChain directly', async () => {
    streamMock.mockImplementation(async function* streamOnce() {
      yield { content: '第一段' };
      yield { content: '第二段' };
    });

    const onChunk = vi.fn();
    const result = await streamText(TEST_SETTINGS, '系统提示', '用户输入', onChunk);

    expect(result).toBe('第一段第二段');
    expect(onChunk.mock.calls.map(([chunk]) => chunk)).toEqual(['第一段', '第二段']);
    expect(chatOpenAIMock).toHaveBeenCalledTimes(1);
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(streamMock.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: '系统提示' }),
        expect.objectContaining({ content: '用户输入' }),
      ]),
    );
  });

  it('routes reasoning chunks to dedicated callback', async () => {
    streamMock.mockImplementation(async function* streamWithReasoning() {
      yield { content: '', additional_kwargs: { reasoning_content: '先分析一下' } };
      yield { content: '最终答案' };
    });

    const onChunk = vi.fn();
    const onReasoningChunk = vi.fn();
    const result = await streamText(
      TEST_SETTINGS,
      '系统提示',
      '用户输入',
      onChunk,
      { onReasoningChunk },
    );

    expect(result).toBe('最终答案');
    expect(onChunk.mock.calls.map(([chunk]) => chunk)).toEqual(['最终答案']);
    expect(onReasoningChunk.mock.calls.map(([chunk]) => chunk)).toEqual(['先分析一下']);
  });

  it('passes provider enableThinking=false through modelKwargs', async () => {
    streamMock.mockImplementation(async function* streamOnce() {
      yield { content: '最终答案' };
    });

    await streamText(
      makeSettings({ enableThinking: false }),
      '系统提示',
      '用户输入',
      vi.fn(),
    );

    expect(chatOpenAIMock).toHaveBeenCalledTimes(1);
    expect(chatOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelKwargs: {
          enable_thinking: false,
        },
      }),
    );
  });

  it('throws when the stream never yields text', async () => {
    streamMock.mockImplementation(async function* emptyStream() {
      yield { content: '' };
    });

    await expect(streamText(TEST_SETTINGS, '系统提示', '用户输入', vi.fn())).rejects.toThrow(
      'LLM 流式返回空内容',
    );
  });

  it('throws a configuration error when no provider is configured', async () => {
    const empty = {
      llmProviders: [],
      defaultProviderId: null,
      defaultModel: null,
    } as unknown as AISettings;

    await expect(streamText(empty, '系统提示', '用户输入', vi.fn())).rejects.toThrow(
      '请先在「设置 → AI」中配置 LLM Provider 与模型',
    );
    expect(chatOpenAIMock).not.toHaveBeenCalled();
  });
});
