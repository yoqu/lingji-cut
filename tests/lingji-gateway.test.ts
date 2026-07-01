import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyLingjiFallbackProviders,
  connectLingjiGateway,
  isLingjiManagedProviderId,
  LINGJI_FALLBACK_IDS,
  type LingjiGatewayConfig,
  type LingjiSession,
} from '../src/lib/llm/lingji-gateway';
import { buildDefaultAISettings } from '../src/store/ai';

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

describe('applyLingjiFallbackProviders', () => {
  const SESSION: LingjiSession = {
    apiKey: 'lj_abc',
    profile: { email: 'a@b.com' },
    balance: 100,
    tier: 'FREE',
  };

  it('四类都 upsert，且空默认时设为默认（baseUrl 按约定拼接）', () => {
    const out = applyLingjiFallbackProviders(buildDefaultAISettings(), SESSION, 'http://localhost:15173');
    expect(out.llmProviders.find((p) => p.id === LINGJI_FALLBACK_IDS.llm)?.baseUrl).toBe('http://localhost:15173/v1');
    expect(out.imageProviders.find((p) => p.id === LINGJI_FALLBACK_IDS.image)?.baseUrl).toBe('http://localhost:15173');
    expect(out.ttsProviders.find((p) => p.id === LINGJI_FALLBACK_IDS.tts)?.baseUrl).toBe('http://localhost:15173');
    expect(out.videoProviders.find((p) => p.id === LINGJI_FALLBACK_IDS.video)?.baseUrl).toBe('http://localhost:15173');
    expect(out.defaultProviderId).toBe(LINGJI_FALLBACK_IDS.llm);
    expect(out.defaultImageProviderId).toBe(LINGJI_FALLBACK_IDS.image);
    expect(out.defaultTtsProviderId).toBe(LINGJI_FALLBACK_IDS.tts);
    expect(out.defaultVideoProviderId).toBe(LINGJI_FALLBACK_IDS.video);
  });

  it('已有默认时不覆盖用户选择，但仍 upsert provider', () => {
    const base = { ...buildDefaultAISettings(), defaultProviderId: 'user-x', defaultModel: 'm' };
    const out = applyLingjiFallbackProviders(base, SESSION, 'http://localhost:15173');
    expect(out.defaultProviderId).toBe('user-x');
    expect(out.llmProviders.some((p) => p.id === LINGJI_FALLBACK_IDS.llm)).toBe(true);
  });

  it('重复调用 id 幂等：不重复，且刷新 apiKey', () => {
    const once = applyLingjiFallbackProviders(buildDefaultAISettings(), SESSION, 'http://localhost:15173');
    const twice = applyLingjiFallbackProviders(once, { ...SESSION, apiKey: 'lj_new' }, 'http://localhost:15173');
    expect(twice.llmProviders.filter((p) => p.id === LINGJI_FALLBACK_IDS.llm)).toHaveLength(1);
    expect(twice.llmProviders.find((p) => p.id === LINGJI_FALLBACK_IDS.llm)?.apiKey).toBe('lj_new');
    expect(twice.imageProviders.filter((p) => p.id === LINGJI_FALLBACK_IDS.image)).toHaveLength(1);
  });

  it('去掉 base 尾斜杠', () => {
    const out = applyLingjiFallbackProviders(buildDefaultAISettings(), SESSION, 'https://lingji.qushenma.com/');
    expect(out.llmProviders.find((p) => p.id === LINGJI_FALLBACK_IDS.llm)?.baseUrl).toBe('https://lingji.qushenma.com/v1');
  });

  it('服务端下发配置优先：type/path/models 全部来自 session.providers', () => {
    const providers: LingjiGatewayConfig = {
      llm: { type: 'openai_compatible', path: '/gw', models: ['srv-chat'], defaultModel: 'srv-chat' },
      image: { type: 'openai_image', path: '/img', models: ['srv-img'], defaultModel: 'srv-img' },
      tts: { type: 'minimax', path: '/tts', models: ['srv-tts'], defaultModel: 'srv-tts' },
      video: { type: 'custom', path: '/vid', models: ['srv-vid'], defaultModel: 'srv-vid' },
    };
    const out = applyLingjiFallbackProviders(
      buildDefaultAISettings(),
      { ...SESSION, providers },
      'http://localhost:15173',
    );
    expect(out.llmProviders.find((p) => p.id === LINGJI_FALLBACK_IDS.llm)?.baseUrl).toBe('http://localhost:15173/gw');
    expect(out.imageProviders.find((p) => p.id === LINGJI_FALLBACK_IDS.image)?.baseUrl).toBe('http://localhost:15173/img');
    expect(out.imageProviders.find((p) => p.id === LINGJI_FALLBACK_IDS.image)?.models).toEqual(['srv-img']);
    expect(out.ttsProviders.find((p) => p.id === LINGJI_FALLBACK_IDS.tts)?.baseUrl).toBe('http://localhost:15173/tts');
    expect(out.videoProviders.find((p) => p.id === LINGJI_FALLBACK_IDS.video)?.models).toEqual(['srv-vid']);
    expect(out.defaultModel).toBe('srv-chat');
  });
});

describe('isLingjiManagedProviderId', () => {
  it('识别托管 id 前缀', () => {
    expect(isLingjiManagedProviderId(LINGJI_FALLBACK_IDS.llm)).toBe(true);
    expect(isLingjiManagedProviderId('lingji-fallback-image')).toBe(true);
    expect(isLingjiManagedProviderId('user-provider-x')).toBe(false);
    expect(isLingjiManagedProviderId(null)).toBe(false);
    expect(isLingjiManagedProviderId(undefined)).toBe(false);
  });
});
