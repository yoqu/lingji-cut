# 统一操作进度条设计规范

> **Status**: Draft — 待用户确认后生效
> **Date**: 2026-04-11
> **Scope**: 全项目所有耗时操作（≥2 秒）的进度展示统一架构
> **Policy file**: [`PROGRESS-SPEC.md`](../../../PROGRESS-SPEC.md)（根目录纲领引用）

---

## 1. 背景与动机

当前项目存在 6+ 套独立的进度展示方案，分散且不一致：

| 方案 | 位置 | 适用场景 |
|------|------|---------|
| `AgentProgressBar` | 编辑器上方 | AI 写稿/审稿 |
| `ExportProgress` | 模态弹窗 | 视频导出 |
| `DouyinImportDialog` 内进度 | 模态弹窗 | 抖音导入 |
| `ai.ts` workflow 状态 | AI 面板 | TTS/分析/封面 |
| `LoadingOverlay` | 全屏遮罩 | 通用加载 |
| `Toast` | 右上角 | 通知（无进度） |

**目标**：收归为一套统一的底部进度系统，所有耗时操作共用同一展示通道。

---

## 2. 设计约束（用户已确认）

| 约束 | 决策 |
|------|------|
| 编辑器内动画 | **保留**（打字机 / 审阅光标 / 虚拟光标属于内容反馈，不动） |
| 与 AppStatusBar 关系 | **方案 B**：集成进 AppStatusBar，不扩展 28px 高度 |
| 进度详情查看 | 点击状态栏摘要 → 上方浮动面板 |
| 视频导出 | 底部进度条 + 完成态行 + 点击打开 Finder |
| 模态弹窗进度 | 废弃（导入弹窗保留 URL 输入，进度迁移到底部） |

---

## 3. 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│                        主工作区内容                                │
│  （编辑器内动画：打字机 / 审阅光标 / 虚拟光标 → 保留不变）          │
├──────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  TaskProgressPanel（浮动面板，仅点击展开）                  │  │
│  │  position: absolute; bottom: 100%; z-index: 100           │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │ 🤖 AI 生成稿件    streaming    ████░░░ 67%      ⏹  │  │  │
│  │  │ 📥 抖音视频导入   正在转录…    ██░░░░░ 15%          │  │  │
│  │  │ 🎬 视频导出       rendering    ████████░ 89%        │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  AppStatusBar（28px 不变）                                  │  │
│  │  ═══════════════════════════════ ← StatusBarProgressLine   │  │
│  │  [🤖 AI 生成中 67% · +2]          [ctx 45%] [● 已连接]   │  │
│  │  ↑ StatusBarTaskSummary                                    │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 数据流

```
操作代码（ScriptWorkbench / Editor / hooks）
  │  startTask / updateTask / completeTask / failTask / cancelTask
  ▼
taskProgressStore（Zustand, 纯内存）
  │
  ├──► StatusBarProgressLine  — 读取 primaryTask 的 progress / mode / category
  ├──► StatusBarTaskSummary   — 读取 primaryTask + activeCount
  └──► TaskProgressPanel      — 读取全部 tasks
```

---

## 4. 操作层级分类

### L0 — 瞬时（< 2s）：不展示进度

| 操作 | 耗时 | 来源 |
|------|------|------|
| 文件保存（auto-save） | < 500ms | 写稿工作台 / 编辑器 |
| 文件树刷新 | < 1s | 写稿工作台 |
| 文本文件导入 | < 1s | 写稿工作台 |
| 单文件加载 | < 500ms | 写稿工作台 |
| SRT 文件解析 | 1-2s | 编辑器 |

### L1 — 短耗时（2–30s）：进度线 + 状态栏文字

| 操作 | 耗时 | 来源 | mode |
|------|------|------|------|
| AI 卡片单张重新生成 | 10-30s | 编辑器 | `indeterminate` |
| 封面提示词重新生成 | 10-20s | 编辑器 | `indeterminate` |
| 音频元数据提取 | 1-5s | 编辑器 | `indeterminate` |
| 项目素材扫描 | 2-10s | 编辑器 | `indeterminate` |
| 时间线保存/加载 | 2-10s | 编辑器 | `indeterminate` |
| 项目文件批量加载 | 1-5s | 写稿工作台 | `indeterminate` |

### L2 — 长耗时（> 30s）：进度线 + 文字 + 浮动面板 + 可中断

| 操作 | 耗时 | 来源 | mode | 阶段标签 |
|------|------|------|------|---------|
| AI 生成稿件 | 10-120s | 写稿工作台 | `streaming` | preparing → streaming → finalizing |
| AI 审稿 | 15-120s | 写稿工作台 | `determinate` | waiting → reviewing → annotating |
| AI 重写稿件 | 10-120s | 写稿工作台 | `streaming` | preparing → streaming → finalizing |
| MCP 更新稿件 | 5-30s | 写稿工作台 | `streaming` | preparing → playing → finalizing |
| 抖音视频导入 | 3-20min | 写稿工作台 | `determinate` | downloading → extracting_audio → transcribing → syncing |
| TTS 语音合成 | 30-120s | 编辑器 | `determinate` | tts_generating |
| SRT AI 分析 | 30-60s | 编辑器 | `determinate` | ai_analyzing |
| 封面图批量生成 | 60-180s | 编辑器 | `determinate` | cover_generating |
| 视频导出 | 2-10min | 编辑器 | `determinate` | bundling → rendering → done |

---

## 5. 统一状态协议

### 5.1 数据结构

```typescript
type ProgressMode = 'determinate' | 'indeterminate' | 'streaming';

interface TaskCompletionAction {
  label: string;       // "在 Finder 中显示"
  handler: () => void;
}

interface TaskProgressItem {
  id: string;                    // 'ai-generate-1712808000000'
  category: TaskCategory;        // 分类只决定任务语义与图标
  label: string;                 // "AI 生成稿件"
  mode: ProgressMode;
  progress: number;              // 0-100，indeterminate 时为 0
  phase: string | null;          // "streaming"、"正在转录字幕…"
  level: 0 | 1 | 2;
  canCancel: boolean;
  onCancel?: () => void;
  startedAt: number;
  completedAt?: number;
  status: 'active' | 'completed' | 'error' | 'cancelled';
  error?: string;
  cancelReason?: string;
  completionAction?: TaskCompletionAction;
}

type TaskCategory =
  | 'ai-write'    // AI 生成/重写
  | 'ai-review'   // AI 审稿
  | 'ai-analyze'  // AI 分析（卡片/提示词）
  | 'import'      // 抖音导入/文件导入
  | 'export'      // 视频导出
  | 'tts'         // TTS 语音合成
  | 'cover'       // 封面图生成
  | 'io'          // 通用文件 I/O
  | 'publish';    // 平台发布
```

### 5.2 Store API

```typescript
interface TaskProgressStore {
  tasks: Map<string, TaskProgressItem>;

  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;

  startTask: (task: Omit<TaskProgressItem, 'startedAt' | 'status'>) => void;
  updateTask: (id: string, patch: Partial<Pick<
    TaskProgressItem, 'progress' | 'phase' | 'mode' | 'label'
  >>) => void;
  completeTask: (id: string, action?: TaskCompletionAction) => void;
  failTask: (id: string, error: string) => void;
  cancelTask: (id: string, reason?: string) => void;
  removeTask: (id: string) => void;

  // 派生值（Zustand selector 或 getter）
  primaryTask: TaskProgressItem | null;   // 最近启动的 active 任务
  activeCount: number;                    // status === 'active' 的数量
}
```

**行为规则**：
- `completeTask` 将 status 设为 `'completed'`，设置 `completedAt`，5 秒后自动 `removeTask`
- `failTask` 将 status 设为 `'error'`，10 秒后自动 `removeTask`（用户也可提前手动关闭）
- `cancelTask` 将 status 设为 `'cancelled'`，使用中性色，5 秒后自动 `removeTask`
- 任务进入终态后拒绝迟到的 update/complete/fail；父任务终止会同步收尾仍 active 的子任务
- `primaryTask` 选择规则：最近 `startedAt` 的 active 任务；无 active 时取最近终态任务
- Store 文件：`src/store/task-progress.ts`，Zustand，无持久化

---

## 6. UI 组件

### 6.1 StatusBarProgressLine

**职责**：AppStatusBar 顶部的 2px 进度指示线。

| 属性 | 值 |
|------|-----|
| 高度 | 2px |
| 定位 | `position: absolute; top: 0; left: 0; right: 0` 在 AppStatusBar 内部 |
| 圆角 | 无（贯穿全宽） |
| z-index | 1 |
| 无任务时 | 不渲染 |

**颜色（按状态）**：active 统一使用 `var(--color-system-blue)`；completed、error、cancelled
分别使用 `var(--color-success)`、`var(--color-danger)`、`var(--color-text-tertiary)`。
category 不再分配彩虹色。

**动画**：

| mode | 实现 |
|------|------|
| `determinate` | `width: ${progress}%`，`transition: width 0.3s ease` |
| `indeterminate` | `@keyframes indeterminateSweep`：35% 宽度光带从左到右，1.2s 周期 |
| `streaming` | 系统蓝单色脉冲，不使用渐变、辉光或扫描线 |

**多任务**：显示 `primaryTask` 的状态色和进度。

### 6.2 StatusBarTaskSummary

**职责**：状态栏左侧的任务摘要文字，可点击展开面板。

**位置**：`AppStatusBar .left` 区域，`WorkbenchStatsIndicator` 之后，用 `|` 分隔符隔开。

**展示逻辑**：

| 场景 | 文字 |
|------|------|
| 无活跃任务 | 不渲染 |
| 1 个 active | `{icon} {label} {progress}%` |
| 2+ 个 active | `{icon} {primaryLabel} {progress}% · +{n-1}` |
| 完成（短暂可见） | `{Check} {label} 完成` |
| 失败（短暂可见） | `{CircleAlert} {label} 失败` |
| 取消（短暂可见） | `{Ban} {label} 已取消` |

**图标映射**：

| category | 图标 |
|----------|------|
| `ai-write` | `FilePenLine` |
| `ai-review` | `Search` |
| `ai-analyze` | `Sparkles` |
| `import` | `Download` |
| `export` | `Film` |
| `tts` | `Mic` |
| `cover` | `Image` |
| `io` | `FolderOpen` |
| `publish` | `Upload` |

**交互**：点击切换 `panelOpen`；hover 提亮至 `--color-text-secondary`。

### 6.3 TaskProgressPanel

**职责**：浮动详情面板，展示所有活跃/刚完成的任务。

**样式**：
```css
position: absolute;
bottom: 30px;     /* statusBar(28) + 2px gap */
left: 0;
right: 0;
background: var(--color-panel-elevated, #2C2C2E);
border: 1px solid var(--color-separator, #38383A);
border-radius: 8px 8px 0 0;
box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.3);
padding: 8px 0;
max-height: 240px;
overflow-y: auto;
z-index: 100;
```

**任务行布局**：
```
[icon 16px] [label 11px fw600 flex:1] [phase 11px tertiary] [bar 80×3px] [pct 10px] [cancel?]
```

**状态变体**：

| status | 进度条颜色 | 右侧内容 | 自动移除 |
|--------|-----------|---------|---------|
| `active` | 系统蓝 | 百分比 + 取消按钮（仅真实可中断时） | 否 |
| `completed` | `--color-success` 100% | `completionAction` 按钮或空 | 5s |
| `error` | `--color-danger` | 错误摘要 + 关闭按钮 | 10s |
| `cancelled` | `--color-text-tertiary` | 中性取消原因 | 5s |

**关闭**：点击面板外区域关闭。

---

## 7. 接入清单

### 7.1 写稿工作台

| 操作 | category | mode | 替代 |
|------|----------|------|------|
| AI 生成稿件 | `ai-write` | `streaming` | 替代 `AgentProgressBar` 生成模式 |
| AI 审稿 | `ai-review` | `determinate` | 替代 `AgentProgressBar` 审稿模式 |
| AI 重写 | `ai-write` | `streaming` | 替代 `AgentProgressBar` 重写模式 |
| MCP 更新稿件 | `ai-write` | `streaming` | 新增 |
| 抖音视频导入 | `import` | `determinate` | 替代 `DouyinImportDialog` 进度部分 |
| 项目文件加载 | `io` | `indeterminate` | 新增 |

### 7.2 视频编辑器

| 操作 | category | mode | 替代 |
|------|----------|------|------|
| TTS 语音合成 | `tts` | `determinate` | 新增 |
| SRT AI 分析 | `ai-analyze` | `determinate` | 新增 |
| AI 卡片重生成 | `ai-analyze` | `indeterminate` | 新增 |
| 封面提示词重生成 | `ai-analyze` | `indeterminate` | 新增 |
| 封面图批量生成 | `cover` | `determinate` | 新增 |
| 视频导出 | `export` | `determinate` | 替代 `ExportProgress` 模态 |
| 时间线保存/加载 | `io` | `indeterminate` | 新增 |
| 素材扫描 | `io` | `indeterminate` | 新增 |

**视频导出完成后**：`completeTask(id, { label: '在 Finder 中显示', handler: () => showItemInFolder(path) })`

---

## 8. 废弃清单

| 组件 | 文件 | 处置 |
|------|------|------|
| `AgentProgressBar` | `src/components/agent/AgentProgressBar.tsx` | 移除渲染引用，删除文件 |
| `AgentProgressBar.module.css` | `src/components/agent/AgentProgressBar.module.css` | 随组件删除 |
| `ExportProgress` | `src/components/ExportProgress.tsx` | 移除渲染引用，删除文件 |
| `ExportProgress.module.css` | `src/components/ExportProgress.module.css` | 随组件删除 |

**保留不动**（编辑器内动画）：
- `src/lib/virtual-cursor.ts`
- `src/lib/live-streaming-editor.ts`
- `src/lib/review-cursor-animator.ts`
- `src/lib/streaming-editor.ts`
- `src/lib/diff-to-frames.ts`

---

## 9. 新增文件

| 文件 | 职责 |
|------|------|
| `src/store/task-progress.ts` | Zustand store |
| `src/components/StatusBarProgressLine.tsx` | 2px 进度线 |
| `src/components/StatusBarTaskSummary.tsx` | 状态栏任务摘要 |
| `src/components/TaskProgressPanel.tsx` | 浮动详情面板 |
| `src/components/TaskProgressPanel.module.css` | 面板样式 |

---

## 10. 接入模板

```typescript
import { useTaskProgressStore } from '../store/task-progress';

const taskId = `my-op-${Date.now()}`;

// 启动
useTaskProgressStore.getState().startTask({
  id: taskId,
  category: 'ai-write',
  label: 'AI 生成稿件',
  mode: 'streaming',
  progress: 0,
  phase: 'preparing',
  level: 2,
  canCancel: true,
  onCancel: () => { /* 中断 */ },
});

// 更新
useTaskProgressStore.getState().updateTask(taskId, {
  progress: 50,
  phase: 'streaming',
});

// 完成（可带操作按钮）
useTaskProgressStore.getState().completeTask(taskId, {
  label: '在 Finder 中显示',
  handler: () => showInFinder(),
});

// 或失败
useTaskProgressStore.getState().failTask(taskId, 'API 超时');

// 或用户取消（onCancel 必须真实中断底层操作）
useTaskProgressStore.getState().cancelTask(taskId, '用户停止');
```

---

## 11. 禁止事项

1. 禁止新功能中创建独立进度展示组件（模态 / 内联 / 顶部条）
2. 禁止用 `LoadingOverlay` 展示长耗时操作
3. 禁止修改 AppStatusBar 的 28px 高度
4. 禁止在进度线中使用彩虹分类色、渐变、辉光或 emoji
5. 禁止伪造百分比或永远 active 的装饰步骤
6. 禁止进度展示阻塞用户操作
7. 禁止在底层不可中断时展示取消按钮
8. 禁止把取消写成成功或失败
9. 禁止完成态缺少必要操作入口（如导出后的 Finder 按钮）

---

## 12. 实施分期

| Phase | 内容 | 依赖 |
|-------|------|------|
| **P1 基础框架** | store + 3 个 UI 组件 + 集成到 AppStatusBar | 无 |
| **P2 写稿工作台** | AI 生成/审稿/重写 + 抖音导入 + MCP 更新 | P1 |
| **P3 视频编辑器** | 视频导出 + TTS + 分析 + 封面 + 卡片重生成 | P1 |
| **P4 收尾** | 废弃组件清理 + L1 短操作补齐 + 面板打磨 | P2, P3 |

---

## 13. 与现有规范关系

| 规范 | 关系 |
|------|------|
| DESIGN.md AI 人机交互体系 | 统一生命周期、状态语义、视觉反馈与取消规则 |
| CLAUDE.md UI 设计规范 | 颜色/字体/间距遵循 macOS 专业工具风格 |
| DESIGN.md | 组件实现遵循 CSS 变量和设计 token |
