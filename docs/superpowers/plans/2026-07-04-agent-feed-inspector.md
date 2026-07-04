# Agent 观测面板右侧常驻 + 阶段管线 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 AI 卡片多 agent 生成观测面板从状态栏浮层升级为编辑器右侧 Inspector 常驻视图，顶部阶段管线（导演→雕刻→质检→审查）+ 卡片头像轨 + 每条消息的角色头像与模型徽标。

**Architecture:** 事件协议（`agent-feed:event`）加三个可选字段 `stage/round/model`（向后兼容）；渲染端 store 增加阶段状态机与角色模型表；共享视图组件 `AgentFeedView` 同时供右侧 Inspector（编辑器内）与状态栏浮层（编辑器外）使用；`openPanel` 按 `dockMounted` 自动路由到 Inspector 或浮层。

**Tech Stack:** Electron IPC（现有通道，无新 IPC）、Zustand、React 19、CSS Modules、lucide-react、Vitest（node 环境 + `renderToStaticMarkup`）。

**Spec:** `docs/superpowers/specs/2026-07-04-agent-feed-inspector-design.md`

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `electron/pipeline/agent-feed.ts` | 修改 | 事件协议：`AgentFeedStage` 类型 + `stage/round/model` 可选字段 |
| `electron/pipeline/motion-agent-run.ts` | 修改 | `setPhase` 带结构化阶段、`roleStream` 带模型 |
| `src/store/agent-feed.ts` | 修改 | 阶段状态机、`modelsByRole`、`turnStages`、dock 路由 |
| `src/components/agent-feed/agent-feed.module.css` | 新建 | 该目录组件共享样式 |
| `src/components/agent-feed/RoleAvatar.tsx` | 新建 | 角色头像（无现成 Avatar 原语） |
| `src/components/agent-feed/StagePipeline.tsx` | 新建 | 四阶段节点管线（含重试角标、点击跳转） |
| `src/components/agent-feed/AgentFeedView.tsx` | 新建 | 共享主视图：卡片轨 + 管线 + 对话流 |
| `src/components/AgentObservationPanel.tsx` | 修改 | 浮层壳保留，body 换成 `AgentFeedView` |
| `src/components/EditorInspector.tsx` | 修改 | `InspectorSelection` 新增 `agent-feed` 类型 |
| `src/pages/Editor.tsx` | 修改 | dockMounted 注册、focusToken 响应、生成自动切入、清空回退 |
| `tests/agent-feed-emitter.test.ts` | 修改 | 新字段透传 |
| `tests/agent-feed-store.test.ts` | 修改 | 阶段状态机 / 模型表 / dock 路由 |
| `tests/motion-agent-run.test.ts` | 修改 | phase 事件带 stage/round、角色事件带 model |
| `tests/agent-feed-view.test.tsx` | 新建 | StagePipeline / AgentFeedView 渲染测试 |

不改：`electron/preload.ts`、`src/lib/electron-api.ts`（通道与类型引用不变，可选字段自动流过）；`AppStatusBar.tsx` / `TaskProgressPanel.tsx`（入口继续调 `openPanel`，由 store 路由）。

---

### Task 1: 事件协议扩展（stage/round/model 透传）

**Files:**
- Modify: `electron/pipeline/agent-feed.ts`
- Test: `tests/agent-feed-emitter.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `tests/agent-feed-emitter.test.ts` 末尾追加（沿用文件里已有的 emitter 构造方式；若已有 `makeEmitter`/fake send 辅助则复用，没有则用下面自带的）：

```ts
describe('stage/round/model 字段透传', () => {
  it('phase 事件立即发送并携带 stage/round；text 合并后保留 model', () => {
    const sent: any[] = [];
    const timers: Array<() => void> = [];
    const emitter = createAgentFeedEmitter({
      send: (_ch, payload) => sent.push(payload),
      feedId: 'task-1',
      setTimeoutFn: (h) => { timers.push(h); return 0 as any; },
      clearTimeoutFn: () => {},
      now: () => 1000,
    });
    emitter.emit({ cardKey: 'seg-1', role: 'director', kind: 'text', text: 'a', model: 'openai/gpt-x' });
    emitter.emit({ cardKey: 'seg-1', role: 'director', kind: 'text', text: 'b', model: 'openai/gpt-x' });
    emitter.emit({ cardKey: 'seg-1', role: 'orchestrator', kind: 'phase', text: '修复 1/3', stage: 'mechqa', round: 1 });
    // phase 非增量：先冲刷缓冲再发送，顺序 = [合并后的 text, phase]
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ kind: 'text', text: 'ab', model: 'openai/gpt-x' });
    expect(sent[1]).toMatchObject({ kind: 'phase', text: '修复 1/3', stage: 'mechqa', round: 1 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent-feed-emitter.test.ts`
Expected: FAIL —— TS 报 `model`/`stage`/`round` 不在 `AgentFeedEmitInput` 上（类型错误即视为失败）。

- [ ] **Step 3: 实现** — `electron/pipeline/agent-feed.ts`：在 `AgentFeedRole` 定义后新增类型，并给 `AgentFeedEvent` 追加字段：

```ts
/** 结构化阶段（渲染端阶段管线用）：导演 / 雕刻 / 机械质检 / 审查。 */
export type AgentFeedStage = 'director' | 'sculpt' | 'mechqa' | 'review';
```

`AgentFeedEvent` 接口 `isError?: boolean;` 之后追加：

```ts
  /** 结构化阶段（kind='phase' 时携带；text 仍是人读文案）。 */
  stage?: AgentFeedStage;
  /** 重试轮次（分镜重出 / 修复 / 回炉），从 1 起。 */
  round?: number;
  /** 本角色会话使用的模型引用（`providerId/modelId`）；缺省 = pi 默认。 */
  model?: string;
```

emitter 本身无需改动（合并走 `{ ...ev }`、直发走展开，新字段自动透传）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/agent-feed-emitter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/pipeline/agent-feed.ts tests/agent-feed-emitter.test.ts
git commit -m "feat(agent-feed): 事件协议增加 stage/round/model 可选字段"
```

---

### Task 2: motion-agent-run 发射结构化阶段与模型

**Files:**
- Modify: `electron/pipeline/motion-agent-run.ts`
- Test: `tests/motion-agent-run.test.ts`

- [ ] **Step 1: 写失败测试** — `tests/motion-agent-run.test.ts` 末尾追加一个 describe（自带 deps，模拟每个会话吐一条 text_delta 以验证 model 透传；`providerWith`/`STORYBOARD`/`VALID_TSX`/`writeTsx`/`makeCtx` 均为该文件已有辅助）：

```ts
describe('观测事件：结构化 stage/round 与模型标注', () => {
  it('phase 事件带 stage，角色流事件带 model', async () => {
    const feed: Array<Record<string, unknown>> = [];
    const { provider } = providerWith(
      {
        reply: async (role, _text, cwd) => {
          if (role === '导演') return STORYBOARD;
          if (role === '雕刻') { await writeTsx(cwd); return 'ok'; }
          return '{"pass": true, "issues": []}';
        },
      },
      {
        onAgentEvent: (ev: Record<string, unknown>) => feed.push(ev),
        directorModel: 'prov/dir-model',
        sculptorModel: 'prov/sculpt-model',
      },
    );
    await provider(makeCtx());

    const phases = feed.filter((e) => e.kind === 'phase').map((e) => [e.text, e.stage]);
    expect(phases).toEqual([
      ['导演', 'director'],
      ['雕刻', 'sculpt'],
      ['验证', 'mechqa'],
      ['审查', 'review'],
    ]);
    expect(phases.every(([, stage]) => stage != null)).toBe(true);
  });

  it('修复/回炉等重试 phase 带 round', async () => {
    const feedRounds: Array<Record<string, unknown>> = [];
    let sculptTurn = 0;
    const { provider } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          sculptTurn += 1;
          // 第一轮写坏卡（缺 export default），第二轮修好 → 触发一次 修复 1/3
          await writeTsx(cwd, sculptTurn === 1 ? 'const x = 1;' : VALID_TSX);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    }, { onAgentEvent: (ev: Record<string, unknown>) => feedRounds.push(ev) });
    await provider(makeCtx());
    const fix = feedRounds.find((e) => e.kind === 'phase' && String(e.text).startsWith('修复'));
    expect(fix).toMatchObject({ stage: 'mechqa', round: 1 });
  });

  it('角色流事件携带各自会话的 model', async () => {
    const feed: Array<Record<string, unknown>> = [];
    const prompts: string[] = [];
    const deps = {
      createSession: async (input: { systemPrompt: string; cwd: string; model?: string; onEvent?: (ev: unknown) => void }) => ({
        prompt: async (text: string) => {
          prompts.push(text);
          input.onEvent?.({ type: 'text_delta', delta: 'x' });
          if (input.systemPrompt === '导演') return STORYBOARD;
          if (input.systemPrompt === '雕刻') { await writeTsx(input.cwd); return 'ok'; }
          return '{"pass": true, "issues": []}';
        },
        dispose: () => {},
        abort: () => {},
      }),
      loadRole: async (name: string) => ({ 'card-director': { name, version: '2', tools: [], systemPrompt: '导演' }, 'card-sculptor': { name, version: '2', tools: ['read', 'write', 'edit'], systemPrompt: '雕刻' }, 'card-reviewer': { name, version: '3', tools: [], systemPrompt: '审查' } } as Record<string, unknown>)[name],
      ensureConfig: async () => undefined,
      ensureRoles: async () => undefined,
    };
    const provider = createMotionCardAgentProvider({
      userDataPath: '/tmp/user-data',
      projectPath: '/tmp/project',
      rolesSeedDir: '/tmp/seed',
      directorModel: 'prov/dir-model',
      sculptorModel: 'prov/sculpt-model',
      onAgentEvent: (ev) => feed.push(ev as Record<string, unknown>),
      deps: deps as never,
    });
    await provider(makeCtx());
    const byRole = (role: string) => feed.filter((e) => e.role === role && e.kind === 'text');
    expect(byRole('director')[0]).toMatchObject({ model: 'prov/dir-model' });
    expect(byRole('sculptor')[0]).toMatchObject({ model: 'prov/sculpt-model' });
    expect(byRole('reviewer')[0]).toMatchObject({ model: 'prov/sculpt-model' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/motion-agent-run.test.ts`
Expected: FAIL —— phase 事件无 `stage` 字段、text 事件无 `model` 字段。

- [ ] **Step 3: 实现** — `electron/pipeline/motion-agent-run.ts`：

3a. 从 `./agent-feed` 的类型导入里补 `AgentFeedStage`（该文件已导入 `AgentFeedEmitInput`、`AgentFeedRole`，在同一 import 加）。

3b. `roleStream` 增加 `model` 参数并附到每条事件（`electron/pipeline/motion-agent-run.ts:166-192`）：

```ts
    const roleStream = (role: AgentFeedRole, model?: string): Pick<PiHeadlessCreateInput, 'onEvent'> =>
      feedEmit
        ? {
            onEvent: (ev: PiHeadlessStreamEvent) => {
              if (ev.type === 'text_delta') feedEmit({ role, kind: 'text', text: ev.delta, model });
              else if (ev.type === 'thinking_delta') feedEmit({ role, kind: 'thinking', text: ev.delta, model });
              else if (ev.type === 'tool_use') {
                feedEmit({
                  role,
                  kind: 'tool_use',
                  toolCallId: ev.id,
                  toolName: ev.name,
                  toolInput: safeStringify(ev.input),
                  model,
                });
              } else {
                feedEmit({
                  role,
                  kind: 'tool_result',
                  toolCallId: ev.toolUseId,
                  toolName: ev.name,
                  toolOutput: ev.content,
                  isError: ev.isError,
                  model,
                });
              }
            },
          }
        : {};
```

3c. `setPhase` 增加结构化参数（`electron/pipeline/motion-agent-run.ts:195-199`）：

```ts
    const setPhase = (phase: string, stage?: AgentFeedStage, round?: number) => {
      phaseStartedAt = Date.now();
      onPhase?.(phase);
      feedEmit?.({ role: 'orchestrator', kind: 'phase', text: phase, stage, round });
    };
```

3d. 逐个调用点补参（行号为当前版本参考）：

| 行 | 原调用 | 改为 |
|---|---|---|
| 227 | `setPhase('导演')` | `setPhase('导演', 'director')` |
| 235 | `...roleStream('director')` | `...roleStream('director', directorModel)` |
| 282 | `setPhase(\`分镜重出（解析失败 ${parseRounds}/${MAX_STORYBOARD_PARSE_RETRY}）\`)` | 追加 `, 'director', parseRounds` |
| 305 | `setPhase(\`分镜重出 ${semanticRounds}/${MAX_STORYBOARD_ITER}\`)` | 追加 `, 'director', semanticRounds` |
| 325 | `setPhase('雕刻')` | `setPhase('雕刻', 'sculpt')` |
| 334 | `...roleStream('sculptor')` | `...roleStream('sculptor', sculptorModel)` |
| 393 | `setPhase('验证')` | `setPhase('验证', 'mechqa')` |
| 413 | `setPhase('简化重写')` | `setPhase('简化重写', 'sculpt')` |
| 427 | `setPhase('兜底出卡')` | `setPhase('兜底出卡', 'sculpt')` |
| 432 | `setPhase(\`修复 ${fixIter}/${MAX_FIX_ITER}\`)` | 追加 `, 'mechqa', fixIter` |
| 447 | `setPhase('审查')` | `setPhase('审查', 'review')` |
| 454 | `...roleStream('reviewer')` | `...roleStream('reviewer', sculptorModel)` |
| 482 | `setPhase(\`回炉 ${reviewIter}/${MAX_REVIEW_ITER}\`)` | 追加 `, 'sculpt', reviewIter` |

（回炉是雕刻返工，映射到 `sculpt`；管线状态机会把 mechqa/review 回退 pending，与真实流程一致。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/motion-agent-run.test.ts tests/agent-feed-emitter.test.ts`
Expected: PASS（含既有用例——`onPhase` 回调文案未动，不应破坏现有断言）

- [ ] **Step 5: Commit**

```bash
git add electron/pipeline/motion-agent-run.ts tests/motion-agent-run.test.ts
git commit -m "feat(agent-feed): 编排发射结构化阶段(stage/round)与角色模型"
```

---

### Task 3: store 阶段状态机 + 模型表 + turn 阶段标注

**Files:**
- Modify: `src/store/agent-feed.ts`
- Test: `tests/agent-feed-store.test.ts`

- [ ] **Step 1: 写失败测试** — `tests/agent-feed-store.test.ts` 追加（`ev`/`reduceAll` 为文件已有辅助）：

```ts
describe('阶段状态机与模型标注', () => {
  it('phase(stage) 推进管线：前置 done、当前 active、后续 pending', () => {
    const s = reduceAll([
      ev({ role: 'orchestrator', kind: 'phase', text: '导演', stage: 'director' }),
      ev({ role: 'orchestrator', kind: 'phase', text: '雕刻', stage: 'sculpt' }),
      ev({ role: 'orchestrator', kind: 'phase', text: '验证', stage: 'mechqa' }),
    ]);
    expect(s.currentStage).toBe('mechqa');
    expect(s.stages.director.status).toBe('done');
    expect(s.stages.sculpt.status).toBe('done');
    expect(s.stages.mechqa.status).toBe('active');
    expect(s.stages.review.status).toBe('pending');
  });

  it('回炉（review 后回到 sculpt）把下游阶段回退 pending 并记录轮次', () => {
    const s = reduceAll([
      ev({ role: 'orchestrator', kind: 'phase', text: '审查', stage: 'review' }),
      ev({ role: 'orchestrator', kind: 'phase', text: '回炉 1/2', stage: 'sculpt', round: 1 }),
    ]);
    expect(s.stages.sculpt).toEqual({ status: 'active', round: 1 });
    expect(s.stages.mechqa.status).toBe('pending');
    expect(s.stages.review.status).toBe('pending');
  });

  it('done 把 active 阶段收为 done；error 把当前阶段标红', () => {
    const done = reduceAll([
      ev({ role: 'orchestrator', kind: 'phase', text: '审查', stage: 'review' }),
      ev({ role: 'orchestrator', kind: 'done', text: '生成完成' }),
    ]);
    expect(done.stages.review.status).toBe('done');

    const err = reduceAll([
      ev({ role: 'orchestrator', kind: 'phase', text: '雕刻', stage: 'sculpt' }),
      ev({ role: 'orchestrator', kind: 'error', text: '失败' }),
    ]);
    expect(err.stages.sculpt.status).toBe('error');
  });

  it('无 stage 的旧 phase 事件不影响管线（向后兼容）', () => {
    const s = reduceAll([ev({ role: 'orchestrator', kind: 'phase', text: '导演' })]);
    expect(s.currentStage).toBeUndefined();
    expect(s.stages.director.status).toBe('pending');
  });

  it('事件 model 记入 modelsByRole；turn 按创建时阶段标注', () => {
    const s = reduceAll([
      ev({ role: 'orchestrator', kind: 'phase', text: '导演', stage: 'director' }),
      ev({ role: 'director', kind: 'text', text: '分镜', model: 'prov/dir-model' }),
      ev({ role: 'orchestrator', kind: 'phase', text: '雕刻', stage: 'sculpt' }),
      ev({ role: 'sculptor', kind: 'text', text: '写组件', model: 'prov/sculpt-model' }),
    ]);
    expect(s.modelsByRole).toEqual({ director: 'prov/dir-model', sculptor: 'prov/sculpt-model' });
    const directorTurn = s.turns.find((t) => t.agentId === 'director')!;
    const sculptorTurn = s.turns.find((t) => t.agentId === 'sculptor')!;
    expect(s.turnStages[String(directorTurn.id)]).toBe('director');
    expect(s.turnStages[String(sculptorTurn.id)]).toBe('sculpt');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent-feed-store.test.ts`
Expected: FAIL —— `stages`/`modelsByRole`/`turnStages`/`currentStage` 不存在。

- [ ] **Step 3: 实现** — `src/store/agent-feed.ts`：

3a. 类型导入与再导出（文件头部）：

```ts
import type { AgentFeedEvent, AgentFeedRole, AgentFeedStage } from '../../electron/pipeline/agent-feed';

export type { AgentFeedEvent, AgentFeedRole, AgentFeedStage };
```

3b. 阶段常量与状态类型（`ROLE_NAMES` 附近）：

```ts
export type StageStatus = 'pending' | 'active' | 'done' | 'error';
export interface StageState {
  status: StageStatus;
  /** 该阶段最近一次重试轮次（分镜重出 / 修复 / 回炉）。 */
  round?: number;
}

export const STAGE_ORDER: readonly AgentFeedStage[] = ['director', 'sculpt', 'mechqa', 'review'];
export const STAGE_NAMES: Record<AgentFeedStage, string> = {
  director: '导演',
  sculpt: '雕刻',
  mechqa: '质检',
  review: '审查',
};

function initialStages(): Record<AgentFeedStage, StageState> {
  return {
    director: { status: 'pending' },
    sculpt: { status: 'pending' },
    mechqa: { status: 'pending' },
    review: { status: 'pending' },
  };
}
```

3c. `AgentFeedSession` 追加字段（`lastSeq: number;` 之后）：

```ts
  /** 阶段管线状态（由带 stage 的 phase 事件驱动）。 */
  stages: Record<AgentFeedStage, StageState>;
  currentStage?: AgentFeedStage;
  /** 角色 → 模型引用（providerId/modelId），来自事件 model 字段。 */
  modelsByRole: Partial<Record<AgentFeedRole, string>>;
  /** turn.id → 创建该 turn 时所处阶段（管线节点点击跳转用）。 */
  turnStages: Record<string, AgentFeedStage>;
```

3d. `reduceFeedEvent` 改造：

- `base` 初始化补 `stages: initialStages(), modelsByRole: {}, turnStages: {}`（`lastSeq: 0,` 之后）。
- 在取 turn 之前（`const turns = base.turns.slice();` 之前）插入阶段/模型推导：

```ts
  let stages = base.stages;
  let currentStage = base.currentStage;
  let modelsByRole = base.modelsByRole;
  let turnStages = base.turnStages;

  if (ev.model && modelsByRole[ev.role] !== ev.model) {
    modelsByRole = { ...modelsByRole, [ev.role]: ev.model };
  }
  if (ev.kind === 'phase' && ev.stage) {
    const target = STAGE_ORDER.indexOf(ev.stage);
    const next = { ...stages };
    STAGE_ORDER.forEach((s, i) => {
      if (i < target) {
        if (next[s].status !== 'done') next[s] = { ...next[s], status: 'done' };
      } else if (i === target) {
        next[s] = { status: 'active', round: ev.round };
      } else if (next[s].status !== 'pending') {
        // 回炉等回跳：下游阶段回退待办，如实反映重走
        next[s] = { status: 'pending' };
      }
    });
    stages = next;
    currentStage = ev.stage;
  } else if (ev.kind === 'done') {
    const next = { ...stages };
    for (const s of STAGE_ORDER) {
      if (next[s].status === 'active') next[s] = { ...next[s], status: 'done' };
    }
    stages = next;
  } else if (ev.kind === 'error') {
    if (currentStage && stages[currentStage].status === 'active') {
      stages = { ...stages, [currentStage]: { ...stages[currentStage], status: 'error' } };
    }
  }
```

- 新 turn 创建分支（`turns.push(turn);` 之前）补阶段标注：

```ts
    if (currentStage) turnStages = { ...turnStages, [String(turn.id)]: currentStage };
```

- turn 截断处同步清理（替换现有 `if (turns.length > MAX_TURNS_PER_SESSION) {...}` 块）：

```ts
  if (turns.length > MAX_TURNS_PER_SESSION) {
    const removed = turns.splice(0, turns.length - MAX_TURNS_PER_SESSION);
    if (removed.some((t) => turnStages[String(t.id)] !== undefined)) {
      turnStages = { ...turnStages };
      for (const t of removed) delete turnStages[String(t.id)];
    }
  }
```

- 返回值补新字段：

```ts
  return { ...base, turns, status, updatedAt: ev.ts, lastSeq: ev.seq, stages, currentStage, modelsByRole, turnStages };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/agent-feed-store.test.ts`
Expected: PASS（含既有用例）

- [ ] **Step 5: Commit**

```bash
git add src/store/agent-feed.ts tests/agent-feed-store.test.ts
git commit -m "feat(agent-feed): store 阶段状态机 + 角色模型表 + turn 阶段标注"
```

---

### Task 4: store dock 路由（openPanel 进 Inspector 或浮层）

**Files:**
- Modify: `src/store/agent-feed.ts`
- Test: `tests/agent-feed-store.test.ts`

- [ ] **Step 1: 写失败测试** — `tests/agent-feed-store.test.ts` 追加（需要在 import 中补 `useAgentFeedStore`）：

```ts
describe('dock 路由', () => {
  it('dockMounted=false 时 openPanel 打开浮层；true 时改发 focusToken 不开浮层', () => {
    const store = useAgentFeedStore;
    store.getState().clearAll();
    store.getState().setDockMounted(false);
    store.getState().applyEvent(ev({ role: 'director', kind: 'text', text: 'x' }));

    store.getState().openPanel('task-1');
    expect(store.getState().panelOpen).toBe(true);
    expect(store.getState().selectedKey).toBe('task-1::seg-1');

    store.getState().closePanel();
    const tokenBefore = store.getState().focusToken;
    store.getState().setDockMounted(true);
    store.getState().openPanel('task-1');
    expect(store.getState().panelOpen).toBe(false);
    expect(store.getState().focusToken).toBe(tokenBefore + 1);

    store.getState().setDockMounted(false);
    store.getState().clearAll();
  });

  it('setDockMounted(true) 收起已打开的浮层', () => {
    const store = useAgentFeedStore;
    store.getState().applyEvent(ev({ role: 'director', kind: 'text', text: 'x' }));
    store.getState().openPanel();
    expect(store.getState().panelOpen).toBe(true);
    store.getState().setDockMounted(true);
    expect(store.getState().panelOpen).toBe(false);
    store.getState().setDockMounted(false);
    store.getState().clearAll();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent-feed-store.test.ts`
Expected: FAIL —— `setDockMounted`/`focusToken` 不存在。

- [ ] **Step 3: 实现** — `src/store/agent-feed.ts` 的 `AgentFeedStore` 接口与实现：

接口追加：

```ts
  /** 编辑器右侧观测视图是否在场（在场时 openPanel 路由到 Inspector 而非浮层）。 */
  dockMounted: boolean;
  /** 单调计数：每次 +1 表示"请编辑器把 Inspector 切到观测视图"。 */
  focusToken: number;
  setDockMounted: (mounted: boolean) => void;
```

实现（`create` 初始值补 `dockMounted: false, focusToken: 0,`；`openPanel` 整体替换为）：

```ts
  openPanel: (feedId) => {
    const { sessions, selectedKey, dockMounted, focusToken } = get();
    let nextSelected = selectedKey;
    if (feedId) {
      const list = sessionsForFeed(sessions, feedId);
      if (list.length > 0) {
        nextSelected = list.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).key;
      }
    }
    if (!nextSelected || !sessions.has(nextSelected)) {
      let latest: AgentFeedSession | null = null;
      for (const s of sessions.values()) {
        if (!latest || s.updatedAt > latest.updatedAt) latest = s;
      }
      nextSelected = latest?.key ?? null;
    }
    if (dockMounted) {
      set({ selectedKey: nextSelected, focusToken: focusToken + 1 });
    } else {
      set({ panelOpen: true, selectedKey: nextSelected });
    }
  },

  setDockMounted: (mounted) => set(mounted ? { dockMounted: true, panelOpen: false } : { dockMounted: false }),
```

`clearAll` 不动（`focusToken` 保持单调，避免误触发）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/agent-feed-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/agent-feed.ts tests/agent-feed-store.test.ts
git commit -m "feat(agent-feed): openPanel 按 dockMounted 路由到 Inspector/浮层"
```

---

### Task 5: UI 组件（RoleAvatar / StagePipeline / AgentFeedView）

**Files:**
- Create: `src/components/agent-feed/agent-feed.module.css`
- Create: `src/components/agent-feed/RoleAvatar.tsx`
- Create: `src/components/agent-feed/StagePipeline.tsx`
- Create: `src/components/agent-feed/AgentFeedView.tsx`
- Test: `tests/agent-feed-view.test.tsx`

- [ ] **Step 1: 写失败测试** — 新建 `tests/agent-feed-view.test.tsx`（node 环境 + `renderToStaticMarkup`，与 `tests/ai-card-inspector.test.tsx` 同模式）：

```tsx
import { describe, expect, it, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StagePipeline } from '../src/components/agent-feed/StagePipeline';
import { AgentFeedView } from '../src/components/agent-feed/AgentFeedView';
import { useAgentFeedStore, type AgentFeedEvent } from '../src/store/agent-feed';

let seq = 0;
function ev(partial: Partial<AgentFeedEvent> & Pick<AgentFeedEvent, 'kind' | 'role'>): AgentFeedEvent {
  seq += 1;
  return { feedId: 'task-1', cardKey: 'seg-1', cardLabel: '开场钩子', seq, ts: 1000 + seq, ...partial };
}

beforeEach(() => {
  useAgentFeedStore.getState().clearAll();
  seq = 0;
});

describe('StagePipeline', () => {
  it('渲染四个阶段节点、状态与重试角标', () => {
    const html = renderToStaticMarkup(
      <StagePipeline
        stages={{
          director: { status: 'done' },
          sculpt: { status: 'active', round: 2 },
          mechqa: { status: 'pending' },
          review: { status: 'pending' },
        }}
      />,
    );
    expect(html).toContain('导演');
    expect(html).toContain('雕刻');
    expect(html).toContain('质检');
    expect(html).toContain('审查');
    expect(html).toContain('data-status="active"');
    expect(html).toContain('↻2');
  });
});

describe('AgentFeedView', () => {
  it('无会话时渲染空态', () => {
    expect(renderToStaticMarkup(<AgentFeedView />)).toContain('暂无生成过程');
  });

  it('渲染卡片会话：角色名、模型徽标与阶段标注；无 model 时回落"默认模型"', () => {
    const apply = useAgentFeedStore.getState().applyEvent;
    apply(ev({ role: 'orchestrator', kind: 'phase', text: '导演', stage: 'director' }));
    apply(ev({ role: 'director', kind: 'text', text: '分镜设计', model: 'prov/dir-model' }));
    apply(ev({ role: 'orchestrator', kind: 'phase', text: '雕刻', stage: 'sculpt' }));
    apply(ev({ role: 'sculptor', kind: 'text', text: '写组件' })); // 无 model → 默认模型
    const html = renderToStaticMarkup(<AgentFeedView />);
    expect(html).toContain('开场钩子');
    expect(html).toContain('导演');
    expect(html).toContain('dir-model'); // 模型徽标显示短名
    expect(html).toContain('默认模型');
    expect(html).toContain('data-stage="director"');
    expect(html).toContain('data-stage="sculpt"');
  });

  it('多卡会话渲染卡片轨（每卡一个头像）', () => {
    const apply = useAgentFeedStore.getState().applyEvent;
    apply(ev({ role: 'director', kind: 'text', text: 'a', cardKey: 'seg-1', cardLabel: '卡一' }));
    apply(ev({ role: 'director', kind: 'text', text: 'b', cardKey: 'seg-2', cardLabel: '卡二' }));
    const html = renderToStaticMarkup(<AgentFeedView />);
    expect(html).toContain('卡一');
    expect(html).toContain('卡二');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent-feed-view.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现四个文件**

`src/components/agent-feed/agent-feed.module.css`：

```css
/* agent-feed 观测视图（Inspector 停靠与状态栏浮层共用） */

.view {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  text-align: center;
  color: var(--color-text-tertiary);
  font-size: var(--font-size-sm);
}

/* ── 卡片轨（多卡并行时的左侧头像列） ── */
.cardRail {
  width: 44px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-separator);
  overflow-y: auto;
  padding: 8px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.cardAvatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid transparent;
  background: color-mix(in srgb, var(--color-text-primary) 8%, transparent);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
}

.cardAvatar[data-status='active'] {
  border-color: var(--color-system-blue, #0a84ff);
  animation: feedPulse 1.4s ease-in-out infinite;
}

.cardAvatar[data-status='done'] {
  border-color: var(--color-success, #32d74b);
}

.cardAvatar[data-status='error'] {
  border-color: var(--color-danger, #ff453a);
}

.cardAvatarSelected {
  background: color-mix(in srgb, var(--color-system-blue) 22%, transparent);
  color: var(--color-text-primary);
}

@keyframes feedPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* ── 会话主视图 ── */
.sessionView {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.sessionHead {
  padding: 8px 12px 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}

/* ── 阶段管线 ── */
.pipeline {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-separator);
  flex-shrink: 0;
  overflow-x: auto;
}

.pipelineNode {
  display: flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: none;
  padding: 3px 6px;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  cursor: pointer;
  white-space: nowrap;
}

.pipelineNode:hover {
  background: color-mix(in srgb, var(--color-text-primary) 6%, transparent);
}

.pipelineNode[data-status='active'] {
  color: var(--color-text-primary);
  font-weight: 600;
}

.pipelineNode[data-status='done'] {
  color: var(--color-text-secondary);
}

.pipelineNode[data-status='error'] {
  color: var(--color-danger, #ff453a);
}

.pipelineDot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--color-text-tertiary) 45%, transparent);
  flex-shrink: 0;
}

.pipelineDot[data-status='active'] {
  background: var(--color-system-blue, #0a84ff);
  animation: feedPulse 1.4s ease-in-out infinite;
}

.pipelineDot[data-status='done'] {
  background: var(--color-success, #32d74b);
}

.pipelineDot[data-status='error'] {
  background: var(--color-danger, #ff453a);
}

.pipelineRound {
  font-size: 10px;
  color: var(--color-system-blue, #0a84ff);
}

.pipelineLink {
  width: 12px;
  height: 1px;
  background: var(--color-separator);
  flex-shrink: 0;
}

/* ── 对话流 ── */
.messages {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.turnCaption {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-text-tertiary);
  margin-bottom: 4px;
}

.roleAvatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  flex-shrink: 0;
  background: color-mix(in srgb, var(--color-system-blue) 16%, transparent);
  color: var(--color-system-blue, #0a84ff);
}

.roleAvatar[data-role='orchestrator'] {
  background: color-mix(in srgb, var(--color-text-tertiary) 16%, transparent);
  color: var(--color-text-tertiary);
}

.roleAvatar[data-role='sculptor'] {
  background: color-mix(in srgb, #bf5af2 18%, transparent);
  color: #bf5af2;
}

.roleAvatar[data-role='reviewer'] {
  background: color-mix(in srgb, var(--color-success, #32d74b) 18%, transparent);
  color: var(--color-success, #32d74b);
}

.modelBadge {
  font-weight: 500;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-text-primary) 7%, transparent);
  color: var(--color-text-tertiary);
  line-height: 16px;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

`src/components/agent-feed/RoleAvatar.tsx`：

```tsx
import { Clapperboard, Hammer, ShieldCheck, Workflow, type LucideIcon } from 'lucide-react';
import type { AgentFeedRole } from '../../store/agent-feed';
import styles from './agent-feed.module.css';

const ROLE_ICONS: Record<AgentFeedRole, LucideIcon> = {
  director: Clapperboard,
  sculptor: Hammer,
  reviewer: ShieldCheck,
  orchestrator: Workflow,
};

export function RoleAvatar({ role, size = 18 }: { role: AgentFeedRole; size?: number }) {
  const Icon = ROLE_ICONS[role] ?? Workflow;
  return (
    <span className={styles.roleAvatar} data-role={role} style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.62)} />
    </span>
  );
}
```

`src/components/agent-feed/StagePipeline.tsx`：

```tsx
import React from 'react';
import { STAGE_NAMES, STAGE_ORDER, type AgentFeedStage, type StageState } from '../../store/agent-feed';
import styles from './agent-feed.module.css';

interface StagePipelineProps {
  stages: Record<AgentFeedStage, StageState>;
  /** 点击节点跳转到该阶段第一条对话。 */
  onStageClick?: (stage: AgentFeedStage) => void;
}

export function StagePipeline({ stages, onStageClick }: StagePipelineProps) {
  return (
    <div className={styles.pipeline} aria-label="生成阶段">
      {STAGE_ORDER.map((stage, i) => {
        const st = stages[stage];
        return (
          <React.Fragment key={stage}>
            {i > 0 ? <span className={styles.pipelineLink} /> : null}
            <button
              type="button"
              className={styles.pipelineNode}
              data-status={st.status}
              title={`${STAGE_NAMES[stage]}${st.round ? `（第 ${st.round} 轮重试）` : ''}`}
              onClick={() => onStageClick?.(stage)}
            >
              <span className={styles.pipelineDot} data-status={st.status} />
              <span>{STAGE_NAMES[stage]}</span>
              {st.round ? <span className={styles.pipelineRound}>↻{st.round}</span> : null}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}
```

`src/components/agent-feed/AgentFeedView.tsx`：

```tsx
/**
 * AgentFeedView — AI 卡片多 agent 生成过程的共享观测视图。
 *
 * 编辑器右侧 Inspector（常驻停靠）与状态栏浮层（编辑器外）共用：
 * 左侧卡片轨（多卡并行时每卡一个头像，活跃呼吸）、顶部阶段管线
 * （导演→雕刻→质检→审查，点击跳转该阶段对话）、下方角色对话流
 * （角色头像 + 模型徽标，复用 renderBlocks）。
 */

import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { renderBlocks } from '../agent/AssistantMessage';
import {
  useAgentFeedStore,
  type AgentFeedRole,
  type AgentFeedSession,
  type AgentFeedStage,
} from '../../store/agent-feed';
import { RoleAvatar } from './RoleAvatar';
import { StagePipeline } from './StagePipeline';
import styles from './agent-feed.module.css';

function modelShortName(model: string | undefined): string {
  if (!model) return '默认模型';
  return model.split('/').pop() || model;
}

function SessionView({ session }: { session: AgentFeedSession }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  };

  // 流式更新贴底跟随；上滚后不强拉（与 MessageList 行为一致）。
  useLayoutEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session]);

  useEffect(() => {
    pinnedRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.key]);

  const scrollToStage = (stage: AgentFeedStage) => {
    const el = scrollRef.current?.querySelector(`[data-stage="${stage}"]`);
    if (el) {
      pinnedRef.current = false;
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  };

  const lastIndex = session.turns.length - 1;
  return (
    <div className={styles.sessionView}>
      <div className={styles.sessionHead} title={session.label}>
        {session.label}
      </div>
      <StagePipeline stages={session.stages} onStageClick={scrollToStage} />
      <div ref={scrollRef} onScroll={handleScroll} className={styles.messages}>
        {session.turns.map((turn, index) => {
          const role = (turn.agentId ?? 'orchestrator') as AgentFeedRole;
          const stage = session.turnStages[String(turn.id)];
          return (
            <div
              key={String(turn.id)}
              data-stage={stage}
              style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
            >
              <div className={styles.turnCaption}>
                <RoleAvatar role={role} />
                <span>{turn.agentName}</span>
                {role !== 'orchestrator' ? (
                  <span className={styles.modelBadge} title={session.modelsByRole[role]}>
                    {modelShortName(session.modelsByRole[role])}
                  </span>
                ) : null}
              </div>
              {renderBlocks(turn.blocks, {
                isLastAssistant: index === lastIndex,
                isStreaming: index === lastIndex && session.status === 'active',
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AgentFeedView() {
  const sessions = useAgentFeedStore((s) => s.sessions);
  const selectedKey = useAgentFeedStore((s) => s.selectedKey);
  const selectSession = useAgentFeedStore((s) => s.selectSession);

  const list = Array.from(sessions.values()).sort((a, b) => b.startedAt - a.startedAt);
  if (list.length === 0) {
    return <div className={styles.empty}>暂无生成过程：卡片生成开始后这里会实时显示各 agent 的对话与阶段进展。</div>;
  }
  const selected = (selectedKey && sessions.get(selectedKey)) || list[0];

  return (
    <div className={styles.view}>
      {list.length > 1 ? (
        <div className={styles.cardRail}>
          {list.map((session) => (
            <button
              key={session.key}
              type="button"
              className={`${styles.cardAvatar} ${
                selected.key === session.key ? styles.cardAvatarSelected : ''
              }`}
              data-status={session.status}
              title={session.label}
              onClick={() => selectSession(session.key)}
            >
              {session.label.slice(0, 1)}
            </button>
          ))}
        </div>
      ) : null}
      <SessionView session={selected} />
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/agent-feed-view.test.tsx`
Expected: PASS。若空态用例因 `title` 属性等细节文案失败，按实际渲染修断言而非改组件语义。

（注意多卡用例断言 `卡一`/`卡二` 来自头像 `title` 与选中会话 `sessionHead`；`renderToStaticMarkup` 会输出 title 属性，成立。）

- [ ] **Step 5: Commit**

```bash
git add src/components/agent-feed tests/agent-feed-view.test.tsx
git commit -m "feat(agent-feed): AgentFeedView 共享观测视图（卡片轨+阶段管线+模型徽标）"
```

---

### Task 6: 浮层复用 AgentFeedView（删除重复实现）

**Files:**
- Modify: `src/components/AgentObservationPanel.tsx`
- Modify: `src/components/AgentObservationPanel.module.css`

- [ ] **Step 1: 重写 `AgentObservationPanel.tsx`**（保留浮层壳 + 头部按钮，body 换共享视图）：

```tsx
/**
 * AgentObservationPanel — AI 卡片多 agent 生成过程的浮层入口（编辑器外兜底）。
 *
 * 状态栏上方浮层（与 TaskProgressPanel 同模式），内容复用 AgentFeedView。
 * 编辑器内该内容停靠在右侧 Inspector（dockMounted 时 openPanel 不再打开本浮层）。
 */

import { AgentFeedView } from './agent-feed/AgentFeedView';
import { useAgentFeedStore } from '../store/agent-feed';
import styles from './AgentObservationPanel.module.css';

export function AgentObservationPanel() {
  const panelOpen = useAgentFeedStore((s) => s.panelOpen);
  const closePanel = useAgentFeedStore((s) => s.closePanel);
  const clearAll = useAgentFeedStore((s) => s.clearAll);

  if (!panelOpen) return null;

  return (
    <>
      <div className={styles.overlay} onClick={closePanel} />
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.title}>AI 生成过程观测</span>
          <button className={styles.headerBtn} onClick={clearAll} title="清除全部观测记录">
            清除记录
          </button>
          <button className={styles.headerBtn} onClick={closePanel}>
            关闭
          </button>
        </div>
        <AgentFeedView />
      </div>
    </>
  );
}
```

- [ ] **Step 2: 清理 CSS** — `AgentObservationPanel.module.css` 只保留 `.overlay/.panel/.header/.title/.headerBtn`（含 hover），删除 `.body/.sidebar/.sessionItem*/.sessionDot*/.sessionLabel/.messages/.turnCaption/.roleBadge*/.empty` 与 `@keyframes obsPulse`。

- [ ] **Step 3: 跑相关测试与类型检查**

Run: `npx vitest run tests/agent-feed-view.test.tsx tests/agent-feed-store.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS / 无类型错误（若项目无独立 tsc 脚本，跑 `npm run build` 的 renderer 编译亦可，放到 Task 8 统一做则此处仅跑 vitest）。

- [ ] **Step 4: Commit**

```bash
git add src/components/AgentObservationPanel.tsx src/components/AgentObservationPanel.module.css
git commit -m "refactor(agent-feed): 浮层复用 AgentFeedView，删除重复对话渲染"
```

---

### Task 7: EditorInspector + Editor 接线（常驻入口）

**Files:**
- Modify: `src/components/EditorInspector.tsx`
- Modify: `src/pages/Editor.tsx`

- [ ] **Step 1: `EditorInspector.tsx`**：

- `InspectorSelection` 增加成员：

```ts
export type InspectorSelection =
  | { type: 'empty' }
  | { type: 'ai-card'; cardId: string }
  | { type: 'overlay'; overlayId: string }
  | { type: 'subtitle-style' }
  | { type: 'agent-feed' };
```

- import 增加 `import { AgentFeedView } from './agent-feed/AgentFeedView';`
- `headerTitle` 链首补：

```ts
  const headerTitle =
    selection.type === 'agent-feed'
      ? '生成观测'
      : selection.type === 'subtitle-style'
      ? '字幕样式'
      : ...（其余不动）
```

- `renderBody()` 开头补：

```ts
    if (selection.type === 'agent-feed') {
      return <AgentFeedView />;
    }
```

注意：`AgentFeedView` 根节点是 flex 容器，`EditorInspector` 的 `.body` 若非 flex 布局，需要给包一层撑满高度：检查 `EditorInspector.module.css` 的 `.body`——若是 `overflow-y: auto` 的块级容器，则改为在 agent-feed 分支返回 `<div style={{ display: 'flex', height: '100%', minHeight: 0 }}><AgentFeedView /></div>`（实现时按实际 CSS 选最小改动，不动其他 inspector 的布局）。

- [ ] **Step 2: `Editor.tsx` 接线**（四段，全部放在已有 `inspectorSelection` state 附近）：

- import：`import { useAgentFeedStore } from '../store/agent-feed';`（若该文件尚未引）。
- dock 注册（组件顶层，一次性 effect）：

```ts
  // 观测视图停靠注册：编辑器在场时 openPanel 路由到右侧 Inspector 而非状态栏浮层
  useEffect(() => {
    useAgentFeedStore.getState().setDockMounted(true);
    return () => useAgentFeedStore.getState().setDockMounted(false);
  }, []);
```

- focusToken 响应（状态栏图标 / 任务行「查看过程」点击 → 切 Inspector）：

```ts
  const feedFocusToken = useAgentFeedStore((s) => s.focusToken);
  const handledFocusRef = useRef(feedFocusToken);
  useEffect(() => {
    if (feedFocusToken !== handledFocusRef.current) {
      handledFocusRef.current = feedFocusToken;
      setInspectorSelection({ type: 'agent-feed' });
    }
  }, [feedFocusToken]);
```

- 生成开始自动切入（false→true 边沿，一轮生成只抢占一次）：

```ts
  const feedHasActive = useAgentFeedStore((s) => s.hasActive);
  const prevFeedActiveRef = useRef(false);
  useEffect(() => {
    if (feedHasActive && !prevFeedActiveRef.current) {
      setInspectorSelection({ type: 'agent-feed' });
    }
    prevFeedActiveRef.current = feedHasActive;
  }, [feedHasActive]);
```

- 清空回退（clearAll / 项目切换后观测视图不悬空）：

```ts
  const feedSessionCount = useAgentFeedStore((s) => s.sessions.size);
  useEffect(() => {
    if (feedSessionCount === 0 && inspectorSelection.type === 'agent-feed') {
      setInspectorSelection({ type: 'empty' });
    }
  }, [feedSessionCount, inspectorSelection.type]);
```

`useRef` 已在 Editor.tsx 导入（playerRef 等在用）；确认 `useEffect` 同理。

- [ ] **Step 3: 手动/构建验证**

Run: `npx vitest run tests/editor.test.tsx 2>/dev/null || true`（若存在编辑器测试则必须 PASS），再 `npm run dev` 手动验收：
1. 编辑器内触发单卡重生成（AI 面板或卡片 Inspector 的重新生成）→ 右侧自动切到「生成观测」，管线随导演→雕刻→质检→审查推进，消息带角色头像与模型徽标；
2. 点选时间线 overlay → Inspector 切走；点状态栏 Activity 图标 → 切回观测视图（不弹浮层）；
3. 「重试全部」多卡并行 → 左侧卡片轨出现多个头像，活跃卡呼吸；
4. 回到欢迎页/工作台（编辑器卸载）→ 状态栏图标恢复弹浮层行为。

- [ ] **Step 4: Commit**

```bash
git add src/components/EditorInspector.tsx src/pages/Editor.tsx
git commit -m "feat(editor): 生成观测视图接入右侧 Inspector（自动切入+入口路由）"
```

---

### Task 8: 全量验证

- [ ] **Step 1: 相关测试全跑**

Run: `npx vitest run tests/agent-feed-emitter.test.ts tests/agent-feed-store.test.ts tests/agent-feed-view.test.tsx tests/motion-agent-run.test.ts tests/card-run.test.ts tests/pipeline-task-progress-bridge.test.ts`
Expected: 全部 PASS

- [ ] **Step 2: 全量测试 + 构建**

Run: `npm test && npm run build`
Expected: 无失败、无类型错误

- [ ] **Step 3: 若构建/全量出问题，修复后补提交**

```bash
git add -A && git commit -m "fix(agent-feed): 全量验证收尾"
```
