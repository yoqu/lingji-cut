import type { LLMProvider } from '../../types/ai';
import { LMSTUDIO_DEFAULT_BASE_URL } from '../../types/ai';

const MINIMAX_ANTHROPIC_DEFAULT_BASE_URL = 'https://api.minimaxi.com/anthropic';

export interface PiProviderPreset {
  id: string;
  label: string;
  description: string;
  piProviderId: string | null;
  providerName: string;
  type: LLMProvider['type'];
  baseUrl: string;
  models: string[];
  apiKeyPlaceholder: string;
  apiKeyRequired: boolean;
  enableThinking: boolean;
}

export const CUSTOM_PROVIDER_PRESET_ID = 'custom';

export const PI_PROVIDER_PRESETS: PiProviderPreset[] = [
  {
    id: 'lingji-gateway',
    label: '灵机剪影网关（开箱即用）',
    description:
      '登录灵机剪影账户后在「用户中心 · 网关密钥」生成 lj_ 密钥填入即可；AI 调用统一走网关按积分计费，无需自配上游 Key。Base URL 改成你的网关地址。',
    piProviderId: null,
    providerName: '灵机剪影网关',
    type: 'openai_compatible',
    baseUrl: 'http://localhost:18080/v1',
    models: ['gpt-4o-mini', 'gpt-4o'],
    apiKeyPlaceholder: 'lj_...',
    apiKeyRequired: true,
    enableThinking: false,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'Pi 内置 OpenAI provider，填写 Key 后即可使用。',
    piProviderId: 'openai',
    providerName: 'OpenAI',
    type: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-mini'],
    apiKeyPlaceholder: 'sk-...',
    apiKeyRequired: true,
    enableThinking: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Pi 内置 Anthropic provider，适合 Claude 系列模型。',
    piProviderId: 'anthropic',
    providerName: 'Anthropic',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-fable-5'],
    apiKeyPlaceholder: 'sk-ant-...',
    apiKeyRequired: true,
    enableThinking: true,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    description: 'Pi 内置 Google provider，填写 Gemini API Key 即可。',
    piProviderId: 'google',
    providerName: 'Google Gemini',
    type: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro'],
    apiKeyPlaceholder: 'AIza...',
    apiKeyRequired: true,
    enableThinking: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'Pi 内置 DeepSeek provider，兼容 OpenAI Chat Completions。',
    piProviderId: 'deepseek',
    providerName: 'DeepSeek',
    type: 'openai_compatible',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    apiKeyPlaceholder: 'sk-...',
    apiKeyRequired: true,
    enableThinking: true,
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    description: 'Pi 内置 MiniMax provider；剪辑流水线仍走 Anthropic 兼容端点。',
    piProviderId: 'minimax',
    providerName: 'MiniMax',
    type: 'minimax',
    baseUrl: MINIMAX_ANTHROPIC_DEFAULT_BASE_URL,
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
    apiKeyPlaceholder: 'eyJ...',
    apiKeyRequired: true,
    enableThinking: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Pi 内置 OpenRouter provider，适合统一路由多厂商模型。',
    piProviderId: 'openrouter',
    providerName: 'OpenRouter',
    type: 'openai_compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'anthropic/claude-sonnet-4.6',
      'anthropic/claude-opus-4.8',
      'openai/gpt-5.5',
      'openai/gpt-5.5-pro',
      'google/gemini-3.1-pro-preview',
      'moonshotai/kimi-k2.7-code',
      'z-ai/glm-5.2',
      'openrouter/auto',
    ],
    apiKeyPlaceholder: 'sk-or-...',
    apiKeyRequired: true,
    enableThinking: true,
  },
  {
    id: 'xai',
    label: 'xAI',
    description: 'Pi 内置 xAI provider，兼容 OpenAI 调用格式。',
    piProviderId: 'xai',
    providerName: 'xAI',
    type: 'openai_compatible',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4.3', 'grok-4.20-0309-reasoning', 'grok-build-0.1', 'grok-code-fast-1'],
    apiKeyPlaceholder: 'xai-...',
    apiKeyRequired: true,
    enableThinking: true,
  },
  {
    id: 'zai',
    label: 'ZAI',
    description: 'Pi 内置 z.ai provider，适合 GLM 系列模型。',
    piProviderId: 'zai',
    providerName: 'z.ai',
    type: 'openai_compatible',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    models: ['glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7'],
    apiKeyPlaceholder: '填写 ZAI API Key',
    apiKeyRequired: true,
    enableThinking: true,
  },
  {
    id: 'zai-coding-cn',
    label: '智谱 Z.ai（中国）',
    description: 'Pi 内置 ZAI Coding Plan (China) provider，使用智谱国内 coding 端点。',
    piProviderId: 'zai-coding-cn',
    providerName: '智谱 Z.ai',
    type: 'openai_compatible',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    models: ['glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7'],
    apiKeyPlaceholder: '填写智谱 API Key',
    apiKeyRequired: true,
    enableThinking: true,
  },
  {
    id: 'moonshotai',
    label: 'Moonshot AI Kimi',
    description: 'Pi 内置 Moonshot AI provider，适合 Kimi K2 系列模型。',
    piProviderId: 'moonshotai',
    providerName: 'Moonshot AI Kimi',
    type: 'openai_compatible',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k2-thinking'],
    apiKeyPlaceholder: 'sk-...',
    apiKeyRequired: true,
    enableThinking: true,
  },
  {
    id: 'moonshotai-cn',
    label: '月之暗面 Kimi',
    description: 'Pi 内置 Moonshot AI China provider，使用 moonshot.cn 国内端点。',
    piProviderId: 'moonshotai-cn',
    providerName: '月之暗面 Kimi',
    type: 'openai_compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k2-thinking'],
    apiKeyPlaceholder: 'sk-...',
    apiKeyRequired: true,
    enableThinking: true,
  },
  {
    id: 'kimi',
    label: 'Kimi Coding',
    description: 'Pi 内置 Kimi Coding provider，适合代码与长上下文任务。',
    piProviderId: 'kimi-coding',
    providerName: 'Kimi Coding',
    type: 'openai_compatible',
    baseUrl: 'https://api.kimi.com/coding',
    models: ['k2p7', 'kimi-k2-thinking', 'kimi-for-coding'],
    apiKeyPlaceholder: 'sk-...',
    apiKeyRequired: true,
    enableThinking: true,
  },
  {
    id: 'volcano',
    label: '火山方舟 Coding Plan',
    description: '火山引擎方舟 Coding Plan（OpenAI 兼容端点 /api/coding/v3），主力 Doubao-Seed-Code 编程模型。',
    piProviderId: null,
    providerName: '火山方舟',
    type: 'openai_compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    models: [
      'doubao-seed-2.0-code',
      'doubao-seed-2.0-pro',
      'doubao-seed-2.0-lite',
      'doubao-seed-code',
      'minimax-m2.7',
      'minimax-m3',
      'glm-5.2',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'kimi-k2.6',
      'kimi-k2.7-code',
    ],
    apiKeyPlaceholder: '填写火山引擎 API Key',
    apiKeyRequired: true,
    enableThinking: false,
  },
  {
    id: 'volcengine-ark-chat',
    label: '火山引擎方舟 (Chat)',
    description: '火山引擎方舟标准 Chat 端点 /api/v3，支持深度思考(thinking)、思考力度(reasoning_effort) 精细控制。',
    piProviderId: null,
    providerName: '火山引擎方舟',
    type: 'volcengine_ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [
      'doubao-seed-2-1-pro-260628',
      'doubao-seed-2-1-turbo-260628',
      'doubao-seed-1-6-250615',
      'deepseek-v4-pro-260425',
    ],
    apiKeyPlaceholder: '填写火山引擎 API Key',
    apiKeyRequired: true,
    enableThinking: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    description: '本地 OpenAI 兼容服务，通常无需 API Key。',
    piProviderId: null,
    providerName: 'LM Studio',
    type: 'lmstudio',
    baseUrl: LMSTUDIO_DEFAULT_BASE_URL,
    models: ['local-model'],
    apiKeyPlaceholder: '可留空',
    apiKeyRequired: false,
    enableThinking: false,
  },
];

export function findPiProviderPresetByBuiltinId(
  builtinProviderId: string | null | undefined,
): PiProviderPreset | null {
  if (!builtinProviderId) return null;
  return PI_PROVIDER_PRESETS.find((preset) => preset.piProviderId === builtinProviderId) ?? null;
}

export function getPiBuiltinProviderId(provider: LLMProvider): string | null {
  const id = provider.pi?.builtinProviderId?.trim();
  return id || null;
}

export function isPiBuiltinProvider(provider: LLMProvider): boolean {
  return Boolean(getPiBuiltinProviderId(provider));
}

export function applyPiProviderPreset(
  provider: LLMProvider,
  preset: PiProviderPreset,
): LLMProvider {
  const nextPi = preset.piProviderId
    ? { builtinProviderId: preset.piProviderId }
    : { ...(provider.pi ?? {}) };
  if (!preset.piProviderId) delete nextPi.builtinProviderId;

  const configuredModels = provider.models
    .map((model) => model.trim())
    .filter((model, index, list) => model.length > 0 && list.indexOf(model) === index);

  return {
    ...provider,
    name: provider.name.trim() ? provider.name : preset.providerName,
    type: preset.type,
    baseUrl: provider.baseUrl.trim() ? provider.baseUrl : preset.baseUrl,
    models: configuredModels.length > 0 ? configuredModels : preset.models,
    enableThinking: provider.enableThinking ?? preset.enableThinking,
    pi: Object.keys(nextPi).length > 0 ? nextPi : undefined,
  };
}
