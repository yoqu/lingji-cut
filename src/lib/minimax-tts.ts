export interface MinimaxSubtitleSentence {
  text?: string;
  pronounce_text?: string;
  begin_time?: number;
  end_time?: number;
  time_begin?: number;
  time_end?: number;
}

export interface MinimaxTtsResponse {
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
  data?: {
    audio?: string;
    subtitle_file?: string;
    subtitles?: MinimaxSubtitleSentence[];
  };
  extra_info?: {
    audio_length?: number;
    audio_size?: number;
    usage_characters?: number;
  };
}

export interface BuildMinimaxTtsRequestOptions {
  text: string;
  voiceId: string;
  speed: number;
  vol: number;
  pitch: number;
  emotion: string;
  model: string;
}

interface MinimaxSubtitlePayload {
  subtitles?: MinimaxSubtitleSentence[];
  data?: {
    subtitles?: MinimaxSubtitleSentence[];
  };
}

export function toSRTTime(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  const h = Math.floor(safeMs / 3_600_000);
  const m = Math.floor((safeMs % 3_600_000) / 60_000);
  const s = Math.floor((safeMs % 60_000) / 1_000);
  const mil = safeMs % 1_000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(mil).padStart(3, '0')}`;
}

function readSubtitleStartMs(sentence: MinimaxSubtitleSentence): number {
  return Number(sentence.begin_time ?? sentence.time_begin ?? 0);
}

function readSubtitleEndMs(sentence: MinimaxSubtitleSentence): number {
  return Number(sentence.end_time ?? sentence.time_end ?? 0);
}

function readSubtitleText(sentence: MinimaxSubtitleSentence): string {
  return String(sentence.text ?? sentence.pronounce_text ?? '').trim();
}

export function buildMinimaxTtsRequestBody(options: BuildMinimaxTtsRequestOptions): Record<string, unknown> {
  const voiceSetting: Record<string, unknown> = {
    voice_id: options.voiceId,
    speed: options.speed,
    vol: options.vol,
    pitch: options.pitch,
  };

  if (options.emotion) {
    voiceSetting.emotion = options.emotion;
  }

  return {
    model: options.model || 'speech-2.8-hd',
    text: options.text,
    stream: false,
    output_format: 'hex',
    voice_setting: voiceSetting,
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
    },
    subtitle_enable: true,
    language_boost: 'Chinese',
  };
}

export function extractMinimaxSubtitleSentences(payload: unknown): MinimaxSubtitleSentence[] {
  if (Array.isArray(payload)) {
    return payload as MinimaxSubtitleSentence[];
  }

  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const subtitlePayload = payload as MinimaxSubtitlePayload;

  if (Array.isArray(subtitlePayload.subtitles)) {
    return subtitlePayload.subtitles;
  }

  if (Array.isArray(subtitlePayload.data?.subtitles)) {
    return subtitlePayload.data.subtitles;
  }

  return [];
}

export function subtitleJsonToSRT(sentences: MinimaxSubtitleSentence[]): string {
  const normalized = sentences
    .map((sentence) => ({
      startMs: readSubtitleStartMs(sentence),
      endMs: readSubtitleEndMs(sentence),
      text: readSubtitleText(sentence),
    }))
    .filter((sentence) => sentence.text && sentence.endMs >= sentence.startMs);

  if (normalized.length === 0) {
    return '';
  }

  return (
    normalized
      .map((sentence, index) => {
        return `${index + 1}\n${toSRTTime(sentence.startMs)} --> ${toSRTTime(sentence.endMs)}\n${sentence.text}`;
      })
      .join('\n\n') + '\n'
  );
}

export function getMinimaxDurationMs(
  response: Pick<MinimaxTtsResponse, 'extra_info'>,
  sentences: MinimaxSubtitleSentence[],
): number {
  const subtitleDurationMs = sentences.reduce((maxDuration, sentence) => {
    return Math.max(maxDuration, readSubtitleEndMs(sentence));
  }, 0);

  if (subtitleDurationMs > 0) {
    return subtitleDurationMs;
  }

  const audioLengthMs = Number(response.extra_info?.audio_length ?? 0);
  return Number.isFinite(audioLengthMs) && audioLengthMs > 0 ? Math.round(audioLengthMs) : 0;
}

export function decodeMinimaxAudioData(audioData: string): Buffer {
  const normalized = audioData.replace(/\s+/g, '');
  if (!normalized) {
    throw new Error('MiniMax TTS 未返回有效音频数据');
  }

  if (/^[0-9a-f]+$/i.test(normalized) && normalized.length % 2 === 0) {
    return Buffer.from(normalized, 'hex');
  }

  return Buffer.from(normalized, 'base64');
}
