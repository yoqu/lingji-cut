import { getAISettingsIssue } from '../../lib/ai-settings';
import { resolveDefaultTTSConfig } from '../../lib/tts-settings';
import {
  DEFAULT_WORKFLOW,
  loadAISettings,
  type WorkflowStep,
} from '../../store/ai';
import type { AISettings } from '../../types/ai';
import { workflowSession } from './session';
import type { SetWorkflow } from './types';

export interface WorkflowPrerequisites {
  settings: AISettings;
  ttsConfig: ReturnType<typeof resolveDefaultTTSConfig>;
}

function failValidation(
  setWorkflow: SetWorkflow,
  fromStep: WorkflowStep,
  error: string,
): null {
  setWorkflow({ ...DEFAULT_WORKFLOW, step: 'error', error, failedStep: fromStep });
  return null;
}

function needsTts(fromStep: WorkflowStep): boolean {
  return fromStep === 'tts_generating' || fromStep === 'script_generating';
}

function validateTts(
  fromStep: WorkflowStep,
  ttsConfig: ReturnType<typeof resolveDefaultTTSConfig>,
  setWorkflow: SetWorkflow,
): boolean {
  if (!needsTts(fromStep)) return true;
  if (!ttsConfig.provider || !ttsConfig.voice) {
    failValidation(setWorkflow, fromStep, '请先在设置 → 口播合成中配置默认口播生成服务和默认音色');
    return false;
  }
  if (!ttsConfig.provider.apiKey.trim()) {
    failValidation(setWorkflow, fromStep, '请先在设置 → 口播合成中填写默认口播生成服务的 API Key');
    return false;
  }
  return true;
}

function needsLlm(fromStep: WorkflowStep): boolean {
  return ['ai_analyzing', 'tts_done', 'cover_generating', 'arranging'].includes(fromStep);
}

export async function loadWorkflowPrerequisites(
  fromStep: WorkflowStep,
  scriptText: string,
  projectDir: string,
  setWorkflow: SetWorkflow,
): Promise<WorkflowPrerequisites | null> {
  const settings = await loadAISettings();
  if (!projectDir) return failValidation(setWorkflow, fromStep, '请先选择工程目录后再生成视频');
  if (fromStep !== 'script_generating' && !scriptText.trim()) {
    return failValidation(setWorkflow, fromStep, '未找到可用于生成视频的文稿内容');
  }
  if (!settings) return failValidation(setWorkflow, fromStep, '请先完成 AI 配置后再生成视频');
  const ttsConfig = resolveDefaultTTSConfig(settings);
  if (!validateTts(fromStep, ttsConfig, setWorkflow)) return null;
  const llmIssue = getAISettingsIssue(settings);
  if (needsLlm(fromStep) && llmIssue) {
    workflowSession.retryStep = 'ai_analyzing';
    return failValidation(setWorkflow, fromStep, llmIssue);
  }
  return { settings, ttsConfig };
}
