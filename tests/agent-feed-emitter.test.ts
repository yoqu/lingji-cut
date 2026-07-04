import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_FEED_CHANNEL,
  clipTail,
  createAgentFeedEmitter,
  type AgentFeedEvent,
} from '../electron/pipeline/agent-feed';

function makeEmitter(opts: { flushMs?: number; maxClip?: number } = {}) {
  const sent: AgentFeedEvent[] = [];
  const timers: Array<() => void> = [];
  const emitter = createAgentFeedEmitter({
    send: (channel, payload) => {
      expect(channel).toBe(AGENT_FEED_CHANNEL);
      sent.push(payload as AgentFeedEvent);
    },
    feedId: 'task-1',
    now: () => 1000,
    setTimeoutFn: (handler) => {
      timers.push(handler);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: () => {},
    ...opts,
  });
  const runTimers = () => {
    const pending = timers.splice(0);
    for (const t of pending) t();
  };
  return { emitter, sent, runTimers };
}

describe('clipTail', () => {
  it('不超限时原样返回', () => {
    expect(clipTail('abc', 10)).toBe('abc');
  });

  it('超限时留尾并标注截断量', () => {
    const out = clipTail('x'.repeat(100), 10);
    expect(out).toContain('前 90 字符已截断');
    expect(out.endsWith('x'.repeat(10))).toBe(true);
  });
});

describe('createAgentFeedEmitter', () => {
  it('text 增量按 (cardKey, role) 合并，冲刷时一次发出', () => {
    const { emitter, sent, runTimers } = makeEmitter();
    emitter.emit({ cardKey: 'seg-1', role: 'sculptor', kind: 'text', text: '你' });
    emitter.emit({ cardKey: 'seg-1', role: 'sculptor', kind: 'text', text: '好' });
    emitter.emit({ cardKey: 'seg-2', role: 'sculptor', kind: 'text', text: '另一张卡' });
    expect(sent).toHaveLength(0);
    runTimers();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ feedId: 'task-1', cardKey: 'seg-1', kind: 'text', text: '你好', seq: 1 });
    expect(sent[1]).toMatchObject({ cardKey: 'seg-2', text: '另一张卡', seq: 2 });
  });

  it('非增量事件先冲刷缓冲，保持事件顺序', () => {
    const { emitter, sent } = makeEmitter();
    emitter.emit({ cardKey: 'seg-1', role: 'sculptor', kind: 'text', text: '写文件前' });
    emitter.emit({
      cardKey: 'seg-1',
      role: 'sculptor',
      kind: 'tool_use',
      toolCallId: 't1',
      toolName: 'write',
      toolInput: '{"path":"motionCard.tsx"}',
    });
    expect(sent.map((e) => e.kind)).toEqual(['text', 'tool_use']);
    expect(sent.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('工具输出与里程碑文案按 maxClip 截断留尾', () => {
    const { emitter, sent } = makeEmitter({ maxClip: 16 });
    emitter.emit({
      cardKey: 'seg-1',
      role: 'sculptor',
      kind: 'tool_result',
      toolCallId: 't1',
      toolOutput: 'y'.repeat(200),
    });
    emitter.emit({ cardKey: 'seg-1', role: 'orchestrator', kind: 'milestone', text: 'z'.repeat(200) });
    expect(sent[0].toolOutput).toContain('已截断');
    expect(sent[0].toolOutput!.endsWith('y'.repeat(16))).toBe(true);
    expect(sent[1].text).toContain('已截断');
  });

  it('dispose 冲刷未发送的增量', () => {
    const { emitter, sent } = makeEmitter();
    emitter.emit({ cardKey: 'seg-1', role: 'director', kind: 'thinking', text: '思考中' });
    expect(sent).toHaveLength(0);
    emitter.dispose();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'thinking', text: '思考中' });
  });

  it('send 抛错时静默（渲染窗口可能已关闭）', () => {
    const emitter = createAgentFeedEmitter({
      send: () => {
        throw new Error('window destroyed');
      },
      feedId: 'task-1',
    });
    expect(() =>
      emitter.emit({ cardKey: 'seg-1', role: 'orchestrator', kind: 'phase', text: '导演' }),
    ).not.toThrow();
  });
});

describe('stage/round/model 字段透传', () => {
  it('phase 事件立即发送并携带 stage/round；text 合并后保留 model', () => {
    const { emitter, sent } = makeEmitter();
    emitter.emit({ cardKey: 'seg-1', role: 'director', kind: 'text', text: 'a', model: 'openai/gpt-x' });
    emitter.emit({ cardKey: 'seg-1', role: 'director', kind: 'text', text: 'b', model: 'openai/gpt-x' });
    emitter.emit({ cardKey: 'seg-1', role: 'orchestrator', kind: 'phase', text: '修复 1/3', stage: 'mechqa', round: 1 });
    // phase 非增量：先冲刷缓冲再发送，顺序 = [合并后的 text, phase]
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ kind: 'text', text: 'ab', model: 'openai/gpt-x' });
    expect(sent[1]).toMatchObject({ kind: 'phase', text: '修复 1/3', stage: 'mechqa', round: 1 });
  });
});
