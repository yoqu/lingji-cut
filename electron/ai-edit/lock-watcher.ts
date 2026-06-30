import { parseLock, isLockActive, type EditLock, type EditScope } from './lock-state';

export interface LockChange {
  active: boolean;
  scope?: EditScope;
  lock?: EditLock;
}

interface LockMonitorOptions {
  /** 读锁文件原始内容；文件不存在返回 null。 */
  readLock: () => Promise<string | null>;
  now: () => number;
  onChange: (change: LockChange) => void;
}

export class LockMonitor {
  private lastActive = false;
  private lastScope: EditScope | undefined;
  constructor(private readonly opts: LockMonitorOptions) {}

  async poll(): Promise<void> {
    const raw = await this.opts.readLock();
    const lock = raw == null ? null : parseLock(raw);
    const active = !!lock && isLockActive(lock, this.opts.now());
    const scope = active ? lock!.scope : undefined;
    if (active === this.lastActive && scope === this.lastScope) return;
    this.lastActive = active;
    this.lastScope = scope;
    this.opts.onChange({ active, scope, lock: active ? lock! : undefined });
  }
}
