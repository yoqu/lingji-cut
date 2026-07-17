import type { WorkflowStep } from '../../store/ai';
import { runDirectorStage } from './director-stage';
import { runScriptStage } from './script-stage';
import { workflowSession } from './session';
import { runTtsStage } from './tts-stage';
import type { WorkflowRunRequest } from './types';
import {
  loadWorkflowPrerequisites,
  type WorkflowPrerequisites,
} from './validation';

interface ActiveRun extends WorkflowRunRequest {
  taskId: string;
  requestId: string;
  isStaleRun: () => boolean;
}

function createActiveRun(request: WorkflowRunRequest): ActiveRun {
  const taskId = workflowSession.taskId || `ai-workflow-${Date.now()}`;
  workflowSession.taskId = taskId;
  const requestId = workflowSession.requestId;
  return {
    ...request,
    taskId,
    requestId,
    isStaleRun: () => workflowSession.cancelled || workflowSession.requestId !== requestId,
  };
}

async function runInitialStages(
  run: ActiveRun,
  prerequisites: WorkflowPrerequisites,
): Promise<boolean> {
  if (run.fromStep === 'script_generating') {
    const generated = await runScriptStage({
      projectDir: run.projectDir, taskId: run.taskId, requestId: run.requestId,
      setWorkflow: run.setWorkflow, cancelWorkflowTask: run.cancelWorkflowTask,
      isStaleRun: run.isStaleRun,
    });
    if (generated == null) return false;
    run.scriptText = generated;
    run.fromStep = 'tts_generating';
  }
  if (run.isStaleRun()) return false;
  if (run.fromStep !== 'tts_generating') return true;
  const result = await runTtsStage({
    scriptText: run.scriptText, projectDir: run.projectDir,
    taskId: run.taskId, requestId: run.requestId,
    settings: prerequisites.settings,
    provider: prerequisites.ttsConfig.provider, voice: prerequisites.ttsConfig.voice,
    setWorkflow: run.setWorkflow, cancelWorkflowTask: run.cancelWorkflowTask,
    isStaleRun: run.isStaleRun,
  });
  if (result === 'stop') return false;
  run.fromStep = 'ai_analyzing';
  return !run.isStaleRun();
}

function directorStartAt(fromStep: WorkflowStep): 'director' | 'production' | null {
  const directorEntries: WorkflowStep[] = [
    'ai_analyzing', 'tts_done', 'director_planning', 'production_running',
    'cover_generating', 'arranging',
  ];
  if (!directorEntries.includes(fromStep)) return null;
  return ['production_running', 'cover_generating', 'arranging'].includes(fromStep)
    ? 'production'
    : 'director';
}

export async function runWorkflowFromStep(request: WorkflowRunRequest): Promise<void> {
  const run = createActiveRun(request);
  const prerequisites = await loadWorkflowPrerequisites(
    run.fromStep, run.scriptText, run.projectDir, run.setWorkflow,
  );
  if (!prerequisites || !(await runInitialStages(run, prerequisites))) return;
  const startAt = directorStartAt(run.fromStep);
  if (!startAt || run.isStaleRun()) return;
  await runDirectorStage({
    startAt, projectDir: run.projectDir, taskId: run.taskId,
    settings: prerequisites.settings, setWorkflow: run.setWorkflow,
    isStaleRun: run.isStaleRun,
  });
}
