# AI 卡片生成观测面板：右侧常驻 + 阶段管线 设计

日期：2026-07-04
分支：feat/desktop-account-login（实现时另开分支或沿用当前工作分支由实现计划决定）

## 问题

Motion 卡多 agent 生成（导演→雕刻→机械质检→审查）的过程观测面板 `AgentObservationPanel` 目前是状态栏浮层，入口只有状态栏小图标和任务行"查看过程"按钮，藏得太深。用户期望：

1. 常驻编辑器右侧（像 AI 对话面板一样随手可见）；
2. 流程图引擎式展示：一眼看到当前阶段、每阶段对话内容；
3. 侧边多头像表示多 agent / 多卡并行；
4. 明确标注每个 agent 正在使用的模型。

## 决策（用户未及时回复，按推荐项定稿）

- **停靠位置**：右侧 Inspector 槽 —— `InspectorSelection` 新增 `{ type: 'agent-feed' }`。生成开始自动切入；用户点选素材可切走、随时切回。复用现有宽度调节与布局，改动最小。
- **流程形态**：垂直阶段管线 —— 面板顶部固定 导演→雕刻→质检→审查 节点条（含重试回环角标），高亮当前阶段；点击节点跳转/过滤该阶段对话。下方是完整对话流。不引入 react-flow 类画布依赖（KISS）。
- **并行组织**：按卡片分组 —— 左侧窄轨一列卡片会话头像（活跃卡带呼吸动效 + 当前阶段角标），点击切换主视图；角色头像出现在对话流内每条消息旁，附模型徽标。

## 架构

### 数据层（主进程 → 渲染端）

事件协议 `electron/pipeline/agent-feed.ts` 小幅扩展（全部可选字段，向后兼容）：

```ts
export type AgentFeedStage = 'director' | 'sculpt' | 'mechqa' | 'review';

export interface AgentFeedEvent {
  // …现有字段不变…
  /** 结构化阶段（kind='phase' 时携带；text 仍是人读文案） */
  stage?: AgentFeedStage;
  /** 重试轮次（修复 N/M、回炉 N/M 等），从 1 起 */
  round?: number;
  /** 本角色会话使用的模型 id（导演/雕刻/审查会话创建时已知） */
  model?: string;
}
```

发射侧 `electron/pipeline/motion-agent-run.ts`：

- `setPhase(text)` 改为 `setPhase(text, stage?, round?)`，各调用点补结构化参数：
  - `导演`/`分镜重出…` → `stage:'director'`（重出带 round）
  - `雕刻`/`简化重写`/`兜底出卡` → `stage:'sculpt'`
  - `验证`/`修复 N/M` → `stage:'mechqa'`（修复带 round）
  - `审查`/`回炉 N/M` → `stage:'review'`（回炉带 round）
- `roleStream(role)` 增加 `model` 参数：director 会话传 `directorModel`、sculptor/reviewer 传 `sculptorModel`；为 `undefined`（回落 pi 默认）时事件不带 model，UI 显示「默认模型」。每条角色流事件都带 model（成本可忽略，避免状态机）。

### Store（`src/store/agent-feed.ts`）

`AgentFeedSession` 扩展：

```ts
interface AgentFeedSession {
  // …现有字段…
  currentStage?: AgentFeedStage;
  /** 各阶段状态：pending/active/done/error + 重试轮次 */
  stages: Record<AgentFeedStage, { status: StageStatus; round?: number }>;
  /** 角色 → 模型 id（来自事件 model 字段） */
  modelsByRole: Partial<Record<AgentFeedRole, string>>;
}
```

`reduceFeedEvent` 补规则：

- `phase` 事件带 `stage` 时：该 stage 置 active、其前置 stage 置 done、记录 round；`done` 事件把全部 active 置 done；`error` 事件把当前 stage 置 error。
- 每个 turn 记 `stage`（归属当时的 currentStage），供节点点击过滤/跳转。
- 事件带 `model` 时更新 `modelsByRole`。
- 不带 `stage` 的旧 phase 事件按现状仅生成文案 turn（兼容）。

新增全局派生：`useAgentFeedStore` 增加 `focusRequest`（feedId+cardKey 或 null），供状态栏/任务行入口聚焦到 Inspector 视图。

### UI 层

新目录 `src/components/agent-feed/`：

- **`AgentFeedView.tsx`** — 共享主视图（从现 `AgentObservationPanel` 抽取重构）：
  - 左侧窄轨：卡片会话头像列（首字/序号圆形，活跃呼吸动效，角标 = 当前阶段图标，error 红点）；
  - 顶部：`StagePipeline`；
  - 主体：对话流（复用 `renderBlocks`），每个 turn 前缀角色头像 + 角色名 + 模型徽标（`Badge`）；
  - 底部吸附滚动沿用现 pinned 模式。
- **`StagePipeline.tsx`** — 垂直/横向自适应节点条：四节点 + 连线，状态色（pending 灰/active 蓝呼吸/done 绿/error 红），重试轮次角标（如 ↻2）；点击节点滚动到该阶段第一个 turn 并高亮过滤。
- **`RoleAvatar.tsx`** — 极简角色头像（无现成 Avatar 原语，自建）：角色色 + 图标（导演🎬雕刻/审查等用 lucide 图标），尺寸两档。

接入点：

- `src/components/EditorInspector.tsx`：`InspectorSelection` 增 `{ type: 'agent-feed' }`，渲染 `AgentFeedView`。
- `src/pages/Editor.tsx`：
  - 订阅 `useAgentFeedStore.hasActive`：从 false→true 时自动 `setInspectorSelection({type:'agent-feed'})`（仅当当前非用户手动锁定的其他检查器？KISS：直接切入，用户可切走，本轮生成内不再反复抢占——用 feedId 记忆已抢占过）。
  - Inspector 顶部提供返回/关闭沿用现有模式。
- `src/components/AppStatusBar.tsx` / `TaskProgressPanel.tsx`：编辑器页时入口改为发 `focusRequest`（Editor 订阅后切 Inspector）；非编辑器页保留现浮层 `AgentObservationPanel`（内部改用共享 `AgentFeedView`，删重复实现）。

### 错误与边界

- 事件缺 `stage`/`model`（旧版本主进程或第三方 emit）：管线仅显示已知阶段，模型徽标显示「默认模型」或省略。
- 会话超 50 / turn 超 120 截断行为不变。
- 生成 error：管线节点红 + 会话头像红点；对话流已有 error turn。
- 项目切换 `clearAll()` 时若 Inspector 停在 agent-feed 视图，回落 `{type:'empty'}`。

## 测试

- `tests/agent-feed-emitter.test.ts`：新字段透传（stage/round/model 不被合并逻辑丢弃）。
- `tests/agent-feed-store.test.ts`：stage 状态机（phase→active/done、error、round、modelsByRole、turn.stage 归属）。
- `tests/motion-agent-run.test.ts`：断言各 setPhase 调用带正确 stage/round，roleStream 事件带 model。
- 新增 `tests/agent-feed-view.test.tsx`（或并入现组件测试）：StagePipeline 状态渲染、点击过滤、模型徽标回落文案。
- Inspector 接入：Editor 自动切入逻辑的最小单测（store 驱动）。

## 明确不做（YAGNI）

- 不引入 react-flow / 画布节点图。
- 不做历史回放持久化（会话仍是内存态，切项目即清）。
- 不改 pipeline 编排与重试逻辑本身。
- 不新增独立第四栏布局。
