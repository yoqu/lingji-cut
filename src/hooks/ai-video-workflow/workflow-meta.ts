import {
  DEFAULT_WORKFLOW_META,
  type ProjectData,
  type ProjectWorkflowMeta,
} from '../../lib/project-persistence';

async function loadWorkflowMeta(projectDir: string): Promise<ProjectWorkflowMeta> {
  try {
    const raw = await window.electronAPI.loadProject(projectDir);
    const parsed = JSON.parse(raw) as ProjectData;
    return { ...DEFAULT_WORKFLOW_META, ...(parsed.workflowMeta ?? {}) };
  } catch {
    return { ...DEFAULT_WORKFLOW_META };
  }
}

export async function patchWorkflowMeta(
  projectDir: string,
  patch: Partial<ProjectWorkflowMeta>,
): Promise<void> {
  if (!projectDir) return;
  const next = { ...(await loadWorkflowMeta(projectDir)), ...patch };
  try {
    await window.electronAPI.saveProjectSection(
      projectDir,
      'workflowMeta',
      JSON.stringify(next),
    );
  } catch {
    // 工作流元数据只用于恢复提示，持久化失败不阻断制作。
  }
}
