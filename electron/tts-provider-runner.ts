import type { TTSProvider, TTSVoicePreset } from '../src/types/ai';
import { INSUFFICIENT_CREDITS_MESSAGE, isLingjiGatewayKey } from '../src/lib/llm/credits-error';
import {
  buildMinimaxTtsRequestBody,
  decodeMinimaxAudioData,
  extractMinimaxSubtitleSentences,
  getMinimaxDurationMs,
  subtitleJsonToSRT,
  type MinimaxSubtitleSentence,
  type MinimaxTtsResponse,
} from '../src/lib/minimax-tts';
import {
  buildXiaomiMimoTtsRequestBody,
  decodeXiaomiMimoAudioData,
  readXiaomiMimoReferenceAudio,
  resolveXiaomiMimoTtsUrl,
  type XiaomiMimoTtsResponse,
} from '../src/lib/xiaomi-mimo-tts';

export interface TTSRunnerResult {
  audioBuffer: Buffer;
  audioExtension: 'mp3' | 'wav';
  subtitleText?: string;
  durationMs?: number;
}

export interface TTSRunnerOptions {
  text: string;
  provider: TTSProvider;
  voice: TTSVoicePreset;
  signal: AbortSignal;
  styleInstruction?: string;
  speakText?: string;
}

async function runMinimaxTTS(options: TTSRunnerOptions): Promise<TTSRunnerResult> {
  const { text, provider, voice, signal } = options;
  const response = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/v1/t2a_v2`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
    },
    signal,
    body: JSON.stringify(
      buildMinimaxTtsRequestBody({
        text,
        voiceId: voice.voiceId ?? '',
        speed: voice.params.speed,
        vol: voice.params.vol ?? 1,
        pitch: voice.params.pitch ?? 0,
        emotion: voice.params.emotion ?? '',
        model: voice.model ?? provider.models[0] ?? '',
      }),
    ),
  });

  if (!response.ok) {
    if (response.status === 402 && isLingjiGatewayKey(provider.apiKey)) {
      throw new Error(INSUFFICIENT_CREDITS_MESSAGE);
    }
    const errText = await response.text().catch(() => String(response.status));
    throw new Error(`MiniMax TTS 请求失败: ${errText}`);
  }

  const result = (await response.json()) as MinimaxTtsResponse;
  const baseResp = result.base_resp;
  if (baseResp && typeof baseResp.status_code === 'number' && baseResp.status_code !== 0) {
    throw new Error(
      `MiniMax TTS 接口错误: [${baseResp.status_code}] ${baseResp.status_msg ?? '未知错误'}`,
    );
  }

  const audioField = result.data?.audio ?? '';
  if (!audioField) {
    throw new Error('MiniMax TTS 未返回任何音频数据，请检查 API Key 及配置');
  }

  let audioBuffer: Buffer;
  if (/^https?:\/\//.test(audioField)) {
    const audioResponse = await fetch(audioField, { signal });
    if (!audioResponse.ok) {
      throw new Error(`MiniMax 音频下载失败: HTTP ${audioResponse.status}`);
    }
    audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
  } else {
    audioBuffer = decodeMinimaxAudioData(audioField);
  }

  let subtitleSentences: MinimaxSubtitleSentence[] = [];
  if (result.data?.subtitle_file) {
    try {
      const subtitleResp = await fetch(result.data.subtitle_file, { signal });
      if (!subtitleResp.ok) {
        throw new Error(`字幕文件下载失败: HTTP ${subtitleResp.status}`);
      }
      subtitleSentences = extractMinimaxSubtitleSentences(await subtitleResp.json());
    } catch {
      subtitleSentences = [];
    }
  } else {
    subtitleSentences = extractMinimaxSubtitleSentences(result.data);
  }

  return {
    audioBuffer,
    audioExtension: 'mp3',
    subtitleText: subtitleJsonToSRT(subtitleSentences),
    durationMs: getMinimaxDurationMs(result, subtitleSentences),
  };
}

async function runXiaomiMimoTTS(options: TTSRunnerOptions): Promise<TTSRunnerResult> {
  const { text, provider, voice, signal } = options;
  if (voice.source !== 'cloned') {
    throw new Error('MiMo TTS 当前需要选择克隆音色');
  }

  const reference = await readXiaomiMimoReferenceAudio(voice.referenceAudioPath);
  const response = await fetch(resolveXiaomiMimoTtsUrl(provider), {
    method: 'POST',
    headers: {
      'api-key': provider.apiKey,
      'Content-Type': 'application/json',
    },
    signal,
    body: JSON.stringify(
      buildXiaomiMimoTtsRequestBody({
        text,
        provider,
        voice,
        referenceAudioBase64: reference.data.toString('base64'),
        referenceAudioMime: reference.mime,
        styleInstruction: options.styleInstruction,
        speakText: options.speakText,
      }),
    ),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => String(response.status));
    throw new Error(`MiMo TTS 请求失败: ${errText}`);
  }

  const audioBuffer = decodeXiaomiMimoAudioData((await response.json()) as XiaomiMimoTtsResponse);
  return {
    audioBuffer,
    audioExtension: 'wav',
  };
}

export async function runTTSProvider(options: TTSRunnerOptions): Promise<TTSRunnerResult> {
  if (!options.provider.apiKey.trim()) {
    throw new Error('口播生成服务缺少 API Key');
  }

  if (options.provider.type === 'minimax') {
    return runMinimaxTTS(options);
  }

  if (options.provider.type === 'xiaomi_mimo') {
    return runXiaomiMimoTTS(options);
  }

  throw new Error('该口播生成服务类型暂未接入生成实现');
}
