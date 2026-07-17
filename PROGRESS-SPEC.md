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
5. **局部反馈可选**：打字机/审阅标注可作为内容变化的增强，但不能替代统一任务状态

## 统一 Store

- 文件：`src/store/task-progress.ts`
- API：`startTask` / `updateTask` / `completeTask` / `failTask` / `cancelTask` / `removeTask`

## 分类与图标

分类只决定任务名称与 Lucide 图标，不决定活动色。所有 active 任务统一使用
`var(--color-system-blue)`；完成、失败、取消分别使用 success、danger、text-tertiary 语义色。

| category | 用途 | Lucide 图标 |
|----------|------|-------------|
| `ai-write` | 文稿与发布文本 | `FilePenLine` |
| `ai-review` | 文稿审查 | `Search` |
| `ai-analyze` | 字幕、卡片与 Motion 分析 | `Sparkles` |
| `import` | 媒体与文件导入 | `Download` |
| `export` | 视频导出 | `Film` |
| `tts` | 口播音频合成 | `Mic` |
| `cover` | 封面与图片生成 | `Image` |
| `io` | 文件读写 | `FolderOpen` |
| `publish` | 平台发布 | `Upload` |

导演优先工作流仍复用这些 category，不新建第二套进度系统：

- `director-planning` 使用 `ai-analyze`，完成后任务进入 completed，并由导演台承接批准动作。
- `production-running` 是同一父任务下的画面、封面、声音、高亮和时间线轨道；局部进度可在导演台展示，但必须同步到底部任务。
- `director-review` / `animatic-review` 是持久化检查点，不允许用永远 active 的进度任务模拟等待。
- 暂停制作必须写入 `production-paused`，将仍为 generating 的输出改为 stale；恢复只补 stale / failed / missing 产物。
- 所有迟到产物提交必须同时校验 `taskId + directorRevision`，不能覆盖新任务或新导演版本。

## 终态语义

- `completed`：真实完成，进度归 100%，5 秒后自动移除。
- `error`：仅用于真实失败，展示错误与恢复动作，10 秒后自动移除。
- `cancelled`：用户主动停止或上游取消，中性反馈，5 秒后自动移除。
- 终态任务拒绝迟到的 `updateTask` / `completeTask` / `failTask`，避免竞态覆盖。
- 父任务进入终态时，同步收尾仍 active 的子任务；已完成的子任务保持原终态。

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
3. 禁止用彩虹分类色、emoji、渐变或辉光包装 AI 进度
4. 禁止进度展示阻塞用户操作
5. 禁止伪造百分比或展示永远 active 的装饰步骤
6. 不能真实中断底层任务时，禁止显示取消按钮

---

*详细的数据结构、UI 组件规范、接入清单、实施分期见完整设计文档。*
