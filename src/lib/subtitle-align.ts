import type { SrtEntry } from '../types';
import { MIN_SEGMENT_DURATION_MS } from './srt-resegment';

/** ASR 逐字时间戳（Bcut words），text 通常是单个 CJK 字或一个英文词。 */
export interface AsrWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** ASR 断句结果；words 缺失时按 text 字符在句内线性插值。 */
export interface AsrSegment {
  text: string;
  startMs: number;
  endMs: number;
  words?: AsrWord[];
}

/** 一个 TTS 分块的估算字幕：entries 为绝对时间，[startMs, endMs] 由块音频真实时长确定。 */
export interface AlignChunk {
  startMs: number;
  endMs: number;
  entries: SrtEntry[];
}

export interface AlignResult {
  entries: SrtEntry[];
  alignedChunks: number;
  totalChunks: number;
}

interface TimedChar {
  ch: string;
  startMs: number;
  endMs: number;
}

/** 块边界来自音频拼接，本身精确；只留小余量容忍 ASR 端点误差。 */
const CHUNK_SLICE_MARGIN_MS = 800;
/** 相邻字幕间隙小于该值时并入前一条，避免闪断。 */
const GAP_MERGE_MS = 320;
/** 精确匹配字符占比低于该值时放弃该块的对齐结果。 */
const MIN_EXACT_COVERAGE = 0.5;
/** DP 矩阵规模上限，防止异常长块撑爆内存。 */
const MAX_DP_CELLS = 30_000_000;

/** 归一化为可对齐字符：全角转半角、小写化，仅保留汉字/字母/数字。 */
export function normalizeAlignChar(raw: string): string | null {
  const code = raw.codePointAt(0);
  if (code === undefined) return null;
  const ch = (code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : raw).toLowerCase();
  return /[\p{Script=Han}\p{L}\p{N}]/u.test(ch) ? ch : null;
}

function expandChars(text: string, startMs: number, endMs: number, out: TimedChar[]): void {
  const chars: string[] = [];
  for (const raw of text) {
    const ch = normalizeAlignChar(raw);
    if (ch) chars.push(ch);
  }
  if (chars.length === 0) return;
  const span = Math.max(0, endMs - startMs);
  for (let i = 0; i < chars.length; i++) {
    out.push({
      ch: chars[i],
      startMs: startMs + (span * i) / chars.length,
      endMs: startMs + (span * (i + 1)) / chars.length,
    });
  }
}

/** 把 ASR 结果摊平成带时间的字符流：优先 words 逐字时间，缺失时句内线性插值。 */
export function buildAsrTimedChars(segments: AsrSegment[]): TimedChar[] {
  const out: TimedChar[] = [];
  for (const seg of segments) {
    if (seg.words && seg.words.length > 0) {
      for (const word of seg.words) expandChars(word.text, word.startMs, word.endMs, out);
    } else {
      expandChars(seg.text, seg.startMs, seg.endMs, out);
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/**
 * 字符级编辑距离对齐（Needleman–Wunsch），返回每个脚本字符命中的 ASR 时间。
 * 替换（ASR 识别错字）也赋时间——位置上仍对应同一发音；exact 只统计完全匹配用于覆盖率。
 */
function alignScriptToAsr(
  script: string[],
  asr: TimedChar[],
): { times: Array<{ s: number; e: number } | null>; exact: number } | null {
  const m = script.length;
  const n = asr.length;
  if (m === 0 || n === 0) return null;
  if ((m + 1) * (n + 1) > MAX_DP_CELLS) return null;

  const width = n + 1;
  const trace = new Uint8Array((m + 1) * width);
  let prev = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) {
    prev[j] = j;
    trace[j] = 3;
  }
  trace[0] = 0;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    trace[i * width] = 2;
    for (let j = 1; j <= n; j++) {
      const match = script[i - 1] === asr[j - 1].ch;
      let best = prev[j - 1] + (match ? 0 : 1);
      let step = match ? 0 : 1;
      if (prev[j] + 1 < best) {
        best = prev[j] + 1;
        step = 2;
      }
      if (curr[j - 1] + 1 < best) {
        best = curr[j - 1] + 1;
        step = 3;
      }
      curr[j] = best;
      trace[i * width + j] = step;
    }
    [prev, curr] = [curr, prev];
  }

  const times: Array<{ s: number; e: number } | null> = new Array(m).fill(null);
  let exact = 0;
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const step = trace[i * width + j];
    if (i > 0 && j > 0 && step <= 1) {
      times[i - 1] = { s: asr[j - 1].startMs, e: asr[j - 1].endMs };
      if (step === 0) exact++;
      i--;
      j--;
    } else if (i > 0 && (step === 2 || j === 0)) {
      i--;
    } else {
      j--;
    }
  }
  return { times, exact };
}

/** 未命中的字符按索引在相邻锚点间线性插值，两端向块边界收敛。 */
function interpolateTimes(
  times: Array<{ s: number; e: number } | null>,
  chunkStartMs: number,
  chunkEndMs: number,
): Array<{ s: number; e: number }> {
  const anchors: number[] = [];
  for (let i = 0; i < times.length; i++) if (times[i]) anchors.push(i);
  const result: Array<{ s: number; e: number }> = new Array(times.length);
  let anchorPos = 0;
  for (let i = 0; i < times.length; i++) {
    const known = times[i];
    if (known) {
      result[i] = known;
      continue;
    }
    while (anchorPos < anchors.length && anchors[anchorPos] < i) anchorPos++;
    const prevIdx = anchorPos > 0 ? anchors[anchorPos - 1] : -1;
    const nextIdx = anchorPos < anchors.length ? anchors[anchorPos] : -1;
    const lo = prevIdx >= 0 ? times[prevIdx]!.e : chunkStartMs;
    const hi = nextIdx >= 0 ? times[nextIdx]!.s : chunkEndMs;
    const gapCount = (nextIdx >= 0 ? nextIdx : times.length) - (prevIdx >= 0 ? prevIdx + 1 : 0);
    const offset = i - (prevIdx >= 0 ? prevIdx + 1 : 0);
    const span = Math.max(0, hi - lo);
    result[i] = {
      s: lo + (span * offset) / Math.max(1, gapCount),
      e: lo + (span * (offset + 1)) / Math.max(1, gapCount),
    };
  }
  return result;
}

/** 单块对齐：失败或覆盖率不足时原样返回估算 entries。 */
function refineChunkEntries(chunk: AlignChunk, asrChars: TimedChar[]): { entries: SrtEntry[]; aligned: boolean } {
  const scriptChars: string[] = [];
  const entryOf: number[] = [];
  chunk.entries.forEach((entry, idx) => {
    for (const raw of entry.text) {
      const ch = normalizeAlignChar(raw);
      if (ch) {
        scriptChars.push(ch);
        entryOf.push(idx);
      }
    }
  });

  const alignment = alignScriptToAsr(scriptChars, asrChars);
  if (!alignment || alignment.exact / scriptChars.length < MIN_EXACT_COVERAGE) {
    return { entries: chunk.entries, aligned: false };
  }

  const times = interpolateTimes(alignment.times, chunk.startMs, chunk.endMs);
  const refined = chunk.entries.map((entry) => ({ ...entry }));
  for (let idx = 0; idx < refined.length; idx++) {
    let first = -1;
    let last = -1;
    for (let c = 0; c < entryOf.length; c++) {
      if (entryOf[c] !== idx) continue;
      if (first < 0) first = c;
      last = c;
    }
    if (first < 0) continue; // 纯标点条目：保留估算时间，由单调化兜底
    refined[idx].startMs = Math.round(times[first].s);
    refined[idx].endMs = Math.round(times[last].e);
  }

  // 单调化 + 最小时长 + 小间隙合并，全部收在块窗口内
  let prevEnd = chunk.startMs;
  for (let idx = 0; idx < refined.length; idx++) {
    const entry = refined[idx];
    let start = Math.min(Math.max(entry.startMs, prevEnd), chunk.endMs);
    let end = Math.max(entry.endMs, start + MIN_SEGMENT_DURATION_MS);
    end = Math.min(end, chunk.endMs);
    if (end <= start) end = Math.min(start + MIN_SEGMENT_DURATION_MS, chunk.endMs);
    entry.startMs = start;
    entry.endMs = end;
    if (idx > 0 && start - refined[idx - 1].endMs > 0 && start - refined[idx - 1].endMs < GAP_MERGE_MS) {
      refined[idx - 1].endMs = start;
    }
    prevEnd = end;
  }
  return { entries: refined, aligned: true };
}

/**
 * 用 ASR 字符时间线校准各块估算字幕。文本永远以口播稿为准（ASR 只供时间），
 * 逐块独立对齐，任何一块失败只回退该块。
 */
export function alignChunksWithAsr(chunks: AlignChunk[], asr: AsrSegment[]): AlignResult {
  const timeline = buildAsrTimedChars(asr);
  const entries: SrtEntry[] = [];
  let alignedChunks = 0;
  for (const chunk of chunks) {
    const slice = timeline.filter((c) => {
      const mid = (c.startMs + c.endMs) / 2;
      return mid >= chunk.startMs - CHUNK_SLICE_MARGIN_MS && mid < chunk.endMs + CHUNK_SLICE_MARGIN_MS;
    });
    const refined = refineChunkEntries(chunk, slice);
    if (refined.aligned) alignedChunks++;
    entries.push(...refined.entries);
  }
  return {
    entries: entries.map((entry, idx) => ({ ...entry, index: idx + 1 })),
    alignedChunks,
    totalChunks: chunks.length,
  };
}
