# 桌面端账户登录 + 四类兜底 Provider 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 桌面端欢迎页集成灵机剪影账户浏览器授权登录 + 账号信息面板；登录后自动 upsert 四类兜底 Provider（对话/图片/TTS/视频），服务器基址烘焙进包（dev localhost:15173 / prod lingji.qushenma.com），用户不可见改。

**Architecture:** 主进程持有烘焙基址与 loopback+PKCE 授权流，safeStorage 落盘账号；渲染层拿 session 后 upsert 四条确定性 id 的 provider 到 aiSettings；欢迎页 Hero 右上角挂 AccountBadge。服务端 lingji-web 加最小授权端点。

**Tech Stack:** Electron 41 / React 19 / TS / Vitest；lingji-web Spring Boot 4.1 + React。

**运行时 URL 约定（已核准）：**
- LLM `openai_compatible` baseUrl `{base}/v1` → `/chat/completions`
- 图片 `openai_image` baseUrl `{base}` → `/v1/images/generations`
- TTS `minimax` baseUrl `{base}` → `/v1/t2a_v2`
- 视频 `custom`(→vidu) baseUrl `{base}` → `/ent/v2/text2video`

---

## Task 1: 兜底 Provider 构建 + upsert 纯函数（渲染层，TDD）

**Files:**
- Modify: `src/lib/llm/lingji-gateway.ts`
- Test: `tests/lingji-gateway.test.ts`

类型（新增到 lingji-gateway.ts）：
```ts
export interface LingjiSession {
  apiKey: string;                 // lj_...
  profile: { email: string; displayName?: string; avatarUrl?: string };
  balance: number;
  tier: string;
}
```

核心函数：
```ts
import type { AISettings } from '../../types/ai';

export const LINGJI_FALLBACK_IDS = {
  llm: 'lingji-fallback-llm',
  image: 'lingji-fallback-image',
  tts: 'lingji-fallback-tts',
  video: 'lingji-fallback-video',
} as const;

/** 用 session 把四类兜底 provider upsert 进 settings：同 id 覆盖 apiKey/baseUrl/models，
 *  仅当该类目当前无默认时设为默认。base 为烘焙服务器基址（无尾斜杠、无 /v1）。 */
export function applyLingjiFallbackProviders(
  settings: AISettings,
  session: LingjiSession,
  base: string,
): AISettings {
  const b = base.replace(/\/+$/, '');
  const key = session.apiKey;

  const upsert = <T extends { id: string }>(list: T[], next: T): T[] => {
    const i = list.findIndex((p) => p.id === next.id);
    if (i < 0) return [...list, next];
    const copy = list.slice();
    copy[i] = { ...copy[i], ...next };
    return copy;
  };

  const llm = { id: LINGJI_FALLBACK_IDS.llm, name: '灵机剪影网关', type: 'openai_compatible' as const,
    baseUrl: `${b}/v1`, apiKey: key, models: ['gpt-4o-mini', 'gpt-4o'], defaultModel: 'gpt-4o-mini', enableThinking: false };
  const image = { id: LINGJI_FALLBACK_IDS.image, name: '灵机剪影图片', type: 'openai_image' as const,
    baseUrl: b, apiKey: key, models: ['gpt-image-1'], extras: { managedBy: 'lingji' } };
  const tts = { id: LINGJI_FALLBACK_IDS.tts, name: '灵机剪影语音', type: 'minimax' as const,
    baseUrl: b, apiKey: key, models: ['speech-2.8-hd'] };
  const video = { id: LINGJI_FALLBACK_IDS.video, name: '灵机剪影视频', type: 'custom' as const,
    baseUrl: b, apiKey: key, models: ['lingji-video'], extras: { managedBy: 'lingji' } };

  return {
    ...settings,
    llmProviders: upsert(settings.llmProviders, llm),
    defaultProviderId: settings.defaultProviderId ?? llm.id,
    defaultModel: settings.defaultModel ?? llm.defaultModel,
    imageProviders: upsert(settings.imageProviders, image),
    defaultImageProviderId: settings.defaultImageProviderId ?? image.id,
    defaultImageModel: settings.defaultImageModel ?? image.models[0],
    ttsProviders: upsert(settings.ttsProviders, tts),
    defaultTtsProviderId: settings.defaultTtsProviderId ?? tts.id,
    videoProviders: upsert(settings.videoProviders, video),
    defaultVideoProviderId: settings.defaultVideoProviderId ?? video.id,
    defaultVideoModel: settings.defaultVideoModel ?? video.models[0],
  };
}
```

- [ ] **Step 1: 写失败测试** `tests/lingji-gateway.test.ts` 追加：
```ts
import { applyLingjiFallbackProviders, LINGJI_FALLBACK_IDS, type LingjiSession } from '../src/lib/llm/lingji-gateway';
import { buildDefaultAISettings } from '../src/store/ai'; // 若不导出则手拼最小 settings

const SESSION: LingjiSession = { apiKey: 'lj_abc', profile: { email: 'a@b.com' }, balance: 100, tier: 'FREE' };

test('applyLingjiFallbackProviders 四类都 upsert 且空默认时设默认', () => {
  const base = { /* 最小 AISettings：各 providers:[], 各 defaultXxxId:null */ } as any;
  const out = applyLingjiFallbackProviders(base, SESSION, 'http://localhost:15173');
  expect(out.llmProviders.find(p => p.id === LINGJI_FALLBACK_IDS.llm)?.baseUrl).toBe('http://localhost:15173/v1');
  expect(out.imageProviders.find(p => p.id === LINGJI_FALLBACK_IDS.image)?.baseUrl).toBe('http://localhost:15173');
  expect(out.defaultProviderId).toBe(LINGJI_FALLBACK_IDS.llm);
  expect(out.defaultTtsProviderId).toBe(LINGJI_FALLBACK_IDS.tts);
});

test('已有默认时不覆盖用户选择，但仍 upsert', () => {
  const base = { llmProviders: [], imageProviders: [], ttsProviders: [], videoProviders: [],
    defaultProviderId: 'user-x', defaultModel: 'm', defaultImageProviderId: 'ux', defaultImageModel: 'im',
    defaultTtsProviderId: 'ut', defaultTtsVoiceId: null, ttsVoices: [], defaultVideoProviderId: 'uv', defaultVideoModel: 'vm' } as any;
  const out = applyLingjiFallbackProviders(base, SESSION, 'http://localhost:15173');
  expect(out.defaultProviderId).toBe('user-x');
  expect(out.llmProviders.some(p => p.id === LINGJI_FALLBACK_IDS.llm)).toBe(true);
});

test('重复调用不产生重复 provider（id 幂等）', () => {
  const base = { llmProviders: [], imageProviders: [], ttsProviders: [], videoProviders: [],
    defaultProviderId: null, defaultModel: null, defaultImageProviderId: null, defaultImageModel: null,
    defaultTtsProviderId: null, defaultTtsVoiceId: null, ttsVoices: [], defaultVideoProviderId: null, defaultVideoModel: null } as any;
  const once = applyLingjiFallbackProviders(base, SESSION, 'http://localhost:15173');
  const twice = applyLingjiFallbackProviders(once, { ...SESSION, apiKey: 'lj_new' }, 'http://localhost:15173');
  expect(twice.llmProviders.filter(p => p.id === LINGJI_FALLBACK_IDS.llm)).toHaveLength(1);
  expect(twice.llmProviders.find(p => p.id === LINGJI_FALLBACK_IDS.llm)?.apiKey).toBe('lj_new');
});
```
- [ ] **Step 2: 跑测试确认失败** `npx vitest run tests/lingji-gateway.test.ts` → FAIL（函数未定义）
- [ ] **Step 3: 实现** 在 `src/lib/llm/lingji-gateway.ts` 加上 `LingjiSession`、`LINGJI_FALLBACK_IDS`、`applyLingjiFallbackProviders`（见上）。保留旧 `connectLingjiGateway` 不动。
- [ ] **Step 4: 跑测试通过** `npx vitest run tests/lingji-gateway.test.ts` → PASS
- [ ] **Step 5: 提交** `git add -A && git commit -m "feat(llm): session→四类兜底 provider upsert 纯函数"`

## Task 2: 主进程授权流 + safeStorage 落盘（electron/lingji-account.ts）

**Files:**
- Create: `electron/lingji-account.ts`
- Test: `tests/lingji-account.test.ts`（纯逻辑：授权 URL 组装、state 校验、code 换 key 的 body）

要点：
```ts
import { app, shell, safeStorage } from 'electron';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function lingjiBaseUrl(): string {
  return app.isPackaged ? 'https://lingji.qushenma.com' : 'http://localhost:15173';
}

const ACCOUNT_FILE = path.join(os.homedir(), '.lingji', 'account.json');

// PKCE
export function makePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
export function buildAuthorizeUrl(base: string, redirectUri: string, state: string, challenge: string): string {
  const u = new URL('/oauth/authorize', base);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client', 'desktop');
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}
```
- loopback：`http.createServer` 监听 `127.0.0.1:0`，收到 `/callback?code&state` → 校验 state → 200 返回“授权成功，可关闭本页面”HTML → resolve code。3 分钟超时 reject。
- `lingjiLogin()`：makePkce → startLoopback(port) → openExternal(buildAuthorizeUrl) → 等 code → `POST {base}/api/oauth/desktop/token {code, code_verifier, client:'desktop'}` → 得 session → saveAccount(session) → 返回 session。
- `saveAccount/loadAccount/clearAccount`：safeStorage 加密写 ACCOUNT_FILE（参考 `electron/acp/config.ts:150-163`），确保目录存在。
- `refreshBootstrap()`：`GET {base}/api/client/bootstrap` 带 `Authorization: Bearer <apiKey>`（若网关密钥可用作 bearer）；失败静默返回缓存。

- [ ] **Step 1: 写失败测试** `tests/lingji-account.test.ts`：
```ts
import { buildAuthorizeUrl, makePkce } from '../electron/lingji-account';
test('buildAuthorizeUrl 带全部 PKCE 参数', () => {
  const url = buildAuthorizeUrl('http://localhost:15173', 'http://127.0.0.1:5321/callback', 'st', 'ch');
  expect(url).toContain('/oauth/authorize');
  expect(url).toContain('code_challenge=ch');
  expect(url).toContain('code_challenge_method=S256');
  expect(url).toContain(encodeURIComponent('http://127.0.0.1:5321/callback'));
});
test('makePkce 生成 verifier/challenge', () => {
  const { verifier, challenge } = makePkce();
  expect(verifier.length).toBeGreaterThan(20);
  expect(challenge.length).toBeGreaterThan(20);
});
```
> 注：electron 模块在 Vitest 下不可用，测试文件顶部 `vi.mock('electron', () => ({ app:{isPackaged:false}, shell:{}, safeStorage:{} }))`。
- [ ] **Step 2: 跑测试确认失败** `npx vitest run tests/lingji-account.test.ts` → FAIL
- [ ] **Step 3: 实现** 写 `electron/lingji-account.ts` 全部逻辑（上述）。
- [ ] **Step 4: 跑测试通过** → PASS
- [ ] **Step 5: 提交** `git commit -m "feat(account): 主进程 loopback+PKCE 授权流与 safeStorage 落盘"`

## Task 3: IPC 三件套（main / preload / electron-api）

**Files:**
- Modify: `electron/main.ts`（注册 handler）
- Modify: `electron/preload.ts`（暴露桥）
- Modify: `src/lib/electron-api.ts`（类型 + 方法）

- [ ] **Step 1: main.ts 注册**（import lingji-account）：
```ts
import { lingjiLogin, lingjiLogout, loadAccount } from './lingji-account';
ipcMain.handle('lingji-login', async () => lingjiLogin());
ipcMain.handle('lingji-logout', async () => lingjiLogout());
ipcMain.handle('lingji-get-account', async () => loadAccount());
```
- [ ] **Step 2: preload.ts 暴露**（在 `electronAPI` 对象内追加）：
```ts
lingjiLogin: () => ipcRenderer.invoke('lingji-login'),
lingjiLogout: () => ipcRenderer.invoke('lingji-logout'),
lingjiGetAccount: () => ipcRenderer.invoke('lingji-get-account'),
```
- [ ] **Step 3: electron-api.ts 类型**：加 `LingjiAccount`（= 落盘结构：email/displayName?/avatarUrl?/tier/balance?/apiKey/connectedAt）与 `LingjiSession`（复用 lib/llm 的），并在 electronAPI 接口加三方法签名。
- [ ] **Step 4: 构建校验** `npm run build`（或 `npx tsc -p tsconfig.json --noEmit` 若可用）确认三件套类型对齐无错。
- [ ] **Step 5: 提交** `git commit -m "feat(ipc): lingji-login/logout/get-account 三件套"`

## Task 4: 欢迎页账号面板 AccountBadge + 挂载 Setup

**Files:**
- Create: `src/components/account/AccountBadge.tsx`
- Modify: `src/pages/Setup.tsx`（Hero Banner 内 `donateBadge` 旁引入 `<AccountBadge/>`）
- Modify: `src/pages/Setup.module.css`（如需 accountBadge 定位样式，复用 donateBadge 风格）

AccountBadge 行为：
- 初次 `useEffect` 调 `electronAPI.lingjiGetAccount()` 取缓存账号。
- 无账号：渲染「登录灵机剪影」按钮 → `lingjiLogin()`；loading 态禁用；成功后 `loadAISettings()`→`applyLingjiFallbackProviders(settings, session, base)`→`saveAISettings()`，并刷新本地账号态。base 从哪来？→ 由 session 隐含（provider baseUrl 已在主进程用烘焙基址拼好返回，渲染层不需知道 base）。**修正**：让主进程在 `lingji-login` 返回 session 时**同时返回构建好的 base**（即 `{ session, base }`），或直接让主进程返回已 upsert 所需的 base 字符串。渲染层用该 base 调 `applyLingjiFallbackProviders`。
- 有账号：渲染头像/邮箱 + 积分余额 + tier + 「退出」按钮 → `lingjiLogout()` 后清本地态（provider 保留）。

- [ ] **Step 1: 写 AccountBadge.tsx**（用 `src/ui` 的 Button/头像；样式对齐 donateBadge）。
- [ ] **Step 2: Setup.tsx 挂载** 在 `Setup.tsx:216`（donateBadge 之后）加 `<AccountBadge className={styles.accountBadge} />`；Setup 需能访问 electronAPI（已全局）。
- [ ] **Step 3: 构建校验** `npm run build` 通过。
- [ ] **Step 4: 手动验收（dev）** `npm run dev` → 欢迎页右上出现登录入口。
- [ ] **Step 5: 提交** `git commit -m "feat(welcome): 欢迎页账号面板 AccountBadge + 登录后 upsert 兜底 provider"`

## Task 5: 精简 LingjiGatewayConnect（去掉可编辑网关地址）

**Files:**
- Modify: `src/components/settings/LingjiGatewayConnect.tsx`

- [ ] **Step 1:** 去掉「网关地址」`Field/Input`（`:68-70`）与 `baseUrl` state；改为设置页也走烘焙基址的账户登录入口（复用 `electronAPI.lingjiLogin` 而非旧 email/password），或直接在设置页复用 AccountBadge 的登录动作。保持 `onConnected` 兼容 ProviderListSection。
- [ ] **Step 2: 构建校验** `npm run build` 通过；`npx vitest run tests/lingji-gateway.test.ts` 仍 PASS。
- [ ] **Step 3: 提交** `git commit -m "refactor(settings): LingjiGatewayConnect 走烘焙基址，去掉网关地址输入"`

## Task 6: 服务端最小授权端点（../lingji-web）

**Files（lingji-web）:**
- Backend: `backend/.../account/web/OAuthDesktopController.java`（新）+ service 复用 AuthService/ApiKeyService
- Frontend: `frontend/src/pages/OAuthAuthorize.tsx`（新）+ 路由 + vite dev proxy(15173)

- [ ] **Step 1: 后端** `POST /api/oauth/desktop/authorize`（已登录 JWT）：入参 `{redirect_uri, state, code_challenge}`；生成一次性 `code`（内存/Redis，TTL 2min，绑定 userId+challenge+redirect_uri），返回 `{code}`。
- [ ] **Step 2: 后端** `POST /api/oauth/desktop/token`：入参 `{code, code_verifier, client}`；校验 challenge=SHA256(code_verifier)、未过期→复用 `ApiKeyService` 生成 `lj_` key + 读 bootstrap→返回 `{apiKey, profile:{email,displayName?,avatarUrl?}, balance, tier}`。一次性 code 用后作废。
- [ ] **Step 3: 前端授权页** `/oauth/authorize`：读 query→若未登录跳登录再回；展示「授权灵机剪影桌面端」确认→点授权 POST `/api/oauth/desktop/authorize`→拿 code→`window.location = redirect_uri?code&state`。
- [ ] **Step 4: vite dev** 确认 `/api`、`/v1` 代理到后端且 dev server 端口 15173（`frontend/vite.config.ts`）。
- [ ] **Step 5: 后端单测** 复用 lingji-web 测试栈覆盖 code 签发/换取/过期/challenge 不匹配。
- [ ] **Step 6: 提交（lingji-web 仓库）** `git commit -m "feat(oauth): 桌面端浏览器授权 code 换 lj_ key 端点 + 授权页"`

## Task 7: 端到端联调（dev）

- [ ] lingji-web：起后端 + `frontend` dev(15173)。
- [ ] 桌面端 `npm run dev`：欢迎页点登录→浏览器授权→回调→四 provider 落位（查设置页）→对话 provider 实调 `{15173}/v1/chat/completions` 成功。
- [ ] 记录验证结果到最终说明（如实写明跑了什么、没跑什么）。

---

## Self-Review

- **Spec 覆盖**：§4.1 基址→T2/T4；§4.2 授权流→T2；§4.3 兜底 provider→T1;§4.4 账号面板→T4；§4.5 持久化→T2；§5.1 桌面文件→T1-5；§5.2 服务端→T6；§7 错误处理→T2(超时/state)/T4(登录失败态)；§8 测试→T1/T2/T6/T7。全覆盖。
- **base 传递歧义**已在 T4 Step-1 修正：`lingji-login` 返回 `{ session, base }`，渲染层用 base 调 `applyLingjiFallbackProviders`。相应 T2 的 `lingjiLogin()` 返回类型改为 `{ session, base }`，T3 电子桥/类型随之。
- **类型一致**：`LingjiSession` 单一来源在 `src/lib/llm/lingji-gateway.ts`，electron-api 复用导入；`LINGJI_FALLBACK_IDS` 常量在 T1 定义，供 T4 引用。
- **无占位**：各 Step 均含实际代码/命令。
</content>
