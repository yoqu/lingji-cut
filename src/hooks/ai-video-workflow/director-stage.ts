import {
  runAutoDirectorOrchestrator,
  type AutoDirectorProgress,
} from '../../lib/auto-director-orchestrator';
import type { AISettings } from '../../types/ai';
import { useTaskProgressStore } from '../../store/task-progress';
import { useTimelineStore } from '../../store/timeline';
import { buildWorkflowError } from './errors';
import { hydrateReusablePodcastMedia } from './podcast-media';
import {
  averageTrackProgress,
  buildStepLabel,
  ensureWorkflowTask,
  mapSubProgressToGlobal,
  PHASES,
} from './progress';
import { sessionProductionMode, workflowSession } from './session';
import type { SetWorkflow } from './types';

interface DirectorStageOptions {
  startAt: 'director' | 'production';
  projectDir: string;
  taskId: string;
  settings: AISettings;
  setWorkflow: SetWorkflow;
  isStaleRun: () => boolean;
}

function startDirectorProgress(options: DirectorStageOptions): void {
  const phase = options.startAt === 'director' ? PHASES.analyze : PHASES.arrange;
  const step = options.startAt === 'director' ? 'director_planning' : 'production_running';
  const message = options.startAt === 'director' ? '分析内容结构' : '恢复缺失制作项';
  options.setWorkflow({
    step, progress: phase.baseStart, stepLabel: buildStepLabel(phase, message),
    error: null, canCancel: options.startAt === 'production',
  });
  ensureWorkflowTask(options.taskId, phase, {
    subPercent: 0, subMessage: message,
    canCancel: options.startAt === 'production', onCancel: undefined,
  });
}

function buildProgressHandler(options: DirectorStageOptions): (event: AutoDirectorProgress) => void {
  const tracks: Partial<Record<string, number>> = {};
  return (event) => {
    if (options.isStaleRun()) return;
    const key = event.phase === 'director' ? 'director' : event.track;
    tracks[key] = event.percent;
    const phase = event.phase === 'director' ? PHASES.analyze : PHASES.arrange;
    const progress = mapSubProgressToGlobal(phase, averageTrackProgress(tracks));
    const step = event.phase === 'director' ? 'director_planning' : 'production_running';
    options.setWorkflow({
      step, progress, stepLabel: buildStepLabel(phase, event.message),
      canCancel: event.phase === 'production',
    });
    useTaskProgressStore.getState().updateTask(options.taskId, {
      progress, phase: event.message, canCancel: event.phase === 'production',
    });
  };
}

function finishDirectorReview(options: DirectorStageOptions, revision?: number): void {
  options.setWorkflow({
    step: 'director_review', progress: mapSubProgressToGlobal(PHASES.analyze, 100),
    stepLabel: '导演方案已就绪，批准后才会开始生成画面、封面和声音',
    error: null, canCancel: false,
  });
  useTaskProgressStore.getState().updateTask(options.taskId, { label: '导演方案等待批准' });
  useTaskProgressStore.getState().completeTask(options.taskId);
  workflowSession.telemetry?.event('checkpoint.waiting', {
    checkpoint: 'director-review', taskId: options.taskId, directorRevision: revision,
  });
  workflowSession.telemetry?.event('run.end', { ok: true, awaitingDirectorReview: true });
}

function finishProduction(options: DirectorStageOptions, awaitingAnimatic: boolean): void {
  options.setWorkflow({
    step: awaitingAnimatic ? 'animatic_review' : 'done', progress: 100,
    stepLabel: awaitingAnimatic ? 'Animatic 已生成，请进入编辑器确认' : '视频草稿已准备完成',
    error: null, canCancel: false,
  });
  useTaskProgressStore.getState().updateTask(options.taskId, {
    label: awaitingAnimatic ? 'Animatic 等待确认' : '视频草稿已准备完成',
  });
  useTaskProgressStore.getState().completeTask(options.taskId);
  workflowSession.telemetry?.event('run.end', {
    ok: true, awaitingAnimaticReview: awaitingAnimatic,
  });
}

async function failDirectorStage(options: DirectorStageOptions, error: unknown): Promise<void> {
  const directorStage = options.startAt === 'director';
  const message = buildWorkflowError(
    directorStage ? '导演方案生成失败' : '制作执行失败', error,
  );
  const failedStep = directorStage ? 'director_planning' : 'production_running';
  options.setWorkflow({
    step: 'error', progress: 0, stepLabel: '', error: message,
    canCancel: false, failedStep,
  });
  useTaskProgressStore.getState().failTask(options.taskId, message);
  workflowSession.retryStep = failedStep;
  await window.electronAPI.mutateProjectProduction(options.projectDir, {
    kind: 'set-workflow', stage: 'error', error: message,
    expectedTaskId: options.taskId,
  }).catch(() => undefined);
  workflowSession.telemetry?.event('run.end', {
    ok: false, failedStage: directorStage ? 'director.plan' : 'production', error: message,
  });
}

export async function runDirectorStage(options: DirectorStageOptions): Promise<void> {
  startDirectorProgress(options);
  try {
    await hydrateReusablePodcastMedia();
    const result = await runAutoDirectorOrchestrator({
      projectDir: options.projectDir,
      entries: useTimelineStore.getState().srtEntries,
      settings: options.settings, taskId: options.taskId,
      mode: sessionProductionMode(), startAt: options.startAt,
      telemetryRunId: workflowSession.telemetryRunId,
      shouldCancel: options.isStaleRun,
      onProgress: buildProgressHandler(options),
    });
    if (options.isStaleRun()) return;
    if (result.checkpoint === 'director-review') {
      finishDirectorReview(options, result.production.draftPlan?.revision);
      return;
    }
    finishProduction(options, result.checkpoint === 'animatic-review');
  } catch (error) {
    if (!options.isStaleRun()) await failDirectorStage(options, error);
  }
}
