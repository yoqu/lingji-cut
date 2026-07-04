import { describe, expect, it } from 'vitest';
import {
  MAX_BLOCK_TEXT,
  reduceFeedEvent,
  sessionKeyOf,
  sessionsForFeed,
  hasFeedSessions,
  useAgentFeedStore,
  type AgentFeedEvent,
  type AgentFeedSession,
} from '../src/store/agent-feed';

let seqCounter = 0;

function ev(partial: Partial<AgentFeedEvent> & Pick<AgentFeedEvent, 'kind' | 'role'>): AgentFeedEvent {
  seqCounter += 1;
  return {
    feedId: 'task-1',
    cardKey: 'seg-1',
    cardLabel: '测试卡片',
    seq: seqCounter,
    ts: 1000 + seqCounter,
    ...partial,
  };
}

function reduceAll(events: AgentFeedEvent[]): AgentFeedSession {
  let session: AgentFeedSession | null = null;
  for (const e of events) session = reduceFeedEvent(session, e);
  return session!;
}

describe('reduceFeedEvent', () => {
  it('首事件建会话：label 取 cardLabel，key 为 feedId::cardKey', () => {
    const s = reduceAll([ev({ role: 'orchestrator', kind: 'phase', text: '导演' })]);
    expect(s.key).toBe('task-1::seg-1');
    expect(s.label).toBe('测试卡片');
    expect(s.status).toBe('active');
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].agentName).toBe('编排');
    expect(s.turns[0].blocks[0]).toEqual({ type: 'text', text: '▸ 导演' });
  });

  it('同角色 text 合并进同一块，角色切换开新 turn', () => {
    const s = reduceAll([
      ev({ role: 'director', kind: 'text', text: '分镜' }),
      ev({ role: 'director', kind: 'text', text: 'JSON' }),
      ev({ role: 'orchestrator', kind: 'phase', text: '雕刻' }),
      ev({ role: 'sculptor', kind: 'text', text: '开始写组件' }),
    ]);
    expect(s.turns).toHaveLength(3);
    expect(s.turns[0].agentName).toBe('导演');
    expect(s.turns[0].blocks).toEqual([{ type: 'text', text: '分镜JSON' }]);
    expect(s.turns[2].agentName).toBe('雕刻');
  });

  it('tool_use/tool_result 按 toolCallId 配对，isError 置 failed', () => {
    const s = reduceAll([
      ev({ role: 'sculptor', kind: 'tool_use', toolCallId: 't1', toolName: 'write', toolInput: '{"path":"motionCard.tsx"}' }),
      ev({ role: 'sculptor', kind: 'tool_use', toolCallId: 't2', toolName: 'edit' }),
      ev({ role: 'sculptor', kind: 'tool_result', toolCallId: 't1', toolOutput: 'ok' }),
      ev({ role: 'sculptor', kind: 'tool_result', toolCallId: 't2', toolOutput: 'boom', isError: true }),
    ]);
    const blocks = s.turns[0].blocks;
    expect(blocks[0]).toMatchObject({ type: 'tool_call', toolCallId: 't1', status: 'completed', rawOutput: 'ok' });
    expect(blocks[1]).toMatchObject({ type: 'tool_call', toolCallId: 't2', status: 'failed', rawOutput: 'boom' });
  });

  it('thinking 独立成块并与 text 互不合并', () => {
    const s = reduceAll([
      ev({ role: 'director', kind: 'thinking', text: '推理' }),
      ev({ role: 'director', kind: 'thinking', text: '中' }),
      ev({ role: 'director', kind: 'text', text: '结论' }),
    ]);
    expect(s.turns[0].blocks).toEqual([
      { type: 'thinking', text: '推理中' },
      { type: 'text', text: '结论' },
    ]);
  });

  it('error 事件落 error 块并置会话 error；done 置 done', () => {
    const failed = reduceAll([
      ev({ role: 'sculptor', kind: 'text', text: 'x' }),
      ev({ role: 'orchestrator', kind: 'error', text: '渲染校验失败' }),
    ]);
    expect(failed.status).toBe('error');
    expect(failed.turns[1].blocks[0]).toEqual({ type: 'error', message: '渲染校验失败' });

    const done = reduceAll([
      ev({ role: 'sculptor', kind: 'text', text: 'x' }),
      ev({ role: 'orchestrator', kind: 'done', text: '生成完成' }),
    ]);
    expect(done.status).toBe('done');
  });

  it('乱序防御：seq 不大于 lastSeq 的事件丢弃（返回原引用）', () => {
    const first = ev({ role: 'director', kind: 'text', text: 'a' });
    const second = ev({ role: 'director', kind: 'text', text: 'b' });
    let s = reduceFeedEvent(null, first)!;
    s = reduceFeedEvent(s, second)!;
    const replayed = reduceFeedEvent(s, { ...first });
    expect(replayed).toBe(s);
  });

  it('单块文本超限时截断留尾', () => {
    const s = reduceAll([
      ev({ role: 'sculptor', kind: 'text', text: 'a'.repeat(MAX_BLOCK_TEXT) }),
      ev({ role: 'sculptor', kind: 'text', text: 'b'.repeat(100) }),
    ]);
    const block = s.turns[0].blocks[0] as { type: 'text'; text: string };
    expect(block.text.length).toBeLessThanOrEqual(MAX_BLOCK_TEXT + 1);
    expect(block.text.endsWith('b'.repeat(100))).toBe(true);
  });

  it('cardLabel 缺失时回退 cardKey', () => {
    const s = reduceFeedEvent(
      null,
      ev({ role: 'orchestrator', kind: 'phase', text: '导演', cardLabel: undefined }),
    )!;
    expect(s.label).toBe('seg-1');
  });
});

describe('会话查询辅助', () => {
  const make = (feedId: string, cardKey: string): AgentFeedSession =>
    reduceFeedEvent(null, ev({ role: 'orchestrator', kind: 'phase', text: 'x', feedId, cardKey }))!;

  it('sessionsForFeed 按 feedId 过滤并按开始时间排序', () => {
    const sessions = new Map<string, AgentFeedSession>();
    const a = make('task-1', 'seg-2');
    const b = make('task-1', 'seg-1');
    const c = make('task-2', 'seg-1');
    for (const s of [a, b, c]) sessions.set(s.key, s);
    const got = sessionsForFeed(sessions, 'task-1');
    expect(got.map((s) => s.cardKey)).toEqual(['seg-2', 'seg-1']);
  });

  it('hasFeedSessions / sessionKeyOf', () => {
    const sessions = new Map<string, AgentFeedSession>();
    const s = make('task-9', 'seg-1');
    sessions.set(s.key, s);
    expect(hasFeedSessions(sessions, 'task-9')).toBe(true);
    expect(hasFeedSessions(sessions, 'task-x')).toBe(false);
    expect(sessionKeyOf({ feedId: 'f', cardKey: 'c' })).toBe('f::c');
  });
});

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
