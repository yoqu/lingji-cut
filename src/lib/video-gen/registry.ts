import type { VideoProviderType } from '../../types/ai';
import { VideoGenerationError } from './errors';
import { viduProvider } from './providers/vidu';
import type { VideoGenerationProvider } from './types';

const providers = new Map<VideoProviderType, VideoGenerationProvider>();

export function registerVideoProvider(provider: VideoGenerationProvider): void {
  providers.set(provider.type, provider);
}

registerVideoProvider(viduProvider);

export function getVideoProvider(type: VideoProviderType): VideoGenerationProvider {
  const p = providers.get(type);
  if (!p) {
    throw new VideoGenerationError(
      'invalid_request',
      type,
      `未注册的 video provider type: ${type}`,
    );
  }
  return p;
}

export function listRegisteredVideoProviderTypes(): VideoProviderType[] {
  return Array.from(providers.keys());
}
