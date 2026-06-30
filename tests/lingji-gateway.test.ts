import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectLingjiGateway } from '../src/lib/llm/lingji-gateway';

function mockEnvelope(data: unknown, code = 0, message = 'ok') {
  return { ok: true, status: 200, json: async () => ({ code, message, data }) } as Response;
}

afterEach(() => vi.restoreAllMocks());

describe('connectLingjiGateway', () => {
  it('登录并生成密钥后构造 openai_compatible Provider', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockEnvelope({ accessToken: 'jwt-token' }))
      .mockResolvedValueOnce(mockEnvelope({ token: 'lj_secret' }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = await connectLingjiGateway({
      baseUrl: 'http://localhost:8080/',
      email: 'a@b.com',
      password: 'pass1234',
    });

    expect(provider.type).toBe('openai_compatible');
    expect(provider.baseUrl).toBe('http://localhost:8080/v1');
    expect(provider.apiKey).toBe('lj_secret');
    expect(provider.models.length).toBeGreaterThan(0);
    expect(provider.defaultModel).toBe(provider.models[0]);

    // 第一调登录、第二调建密钥(带 Bearer JWT)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/api/auth/login');
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8080/api/client/api-keys');
    const keyHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(keyHeaders.Authorization).toBe('Bearer jwt-token');
  });

  it('剥离误填的 /v1 后缀', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockEnvelope({ accessToken: 't' }))
      .mockResolvedValueOnce(mockEnvelope({ token: 'lj_x' }));
    vi.stubGlobal('fetch', fetchMock);
    const p = await connectLingjiGateway({ baseUrl: 'https://gw.example.com/v1', email: 'a@b.com', password: 'p' });
    expect(p.baseUrl).toBe('https://gw.example.com/v1');
    expect(fetchMock.mock.calls[0][0]).toBe('https://gw.example.com/api/auth/login');
  });

  it('登录失败(业务码非0)抛出可读错误', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(mockEnvelope(null, 2002, '邮箱或密码错误'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      connectLingjiGateway({ baseUrl: 'http://localhost:8080', email: 'a@b.com', password: 'bad' }),
    ).rejects.toThrow('邮箱或密码错误');
  });
});
