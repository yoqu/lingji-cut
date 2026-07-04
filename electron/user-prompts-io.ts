import fs from 'node:fs/promises';
import path from 'node:path';
import { readTextIfExists } from './fs-utils';
import {
  PROMPT_CATEGORIES,
  SCRIPT_TEMPLATE_SEEDS,
  parseUserPromptYaml,
  serializeUserPromptYaml,
  type PromptCategory,
  type UserPromptEntry,
  type UserPromptSeed,
} from '../src/lib/prompts';
import type { CustomScriptTemplate, GlobalSettingsFile } from '../src/types/global-settings';
import { loadGlobalSettings, saveGlobalSettings } from './global-settings';

const GLOBAL_SUBDIR = 'prompts';

function seedsOfCategory(category: PromptCategory): UserPromptSeed[] {
  if (category === 'script-template') return SCRIPT_TEMPLATE_SEEDS;
  return [];
}

function categoryDir(userDataPath: string, category: PromptCategory): string {
  return path.join(userDataPath, GLOBAL_SUBDIR, category);
}

function entryFilePath(userDataPath: string, category: PromptCategory, id: string): string {
  return path.join(categoryDir(userDataPath, category), `${id}.yaml`);
}

function sanitizeId(id: string): string {
  if (!id) throw new Error('user-prompt id 不能为空');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`user-prompt id 非法：${id}（仅允许字母数字与 . _ - 且必须以字母数字开头）`);
  }
  return id;
}

async function listYamlFileIds(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
      .map((entry) => entry.name.replace(/\.yaml$/, ''));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function seedToEntry(seed: UserPromptSeed): UserPromptEntry {
  return {
    id: seed.id,
    category: seed.category,
    name: seed.name,
    description: seed.description,
    version: seed.version,
    system: seed.system,
    user: seed.user,
    isBuiltin: true,
  };
}

/**
 * 列出某分类下全部用户提示词。
 * 合并策略：
 * - 每个内置 seed 先生成一条 isBuiltin=true 的条目
 * - 若对应 id 存在 YAML 文件，则以文件内容覆盖（isBuiltin 仍为 true，表示"内置可被覆盖"）
 * - 文件存在但无对应 seed 的 id 视为用户新增条目（isBuiltin=false）
 */
export async function listUserPromptEntries(
  category: PromptCategory,
  ctx: { userDataPath: string },
): Promise<UserPromptEntry[]> {
  const seeds = seedsOfCategory(category);
  const seedMap = new Map(seeds.map((seed) => [seed.id, seed]));
  const dir = categoryDir(ctx.userDataPath, category);
  const fileIds = await listYamlFileIds(dir);
  const fileIdSet = new Set(fileIds);

  const result: UserPromptEntry[] = [];

  for (const seed of seeds) {
    if (!fileIdSet.has(seed.id)) {
      result.push(seedToEntry(seed));
      continue;
    }
    const raw = await readTextIfExists(entryFilePath(ctx.userDataPath, category, seed.id));
    if (!raw) {
      result.push(seedToEntry(seed));
      continue;
    }
    try {
      const parsed = parseUserPromptYaml(raw, { id: seed.id, category });
      result.push({ ...parsed, isBuiltin: true });
    } catch (err) {
      console.warn(`[user-prompts] 覆盖文件解析失败，回退 seed：${category}/${seed.id}`, err);
      result.push(seedToEntry(seed));
    }
  }

  for (const id of fileIds) {
    if (seedMap.has(id)) continue;
    const raw = await readTextIfExists(entryFilePath(ctx.userDataPath, category, id));
    if (!raw) continue;
    try {
      const parsed = parseUserPromptYaml(raw, { id, category });
      result.push({ ...parsed, isBuiltin: false });
    } catch (err) {
      console.warn(`[user-prompts] 自定义文件解析失败，已跳过：${category}/${id}`, err);
    }
  }

  return result;
}

export async function readUserPromptEntry(
  category: PromptCategory,
  id: string,
  ctx: { userDataPath: string },
): Promise<UserPromptEntry | null> {
  const safeId = sanitizeId(id);
  const seed = seedsOfCategory(category).find((s) => s.id === safeId);
  const raw = await readTextIfExists(entryFilePath(ctx.userDataPath, category, safeId));
  if (raw) {
    try {
      const parsed = parseUserPromptYaml(raw, { id: safeId, category });
      return { ...parsed, isBuiltin: Boolean(seed) };
    } catch (err) {
      console.warn(`[user-prompts] 读取解析失败：${category}/${safeId}`, err);
      if (seed) return seedToEntry(seed);
      return null;
    }
  }
  if (seed) return seedToEntry(seed);
  return null;
}

export interface WriteUserPromptInput {
  id: string;
  category: PromptCategory;
  name: string;
  description: string;
  version?: number;
  system: string;
  user: string;
  createdAt?: string;
  updatedAt?: string;
  ttsStyle?: string;
  ttsAnnotateHint?: string;
}

export async function writeUserPromptEntry(
  input: WriteUserPromptInput,
  ctx: { userDataPath: string },
): Promise<UserPromptEntry> {
  const safeId = sanitizeId(input.id);
  const filePath = entryFilePath(ctx.userDataPath, input.category, safeId);
  const now = new Date().toISOString();
  const existingRaw = await readTextIfExists(filePath);
  const createdAt = (() => {
    if (input.createdAt) return input.createdAt;
    if (!existingRaw) return now;
    try {
      const existing = parseUserPromptYaml(existingRaw, { id: safeId, category: input.category });
      return existing.createdAt ?? now;
    } catch {
      return now;
    }
  })();

  const yaml = serializeUserPromptYaml({
    name: input.name.trim(),
    description: input.description,
    version: input.version,
    system: input.system,
    user: input.user,
    createdAt,
    updatedAt: now,
    ttsStyle: input.ttsStyle,
    ttsAnnotateHint: input.ttsAnnotateHint,
  });

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, yaml, 'utf-8');

  const seed = seedsOfCategory(input.category).find((s) => s.id === safeId);
  return {
    id: safeId,
    category: input.category,
    name: input.name.trim(),
    description: input.description,
    version: input.version,
    system: input.system,
    user: input.user,
    isBuiltin: Boolean(seed),
    createdAt,
    updatedAt: now,
    ttsStyle: input.ttsStyle,
    ttsAnnotateHint: input.ttsAnnotateHint,
  };
}

/**
 * 删除语义：
 * - 自定义条目（无 seed）：删除文件，返回 { removed: true, restoredToSeed: false }
 * - 内置条目有覆盖文件：删除覆盖文件，恢复 seed，返回 { removed: true, restoredToSeed: true }
 * - 内置条目无覆盖文件：报错（不允许删除内置）
 */
export async function deleteUserPromptEntry(
  category: PromptCategory,
  id: string,
  ctx: { userDataPath: string },
): Promise<{ removed: boolean; restoredToSeed: boolean }> {
  const safeId = sanitizeId(id);
  const filePath = entryFilePath(ctx.userDataPath, category, safeId);
  const seed = seedsOfCategory(category).find((s) => s.id === safeId);

  try {
    await fs.unlink(filePath);
    return { removed: true, restoredToSeed: Boolean(seed) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (seed) {
        throw new Error(`内置模板不可删除：${category}/${safeId}`);
      }
      return { removed: false, restoredToSeed: false };
    }
    throw err;
  }
}

export function getUserPromptSeed(
  category: PromptCategory,
  id: string,
): UserPromptSeed | null {
  return seedsOfCategory(category).find((s) => s.id === id) ?? null;
}

export function assertPromptCategory(value: unknown): PromptCategory {
  if (typeof value !== 'string') throw new Error(`不合法的 prompt category：${String(value)}`);
  const ok = (PROMPT_CATEGORIES as readonly string[]).includes(value);
  if (!ok) throw new Error(`不合法的 prompt category：${value}`);
  return value as PromptCategory;
}

/**
 * 把 customTemplates[]（旧 settings.json 字段）迁移到 userData/prompts/script-template/*.yaml。
 * - 迁移成功后在 settings.json 里标记 migrations.scriptTemplateToUserPrompts = 'done'
 * - 旧字段保留不清理，防止回滚时失数据；后续版本可再清理
 * - 幂等：已标记 done 或无 customTemplates 时直接跳过
 */
export async function migrateLegacyScriptTemplates(
  ctx: { userDataPath: string },
): Promise<{ migrated: number; skipped: boolean; reason?: string }> {
  const settings: GlobalSettingsFile | null = await loadGlobalSettings(ctx.userDataPath);
  if (!settings) return { migrated: 0, skipped: true, reason: 'no-settings-file' };
  if (settings.migrations?.scriptTemplateToUserPrompts === 'done') {
    return { migrated: 0, skipped: true, reason: 'already-done' };
  }
  const legacy = Array.isArray(settings.customTemplates) ? settings.customTemplates : [];
  if (legacy.length === 0) {
    const nextSettings: GlobalSettingsFile = {
      ...settings,
      migrations: {
        ...settings.migrations,
        scriptTemplateToUserPrompts: 'done',
      },
    };
    await saveGlobalSettings(ctx.userDataPath, nextSettings);
    return { migrated: 0, skipped: true, reason: 'no-legacy-entries' };
  }

  let migrated = 0;
  for (const template of legacy as CustomScriptTemplate[]) {
    if (!template || typeof template.id !== 'string') continue;
    let safeId: string;
    try {
      safeId = sanitizeId(template.id);
    } catch (err) {
      console.warn(`[user-prompts/migrate] 跳过非法 id：${template.id}`, err);
      continue;
    }
    const targetPath = entryFilePath(ctx.userDataPath, 'script-template', safeId);
    const existing = await readTextIfExists(targetPath);
    if (existing) continue;

    const yaml = serializeUserPromptYaml({
      name: template.name ?? safeId,
      description: template.description ?? '',
      version: 1,
      system: template.systemPrompt ?? '',
      user: '{{rawText}}',
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    });
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, yaml, 'utf-8');
    migrated += 1;
  }

  const nextSettings: GlobalSettingsFile = {
    ...settings,
    migrations: {
      ...settings.migrations,
      scriptTemplateToUserPrompts: 'done',
    },
  };
  await saveGlobalSettings(ctx.userDataPath, nextSettings);
  return { migrated, skipped: false };
}

export { sanitizeId };
