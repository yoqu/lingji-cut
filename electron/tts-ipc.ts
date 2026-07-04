import { ipcMain, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTTSProvider } from './tts-provider-runner';
import { groupSentencesByBudget, isTruncatedMimoChunk, MIMO_TTS_CHUNK_CHAR_BUDGET, type ChunkPart } from './tts-chunking';
import { buildAlignedSrtFromChunks } from './tts-srt-align';
import { concatWavFiles } from './media-concat';
import {
  buildLegacyMinimaxTTSProvider,
  buildLegacyMinimaxTTSVoice,
} from '../src/lib/tts-settings';
import { buildEstimatedSrtTextFromText } from '../src/lib/srt-resegment';
import { readAudioDurationMs } from './media-duration';
import { makeMainTelemetry } from './telemetry/main-telemetry';
import type { TTSProvider, TTSVoicePreset } from '../src/types/ai';

export interface TtsIpcContext {
  getMainWindow: () => BrowserWindow | null;
  writeAppLog: (level: 'info' | 'warn' | 'error', scope: string, message: string, details?: string) => void;
  resolveRuntimeBinaries: () => { ffmpegPath: string | null; ffprobePath: string | null };
}

const activeTtsRequests = new Map<string, AbortController>();

export function registerTtsIpc(ctx: TtsIpcContext): void {
  const { getMainWindow, writeAppLog, resolveRuntimeBinaries } = ctx;

  ipcMain.handle(
    'generate-tts',
    async (
      _event,
      args: {
        requestId: string;
        text: string;
        provider?: TTSProvider;
        voice?: TTSVoicePreset;
        voiceId?: string;
        speed?: number;
        vol?: number;
        pitch?: number;
        emotion?: string;
        model?: string;
        apiKey?: string;
        projectDir: string;
        telemetryRunId?: string | null;
        styleInstruction?: string;
        sentences?: Array<{ subtitle: string; speak: string }>;
      },
    ) => {
      const { requestId, text, projectDir } = args;
      const provider =
        args.provider ??
        buildLegacyMinimaxTTSProvider({
          minimaxApiKey: args.apiKey ?? '',
          minimaxModel: args.model ?? 'speech-2.8-hd',
        });
      const voice =
        args.voice ??
        buildLegacyMinimaxTTSVoice({
          minimaxVoiceId: args.voiceId ?? 'male-qn-qingse',
          minimaxSpeed: args.speed ?? 1,
          minimaxVol: args.vol ?? 1,
          minimaxPitch: args.pitch ?? 0,
          minimaxEmotion: args.emotion ?? '',
          minimaxModel: args.model ?? 'speech-2.8-hd',
        });
      const model = voice.model ?? provider.models[0] ?? '';
      const controller = new AbortController();
      activeTtsRequests.set(requestId, controller);
      getMainWindow()?.webContents.send('tts-progress', 0);
      const ttsTelemetry = makeMainTelemetry(args.telemetryRunId);
      const ttsStartTs = Date.now();
      ttsTelemetry.emit('stage.start', {
        stage: 'tts',
        chars: text.length,
        model,
        providerType: provider.type,
        voiceSource: voice.source,
      });

      // MiniMax t2a_v2 是同步接口，等待 30~120s。期间无回调信号，用估算心跳把进度从 2% 缓慢推到 30%，
      // 避免 UI 视觉上"卡在 0%"。fetch 返回后会立刻覆盖到 35%。
      let heartbeatPct = 2;
      const HEARTBEAT_CEIL = 30;
      const heartbeat = setInterval(() => {
        if (heartbeatPct < HEARTBEAT_CEIL) {
          heartbeatPct = Math.min(HEARTBEAT_CEIL, heartbeatPct + 1);
          getMainWindow()?.webContents.send('tts-progress', heartbeatPct);
        }
      }, 1500);

      try {
        await fs.mkdir(projectDir, { recursive: true });
        let audioPath: string;
        let durationMs = 0;
        let srtText = '';
        const isMimoChunked =
          provider.type === 'xiaomi_mimo' && Array.isArray(args.sentences) && args.sentences.length > 0;

        if (isMimoChunked) {
          const chunks = groupSentencesByBudget(args.sentences!, MIMO_TTS_CHUNK_CHAR_BUDGET);
          const { ffmpegPath: ffmpegPathOrNull, ffprobePath } = resolveRuntimeBinaries();
          if (!ffmpegPathOrNull) throw new Error('ffmpeg 未找到，无法合并 MiMo 分块音频');
          const ffmpegPath = ffmpegPathOrNull;
          audioPath = path.join(projectDir, 'podcast-audio.wav');
          const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingji-tts-'));
          const parts: ChunkPart[] = [];
          const partPaths: string[] = [];
          try {
            for (let i = 0; i < chunks.length; i++) {
              const speakText = chunks[i].map((u) => u.speak).join('');
              const chunkChars = chunks[i].reduce((n, u) => n + u.subtitle.length, 0);
              const partPath = path.join(tmpDir, `chunk-${i}.wav`);
              let ok = false;
              let durMs = 0;
              let lastErr: unknown;
              for (let attempt = 0; attempt <= 2 && !ok; attempt++) {
                try {
                  const r = await runTTSProvider({
                    text: speakText,
                    provider,
                    voice,
                    signal: controller.signal,
                    styleInstruction: args.styleInstruction,
                    speakText,
                  });
                  if (r.audioBuffer.byteLength === 0) {
                    lastErr = new Error('MiMo 返回空音频');
                    continue;
                  }
                  await fs.writeFile(partPath, r.audioBuffer);
                  // ffprobe 偶发失败时按字数估算时长兜底，不丢弃已合成音频
                  try {
                    durMs = await readAudioDurationMs(partPath, { ffprobePath });
                  } catch {
                    durMs = Math.max(1_000, chunkChars * 200);
                  }
                  if (isTruncatedMimoChunk(durMs, chunkChars)) {
                    const msg = `MiMo 第 ${i + 1} 块音频疑似截断（${durMs}ms / ${chunkChars} 字），第 ${attempt + 1} 次重试`;
                    writeAppLog('warn', 'tts', msg);
                    lastErr = new Error(msg);
                    continue;
                  }
                  ok = true;
                } catch (err) {
                  lastErr = err;
                  if ((err as { name?: string }).name === 'AbortError') throw err;
                }
              }
              if (!ok) throw lastErr instanceof Error ? lastErr : new Error('MiMo 分块合成失败');
              partPaths.push(partPath);
              parts.push({ durMs, units: chunks[i] });
              getMainWindow()?.webContents.send('tts-progress', 35 + Math.round((50 * (i + 1)) / chunks.length));
            }
            await concatWavFiles(partPaths, audioPath, { ffmpegPath });
            durationMs = parts.reduce((sum, p) => sum + p.durMs, 0);
            getMainWindow()?.webContents.send('tts-progress', 88);
            const aligned = await buildAlignedSrtFromChunks({
              audioPath,
              parts,
              signal: controller.signal,
              log: (level, message) => writeAppLog(level, 'tts', message),
            });
            srtText = aligned.srtText;
            writeAppLog('info', 'tts', `MiMo 分块合成完成，块数=${chunks.length}，时长=${durationMs}ms，ASR对齐=${aligned.aligned}，路径=${audioPath}`);
          } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
          }
        } else {
          const result = await runTTSProvider({ text, provider, voice, signal: controller.signal });
          writeAppLog('info', 'tts', 'TTS 同步响应接收完成', `provider=${provider.type}`);
          getMainWindow()?.webContents.send('tts-progress', 35);
          const audioBuf = result.audioBuffer;
          if (audioBuf.byteLength === 0) {
            throw new Error('TTS 未返回任何音频数据，请检查 API Key 及配置');
          }
          audioPath = path.join(projectDir, `podcast-audio.${result.audioExtension}`);
          await fs.writeFile(audioPath, audioBuf);
          writeAppLog('info', 'tts', `音频已保存，大小=${audioBuf.byteLength} 字节，路径=${audioPath}`);
          durationMs = result.durationMs ?? 0;
          if (durationMs <= 0) {
            try {
              durationMs = await readAudioDurationMs(audioPath, { ffprobePath: resolveRuntimeBinaries().ffprobePath });
            } catch (error) {
              writeAppLog('warn', 'tts', '读取音频时长失败，将使用 1 秒兜底', error instanceof Error ? error.message : String(error));
              durationMs = 1_000;
            }
          }
          srtText = result.subtitleText?.trim()
            ? result.subtitleText
            : text.trim()
              ? buildEstimatedSrtTextFromText(text, durationMs)
              : '';
        }

        if (!isMimoChunked) getMainWindow()?.webContents.send('tts-progress', 70);
        const srtPath = path.join(projectDir, 'podcast-subtitles.srt');
        const originalSrtPath = path.join(projectDir, 'podcast-subtitles.original.srt');
        await fs.writeFile(srtPath, srtText, 'utf-8');
        await fs.writeFile(originalSrtPath, srtText, 'utf-8');
        getMainWindow()?.webContents.send('tts-progress', 100);
        ttsTelemetry.emit('stage.end', {
          stage: 'tts',
          durationMs: Date.now() - ttsStartTs,
          ok: true,
          audioDurationMs: durationMs,
        });

        return { audioPath, srtPath, durationMs };
      } catch (error) {
        ttsTelemetry.emit('stage.end', {
          stage: 'tts',
          durationMs: Date.now() - ttsStartTs,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        if ((error as { name?: string }).name === 'AbortError') {
          throw new Error('TTS 任务已取消');
        }
        const cause = (error as { cause?: unknown })?.cause;
        const causeMsg =
          cause instanceof Error
            ? `${cause.name}: ${cause.message}${(cause as { code?: string }).code ? ` (${(cause as { code?: string }).code})` : ''}`
            : cause
              ? String(cause)
              : '';
        writeAppLog(
          'error',
          'tts',
          'TTS fetch 失败',
          `${(error as Error)?.message ?? String(error)} | cause=${causeMsg || '<none>'}`,
        );
        if (causeMsg) {
          throw new Error(`TTS 网络失败: ${causeMsg}`);
        }
        throw error;
      } finally {
        clearInterval(heartbeat);
        activeTtsRequests.delete(requestId);
      }
    },
  );

  ipcMain.handle('cancel-tts', async (_event, requestId: string) => {
    activeTtsRequests.get(requestId)?.abort();
    activeTtsRequests.delete(requestId);
  });
}
