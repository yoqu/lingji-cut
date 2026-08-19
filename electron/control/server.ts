/**
 * 灵机控制服务（loopback HTTP + token）
 * agent/CLI 的唯一接入面：POST /invoke { op, args } → 工具注册表分发。
 * 同端口托管声呐桥端点。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { ControlRegistry } from './registry';
import { registerTools } from './tools';
import { writeEndpointFile, removeEndpointFile } from './endpoint-file';
import { createSonarInboxStore, type SonarInboxStore } from '../sonar/inbox-store';
import { getOrCreateSonarToken } from '../sonar/token';
import { handleSonarHttp, isSonarPath } from '../sonar/routes';

// ─── 模块状态 ─────────────────────────────────────────────
let httpServer: Server | null = null;
let currentPort = 19820;
let getMainWindowFn: (() => BrowserWindow | null) | null = null;
let registry: ControlRegistry | null = null;
let controlToken = '';

// ─── 声呐桥状态 ───────────────────────────────────────────
let sonarStore: SonarInboxStore | null = null;
let sonarToken = '';
/** 扩展最近一次访问桥（配对 / 探活 / 推送）的时间，供状态栏判活。 */
let sonarLastSeenAt: number | null = null;

export interface SonarBridgeInfo {
  port: number;
  token: string;
  /** 桥服务是否在监听 */
  running: boolean;
  lastSeenAt: number | null;
}

/** 暴露给主进程/IPC：待创作箱 store（启动后非空）。 */
export function getSonarInboxStore(): SonarInboxStore | null {
  return sonarStore;
}

/** 暴露给主进程/IPC：桥端点信息（端口 + token + 活跃度），供设置页与状态栏使用。 */
export function getSonarBridgeInfo(): SonarBridgeInfo {
  return { port: currentPort, token: sonarToken, running: httpServer !== null, lastSeenAt: sonarLastSeenAt };
}

// ─── 辅助 ─────────────────────────────────────────────────
function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-lingji-token, x-sonar-token');
}

function parseRequestBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** 心跳类高频操作不广播，避免界面反馈噪声 */
const SILENT_OPS = new Set(['lingji_edit_heartbeat', 'lingji_edit_lock_status', 'lingji_get_task_status']);

/** 向渲染端广播 agent 操作事件，驱动「AI 正在操作」的界面反馈 */
function emitOpEvent(event: {
  op: string;
  title: string;
  phase: 'start' | 'success' | 'error';
  error?: string;
}): void {
  if (SILENT_OPS.has(event.op)) return;
  try {
    getMainWindowFn?.()?.webContents.send('control:op-event', { ...event, ts: Date.now() });
  } catch {
    // 窗口可能已关闭
  }
}

// ─── /invoke 处理 ─────────────────────────────────────────
async function handleInvoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    respondJson(res, 405, { ok: false, error: 'Method Not Allowed', code: 'method_not_allowed' });
    return;
  }
  if (req.headers['x-lingji-token'] !== controlToken) {
    respondJson(res, 401, { ok: false, error: '鉴权失败：token 缺失或不匹配', code: 'unauthorized' });
    return;
  }
  let body: unknown;
  try {
    body = await parseRequestBody(req);
  } catch {
    respondJson(res, 400, { ok: false, error: '请求体不是合法 JSON', code: 'bad_request' });
    return;
  }
  const { op, args } = (body ?? {}) as { op?: unknown; args?: unknown };
  if (typeof op !== 'string' || !op) {
    respondJson(res, 400, { ok: false, error: '缺少 op 字段', code: 'bad_request' });
    return;
  }
  const title = registry!.titleOf(op) ?? op;
  emitOpEvent({ op, title, phase: 'start' });
  const result = await registry!.invoke(op, args);
  emitOpEvent(
    result.ok
      ? { op, title, phase: 'success' }
      : { op, title, phase: 'error', error: result.error },
  );
  respondJson(res, 200, result);
}

// ─── 公开 API ─────────────────────────────────────────────

/**
 * 启动控制服务
 * @param port 监听端口，默认 19820
 * @param getMainWindow 获取 Electron 主窗口的回调
 */
export async function startControlServer(
  port = 19820,
  getMainWindow: () => BrowserWindow | null,
): Promise<void> {
  if (httpServer) {
    console.log('[Control] 服务已在运行中，跳过重复启动');
    return;
  }

  currentPort = port;
  getMainWindowFn = getMainWindow;
  controlToken = randomBytes(24).toString('hex');

  registry = new ControlRegistry();
  registerTools(registry, getMainWindow);

  // 声呐桥：待创作箱 store + 共享 token（loopback + token 鉴权）
  sonarStore = createSonarInboxStore();
  sonarToken = await getOrCreateSonarToken();

  httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/health') {
      respondJson(res, 200, { status: 'ok', name: 'lingji-editor' });
      return;
    }

    if (pathname === '/invoke') {
      try {
        await handleInvoke(req, res);
      } catch (err) {
        console.error('[Control] 处理请求出错:', err);
        if (!res.headersSent) {
          respondJson(res, 500, { ok: false, error: 'Internal server error', code: 'internal_error' });
        }
      }
      return;
    }

    // ── 声呐桥端点（仅 loopback + token）──
    if (isSonarPath(pathname)) {
      // 扩展无心跳，任一桥请求都记为一次"活着"的信号
      sonarLastSeenAt = Date.now();
      try {
        await handleSonarHttp(req, res, {
          store: sonarStore!,
          expectedToken: sonarToken,
          version: '1.0.0',
          endpoint: `http://127.0.0.1:${currentPort}`,
          // 收件箱有新增/刷新 → 通知渲染端待创作箱实时刷新（无需手动点刷新）。
          onInboxChanged: () => {
            try {
              getMainWindowFn?.()?.webContents.send('sonar-inbox-updated');
            } catch (e) {
              console.warn('[Sonar] 通知渲染端刷新失败', e);
            }
          },
        });
      } catch (err) {
        console.error('[Sonar] 处理请求出错:', err);
        if (!res.headersSent) {
          respondJson(res, 400, { error: 'Bad Request' });
        }
      }
      return;
    }

    respondJson(res, 404, { error: 'Not Found' });
  });

  return new Promise<void>((resolve, reject) => {
    httpServer!.listen(port, '127.0.0.1', () => {
      console.log(`[Control] 控制服务已启动: http://127.0.0.1:${port}/invoke`);
      void writeEndpointFile({ port, token: controlToken, sonarToken }).catch((err) =>
        console.error('[Control] 写端点文件失败:', err),
      );
      resolve();
    });
    httpServer!.on('error', (err) => {
      console.error('[Control] 服务启动失败:', err);
      httpServer = null;
      reject(err);
    });
  });
}

/** 停止控制服务 */
export async function stopControlServer(): Promise<void> {
  if (httpServer) {
    await new Promise<void>((resolve) => {
      httpServer!.close(() => resolve());
    });
    httpServer = null;
    registry = null;
    void removeEndpointFile().catch(() => {});
  }
  console.log('[Control] 服务已停止');
}

/** 获取控制服务当前状态 */
export function getControlServerStatus(): { running: boolean; port: number; url: string } {
  return {
    running: httpServer !== null,
    port: currentPort,
    url: `http://127.0.0.1:${currentPort}`,
  };
}
