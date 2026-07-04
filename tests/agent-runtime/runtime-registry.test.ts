import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { RuntimeRegistry } from '../../electron/agent-runtime/runtime-registry';
import type { AgentSessionStartInput } from '../../electron/agent-runtime/session';
import type { AgentStreamEvent } from '../../electron/agent-runtime/event-model';

// ─── Fake AgentSession ───────────────────────────────────────────────────────

/**
 * 可控的假 AgentSession：start() 记录 input，并把内部缓存的脚本事件
 * 依次喂给 input.onEvent；亦可手动 emit。cancel() 记录调用。
 */
class FakeSession {
  static instances: FakeSession[] = [];
  lastInput: AgentSessionStartInput | null = null;
  startCalls = 0;
  cancelCalls = 0;
  /** 启动时自动 emit 的事件序列（可选） */
  script: AgentStreamEvent[] = [];
  /** true 时 start() 返回的 promise 永不 resolve（模拟轮进行中） */
  pending = false;

  constructor() {
    FakeSession.instances.push(this);
  }

  async start(input: AgentSessionStartInput): Promise<void> {
    this.startCalls += 1;
    this.lastInput = input;
    for (const ev of this.script) {
      input.onEvent(ev);
    }
    if (this.pending) {
      await new Promise<void>(() => {
        /* 永挂起 */
      });
    }
  }

  /** 手动把事件喂给最近一次 start 的 onEvent */
  emit(ev: AgentStreamEvent): void {
    this.lastInput?.onEvent(ev);
  }

  cancel(): void {
    this.cancelCalls += 1;
  }

  respondCalls: Array<[string, string]> = [];
  respondPermission(requestId: string, optionId: string): void {
    this.respondCalls.push([requestId, optionId]);
  }
}

function makeRegistry(): {
  registry: RuntimeRegistry;
  sessions: FakeSession[];
} {
  FakeSession.instances = [];
  const sessions: FakeSession[] = FakeSession.instances;
  const registry = new RuntimeRegistry({
    createSession: () => new FakeSession() as any,
  });
  return { registry, sessions };
}

const baseConnect = {
  conversationId: 1,
  agentType: 'pi',
  projectDir: '/proj',
};

describe('RuntimeRegistry', () => {
  let statusEvents: Array<{ conversationId: number; status: string }>;
  let runtimeEvents: Array<{ conversationId: number; event: any }>;

  function attachListeners(registry: RuntimeRegistry) {
    statusEvents = [];
    runtimeEvents = [];
    registry.on('status', (p: any) => statusEvents.push(p));
    registry.on('event', (p: any) => runtimeEvents.push(p));
  }

  beforeEach(() => {
    statusEvents = [];
    runtimeEvents = [];
  });

  it('connect 登记会话上下文但不 spawn（不创建 session.start）', async () => {
    const { registry, sessions } = makeRegistry();
    attachListeners(registry);

    await registry.connect({ ...baseConnect });

    // connect 不应触发任何 start
    const started = sessions.filter((s) => s.startCalls > 0);
    expect(started.length).toBe(0);
    // 登记后应有快照
    expect(registry.get(1)).not.toBeNull();
    // connect 发出 connected/disconnected 之类的 status（至少要存在一个 status 事件）
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('connect 未知 agentType 抛错', async () => {
    const { registry } = makeRegistry();
    await expect(
      registry.connect({ ...baseConnect, agentType: 'nope-xyz' }),
    ).rejects.toThrow();
  });

  it('sendPrompt 触发 fake session.start，prompt 为 contents 文本化', async () => {
    const { registry, sessions } = makeRegistry();
    attachListeners(registry);

    await registry.connect({ ...baseConnect, model: 'm1' });
    await registry.sendPrompt(1, [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }]);

    const started = sessions.filter((s) => s.startCalls > 0);
    expect(started.length).toBe(1);
    const input = started[0].lastInput!;
    expect(input.prompt).toContain('hello');
    expect(input.prompt).toContain('world');
    expect(input.cwd).toBe('/proj');
    expect(input.model).toBe('m1');
    expect(typeof input.onEvent).toBe('function');
  });

  it('sendPrompt opts.model 覆盖 connect 时登记的 model 并透传给 session.start', async () => {
    const { registry, sessions } = makeRegistry();
    attachListeners(registry);

    await registry.connect({ ...baseConnect, model: 'm1' });
    await registry.sendPrompt(1, [{ type: 'text', text: 'hi' }], { model: 'm2' });

    const started = sessions.filter((s) => s.startCalls > 0);
    expect(started.length).toBe(1);
    expect(started[0].lastInput!.model).toBe('m2');

    // 覆盖后回写 entry.model：下一轮不带 opts 也沿用 m2。
    await registry.sendPrompt(1, [{ type: 'text', text: 'again' }]);
    const second = sessions.filter((s) => s.startCalls > 0)[1];
    expect(second.lastInput!.model).toBe('m2');
  });

  it('text_delta → emit event {type:text}', async () => {
    const { registry, sessions } = makeRegistry();
    attachListeners(registry);
    await registry.connect({ ...baseConnect });
    await registry.sendPrompt(1, [{ type: 'text', text: 'hi' }]);
    const session = sessions.find((s) => s.startCalls > 0)!;
    session.emit({ type: 'text_delta', delta: 'abc' });

    const ev = runtimeEvents.find((e) => e.event.type === 'text');
    expect(ev).toBeTruthy();
    expect(ev!.conversationId).toBe(1);
    expect(ev!.event.text).toBe('abc');
  });

  it('tool_use → emit event {type:tool_call}', async () => {
    const { registry, sessions } = makeRegistry();
    attachListeners(registry);
    await registry.connect({ ...baseConnect });
    await registry.sendPrompt(1, [{ type: 'text', text: 'hi' }]);
    const session = sessions.find((s) => s.startCalls > 0)!;
    session.emit({ type: 'tool_use', id: 't1', name: 'Read', input: { path: '/x' } });

    const ev = runtimeEvents.find((e) => e.event.type === 'tool_call');
    expect(ev).toBeTruthy();
    expect(ev!.event.toolCallId).toBe('t1');
    expect(ev!.event.title).toBe('Read');
  });

  it('turn_end → emit event {type:turn_complete}', async () => {
    const { registry, sessions } = makeRegistry();
    attachListeners(registry);
    await registry.connect({ ...baseConnect });
    await registry.sendPrompt(1, [{ type: 'text', text: 'hi' }]);
    const session = sessions.find((s) => s.startCalls > 0)!;
    session.emit({ type: 'turn_end', stopReason: 'end_turn' });

    const ev = runtimeEvents.find((e) => e.event.type === 'turn_complete');
    expect(ev).toBeTruthy();
    expect(ev!.event.stopReason).toBe('end_turn');
  });

  it('toRuntimeEvent 返回 null 的事件（status / thinking_start）被忽略', async () => {
    const { registry, sessions } = makeRegistry();
    attachListeners(registry);
    await registry.connect({ ...baseConnect });
    await registry.sendPrompt(1, [{ type: 'text', text: 'hi' }]);
    const session = sessions.find((s) => s.startCalls > 0)!;
    const before = runtimeEvents.length;
    session.emit({ type: 'status', label: 'thinking' });
    session.emit({ type: 'thinking_start' });
    expect(runtimeEvents.length).toBe(before);
  });

  it('error 事件经 toRuntimeEvent 转发为 event {type:error}', async () => {
    const { registry, sessions } = makeRegistry();
    attachListeners(registry);
    await registry.connect({ ...baseConnect });
    await registry.sendPrompt(1, [{ type: 'text', text: 'hi' }]);
    const session = sessions.find((s) => s.startCalls > 0)!;
    session.emit({ type: 'error', message: 'boom' });

    const ev = runtimeEvents.find((e) => e.event.type === 'error');
    expect(ev).toBeTruthy();
    expect(ev!.event.message).toBe('boom');
  });

  it('sendPrompt 发出 prompting → connected 的 status 序列', async () => {
    const { registry, sessions } = makeRegistry();
    attachListeners(registry);
    await registry.connect({ ...baseConnect });
    statusEvents = [];
    await registry.sendPrompt(1, [{ type: 'text', text: 'hi' }]);
    const s = sessions.find((x) => x.startCalls > 0)!;
    s.emit({ type: 'turn_end', stopReason: 'end_turn' });

    const statuses = statusEvents.map((e) => e.status);
    expect(statuses).toContain('prompting');
    // turn 结束后回落到 connected
    expect(statuses[statuses.length - 1]).toBe('connected');
  });

  it('start() 立即 resolve 后状态仍是 prompting（不提前回落 connected）', async () => {
    // 真实时序：AgentSession.start() 只挂监听器即 resolve（不 await 子进程 close）。
    // 此处 FakeSession 默认 pending=false → start() 立即 resolve，贴近真实。
    const { registry, sessions } = makeRegistry();
    attachListeners(registry);
    await registry.connect({ ...baseConnect });
    statusEvents = [];

    // sendPrompt 已 await start() resolve；此时仍应处于 prompting（轮未结束）。
    await registry.sendPrompt(1, [{ type: 'text', text: 'hi' }]);

    expect(registry.get(1)!.status).toBe('prompting');
    const statuses = statusEvents.map((e) => e.status);
    expect(statuses).toContain('prompting');
    // start resolve 不应触发 connected
    expect(statuses).not.toContain('connected');

    // 文本流式途中：仍是 prompting
    const s = sessions.find((x) => x.startCalls > 0)!;
    s.emit({ type: 'text_delta', delta: 'streaming...' });
    expect(registry.get(1)!.status).toBe('prompting');

    // 只有收到 turn_end 才回落 connected，并 emit turn_complete
    s.emit({ type: 'turn_end', stopReason: 'end_turn' });
    expect(registry.get(1)!.status).toBe('connected');
    const completeEv = runtimeEvents.find((e) => e.event.type === 'turn_complete');
    expect(completeEv).toBeTruthy();
    expect(statusEvents[statusEvents.length - 1].status).toBe('connected');
  });

  it('start() 立即 resolve 后 emit error → 状态变 error', async () => {
    const { registry, sessions } = makeRegistry();
    attachListeners(registry);
    await registry.connect({ ...baseConnect });
    statusEvents = [];
    await registry.sendPrompt(1, [{ type: 'text', text: 'hi' }]);

    // start resolve 后仍未结束 → prompting
    expect(registry.get(1)!.status).toBe('prompting');

    const s = sessions.find((x) => x.startCalls > 0)!;
    s.emit({ type: 'error', message: 'boom' });
    expect(registry.get(1)!.status).toBe('error');
    expect(statusEvents[statusEvents.length - 1].status).toBe('error');
  });

  it('start() 抛错（spawn 失败）→ emit error event + 状态 error', async () => {
    const created: FakeSession[] = [];
    const registry = new RuntimeRegistry({
      createSession: () => {
        const s = new FakeSession();
        s.start = async () => {
          throw new Error('spawn failed');
        };
        created.push(s);
        return s as any;
      },
    });
    attachListeners(registry);
    await registry.connect({ ...baseConnect });
    statusEvents = [];
    await registry.sendPrompt(1, [{ type: 'text', text: 'hi' }]);

    expect(registry.get(1)!.status).toBe('error');
    const errEv = runtimeEvents.find((e) => e.event.type === 'error');
    expect(errEv).toBeTruthy();
    expect(errEv!.event.message).toContain('spawn failed');
  });

  it('turn_end 后再次 sendPrompt：新一轮重新进入 prompting 并可再次结束', async () => {
    const { registry, sessions } = makeRegistry();
    attachListeners(registry);
    await registry.connect({ ...baseConnect });

    await registry.sendPrompt(1, [{ type: 'text', text: 'r1' }]);
    const s1 = sessions.find((x) => x.startCalls > 0)!;
    s1.emit({ type: 'turn_end', stopReason: 'end_turn' });
    expect(registry.get(1)!.status).toBe('connected');

    statusEvents = [];
    await registry.sendPrompt(1, [{ type: 'text', text: 'r2' }]);
    // 第二轮：start resolve 后仍 prompting
    expect(registry.get(1)!.status).toBe('prompting');
    const s2 = sessions.filter((x) => x.startCalls > 0).at(-1)!;
    expect(s2).not.toBe(s1);
    s2.emit({ type: 'turn_end', stopReason: 'end_turn' });
    expect(registry.get(1)!.status).toBe('connected');
  });

  it('cancelTurn 调 session.cancel（轮进行中）', async () => {
    const created: FakeSession[] = [];
    const registry = new RuntimeRegistry({
      createSession: () => {
        const s = new FakeSession();
        s.pending = true; // 模拟进行中的轮
        created.push(s);
        return s as any;
      },
    });
    attachListeners(registry);
    await registry.connect({ ...baseConnect });
    // 不 await：start 永挂起，轮保持进行中
    void registry.sendPrompt(1, [{ type: 'text', text: 'hi' }]);
    const session = created.find((s) => s.startCalls > 0)!;
    registry.cancelTurn(1);
    expect(session.cancelCalls).toBe(1);
  });

  it('disconnect 清理会话；之后 sendPrompt 抛错', async () => {
    const { registry } = makeRegistry();
    attachListeners(registry);
    await registry.connect({ ...baseConnect });
    registry.disconnect(1);
    expect(registry.get(1)).toBeNull();
    expect(statusEvents.some((e) => e.status === 'disconnected')).toBe(true);
    await expect(registry.sendPrompt(1, [{ type: 'text', text: 'x' }])).rejects.toThrow();
  });

  it('多会话隔离：两个 conversationId 各自事件不串', async () => {
    const { registry, sessions } = makeRegistry();
    attachListeners(registry);
    await registry.connect({ conversationId: 1, agentType: 'pi', projectDir: '/p1' });
    await registry.connect({ conversationId: 2, agentType: 'pi', projectDir: '/p2' });
    await registry.sendPrompt(1, [{ type: 'text', text: 'one' }]);
    await registry.sendPrompt(2, [{ type: 'text', text: 'two' }]);

    const startedFor = (cid: number) =>
      sessions.filter((s) => s.startCalls > 0 && s.lastInput?.cwd === (cid === 1 ? '/p1' : '/p2'));
    const s1 = startedFor(1)[0];
    const s2 = startedFor(2)[0];
    expect(s1).not.toBe(s2);

    s1.emit({ type: 'text_delta', delta: 'A' });
    s2.emit({ type: 'text_delta', delta: 'B' });

    const c1 = runtimeEvents.filter((e) => e.conversationId === 1 && e.event.type === 'text');
    const c2 = runtimeEvents.filter((e) => e.conversationId === 2 && e.event.type === 'text');
    expect(c1.map((e) => e.event.text)).toEqual(['A']);
    expect(c2.map((e) => e.event.text)).toEqual(['B']);
  });

  it('pi resume 透传记录的 sessionId 作为 resumeSessionId', async () => {
    const { registry, sessions } = makeRegistry();
    attachListeners(registry);

    await registry.connect({
      conversationId: 1,
      agentType: 'pi',
      projectDir: '/proj',
      sessionId: 'pi-session-123',
    });
    await registry.sendPrompt(1, [{ type: 'text', text: 'continue' }]);

    const started = sessions.find((s) => s.startCalls > 0)!;
    expect(started.lastInput!.resumeSessionId).toBe('pi-session-123');
    expect(started.lastInput!.isResuming).toBe(true);
  });

  it('回写每轮上报的 sessionId：新建会话第二轮以第一轮 session 续接（保留上下文历史）', async () => {
    const { registry, sessions } = makeRegistry();
    attachListeners(registry);

    // 全新会话：connect 时无 sessionId。
    await registry.connect({ ...baseConnect });
    await registry.sendPrompt(1, [{ type: 'text', text: 'turn1' }]);

    const s1 = sessions.find((s) => s.startCalls > 0)!;
    // 第一轮无 resume id（pi 会新建会话）。
    expect(s1.lastInput!.resumeSessionId).toBeNull();
    expect(s1.lastInput!.isResuming).toBe(false);

    // pi-inprocess 在 createAgentSession 后上报新建/恢复出的 session id。
    s1.emit({ type: 'status', label: 'session', sessionId: 'pi-sess-1' });
    // 回写后快照应反映该 id。
    expect(registry.get(1)!.sessionId).toBe('pi-sess-1');
    s1.emit({ type: 'turn_end', stopReason: 'end_turn' });

    // 第二轮：必须带着第一轮的 session id 去 resume，pi 据此 open 历史会话
    // 并由 buildSessionContext 把完整历史喂给模型。
    await registry.sendPrompt(1, [{ type: 'text', text: 'turn2' }]);
    const s2 = sessions.filter((s) => s.startCalls > 0).at(-1)!;
    expect(s2).not.toBe(s1);
    expect(s2.lastInput!.resumeSessionId).toBe('pi-sess-1');
    expect(s2.lastInput!.isResuming).toBe(true);
  });

  it('兼容方法存在：setPermissionPolicy / setMode / setConfigOption / respondPermission 不抛', async () => {
    const { registry } = makeRegistry();
    await registry.connect({ ...baseConnect });
    expect(() => registry.setPermissionPolicy('tiered')).not.toThrow();
    await expect(registry.setMode(1, 'm')).resolves.toBeUndefined();
    await expect(registry.setConfigOption(1, 'c', 'v')).resolves.toBeUndefined();
    await expect(registry.respondPermission(1, 'r', 'o')).resolves.toBeUndefined();
  });
});

describe('RuntimeRegistry 审批策略透传与响应', () => {
  it('sendPrompt 把 live getPermissionPolicy 透传给 session.start', async () => {
    const { registry, sessions } = makeRegistry();
    registry.setPermissionPolicy('always_ask');
    await registry.connect({ ...baseConnect });
    await registry.sendPrompt(1, [{ type: 'text', text: 'hi' }]);
    const getter = sessions[0].lastInput?.getPermissionPolicy;
    expect(typeof getter).toBe('function');
    expect(getter?.()).toBe('always_ask');
    // live：策略变化后 getter 反映最新值
    registry.setPermissionPolicy('auto_approve');
    expect(getter?.()).toBe('auto_approve');
  });

  it('respondPermission 委派到活跃会话的 respondPermission', async () => {
    const { registry } = makeRegistry();
    // 让该轮挂起，使 activeSession 在 respondPermission 时仍存活。
    const target = new FakeSession();
    target.pending = true;
    (registry as any).createSession = () => target;
    await registry.connect({ ...baseConnect });
    void registry.sendPrompt(1, [{ type: 'text', text: 'hi' }]);
    await registry.respondPermission(1, 'req-9', 'allow_once');
    expect(target.respondCalls).toEqual([['req-9', 'allow_once']]);
  });
});
