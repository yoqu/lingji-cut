export const PIPELINE_TASK_KINDS = [
  'tts',
  'write_script',
  'review_script',
  'analyze_subtitles',
  'generate_covers',
  'generate_storyboard',
  'generate_cards',
  'generate_motion',
  'sculpt_card',
  'export_video',
  'import_video_source',
] as const;

export type PipelineTaskKind = (typeof PIPELINE_TASK_KINDS)[number];

export type PipelineTaskStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export interface PipelineTaskProgress {
  phase: string;
  percent: number;
  message?: string;
}

export interface PipelineTaskError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface PipelineTask {
  taskId: string;
  kind: PipelineTaskKind;
  projectPath: string;
  status: PipelineTaskStatus;
  progress: PipelineTaskProgress;
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  error?: PipelineTaskError;
  logs: string[];
}

const TERMINAL: ReadonlySet<PipelineTaskStatus> = new Set([
  'succeeded',
  'failed',
  'canceled',
]);

export function isTerminalStatus(s: PipelineTaskStatus): boolean {
  return TERMINAL.has(s);
}

export const PIPELINE_ERROR_CODES = {
  TASK_CONFLICT: 'task_conflict',
  NOT_CANCELABLE: 'not_cancelable',
  PROJECT_NOT_FOUND: 'project_not_found',
  INVALID_PROJECT: 'invalid_project',
  UNKNOWN_TASK: 'unknown_task',
  INTERNAL: 'internal',
} as const;

export const PIPELINE_TASK_LOG_LIMIT = 200;

/** 可取消的 task kinds（其余返回 not_cancelable） */
export const CANCELABLE_KINDS: ReadonlySet<PipelineTaskKind> = new Set<PipelineTaskKind>([
  'tts',
  'export_video',
  'write_script',
  'review_script',
  'analyze_subtitles',
  'generate_covers',
  'generate_storyboard',
  'generate_cards',
  'generate_motion',
  'import_video_source',
]);
