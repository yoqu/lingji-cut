// cli/src/client.ts
import { CliError } from './errors';
import type { ControlEndpoint } from './endpoint';

export interface ToolCaller {
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

interface InvokeResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

/** 连接已启动应用的控制服务，返回操作调用器 */
export async function connectClient(endpoint: ControlEndpoint): Promise<ToolCaller> {
  const { url, token } = endpoint;
  try {
    const health = await fetch(`${url}/health`);
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch {
    throw new CliError(
      `未发现运行中的灵机剪影控制服务（${url}）。请先启动灵机剪影应用。`,
      'server_unreachable',
    );
  }
  return {
    async call(name, args = {}) {
      let res: Response;
      try {
        res = await fetch(`${url}/invoke`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'x-lingji-token': token } : {}),
          },
          body: JSON.stringify({ op: name, args }),
        });
      } catch {
        throw new CliError(`控制服务连接中断（${url}）。`, 'server_unreachable');
      }
      if (res.status === 401) {
        throw new CliError(
          '控制服务鉴权失败：token 缺失或不匹配。重启应用后重试，或检查 --token / LINGJI_CONTROL_TOKEN。',
          'unauthorized',
        );
      }
      let body: InvokeResponse | null = null;
      try {
        body = (await res.json()) as InvokeResponse;
      } catch {
        // 落入下方统一错误
      }
      if (!body || typeof body.ok !== 'boolean') {
        throw new CliError(`控制服务响应异常（HTTP ${res.status}）。`, 'bad_response');
      }
      if (!body.ok) {
        throw new CliError(body.error ?? '控制服务返回错误', body.code ?? 'tool_error');
      }
      return body.data ?? null;
    },
    async close() {
      // fetch 无持久连接，无需清理
    },
  };
}
