/**
 * Pipeline 进度桥：把主进程 `pipeline:task-update` 推送的 PipelineTask 快照
 * 映射到底部统一任务进度系统（task-progress store）。
 *
 * 背景：MCP（含内置 pi）触发的 pipeline 任务（导出/TTS/分析/封面/卡片/Motion）
 * 在主进程跑得好好的，进度通过 `attachTaskProgressBridge` 发到渲染窗口的
 * `pipeline:task-update` 频道，但渲染端从没订阅过 → AI 触发的导出在 UI 零反应。
 * 本模块是「订阅 + kind→category/label 映射 + 幂等 start/update/complete/fail」单元，
 * 与视频导入的 `video-import-progress` 那套并行（导入已自带桥，不在此处理）。
 */

export type PipelineTaskStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export type PipelineTaskKind =
  | 'tts'
  | 'write_script'
  | 'review_script'
  | 'analyze_subtitles'
  | 'generate_covers'
  | 'generate_storyboard'
  | 'generate_cards'
  | 'generate_motion'
  | 'sculpt_card'
  | 'publish_metadata'
  | 'export_video'
  | 'import_video_source'
  | 'publish';

export interface PipelineTaskSnapshot {
  taskId: string;
  kind: PipelineTaskKind;
  status: PipelineTaskStatus;
  progress: { phase: string; percent: number; message?: string };
  error?: { message: string } | null;
  /** 主进程 bridge 附加的稳定 id（`pipeline:<taskId>`）。 */
  bridgeId?: string;
}

export type PipelineTaskCategory =
  | 'ai-write'
  | 'ai-review'
  | 'ai-analyze'
  | 'cover'
  | 'tts'
  | 'export'
  | 'import'
  | 'io';

/** task-progress store 中 pipeline 任务的稳定 id。 */
export function pipelineTaskStoreId(taskId: string): string {
  return `pipeline:${taskId}`;
}

const KIND_MAP: Record<PipelineTaskKind, { category: PipelineTaskCategory; label: string }> = {
  tts: { category: 'tts', label: '生成口播音频' },
  write_script: { category: 'ai-write', label: '生成口播稿' },
  review_script: { category: 'ai-review', label: '审查口播稿' },
  analyze_subtitles: { category: 'ai-analyze', label: '字幕分析' },
  generate_covers: { category: 'cover', label: '生成封面' },
  generate_storyboard: { category: 'ai-analyze', label: '生成分镜' },
  generate_cards: { category: 'ai-analyze', label: '生成卡片' },
  generate_motion: { category: 'ai-analyze', label: 'Motion 卡片' },
  sculpt_card: { category: 'ai-analyze', label: '精雕卡片' },
  publish_metadata: { category: 'ai-write', label: '生成发布文案' },
  export_video: { category: 'export', label: '导出视频' },
  import_video_source: { category: 'import', label: '导入视频' },
  publish: { category: 'export', label: '发布视频' },
};

export function mapKindToCategoryLabel(
  kind: PipelineTaskKind,
): { category: PipelineTaskCategory; label: string } {
  return KIND_MAP[kind] ?? { category: 'io', label: '任务' };
}

function describePhase(snapshot: PipelineTaskSnapshot): string {
  const phase = snapshot.progress.phase?.trim();
  if (!phase || phase === 'pending') return '准备中…';
  return phase;
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export interface PipelineProgressStartInput {
  id: string;
  category: PipelineTaskCategory;
  label: string;
  mode: 'determinate';
  progress: number;
  phase: string;
  level: 0;
  canCancel: boolean;
  onCancel?: () => void;
}

export interface PipelineProgressBridgeDeps {
  /** 订阅 pipeline:task-update，返回取消订阅函数。 */
  subscribe: (callback: (task: PipelineTaskSnapshot) => void) => () => void;
  startTask: (input: PipelineProgressStartInput) => void;
  updateTask: (id: string, patch: { progress: number; phase: string }) => void;
  completeTask: (id: string) => void;
  failTask: (id: string, error: string) => void;
  cancelTask: (id: string, reason?: string) => void;
  hasTask: (id: string) => boolean;
  /** 取消 pipeline 任务（渲染端 → 主进程）。不提供则任务不可取消。 */
  cancel?: (taskId: string) => void;
}

export interface PipelineProgressBridge {
  dispose: () => void;
}

/**
 * 创建进度桥：把每个 PipelineTask 快照按 `pipeline:<taskId>` 幂等落到统一进度系统。
 * - running/pending：首见 startTask，其后 updateTask（真实百分比）。
 * - succeeded：completeTask；failed：failTask；canceled：cancelTask。
 * 调用方在卸载时必须 dispose()。
 */
export function createPipelineProgressBridge(
  deps: PipelineProgressBridgeDeps,
): PipelineProgressBridge {
  let disposed = false;

  const handle = (task: PipelineTaskSnapshot) => {
    if (disposed) return;
    const id = task.bridgeId ?? pipelineTaskStoreId(task.taskId);

    if (task.status === 'succeeded') {
      deps.completeTask(id);
      return;
    }
    if (task.status === 'failed') {
      deps.failTask(id, task.error?.message?.trim() || '任务失败');
      return;
    }
    if (task.status === 'canceled') {
      deps.cancelTask(id, '任务已取消');
      return;
    }

    // pending / running
    const progress = clampPercent(task.progress.percent);
    const phase = describePhase(task);
    if (!deps.hasTask(id)) {
      const { category, label } = mapKindToCategoryLabel(task.kind);
      deps.startTask({
        id,
        category,
        label,
        mode: 'determinate',
        progress,
        phase,
        level: 0,
        canCancel: Boolean(deps.cancel),
        onCancel: deps.cancel ? () => deps.cancel!(task.taskId) : undefined,
      });
    } else {
      deps.updateTask(id, { progress, phase });
    }
  };

  const unsubscribe = deps.subscribe(handle);

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}
