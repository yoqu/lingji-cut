import { useTaskProgressStore } from '../../store/task-progress';
import type { WorkflowStep } from '../../store/ai';
import { workflowSession } from './session';
import type { CancelWorkflowTask, SetWorkflow } from './types';

export type PhaseKey = 'script' | 'tts' | 'analyze' | 'highlights' | 'cover' | 'arrange';

export interface PhaseSpec {
  key: PhaseKey;
  index: number;
  label: string;
  baseStart: number;
  span: number;
  category: 'tts' | 'ai-analyze' | 'cover' | 'ai-write';
}

const TOTAL_STEPS = 6;
export const PHASES: Record<PhaseKey, PhaseSpec> = {
  script: { key: 'script', index: 1, label: '生成口播稿', baseStart: 0, span: 16, category: 'ai-write' },
  tts: { key: 'tts', index: 2, label: '合成口播', baseStart: 16, span: 17, category: 'tts' },
  analyze: { key: 'analyze', index: 3, label: '内容分析', baseStart: 33, span: 17, category: 'ai-analyze' },
  highlights: { key: 'highlights', index: 4, label: '字幕高亮', baseStart: 50, span: 17, category: 'ai-analyze' },
  cover: { key: 'cover', index: 5, label: '生成封面', baseStart: 67, span: 17, category: 'cover' },
  arrange: { key: 'arrange', index: 6, label: '时间轴排布', baseStart: 84, span: 16, category: 'ai-analyze' },
};

export function buildStepLabel(phase: PhaseSpec, suffix?: string): string {
  const base = `步骤 ${phase.index}/${TOTAL_STEPS} · ${phase.label}`;
  return suffix ? `${base} · ${suffix}` : base;
}

export function mapSubProgressToGlobal(phase: PhaseSpec, subPercent: number): number {
  const clamped = Math.max(0, Math.min(100, subPercent));
  return Math.min(100, Math.round(phase.baseStart + (clamped / 100) * phase.span));
}

interface EnsureTaskOptions {
  subPercent: number;
  subMessage?: string;
  canCancel: boolean;
  onCancel?: () => void;
}

export function ensureWorkflowTask(
  taskId: string,
  phase: PhaseSpec,
  options: EnsureTaskOptions,
): void {
  const store = useTaskProgressStore.getState();
  const task = {
    category: phase.category,
    label: buildStepLabel(phase),
    mode: 'determinate' as const,
    progress: mapSubProgressToGlobal(phase, options.subPercent),
    phase: options.subMessage ?? phase.label,
    canCancel: options.canCancel,
    onCancel: options.onCancel,
  };
  if (store.tasks.has(taskId)) {
    store.updateTask(taskId, task);
    return;
  }
  store.startTask({ id: taskId, ...task, level: 2 });
}

export function averageTrackProgress(tracks: Partial<Record<string, number>>): number {
  const values = Object.values(tracks).filter((value): value is number => value != null);
  return values.length === 0
    ? 0
    : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function phaseToStep(phase: PhaseKey): WorkflowStep {
  if (phase === 'script') return 'script_generating';
  if (phase === 'tts') return 'tts_generating';
  if (phase === 'cover') return 'cover_generating';
  if (phase === 'arrange') return 'arranging';
  return 'ai_analyzing';
}

interface CancelHandlerOptions {
  phase: PhaseKey;
  requestId: string;
  taskId: string;
  setWorkflow: SetWorkflow;
  cancelWorkflowTask: CancelWorkflowTask;
}

export function buildPhaseOnCancel(options: CancelHandlerOptions): () => void {
  return () => {
    if (workflowSession.cancelled) return;
    workflowSession.cancelled = true;
    workflowSession.abortController?.abort();
    if (options.phase === 'tts' && options.requestId) {
      void window.electronAPI.cancelTTS(options.requestId);
    }
    options.cancelWorkflowTask(options.taskId, '任务已取消');
    const failedStep = phaseToStep(options.phase);
    options.setWorkflow({
      step: 'error', progress: 0, stepLabel: '', error: '任务已取消',
      canCancel: false, failedStep,
    });
    workflowSession.retryStep = failedStep;
  };
}
