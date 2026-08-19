import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createDefaultProjectData,
  extractMetaSection,
  extractPublishSection,
  migrateProjectData,
  mergeProjectSection,
  type ProjectData,
  type ProjectSection,
} from '../src/lib/project-persistence';
import {
  dehydrateTimelineCards,
  hydrateTimelineCards,
} from '../src/lib/motion-card-externalize';
import type { TimelineData } from '../src/types';
import { markSelfWrite } from './ai-edit/self-write-guard';
import type { ProjectProductionState } from '../src/types/director';
import { createEmptyProductionState } from '../src/lib/director-workflow';
import {
  applyProductionMutation,
  assertProductionMutationGuard,
  normalizeProductionStateInvariant,
  type ProductionMutation,
  type ProductionMutationGuard,
} from '../src/lib/production-mutations';

const PROJECT_FILE = 'project.json';

// per-projectDir 写锁：Promise 链序列化
const writeLocks = new Map<string, Promise<unknown>>();

function withWriteLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(projectDir) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeLocks.set(projectDir, next);
  // 无论成败都清理锁；用同一 handler 处理 reject，避免 fn 抛错时产生未处理的 rejection。
  const cleanup = () => {
    if (writeLocks.get(projectDir) === next) {
      writeLocks.delete(projectDir);
    }
  };
  void next.then(cleanup, cleanup);
  return next;
}

/**
 * 读取并分类 project.json 的状态：
 * - ok：成功解析
 * - absent：文件不存在（可安全创建默认工程）
 * - corrupt：文件存在但读取/解析失败（torn write / 并发写 / 损坏）
 *
 * 关键：corrupt 必须与 absent 区分。历史上二者都被当作 null 处理，
 * 导致一旦读取失败就回退默认工程并覆盖写回，把 timeline 等其它段全部清空。
 */
type ProjectReadResult =
  | { status: 'ok'; data: ProjectData }
  | { status: 'absent' }
  | { status: 'corrupt'; raw: string | null; error: unknown };

async function readProjectJsonClassified(projectDir: string): Promise<ProjectReadResult> {
  const filePath = path.join(projectDir, PROJECT_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { status: 'absent' };
    }
    // 其它读取错误（权限/IO）按损坏处理，绝不静默重置
    return { status: 'corrupt', raw: null, error };
  }
  try {
    return { status: 'ok', data: JSON.parse(raw) as ProjectData };
  } catch (error) {
    return { status: 'corrupt', raw, error };
  }
}

/**
 * 把损坏的 project.json 原文备份到 project.json.corrupt-<ts>.bak，
 * 以便后续人工/工具恢复，绝不在未备份的情况下覆盖损坏文件。
 */
async function backupCorruptProjectFile(projectDir: string, raw: string | null): Promise<string | null> {
  if (raw == null) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(projectDir, `${PROJECT_FILE}.corrupt-${ts}.bak`);
  try {
    await fs.writeFile(backupPath, raw, 'utf-8');
    return backupPath;
  } catch {
    return null;
  }
}

async function backupLegacyProjectFile(projectDir: string, raw: string): Promise<string> {
  let version = 'legacy';
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'number') version = `v${parsed.version}`;
  } catch {
    // 原文已由调用方成功解析；这里只为备份名兜底。
  }
  const backupPath = path.join(projectDir, `project.${version}.backup.json`);
  try {
    await fs.access(backupPath);
  } catch {
    await fs.writeFile(backupPath, raw, { encoding: 'utf-8', flag: 'wx' }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
  }
  return backupPath;
}

class ProjectFileCorruptError extends Error {
  constructor(public readonly projectDir: string, public readonly backupPath: string | null, cause: unknown) {
    super(
      `project.json 读取失败（疑似损坏或并发写入），已中止以避免覆盖数据。` +
        (backupPath ? `原文已备份到 ${backupPath}。` : '') +
        ` 原始错误：${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'ProjectFileCorruptError';
  }
}

async function writeProjectJson(projectDir: string, data: ProjectData): Promise<void> {
  await fs.mkdir(projectDir, { recursive: true });
  const abs = path.resolve(projectDir, PROJECT_FILE);
  const jsonStr = JSON.stringify(data, null, 2);
  // 原子写：先写临时文件再 rename。rename 在同一文件系统上是原子操作，
  // 杜绝「截断后写入」期间被其它进程（如独立的 lingji CLI）读到半截 JSON 而判定损坏。
  const tmp = `${abs}.tmp-${process.pid}`;
  await fs.writeFile(tmp, jsonStr, 'utf-8');
  try {
    await fs.rename(tmp, abs);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  // 记录自写内容：chokidar 监听到同内容变更时识别为自身回声并跳过转发，打断 autosave↔watch 回环。
  markSelfWrite(abs, jsonStr);
}

/** projectDir 绑定的卡片源码 IO 适配器（相对路径 → 项目目录下绝对路径）。 */
function cardIo(projectDir: string) {
  return {
    writeFile: async (rel: string, content: string) => {
      const abs = path.resolve(projectDir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf-8');
      // 记录自写内容（卡片 tsx），见 markSelfWrite 说明。
      markSelfWrite(abs, content);
    },
    readFile: async (rel: string): Promise<string | null> => {
      try {
        return await fs.readFile(path.join(projectDir, rel), 'utf-8');
      } catch {
        return null;
      }
    },
  };
}

/**
 * 清理旧工程中已经失效的 AI 字段与制作中间态。非 production-running
 * 阶段不能保留 generating，否则重启后导演台会一直显示上一任务仍在保存。
 */
function normalizeProjectData(data: ProjectData): ProjectData {
  const currentAI = data.aiAnalysis;
  const legacyExtras =
    !currentAI ||
    'motionCards' in currentAI ||
    'storyboardPlan' in currentAI ||
    currentAI.analysisResult === undefined ||
    currentAI.coverCandidates === undefined;
  const production = data.production
    ? normalizeProductionStateInvariant(data.production, data.production.workflow.updatedAt)
    : undefined;
  const repairedProduction = production !== data.production;
  if (!legacyExtras && !repairedProduction) return data;
  return {
    ...data,
    ...(legacyExtras ? {
      aiAnalysis: {
        analysisResult: currentAI?.analysisResult ?? null,
        coverCandidates: currentAI?.coverCandidates ?? [],
      },
    } : {}),
    ...(repairedProduction ? { production } : {}),
  };
}

/**
 * 加载项目文件：
 * 1. 若 project.json 存在，直接读取
 * 2. 否则创建默认 ProjectData 并写入
 */
async function loadProjectFileRaw(projectDir: string): Promise<ProjectData> {
  const read = await readProjectJsonClassified(projectDir);
  if (read.status === 'ok') {
    const migrated = migrateProjectData(read.data);
    const normalized = normalizeProjectData(migrated.data);
    const repairedProduction = normalized.production !== migrated.data.production;
    if (migrated.migrated || repairedProduction) {
      if (migrated.migrated) {
        const raw = await fs.readFile(path.join(projectDir, PROJECT_FILE), 'utf-8');
        await backupLegacyProjectFile(projectDir, raw);
      }
      await writeProjectJson(projectDir, normalized);
    }
    return normalized;
  }
  if (read.status === 'corrupt') {
    // 文件存在但损坏：备份原文并抛错，绝不用默认工程覆盖（否则丢失全部数据）。
    const backupPath = await backupCorruptProjectFile(projectDir, read.raw);
    throw new ProjectFileCorruptError(projectDir, backupPath, read.error);
  }

  const data = createDefaultProjectData();
  await writeProjectJson(projectDir, data);
  return data;
}

/**
 * 加载项目数据并据 tsxPath 把外置卡片源码读回内存（hydrate）。
 * 旧工程内嵌 tsx 的卡片会在 hydrate 时回填 tsxPath（再次落盘由 dehydrate 写出独立文件）。
 */
export async function loadProjectFile(projectDir: string): Promise<ProjectData> {
  const data = await loadProjectFileRaw(projectDir);
  if (data.timeline) {
    data.timeline = await hydrateTimelineCards(data.timeline, cardIo(projectDir));
  }
  return data;
}

/** 在同一项目写锁内读取最新 production、应用判别式 mutation 并原子回写。 */
export async function mutateProjectProduction(
  projectDir: string,
  mutation: ProductionMutation,
  validateCurrent?: (project: ProjectData) => void,
): Promise<ProjectProductionState> {
  return withWriteLock(projectDir, async () => {
    const read = await readProjectJsonClassified(projectDir);
    if (read.status === 'corrupt') {
      const backupPath = await backupCorruptProjectFile(projectDir, read.raw);
      throw new ProjectFileCorruptError(projectDir, backupPath, read.error);
    }
    const current = read.status === 'ok'
      ? migrateProjectData(read.data).data
      : createDefaultProjectData();
    validateCurrent?.(current);
    const rawBase = current.production ?? createEmptyProductionState();
    const base = normalizeProductionStateInvariant(rawBase, rawBase.workflow.updatedAt);
    const production = applyProductionMutation(base, mutation);
    const withProduction = mergeProjectSection(current, 'production', production);
    const draft = mutation.kind === 'replace-draft' ? production.draftPlan : null;
    const workTitle = mutation.kind === 'replace-draft' ? mutation.plan.title?.trim() : undefined;
    const publish = extractPublishSection(current);
    const next = draft && workTitle
      ? {
          ...withProduction,
          meta: { ...extractMetaSection(current), title: workTitle },
          publish: {
            ...publish,
            title: workTitle,
            desc: publish.desc.trim() || draft.summary.trim(),
          },
        }
      : withProduction;
    await writeProjectJson(projectDir, next);
    return production;
  });
}

/**
 * 保存项目某一段数据，通过写锁保证并发安全。
 * Web Card 路径已下线，所有卡片走 Motion Card（JSX → Babel 编译 → 运行时沙箱），
 * 源码直接内嵌在 project.json，不再需要把 srcDoc 写到磁盘。
 */
export async function saveProjectSection(
  projectDir: string,
  section: ProjectSection,
  value: unknown,
  productionGuard?: ProductionMutationGuard,
): Promise<void> {
  let nextValue = value;
  if (section === 'production') {
    const production = typeof value === 'string' ? JSON.parse(value) : value;
    if (!production || (production as { version?: unknown }).version !== 3) {
      throw new Error('production_schema_invalid：production 只能写入 V3 ProjectProductionState');
    }
    nextValue = production;
  }
  if (section === 'timeline' && value) {
    const timeline = typeof value === 'string' ? JSON.parse(value) : value;
    if (timeline) {
      const dehydrated = await dehydrateTimelineCards(
        timeline as TimelineData,
        cardIo(projectDir),
      );
      nextValue = dehydrated; // 传对象给 merge（卡片 tsx 已外置）
    }
  }
  return withWriteLock(projectDir, async () => {
    const read = await readProjectJsonClassified(projectDir);
    if (read.status === 'corrupt') {
      // 读取失败时绝不回退默认工程后写回——那会把 timeline 等其它段清空。
      // 备份损坏原文并中止本次保存，保留磁盘现状等待恢复。
      const backupPath = await backupCorruptProjectFile(projectDir, read.raw);
      throw new ProjectFileCorruptError(projectDir, backupPath, read.error);
    }
    // 仅当文件确实不存在时才用默认工程作为基底。
    let current = read.status === 'ok' ? read.data : createDefaultProjectData();
    const migrated = migrateProjectData(current);
    if (read.status === 'ok' && migrated.migrated) {
      const raw = await fs.readFile(path.join(projectDir, PROJECT_FILE), 'utf-8');
      await backupLegacyProjectFile(projectDir, raw);
    }
    current = migrated.data;
    if (productionGuard) {
      assertProductionMutationGuard(
        current.production ?? createEmptyProductionState(),
        productionGuard,
      );
    }
    const merged = mergeProjectSection(
      current,
      section,
      nextValue as ProjectData[typeof section],
    );
    await writeProjectJson(projectDir, merged);
  });
}
