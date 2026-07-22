import { describe, it, expect, vi } from 'vitest';
import { createOpenAiSummaryProvider } from '@/processing/summary-provider';
import type { TranscriptDocument } from '@/domain/models';

const transcript: TranscriptDocument = {
  videoId: 'v1',
  provider: 'openai',
  language: 'zh',
  fullText: '这是一段口播全文，用于生成摘要。',
  srtText: '',
  segments: [{ text: '这是一段口播全文，用于生成摘要。', startMs: 0, endMs: 5000 }],
  createdAt: 0,
};

function chatJson(content: string) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) } as Response;
}

describe('createOpenAiSummaryProvider', () => {
  it('posts to /chat/completions and validates the parsed analysis', async () => {
    const content = JSON.stringify({
      category: '深度分析',
      summary: '这是摘要',
      keyPoints: ['点1'],
      tags: ['标签'],
    });
    const fetchImpl = vi.fn(async () => chatJson(content));
    const provider = createOpenAiSummaryProvider(
      { baseUrl: 'https://llm.example/v1', apiKey: 'sk-2', model: 'gpt-x', temperature: 0.3 },
      { fetchImpl, now: () => 9 },
    );
    const analysis = await provider.summarize(transcript, { videoId: 'v1' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://llm.example/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-x');
    expect(body.temperature).toBe(0.3);
    expect(analysis.category).toBe('深度分析');
    expect(analysis.summary).toBe('这是摘要');
    expect(analysis.model).toBe('gpt-x');
    expect(analysis.createdAt).toBe(9);
  });

  it('omits temperature for Kimi Coding even when one is configured', async () => {
    const content = JSON.stringify({
      category: '深度分析',
      summary: '这是摘要',
      keyPoints: ['点1'],
      tags: ['标签'],
    });
    const fetchImpl = vi.fn(async () => chatJson(content));
    const provider = createOpenAiSummaryProvider(
      {
        baseUrl: 'https://api.kimi.com/coding/v1',
        apiKey: 'sk-kimi',
        model: 'k3',
        temperature: 0.3,
      },
      { fetchImpl },
    );

    await provider.summarize(transcript, { videoId: 'v1' });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBeUndefined();
  });

  it('throws SUMMARY_INVALID_RESPONSE when content is not valid JSON', async () => {
    const fetchImpl = vi.fn(async () => chatJson('抱歉，我无法输出 JSON'));
    const provider = createOpenAiSummaryProvider(
      { baseUrl: 'https://llm.example', apiKey: 'x', model: 'm' },
      { fetchImpl },
    );
    await expect(provider.summarize(transcript, { videoId: 'v1' })).rejects.toMatchObject({
      error: { code: 'SUMMARY_INVALID_RESPONSE' },
    });
  });

  it('throws SUMMARY_FAILED on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
    const provider = createOpenAiSummaryProvider(
      { baseUrl: 'https://llm.example', apiKey: 'x', model: 'm' },
      { fetchImpl },
    );
    await expect(provider.summarize(transcript, { videoId: 'v1' })).rejects.toMatchObject({
      error: { code: 'SUMMARY_FAILED' },
    });
  });

  it('retries without response_format when the endpoint rejects json_object with 400', async () => {
    const ok = JSON.stringify({ category: '深度分析', summary: 's', keyPoints: ['k'], tags: ['t'] });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'response_format is not supported',
      } as Response)
      .mockResolvedValueOnce(chatJson(ok));
    const provider = createOpenAiSummaryProvider(
      { baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', apiKey: 'k', model: 'doubao-seed-2.0-code' },
      { fetchImpl, now: () => 1 },
    );
    const analysis = await provider.summarize(transcript, { videoId: 'v1' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    const secondBody = JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string);
    expect(firstBody.response_format).toEqual({ type: 'json_object' });
    expect(secondBody.response_format).toBeUndefined();
    expect(analysis.summary).toBe('s');
  });

  it('surfaces the API error body in the SUMMARY_FAILED message', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'invalid model: doubao-seed-2.0-code',
    }) as Response);
    const provider = createOpenAiSummaryProvider(
      { baseUrl: 'https://ark.example/api/coding/v3', apiKey: 'x', model: 'doubao-seed-2.0-code' },
      { fetchImpl },
    );
    await expect(provider.summarize(transcript, { videoId: 'v1' })).rejects.toMatchObject({
      error: { code: 'SUMMARY_FAILED', message: expect.stringContaining('invalid model') },
    });
    // 首次 400 触发一次去 json_object 重试，仍 400 → 共 2 次请求。
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('parses JSON wrapped in markdown code fences', async () => {
    const fenced =
      '```json\n' +
      JSON.stringify({ category: '深度分析', summary: 's', keyPoints: ['k'], tags: ['t'] }) +
      '\n```';
    const fetchImpl = vi.fn(async () => chatJson(fenced));
    const provider = createOpenAiSummaryProvider(
      { baseUrl: 'https://llm.example', apiKey: 'x', model: 'm' },
      { fetchImpl, now: () => 2 },
    );
    const analysis = await provider.summarize(transcript, { videoId: 'v1' });
    expect(analysis.summary).toBe('s');
  });
});
