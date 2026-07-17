import type { SunoAudioGenerationSettings } from '../../types/ai';

export const DEFAULT_SUNO_CALLBACK_URL =
  'https://lingji.qushenma.com/api/audio-generation/suno-callback';

export const DEFAULT_SUNO_AUDIO_SETTINGS: SunoAudioGenerationSettings = {
  enabled: false,
  baseUrl: 'https://api.sunoapi.org',
  apiKey: '',
  callbackUrl: DEFAULT_SUNO_CALLBACK_URL,
  musicModel: 'V5',
  pollIntervalMs: 10_000,
  timeoutMs: 600_000,
};

export function normalizeSunoAudioSettings(
  value?: Partial<SunoAudioGenerationSettings> | null,
): SunoAudioGenerationSettings {
  return {
    ...DEFAULT_SUNO_AUDIO_SETTINGS,
    ...value,
    baseUrl: value?.baseUrl?.trim() || DEFAULT_SUNO_AUDIO_SETTINGS.baseUrl,
    apiKey: value?.apiKey?.trim() ?? '',
    callbackUrl: value?.callbackUrl?.trim() || DEFAULT_SUNO_CALLBACK_URL,
    musicModel: value?.musicModel === 'V5_5' ? 'V5_5' : 'V5',
    pollIntervalMs: Math.max(2_000, value?.pollIntervalMs ?? 10_000),
    timeoutMs: Math.max(60_000, value?.timeoutMs ?? 600_000),
  };
}
