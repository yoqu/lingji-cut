import type { AISettings, TTSProvider, TTSVoicePreset } from '../types/ai';

export const DEFAULT_MINIMAX_TTS_PROVIDER_ID = 'tts-provider-minimax-default';
export const DEFAULT_MINIMAX_TTS_VOICE_ID = 'tts-voice-minimax-default';

export const DEFAULT_MINIMAX_TTS_BASE_URL = 'https://api.minimaxi.com';
export const DEFAULT_MIMO_TTS_BASE_URL = 'https://api.xiaomimimo.com';
export const DEFAULT_MINIMAX_TTS_MODEL = 'speech-2.8-hd';
export const DEFAULT_MIMO_TTS_MODEL = 'mimo-v2.5-tts-voiceclone';
export const DEFAULT_MINIMAX_VOICE_ID = 'male-qn-qingse';

const DEFAULT_TIMESTAMP = 0;

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function uniqueStrings(values: unknown[], fallback: string[]): string[] {
  const normalized = values
    .map((value) => trimString(value))
    .filter((value, index, list) => value.length > 0 && list.indexOf(value) === index);
  return normalized.length > 0 ? normalized : fallback;
}

export function buildLegacyMinimaxTTSProvider(settings: Partial<AISettings>): TTSProvider {
  return {
    id: DEFAULT_MINIMAX_TTS_PROVIDER_ID,
    name: 'MiniMax 默认口播',
    type: 'minimax',
    baseUrl: DEFAULT_MINIMAX_TTS_BASE_URL,
    apiKey: settings.minimaxApiKey ?? '',
    models: [settings.minimaxModel?.trim() || DEFAULT_MINIMAX_TTS_MODEL],
  };
}

export function buildLegacyMinimaxTTSVoice(settings: Partial<AISettings>): TTSVoicePreset {
  const now = DEFAULT_TIMESTAMP;
  return {
    id: DEFAULT_MINIMAX_TTS_VOICE_ID,
    name: 'MiniMax 默认音色',
    providerId: DEFAULT_MINIMAX_TTS_PROVIDER_ID,
    providerType: 'minimax',
    model: settings.minimaxModel?.trim() || DEFAULT_MINIMAX_TTS_MODEL,
    voiceId: settings.minimaxVoiceId?.trim() || DEFAULT_MINIMAX_VOICE_ID,
    source: 'system',
    params: {
      speed: normalizeNumber(settings.minimaxSpeed, 1),
      vol: normalizeNumber(settings.minimaxVol, 1),
      pitch: normalizeNumber(settings.minimaxPitch, 0),
      emotion: settings.minimaxEmotion ?? '',
    },
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeProvider(provider: TTSProvider): TTSProvider | null {
  const name = provider.name.trim();
  const baseUrl = provider.baseUrl.trim();
  const apiKey = provider.apiKey.trim();
  if (!provider.id || !name || !provider.type) return null;
  const displayName =
    provider.id === DEFAULT_MINIMAX_TTS_PROVIDER_ID && name === 'MiniMax 默认 TTS'
      ? 'MiniMax 默认口播'
      : name;
  return {
    ...provider,
    name: displayName,
    baseUrl,
    apiKey,
    models: uniqueStrings(provider.models ?? [], []),
  };
}

function normalizeVoice(voice: TTSVoicePreset, providers: TTSProvider[]): TTSVoicePreset | null {
  const provider = providers.find((item) => item.id === voice.providerId);
  if (!voice.id || !voice.name.trim() || !provider) return null;
  const source = voice.source === 'cloned' ? 'cloned' : 'system';
  const voiceId = trimString(voice.voiceId);
  const referenceAudioPath = trimString(voice.referenceAudioPath);
  if (source === 'system' && !voiceId) return null;
  if (source === 'cloned' && !referenceAudioPath) return null;
  return {
    ...voice,
    name: voice.name.trim(),
    providerType: provider.type,
    model: trimString(voice.model) || provider.models[0] || null,
    voiceId: voiceId || undefined,
    source,
    referenceAudioPath: referenceAudioPath || undefined,
    referenceAudioName: trimString(voice.referenceAudioName) || undefined,
    referenceAudioMime: voice.referenceAudioMime,
    params: {
      speed: normalizeNumber(voice.params?.speed, 1),
      vol: normalizeNumber(voice.params?.vol, 1),
      pitch: normalizeNumber(voice.params?.pitch, 0),
      emotion: voice.params?.emotion ?? '',
    },
    createdAt: normalizeNumber(voice.createdAt, Date.now()),
    updatedAt: normalizeNumber(voice.updatedAt, Date.now()),
  };
}

export function normalizeTTSSettings(settings: AISettings): AISettings {
  const rawProviders = Array.isArray(settings.ttsProviders) ? settings.ttsProviders : [];
  let ttsProviders = rawProviders
    .map((provider) => normalizeProvider(provider))
    .filter((provider): provider is TTSProvider => Boolean(provider));

  if (ttsProviders.length === 0) {
    ttsProviders = [buildLegacyMinimaxTTSProvider(settings)];
  }

  const hasDefaultProvider = ttsProviders.some(
    (provider) => provider.id === settings.defaultTtsProviderId,
  );
  const defaultTtsProviderId = hasDefaultProvider
    ? settings.defaultTtsProviderId
    : ttsProviders[0]?.id ?? null;

  const rawVoices = Array.isArray(settings.ttsVoices) ? settings.ttsVoices : [];
  let ttsVoices = rawVoices
    .map((voice) => normalizeVoice(voice, ttsProviders))
    .filter((voice): voice is TTSVoicePreset => Boolean(voice));

  if (ttsVoices.length === 0) {
    const legacyVoice = buildLegacyMinimaxTTSVoice(settings);
    const defaultProvider = ttsProviders.find((provider) => provider.id === defaultTtsProviderId);
    ttsVoices = [
      {
        ...legacyVoice,
        providerId: defaultProvider?.id ?? legacyVoice.providerId,
        providerType: defaultProvider?.type ?? legacyVoice.providerType,
      },
    ];
  }

  const hasDefaultVoice = ttsVoices.some((voice) => voice.id === settings.defaultTtsVoiceId);
  const defaultTtsVoiceId = hasDefaultVoice
    ? settings.defaultTtsVoiceId
    : ttsVoices[0]?.id ?? null;

  return {
    ...settings,
    ttsProviders,
    defaultTtsProviderId,
    defaultTtsVoiceId,
    ttsVoices,
  };
}

export function resolveDefaultTTSConfig(settings: AISettings): {
  provider: TTSProvider | null;
  voice: TTSVoicePreset | null;
} {
  const normalized = normalizeTTSSettings(settings);
  const voice =
    normalized.ttsVoices.find((item) => item.id === normalized.defaultTtsVoiceId) ??
    normalized.ttsVoices[0] ??
    null;
  const provider =
    normalized.ttsProviders.find((item) => item.id === voice?.providerId) ??
    normalized.ttsProviders.find((item) => item.id === normalized.defaultTtsProviderId) ??
    normalized.ttsProviders[0] ??
    null;
  return { provider, voice };
}
