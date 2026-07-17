import type { SrtEntry } from '../types';
import type { AISettings } from '../types/ai';
import type { ProjectData } from './project-persistence';
import { createEmptyProductionState } from './director-workflow';
import { useAIStore } from '../store/ai';
import type { ProjectProductionState } from '../types/director';

interface RequestDirectorPlanOptions {
  projectDir: string;
  entries: SrtEntry[];
  settings: AISettings;
  taskId: string;
  telemetryRunId?: string;
  onProgress?: (percent: number, message: string) => void;
}

export async function requestDirectorPlan(
  options: RequestDirectorPlanOptions,
): Promise<ProjectProductionState> {
  const raw = await window.electronAPI.loadProject(options.projectDir);
  const current = (JSON.parse(raw) as ProjectData).production ?? createEmptyProductionState();
  const revision = current.draftPlan?.revision ?? (current.approvedPlan?.revision ?? 0) + 1;
  const off = window.electronAPI.onDirectorPlanProgress((event) => {
    if (event.taskId !== options.taskId || event.directorRevision !== revision) return;
    const percent = event.phase === 'planning'
      ? Math.round(event.percent * 0.65)
      : 65 + Math.round(event.percent * 0.35);
    options.onProgress?.(
      percent,
      event.phase === 'planning' ? '分析内容结构' : '制定 Motion Bible',
    );
  });
  try {
    return await window.electronAPI.startDirectorPlan({
      taskId: options.taskId,
      directorRevision: revision,
      entries: options.entries,
      settings: options.settings,
      projectDir: options.projectDir,
      projectBindings: useAIStore.getState().projectBindings,
      telemetryRunId: options.telemetryRunId,
      mode: 'director',
    });
  } finally {
    off();
  }
}
