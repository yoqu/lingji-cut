import { describe, it, expect, vi } from 'vitest';
import {
  pipelineTaskStoreId,
  mapKindToCategoryLabel,
  createPipelineProgressBridge,
  type PipelineTaskSnapshot,
  type PipelineProgressBridgeDeps,
} from '../src/lib/pipeline-progress-bridge';

function makeDeps(overrides: Partial<PipelineProgressBridgeDeps> = {}) {
  let cb: ((t: PipelineTaskSnapshot) => void) | null = null;
  const tasks = new Set<string>();
  const calls = {
    start: [] as any[],
    update: [] as any[],
    complete: [] as string[],
    fail: [] as Array<{ id: string; error: string }>,
    cancelled: [] as Array<{ id: string; reason?: string }>,
    cancel: [] as string[],
  };
  const deps: PipelineProgressBridgeDeps = {
    subscribe: (fn) => {
      cb = fn;
      return () => {
        cb = null;
      };
    },
    startTask: (input) => {
      tasks.add(input.id);
      calls.start.push(input);
    },
    updateTask: (id, patch) => calls.update.push({ id, patch }),
    completeTask: (id) => calls.complete.push(id),
    failTask: (id, error) => calls.fail.push({ id, error }),
    cancelTask: (id, reason) => calls.cancelled.push({ id, reason }),
    hasTask: (id) => tasks.has(id),
    cancel: (taskId) => calls.cancel.push(taskId),
    ...overrides,
  };
  return { deps, calls, emit: (t: PipelineTaskSnapshot) => cb?.(t) };
}

function snap(partial: Partial<PipelineTaskSnapshot>): PipelineTaskSnapshot {
  return {
    taskId: 't1',
    kind: 'export_video',
    status: 'running',
    progress: { phase: '渲染', percent: 42 },
    bridgeId: 'pipeline:t1',
    ...partial,
  };
}

describe('pipelineTaskStoreId', () => {
  it('prefixes the task id', () => {
    expect(pipelineTaskStoreId('abc')).toBe('pipeline:abc');
  });
});

describe('mapKindToCategoryLabel', () => {
  it('maps export to export category', () => {
    expect(mapKindToCategoryLabel('export_video')).toEqual({
      category: 'export',
      label: '导出视频',
    });
  });
  it('maps tts to tts category', () => {
    expect(mapKindToCategoryLabel('tts').category).toBe('tts');
  });
  it('maps covers to cover category', () => {
    expect(mapKindToCategoryLabel('generate_covers').category).toBe('cover');
  });
});

describe('createPipelineProgressBridge', () => {
  it('starts a task on first running snapshot with mapped category and clamped progress', () => {
    const { deps, calls, emit } = makeDeps();
    createPipelineProgressBridge(deps);
    emit(snap({ progress: { phase: '渲染', percent: 42 } }));
    expect(calls.start).toHaveLength(1);
    const t = calls.start[0];
    expect(t.id).toBe('pipeline:t1');
    expect(t.category).toBe('export');
    expect(t.progress).toBe(42);
    expect(t.phase).toBe('渲染');
    expect(t.level).toBe(0);
    expect(t.canCancel).toBe(true);
  });

  it('updates (not re-starts) on subsequent running snapshots', () => {
    const { deps, calls, emit } = makeDeps();
    createPipelineProgressBridge(deps);
    emit(snap({ progress: { phase: '渲染', percent: 10 } }));
    emit(snap({ progress: { phase: '渲染', percent: 80 } }));
    expect(calls.start).toHaveLength(1);
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]).toMatchObject({ id: 'pipeline:t1', patch: { progress: 80 } });
  });

  it('completes the task on succeeded', () => {
    const { deps, calls, emit } = makeDeps();
    createPipelineProgressBridge(deps);
    emit(snap({ status: 'running' }));
    emit(snap({ status: 'succeeded', progress: { phase: '完成', percent: 100 } }));
    expect(calls.complete).toEqual(['pipeline:t1']);
  });

  it('fails the task with the error message on failed', () => {
    const { deps, calls, emit } = makeDeps();
    createPipelineProgressBridge(deps);
    emit(snap({ status: 'running' }));
    emit(snap({ status: 'failed', error: { message: '渲染崩了' } }));
    expect(calls.fail).toEqual([{ id: 'pipeline:t1', error: '渲染崩了' }]);
  });

  it('marks the task as cancelled on canceled', () => {
    const { deps, calls, emit } = makeDeps();
    createPipelineProgressBridge(deps);
    emit(snap({ status: 'running' }));
    emit(snap({ status: 'canceled' }));
    expect(calls.cancelled).toEqual([{ id: 'pipeline:t1', reason: '任务已取消' }]);
  });

  it('wires onCancel to deps.cancel with the raw taskId', () => {
    const { deps, calls, emit } = makeDeps();
    createPipelineProgressBridge(deps);
    emit(snap({ status: 'running' }));
    calls.start[0].onCancel?.();
    expect(calls.cancel).toEqual(['t1']);
  });

  it('marks canCancel false when no cancel dep provided', () => {
    const { deps, calls, emit } = makeDeps({ cancel: undefined });
    createPipelineProgressBridge(deps);
    emit(snap({ status: 'running' }));
    expect(calls.start[0].canCancel).toBe(false);
  });

  it('stops handling after dispose', () => {
    const { deps, calls, emit } = makeDeps();
    const bridge = createPipelineProgressBridge(deps);
    bridge.dispose();
    emit(snap({ status: 'running' }));
    expect(calls.start).toHaveLength(0);
  });
});
