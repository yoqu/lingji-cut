/**
 * 内置 LLM Provider 预设（摘要/分析用），迁移自桌面端 src/lib/llm/pi-provider-presets.ts。
 *
 * 扩展的摘要 Provider 只实现两种协议（见 domain/models 的 LlmProtocol）：
 * - 'openai'：POST {baseUrl}/chat/completions（OpenAI 兼容）
 * - 'anthropic'：POST {baseUrl}/v1/messages（Anthropic Messages，含 MiniMax anthropic 端点）
 *
 * 说明：
 * - baseUrl 与模型列表与桌面端预设保持一一对应（每厂商最新模型；新增/更新模型时两端同步）。
 * - gemini 在桌面端为独立协议，这里映射到 Gemini 的 OpenAI 兼容端点（.../v1beta/openai）以复用 chat/completions。
 * - lmstudio 为本地 OpenAI 兼容服务，通常无需 Key。
 */
import type { LlmProtocol } from '@/domain/models';

export interface LlmProviderPreset {
  id: string;
  /** 下拉中展示的名称。 */
  label: string;
  /** 落库时的 provider 名称。 */
  providerName: string;
  protocol: LlmProtocol;
  baseUrl: string;
  models: string[];
  apiKeyPlaceholder: string;
  apiKeyRequired: boolean;
}

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    providerName: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-mini'],
    apiKeyPlaceholder: 'sk-...',
    apiKeyRequired: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    providerName: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-fable-5'],
    apiKeyPlaceholder: 'sk-ant-...',
    apiKeyRequired: true,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    providerName: 'Google Gemini',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro'],
    apiKeyPlaceholder: 'AIza...',
    apiKeyRequired: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    providerName: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    apiKeyPlaceholder: 'sk-...',
    apiKeyRequired: true,
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    providerName: 'MiniMax',
    protocol: 'anthropic',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
    apiKeyPlaceholder: 'eyJ...',
    apiKeyRequired: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    providerName: 'OpenRouter',
    protocol: 'openai',
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
  },
  {
    id: 'xai',
    label: 'xAI',
    providerName: 'xAI',
    protocol: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4.3', 'grok-4.20-0309-reasoning', 'grok-build-0.1', 'grok-code-fast-1'],
    apiKeyPlaceholder: 'xai-...',
    apiKeyRequired: true,
  },
  {
    id: 'zai',
    label: 'ZAI（GLM）',
    providerName: 'z.ai',
    protocol: 'openai',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    models: ['glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7'],
    apiKeyPlaceholder: '填写 ZAI API Key',
    apiKeyRequired: true,
  },
  {
    id: 'zai-coding-cn',
    label: '智谱 Z.ai（中国）',
    providerName: '智谱 Z.ai',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    models: ['glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7'],
    apiKeyPlaceholder: '填写智谱 API Key',
    apiKeyRequired: true,
  },
  {
    id: 'moonshotai',
    label: 'Moonshot AI Kimi',
    providerName: 'Moonshot AI Kimi',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k2-thinking'],
    apiKeyPlaceholder: 'sk-...',
    apiKeyRequired: true,
  },
  {
    id: 'moonshotai-cn',
    label: '月之暗面 Kimi',
    providerName: '月之暗面 Kimi',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k2-thinking'],
    apiKeyPlaceholder: 'sk-...',
    apiKeyRequired: true,
  },
  {
    id: 'kimi',
    label: 'Kimi Coding',
    providerName: 'Kimi Coding',
    protocol: 'openai',
    baseUrl: 'https://api.kimi.com/coding/v1',
    models: ['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed'],
    apiKeyPlaceholder: 'sk-...',
    apiKeyRequired: true,
  },
  {
    id: 'volcano',
    label: '火山方舟 Coding Plan',
    providerName: '火山方舟',
    protocol: 'openai',
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
  },
  {
    id: 'lmstudio',
    label: 'LM Studio（本地）',
    providerName: 'LM Studio',
    protocol: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    models: ['local-model'],
    apiKeyPlaceholder: '可留空',
    apiKeyRequired: false,
  },
];

export function findLlmPreset(id: string | undefined): LlmProviderPreset | undefined {
  if (!id) return undefined;
  return LLM_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** 预设是否要求 API Key（未知预设按需要 Key 处理，更安全）。 */
export function presetRequiresApiKey(presetId: string | undefined): boolean {
  const preset = findLlmPreset(presetId);
  return preset ? preset.apiKeyRequired : true;
}
