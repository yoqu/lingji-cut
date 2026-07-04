import type { TtsUnit } from '../src/lib/tts/types';
import { resegmentSrtEntries, DEFAULT_MAX_CHARS_PER_ENTRY } from '../src/lib/srt-resegment';
import { serializeSrtEntries } from '../src/lib/srt-parser';
import type { AlignChunk } from '../src/lib/subtitle-align';

/** MiMo 单次请求字数预算；3000–8000 字稿约 4–10 块。限制未文档化，保守可调。 */
export const MIMO_TTS_CHUNK_CHAR_BUDGET = 800;

/** 中文口播约 180–260ms/字；低于该值说明 MiMo 只合成了块的一部分（实测两次截断 ≈72 / 97ms/字）。 */
export const MIMO_MIN_MS_PER_CHAR = 140;

/** MiMo 偶发返回截断音频（非空但缺内容），必须按失败重试，否则字幕/卡片整轴挤歪。 */
export function isTruncatedMimoChunk(durMs: number, subtitleChars: number): boolean {
  return subtitleChars >= 10 && durMs < subtitleChars * MIMO_MIN_MS_PER_CHAR;
}

export interface ChunkPart {
  durMs: number;
  units: TtsUnit[];
}

/** 连续句按 speak 字数打包，绝不切断单句；单句超预算自成一块。 */
export function groupSentencesByBudget(units: TtsUnit[], budget: number): TtsUnit[][] {
  const chunks: TtsUnit[][] = [];
  let current: TtsUnit[] = [];
  let currentLen = 0;
  for (const unit of units) {
    const len = unit.speak.length;
    if (current.length > 0 && currentLen + len > budget) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(unit);
    currentLen += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * 每块按字幕文本拼成一条 entry [offset, offset+durMs]，再用 resegmentSrtEntries 切到合适长度；
 * offset 在块间累加，时间为字符数等比估算。字幕文本取 units.subtitle（干净）。
 */
export function buildChunkAlignInputs(parts: ChunkPart[]): AlignChunk[] {
  const chunks: AlignChunk[] = [];
  let offset = 0;
  for (const part of parts) {
    const durMs = Math.max(0, Math.round(part.durMs));
    const text = part.units.map((u) => u.subtitle).join('');
    if (text) {
      const local = resegmentSrtEntries(
        [{ index: 1, startMs: 0, endMs: Math.max(1, durMs), text }],
        DEFAULT_MAX_CHARS_PER_ENTRY,
      );
      chunks.push({
        startMs: offset,
        endMs: offset + Math.max(1, durMs),
        entries: local.map((e) => ({ ...e, startMs: e.startMs + offset, endMs: e.endMs + offset })),
      });
    }
    offset += durMs;
  }
  return chunks;
}

/** 用每块的真实时长构建多条估算字幕（无 ASR 校准时的兜底输出）。 */
export function buildSrtFromChunks(parts: ChunkPart[]): string {
  const entries = buildChunkAlignInputs(parts).flatMap((c) => c.entries);
  return serializeSrtEntries(entries.map((e, i) => ({ ...e, index: i + 1 })));
}
