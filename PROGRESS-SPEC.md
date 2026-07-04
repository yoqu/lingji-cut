# 统一操作进度条规范（Unified Task Progress Bar Specification）

> **纲领性文件** — 本文件定义了"灵机剪影"所有耗时操作的统一进度展示架构。
> 所有新功能和已有功能的迭代，凡涉及耗时操作（≥2 秒），**必须**接入本规范定义的统一进度系统。
> 任何 AI Agent 在本项目中的实现工作，都**必须**遵循本规范。

**完整设计文档**：[`docs/superpowers/specs/2026-04-11-unified-task-progress-design.md`](./docs/superpowers/specs/2026-04-11-unified-task-progress-design.md)

---

## 核心原则

1. **统一入口**：所有耗时操作的进度统一汇聚到底部 `AppStatusBar`
2. **无侵入**：不增加 28px 高度，仅叠加 2px 进度线
3. **可展开**：点击状态栏摘要 → 上方浮动详情面板
4. **多任务并行**：支持同时显示多个独立进度
5. **编辑器内动画保留**：打字机/审阅光标/虚拟光标不受影响

## 统一 Store

- 文件：`src/store/task-progress.ts`
- API：`startTask` / `updateTask` / `completeTask` / `failTask` / `removeTask`

## 分类颜色

| category | 颜色 | 图标 |
|----------|------|------|
| `ai-write` | `#a78bfa` 紫色 | 🤖 |
| `ai-review` | `#34d399` 绿色 | 🔍 |
| `ai-analyze` | `#60a5fa` 蓝色 | 🧠 |
| `import` | `#fbbf24` 琥珀 | 📥 |
| `export` | `#0A84FF` 系统蓝 | 🎬 |
| `tts` | `#f472b6` 粉色 | 🎙️ |
| `cover` | `#c084fc` 浅紫 | 🖼️ |
| `io` | `#9ca3af` 灰色 | 📁 |

## 观测面板（AI 生成过程）

统一进度系统的过程观测扩展（非独立进度弹窗）：AI 卡片多 agent 生成（导演→雕刻→审查）
的流式输出、工具调用与编排里程碑，经 `agent-feed:event` 通道进入 `src/store/agent-feed.ts`，
由 `AgentObservationPanel`（状态栏上方浮层）以对话流呈现。

- 关联约定：观测会话的 `feedId` = 任务在 task-progress store 的 id
  （渲染端触发经 IPC args 透传；MCP/CLI headless 为 `pipeline:<taskId>`）。
- 入口：进度面板任务行「查看过程」按钮 + 状态栏观测图标。
- 记录独立于任务生命周期（任务消失后仍可回看），手动清除或切换项目时释放。
- 新的多 agent 生成链路接入观测时复用本通道，禁止另建独立事件通道或弹窗。

## 废弃组件

- `AgentProgressBar`（编辑器上方）→ 由统一底部系统替代
- `ExportProgress`（模态弹窗）→ 由统一底部系统替代

## 禁止事项

1. 禁止新功能中创建独立进度展示组件
2. 禁止修改 AppStatusBar 的 28px 高度
3. 禁止移除编辑器内打字机/审阅光标动画
4. 禁止进度展示阻塞用户操作

---

*详细的数据结构、UI 组件规范、接入清单、实施分期见完整设计文档。*
