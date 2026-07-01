import type { AISettings, LLMProvider } from '../../types/ai';
import { PI_PROVIDER_PRESETS } from './pi-provider-presets';

/** 服务端下发的单类 Provider 描述：type/path/models 全部由统一网关决定，客户端不可改。 */
export interface LingjiProviderDescriptor {
  /** provider 运行时类型，如 openai_compatible / openai_image / minimax / custom。 */
  type: string;
  /** 拼接到烘焙基址后的路径后缀（llm 为 /v1，其余为空）。 */
  path: string;
  models: string[];
  defaultModel: string;
}

/** 服务端下发的四类网关 Provider 配置（单一真源）。 */
export interface LingjiGatewayConfig {
  llm: LingjiProviderDescriptor;
  image: LingjiProviderDescriptor;
  tts: LingjiProviderDescriptor;
  video: LingjiProviderDescriptor;
}

/**
 * 下发缺失时的本地兜底配置（离线/旧服务端兼容）。正常运行时以服务端 `session.providers` 为准。
 * 与服务端 `lingji.client.providers.*` 默认值保持一致。
 */
export const DEFAULT_LINGJI_GATEWAY_CONFIG: LingjiGatewayConfig = {
  llm: { type: 'openai_compatible', path: '/v1', models: ['gpt-4o-mini', 'gpt-4o'], defaultModel: 'gpt-4o-mini' },
  image: { type: 'openai_image', path: '', models: ['gpt-image-1'], defaultModel: 'gpt-image-1' },
  tts: { type: 'minimax', path: '', models: ['speech-2.8-hd'], defaultModel: 'speech-2.8-hd' },
  video: { type: 'custom', path: '', models: ['lingji-video'], defaultModel: 'lingji-video' },
};

/** 桌面端授权登录成功后，主进程回传的账户会话。apiKey 为长效网关密钥 lj_。 */
export interface LingjiSession {
  apiKey: string;
  profile: { email: string; displayName?: string; avatarUrl?: string };
  balance: number;
  tier: string;
  /** 服务端下发的四类网关 Provider 配置；缺省时用 DEFAULT_LINGJI_GATEWAY_CONFIG 兜底。 */
  providers?: LingjiGatewayConfig;
}

/** 四类兜底 Provider 的确定性 id：重登按 id 幂等 upsert，不产生重复。 */
export const LINGJI_FALLBACK_IDS = {
  llm: 'lingji-fallback-llm',
  image: 'lingji-fallback-image',
  tts: 'lingji-fallback-tts',
  video: 'lingji-fallback-video',
} as const;

/** 托管 Provider 判定：id 以 lingji-fallback- 开头者为服务端下发、不可编辑/删除。 */
export function isLingjiManagedProviderId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('lingji-fallback-');
}

/** 取会话中的下发配置，缺省兜底。 */
function resolveGatewayConfig(session: LingjiSession): LingjiGatewayConfig {
  return session.providers ?? DEFAULT_LINGJI_GATEWAY_CONFIG;
}

/** 烘焙基址（去尾斜杠）+ 下发 path。 */
function joinBase(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path || ''}`;
}

/**
 * 用会话把对话/图片/TTS/视频四类兜底 Provider upsert 进 settings：
 * 同 id 覆盖 apiKey/baseUrl/models（保留用户改过的 name），仅当该类目当前无默认时设为默认。
 * base 为烘焙服务器基址（无尾斜杠、无 /v1），各 provider 的 baseUrl 按各自运行时拼接约定：
 * LLM `{base}/v1`、图片/TTS/视频 `{base}`（分别落 /v1/images/generations、/v1/t2a_v2、/ent/v2/text2video）。
 */
/** 从会话（含服务端下发配置）构建对话兜底 LLM Provider。base 无尾斜杠。 */
export function buildLingjiLlmProvider(session: LingjiSession, base: string): LLMProvider {
  const d = resolveGatewayConfig(session).llm;
  return {
    id: LINGJI_FALLBACK_IDS.llm,
    name: '灵机剪影网关',
    type: d.type as LLMProvider['type'],
    baseUrl: joinBase(base, d.path),
    apiKey: session.apiKey,
    models: d.models,
    defaultModel: d.defaultModel,
    enableThinking: false,
  };
}

export function applyLingjiFallbackProviders(
  settings: AISettings,
  session: LingjiSession,
  base: string,
): AISettings {
  const b = base.replace(/\/+$/, '');
  const key = session.apiKey;
  const cfg = resolveGatewayConfig(session);

  const upsert = <T extends { id: string }>(list: T[], next: T): T[] => {
    const i = list.findIndex((p) => p.id === next.id);
    if (i < 0) return [...list, next];
    const copy = list.slice();
    copy[i] = { ...copy[i], ...next };
    return copy;
  };

  const llm: LLMProvider = buildLingjiLlmProvider(session, b);
  const image = {
    id: LINGJI_FALLBACK_IDS.image,
    name: '灵机剪影图片',
    type: cfg.image.type as import('../../types/ai').ImageProviderType,
    baseUrl: joinBase(b, cfg.image.path),
    apiKey: key,
    models: cfg.image.models,
    extras: { managedBy: 'lingji' },
  };
  const tts = {
    id: LINGJI_FALLBACK_IDS.tts,
    name: '灵机剪影语音',
    type: cfg.tts.type as import('../../types/ai').TTSProviderType,
    baseUrl: joinBase(b, cfg.tts.path),
    apiKey: key,
    models: cfg.tts.models,
  };
  const video = {
    id: LINGJI_FALLBACK_IDS.video,
    name: '灵机剪影视频',
    type: cfg.video.type as import('../../types/ai').VideoProviderType,
    baseUrl: joinBase(b, cfg.video.path),
    apiKey: key,
    models: cfg.video.models,
    extras: { managedBy: 'lingji' },
  };

  return {
    ...settings,
    llmProviders: upsert(settings.llmProviders, llm),
    defaultProviderId: settings.defaultProviderId ?? llm.id,
    defaultModel: settings.defaultModel ?? llm.defaultModel ?? null,
    imageProviders: upsert(settings.imageProviders, image),
    defaultImageProviderId: settings.defaultImageProviderId ?? image.id,
    defaultImageModel: settings.defaultImageModel ?? cfg.image.defaultModel,
    ttsProviders: upsert(settings.ttsProviders, tts),
    defaultTtsProviderId: settings.defaultTtsProviderId ?? tts.id,
    videoProviders: upsert(settings.videoProviders, video),
    defaultVideoProviderId: settings.defaultVideoProviderId ?? video.id,
    defaultVideoModel: settings.defaultVideoModel ?? cfg.video.defaultModel,
  };
}

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
