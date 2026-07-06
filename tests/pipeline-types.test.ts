import { describe, it, expect } from 'vitest';
import {
  PIPELINE_TASK_KINDS,
  PIPELINE_ERROR_CODES,
  isTerminalStatus,
  type PipelineTask,
  type PipelineTaskStatus,
} from '../electron/pipeline/types';

describe('pipeline types', () => {
  it('exports the 13 task kinds from spec', () => {
    expect(PIPELINE_TASK_KINDS).toEqual([
      'tts',
      'write_script',
      'review_script',
      'analyze_subtitles',
      'generate_covers',
      'generate_storyboard',
      'generate_cards',
      'generate_motion',
      'sculpt_card',
      'publish_metadata',
      'export_video',
      'import_video_source',
      'publish',
    ]);
  });

  it('classifies terminal statuses', () => {
    expect(isTerminalStatus('succeeded')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('canceled')).toBe(true);
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('pending')).toBe(false);
  });

  it('exposes documented error codes', () => {
    expect(PIPELINE_ERROR_CODES.TASK_CONFLICT).toBe('task_conflict');
    expect(PIPELINE_ERROR_CODES.NOT_CANCELABLE).toBe('not_cancelable');
    expect(PIPELINE_ERROR_CODES.PROJECT_NOT_FOUND).toBe('project_not_found');
  });

  it('typings compile with sample task', () => {
    const task: PipelineTask = {
      taskId: '00000000-0000-4000-8000-000000000000',
      kind: 'tts',
      projectPath: '/tmp/foo',
      status: 'pending',
      progress: { phase: 'init', percent: 0 },
      startedAt: 1,
      logs: [],
    };
    const status: PipelineTaskStatus = task.status;
    expect(status).toBe('pending');
  });
});
