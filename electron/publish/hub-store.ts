import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  formatPublishMaterialsMarkdown,
  parseHubJobState,
  parseHubJobsCatalog,
  summarizeHubJob,
  type HubJobState,
  type HubJobSummary,
  type HubJobsCatalog,
} from '../../src/lib/publish/hub-state';

const JOBS_FILE = 'jobs.json';
const PUBLISH_RELATIVE = path.join('.lingji', 'publish.json');
const MATERIALS_NAME = '发布物料.md';

function jobsPath(userDataPath: string): string {
  return path.join(userDataPath, 'publish', JOBS_FILE);
}

async function atomicWrite(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, data, 'utf-8');
  await rename(tmp, file);
}

export async function loadHubCatalog(userDataPath: string): Promise<HubJobsCatalog> {
  try {
    const raw = JSON.parse(await readFile(jobsPath(userDataPath), 'utf-8')) as unknown;
    return parseHubJobsCatalog(raw);
  } catch {
    return { jobs: [] };
  }
}

export async function saveHubCatalog(userDataPath: string, catalog: HubJobsCatalog): Promise<void> {
  await atomicWrite(jobsPath(userDataPath), JSON.stringify(catalog, null, 2));
}

export function publishStatePath(workDir: string): string {
  return path.join(workDir, PUBLISH_RELATIVE);
}

export async function loadHubJobState(workDir: string): Promise<HubJobState> {
  try {
    const raw = JSON.parse(await readFile(publishStatePath(workDir), 'utf-8')) as unknown;
    return parseHubJobState(raw);
  } catch {
    return parseHubJobState(null);
  }
}

export async function saveHubJobState(workDir: string, state: HubJobState): Promise<void> {
  await atomicWrite(publishStatePath(workDir), JSON.stringify(state, null, 2));
  const materials = path.join(workDir, MATERIALS_NAME);
  try {
    await readFile(materials, 'utf-8');
    await writeFile(materials, formatPublishMaterialsMarkdown(state.draft), 'utf-8');
  } catch {
    // 没有物料文件就不创建，避免把该文件名当成准入条件。
  }
}

function upsertSummary(jobs: HubJobSummary[], summary: HubJobSummary): HubJobSummary[] {
  const rest = jobs.filter((job) => path.resolve(job.workDir) !== path.resolve(summary.workDir));
  return [summary, ...rest];
}

export async function addHubJob(userDataPath: string, workDir: string): Promise<HubJobSummary> {
  const resolved = path.resolve(workDir);
  const state = await loadHubJobState(resolved);
  const summary = summarizeHubJob(resolved, state);
  const catalog = await loadHubCatalog(userDataPath);
  await saveHubCatalog(userDataPath, { jobs: upsertSummary(catalog.jobs, summary) });
  return summary;
}

export async function removeHubJob(userDataPath: string, workDir: string): Promise<HubJobsCatalog> {
  const resolved = path.resolve(workDir);
  const catalog = await loadHubCatalog(userDataPath);
  const next = { jobs: catalog.jobs.filter((job) => path.resolve(job.workDir) !== resolved) };
  await saveHubCatalog(userDataPath, next);
  return next;
}

export async function touchHubJob(userDataPath: string, workDir: string, state: HubJobState): Promise<HubJobSummary> {
  const summary = summarizeHubJob(path.resolve(workDir), state);
  const catalog = await loadHubCatalog(userDataPath);
  await saveHubCatalog(userDataPath, { jobs: upsertSummary(catalog.jobs, summary) });
  return summary;
}
