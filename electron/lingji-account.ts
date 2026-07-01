import { app, safeStorage, shell } from 'electron';
import http from 'node:http';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 桌面端灵机剪影账户：浏览器授权 + 本地回调（loopback）+ PKCE 登录，safeStorage 落盘。
 * 服务器基址烘焙进包，用户不可见改：开发 localhost:15173 / 生产 lingji.qushenma.com。
 */

/** 落盘账户结构（含长效网关密钥 lj_）。 */
export interface LingjiAccount {
  email: string;
  displayName?: string;
  avatarUrl?: string;
  tier: string;
  balance: number;
  apiKey: string;
  connectedAt: string;
}

/** 授权换取后的会话（返回渲染层，用于 upsert 兜底 provider）。 */
export interface LingjiSession {
  apiKey: string;
  profile: { email: string; displayName?: string; avatarUrl?: string };
  balance: number;
  tier: string;
}

const ACCOUNT_FILE = path.join(os.homedir(), '.lingji', 'account.json');
const AUTH_TIMEOUT_MS = 3 * 60 * 1000;

/** 烘焙的服务器基址（无尾斜杠）。 */
export function lingjiBaseUrl(): string {
  return app.isPackaged ? 'https://lingji.qushenma.com' : 'http://localhost:15173';
}

export function makePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** 组装授权页 URL（带 PKCE 与 loopback redirect）。 */
export function buildAuthorizeUrl(
  base: string,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const u = new URL('/oauth/authorize', base);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client', 'desktop');
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

interface CallbackResult {
  code: string;
}

const CALLBACK_HTML = (ok: boolean) =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>灵机剪影</title>` +
  `<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;height:100vh;margin:0;` +
  `align-items:center;justify-content:center;background:#f5f5f7;color:#1d1d1f}` +
  `.card{text-align:center}.t{font-size:20px;font-weight:600;margin-bottom:8px}` +
  `.s{font-size:14px;color:#6e6e73}</style></head><body><div class="card">` +
  `<div class="t">${ok ? '授权成功' : '授权失败'}</div>` +
  `<div class="s">${ok ? '可关闭本页面返回灵机剪影' : '请返回应用重试'}</div>` +
  `</div></body></html>`;

interface Envelope<T> {
  code: number;
  message: string;
  data: T;
}

async function exchangeCode(
  base: string,
  code: string,
  verifier: string,
): Promise<LingjiSession> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/oauth/desktop/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, client: 'desktop' }),
    });
  } catch {
    throw new Error('无法连接服务器，请检查网络');
  }
  let env: Envelope<LingjiSession>;
  try {
    env = (await res.json()) as Envelope<LingjiSession>;
  } catch {
    throw new Error(`服务器返回异常（HTTP ${res.status}）`);
  }
  if (env.code !== 0) throw new Error(env.message || `授权失败（${env.code}）`);
  return env.data;
}

async function persistAccount(session: LingjiSession): Promise<void> {
  const account: LingjiAccount = {
    email: session.profile.email,
    displayName: session.profile.displayName,
    avatarUrl: session.profile.avatarUrl,
    tier: session.tier,
    balance: session.balance,
    apiKey: session.apiKey,
    connectedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(ACCOUNT_FILE), { recursive: true });
  const json = JSON.stringify(account);
  if (safeStorage.isEncryptionAvailable()) {
    await fs.writeFile(ACCOUNT_FILE, safeStorage.encryptString(json));
  } else {
    await fs.writeFile(ACCOUNT_FILE, json, 'utf-8');
  }
}

/** 读缓存账户；无/损坏返回 null。 */
export async function loadAccount(): Promise<LingjiAccount | null> {
  try {
    const buf = await fs.readFile(ACCOUNT_FILE);
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString('utf-8');
    return JSON.parse(json) as LingjiAccount;
  } catch {
    return null;
  }
}

export async function lingjiLogout(): Promise<void> {
  try {
    await fs.rm(ACCOUNT_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

/** 完整授权登录：loopback + 浏览器授权 + code 换 key + 落盘。返回 session 与烘焙基址。 */
export async function lingjiLogin(): Promise<{ session: LingjiSession; base: string }> {
  const base = lingjiBaseUrl();
  const state = crypto.randomBytes(16).toString('hex');
  const { verifier, challenge } = makePkce();

  const loopback = await awaitLoopbackCodePrepared(state);
  try {
    await shell.openExternal(buildAuthorizeUrl(base, loopback.redirectUri, state, challenge));
    const { code } = await loopback.done;
    const session = await exchangeCode(base, code, verifier);
    await persistAccount(session);
    return { session, base };
  } finally {
    loopback.close();
  }
}

/**
 * 先起 loopback 拿到 redirectUri（用于组装授权 URL），再返回等待 code 的 promise。
 * 避免在 server.listen 回调前就打开浏览器导致 redirectUri 为空。
 */
function awaitLoopbackCodePrepared(state: string): Promise<{
  redirectUri: string;
  done: Promise<CallbackResult>;
  close: () => void;
}> {
  return new Promise((resolvePrep, rejectPrep) => {
    let resolveDone!: (r: CallbackResult) => void;
    let rejectDone!: (e: Error) => void;
    const done = new Promise<CallbackResult>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });

    let settled = false;
    const server = http.createServer((req, res) => {
      if (!req.url || !req.url.startsWith('/callback')) {
        res.writeHead(404).end();
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      const code = url.searchParams.get('code');
      const ok = Boolean(code) && url.searchParams.get('state') === state;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(CALLBACK_HTML(ok));
      if (settled) return;
      settled = true;
      if (ok && code) resolveDone({ code });
      else rejectDone(new Error('授权校验失败（state 不匹配或缺少 code）'));
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectDone(new Error('授权超时，请重试'));
    }, AUTH_TIMEOUT_MS);

    const close = () => {
      clearTimeout(timer);
      server.close();
    };

    server.on('error', (e) => {
      if (!settled) {
        settled = true;
        rejectDone(e as Error);
      }
      rejectPrep(e);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      resolvePrep({ redirectUri: `http://127.0.0.1:${port}/callback`, done, close });
    });
  });
}
