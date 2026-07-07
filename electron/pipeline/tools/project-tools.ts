import fs from 'node:fs/promises';
import path from 'node:path';
import { createDefaultProjectData } from '../../../src/lib/project-persistence';
import { computeProjectState, type ProjectStateSnapshot } from '../algorithms/project-state';
import { resolveProject } from '../context';
import { PIPELINE_ERROR_CODES } from '../types';

class PipelineError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface CreateProjectInput {
  path: string;
  options?: { name?: string; meta?: Record<string, unknown> };
}

export interface CreateProjectOutput {
  projectPath: string;
}

async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length === 0;
  } catch {
    return true; // 不存在视为可创建
  }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    const st = await fs.stat(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export async function createProject(input: CreateProjectInput): Promise<CreateProjectOutput> {
  if (!path.isAbsolute(input.path)) {
    throw new PipelineError(
      PIPELINE_ERROR_CODES.INVALID_PROJECT,
      'path 必须为绝对路径',
    );
  }
  const target = input.path;
  const exists = await dirExists(target);
  if (exists && !(await isEmptyDir(target))) {
    throw new PipelineError(
      PIPELINE_ERROR_CODES.INVALID_PROJECT,
      `目标目录非空: ${target}`,
    );
  }

  await fs.mkdir(target, { recursive: true });
  await Promise.all([
    fs.mkdir(path.join(target, 'covers'), { recursive: true }),
    fs.mkdir(path.join(target, 'ai-cards'), { recursive: true }),
    fs.mkdir(path.join(target, 'configs/prompts'), { recursive: true }),
  ]);

  const data = createDefaultProjectData();
  await fs.writeFile(
    path.join(target, 'project.json'),
    JSON.stringify(data, null, 2),
    'utf-8',
  );
  await fs.writeFile(path.join(target, 'original.md'), '', 'utf-8');

  return { projectPath: target };
}

export async function getProjectState(input: { projectPath: string }): Promise<ProjectStateSnapshot> {
  await resolveProject(input.projectPath);
  return computeProjectState(input.projectPath);
}

export async function openProject(input: { path: string }): Promise<{ ok: true }> {
  await resolveProject(input.path);
  return { ok: true };
}

import { loadGlobalSettings, saveGlobalSettings, type GlobalSettingsFile } from '../../global-settings';

export interface SettingsSnapshot {
  defaultProvider: string | null;
  defaultModel: string | null;
  llmProviders: Array<Record<string, unknown>> | null;
  imageProviders: Array<Record<string, unknown>> | null;
  videoProviders: Array<Record<string, unknown>> | null;
  defaultImageProvider: string | null;
  defaultImageModel: string | null;
  defaultVideoProvider: string | null;
  defaultVideoModel: string | null;
  ttsDefaults: Record<string, unknown> | null;
  promptBindings: Record<string, unknown> | null;
}

const SECRET_KEY_RE = /apikey|secret|token|sessionid|password|credential|bearer|signature/i;

function stripSecrets<T extends Record<string, unknown>>(obj: T | null | undefined): Record<string, unknown> | null {
  if (!obj) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEY_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function stripSecretsFromList(list: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(list)) return null;
  return list.map((item) => {
    if (!item || typeof item !== 'object') return {};
    return stripSecrets(item as Record<string, unknown>) ?? {};
  });
}

function pickTtsDefaults(ai: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!ai) return null;
  const out: Record<string, unknown> = {};
  for (const k of [
    'minimaxVoiceId',
    'minimaxSpeed',
    'minimaxVol',
    'minimaxPitch',
    'minimaxEmotion',
    'minimaxModel',
  ]) {
    if (k in ai) out[k] = ai[k];
  }
  return Object.keys(out).length > 0 ? out : null;
}

export async function getSettings(opts: { userDataPath: string }): Promise<SettingsSnapshot> {
  const file = await loadGlobalSettings(opts.userDataPath);
  const ai = (file?.aiSettings ?? null) as Record<string, unknown> | null;

  return {
    defaultProvider: (ai?.defaultProviderId as string | null | undefined) ?? null,
    defaultModel: (ai?.defaultModel as string | null | undefined) ?? null,
    llmProviders: stripSecretsFromList(ai?.llmProviders),
    imageProviders: stripSecretsFromList(ai?.imageProviders),
    videoProviders: stripSecretsFromList(ai?.videoProviders),
    defaultImageProvider: (ai?.defaultImageProviderId as string | null | undefined) ?? null,
    defaultImageModel: (ai?.defaultImageModel as string | null | undefined) ?? null,
    defaultVideoProvider: (ai?.defaultVideoProviderId as string | null | undefined) ?? null,
    defaultVideoModel: (ai?.defaultVideoModel as string | null | undefined) ?? null,
    ttsDefaults: pickTtsDefaults(ai),
    promptBindings: stripSecrets(ai?.promptBindings as Record<string, unknown> | undefined),
  };
}

/** 可通过控制服务写入的全局设置白名单（永不包含密钥类字段） */
const UPDATABLE_SETTINGS_KEYS = new Set([
  'defaultProviderId',
  'defaultModel',
  'defaultImageProviderId',
  'defaultImageModel',
  'defaultVideoProviderId',
  'defaultVideoModel',
  'minimaxVoiceId',
  'minimaxSpeed',
  'minimaxVol',
  'minimaxPitch',
  'minimaxEmotion',
  'minimaxModel',
]);

export async function updateSettings(opts: {
  userDataPath: string;
  updates: Record<string, string | number | boolean>;
}): Promise<{ updated: string[]; rejected: string[] }> {
  const updated: string[] = [];
  const rejected: string[] = [];
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(opts.updates)) {
    if (UPDATABLE_SETTINGS_KEYS.has(key) && !SECRET_KEY_RE.test(key)) {
      filtered[key] = value;
      updated.push(key);
    } else {
      rejected.push(key);
    }
  }
  if (updated.length === 0) {
    throw new PipelineError(
      'invalid_settings_key',
      `没有可更新的字段（白名单: ${[...UPDATABLE_SETTINGS_KEYS].join(', ')}）`,
    );
  }
  const file = (await loadGlobalSettings(opts.userDataPath)) ?? ({} as GlobalSettingsFile);
  const ai = { ...(file.aiSettings ?? {}), ...filtered } as GlobalSettingsFile['aiSettings'];
  await saveGlobalSettings(opts.userDataPath, { ...file, aiSettings: ai });
  return { updated, rejected };
}
