import fs from 'node:fs/promises';
import path from 'node:path';
import { loadProjectFile, saveProjectSection } from '../project-file';
import type { ProjectData, ProjectSection } from '../../src/lib/project-persistence';
import type { ProductionMutationGuard } from '../../src/lib/production-mutations';
import { PIPELINE_ERROR_CODES } from './types';

export type ProjectContext =
  | { mode: 'active'; projectPath: string }
  | { mode: 'headless'; projectPath: string; headless: HeadlessProjectContext };

let activeProjectPath: string | null = null;

export function setActiveProjectPath(p: string | null): void {
  activeProjectPath = p ? path.resolve(p) : null;
}

export function getActiveProjectPath(): string | null {
  return activeProjectPath;
}

class PipelineError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

async function ensureProjectDir(projectPath: string): Promise<void> {
  try {
    const st = await fs.stat(projectPath);
    if (!st.isDirectory()) {
      throw new PipelineError(
        PIPELINE_ERROR_CODES.PROJECT_NOT_FOUND,
        `路径不是目录: ${projectPath}`,
      );
    }
  } catch (e) {
    if (e instanceof PipelineError) throw e;
    throw new PipelineError(
      PIPELINE_ERROR_CODES.PROJECT_NOT_FOUND,
      `项目目录不存在: ${projectPath}`,
    );
  }
}

export async function resolveProject(projectPath: string): Promise<ProjectContext> {
  const abs = path.resolve(projectPath);
  await ensureProjectDir(abs);
  if (activeProjectPath && abs === activeProjectPath) {
    return { mode: 'active', projectPath: abs };
  }
  return {
    mode: 'headless',
    projectPath: abs,
    headless: new HeadlessProjectContext(abs),
  };
}

export class HeadlessProjectContext {
  constructor(public readonly projectPath: string) {}

  /** 复用 electron/project-file.ts 的加载逻辑（含旧文件迁移） */
  async loadProjectData(): Promise<ProjectData> {
    return loadProjectFile(this.projectPath);
  }

  /** 经写锁按节合并 */
  async saveSection<S extends ProjectSection>(
    section: S,
    value: ProjectData[S],
    productionGuard?: ProductionMutationGuard,
  ): Promise<void> {
    await saveProjectSection(this.projectPath, section, value, productionGuard);
  }
}
