import { createAutoRunTelemetry } from '../../lib/telemetry/auto-run';
import { getProjectDir } from '../../store/timeline';
import type {
  PreparedWorkflowStart,
  WorkflowSessionState,
  WorkflowStartOptions,
} from './types';
import { patchWorkflowMeta } from './workflow-meta';

export const workflowSession: WorkflowSessionState = createEmptySession();

function createEmptySession(): WorkflowSessionState {
  return {
    requestId: '', retryStep: 'tts_generating', scriptText: '', projectDir: '',
    pauseAfterTts: false, ttsOnly: false, cancelled: false, taskId: '',
    autoMode: false, autoParams: null, originalText: '', telemetryRunId: '',
    telemetry: null, abortController: null,
  };
}

export function resetWorkflowSession(): void {
  workflowSession.abortController?.abort();
  Object.assign(workflowSession, createEmptySession());
}

function initializeWorkflowSession(options?: WorkflowStartOptions): void {
  resetWorkflowSession();
  workflowSession.requestId = crypto.randomUUID();
  workflowSession.taskId = `ai-workflow-${Date.now()}`;
  workflowSession.telemetryRunId = `autorun-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  workflowSession.telemetry = createAutoRunTelemetry(workflowSession.telemetryRunId);
  workflowSession.projectDir = getProjectDir() ?? '';
  workflowSession.pauseAfterTts = options?.pauseAfterTts ?? false;
  workflowSession.ttsOnly = options?.ttsOnly ?? false;
  workflowSession.autoMode = options?.autoMode ?? false;
  workflowSession.autoParams = options?.autoParams ?? null;
  workflowSession.originalText = options?.originalText ?? '';
}

function recordRunStart(options?: WorkflowStartOptions): void {
  workflowSession.telemetry?.event('run.start', {
    autoMode: options?.autoMode ?? false,
    startFromStep: options?.startFromStep ?? null,
    pauseAfterTts: options?.pauseAfterTts ?? false,
    ttsOnly: options?.ttsOnly ?? false,
    projectDir: workflowSession.projectDir,
  });
}

async function resolveScriptText(
  scriptText: string,
  initialStep: PreparedWorkflowStart['initialStep'],
): Promise<string> {
  if (scriptText.trim() || !workflowSession.projectDir || initialStep === 'script_generating') {
    return scriptText;
  }
  return await window.electronAPI.loadScriptFile(workflowSession.projectDir, 'script.md') ?? '';
}

function persistAutoRunMeta(): void {
  if (!workflowSession.autoMode || !workflowSession.autoParams || !workflowSession.projectDir) return;
  void patchWorkflowMeta(workflowSession.projectDir, {
    lastAutoParams: workflowSession.autoParams,
    lastAutoRunAt: new Date().toISOString(),
  });
}

export async function prepareWorkflowStart(
  scriptText: string,
  options?: WorkflowStartOptions,
): Promise<PreparedWorkflowStart> {
  initializeWorkflowSession(options);
  recordRunStart(options);
  const initialStep = options?.startFromStep
    ?? (options?.autoMode ? 'script_generating' : 'tts_generating');
  workflowSession.retryStep = initialStep;
  workflowSession.scriptText = await resolveScriptText(scriptText, initialStep);
  persistAutoRunMeta();
  return { initialStep, scriptText: workflowSession.scriptText, projectDir: workflowSession.projectDir };
}

export function sessionProductionMode(): 'auto' | 'director' {
  if (!workflowSession.autoMode) return 'director';
  return workflowSession.autoParams?.productionMode === 'director' ? 'director' : 'auto';
}
