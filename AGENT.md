# AGENT.md

本文件描述在 `video-web-master` 仓库内工作的自动化代理默认约束。若上层目录、会话或用户有更高优先级指令，以更高优先级为准。

## 1. 仓库定位

这是一个 `Electron + React + Remotion` 的本地优先桌面视频创作工具，产品名为 `灵机剪影`。

当前核心目标不是“导入 MP3 + SRT 后导出视频”这么单一，而是覆盖完整创作链路：

```text
素材 / 抖音导入
  → original.md
  → script.md
  → MiniMax TTS + SRT
  → AI 分析 / 封面 / 信息卡 / Motion Card
  → 时间线编辑
  → Remotion H.264 MP4 导出
```

## 2. 默认工作方式

接手任务时先判断改动类型：

- 文档 / 文案 / 小样式：可直接做最小修改。
- 时间线 / AI / IPC / Agent / 持久化：先读相关入口和数据流，再改。
- 多文件并行任务：只在写入范围互不冲突时拆分；同一文件多处修改默认串行。
- 不确定影响面的任务：先列清楚依赖和风险，再实施。

不要因为看到旧文档描述就照旧实现。优先以当前代码为准。

## 3. 先读哪里

通用入口：

- `package.json`
- `src/App.tsx`
- `src/lib/electron-api.ts`
- `electron/main.ts`
- `electron/preload.ts`

页面入口：

- `src/pages/Setup.tsx`
- `src/pages/ScriptWorkbench.tsx`
- `src/pages/Editor.tsx`
- `src/pages/Settings.tsx`

状态入口：

- `src/store/timeline.ts`
- `src/store/ai.ts`
- `src/store/script.ts`
- `src/store/task-progress.ts`
- `src/store/agent.ts`

核心类型：

- `src/types.ts`
- `src/types/ai.ts`
- `src/types/global-settings.ts`
- `src/lib/project-persistence.ts`

## 4. 项目文件契约

用户项目目录的主文件是 `project.json`，由 `electron/project-file.ts` 负责加载、保存和迁移。

`project.json` 包含三个主要段：

- `timeline`
- `aiAnalysis`
- `script`

常见项目文件 / 目录：

- `original.md`
- `script.md`
- `podcast-audio.mp3`
- `podcast-subtitles.srt`
- `podcast-subtitles.original.srt`
- `covers/`
- `ai-cards/`
- `imports/douyin/<videoId>/`
- `configs/prompts/`

格式约束：

`project.json` 是唯一工程文件；旧分散文件（`timeline.json` / `ai-analysis.json` / `script-state.json`）的迁移链已删除，pre-project.json 旧工程不再支持。新功能一律写入 `project.json` 段或明确的业务资源目录，不要新增分散状态文件。

## 5. Electron IPC 契约

Renderer 不能直接使用 Node API。

新增或修改主进程能力时，通常要同步：

- `electron/main.ts`
- `electron/preload.ts`
- `src/lib/electron-api.ts`
- 相关测试

如果涉及 Agent / MCP / Conversation / Script History，还要检查：

- `electron/acp/ipc.ts`
- `electron/mcp/ipc.ts`
- `electron/conversations/ipc.ts`
- `electron/script-history/ipc.ts`
- preload 暴露的对应 API

## 6. 时间线与视频契约

时间线核心在 `src/types.ts` 与 `src/store/timeline.ts`。

当前支持：

- 口播音轨、字幕轨、视觉轨、音频叠加轨。
- 图片、视频、文字、音频 overlay。
- AI 卡片 overlay。
- 轨道新增、删除、锁定、排序。
- overlay 拖拽、吸附、碰撞检测、裁剪、拆分、复制 / 剪切 / 粘贴。
- 字幕自动重切分、关键词高亮、字幕样式。

修改相关能力时，常见联动文件：

- `src/lib/timeline-tracks.ts`
- `src/lib/timeline-placement.ts`
- `src/lib/timeline-snap.ts`
- `src/lib/subtitle-builder.ts`
- `src/lib/subtitle-highlights.ts`
- `src/lib/srt-resegment.ts`
- `src/components/Timeline.tsx`
- `src/components/EditorInspector.tsx`
- `src/remotion/MainComposition.tsx`
- `src/remotion/timeline-to-sequences.ts`
- `src/components/RemotionPreviewPlayer.tsx`

## 7. Remotion 导出契约

渲染链路固定：

- `src/remotion/`（`MainComposition` / `Root` / `timeline-to-sequences` / `overlays/*` / `card-host` / `asset-src`）
- `electron/remotion/`（`compile-card-node` / `bundle` / `render`）
- `electron/main.ts` 的 `render-video` IPC（materialize → 编译卡片 → bundle → renderMedia）

修改导出前要确认：

- 本地绝对路径素材是否可被 `asset-src` 正确映射。
- `exportConfig` 是否正确影响 fps、quality、分辨率与输出格式。
- 音频、字幕、图片 / 视频 / 文字 overlay、AI Card、Motion Card 是否在预览和导出中一致（同一份 `buildRenderPlan` 与编译产物）。
- 打包后 Remotion 自带的 Chrome Headless Shell 与 ffmpeg 必须可被主进程定位。
- 不允许重新引入 HyperFrames 或 GSAP 运行时作为渲染路径。

## 8. AI 与提示词契约

AI 设置在 `src/types/ai.ts`。

当前 AI 体系包括：

- 多 LLM Provider。
- 多 Image Provider。
- MiniMax TTS。
- 字幕分段规划。
- 内容卡片生成。
- 封面提示词与图片生成。
- 视觉编排 Storyboard。
- Motion Card 生成 / 修改 / 自动修复。
- 全局 / 项目级提示词覆盖。
- Prompt Kind 到 Provider / Model 的绑定。

Prompt Kind 列表：

- `planning.segment`
- `cover.regeneration`
- `cards.segment`
- `cards.animation`
- `script.review`
- `card.image`
- `card.video`
- `publish.metadata`
- `publish.partition`

修改 AI 相关功能时，至少检查：

- `src/store/ai.ts`
- `src/lib/ai-analysis.ts`
- `src/lib/ai-persistence.ts`
- `src/lib/llm/`
- `src/lib/image-gen/`
- `src/lib/prompts/`
- `electron/prompts-io.ts`
- `electron/prompt-bindings-io.ts`
- `src/components/settings/AIConfigTab.tsx`
- `src/components/settings/PromptsConfigTab.tsx`

严禁把 API Key、Session ID、Bearer Token 写入源码、测试快照或文档示例。

## 9. 脚本工作台契约

脚本工作台核心文件：

- `src/pages/ScriptWorkbench.tsx`
- `src/store/script.ts`
- `src/lib/script-persistence.ts`
- `src/components/script/`

关键规则：

- `original.md` 是原始素材。
- `script.md` 是口播成稿。
- 多文件编辑状态由 store 维护。
- 文件监听会检测外部改动并触发冲突。
- 保存 `script.md` 时会创建版本历史。
- AI 写稿 / 审稿需要维护虚拟光标、只读态、流式状态、批注状态。

如果任务发生在应用内 Agent / MCP 场景，不要直接读写项目目录里的 `script.md`。应通过 `lingji_*` MCP 工具操作编辑器。

## 10. Agent / MCP 契约

Agent 与 MCP 是当前项目的重要能力，不是实验性孤岛。

相关入口：

- `electron/acp/`
- `electron/mcp/`
- `electron/conversations/`
- `src/components/agent/`
- `src/lib/agent-api.ts`
- `src/lib/mcp-api.ts`

默认 Agent 配置：

- `~/.lingji/agent-config.json`
- API Key 由 Electron `safeStorage` 加密保存。
- 默认权限策略为 `tiered`。

MCP Server：

- 服务器 ID：`lingji-editor`
- 支持注册到 Claude Code、Codex、Gemini
- 工具名前缀：`lingji_*`

脚本操作优先工具：

- `lingji_get_editor_state`
- `lingji_get_project_context`
- `lingji_read_script`
- `lingji_update_script`
- `lingji_review_script`
- `lingji_list_project_files`
- `lingji_import_video_source`
- `lingji_get_video_import_status`

## 11. UI / 交互契约

完整设计规范看 `DESIGN.md`。

关键原则：

- 桌面优先，不要默认移动端优先。
- 保持 macOS 专业创作工具风格。
- 新 UI 优先复用 `src/ui/components/`、`src/ui/primitives/`、`src/ui/patterns/`。
- 样式变量优先来自 `src/ui/styles/tokens.css` 和 `src/ui/styles/darwin-ui.css`。
- 不要恢复旧 Apple 官网式浅色落地页风格。
- 中文界面文案保持简体中文，代码标识符保持英文。

AI 操作视觉反馈必须复用：

- `src/lib/virtual-cursor.ts`
- `src/lib/live-streaming-editor.ts`
- `src/lib/review-cursor-animator.ts`
- `src/lib/streaming-editor.ts`
- `src/lib/diff-to-frames.ts`

不要自行复制一套 AI 光标、打字机、呼吸扫描动画。

## 12. 统一进度契约

所有耗时操作（≥2 秒）必须接入统一底部进度系统：

- `src/store/task-progress.ts`
- `src/components/AppStatusBar.tsx`
- `src/components/TaskProgressPanel.tsx`
- `src/components/StatusBarProgressLine.tsx`
- `src/components/StatusBarTaskSummary.tsx`

不要为新任务新增独立进度弹窗或重复进度条。

## 13. 高风险改动

出现以下情况时，默认先做影响分析：

- 修改 `TimelineData`、`OverlayItem`、`AICard`、`AISettings`、`ProjectData`。
- 修改项目目录落盘格式。
- 修改 IPC 名称、参数结构或返回值。
- 修改 Remotion composition 输入结构或导出入口。
- 修改 AI Provider、图片 Provider、Prompt Binding。
- 修改 Agent 权限策略、密钥存储、MCP 注册逻辑。
- 修改 Electron 安全边界、preload 暴露范围。
- 修改根级构建配置、依赖、打包脚本。

## 14. 验证建议

根据改动范围选择最小但真实的验证：

- 文档改动：检查 Markdown、路径、命令是否准确。
- 纯函数 / lib：跑相关 Vitest。
- 时间线：跑 timeline、placement、snap、store 相关测试。
- 脚本工作台：跑 script、conversation、history、MCP 相关测试。
- AI：跑 ai、prompts、provider、image-gen、motion 相关测试。
- IPC：跑对应 Electron API / main 测试，并检查 main / preload / renderer 类型同步。
- 导出：跑 remotion / export 相关测试，必要时跑 `npm run build`。

常用命令：

```bash
npm test
npx vitest run tests/<target>.test.ts
npm run build
```

## 15. 提交前检查清单

- 改动是否只覆盖任务相关范围。
- 是否误改构建产物、示例数据或用户工程数据。
- 共享类型变更是否同步所有调用方。
- IPC 三件套是否同步。
- 项目文件格式变更是否包含迁移或兼容策略。
- AI/Agent 密钥是否没有进入源码。
- 是否运行了与改动匹配的验证。
- 最终说明是否如实写明验证结果和未验证项。

## 16. 文档维护约定

当仓库结构、命令、工程文件、AI 配置、Agent / MCP、导出链路发生变化时，同步更新：

- `README.md`
- `CLAUDE.md`
- `AGENT.md`

如果未来新增标准项目级 `AGENTS.md`，可以把本文件迁移过去；迁移前仍以 `AGENT.md` 作为仓库内通用代理说明。
