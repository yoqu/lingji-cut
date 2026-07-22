/**
 * 共享 LLM JSON 调用层。
 *
 * 摘要（summary-provider）与爆款拆解（insight-provider）共用同一套 Provider 调用：
 * - 'openai'：POST {baseUrl}/chat/completions（json_object 输出，400 去 response_format 重试一次）
 * - 'anthropic'：POST {baseUrl}/v1/messages（Anthropic Messages，含 MiniMax anthropic 端点）
 * 返回模型输出文本经 loose JSON 解析后的 unknown，交由各自的运行时校验器收敛。
 *
 * 错误：LLM_REQUEST_FAILED（请求失败/响应非 ok）/ LLM_INVALID_RESPONSE（缺内容或非法 JSON）。
 */
import type { LlmProtocol } from '@/domain/models';
import type { SonarErrorCode } from '@/domain/errors';
import { SonarException, makeError } from '@/domain/errors';

export interface LlmJsonConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 默认 'openai'。 */
  protocol?: LlmProtocol;
  temperature?: number;
  /** anthropic max_tokens（openai 不限）。默认 1024。 */
  maxTokens?: number;
}

/** 各调用方注入自己的错误码，保持既有契约（摘要用 SUMMARY_*，拆解用 INSIGHT_*）。 */
export interface LlmJsonErrorCodes {
  /** 请求失败 / 响应非 ok。 */
  request: SonarErrorCode;
  /** 缺内容 / 非法 JSON。 */
  invalid: SonarErrorCode;
}

const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 1024;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function isKimiCodingBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === 'api.kimi.com' && /^\/coding(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

/** 读取响应体文本用于错误展示；失败回退空串（不掩盖原始状态码）。 */
async function safeErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.trim().slice(0, 300);
  } catch {
    return '';
  }
}

/** 去除 ```json 围栏 / 提取最外层 {...}，容忍模型未严格只输出 JSON 的情况。 */
export function parseLooseJson(content: string, invalidCode: SonarErrorCode): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(body.slice(start, end + 1));
    }
    throw new SonarException(makeError(invalidCode, '模型输出不是合法 JSON'));
  }
}

/** OpenAI 兼容：chat/completions，返回模型输出文本（应为 JSON 字符串）。 */
async function callOpenAi(
  fetchImpl: typeof fetch,
  config: LlmJsonConfig,
  codes: LlmJsonErrorCodes,
  system: string,
  user: string,
): Promise<string> {
  const request = (jsonMode: boolean): Promise<Response> => {
    const body: Record<string, unknown> = {
      model: config.model,
      ...(!isKimiCodingBaseUrl(config.baseUrl)
        ? { temperature: config.temperature ?? DEFAULT_TEMPERATURE }
        : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    // response_format 仅部分 OpenAI 兼容端点支持；不支持的（如火山方舟 Coding）会返回 400。
    if (jsonMode) body.response_format = { type: 'json_object' };
    return fetchImpl(joinUrl(config.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  };

  let res = await request(true);
  // 400 多半是参数不被接受：去掉 response_format 重试一次（提示词已要求只输出 JSON，
  // 解析时再容忍 ``` 围栏 / 前后缀文字）。其它状态码（401/403/429/5xx）不重试。
  if (res.status === 400) {
    res = await request(false);
  }
  if (!res.ok) {
    const detail = await safeErrorBody(res);
    throw new SonarException(
      makeError(codes.request, `模型请求失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`, {
        retryable: true,
      }),
    );
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new SonarException(makeError(codes.invalid, '模型响应缺少内容'));
  }
  return content;
}

/** Anthropic Messages：v1/messages，返回首个 text block。 */
async function callAnthropic(
  fetchImpl: typeof fetch,
  config: LlmJsonConfig,
  codes: LlmJsonErrorCodes,
  system: string,
  user: string,
): Promise<string> {
  const res = await fetchImpl(joinUrl(config.baseUrl, 'v1/messages'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      // 允许浏览器/扩展环境直连（CORS）。
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(!isKimiCodingBaseUrl(config.baseUrl)
        ? { temperature: config.temperature ?? DEFAULT_TEMPERATURE }
        : {}),
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const detail = await safeErrorBody(res);
    throw new SonarException(
      makeError(codes.request, `模型请求失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`, {
        retryable: true,
      }),
    );
  }
  const json = (await res.json()) as { content?: Array<{ type?: string; text?: unknown }> };
  const block = json.content?.find((b) => b.type === 'text') ?? json.content?.[0];
  const content = block?.text;
  if (typeof content !== 'string') {
    throw new SonarException(makeError(codes.invalid, '模型响应缺少内容'));
  }
  return content;
}

/**
 * 调用 LLM 并解析其 JSON 输出。请求失败抛 LLM_REQUEST_FAILED，缺内容/非法 JSON 抛 LLM_INVALID_RESPONSE。
 * 非 SonarException 的底层错误（网络异常）归一化为 LLM_REQUEST_FAILED（retryable）。
 */
export async function callLlmJson(
  fetchImpl: typeof fetch,
  config: LlmJsonConfig,
  codes: LlmJsonErrorCodes,
  system: string,
  user: string,
): Promise<unknown> {
  let content: string;
  try {
    content =
      (config.protocol ?? 'openai') === 'anthropic'
        ? await callAnthropic(fetchImpl, config, codes, system, user)
        : await callOpenAi(fetchImpl, config, codes, system, user);
  } catch (e) {
    if (e instanceof SonarException) throw e;
    throw new SonarException(
      makeError(codes.request, '模型请求失败', {
        retryable: true,
        detail: e instanceof Error ? e.message : String(e),
      }),
    );
  }
  return parseLooseJson(content, codes.invalid);
}
