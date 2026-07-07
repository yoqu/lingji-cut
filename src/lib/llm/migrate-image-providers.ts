import type { AISettings, ImageProviderType } from '../../types/ai';

// 各 provider 类型的默认模型列表（避免跨越 web ↔ node 边界依赖 image-gen registry）
const DEFAULT_MODELS: Record<ImageProviderType, string[]> = {
  jimeng: ['jimeng-5.0'],
  openai_image: ['gpt-image-1'],
  minimax: ['image-01'],
  doubao: ['doubao-seedream-3.0-t2i-250415'],
  imagen: ['imagen-3.0-generate-002'],
  wanx: ['wanx2.1-t2i-turbo'],
  apimart: ['gpt-image-2'],
  custom: [],
};

/**
 * V2：对 imageProviders 中每个 provider 做兼容补全：
 * - extras 缺失 → 补 extras: {}
 * - models 为空数组 → 根据 type 用默认值兜底（已有自定义 models 时不覆盖）
 */
export function migrateImageProvidersV2(settings: AISettings): AISettings {
  if (!settings.imageProviders?.length) return settings;

  let changed = false;
  const nextProviders = settings.imageProviders.map((p) => {
    let next = p;

    // 补全 extras
    if (next.extras === undefined) {
      next = { ...next, extras: {} };
      changed = true;
    }

    // models 为空时用默认值兜底
    if (next.models.length === 0) {
      const defaults = DEFAULT_MODELS[next.type] ?? [];
      if (defaults.length > 0) {
        next = { ...next, models: defaults };
        changed = true;
      }
    }

    return next;
  });

  if (!changed) return settings;
  return { ...settings, imageProviders: nextProviders };
}

export function migrateImageProviders(settings: AISettings): AISettings {
  if (settings.imageProviders?.length) return migrateImageProvidersV2(settings);

  const alreadyHasDefaults =
    Array.isArray(settings.imageProviders) &&
    settings.imageProviders.length === 0 &&
    settings.defaultImageProviderId === null &&
    settings.defaultImageModel === null;
  if (alreadyHasDefaults) return settings;
  return {
    ...settings,
    imageProviders: [],
    defaultImageProviderId: null,
    defaultImageModel: null,
  };
}
