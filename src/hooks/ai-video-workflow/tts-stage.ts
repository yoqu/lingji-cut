import type { AISettings, TTSProvider, TTSVoicePreset } from '../../types/ai';
import { DEFAULT_WORKFLOW } from '../../store/ai';
import { useTaskProgressStore } from '../../store/task-progress';
import { buildWorkflowError } from './errors';
import { persistGeneratedPodcastMedia } from './podcast-media';
import {
  buildPhaseOnCancel,
  buildStepLabel,
  ensureWorkflowTask,
  mapSubProgressToGlobal,
  PHASES,
} from './progress';
import { workflowSession } from './session';
import { buildTTSRequest } from './tts-input';
import type { CancelWorkflowTask, SetWorkflow } from './types';

interface TtsStageOptions {
  scriptText: string;
  projectDir: string;
  taskId: string;
  requestId: string;
  settings: AISettings;
  provider: TTSProvider | null;
  voice: TTSVoicePreset | null;
  setWorkflow: SetWorkflow;
  cancelWorkflowTask: CancelWorkflowTask;
  isStaleRun: () => boolean;
}

function startTtsProgress(options: TtsStageOptions): void {
  const phase = PHASES.tts;
  options.setWorkflow({
    step: 'tts_generating', progress: mapSubProgressToGlobal(phase, 0),
    stepLabel: buildStepLabel(phase, '准备中'), error: null, canCancel: true,
  });
  ensureWorkflowTask(options.taskId, phase, {
    subPercent: 0, subMessage: '准备中', canCancel: true,
    onCancel: buildPhaseOnCancel({
      phase: 'tts', requestId: options.requestId, taskId: options.taskId,
      setWorkflow: options.setWorkflow, cancelWorkflowTask: options.cancelWorkflowTask,
    }),
  });
}

function subscribeTtsProgress(options: TtsStageOptions): () => void {
  return window.electronAPI.onTTSProgress((percent) => {
    if (options.isStaleRun()) return;
    const progress = mapSubProgressToGlobal(PHASES.tts, percent);
    options.setWorkflow({ progress, stepLabel: buildStepLabel(PHASES.tts, `${percent}%`) });
    useTaskProgressStore.getState().updateTask(options.taskId, {
      progress, phase: `合成语音 ${percent}%`,
    });
  });
}

function once(cleanup: () => void): () => void {
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    cleanup();
  };
}

function finishTtsOnly(options: TtsStageOptions): void {
  useTaskProgressStore.getState().updateTask(options.taskId, {
    label: '口播音频已更新', phase: '完成', progress: 100,
    canCancel: false, onCancel: undefined,
  });
  useTaskProgressStore.getState().completeTask(options.taskId);
  options.setWorkflow({ ...DEFAULT_WORKFLOW });
  workflowSession.retryStep = 'tts_generating';
}

function finishTtsStage(options: TtsStageOptions): void {
  options.setWorkflow({
    step: 'tts_done', progress: mapSubProgressToGlobal(PHASES.tts, 100),
    stepLabel: buildStepLabel(PHASES.tts, '完成'), error: null, canCancel: false,
  });
  workflowSession.retryStep = 'ai_analyzing';
}

function failTtsStage(options: TtsStageOptions, error: unknown): void {
  const message = buildWorkflowError('语音生成失败', error);
  options.setWorkflow({
    step: 'error', progress: 0, stepLabel: '', error: message,
    canCancel: false, failedStep: 'tts_generating',
  });
  useTaskProgressStore.getState().failTask(options.taskId, message);
  workflowSession.retryStep = 'tts_generating';
  workflowSession.telemetry?.event('run.end', {
    ok: false, failedStage: 'tts', error: message,
  });
}

async function generatePodcastMedia(options: TtsStageOptions) {
  const request = await buildTTSRequest({
    requestId: options.requestId, scriptText: options.scriptText,
    projectDir: options.projectDir, provider: options.provider,
    voice: options.voice, settings: options.settings,
  });
  return window.electronAPI.generateTTS(request);
}

export async function runTtsStage(options: TtsStageOptions): Promise<'continue' | 'stop'> {
  startTtsProgress(options);
  const cleanupProgress = once(subscribeTtsProgress(options));
  try {
    const result = await generatePodcastMedia(options);
    cleanupProgress();
    if (options.isStaleRun()) return 'stop';
    await persistGeneratedPodcastMedia(result, options.projectDir, options.scriptText);
    if (workflowSession.ttsOnly) {
      finishTtsOnly(options);
      return 'stop';
    }
    finishTtsStage(options);
    return workflowSession.pauseAfterTts ? 'stop' : 'continue';
  } catch (error) {
    if (!options.isStaleRun()) failTtsStage(options, error);
    return 'stop';
  } finally {
    cleanupProgress();
  }
}
