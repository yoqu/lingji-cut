# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Video Web Master - Claude Code 项目规则

## 项目定位

`灵机剪影` 是一个本地优先的 Electron 桌面创作工具，目标是把口播 / 播客内容从素材、文稿、语音、字幕一路推进到可导出的 MP4 视频。

当前主链路：

```text
项目目录
  → original.md / script.md
  → MiniMax TTS 音频 + SRT
  → AI 字幕分析 / 封面 / 信息卡 / Motion Card
  → 时间线编辑
  → Remotion 导出 H.264 MP4
```

这不是纯前端页面项目。很多改动需要同时考虑 Electron 主进程、preload、Renderer 状态、项目文件、Remotion 渲染和测试。

## 常用命令

```bash
npm run dev          # 启动 electron-vite 开发服务
npm run build        # 编译 Electron main + preload + React renderer，并执行混淆
npm test             # 运行 Vitest（单次）
npm run test:watch   # Vitest watch 模式
npx vitest run tests/editor.test.tsx  # 运行单个测试文件
npm run package:mac  # 打包 macOS .app
npm run dist:mac     # 构建并打包 macOS .app
```

当前没有独立 lint 命令。类型与构建问题主要通过 `npm run build`、Vitest 和 TypeScript 检查暴露。

## 技术栈

- Electron 41 / electron-vite
- React 19 / TypeScript 6
- Remotion 4
- Zustand
- CodeMirror 6
- Framer Motion
- TailwindCSS 4 + 自研 UI primitives / patterns
- MCP SDK + Claude ACP
- Vitest

## 页面与状态架构

页面切换由 `src/App.tsx` 中的 `AppPage` 状态驱动，没有使用 react-router。

主要页面：

- `welcome`：欢迎页、最近项目、新建工程、抖音导入入口。
- `setup`：传统音频 + SRT 导入。
- `script-workbench`：脚本工作台、AI 写稿 / 审稿、文件树、版本历史、视频导入预览。
- `editor`：素材面板、预览、时间线、Inspector、AI 面板、导出。
- `settings`：AI、模板、TTS、Agent、MCP、提示词、备份配置。

核心 Store：

- `src/store/timeline.ts`：时间线、素材、轨道、字幕、overlay、undo / redo。
- `src/store/ai.ts`：AI 分析结果、封面候选、Motion Card、Storyboard、AI 视频工作流。
- `src/store/script.ts`：脚本工作台、批注、文件状态、AI 操作动画、抖音导入状态。
- `src/store/task-progress.ts`：底部统一任务进度。
- `src/store/agent.ts`：Agent UI 与运行态信息。

## 工程文件与持久化

当前主工程文件是用户项目目录下的 `project.json`。

`project.json` 结构由 `src/lib/project-persistence.ts` 定义，包含：

- `timeline`：时间线与素材编排。
- `aiAnalysis`：AI 分析、封面候选、Motion Card、Storyboard。
- `script`：模板、批注、审稿状态、脚本工作台状态。
- `meta`：作品级元信息（作品标题真源 `meta.title`；发布 tab / 封面 / 流水线均引用，`publish.title` 保持镜像）。

主进程读写入口：

- `electron/project-file.ts`：统一加载、保存、原子写与损坏备份。
- `electron/main.ts`：暴露 `load-project`、`save-project-section` 等 IPC。
- `src/lib/script-persistence.ts`：脚本工作台状态从 project.json script 段读取。

格式约束：

- `project.json` 是唯一工程文件；旧分散文件（`timeline.json`、`ai-analysis.json`、`script-state.json`）的迁移链与兼容 IPC 已删除。
- 不要新增分散状态文件；所有段落经 `save-project-section` 落盘，落盘由各 store 的订阅自动完成，不要在调用方手动重复写。

常见项目产物：

- `original.md`
- `script.md`
- `podcast-audio.mp3`
- `podcast-subtitles.srt`
- `podcast-subtitles.original.srt`
- `covers/`
- `ai-cards/`
- `imports/douyin/<videoId>/`
- `imports/wechat/<articleId>/`
- `configs/prompts/`

## Electron IPC 约束

Renderer 不直接使用 Node API。任何文件系统、系统菜单、Remotion 渲染、TTS、导入、Agent、MCP 能力必须通过 preload 桥接。

新增 / 修改 IPC 时，通常必须同步：

- `electron/main.ts`
- `electron/preload.ts`
- `src/lib/electron-api.ts`
- 相关测试

如果只改其中一处，通常是不完整改动。

另外：

- `electron/main.ts` 负责 Remotion 渲染（bundle+renderMedia）、文件 I/O、全局配置、菜单、日志、导入、TTS。
- `electron/preload.ts` 暴露 `electronAPI`、`agentAPI`、`mcpAPI`、`conversationAPI` 等安全桥。
- `src/lib/electron-api.ts` 是 Renderer 侧类型契约，不要让它和 preload 漂移。

## 视频与时间线约束

核心类型：

- `src/types.ts`
- `TimelineData`
- `TimelineTrack`
- `OverlayItem`
- `SubtitleStyle`
- `AudioOverlayData`
- `TextOverlayData`

当前 overlay 类型：

- `video`
- `image`
- `text`
- `audio`

重要能力：

- 多视觉轨与音频叠加轨。
- overlay 拖拽、吸附、碰撞检测、裁剪、拆分、复制 / 剪切 / 粘贴。
- 字幕自动重切分、关键词高亮、样式配置。
- 文字图层动画。
- AI 卡片通过 `overlayType: 'ai-card'` 接入时间线。

修改时间线相关逻辑时，优先检查：

- `src/types.ts`
- `src/store/timeline.ts`
- `src/lib/timeline-tracks.ts`
- `src/lib/timeline-placement.ts`
- `src/lib/timeline-snap.ts`
- `src/components/Timeline.tsx`
- `src/remotion/MainComposition.tsx`
- `src/remotion/timeline-to-sequences.ts`

## Remotion 导出约束

渲染引擎为 Remotion（React / 帧驱动）。预览用 `@remotion/player`，导出用 `@remotion/bundler` + `@remotion/renderer`（自带 Chrome Headless Shell + ffmpeg）。

渲染链路：

- `src/remotion/`：`MainComposition` / `Root` / `timeline-to-sequences` / `overlays/*` / `card-host` / `asset-src`
- `electron/remotion/`：`compile-card-node`（esbuild）/ `bundle` / `render`
- `electron/main.ts`：`render-video` IPC（materialize → 编译卡片 → bundle → renderMedia）

关键规则：

- 渲染引擎已从 HyperFrames 切换为 Remotion；不要再引入 HyperFrames 或 GSAP 运行时作为渲染路径。
- `TimelineData` 仍是编辑器数据源，导出/预览前由 `buildRenderPlan` 编译为 Remotion 组件树（`<Sequence>` + overlay 组件）。
- AI Motion Card 是 LLM 生成的**自由 Remotion TSX**（`motionCard.tsx`，default export 函数组件）；主进程用 esbuild 编译为 CJS，经 `inputProps.compiledCards` 注入，由 `CardHost` 在 Remotion 上下文内求值（预览与导出同一份编译产物）。
- pre-project.json 旧工程与 HTML(GSAP) 旧卡片的兼容链已移除：`project.json` 是唯一工程格式，遗留 `motionCard.html` 卡片不再降级渲染。
- 自由 TSX 的运行时求值需要渲染面允许 `'unsafe-eval'`；卡片渲染包含错误边界。
- 导出格式当前是 H.264 MP4。

## AI / Provider / 提示词架构

AI 设置类型在 `src/types/ai.ts`。

LLM Provider：

- `llmProviders`
- `defaultProviderId`
- `defaultModel`
- 运行时重点支持 OpenAI 兼容、Gemini、LM Studio 等类型；Anthropic 当前主要体现在 Provider 类型与模型列表配置能力上，修改生成链路前必须核实 `src/lib/llm/model.ts`。
- 旧字段 `llmBaseUrl`、`llmApiKey`、`llmModel` 只用于迁移兼容。

图片 Provider：

- `jimeng`
- `openai_image`
- `minimax`
- `doubao`
- `imagen`
- `wanx`
- `custom`

提示词分层：

- 内置：`src/lib/prompts/defaults.ts`
- 类型与元数据：`src/lib/prompts/types.ts`
- 全局覆盖：用户数据目录下的 prompts。
- 项目覆盖：`configs/prompts/`。
- 项目绑定：`electron/prompt-bindings-io.ts` 与 `AIStore.projectBindings`。

Prompt Kind：

- `planning.segment`
- `cover.regeneration`
- `cards.segment`
- `cards.animation`
- `script.review`
- `card.image`
- `card.video`
- `publish.metadata`
- `publish.partition`

修改 AI 结构、提示词或卡片时，至少检查：

- `src/types/ai.ts`
- `src/store/ai.ts`
- `src/lib/ai-analysis.ts`
- `src/lib/ai-persistence.ts`
- `src/lib/llm/`
- `src/lib/prompts/`
- `electron/prompts-io.ts`
- `electron/prompt-bindings-io.ts`
- `src/components/AIPanel.tsx`
- `src/components/AICardInspector.tsx`
- `src/remotion/`

## 脚本工作台约束

脚本工作台入口：

- `src/pages/ScriptWorkbench.tsx`
- `src/store/script.ts`
- `src/lib/script-persistence.ts`
- `src/components/script/`

核心文件：

- `original.md`：原始素材。
- `script.md`：口播成稿。

能力边界：

- 多文件标签和文件树由应用状态维护。
- 文件监听会检测外部修改并触发冲突处理。
- `script.md` 保存时会创建版本历史。
- AI 写稿和审稿必须维护 `editorAgent`、`agentOperation`、虚拟光标和只读状态。
- 审稿批注通过精确文本或行号定位，批注状态在 store 中维护。

不要绕过工作台状态直接改 `script.md` 后声称编辑器已同步。若任务发生在应用内 Agent / MCP 语境，应使用 `lingji_*` MCP 工具。

## Agent / ACP / MCP 约束

Agent 相关入口：

- `electron/acp/`
- `electron/conversations/`
- `electron/mcp/`
- `src/components/agent/`
- `src/lib/agent-api.ts`
- `src/lib/mcp-api.ts`
- `src/types/conversation.ts`

Agent 配置：

- 默认位于 `~/.lingji/agent-config.json`。
- API Key 通过 Electron `safeStorage` 加密保存，降级时才明文写入 key 文件。
- 权限策略默认为 `tiered`，可以运行时同步到已连接会话。

MCP Server：

- 服务器 ID：`lingji-editor`。
- 可注册到 Claude Code、Codex、Gemini。
- 工具包括读取编辑器状态、读写脚本、提交审稿批注、列项目文件、获取项目上下文、导入抖音视频、查询导入状态、生成作品标题与发布文案。

Claude ACP 连接时会向用户项目目录写入 / 更新 `CLAUDE.md` 中的 MCP 工具使用指引。这是为了让外部 Claude Code 在脚本编辑场景中通过 `lingji_*` 工具操作编辑器，而不是直接 Read / Write 文件。

## UI 设计规范

完整规范见 `DESIGN.md`。

当前有效方向：

- macOS 专业创作工具风格。
- 桌面优先，最小窗口约 1100×760。
- 主要 accent 使用系统蓝 `--color-system-blue`。
- 不要引入第二套彩色 accent。
- 不要回退到旧 Apple 官网落地页风格。
- 新 UI 优先复用 `src/ui/components/`、`src/ui/primitives/`、`src/ui/patterns/`。
- CSS 变量在 `src/ui/styles/tokens.css`、`src/ui/styles/darwin-ui.css` 等文件中维护。

### AI 操作界面视觉反馈体系（铁律）

所有涉及 AI 操作界面的功能必须复用统一视觉反馈架构，不允许各模块自行发明独立方案。

核心文件：

- `src/lib/virtual-cursor.ts`
- `src/lib/live-streaming-editor.ts`
- `src/lib/review-cursor-animator.ts`
- `src/lib/streaming-editor.ts`
- `src/lib/diff-to-frames.ts`
- `src/store/script.ts`

强制规则：

- 生成 / 审阅类操作必须维护文档内虚拟光标。
- 审阅扫描场景使用浮动鼠标指针。
- AI 操作期间 `editorAgent.readOnly` 必须为 `true`。
- 动画期间 `streamingActive` 必须为 `true`，防止 React 状态同步覆盖 CodeMirror 动画内容。
- 异常 / 中断路径必须清理虚拟光标、审阅高亮、呼吸状态和操作状态。
- 不要在新模块里自行实现 blinking cursor、typing indicator、breathing 效果。

### 统一进度系统

完整规范见 `PROGRESS-SPEC.md`。

所有耗时操作（≥2 秒）必须接入底部统一进度系统：

- Store：`src/store/task-progress.ts`
- UI：`AppStatusBar`、`StatusBarProgressLine`、`StatusBarTaskSummary`、`TaskProgressPanel`
- API：`startTask` / `updateTask` / `completeTask` / `failTask`

禁止为新耗时任务新增独立进度弹窗、顶部条或孤立内联进度组件。编辑器内部打字机和审阅光标属于内容反馈，可以保留。

## 高风险改动清单

以下改动需要先做影响面分析：

- 修改 `TimelineData`、`OverlayItem`、`AICard`、`AISettings`、`ProjectData` 等共享类型。
- 修改 `project.json` 结构或迁移逻辑。
- 修改 IPC 名称、参数或返回值。
- 修改 Remotion composition 输入结构或导出入口。
- 修改 AI Provider、提示词绑定、图片生成 Provider。
- 修改 Agent 权限策略、API Key 存储或 MCP 注册逻辑。
- 修改 Electron 安全边界、preload 暴露范围或 webSecurity 策略。
- 修改根级构建配置、依赖或打包脚本。

## 测试与验证建议

按改动范围选择最小但真实的验证：

- 文档改动：检查 Markdown、路径、命令和架构描述是否与代码一致。
- 纯函数 / lib 改动：运行相关 `npx vitest run tests/<file>.test.ts`。
- UI 组件改动：运行对应组件测试，必要时启动应用手动验收。
- IPC / Electron 桥接改动：覆盖 main / preload / electron-api 三件套并跑相关测试。
- 项目持久化改动：覆盖新工程、旧工程迁移、并发保存、Web Card materialize。
- 导出链路改动：至少跑相关测试，必要时跑 `npm run build`。
- 前端界面较大改动完成后，执行项目内 UI 审查流程。

## 提交前检查

- 是否只改了任务相关范围。
- 是否误改 `dist/`、`dist-electron/`、`release/`、`work/` 等产物目录。
- 共享类型变更是否同步调用方和测试。
- IPC 三件套是否同步。
- 项目文件格式变更是否考虑迁移。
- AI/Agent 密钥是否没有进入源码。
- 最终说明是否如实写明运行了什么验证、没运行什么验证。
