import type {
  AISettings,
  ImageProvider,
  LLMProvider,
  PromptBinding,
  PromptBindingMap,
  VideoProvider,
} from '../../types/ai';
import { userPromptBindingKey, type PromptCategory, type PromptKind } from '../prompts/types';

export type PromptBindingErrorCode =
  | 'PROVIDER_MISSING'
  | 'MODEL_NOT_IN_PROVIDER'
  | 'IMAGE_PROVIDER_MISSING'
  | 'IMAGE_MODEL_NOT_IN_PROVIDER'
  | 'VIDEO_PROVIDER_MISSING'
  | 'VIDEO_MODEL_NOT_IN_PROVIDER';

export class PromptBindingError extends Error {
  constructor(
    public readonly code: PromptBindingErrorCode,
    public readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = 'PromptBindingError';
  }
}

export interface ResolvedBinding {
  provider: LLMProvider;
  model: string;
  imageProvider?: ImageProvider;
  imageModel?: string;
  videoProvider?: VideoProvider;
  videoModel?: string;
}

function pickFirstNonNull<T>(...values: Array<T | null | undefined>): T | null {
  for (const v of values) {
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function resolveLlmByKey(
  key: string,
  settings: AISettings,
  project: PromptBindingMap | null,
  options: { allowGlobalBinding?: boolean } = {},
): { provider: LLMProvider; model: string } {
  const allowGlobal = options.allowGlobalBinding ?? true;
  const projectB: PromptBinding | undefined = project?.[key];
  const globalB: PromptBinding | undefined = allowGlobal ? settings.promptBindings?.[key] : undefined;

  const providerId = pickFirstNonNull(
    projectB?.providerId,
    globalB?.providerId,
    settings.defaultProviderId,
  );

  if (!providerId) {
    throw new PromptBindingError(
      'PROVIDER_MISSING',
      key,
      `提示词 ${key} 未绑定 LLM 且无全局默认 Provider/Model`,
    );
  }
  const provider = settings.llmProviders.find((p) => p.id === providerId);
  if (!provider) {
    throw new PromptBindingError(
      'PROVIDER_MISSING',
      key,
      `提示词 ${key} 绑定的 Provider ${providerId} 不存在`,
    );
  }
  // 模型回退链：提示词级绑定 → 全局提示词绑定 → 该 Provider 的默认模型 → 全局默认模型。
  const model = pickFirstNonNull(
    projectB?.model,
    globalB?.model,
    provider.defaultModel,
    settings.defaultModel,
  );
  if (!model) {
    throw new PromptBindingError(
      'PROVIDER_MISSING',
      key,
      `提示词 ${key} 未绑定 LLM 且无全局默认 Provider/Model`,
    );
  }
  if (!provider.models.includes(model)) {
    throw new PromptBindingError(
      'MODEL_NOT_IN_PROVIDER',
      key,
      `提示词 ${key} 绑定的模型 ${model} 不在 Provider ${provider.name} 的模型列表里`,
    );
  }
  return { provider, model };
}

function resolveLlm(
  kind: PromptKind,
  settings: AISettings,
  project: PromptBindingMap | null,
): { provider: LLMProvider; model: string } {
  return resolveLlmByKey(kind, settings, project);
}

/** image / video 绑定解析共用骨架：项目绑定 → 全局绑定 → 全局默认，校验 provider 存在且 model ∈ models。 */
function resolveMediaBinding<P extends { id: string; name: string; models: string[] }>(
  kind: PromptKind,
  providers: P[],
  picks: {
    providerId: Array<string | null | undefined>;
    model: Array<string | null | undefined>;
  },
  errors: {
    missing: PromptBindingErrorCode;
    modelNotIn: PromptBindingErrorCode;
    label: string;
  },
): { provider: P; model: string } {
  const providerId = pickFirstNonNull(...picks.providerId);
  const model = pickFirstNonNull(...picks.model);

  if (!providerId || !model) {
    throw new PromptBindingError(
      errors.missing,
      kind,
      `提示词 ${kind} 未绑定 ${errors.label} 且无全局默认`,
    );
  }
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) {
    throw new PromptBindingError(
      errors.missing,
      kind,
      `提示词 ${kind} 绑定的 ${errors.label} ${providerId} 不存在`,
    );
  }
  if (!provider.models.includes(model)) {
    throw new PromptBindingError(
      errors.modelNotIn,
      kind,
      `提示词 ${kind} 绑定的模型 ${model} 不在 ${errors.label} ${provider.name} 的模型列表里`,
    );
  }
  return { provider, model };
}

function resolveImage(
  kind: PromptKind,
  settings: AISettings,
  project: PromptBindingMap | null,
): { imageProvider: ImageProvider; imageModel: string } {
  const projectB = project?.[kind];
  const globalB = settings.promptBindings?.[kind];
  const { provider, model } = resolveMediaBinding(kind, settings.imageProviders, {
    providerId: [projectB?.imageProviderId, globalB?.imageProviderId, settings.defaultImageProviderId],
    model: [projectB?.imageModel, globalB?.imageModel, settings.defaultImageModel],
  }, {
    missing: 'IMAGE_PROVIDER_MISSING',
    modelNotIn: 'IMAGE_MODEL_NOT_IN_PROVIDER',
    label: 'ImageProvider',
  });
  return { imageProvider: provider, imageModel: model };
}

function resolveVideo(
  kind: PromptKind,
  settings: AISettings,
  project: PromptBindingMap | null,
): { videoProvider: VideoProvider; videoModel: string } {
  const projectB = project?.[kind];
  const globalB = settings.promptBindings?.[kind];
  const { provider, model } = resolveMediaBinding(kind, settings.videoProviders, {
    providerId: [projectB?.videoProviderId, globalB?.videoProviderId, settings.defaultVideoProviderId],
    model: [projectB?.videoModel, globalB?.videoModel, settings.defaultVideoModel],
  }, {
    missing: 'VIDEO_PROVIDER_MISSING',
    modelNotIn: 'VIDEO_MODEL_NOT_IN_PROVIDER',
    label: 'VideoProvider',
  });
  return { videoProvider: provider, videoModel: model };
}

export function resolvePromptBinding(
  kind: PromptKind,
  settings: AISettings,
  project: PromptBindingMap | null,
): ResolvedBinding {
  const llm = resolveLlm(kind, settings, project);
  if (kind === 'cover.regeneration' || kind === 'card.image') {
    const img = resolveImage(kind, settings, project);
    return { ...llm, ...img };
  }
  if (kind === 'card.video') {
    const vid = resolveVideo(kind, settings, project);
    return { ...llm, ...vid };
  }
  return llm;
}

/**
 * 解析用户自定义提示词条目的绑定（如口播模板）。
 * 仅查项目级绑定，未绑定时回落到全局默认 LLM（AISettings.defaultProviderId / defaultModel）。
 * 不支持全局级模板绑定——用户模板的绑定统一由项目管理。
 */
export function resolveUserPromptBinding(
  category: PromptCategory,
  id: string,
  settings: AISettings,
  project: PromptBindingMap | null,
): { provider: LLMProvider; model: string } {
  const key = userPromptBindingKey(category, id);
  return resolveLlmByKey(key, settings, project, { allowGlobalBinding: false });
}

/**
 * 读取某个用户模板在当前项目下的绑定原值（不做回退，未设置时返回 null）。
 * 用于 UI 展示"是否绑定 / 绑定了什么"。
 */
export function getUserPromptProjectBinding(
  category: PromptCategory,
  id: string,
  project: PromptBindingMap | null,
): PromptBinding | null {
  if (!project) return null;
  const key = userPromptBindingKey(category, id);
  return project[key] ?? null;
}
