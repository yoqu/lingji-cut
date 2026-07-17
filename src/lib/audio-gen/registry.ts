import { createSunoApiProvider } from './sunoapi';
import type { AudioGenerationConfig, AudioGenerationProvider } from './types';

export type AudioGenerationProviderType = 'sunoapi';

export function getAudioGenerationProvider(
  type: AudioGenerationProviderType,
  config: AudioGenerationConfig,
): AudioGenerationProvider {
  if (type !== 'sunoapi') throw new Error(`不支持的音乐/音效 Provider: ${type}`);
  return createSunoApiProvider(config);
}
