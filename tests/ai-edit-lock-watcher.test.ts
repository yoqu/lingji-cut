import { describe, it, expect, vi } from 'vitest';
import { LockMonitor } from '../electron/ai-edit/lock-watcher';

describe('LockMonitor', () => {
  it('读到 active 锁 → 上报 locked', async () => {
    const events: Array<{ active: boolean; scope?: string }> = [];
    let now = 1000;
    const mon = new LockMonitor({
      readLock: async () => JSON.stringify({ owner: 'x', scope: 'video', startedAt: 1000, heartbeat: 1000, ttlMs: 30000 }),
      now: () => now,
      onChange: (s) => events.push(s),
    });
    await mon.poll();
    // locked 上报现在附带解析出的 lock 对象，这里只关心 active/scope
    expect(events.at(-1)).toMatchObject({ active: true, scope: 'video' });
  });

  it('锁文件消失 → 上报 unlocked', async () => {
    const events: Array<{ active: boolean }> = [];
    let now = 1000;
    let raw: string | null = JSON.stringify({ owner: 'x', scope: 'video', startedAt: 1000, heartbeat: 1000, ttlMs: 30000 });
    const mon = new LockMonitor({ readLock: async () => raw, now: () => now, onChange: (s) => events.push(s) });
    await mon.poll();
    raw = null;
    await mon.poll();
    expect(events.at(-1)).toEqual({ active: false, scope: undefined });
  });

  it('心跳过期 → 自动上报 unlocked（遗忘锁兜底）', async () => {
    const events: Array<{ active: boolean }> = [];
    let now = 1000;
    const mon = new LockMonitor({
      readLock: async () => JSON.stringify({ owner: 'x', scope: 'video', startedAt: 1000, heartbeat: 1000, ttlMs: 30000 }),
      now: () => now,
      onChange: (s) => events.push(s),
    });
    await mon.poll();
    now = 1000 + 31000;
    await mon.poll();
    expect(events.at(-1)).toEqual({ active: false, scope: undefined });
  });

  it('状态不变时不重复上报', async () => {
    const onChange = vi.fn();
    const mon = new LockMonitor({
      readLock: async () => JSON.stringify({ owner: 'x', scope: 'video', startedAt: 1000, heartbeat: 1000, ttlMs: 30000 }),
      now: () => 1000,
      onChange,
    });
    await mon.poll();
    await mon.poll();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
