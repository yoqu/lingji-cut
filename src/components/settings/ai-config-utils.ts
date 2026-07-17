import type {
  ImageProvider,
  LLMProvider,
  PiMaxTokensField,
  PiModelCompat,
  PiModelCost,
  PiModelInputType,
  PiProviderApi,
  PiProviderProjectionOptions,
  PiThinkingFormat,
  PiThinkingLevelMap,
  VideoProvider,
  SunoAudioGenerationSettings,
} from '../../types/ai';
import {
  applyPiProviderPreset,
  findPiProviderPresetByBuiltinId,
} from '../../lib/llm/pi-provider-presets';

export interface ProviderDraftErrors {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string;
}

export interface ImageProviderDraftErrors {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string;
}

export interface VideoProviderDraftErrors {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string;
}

const PI_PROVIDER_APIS: PiProviderApi[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
];
const PI_INPUT_TYPES: PiModelInputType[] = ['text', 'image'];
const PI_MAX_TOKEN_FIELDS: PiMaxTokensField[] = ['max_tokens', 'max_completion_tokens'];
const PI_THINKING_FORMATS: PiThinkingFormat[] = [
  'openai',
  'openrouter',
  'deepseek',
  'together',
  'zai',
  'qwen',
  'qwen-chat-template',
];
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

interface AIConfigSnapshotInput {
  providers: LLMProvider[];
  defaultProviderId: string | null;
  defaultModel: string | null;
  imageProviders?: ImageProvider[];
  defaultImageProviderId?: string | null;
  defaultImageModel?: string | null;
  globalCoverImagePrompt?: string;
  videoProviders?: VideoProvider[];
  defaultVideoProviderId?: string | null;
  defaultVideoModel?: string | null;
  audioGeneration?: SunoAudioGenerationSettings;
}

/** 修剪空白并去重的模型列表归一化，LLM / 图像 / 视频 provider 共用。 */
function dedupeTrimmedModels(models: string[]): string[] {
  return models
    .map((model) => model.trim())
    .filter((model, index, list) => model.length > 0 && list.indexOf(model) === index);
}

export function normalizeProviderDraft(provider: LLMProvider): LLMProvider {
  const pi = normalizePiProjectionOptions(provider.pi);
  const withNormalizedPi = { ...provider, ...(pi ? { pi } : { pi: undefined }) };
  const preset = findPiProviderPresetByBuiltinId(pi?.builtinProviderId);
  const withPresetDefaults = preset
    ? applyPiProviderPreset(withNormalizedPi, preset)
    : withNormalizedPi;
  const models = dedupeTrimmedModels(withPresetDefaults.models);
  const trimmedDefaultModel = withPresetDefaults.defaultModel?.trim();
  const defaultModel =
    trimmedDefaultModel && models.includes(trimmedDefaultModel) ? trimmedDefaultModel : undefined;
  return {
    ...withPresetDefaults,
    name: withPresetDefaults.name.trim(),
    baseUrl: withPresetDefaults.baseUrl.trim(),
    apiKey: withPresetDefaults.apiKey.trim(),
    models,
    defaultModel,
    enableThinking: withPresetDefaults.enableThinking ?? true,
  };
}

export function normalizeProviderDrafts(providers: LLMProvider[]): LLMProvider[] {
  return providers.map(normalizeProviderDraft);
}

export function validateProviderDraft(provider: LLMProvider): ProviderDraftErrors {
  const normalized = normalizeProviderDraft(provider);
  const errors: ProviderDraftErrors = {};

  if (!normalized.name) {
    errors.name = '请输入生成服务名称';
  }

  if (
    !normalized.baseUrl &&
    normalized.type !== 'gemini' &&
    normalized.type !== 'lmstudio' &&
    !normalized.pi?.builtinProviderId
  ) {
    errors.baseUrl = '请输入 Base URL';
  }

  if (!normalized.apiKey && normalized.type !== 'lmstudio') {
    errors.apiKey = '请输入 API Key';
  }

  if (normalized.models.length === 0) {
    errors.models = '请至少添加一个模型';
  }

  return errors;
}

export function normalizeProviderSelection(
  providers: LLMProvider[],
  preferredDefaultProviderId: string | null,
  preferredDefaultModel: string | null,
): { defaultProviderId: string | null; defaultModel: string | null } {
  if (providers.length === 0) {
    return { defaultProviderId: null, defaultModel: null };
  }

  const normalizedProviders = normalizeProviderDrafts(providers);
  const activeProvider =
    normalizedProviders.find((provider) => provider.id === preferredDefaultProviderId) ??
    normalizedProviders[0];

  // 全局默认模型优先级：调用方偏好（若仍在该 Provider 模型列表内）→ 该 Provider 自己的
  // 默认模型 → 模型列表首项。
  const defaultModel =
    activeProvider.models.find((model) => model === preferredDefaultModel) ??
    (activeProvider.defaultModel && activeProvider.models.includes(activeProvider.defaultModel)
      ? activeProvider.defaultModel
      : undefined) ??
    activeProvider.models[0] ??
    null;

  return {
    defaultProviderId: activeProvider.id,
    defaultModel,
  };
}

export function createAIConfigSnapshot({
  providers,
  defaultProviderId,
  defaultModel,
  imageProviders,
  defaultImageProviderId,
  defaultImageModel,
  globalCoverImagePrompt,
  videoProviders,
  defaultVideoProviderId,
  defaultVideoModel,
  audioGeneration,
}: AIConfigSnapshotInput): string {
  const normalizedProviders = normalizeProviderDrafts(providers);
  const selection = normalizeProviderSelection(
    normalizedProviders,
    defaultProviderId,
    defaultModel,
  );
  const normalizedImageProviders = imageProviders
    ? normalizeImageProviderDrafts(imageProviders)
    : [];
  const normalizedVideoProviders = videoProviders
    ? normalizeVideoProviderDrafts(videoProviders)
    : [];

  return JSON.stringify({
    providers: normalizedProviders,
    defaultProviderId: selection.defaultProviderId,
    defaultModel: selection.defaultModel,
    imageProviders: normalizedImageProviders,
    defaultImageProviderId: defaultImageProviderId ?? null,
    defaultImageModel: defaultImageModel ?? null,
    globalCoverImagePrompt: (globalCoverImagePrompt ?? '').trim(),
    videoProviders: normalizedVideoProviders,
    defaultVideoProviderId: defaultVideoProviderId ?? null,
    defaultVideoModel: defaultVideoModel ?? null,
    audioGeneration: audioGeneration ?? null,
  });
}

export function hasUnsavedAIConfigChanges(
  lastSavedSnapshot: string,
  currentSnapshot: string,
): boolean {
  return lastSavedSnapshot !== currentSnapshot;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n > 0 ? n : undefined;
}

function normalizePiHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const header = key.trim();
    const headerValue = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (header && headerValue) {
      out[header] = headerValue;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizePiCompat(value: unknown): PiModelCompat | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const out: PiModelCompat = {};
  const booleanKeys: Array<keyof PiModelCompat> = [
    'supportsStore',
    'supportsDeveloperRole',
    'supportsReasoningEffort',
    'supportsUsageInStreaming',
    'requiresToolResultName',
    'requiresAssistantAfterToolResult',
    'requiresThinkingAsText',
    'requiresReasoningContentOnAssistantMessages',
    'supportsStrictMode',
    'supportsLongCacheRetention',
    'supportsEagerToolInputStreaming',
    'sendSessionAffinityHeaders',
    'supportsCacheControlOnTools',
    'forceAdaptiveThinking',
    'allowEmptySignature',
  ];
  for (const key of booleanKeys) {
    if (typeof input[key] === 'boolean') {
      (out as Record<string, boolean>)[key] = input[key] as boolean;
    }
  }
  if (PI_MAX_TOKEN_FIELDS.includes(input.maxTokensField as PiMaxTokensField)) {
    out.maxTokensField = input.maxTokensField as PiMaxTokensField;
  }
  if (PI_THINKING_FORMATS.includes(input.thinkingFormat as PiThinkingFormat)) {
    out.thinkingFormat = input.thinkingFormat as PiThinkingFormat;
  }
  if (input.cacheControlFormat === 'anthropic') {
    out.cacheControlFormat = 'anthropic';
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizePiInputTypes(value: unknown): PiModelInputType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = PI_INPUT_TYPES.filter((type) => value.includes(type));
  return out.length > 0 ? out : undefined;
}

function normalizePiCost(value: unknown): Partial<PiModelCost> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    const n = input[key];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
      out[key] = n;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizePiThinkingLevelMap(value: unknown): PiThinkingLevelMap | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const out: PiThinkingLevelMap = {};
  for (const level of PI_THINKING_LEVELS) {
    const raw = input[level];
    if (raw === null) {
      out[level] = null;
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed) out[level] = trimmed;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizePiProjectionOptions(
  value: LLMProvider['pi'],
): PiProviderProjectionOptions | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const out: PiProviderProjectionOptions = {};
  if (typeof value.builtinProviderId === 'string') {
    const id = value.builtinProviderId.trim();
    if (id) out.builtinProviderId = id;
  }
  if (PI_PROVIDER_APIS.includes(value.api as PiProviderApi)) {
    out.api = value.api;
  }
  if (typeof value.authHeader === 'boolean') {
    out.authHeader = value.authHeader;
  }
  const headers = normalizePiHeaders(value.headers);
  if (headers) out.headers = headers;
  const compat = normalizePiCompat(value.compat);
  if (compat) out.compat = compat;

  const model: NonNullable<PiProviderProjectionOptions['model']> = {};
  if (typeof value.model?.reasoning === 'boolean') {
    model.reasoning = value.model.reasoning;
  }
  const input = normalizePiInputTypes(value.model?.input);
  if (input) model.input = input;
  const contextWindow = normalizePositiveInteger(value.model?.contextWindow);
  if (contextWindow) model.contextWindow = contextWindow;
  const maxTokens = normalizePositiveInteger(value.model?.maxTokens);
  if (maxTokens) model.maxTokens = maxTokens;
  const cost = normalizePiCost(value.model?.cost);
  if (cost) model.cost = cost;
  const thinkingLevelMap = normalizePiThinkingLevelMap(value.model?.thinkingLevelMap);
  if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap;
  if (Object.keys(model).length > 0) out.model = model;

  return Object.keys(out).length > 0 ? out : undefined;
}

// ─── Image / Video Provider 校验与归一化（共用骨架） ─────────────────────

function normalizeMediaProviderDraft<T extends {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}>(provider: T): T {
  return {
    ...provider,
    name: provider.name.trim(),
    baseUrl: provider.baseUrl.trim(),
    apiKey: provider.apiKey.trim(),
    models: dedupeTrimmedModels(provider.models),
  };
}

function validateMediaProviderDraft(
  normalized: { name: string; baseUrl: string; apiKey: string; models: string[] },
  apiKeyLabel: string,
): { name?: string; baseUrl?: string; apiKey?: string; models?: string } {
  const errors: { name?: string; baseUrl?: string; apiKey?: string; models?: string } = {};
  if (!normalized.name) errors.name = '请输入生成服务名称';
  if (!normalized.baseUrl) errors.baseUrl = '请输入 Base URL';
  if (!normalized.apiKey) errors.apiKey = `请输入 ${apiKeyLabel}`;
  if (normalized.models.length === 0) errors.models = '请至少添加一个模型';
  return errors;
}

export function normalizeImageProviderDraft(provider: ImageProvider): ImageProvider {
  return normalizeMediaProviderDraft(provider);
}

export function normalizeImageProviderDrafts(providers: ImageProvider[]): ImageProvider[] {
  return providers.map(normalizeImageProviderDraft);
}

export function validateImageProviderDraft(provider: ImageProvider): ImageProviderDraftErrors {
  const normalized = normalizeImageProviderDraft(provider);
  return validateMediaProviderDraft(
    normalized,
    normalized.type === 'jimeng' ? 'Session ID' : 'API Key',
  );
}

export function normalizeVideoProviderDraft(provider: VideoProvider): VideoProvider {
  return normalizeMediaProviderDraft(provider);
}

export function normalizeVideoProviderDrafts(providers: VideoProvider[]): VideoProvider[] {
  return providers.map(normalizeVideoProviderDraft);
}

export function validateVideoProviderDraft(provider: VideoProvider): VideoProviderDraftErrors {
  return validateMediaProviderDraft(normalizeVideoProviderDraft(provider), 'API Key');
}
