/**
 * 控制服务工具注册表：POST /invoke 的唯一分发真源。
 * registerTool 与原 MCP SDK 同签名，业务 handler 无需感知传输层。
 */
import { z, type ZodRawShape } from 'zod';

export interface ToolResultEnvelope {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ToolMeta {
  title: string;
  description: string;
  inputSchema?: ZodRawShape;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResultEnvelope>;

/** 各注册文件依赖的最小接口（旧签名不变，替代 McpServer 类型） */
export interface ToolRegistrar {
  registerTool(
    name: string,
    meta: ToolMeta,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any) => Promise<ToolResultEnvelope>,
  ): void;
}

export interface InvokeResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

interface ToolEntry {
  meta: ToolMeta;
  schema: z.ZodObject<ZodRawShape> | null;
  handler: ToolHandler;
}

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

/** 把 handler 的 { content:[{text}], isError } 信封翻译为 /invoke 响应 */
function envelopeToResponse(envelope: ToolResultEnvelope): InvokeResponse {
  const text = envelope.content?.[0]?.text;
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (envelope.isError) {
    const obj = (data ?? {}) as { error?: string; message?: string; code?: string };
    return {
      ok: false,
      error: String(obj.error ?? obj.message ?? text ?? '工具返回错误'),
      code: obj.code ?? 'tool_error',
    };
  }
  return { ok: true, data };
}

export class ControlRegistry implements ToolRegistrar {
  private tools = new Map<string, ToolEntry>();

  registerTool(name: string, meta: ToolMeta, handler: ToolHandler): void {
    if (this.tools.has(name)) {
      throw new Error(`工具重复注册: ${name}`);
    }
    this.tools.set(name, {
      meta,
      schema: meta.inputSchema ? z.object(meta.inputSchema) : null,
      handler,
    });
  }

  listOps(): string[] {
    return [...this.tools.keys()].sort();
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 工具的人读标题（用于界面反馈），未注册返回 null */
  titleOf(name: string): string | null {
    return this.tools.get(name)?.meta.title ?? null;
  }

  async invoke(op: string, args: unknown): Promise<InvokeResponse> {
    const entry = this.tools.get(op);
    if (!entry) {
      return { ok: false, error: `未知操作: ${op}`, code: 'unknown_op' };
    }
    let parsed: Record<string, unknown> = {};
    if (entry.schema) {
      const result = entry.schema.safeParse(args ?? {});
      if (!result.success) {
        const detail = result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        return { ok: false, error: `参数无效: ${detail}`, code: 'invalid_args' };
      }
      parsed = result.data;
    }
    try {
      return envelopeToResponse(await entry.handler(parsed));
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: errorCode(err) ?? 'internal_error',
      };
    }
  }
}
