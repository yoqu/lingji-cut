import { describe, expect, it } from 'vitest';
import {
  alignChunksWithAsr,
  buildAsrTimedChars,
  normalizeAlignChar,
  type AlignChunk,
  type AsrSegment,
  type AsrWord,
} from '../src/lib/subtitle-align';

/** 每字一个 word，按固定字长 stepMs 从 startMs 排开。 */
function charWords(text: string, startMs: number, stepMs: number): AsrWord[] {
  return Array.from(text).map((ch, i) => ({
    text: ch,
    startMs: startMs + i * stepMs,
    endMs: startMs + (i + 1) * stepMs,
  }));
}

function seg(text: string, startMs: number, endMs: number, words?: AsrWord[]): AsrSegment {
  return { text, startMs, endMs, words };
}

const CHUNK: AlignChunk = {
  startMs: 0,
  endMs: 10_000,
  entries: [
    { index: 1, startMs: 0, endMs: 6_000, text: '今天我们聊聊人工智能。' },
    { index: 2, startMs: 6_000, endMs: 10_000, text: '接下来进入正题。' },
  ],
};

describe('normalizeAlignChar', () => {
  it('保留汉字/字母/数字，丢弃标点，全角转半角并小写', () => {
    expect(normalizeAlignChar('智')).toBe('智');
    expect(normalizeAlignChar('。')).toBeNull();
    expect(normalizeAlignChar('，')).toBeNull();
    expect(normalizeAlignChar('A')).toBe('a');
    expect(normalizeAlignChar('Ａ')).toBe('a');
    expect(normalizeAlignChar('３')).toBe('3');
    expect(normalizeAlignChar(' ')).toBeNull();
  });
});

describe('buildAsrTimedChars', () => {
  it('优先 words 逐字时间，缺失时句内线性插值', () => {
    const withWords = buildAsrTimedChars([seg('你好', 0, 600, charWords('你好', 0, 300))]);
    expect(withWords).toHaveLength(2);
    expect(withWords[1].startMs).toBe(300);

    const interpolated = buildAsrTimedChars([seg('你好吗', 0, 900)]);
    expect(interpolated).toHaveLength(3);
    expect(interpolated[1].startMs).toBe(300);
    expect(interpolated[2].endMs).toBe(900);
  });
});

describe('alignChunksWithAsr', () => {
  it('句间停顿被还原：字幕不再按字符数均摊时间', () => {
    // 实际语音：前句 0–3s，停顿 4s，后句 7–9.1s；估算把后句提前到了 6s
    const asr = [
      seg('今天我们聊聊人工智能', 0, 3_000, charWords('今天我们聊聊人工智能', 0, 300)),
      seg('接下来进入正题', 7_000, 9_100, charWords('接下来进入正题', 7_000, 300)),
    ];
    const { entries, alignedChunks } = alignChunksWithAsr([CHUNK], asr);
    expect(alignedChunks).toBe(1);
    expect(entries[0].endMs).toBe(3_000);
    expect(entries[1].startMs).toBe(7_000);
    expect(entries[1].endMs).toBe(9_100);
  });

  it('ASR 识别错字不影响对齐，字幕文本始终保持口播稿原文', () => {
    const wrong = '今天我们聊聊人工知能'; // 智→知
    const asr = [
      seg(wrong, 0, 3_000, charWords(wrong, 0, 300)),
      seg('接下来进入正提', 7_000, 9_100, charWords('接下来进入正提', 7_000, 300)), // 题→提
    ];
    const { entries, alignedChunks } = alignChunksWithAsr([CHUNK], asr);
    expect(alignedChunks).toBe(1);
    expect(entries[0].text).toBe('今天我们聊聊人工智能。');
    expect(entries[1].text).toBe('接下来进入正题。');
    expect(entries[1].startMs).toBe(7_000);
  });

  it('无 words 时按句级时间插值，仍能校准句起点', () => {
    const asr = [
      seg('今天我们聊聊人工智能', 0, 3_000),
      seg('接下来进入正题', 7_000, 9_100),
    ];
    const { entries, alignedChunks } = alignChunksWithAsr([CHUNK], asr);
    expect(alignedChunks).toBe(1);
    expect(entries[1].startMs).toBe(7_000);
  });

  it('ASR 为空或完全不匹配时回退估算时间', () => {
    const empty = alignChunksWithAsr([CHUNK], []);
    expect(empty.alignedChunks).toBe(0);
    expect(empty.entries.map((e) => [e.startMs, e.endMs])).toEqual([
      [0, 6_000],
      [6_000, 10_000],
    ]);

    const garbage = alignChunksWithAsr([CHUNK], [
      seg('完全无关的另一段内容根本对不上', 0, 9_000, charWords('完全无关的另一段内容根本对不上', 0, 300)),
    ]);
    expect(garbage.alignedChunks).toBe(0);
  });

  it('相邻字幕小间隙并入前一条，输出重新编号且单调', () => {
    const asr = [
      seg('今天我们聊聊人工智能', 0, 6_800, charWords('今天我们聊聊人工智能', 0, 680)),
      seg('接下来进入正题', 7_000, 9_100, charWords('接下来进入正题', 7_000, 300)),
    ];
    const { entries } = alignChunksWithAsr([CHUNK], asr);
    expect(entries[0].endMs).toBe(7_000); // 200ms 间隙被并入
    expect(entries.map((e) => e.index)).toEqual([1, 2]);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].startMs).toBeGreaterThanOrEqual(entries[i - 1].endMs);
    }
  });

  it('多块各自独立对齐：一块失败只回退该块', () => {
    const chunk2: AlignChunk = {
      startMs: 10_000,
      endMs: 16_000,
      entries: [{ index: 1, startMs: 10_000, endMs: 16_000, text: '第二块的完整句子内容。' }],
    };
    const asr = [
      seg('今天我们聊聊人工智能', 0, 3_000, charWords('今天我们聊聊人工智能', 0, 300)),
      seg('接下来进入正题', 7_000, 9_100, charWords('接下来进入正题', 7_000, 300)),
      // 第二块窗口内没有任何 ASR 内容 → 回退估算
    ];
    const { entries, alignedChunks, totalChunks } = alignChunksWithAsr([CHUNK, chunk2], asr);
    expect(totalChunks).toBe(2);
    expect(alignedChunks).toBe(1);
    const second = entries[entries.length - 1];
    expect(second.startMs).toBe(10_000);
    expect(second.endMs).toBe(16_000);
  });
});
