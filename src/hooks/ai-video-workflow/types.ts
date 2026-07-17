import type { AutoRunTelemetry } from '../../lib/telemetry/auto-run';
import type {
  AutoWorkflowParams,
  WorkflowState,
  WorkflowStep,
} from '../../store/ai';

export interface WorkflowStartOptions {
  pauseAfterTts?: boolean;
  ttsOnly?: boolean;
  startFromStep?: Extract<
    WorkflowStep,
    | 'script_generating'
    | 'tts_generating'
    | 'director_planning'
    | 'production_running'
    | 'ai_analyzing'
    | 'cover_generating'
    | 'arranging'
  >;
  autoMode?: boolean;
  autoParams?: AutoWorkflowParams;
  originalText?: string;
}

export interface WorkflowSessionState {
  requestId: string;
  retryStep: WorkflowStep;
  scriptText: string;
  projectDir: string;
  pauseAfterTts: boolean;
  ttsOnly: boolean;
  cancelled: boolean;
  taskId: string;
  autoMode: boolean;
  autoParams: AutoWorkflowParams | null;
  originalText: string;
  telemetryRunId: string;
  telemetry: AutoRunTelemetry | null;
  abortController: AbortController | null;
}

export type SetWorkflow = (updates: Partial<WorkflowState>) => void;
export type CancelWorkflowTask = (taskId: string, reason?: string) => void;

export interface WorkflowRunRequest {
  fromStep: WorkflowStep;
  scriptText: string;
  projectDir: string;
  setWorkflow: SetWorkflow;
  cancelWorkflowTask: CancelWorkflowTask;
}

export interface PreparedWorkflowStart {
  initialStep: WorkflowStep;
  scriptText: string;
  projectDir: string;
}
