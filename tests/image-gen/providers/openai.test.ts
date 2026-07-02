import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageGenerationError } from '../../../src/lib/image-gen/errors';
import { openaiImageProvider } from '../../../src/lib/image-gen/providers/openai';
import type {
  ImageGenerationContext,
  ImageGenerationRequest,
  ImageProviderConfig,
} from '../../../src/lib/image-gen/types';

// ── 辅助构建 ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ImageProviderConfig> = {}): ImageProviderConfig {
  return {
    baseUrl: 'https://api.openai.com',
    apiKey: 'test-key',
    ...overrides,
  };
}

function makeCtx(): ImageGenerationContext {
  return {
    taskId: 'task-1',
    signal: new AbortController().signal,
    onProgress: vi.fn(),
  };
}

function makeReq(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    prompt: '一只可爱的猫',
    model: 'gpt-image-1',
    aspectRatio: '1:1',
    n: 1,
    ...overrides,
  };
}

function mockFetchOk(body: unknown, status = 200): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function mockFetchError(body: unknown, status: number): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

// ── 测试套件 ──────────────────────────────────────────────────────────────────

describe('openaiImageProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 基本属性 ──────────────────────────────────────────────────────────────

  it('type 为 openai_image', () => {
    expect(openaiImageProvider.type).toBe('openai_image');
  });

  it('capabilities 符合预期', () => {
    const cap = openaiImageProvider.capabilities;
    expect(cap.aspectRatios).toContain('1:1');
    expect(cap.aspectRatios).toContain('16:9');
    expect(cap.aspectRatios).toContain('9:16');
    expect(cap.maxN).toBe(10);
    expect(cap.supportsImageToImage).toBe(false);
    expect(cap.isAsync).toBe(false);
    expect(cap.defaultModels).toEqual(['gpt-image-1', 'gpt-image-2', 'dall-e-3']);
  });

  // ── 正常 b64_json 响应 ────────────────────────────────────────────────────

  it('正常 b64_json 响应：返回 base64 图片', async () => {
    mockFetchOk({ data: [{ b64_json: 'aGVsbG8=' }] });

    const result = await openaiImageProvider.generate(makeReq(), makeConfig(), makeCtx());

    expect(result.images).toHaveLength(1);
    expect(result.images[0].base64).toBe('aGVsbG8=');
    expect(result.images[0].mimeType).toBe('image/png');
  });

  it('b64_json 响应：请求体包含正确字段（gpt-image 系不发 response_format）', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ b64_json: 'abc' }] }), { status: 200 }),
    );

    await openaiImageProvider.generate(makeReq({ n: 2 }), makeConfig(), makeCtx());

    const [, init] = spy.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.size).toBe('1024x1024');
    expect(body.response_format).toBeUndefined();
    expect(body.n).toBe(2);
  });

  it('dall-e 系模型仍显式发送 response_format=b64_json', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ b64_json: 'abc' }] }), { status: 200 }),
    );

    await openaiImageProvider.generate(makeReq({ model: 'dall-e-3' }), makeConfig(), makeCtx());

    const [, init] = spy.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.response_format).toBe('b64_json');
  });

  // ── 正常 url 响应 ─────────────────────────────────────────────────────────

  it('正常 url 响应：返回 url 图片', async () => {
    mockFetchOk({ data: [{ url: 'https://example.com/img.png' }] });

    const result = await openaiImageProvider.generate(makeReq(), makeConfig(), makeCtx());

    expect(result.images).toHaveLength(1);
    expect(result.images[0].url).toBe('https://example.com/img.png');
  });

  it('相对路径 url：按 baseUrl 自动拼接为绝对地址', async () => {
    mockFetchOk({
      data: [{ url: '/p/img/img_31789a372f1d4361ba595ea3/0?exp=1776837437984&sig=feaf5b' }],
    });

    const result = await openaiImageProvider.generate(
      makeReq(),
      makeConfig({ baseUrl: 'http://127.0.0.1:8080' }),
      makeCtx(),
    );

    expect(result.images[0].url).toBe(
      'http://127.0.0.1:8080/p/img/img_31789a372f1d4361ba595ea3/0?exp=1776837437984&sig=feaf5b',
    );
  });

  it('baseUrl 结尾斜杠与相对路径冲突：仍正确解析', async () => {
    mockFetchOk({ data: [{ url: '/p/img/foo' }] });

    const result = await openaiImageProvider.generate(
      makeReq(),
      makeConfig({ baseUrl: 'http://127.0.0.1:8080/' }),
      makeCtx(),
    );

    expect(result.images[0].url).toBe('http://127.0.0.1:8080/p/img/foo');
  });

  // ── aspectRatio 映射 ──────────────────────────────────────────────────────

  it('gpt-image 系 aspectRatio 16:9 → size=1536x1024', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ b64_json: 'x' }] }), { status: 200 }),
    );

    await openaiImageProvider.generate(makeReq({ aspectRatio: '16:9' }), makeConfig(), makeCtx());

    const [, init] = spy.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.size).toBe('1536x1024');
  });

  it('gpt-image 系 aspectRatio 9:16 → size=1024x1536', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ b64_json: 'x' }] }), { status: 200 }),
    );

    await openaiImageProvider.generate(makeReq({ aspectRatio: '9:16' }), makeConfig(), makeCtx());

    const [, init] = spy.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.size).toBe('1024x1536');
  });

  it('dall-e 系 aspectRatio 16:9 → size=1792x1024', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ b64_json: 'x' }] }), { status: 200 }),
    );

    await openaiImageProvider.generate(
      makeReq({ model: 'dall-e-3', aspectRatio: '16:9' }),
      makeConfig(),
      makeCtx(),
    );

    const [, init] = spy.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.size).toBe('1792x1024');
  });

  // ── extraParams 透传 ──────────────────────────────────────────────────────

  it('extraParams 含 quality+style 时透传到 body', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ b64_json: 'x' }] }), { status: 200 }),
    );

    await openaiImageProvider.generate(
      makeReq({ extraParams: { quality: 'hd', style: 'vivid' } }),
      makeConfig(),
      makeCtx(),
    );

    const [, init] = spy.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.quality).toBe('hd');
    expect(body.style).toBe('vivid');
  });

  it('未传 extraParams 时 quality/style 不出现在 body', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ b64_json: 'x' }] }), { status: 200 }),
    );

    await openaiImageProvider.generate(makeReq(), makeConfig(), makeCtx());

    const [, init] = spy.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.quality).toBeUndefined();
    expect(body.style).toBeUndefined();
  });

  // ── HTTP 错误 ─────────────────────────────────────────────────────────────

  it('HTTP 401 抛 ImageGenerationError(code=auth)', async () => {
    mockFetchError({ error: { message: 'Unauthorized' } }, 401);

    await expect(
      openaiImageProvider.generate(makeReq(), makeConfig(), makeCtx()),
    ).rejects.toMatchObject({ code: 'auth', providerType: 'openai_image' });
  });

  it('HTTP 429 抛 ImageGenerationError(code=rate_limited)', async () => {
    mockFetchError({ error: { message: 'Rate limit exceeded' } }, 429);

    await expect(
      openaiImageProvider.generate(makeReq(), makeConfig(), makeCtx()),
    ).rejects.toMatchObject({ code: 'rate_limited', providerType: 'openai_image' });
  });

  it('HTTP 400 + content_policy_violation 抛 code=content_policy', async () => {
    mockFetchError({ error: { code: 'content_policy_violation', message: 'Policy violation' } }, 400);

    await expect(
      openaiImageProvider.generate(makeReq(), makeConfig(), makeCtx()),
    ).rejects.toMatchObject({ code: 'content_policy', providerType: 'openai_image' });
  });

  it('抛出的错误是 ImageGenerationError 实例', async () => {
    mockFetchError({ error: { message: 'Unauthorized' } }, 401);

    await expect(
      openaiImageProvider.generate(makeReq(), makeConfig(), makeCtx()),
    ).rejects.toBeInstanceOf(ImageGenerationError);
  });

  // ── baseUrl 默认值 ────────────────────────────────────────────────────────

  it('baseUrl 为空时使用默认 https://api.openai.com', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ b64_json: 'x' }] }), { status: 200 }),
    );

    await openaiImageProvider.generate(makeReq(), makeConfig({ baseUrl: '' }), makeCtx());

    const [calledUrl] = spy.mock.calls[0];
    expect(String(calledUrl)).toContain('https://api.openai.com');
  });

  // ── 网络异常 ──────────────────────────────────────────────────────────────

  it('网络异常（fetch reject）抛 code=network', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Failed to fetch'));

    await expect(
      openaiImageProvider.generate(makeReq(), makeConfig(), makeCtx()),
    ).rejects.toMatchObject({ code: 'network', providerType: 'openai_image' });
  });

  // ── 进度回调 ──────────────────────────────────────────────────────────────

  it('进度回调按阶段上报', async () => {
    mockFetchOk({ data: [{ b64_json: 'x' }] });

    const ctx = makeCtx();
    await openaiImageProvider.generate(makeReq(), makeConfig(), ctx);

    const progressCalls = (ctx.onProgress as ReturnType<typeof vi.fn>).mock.calls;
    expect(progressCalls[0][0]).toMatchObject({ percent: 10, phase: 'submitting' });
    expect(progressCalls[1][0]).toMatchObject({ percent: 80, phase: 'rendering' });
    expect(progressCalls[2][0]).toMatchObject({ percent: 100, phase: 'rendering' });
  });
});
