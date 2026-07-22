import type { AISettings, LLMProvider } from '../../types/ai';
import { KIMI_CODING_BASE_URL, KIMI_CODING_MODELS } from './pi-provider-presets';

const LEGACY_KIMI_CODING_BASE_URL = 'https://api.kimi.com/coding';
const LEGACY_KIMI_CODING_MODELS = ['k2p7', 'kimi-k2-thinking', 'kimi-for-coding'];
const REMOVED_KIMI_CODING_MODELS = new Set(['k2p7', 'kimi-k2-thinking']);

function inferProviderName(baseUrl: string): string {
  const lower = baseUrl.toLowerCase();
  if (lower.includes('lmstudio') || lower.includes('localhost:1234') || lower.includes('127.0.0.1:1234')) {
    return 'LM Studio';
  }
  if (lower.includes('deepseek')) return 'DeepSeek';
  if (lower.includes('openai')) return 'OpenAI';
  if (lower.includes('anthropic')) return 'Anthropic';
  if (lower.includes('generativelanguage') || lower.includes('gemini')) return 'Gemini';
  if (lower.includes('moonshot') || lower.includes('kimi')) return 'Moonshot';
  if (lower.includes('dashscope') || lower.includes('qwen')) return 'Qwen';
  if (lower.includes('zhipu') || lower.includes('bigmodel')) return 'ZhipuAI';
  try {
    const host = new URL(baseUrl).hostname;
    return host.split('.').slice(-2, -1)[0] ?? 'Custom';
  } catch {
    return 'Custom';
  }
}

function inferProviderType(baseUrl: string): LLMProvider['type'] {
  const lower = baseUrl.toLowerCase();
  if (lower.includes('lmstudio') || lower.includes('localhost:1234') || lower.includes('127.0.0.1:1234')) {
    return 'lmstudio';
  }
  return 'openai_compatible';
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 把旧的全局 `enableThinking` 下沉到每个 provider；
 * provider 已显式设置过则不覆盖，未设置时继承全局值。
 */
function backfillProviderThinking(settings: AISettings): AISettings {
  const globalThinking = settings.enableThinking;
  if (globalThinking === undefined) {
    return settings;
  }
  let mutated = false;
  const nextProviders = settings.llmProviders.map((provider) => {
    if (provider.enableThinking !== undefined) {
      return provider;
    }
    mutated = true;
    return { ...provider, enableThinking: globalThinking };
  });
  if (!mutated) {
    return settings;
  }
  return { ...settings, llmProviders: nextProviders };
}

/**
 * 清洗已下线的 provider 类型：
 * - `anthropic` → `minimax`（同为 Anthropic Messages 协议，配置无损迁移）
 * - `claude_code_acp` 已随 ACP 运行时移除，直接剔除；默认指向被剔除项时回退到首个可用 provider。
 */
function sanitizeRemovedProviderTypes(settings: AISettings): AISettings {
  const providers = settings.llmProviders ?? [];
  let mutated = false;
  const nextProviders: LLMProvider[] = [];
  for (const provider of providers) {
    const rawType = provider.type as string;
    if (rawType === 'claude_code_acp') {
      mutated = true;
      continue;
    }
    if (rawType === 'anthropic') {
      mutated = true;
      nextProviders.push({ ...provider, type: 'minimax' });
      continue;
    }
    nextProviders.push(provider);
  }
  if (!mutated) return settings;
  const defaultStillValid = nextProviders.some((p) => p.id === settings.defaultProviderId);
  return {
    ...settings,
    llmProviders: nextProviders,
    defaultProviderId: defaultStillValid
      ? settings.defaultProviderId
      : (nextProviders[0]?.id ?? null),
  };
}

/** 只迁移未经用户修改的旧版 Kimi Coding 内置预设。 */
function migrateKimiCodingPreset(settings: AISettings): AISettings {
  const legacyModels = new Set(LEGACY_KIMI_CODING_MODELS);
  const migratedProviderIds = new Set<string>();
  let mutated = false;
  const llmProviders = settings.llmProviders.map((provider) => {
    if (provider.pi?.builtinProviderId !== 'kimi-coding') return provider;

    const normalizedBaseUrl = provider.baseUrl.trim().replace(/\/+$/, '');
    const updateBaseUrl = normalizedBaseUrl === LEGACY_KIMI_CODING_BASE_URL;
    const updateModels =
      provider.models.length === LEGACY_KIMI_CODING_MODELS.length &&
      provider.models.every((model) => legacyModels.has(model)) &&
      LEGACY_KIMI_CODING_MODELS.every((model) => provider.models.includes(model));
    if (!updateBaseUrl && !updateModels) return provider;

    mutated = true;
    if (updateModels) migratedProviderIds.add(provider.id);
    return {
      ...provider,
      ...(updateBaseUrl ? { baseUrl: KIMI_CODING_BASE_URL } : {}),
      ...(updateModels ? { models: [...KIMI_CODING_MODELS] } : {}),
      ...(updateModels && REMOVED_KIMI_CODING_MODELS.has(provider.defaultModel ?? '')
        ? { defaultModel: 'k3' }
        : {}),
    };
  });
  if (!mutated) return settings;

  const updateDefaultModel =
    migratedProviderIds.has(settings.defaultProviderId ?? '') &&
    REMOVED_KIMI_CODING_MODELS.has(settings.defaultModel ?? '');
  return {
    ...settings,
    llmProviders,
    ...(updateDefaultModel ? { defaultModel: 'k3' } : {}),
  };
}

/** 迁移完成后剥离旧的单 provider 字段，避免双真源继续存活。 */
function stripLegacyLlmFields(settings: AISettings): AISettings {
  if (!settings.llmBaseUrl && !settings.llmApiKey && !settings.llmModel) {
    return settings;
  }
  return { ...settings, llmBaseUrl: '', llmApiKey: '', llmModel: '' };
}

export function migrateToProviders(settings: AISettings): AISettings {
  if (settings.llmProviders && settings.llmProviders.length > 0) {
    return stripLegacyLlmFields(
      migrateKimiCodingPreset(sanitizeRemovedProviderTypes(backfillProviderThinking(settings))),
    );
  }
  if (!settings.llmBaseUrl) {
    if (
      Array.isArray(settings.llmProviders) &&
      settings.defaultProviderId === null &&
      settings.defaultModel === null
    ) {
      return settings;
    }
    return { ...settings, llmProviders: [], defaultProviderId: null, defaultModel: null };
  }
  const provider: LLMProvider = {
    id: generateId(),
    name: inferProviderName(settings.llmBaseUrl),
    type: inferProviderType(settings.llmBaseUrl),
    baseUrl: settings.llmBaseUrl,
    apiKey: settings.llmApiKey ?? '',
    models: settings.llmModel ? [settings.llmModel] : [],
    enableThinking: settings.enableThinking ?? true,
  };
  return stripLegacyLlmFields({
    ...settings,
    llmProviders: [provider],
    defaultProviderId: provider.id,
    defaultModel: settings.llmModel || null,
  });
}
