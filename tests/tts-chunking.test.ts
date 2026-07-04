import { describe, expect, it } from 'vitest';
import {
  MIMO_TTS_CHUNK_CHAR_BUDGET,
  groupSentencesByBudget,
  buildChunkAlignInputs,
  buildSrtFromChunks,
  isTruncatedMimoChunk,
} from '../electron/tts-chunking';
import { parseSrt } from '../src/lib/srt-parser';
import type { TtsUnit } from '../src/lib/tts/types';

const u = (s: string): TtsUnit => ({ subtitle: s, speak: s });

describe('groupSentencesByBudget', () => {
  it('连续句打包且不超预算', () => {
    const chunks = groupSentencesByBudget([u('一二三'), u('四五六'), u('七八九')], 6);
    expect(chunks.map((c) => c.map((x) => x.subtitle).join(''))).toEqual(['一二三四五六', '七八九']);
  });

  it('绝不切断单句：单句超预算自成一块', () => {
    const chunks = groupSentencesByBudget([u('一二三四五六七八'), u('九十')], 5);
    expect(chunks).toHaveLength(2);
    expect(chunks[0][0].subtitle).toBe('一二三四五六七八');
  });

  it('空输入返回空数组', () => {
    expect(groupSentencesByBudget([], 100)).toEqual([]);
  });

  it('导出默认预算常量', () => {
    expect(MIMO_TTS_CHUNK_CHAR_BUDGET).toBeGreaterThan(0);
  });
});

describe('buildSrtFromChunks', () => {
  it('块间偏移累加、末块 endMs 等于总时长、可被 parseSrt 解析', () => {
    const parts = [
      { durMs: 2000, units: [u('这是一个非常长的句子，需要被分割成多条字幕才能合理展示在屏幕上。'), u('这也是一个很长的句子，将继续占用字符预算。')] },
      { durMs: 1000, units: [u('最后还有一个冗长的句子，会被继续分割到合适的长度。')] },
    ];
    const srt = buildSrtFromChunks(parts);
    const entries = parseSrt(srt);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries[0].startMs).toBe(0);
    expect(entries[entries.length - 1].endMs).toBe(3000);
    expect(entries.every((e) => !e.text.includes('\n'))).toBe(true);
  });

  it('字幕文本取 subtitle（干净），不含 speak 的标签', () => {
    const parts = [{ durMs: 1000, units: [{ subtitle: '重点来了。', speak: '(强调)重点来了。' }] }];
    const srt = buildSrtFromChunks(parts);
    expect(srt).toContain('重点来了。');
    expect(srt).not.toContain('(强调)');
  });
});

describe('isTruncatedMimoChunk', () => {
  it('远低于正常语速的块判为截断（实测两次截断 ≈72 / 97ms/字）', () => {
    expect(isTruncatedMimoChunk(58_000, 800)).toBe(true); // 72ms/字
    expect(isTruncatedMimoChunk(53_000, 550)).toBe(true); // 97ms/字
    expect(isTruncatedMimoChunk(160_000, 800)).toBe(false); // 200ms/字 正常
    expect(isTruncatedMimoChunk(120_000, 800)).toBe(false); // 150ms/字 快语速不误杀
  });

  it('过短文本不判定，避免误杀', () => {
    expect(isTruncatedMimoChunk(100, 5)).toBe(false);
  });
});

describe('buildChunkAlignInputs', () => {
  it('每块给出精确窗口，entries 落在窗口内且偏移累加', () => {
    const parts = [
      { durMs: 2000, units: [u('第一块的句子。')] },
      { durMs: 1500, units: [u('第二块的句子。')] },
    ];
    const chunks = buildChunkAlignInputs(parts);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ startMs: 0, endMs: 2000 });
    expect(chunks[1]).toMatchObject({ startMs: 2000, endMs: 3500 });
    expect(chunks[1].entries[0].startMs).toBe(2000);
    expect(chunks[1].entries.at(-1)!.endMs).toBe(3500);
  });
});
