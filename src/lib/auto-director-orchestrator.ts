import type { SrtEntry } from '../types';
import type { AISettings } from '../types/ai';
import type { ProjectData } from './project-persistence';
import type { ProjectProductionState } from '../types/director';
import { createEmptyProductionState } from './director-workflow';
import { useAIStore } from '../store/ai';
import { createAutoRunTelemetry } from './telemetry/auto-run';
import {
  runDirectorProductionClient,
  type DirectorProductionProgress,
} from './director-production-client';

export type AutoDirectorProgress =
  | { phase: 'director'; percent: number; message: string }
  | ({ phase: 'production' } & DirectorProductionProgress);

export interface AutoDirectorOrchestratorOptions {
  projectDir: string;
  entries: SrtEntry[];
  settings: AISettings;
  taskId: string;
  mode: 'auto' | 'director';
  startAt: 'director' | 'production';
  /** 缺省为 true；false 时新生成的导演方案关闭背景音乐。 */
  bgmEnabled?: boolean;
  telemetryRunId?: string;
  onProgress?: (progress: AutoDirectorProgress) => void;
  shouldCancel?: () => boolean;
}

export type AutoDirectorOrchestratorResult =
  | { checkpoint: 'director-review'; production: ProjectProductionState }
  | { checkpoint: 'animatic-review' | 'complete'; production: ProjectProductionState };

async function loadProduction(projectDir: string): Promise<ProjectProductionState> {
  const raw = await window.electronAPI.loadProject(projectDir);
  return (JSON.parse(raw) as ProjectData).production ?? createEmptyProductionState();
}

function nextRevision(production: ProjectProductionState): number {
  return production.draftPlan?.revision ?? (production.approvedPlan?.revision ?? 0) + 1;
}

async function createPlan(
  options: AutoDirectorOrchestratorOptions,
): Promise<ProjectProductionState> {
  const current = await loadProduction(options.projectDir);
  const revision = nextRevision(current);
  const off = window.electronAPI.onDirectorPlanProgress((event) => {
    if (event.taskId !== options.taskId || event.directorRevision !== revision) return;
    options.onProgress?.({
      phase: 'director',
      percent: event.phase === 'planning'
        ? Math.round(event.percent * 0.65)
        : 65 + Math.round(event.percent * 0.35),
      message: event.phase === 'planning' ? '分析内容结构' : '制定 Motion Bible',
    });
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
      mode: options.mode,
      bgmEnabled: options.bgmEnabled,
    });
  } finally {
    off();
  }
}

async function ensureApproved(
  options: AutoDirectorOrchestratorOptions,
): Promise<AutoDirectorOrchestratorResult | ProjectProductionState> {
  let production = options.startAt === 'director'
    ? await createPlan(options)
    : await loadProduction(options.projectDir);

  const shouldReviewDraft = options.startAt === 'director' || !production.approvedPlan;
  if (shouldReviewDraft) {
    if (!production.draftPlan) production = await createPlan(options);
    if (options.mode === 'director') return { checkpoint: 'director-review', production };
    production = await window.electronAPI.approveDirectorPlanAndStartProduction(
      options.projectDir,
      production.draftPlan!.revision,
      options.taskId,
    );
    if (options.telemetryRunId) {
      createAutoRunTelemetry(options.telemetryRunId).event('checkpoint.auto-approved', {
        checkpoint: 'director-review',
        taskId: options.taskId,
        directorRevision: production.approvedPlan?.revision,
      });
    }
  } else if (
    production.workflow.stage !== 'production-running'
    || production.workflow.activeTaskId !== options.taskId
    || production.workflow.mode !== options.mode
  ) {
    production = await window.electronAPI.resumeProduction(
      options.projectDir,
      options.taskId,
      options.mode,
    );
  }
  return production;
}

export async function runAutoDirectorOrchestrator(
  options: AutoDirectorOrchestratorOptions,
): Promise<AutoDirectorOrchestratorResult> {
  if (options.startAt === 'production' && options.telemetryRunId) {
    createAutoRunTelemetry(options.telemetryRunId).event('production.resume', {
      taskId: options.taskId,
      mode: options.mode,
    });
  }
  const ready = await ensureApproved(options);
  if ('checkpoint' in ready) return ready;
  const production = await runDirectorProductionClient({
    projectDir: options.projectDir,
    production: ready,
    entries: options.entries,
    settings: options.settings,
    taskId: options.taskId,
    telemetryRunId: options.telemetryRunId,
    shouldCancel: options.shouldCancel,
    onProgress: (progress) => options.onProgress?.({ phase: 'production', ...progress }),
  });
  return {
    checkpoint: production.workflow.stage === 'animatic-review' ? 'animatic-review' : 'complete',
    production,
  };
}
