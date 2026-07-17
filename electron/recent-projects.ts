import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { resolvePublishedPlatforms, type ProjectData } from '../src/lib/project-persistence';
import { loadProjectFile } from './project-file';

/** 项目所处阶段（欢迎页标签）：已发布 > 剪辑中 > 口播稿 > 原稿 > 新建。 */
export type RecentProjectStage = 'published' | 'editing' | 'script' | 'original' | 'new';

export interface RecentProjectEntry {
  path: string;
  name: string;
  lastOpenedAt: number;
  createdAt?: string;
  updatedAt?: string;
  coverImageUrl?: string;
  stage?: RecentProjectStage;
  /** 已成功发布的平台 id（stage 为 published 时非空）。 */
  publishedPlatforms?: string[];
}

function fileHasContent(filePath: string): boolean {
  try {
    return statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

/** 从 project.json 与磁盘产物推导项目阶段。 */
export function deriveProjectStage(
  projectDir: string,
  projectData: ProjectData | null,
): Pick<RecentProjectEntry, 'stage' | 'publishedPlatforms'> {
  if (projectData) {
    const published = Object.keys(resolvePublishedPlatforms(projectData));
    if (published.length > 0) {
      return { stage: 'published', publishedPlatforms: published };
    }
    if (projectData.timeline) return { stage: 'editing' };
  }
  if (fileHasContent(path.join(projectDir, 'script.md'))) return { stage: 'script' };
  if (fileHasContent(path.join(projectDir, 'original.md'))) return { stage: 'original' };
  return { stage: 'new' };
}

const RECENT_PROJECTS_FILE = 'recent-projects.json';
const MAX_RECENT_PROJECTS = 20;

export async function loadRecentProjects(
  userDataPath: string,
): Promise<RecentProjectEntry[]> {
  try {
    const raw = await fs.readFile(
      path.join(userDataPath, RECENT_PROJECTS_FILE),
      'utf-8',
    );
    const parsed = JSON.parse(raw) as RecentProjectEntry[];
    // 过滤掉无效条目
    return parsed.filter((p) => Boolean(p?.path) && existsSync(p.path));
  } catch {
    return [];
  }
}

export async function saveRecentProjects(
  userDataPath: string,
  projects: RecentProjectEntry[],
): Promise<void> {
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(
    path.join(userDataPath, RECENT_PROJECTS_FILE),
    JSON.stringify(projects, null, 2),
    'utf-8',
  );
}

export async function addRecentProject(
  userDataPath: string,
  projectDir: string,
  projectName?: string,
): Promise<RecentProjectEntry[]> {
  const existing = await loadRecentProjects(userDataPath);
  const now = Date.now();

  // 加载项目数据获取封面和时间信息
  let projectData: ProjectData | null = null;
  try {
    projectData = await loadProjectFile(projectDir);
  } catch {
    // 忽略加载失败
  }

  // 查找选中的封面
  let coverImageUrl: string | undefined;
  if (projectData?.aiAnalysis?.coverCandidates) {
    const selectedCover = projectData.aiAnalysis.coverCandidates.find(
      (c) => c.selected && c.imageUrl,
    );
    coverImageUrl = selectedCover?.imageUrl;
  }

  const entry: RecentProjectEntry = {
    path: projectDir,
    name: projectName || path.basename(projectDir),
    lastOpenedAt: now,
    createdAt: projectData?.createdAt,
    updatedAt: projectData?.updatedAt,
    coverImageUrl,
    ...deriveProjectStage(projectDir, projectData),
  };

  // 移除已存在的同路径项目，添加到开头
  const filtered = existing.filter((p) => p.path !== projectDir);
  const nextProjects = [entry, ...filtered].slice(0, MAX_RECENT_PROJECTS);

  await saveRecentProjects(userDataPath, nextProjects);
  return nextProjects;
}

export async function removeRecentProject(
  userDataPath: string,
  projectDir: string,
): Promise<RecentProjectEntry[]> {
  const existing = await loadRecentProjects(userDataPath);
  const filtered = existing.filter((p) => p.path !== projectDir);
  await saveRecentProjects(userDataPath, filtered);
  return filtered;
}

export async function refreshRecentProjects(
  userDataPath: string,
): Promise<RecentProjectEntry[]> {
  const existing = await loadRecentProjects(userDataPath);
  const refreshed: RecentProjectEntry[] = [];

  for (const entry of existing) {
    if (!existsSync(entry.path)) {
      continue;
    }

    // 重新加载项目数据获取最新信息
    let projectData: ProjectData | null = null;
    try {
      projectData = await loadProjectFile(entry.path);
    } catch {
      // 忽略加载失败
    }

    let coverImageUrl: string | undefined;
    if (projectData?.aiAnalysis?.coverCandidates) {
      const selectedCover = projectData.aiAnalysis.coverCandidates.find(
        (c) => c.selected && c.imageUrl,
      );
      coverImageUrl = selectedCover?.imageUrl;
    }

    const { stage, publishedPlatforms } = deriveProjectStage(entry.path, projectData);
    refreshed.push({
      ...entry,
      createdAt: projectData?.createdAt ?? entry.createdAt,
      updatedAt: projectData?.updatedAt ?? entry.updatedAt,
      coverImageUrl,
      stage,
      publishedPlatforms,
    });
  }

  await saveRecentProjects(userDataPath, refreshed);
  return refreshed;
}
