import type {
  AudioCandidate,
  AudioGenerationConfig,
  AudioGenerationProvider,
  AudioTask,
  AudioTaskStatus,
  MusicGenerationRequest,
  SoundGenerationRequest,
} from './types';
import { AudioGenerationError } from './types';
import { DEFAULT_SUNO_CALLBACK_URL } from './settings';

const DEFAULT_NEGATIVE_TAGS = [
  'vocals',
  'spoken word',
  'dense lead melody',
  'heavy kick',
  'abrupt drop',
  'busy midrange',
].join(', ');

interface Envelope<T> {
  code: number;
  msg?: string;
  data?: T;
}

const TRANSIENT_CODES = new Set([430, 455, 500]);

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}${path}`;
}

function clampUnit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

function resolveCallbackUrl(config: AudioGenerationConfig): string {
  return config.callbackUrl.trim() || DEFAULT_SUNO_CALLBACK_URL;
}

function parseCandidate(raw: Record<string, unknown>): AudioCandidate | null {
  const audioUrl = String(raw.audioUrl ?? raw.audio_url ?? '');
  if (!audioUrl) return null;
  return {
    id: String(raw.id ?? ''),
    audioUrl,
    streamAudioUrl: String(raw.streamAudioUrl ?? raw.stream_audio_url ?? '') || undefined,
    title: String(raw.title ?? '') || undefined,
    tags: String(raw.tags ?? '') || undefined,
    durationSeconds: typeof raw.duration === 'number' ? raw.duration : undefined,
    modelName: String(raw.modelName ?? raw.model_name ?? '') || undefined,
  };
}

function mapState(status: string): AudioTaskStatus['state'] {
  if (status === 'SUCCESS') return 'succeeded';
  if (status === 'TEXT_SUCCESS' || status === 'FIRST_SUCCESS') return 'partial';
  if (status === 'PENDING') return 'pending';
  return 'failed';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class SunoApiProvider implements AudioGenerationProvider {
  constructor(private readonly config: AudioGenerationConfig) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(endpoint(this.config.baseUrl, path), {
          ...init,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...init.headers,
          },
        });
      } catch (error) {
        if (attempt < 2) {
          await sleep(800 * 2 ** attempt);
          continue;
        }
        throw new AudioGenerationError(
          error instanceof Error ? error.message : '无法连接 SunoAPI.org',
          undefined,
          true,
        );
      }
      const envelope = (await response.json().catch(() => null)) as Envelope<T> | null;
      const code = envelope?.code ?? response.status;
      if (response.ok && code === 200 && envelope?.data !== undefined) return envelope.data;
      const retryable = TRANSIENT_CODES.has(code) || response.status >= 500;
      if (retryable && attempt < 2) {
        await sleep(800 * 2 ** attempt);
        continue;
      }
      throw new AudioGenerationError(envelope?.msg || `SunoAPI 请求失败（${code}）`, code, retryable);
    }
    throw new AudioGenerationError('SunoAPI 请求失败', 500, true);
  }

  async createMusic(request: MusicGenerationRequest): Promise<AudioTask> {
    const data = await this.request<{ taskId: string }>('/api/v1/generate', {
      method: 'POST',
      body: JSON.stringify({
        customMode: true,
        instrumental: true,
        title: request.title.slice(0, 100),
        style: request.style.slice(0, 1000),
        model: request.model ?? this.config.musicModel,
        negativeTags: request.negativeTags?.trim() || DEFAULT_NEGATIVE_TAGS,
        styleWeight: clampUnit(request.styleWeight, 0.75),
        weirdnessConstraint: clampUnit(request.weirdnessConstraint, 0.2),
        callBackUrl: resolveCallbackUrl(this.config),
      }),
    });
    if (!data.taskId) throw new AudioGenerationError('SunoAPI 未返回音乐任务 ID');
    return { taskId: data.taskId, kind: 'music' };
  }

  async createSound(request: SoundGenerationRequest): Promise<AudioTask> {
    const data = await this.request<{ taskId: string }>('/api/v1/generate/sounds', {
      method: 'POST',
      body: JSON.stringify({
        prompt: request.prompt.slice(0, 500),
        model: 'V5',
        soundLoop: request.soundLoop ?? false,
        ...(request.soundTempo ? { soundTempo: Math.min(300, Math.max(1, Math.round(request.soundTempo))) } : {}),
        ...(request.soundKey ? { soundKey: request.soundKey } : {}),
        grabLyrics: false,
        callBackUrl: resolveCallbackUrl(this.config),
      }),
    });
    if (!data.taskId) throw new AudioGenerationError('SunoAPI 未返回声音任务 ID');
    return { taskId: data.taskId, kind: 'sound' };
  }

  async getMusicTask(taskId: string): Promise<AudioTaskStatus> {
    const data = await this.request<Record<string, unknown>>(
      `/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
    );
    const response = (data.response ?? {}) as Record<string, unknown>;
    const rawCandidates = (response.sunoData ?? response.data ?? []) as Record<string, unknown>[];
    const vendorStatus = String(data.status ?? 'PENDING');
    return {
      taskId: String(data.taskId ?? taskId),
      state: mapState(vendorStatus),
      vendorStatus,
      candidates: rawCandidates.map(parseCandidate).filter((item): item is AudioCandidate => Boolean(item)),
      errorCode: typeof data.errorCode === 'number' ? data.errorCode : undefined,
      errorMessage: String(data.errorMessage ?? '') || undefined,
    };
  }

  async getCredits(): Promise<number> {
    return this.request<number>('/api/v1/generate/credit');
  }
}

export function createSunoApiProvider(config: AudioGenerationConfig): SunoApiProvider {
  if (!config.apiKey.trim()) throw new AudioGenerationError('请先配置 SunoAPI.org API Key', 401);
  return new SunoApiProvider(config);
}
