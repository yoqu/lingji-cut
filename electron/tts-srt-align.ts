import { buildChunkAlignInputs, buildSrtFromChunks, type ChunkPart } from './tts-chunking';
import { alignChunksWithAsr } from '../src/lib/subtitle-align';
import { serializeSrtEntries } from '../src/lib/srt-parser';
import { transcribeWithBcut } from './video-import/bcut-asr';
import type { TranscriptResult } from './video-import/types';

export type TtsTranscribe = (audioPath: string) => Promise<TranscriptResult>;

export interface AlignedSrtArgs {
  audioPath: string;
  parts: ChunkPart[];
  signal?: AbortSignal;
  log?: (level: 'info' | 'warn', message: string) => void;
  /** 测试注入；默认走 Bcut ASR。 */
  transcribe?: TtsTranscribe;
}

/** ASR 轮询上限：上传+识别一般 <2 分钟，4 分钟仍未完成则放弃走估算。 */
const BCUT_POLL_LIMIT = 240;

/**
 * MiMo 等无平台时间戳的 TTS：用 Bcut ASR 解析成品音频，把逐字时间对齐回口播稿字幕。
 * 任何失败（网络/超时/覆盖率不足/取消除外）都回退到字符估算，绝不阻断 TTS 主流程。
 */
export async function buildAlignedSrtFromChunks(
  args: AlignedSrtArgs,
): Promise<{ srtText: string; aligned: boolean }> {
  const { audioPath, parts, signal, log } = args;
  try {
    const transcribe =
      args.transcribe ??
      ((path: string) =>
        transcribeWithBcut(path, {
          fetchImpl: (input, init) => fetch(input, { ...init, signal }),
          pollLimit: BCUT_POLL_LIMIT,
        }));
    const transcript = await transcribe(audioPath);
    const { entries, alignedChunks, totalChunks } = alignChunksWithAsr(
      buildChunkAlignInputs(parts),
      transcript.segments,
    );
    if (alignedChunks === 0) {
      log?.('warn', 'ASR 对齐覆盖率不足，字幕回退字符估算');
      return { srtText: buildSrtFromChunks(parts), aligned: false };
    }
    log?.('info', `ASR 字幕对齐完成：${alignedChunks}/${totalChunks} 块校准`);
    return { srtText: serializeSrtEntries(entries), aligned: true };
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError') throw error;
    log?.(
      'warn',
      `ASR 字幕对齐失败，回退字符估算：${error instanceof Error ? error.message : String(error)}`,
    );
    return { srtText: buildSrtFromChunks(parts), aligned: false };
  }
}
