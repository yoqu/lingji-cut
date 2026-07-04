import { LMSTUDIO_DEFAULT_BASE_URL, type LLMProvider } from '../../types/ai';

const GEMINI_DEFAULT_LIST_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';

function trimSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * 按 baseUrl 末尾是否已含 /v1 智能拼接 /models 端点。
 * - 已以 /v1、/v1/ 结尾：仅追加 /models
 * - 否则：追加 /v1/models
 */
function joinModelsEndpoint(baseUrl: string): string {
  const normalized = trimSlashes(baseUrl);
  if (/\/v\d+(?:beta)?$/.test(normalized)) {
    return `${normalized}/models`;
  }
  return `${normalized}/v1/models`;
}

interface OpenAIModelsResponse {
  data?: Array<{ id?: string }>;
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}${text ? ` - ${text.slice(0, 200)}` : ''}`,
    );
  }
  if (!text) {
    throw new Error('响应内容为空');
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`响应不是合法 JSON：${text.slice(0, 200)}`);
  }
}

async function fetchOpenAICompatibleModels(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const endpoint = joinModelsEndpoint(baseUrl);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(endpoint, { method: 'GET', headers });
  const payload = await readJson<OpenAIModelsResponse>(response);
  return (payload.data ?? [])
    .map((item) => item?.id?.trim())
    .filter((id): id is string => Boolean(id));
}

interface AnthropicModelsResponse {
  data?: Array<{ id?: string }>;
}

async function fetchAnthropicModels(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  if (!apiKey) {
    throw new Error('Anthropic 拉取模型列表需要 API Key');
  }
  const root = trimSlashes(baseUrl) || ANTHROPIC_DEFAULT_BASE;
  const endpoint = /\/v\d+$/.test(root) ? `${root}/models` : `${root}/v1/models`;
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // 浏览器/Electron renderer 直连时 Anthropic 要求显式确认
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  });
  const payload = await readJson<AnthropicModelsResponse>(response);
  return (payload.data ?? [])
    .map((item) => item?.id?.trim())
    .filter((id): id is string => Boolean(id));
}

interface GeminiModelsResponse {
  models?: Array<{
    name?: string;
    supportedGenerationMethods?: string[];
  }>;
}

async function fetchGeminiModels(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  if (!apiKey) {
    throw new Error('Gemini 拉取模型列表需要 API Key');
  }
  const root = trimSlashes(baseUrl) || GEMINI_DEFAULT_LIST_BASE;
  const endpoint = /\/v\d+(?:beta)?$/.test(root)
    ? `${root}/models`
    : `${root}/v1beta/models`;
  const url = `${endpoint}?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const payload = await readJson<GeminiModelsResponse>(response);
  return (payload.models ?? [])
    .filter((item) => {
      const methods = item?.supportedGenerationMethods;
      // 没声明能力时保守保留；声明了则要求支持 generateContent
      if (!methods || methods.length === 0) return true;
      return methods.includes('generateContent');
    })
    .map((item) => item?.name?.replace(/^models\//, '').trim())
    .filter((id): id is string => Boolean(id));
}

/**
 * 拉取目标 Provider 支持的模型列表，结果已去重并排序。
 * 任何失败都会抛出携带可读 message 的错误，调用方负责展示。
 */
export async function fetchProviderModels(provider: LLMProvider): Promise<string[]> {
  const apiKey = provider.apiKey?.trim() ?? '';
  const baseUrl = provider.baseUrl?.trim() ?? '';

  let models: string[];
  switch (provider.type) {
    case 'lmstudio':
      models = await fetchOpenAICompatibleModels(
        baseUrl || LMSTUDIO_DEFAULT_BASE_URL,
        apiKey,
      );
      break;
    case 'openai_compatible':
    case 'openai_responses':
    case 'volcengine_ark':
      // 火山方舟为 OpenAI 兼容端点，模型列表按 {baseUrl}/models 拉取；
      // 端点不支持时调用方会拿到报错、用户手动填模型名即可。
      if (!baseUrl) throw new Error('请先填写 Base URL');
      models = await fetchOpenAICompatibleModels(baseUrl, apiKey);
      break;
    case 'minimax':
      // MiniMax 走 Anthropic 兼容端点；模型列表也按 Anthropic /models 拉取，
      // 端点不支持时调用方会拿到报错、用户手动填模型名即可。
      models = await fetchAnthropicModels(baseUrl || 'https://api.minimaxi.com/anthropic', apiKey);
      break;
    case 'gemini':
      models = await fetchGeminiModels(baseUrl, apiKey);
      break;
    default: {
      const exhaustive: never = provider.type;
      throw new Error(`暂不支持该 Provider 类型：${exhaustive}`);
    }
  }

  return Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
}
