import { describe, expect, it } from 'vitest';
import { buildAlignedSrtFromChunks } from '../electron/tts-srt-align';
import { buildSrtFromChunks } from '../electron/tts-chunking';
import { parseSrt } from '../src/lib/srt-parser';
import type { TranscriptResult } from '../electron/video-import/types';

const SENTENCE_1 = '今天我们要认真聊一聊人工智能行业里最新发生的重要变化。';
const SENTENCE_2 = '接下来我们马上进入今天的正题内容。';

const PARTS = [
  {
    durMs: 10_000,
    units: [
      { subtitle: SENTENCE_1, speak: SENTENCE_1 },
      { subtitle: SENTENCE_2, speak: SENTENCE_2 },
    ],
  },
];

function transcriptOf(segments: TranscriptResult['segments']): TranscriptResult {
  return { engine: 'bcut', fullText: '', srtText: '', segments };
}

describe('buildAlignedSrtFromChunks', () => {
  it('ASR 成功时输出对齐后的时间（句间停顿不再被均摊）', async () => {
    const { srtText, aligned } = await buildAlignedSrtFromChunks({
      audioPath: '/fake/audio.wav',
      parts: PARTS,
      transcribe: async () =>
        transcriptOf([
          { text: SENTENCE_1.replace('。', ''), startMs: 0, endMs: 3_000 },
          { text: SENTENCE_2.replace('。', ''), startMs: 7_000, endMs: 9_100 },
        ]),
    });
    expect(aligned).toBe(true);
    const entries = parseSrt(srtText);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0].text).toBe(SENTENCE_1);
    expect(entries[1].startMs).toBe(7_000);
  });

  it('ASR 失败时回退字符估算且不抛错', async () => {
    const logs: string[] = [];
    const { srtText, aligned } = await buildAlignedSrtFromChunks({
      audioPath: '/fake/audio.wav',
      parts: PARTS,
      transcribe: async () => {
        throw new Error('network down');
      },
      log: (_level, message) => logs.push(message),
    });
    expect(aligned).toBe(false);
    expect(srtText).toBe(buildSrtFromChunks(PARTS));
    expect(logs.join('\n')).toContain('回退');
  });

  it('取消信号导致的 AbortError 原样上抛', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(
      buildAlignedSrtFromChunks({
        audioPath: '/fake/audio.wav',
        parts: PARTS,
        transcribe: async () => {
          throw abortError;
        },
      }),
    ).rejects.toBe(abortError);
  });
});
