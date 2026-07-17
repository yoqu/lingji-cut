import { loadGlobalSettings } from '../global-settings';
import { resolveDefaultTTSConfig, normalizeTTSSettings } from '../../src/lib/tts-settings';
import { readPromptBindings } from '../prompt-bindings-io';
import { GenerationError } from './generation-error';
import { migrateToProviders } from '../../src/lib/llm/provider-utils';
import { migrateImageProviders } from '../../src/lib/llm/migrate-image-providers';
import { DEFAULT_STYLE_PRESET_ID } from '../../src/types/ai';
import type { AISettings, TTSProvider, TTSVoicePreset, PromptBindingMap } from '../../src/types/ai';

/** 读取全局 AISettings（明文，含 keys）；无则返回 null */
export async function loadHeadlessAISettings(userDataPath: string): Promise<AISettings | null> {
  const file = await loadGlobalSettings(userDataPath);
  return file?.aiSettings ?? null;
}

export interface HeadlessTTSConfig {
  provider: TTSProvider;
  voice: TTSVoicePreset;
}

/** 装配默认 TTS provider+voice，缺失项抛 GenerationError */
export async function loadHeadlessTTSConfig(userDataPath: string): Promise<HeadlessTTSConfig> {
  const settings = await loadHeadlessAISettings(userDataPath);
  if (!settings) {
    throw new GenerationError('no_settings', '未找到应用设置（settings.json）。请先在应用中配置 TTS。');
  }
  const { provider, voice } = resolveDefaultTTSConfig(settings);
  if (!provider) {
    throw new GenerationError('no_tts_provider', '未配置口播生成服务，请先在应用设置中配置。');
  }
  if (!voice) {
    throw new GenerationError('no_tts_voice', '未配置口播音色，请先在应用设置中配置。');
  }
  if (!provider.apiKey?.trim()) {
    throw new GenerationError('no_api_key', '口播生成服务缺少 API Key，请在应用设置中填写。');
  }
  return { provider, voice };
}

/** 读取项目级 prompt 绑定 */
export async function loadHeadlessProjectBindings(projectDir: string): Promise<PromptBindingMap> {
  return readPromptBindings({ projectDir });
}

/** 复制自 src/store/ai.ts buildDefaultAISettings 的默认字面量（store 不可 main 导入） */
export function defaultAISettings(): AISettings {
  return {
    llmProviders: [],
    defaultProviderId: null,
    defaultModel: null,
    enableThinking: true,
    minimaxApiKey: '',
    minimaxVoiceId: 'male-qn-qingse',
    minimaxSpeed: 1.0,
    minimaxVol: 1.0,
    minimaxPitch: 0,
    minimaxEmotion: '',
    minimaxModel: 'speech-2.8-hd',
    ttsProviders: [],
    defaultTtsProviderId: null,
    defaultTtsVoiceId: null,
    ttsVoices: [],
    imageProviders: [],
    defaultImageProviderId: null,
    defaultImageModel: null,
    globalCoverImagePrompt: '',
    videoProviders: [],
    defaultVideoProviderId: null,
    defaultVideoModel: null,
    promptBindings: {},
    cardGenerationConcurrency: 2,
    defaultStylePresetId: DEFAULT_STYLE_PRESET_ID,
  };
}

/** 完整 AISettings（默认填充 + 迁移链 + 明文 keys），供封面/卡片/LLM 使用 */
export async function loadFullHeadlessAISettings(userDataPath: string): Promise<AISettings> {
  const file = await loadGlobalSettings(userDataPath);
  const merged = { ...defaultAISettings(), ...(file?.aiSettings ?? {}) } as AISettings;
  return normalizeTTSSettings(migrateImageProviders(migrateToProviders(merged)));
}
