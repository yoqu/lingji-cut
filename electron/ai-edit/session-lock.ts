import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { getActiveProjectPath } from '../pipeline/context';
import { parseLock, isLockActive, type EditLock, type EditScope } from './lock-state';

export interface AiEditLockChange {
  active: boolean;
  scope?: EditScope;
  owner?: string;
  projectPath?: string;
  reason?: string;
  startedAt?: number;
  heartbeat?: number;
  ttlMs?: number;
}

export interface AcquireAiEditLockOptions {
  projectPath?: string | null;
  scope: EditScope;
  owner?: string;
  reason?: string;
  ttlMs?: number;
}

let currentLock: EditLock | null = null;
let broadcaster: (() => BrowserWindow | null) | null = null;

function lockFilePath(projectPath: string): string {
  return path.join(projectPath, '.lingji', 'edit-lock.json');
}

function normalizeProjectPath(projectPath?: string | null): string {
  const selected = projectPath ?? getActiveProjectPath();
  if (!selected) {
    throw new Error('没有活动项目，请传入 --project <path> 或先打开项目。');
  }
  return path.resolve(selected);
}

function toChange(lock: EditLock | null): AiEditLockChange {
  if (!lock || !isLockActive(lock, Date.now())) return { active: false };
  return {
    active: true,
    scope: lock.scope,
    owner: lock.owner,
    projectPath: lock.projectPath,
    reason: lock.reason,
    startedAt: lock.startedAt,
    heartbeat: lock.heartbeat,
    ttlMs: lock.ttlMs,
  };
}

export function configureAiEditLockBroadcaster(getWindow: () => BrowserWindow | null): void {
  broadcaster = getWindow;
}

export function broadcastAiEditLock(change: AiEditLockChange): void {
  const win = broadcaster?.();
  if (win && !win.isDestroyed()) {
    win.webContents.send('ai-edit-lock-changed', change);
  }
}

export function getAiEditLockStatus(): AiEditLockChange {
  return toChange(currentLock);
}

export async function acquireAiEditLock(
  options: AcquireAiEditLockOptions,
): Promise<AiEditLockChange> {
  const projectPath = normalizeProjectPath(options.projectPath);
  const now = Date.now();
  const lock: EditLock = {
    owner: options.owner?.trim() || 'agent',
    scope: options.scope,
    startedAt: now,
    heartbeat: now,
    ttlMs: options.ttlMs ?? 120_000,
    projectPath,
    reason: options.reason?.trim() || undefined,
  };
  await mkdir(path.dirname(lockFilePath(projectPath)), { recursive: true });
  await writeFile(lockFilePath(projectPath), JSON.stringify(lock, null, 2), 'utf-8');
  currentLock = lock;
  const change = toChange(lock);
  broadcastAiEditLock(change);
  return change;
}

export async function heartbeatAiEditLock(
  projectPath?: string | null,
): Promise<AiEditLockChange> {
  const resolvedProjectPath = normalizeProjectPath(projectPath ?? currentLock?.projectPath);
  let lock = currentLock;
  if (!lock || lock.projectPath !== resolvedProjectPath) {
    try {
      lock = parseLock(await readFile(lockFilePath(resolvedProjectPath), 'utf-8'));
    } catch {
      lock = null;
    }
  }
  if (!lock) return { active: false };
  lock = { ...lock, heartbeat: Date.now(), projectPath: resolvedProjectPath };
  await writeFile(lockFilePath(resolvedProjectPath), JSON.stringify(lock, null, 2), 'utf-8');
  currentLock = lock;
  const change = toChange(lock);
  broadcastAiEditLock(change);
  return change;
}

export async function releaseAiEditLock(
  projectPath?: string | null,
): Promise<AiEditLockChange> {
  const resolvedProjectPath = normalizeProjectPath(projectPath ?? currentLock?.projectPath);
  await rm(lockFilePath(resolvedProjectPath), { force: true }).catch(() => {});
  currentLock = null;
  const change = { active: false, projectPath: resolvedProjectPath };
  broadcastAiEditLock(change);
  return change;
}

export function applyObservedAiEditLock(lock: EditLock | null): AiEditLockChange {
  currentLock = lock && isLockActive(lock, Date.now()) ? lock : null;
  const change = toChange(currentLock);
  broadcastAiEditLock(change);
  return change;
}
