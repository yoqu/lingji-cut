export type EditScope = 'video' | 'script';

export interface EditLock {
  owner: string;
  scope: EditScope;
  startedAt: number;
  heartbeat: number;
  ttlMs: number;
  projectPath?: string;
  reason?: string;
}

export function parseLock(raw: string): EditLock | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (
    typeof o.owner !== 'string' ||
    (o.scope !== 'video' && o.scope !== 'script') ||
    typeof o.startedAt !== 'number' ||
    typeof o.heartbeat !== 'number' ||
    typeof o.ttlMs !== 'number'
  ) {
    return null;
  }
  return {
    owner: o.owner,
    scope: o.scope,
    startedAt: o.startedAt,
    heartbeat: o.heartbeat,
    ttlMs: o.ttlMs,
    projectPath: typeof o.projectPath === 'string' ? o.projectPath : undefined,
    reason: typeof o.reason === 'string' ? o.reason : undefined,
  };
}

/** 心跳距 now 超过 ttl 视为遗忘锁，不再 active。 */
export function isLockActive(lock: EditLock, now: number): boolean {
  return now - lock.heartbeat <= lock.ttlMs;
}
