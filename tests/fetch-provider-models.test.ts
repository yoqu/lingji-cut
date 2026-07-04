import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchProviderModels } from '../src/lib/llm/fetch-models';
import type { LLMProvider } from '../src/types/ai';

function makeProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    id: 'p',
    name: 'P',
    type: 'openai_compatible',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    models: [],
    enableThinking: true,
    ...overrides,
  };
}

function mockResponse(payload: unknown, init: { ok?: boolean; status?: number } = {}) {
  const ok = init.ok ?? true;
  const status = init.status ?? (ok ? 200 : 500);
  return {
    ok,
    status,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

describe('fetchProviderModels', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('OpenAI 兼容：直接复用末尾 /v1 并带 Bearer header，结果去重排序', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }, { id: 'gpt-4o' }] }),
    );

    const result = await fetchProviderModels(makeProvider());

    expect(result).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('OpenAI 兼容：baseUrl 不含 /v1 时自动追加', async () => {
    fetchMock.mockResolvedValue(mockResponse({ data: [{ id: 'm1' }] }));

    await fetchProviderModels(makeProvider({ baseUrl: 'https://api.example.com' }));

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/models');
  });

  it('LM Studio：baseUrl 留空时回退到 localhost:1234；apiKey 留空时不带 Authorization', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ data: [{ id: 'qwen2.5-7b-instruct' }] }),
    );

    const result = await fetchProviderModels(
      makeProvider({ type: 'lmstudio', baseUrl: '', apiKey: '' }),
    );

    expect(result).toEqual(['qwen2.5-7b-instruct']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:1234/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('MiniMax：走 Anthropic 兼容端点，使用 x-api-key + anthropic-version header', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ data: [{ id: 'claude-sonnet-4-6' }, { id: 'claude-haiku-4-5' }] }),
    );

    const result = await fetchProviderModels(
      makeProvider({ type: 'minimax', baseUrl: '', apiKey: 'a-key' }),
    );

    expect(result).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-6']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.minimaxi.com/anthropic/v1/models');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('a-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('MiniMax：缺少 apiKey 直接抛错', async () => {
    await expect(
      fetchProviderModels(makeProvider({ type: 'minimax', apiKey: '' })),
    ).rejects.toThrow(/API Key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Gemini：将 key 拼到 query，过滤不支持 generateContent 的模型并去掉 models/ 前缀', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        models: [
          { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-2.5-flash' },
        ],
      }),
    );

    const result = await fetchProviderModels(
      makeProvider({ type: 'gemini', baseUrl: '', apiKey: 'g-key' }),
    );

    expect(result).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url.startsWith('https://generativelanguage.googleapis.com/v1beta/models?key=')).toBe(true);
    expect(url).toContain('g-key');
  });

  it('HTTP 失败时抛出携带状态码的错误', async () => {
    fetchMock.mockResolvedValue(mockResponse({ error: 'unauthorized' }, { ok: false, status: 401 }));

    await expect(fetchProviderModels(makeProvider())).rejects.toThrow(/HTTP 401/);
  });
});
