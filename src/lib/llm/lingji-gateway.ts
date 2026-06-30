import type { LLMProvider } from '../../types/ai';
import { PI_PROVIDER_PRESETS } from './pi-provider-presets';

/** 灵机剪影网关一键登录的输入。baseUrl 为网关根地址，如 http://localhost:8080 */
export interface ConnectGatewayOptions {
  baseUrl: string;
  email: string;
  password: string;
}

interface Envelope<T> {
  code: number;
  message: string;
  data: T;
}

/** 归一根地址：去尾斜杠并剥离可能误填的 /v1 后缀。 */
function normalizeApiBase(raw: string): string {
  return raw.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

async function postJson<T>(url: string, body: unknown, token?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('无法连接网关，请检查地址与网络');
  }
  let env: Envelope<T>;
  try {
    env = (await res.json()) as Envelope<T>;
  } catch {
    throw new Error(`网关返回异常（HTTP ${res.status}）`);
  }
  if (env.code !== 0) throw new Error(env.message || `请求失败（${env.code}）`);
  return env.data;
}

const LINGJI_PRESET = PI_PROVIDER_PRESETS.find((p) => p.id === 'lingji-gateway');

function genId(): string {
  return `lingji-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 一键登录灵机剪影账户：登录取令牌 → 生成长效网关密钥 → 构造可直接调用的
 * openai_compatible Provider（指向网关 /v1，按积分计费，开箱即用）。
 */
export async function connectLingjiGateway(opts: ConnectGatewayOptions): Promise<LLMProvider> {
  const apiBase = normalizeApiBase(opts.baseUrl);
  if (!apiBase) throw new Error('请填写网关地址');

  const login = await postJson<{ accessToken: string }>(
    `${apiBase}/api/auth/login`,
    { email: opts.email.trim(), password: opts.password },
  );
  const key = await postJson<{ token: string }>(
    `${apiBase}/api/client/api-keys`,
    { name: '桌面端' },
    login.accessToken,
  );

  const models = LINGJI_PRESET?.models ?? ['gpt-4o-mini', 'gpt-4o'];
  return {
    id: genId(),
    name: LINGJI_PRESET?.providerName ?? '灵机剪影网关',
    type: 'openai_compatible',
    baseUrl: `${apiBase}/v1`,
    apiKey: key.token,
    models,
    defaultModel: models[0],
    enableThinking: LINGJI_PRESET?.enableThinking ?? false,
  };
}
