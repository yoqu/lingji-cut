/**
 * 灵机素材（KaCut）本机 MCP client。
 *
 * 契约（对端按此实现，字段名严格一致）：
 *   POST /mcp?token=...  JSON-RPC 2.0
 *     → {"jsonrpc":"2.0","id":N,"result":{"content":[{"type":"text","text":"<结果JSON字符串>"}],"isError":false}}
 *   GET  /mcp/health?token=... → {"ok":true}
 *   search_clips 的结果 JSON：对端（KaCut MCPServer）实际返回裸数组 [clip, ...]，
 *   本 client 同时兼容包装层 {"clips":[...]}；get_library_digest 返回摘要对象本身。
 *
 * 地址兼容根 URL、完整 MCP URL 与标准 mcpServers JSON。健康检查 5 秒超时，
 * 素材工具调用允许 15 秒冷启动时间，但不在客户端立即重试；
 * 错误统一抛带 `kacut` 前缀的 Error，且不得包含访问 token。
 */

import type {
  KacutClip,
  KacutLibraryDigest,
  KacutSearchClipsArgs,
} from '../../src/types/footage';
import {
  buildKacutHealthEndpoint,
  normalizeKacutMcpEndpoint,
  redactKacutSecrets,
} from '../../src/lib/kacut-endpoint';

const KACUT_HEALTH_TIMEOUT_MS = 5_000;
const KACUT_TOOL_TIMEOUT_MS = 15_000;

/** JSON-RPC id 递增计数器（模块级单例，多并发调用也不重号）。 */
let nextRpcId = 0;

export class KacutError extends Error {
  constructor(message: string) {
    const safeMessage = redactKacutSecrets(message);
    super(safeMessage.startsWith('kacut') ? safeMessage : `kacut ${safeMessage}`);
    this.name = 'KacutError';
  }
}

function resolveMcpEndpoint(value: string): string {
  const endpoint = normalizeKacutMcpEndpoint(value);
  if (!endpoint) throw new KacutError('MCP 地址格式无效');
  return endpoint;
}

/** 把 AbortSignal 超时 / 网络错误统一归一成 KacutError。 */
function toKacutError(err: unknown, timeoutMs: number): KacutError {
  if (err instanceof KacutError) return err;
  if (err instanceof Error && err.name === 'AbortError') {
    return new KacutError(`请求超时（>${timeoutMs}ms）`);
  }
  return new KacutError(`请求失败：${err instanceof Error ? err.message : String(err)}`);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw toKacutError(err, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

interface JsonRpcEnvelope {
  jsonrpc: string;
  id: number;
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  error?: { code?: number; message?: string };
}

export function isRetryableKacutError(error: unknown): boolean {
  return error instanceof KacutError && (
    error.message.includes('请求超时')
    || error.message.includes('请求失败')
    || /HTTP 50[234]/.test(error.message)
  );
}

async function callMcpToolOnce(
  baseUrl: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const id = ++nextRpcId;
  const url = resolveMcpEndpoint(baseUrl);
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: toolName, arguments: args },
        }),
      },
      KACUT_TOOL_TIMEOUT_MS,
    );
  } catch (err) {
    throw toKacutError(err, KACUT_TOOL_TIMEOUT_MS);
  }
  if (!response.ok) {
    throw new KacutError(`HTTP ${response.status}（${toolName}）`);
  }
  let envelope: JsonRpcEnvelope;
  try {
    envelope = (await response.json()) as JsonRpcEnvelope;
  } catch {
    throw new KacutError(`响应不是合法 JSON（${toolName}）`);
  }
  if (envelope.error) {
    throw new KacutError(
      `RPC 错误 ${envelope.error.code ?? '?'}：${envelope.error.message ?? '未知'}（${toolName}）`,
    );
  }
  const result = envelope.result;
  if (!result) throw new KacutError(`响应缺少 result（${toolName}）`);
  const text = result.content?.find((item) => item?.type === 'text')?.text;
  if (result.isError) {
    throw new KacutError(`工具调用失败（${toolName}）：${text ?? '未知错误'}`);
  }
  if (typeof text !== 'string' || !text.trim()) {
    throw new KacutError(`工具返回空内容（${toolName}）`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new KacutError(`工具返回内容不是合法 JSON（${toolName}）`);
  }
}

async function callMcpTool(
  baseUrl: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return callMcpToolOnce(baseUrl, toolName, args);
}

/** GET /mcp/health（保留 endpoint 的 token query）；服务可用返回 true，否则抛 KacutError。 */
export async function checkKacutHealth(baseUrl: string): Promise<boolean> {
  const url = buildKacutHealthEndpoint(baseUrl);
  if (!url) throw new KacutError('MCP 地址格式无效');
  const response = await fetchWithTimeout(url, { method: 'GET' }, KACUT_HEALTH_TIMEOUT_MS);
  if (!response.ok) throw new KacutError(`健康检查 HTTP ${response.status}`);
  let payload: { ok?: unknown };
  try {
    payload = (await response.json()) as { ok?: unknown };
  } catch {
    throw new KacutError('健康检查响应不是合法 JSON');
  }
  if (payload.ok !== true) throw new KacutError('健康检查未通过（ok !== true）');
  return true;
}

/** search_clips：返回 clips 数组（裸数组与 {"clips":[...]} 两种形状都接受；缺失 / 非数组按空结果处理，不算错误）。 */
export async function searchKacutClips(
  baseUrl: string,
  args: KacutSearchClipsArgs,
): Promise<KacutClip[]> {
  const query = args.query.trim();
  if (!query) throw new KacutError('search_clips 的 query 为空');
  const payload = (await callMcpTool(baseUrl, 'search_clips', {
    query,
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    ...(args.kind ? { kind: args.kind } : {}),
    ...(typeof args.minDurationSec === 'number' ? { minDurationSec: args.minDurationSec } : {}),
    ...(typeof args.maxDurationSec === 'number' ? { maxDurationSec: args.maxDurationSec } : {}),
  })) as { clips?: unknown } | unknown[];
  // KaCut server 实际返回裸数组（其测试锁定该形状）；兼容包装层 {"clips": [...]}（旧契约与本地 mock）
  const raw = Array.isArray(payload) ? payload : payload?.clips;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (clip): clip is KacutClip =>
      Boolean(clip) && typeof clip === 'object'
      && typeof (clip as KacutClip).id === 'string'
      && typeof (clip as KacutClip).path === 'string'
      && typeof (clip as KacutClip).score === 'number',
  );
}

/** get_library_digest：素材库摘要（注入 planning prompt）。 */
export async function getKacutLibraryDigest(baseUrl: string): Promise<KacutLibraryDigest> {
  const digest = (await callMcpTool(baseUrl, 'get_library_digest', {})) as KacutLibraryDigest;
  if (!digest || typeof digest !== 'object' || typeof digest.itemCount !== 'number') {
    throw new KacutError('素材库摘要格式非法（缺少 itemCount）');
  }
  return digest;
}

/**
 * 供 planning 注入的 digest provider 工厂：settings.kacut 未启用返回 null，
 * 抓取失败直接抛出，让上层统一记录 kacut.digest 的具体错误并退化为不出现 footage 选项。
 * main 侧四个 createDirectorPlan / analyzeSrt 装配点共用。
 */
export function makeKacutDigestProvider(settings: {
  kacut?: { enabled: boolean; baseUrl: string };
}): () => Promise<KacutLibraryDigest | null> {
  return async () => {
    const kacut = settings.kacut;
    if (!kacut?.enabled) return null;
    return getKacutLibraryDigest(kacut.baseUrl);
  };
}
