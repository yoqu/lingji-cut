import { runScriptGenerating } from '../../lib/auto-workflow';
import { DEFAULT_WORKFLOW } from '../../store/ai';
import { useTaskProgressStore } from '../../store/task-progress';
import { buildWorkflowError } from './errors';
import {
  buildPhaseOnCancel,
  buildStepLabel,
  ensureWorkflowTask,
  mapSubProgressToGlobal,
  PHASES,
} from './progress';
import { workflowSession } from './session';
import type { CancelWorkflowTask, SetWorkflow } from './types';

interface ScriptStageOptions {
  projectDir: string;
  taskId: string;
  requestId: string;
  setWorkflow: SetWorkflow;
  cancelWorkflowTask: CancelWorkflowTask;
  isStaleRun: () => boolean;
}

function startScriptProgress(options: ScriptStageOptions): void {
  const phase = PHASES.script;
  options.setWorkflow({
    step: 'script_generating', progress: mapSubProgressToGlobal(phase, 0),
    stepLabel: buildStepLabel(phase, '准备中'), error: null, canCancel: true,
  });
  ensureWorkflowTask(options.taskId, phase, {
    subPercent: 0, subMessage: '准备中', canCancel: true,
    onCancel: buildPhaseOnCancel({
      phase: 'script', requestId: options.requestId, taskId: options.taskId,
      setWorkflow: options.setWorkflow, cancelWorkflowTask: options.cancelWorkflowTask,
    }),
  });
}

function failScriptStage(options: ScriptStageOptions, error: unknown): void {
  const message = buildWorkflowError('写稿失败', error);
  options.setWorkflow({
    step: 'error', progress: 0, stepLabel: '', error: message,
    canCancel: false, failedStep: 'script_generating',
  });
  useTaskProgressStore.getState().failTask(options.taskId, message);
  workflowSession.retryStep = 'script_generating';
  workflowSession.telemetry?.event('run.end', {
    ok: false, failedStage: 'script', error: message,
  });
}

function completeScriptStage(options: ScriptStageOptions, scriptText: string): void {
  workflowSession.scriptText = scriptText;
  options.setWorkflow({
    step: 'tts_generating', progress: mapSubProgressToGlobal(PHASES.script, 100),
    stepLabel: buildStepLabel(PHASES.script, '完成'), error: null, canCancel: true,
  });
  workflowSession.retryStep = 'tts_generating';
}

export async function runScriptStage(options: ScriptStageOptions): Promise<string | null> {
  const params = workflowSession.autoParams;
  const originalText = workflowSession.originalText;
  if (!originalText.trim() || !params) {
    options.setWorkflow({
      ...DEFAULT_WORKFLOW, step: 'error', error: '自动模式缺少原始素材或参数',
      failedStep: 'script_generating',
    });
    return null;
  }
  startScriptProgress(options);
  const controller = new AbortController();
  workflowSession.abortController = controller;
  try {
    const scriptText = await runScriptGenerating({
      originalText, projectDir: options.projectDir, params, signal: controller.signal,
    });
    workflowSession.scriptText = scriptText;
    if (options.isStaleRun()) return null;
    completeScriptStage(options, scriptText);
    return scriptText;
  } catch (error) {
    if (!options.isStaleRun()) failScriptStage(options, error);
    return null;
  } finally {
    if (workflowSession.abortController === controller) workflowSession.abortController = null;
  }
}
