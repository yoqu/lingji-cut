# 桌面端灵机剪影账户登录 + 兜底 Provider 设计

日期：2026-07-01
状态：待评审
涉及仓库：`video-web-master`（桌面端，主）、`../lingji-web`（服务端，最小授权端点）

## 1. 目标

在灵机剪影桌面端（Electron）欢迎页集成账户登录与账号信息面板；登录成功后自动配置一套"兜底" AI Provider，覆盖**对话 / 图片 / 视频 / TTS** 四类合成，做到开箱即用。登录采用**浏览器授权 + 本地回调**模式，服务器基址烘焙进打包产物，用户不可见、不可改。

## 2. 现状（已确认）

- 欢迎页复用 `src/pages/Setup.tsx`，无顶部导航/侧栏；Hero Banner 右上角已有 `donateBadge`/`projectBadge` 绝对定位角标，是自然挂载点。
- 现有 `LingjiGatewayConnect.tsx` + `connectLingjiGateway()` 只做**邮箱密码登录**并只生成**一个 LLM provider**，且暴露可编辑的「网关地址」输入框；仅挂在设置页。
- Provider 数据结构（`src/types/ai.ts`）：
  - LLM：`llmProviders[]` / `defaultProviderId` / `defaultModel`；`openai_compatible` 运行时请求 `{baseUrl}/chat/completions`。
  - 图片：`imageProviders[]` / `defaultImageProviderId` / `defaultImageModel`；`openai_image` 运行时请求 `{baseUrl}/v1/images/generations`。
  - 视频：`videoProviders[]` / `defaultVideoProviderId` / `defaultVideoModel`；仅 `vidu` 有运行时，`custom` 回退到 vidu。
  - TTS：`ttsProviders[]` / `defaultTtsProviderId` / `defaultTtsVoiceId` / `ttsVoices[]`；仅 `minimax`、`xiaomi_mimo` 有运行时（`custom_openai_audio` 只有类型无实现）。
  - 字段统一 `baseUrl + apiKey + models`（图片/视频另有 `extras?`）。
- 持久化：无细粒度 store action，统一 `loadAISettings()` / `saveAISettings(settings)`；设默认 = 改 `defaultXxxProviderId` 后整体保存。
- 服务端（`../lingji-web`）：已有 account（注册/登录/JWT/`/api/me`）、gateway（**仅 chat**：`/v1/chat/completions`、`/v1/models`、`/api/gateway/chat`）、billing（积分/tier）、`GET /api/client/bootstrap`（user+balance+tier）、`POST /api/client/api-keys`（生成 `lj_` 长效密钥）。**无 OAuth 授权页/桌面授权端点**。C 端前端 dev 运行在 `localhost:15173`。

## 3. 关键决策（已与用户确认）

1. 登录机制：**浏览器授权 + 本地回调（loopback）**。
2. 四类合成：**桌面端先配好指向网关约定路径**；image/tts/video 网关端点服务端后续补齐。
3. 账号面板：**登录入口 + 基本信息**（头像/邮箱、积分余额、会员 tier、退出）。
4. 交付范围：**桌面端 + 服务端最小授权端点**（`/oauth/authorize` 页 + code 换 key 接口）。

## 4. 架构

### 4.1 服务器基址（烘焙、隐藏、不可改）

Electron 主进程按 `app.isPackaged` 选定唯一基址，不进任何用户可见设置：

```
const LINGJI_BASE = app.isPackaged ? 'https://lingji.qushenma.com' : 'http://localhost:15173'
```

所有交互同源：授权页 `{base}/oauth/authorize`、账号接口 `{base}/api/*`、AI 网关 `{base}/v1/*`。**移除** `LingjiGatewayConnect` 的「网关地址」输入框。开发环境 lingji-web 前端 vite 需将 `/api`、`/v1` 代理到后端并跑在 15173。

### 4.2 授权登录流程（主进程）

```
主进程 lingjiLogin():
  1. 起临时 http.Server 于 127.0.0.1:0（随机端口 P）
  2. 生成 state（CSRF）与 PKCE（code_verifier/code_challenge）
  3. shell.openExternal →
     {base}/oauth/authorize?response_type=code&client=desktop
       &redirect_uri=http://127.0.0.1:P/callback&state=STATE&code_challenge=CC&code_challenge_method=S256
  4. 用户在网页登录（若未登录）并点「授权桌面端」
     → 网页 POST 后端签发一次性 code → 302 到 http://127.0.0.1:P/callback?code=CODE&state=STATE
  5. loopback 收到回调：校验 state，回一句"授权成功，可关闭本页面返回应用"，关闭 server
  6. 主进程 POST {base}/api/oauth/desktop/token { code, code_verifier, client:'desktop' }
     → { apiKey: 'lj_...', profile:{email,displayName?,avatarUrl?}, balance, tier }
  7. safeStorage 加密落盘 ~/.lingji/account.json（含 lj_ key）
  8. 返回 session 给渲染层
```

用短时 `code` + PKCE 换 `lj_` key，避免长效密钥出现在浏览器 URL / 历史。超时（如 3 分钟）与用户关闭浏览器均须清理 loopback server 并回可读错误。

### 4.3 登录后自动配置兜底 Provider（渲染层）

渲染层拿到 session 后，对 `aiSettings` 用**确定性 id** upsert 四条 provider（重登更新、不重复），apiKey 统一 `lj_` key，baseUrl 指向烘焙基址；**仅当该类目当前无默认时**设为默认（不覆盖用户已选）：

| 类目 | id | type | baseUrl | models | 网关约定端点 |
|---|---|---|---|---|---|
| 对话 | `lingji-fallback-llm` | `openai_compatible` | `{base}/v1` | `['gpt-4o-mini','gpt-4o']` | `/v1/chat/completions`（**今日可用**） |
| 图片 | `lingji-fallback-image` | `openai_image` | `{base}` | `['gpt-image-1']` | `/v1/images/generations` |
| 视频 | `lingji-fallback-video` | `custom`(→vidu) | 按 vidu 运行时 | `['lingji-video']` | 网关 vidu 兼容 |
| TTS | `lingji-fallback-tts` | `minimax` | 按 minimax 运行时 | 按 minimax 默认 | 网关 MiniMax 兼容 T2A |

- 图片/视频用固定 id + `extras.managedBy='lingji'` 标记为托管；LLM/TTS 无 `extras`，用固定 id 识别托管。
- 视频/TTS 兜底选用**当前有桌面运行时**的 type（vidu、minimax），确保服务端补齐对应网关端点后即通；具体 baseUrl 后缀在实现时对照各运行时 URL 拼接核准。
- upsert 前若同 id 已存在则替换其 apiKey/baseUrl/models，保留用户对 name 的改动。

### 4.4 欢迎页账号面板

新组件 `AccountBadge`（或复用改造后的 `LingjiGatewayConnect`）挂 `Setup.tsx` Hero Banner 右上角（`donateBadge` 旁）：
- 未登录：「登录灵机剪影」按钮 → `electronAPI.lingjiLogin()`；登录中显示 loading。
- 已登录：头像/邮箱 + 积分余额 + 会员 tier + 「退出登录」；数据来自主进程 `lingji-get-account`，可点击刷新（拉 `{base}/api/client/bootstrap`）。
- 退出：清 `~/.lingji/account.json`；托管 provider 是否移除——保留（避免误删用户默认），仅清账号态。

### 4.5 会话/密钥持久化

- 主进程 `~/.lingji/account.json`，safeStorage 加密（对齐现有 agent-config 密钥处理），字段：`{ email, displayName?, avatarUrl?, tier, apiKey, connectedAt }`；降级时才明文。
- `lj_` key 同时写入四条 provider 的 `apiKey`（沿用现状：provider key 存于 aiSettings 明文，与现有网关 provider 一致）。

## 5. 组件与接口边界

### 5.1 桌面端文件

| 文件 | 变更 | 职责 |
|---|---|---|
| `electron/lingji-account.ts` | 新增 | 烘焙基址、loopback+授权流、code 换 key、safeStorage 持久化、bootstrap 刷新 |
| `electron/main.ts` | 加 IPC | `lingji-login` / `lingji-logout` / `lingji-get-account` |
| `electron/preload.ts` | 加桥 | 暴露 `electronAPI.lingjiLogin/lingjiLogout/lingjiGetAccount` |
| `src/lib/electron-api.ts` | 加类型 | `LingjiSession` / `LingjiAccount` 契约类型 + 方法签名 |
| `src/lib/llm/lingji-gateway.ts` | 改造 | 从 session 构建 4 provider + upsert 到 `aiSettings`（保留旧 `connectLingjiGateway` 或替换） |
| `src/components/account/AccountBadge.tsx` | 新增 | 欢迎页账号面板 UI |
| `src/pages/Setup.tsx` | 挂载 | Hero Banner 右上角引入 `AccountBadge` |
| `src/components/settings/LingjiGatewayConnect.tsx` | 精简 | 去掉「网关地址」输入框，改走烘焙基址（或整体让位给新登录流） |

### 5.2 服务端文件（`../lingji-web`，最小授权端点）

| 文件 | 变更 | 职责 |
|---|---|---|
| `frontend` 新增 `/oauth/authorize` 页 | 新增 | 桌面授权消费页：校验已登录→展示授权确认→调后端签发 code→302 回 `redirect_uri` |
| 后端 `POST /api/oauth/desktop/authorize` | 新增 | 已登录用户签发一次性 code（绑定 code_challenge、redirect_uri、TTL 短） |
| 后端 `POST /api/oauth/desktop/token` | 新增 | 校验 code+code_verifier→复用 `ApiKeyService` 生成 `lj_` key→返回 `{apiKey,profile,balance,tier}` |
| `frontend` vite dev 代理 | 调整 | `/api`、`/v1` 代理到后端，dev 服务跑在 15173 |

## 6. 数据流

```
Setup(AccountBadge) --lingjiLogin()--> preload --> main(lingji-account)
  main: loopback + openExternal → 浏览器 → {base}/oauth/authorize
    → 用户授权 → 后端签 code → 302 → loopback 收 code
  main: POST /api/oauth/desktop/token → { apiKey, profile, balance, tier }
  main: 加密落盘 account.json → 返回 session
Setup: session → upsertLingjiProviders(aiSettings) → saveAISettings
AccountBadge: lingjiGetAccount() → 渲染头像/邮箱/余额/tier
```

## 7. 错误处理

- 无法连接基址 / 后端 5xx：回可读中文错误，账号态不变。
- 用户关浏览器 / 超时（3min）：清 loopback，提示"授权已取消"。
- state 不匹配 / code 过期：拒绝并提示重试。
- 打包环境 `shell.openExternal` 失败：兜底提示手动复制链接（可选）。
- provider upsert 失败：不影响登录态，提示 provider 配置失败可重试。

## 8. 测试

- `src/lib/llm/lingji-gateway.ts`：从 session 构建 4 provider 的纯函数 + upsert（不覆盖已有默认、重登更新不重复）——Vitest 单测。
- `electron/lingji-account.ts` 的 URL 组装 / state 校验 / code 换 key 纯逻辑——单测（loopback 与 shell 交互以接口 mock）。
- 服务端 code 签发/换取——lingji-web 后端单测（复用其测试栈）。
- 端到端（dev）：手动跑一次浏览器授权 → 四 provider 落位 → 对话 provider 实调网关。

## 9. YAGNI / 非目标

- 不做 API Key 管理、用量明细、充值入口（账号面板仅基本信息）。
- 不新增 TTS `custom_openai_audio` 运行时（兜底用现成 minimax 型）。
- 不做托管 provider 的 UI 只读锁（仅打 `managedBy` 标记；后续可加）。
- 不实现 image/tts/video 网关上游代理（服务端后续迭代）。
- 不引入自定义协议 deep link（用 loopback）。
```
