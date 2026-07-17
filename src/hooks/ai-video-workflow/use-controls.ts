import { useCallback } from 'react';
import type { WorkflowState, WorkflowStep } from '../../store/ai';
import { getProjectDir } from '../../store/timeline';
import { runWorkflowFromStep } from './runner';
import { prepareWorkflowStart, workflowSession } from './session';
import type {
  CancelWorkflowTask,
  SetWorkflow,
  WorkflowStartOptions,
} from './types';

type ResetWorkflow = () => void;
type RunFromStep = (step: WorkflowStep, scriptText: string, projectDir: string) => Promise<void>;

function useRunFromStep(
  setWorkflow: SetWorkflow,
  cancelWorkflowTask: CancelWorkflowTask,
): RunFromStep {
  return useCallback(
    async (fromStep, scriptText, projectDir) => {
      await runWorkflowFromStep({
        fromStep, scriptText, projectDir, setWorkflow, cancelWorkflowTask,
      });
    },
    [cancelWorkflowTask, setWorkflow],
  );
}

function useStart(runFromStep: RunFromStep) {
  return useCallback(
    async (scriptText: string, options?: WorkflowStartOptions) => {
      const prepared = await prepareWorkflowStart(scriptText, options);
      void runFromStep(
        prepared.initialStep, prepared.scriptText, prepared.projectDir,
      );
    },
    [runFromStep],
  );
}

function pauseProduction(setWorkflow: SetWorkflow, taskId: string): void {
  void window.electronAPI.cancelProduction(
    workflowSession.projectDir,
    taskId || undefined,
  ).catch(() => undefined);
  setWorkflow({
    step: 'production_paused', stepLabel: '制作已暂停，已完成产物会保留',
    canCancel: false, error: null,
  });
}

function useCancel(
  workflowStep: WorkflowState['step'],
  setWorkflow: SetWorkflow,
  resetWorkflow: ResetWorkflow,
  cancelWorkflowTask: CancelWorkflowTask,
) {
  return useCallback(() => {
    const requestId = workflowSession.requestId;
    const taskId = workflowSession.taskId;
    workflowSession.cancelled = true;
    workflowSession.abortController?.abort();
    if (requestId) void window.electronAPI.cancelTTS(requestId);
    if (taskId) cancelWorkflowTask(taskId, '任务已取消');
    const productionPaused = workflowStep === 'production_running';
    if (productionPaused && workflowSession.projectDir) {
      pauseProduction(setWorkflow, taskId);
    } else {
      resetWorkflow();
    }
    workflowSession.telemetry?.event('run.end', {
      ok: false, cancelled: true, productionPaused,
    });
  }, [cancelWorkflowTask, resetWorkflow, setWorkflow, workflowStep]);
}

function useRetry(runFromStep: RunFromStep) {
  return useCallback(() => {
    workflowSession.cancelled = false;
    if (!workflowSession.requestId || workflowSession.retryStep === 'tts_generating') {
      workflowSession.requestId = crypto.randomUUID();
    }
    workflowSession.taskId = `ai-workflow-${Date.now()}`;
    if (!workflowSession.projectDir) workflowSession.projectDir = getProjectDir() ?? '';
    void runFromStep(
      workflowSession.retryStep, workflowSession.scriptText, workflowSession.projectDir,
    );
  }, [runFromStep]);
}

function useContinueFromTtsDone(runFromStep: RunFromStep) {
  return useCallback((projectDir?: string) => {
    workflowSession.cancelled = false;
    workflowSession.pauseAfterTts = false;
    workflowSession.projectDir = projectDir
      || workflowSession.projectDir
      || getProjectDir()
      || '';
    if (!workflowSession.taskId) workflowSession.taskId = `ai-workflow-${Date.now()}`;
    void runFromStep(
      'ai_analyzing', workflowSession.scriptText, workflowSession.projectDir,
    );
  }, [runFromStep]);
}

export function useWorkflowControls(
  workflowStep: WorkflowState['step'],
  setWorkflow: SetWorkflow,
  resetWorkflow: ResetWorkflow,
  cancelWorkflowTask: CancelWorkflowTask,
) {
  const runFromStep = useRunFromStep(setWorkflow, cancelWorkflowTask);
  return {
    start: useStart(runFromStep),
    cancel: useCancel(workflowStep, setWorkflow, resetWorkflow, cancelWorkflowTask),
    retry: useRetry(runFromStep),
    continueFromTtsDone: useContinueFromTtsDone(runFromStep),
  };
}
