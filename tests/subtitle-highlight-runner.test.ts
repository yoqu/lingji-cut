import { describe, expect, it, vi } from 'vitest';
import type { SrtEntry } from '../src/types';
import type { AISettings } from '../src/types/ai';
import { generateSubtitleHighlights } from '../src/lib/subtitle-highlight-runner';
import { generateStructuredData } from '../src/lib/llm';

function createEntry(index: number, text: string): SrtEntry {
  return {
    index,
    startMs: (index - 1) * 2_000,
    endMs: index * 2_000,
    text,
  };
}

const settings: AISettings = {
  llmBaseUrl: 'https://api.openai.com/v1',
  llmApiKey: 'sk-test',
  llmModel: 'gpt-4o-mini',
};

describe('generateSubtitleHighlights', () => {
  it('requests highlights in batches and merges valid results', async () => {
    const entries = [
      createEntry(1, '中国品牌完成第一次突破'),
      createEntry(2, '真正值得记住的是世界冠军'),
      createEntry(3, '最后一句没有重点'),
    ];
    const modelCaller = vi.fn<typeof generateStructuredData>()
      .mockImplementation(async (_settings, _systemPrompt, userMessage) => {
        if (userMessage.includes('entryIndex=1')) {
          return {
            highlights: [
              {
                entryIndex: 1,
                shouldHighlight: true,
                highlightText: '第一次',
                start: 6,
                end: 9,
              },
              {
                entryIndex: 2,
                shouldHighlight: true,
                highlightText: '世界冠军',
                start: 8,
                end: 12,
              },
            ],
          };
        }

        return {
          highlights: [
            {
              entryIndex: 3,
              shouldHighlight: false,
              highlightText: '',
              start: -1,
              end: -1,
            },
          ],
        };
      });

    const result = await generateSubtitleHighlights(entries, settings, {
      batchSize: 2,
      generateStructuredData: modelCaller,
    });

    expect(modelCaller).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      {
        entryIndex: 1,
        highlightText: '第一次',
        start: 6,
        end: 9,
        sourceText: '中国品牌完成第一次突破',
      },
      {
        entryIndex: 2,
        highlightText: '世界冠军',
        start: 8,
        end: 12,
        sourceText: '真正值得记住的是世界冠军',
      },
    ]);
  });

  it('filters invalid model results before returning', async () => {
    const entries = [createEntry(1, '真正值得记住的是世界冠军')];
    const modelCaller = vi.fn().mockResolvedValue({
      highlights: [
        {
          entryIndex: 1,
          shouldHighlight: true,
          highlightText: '世界冠军',
          start: 0,
          end: 4,
        },
      ],
    });

    const result = await generateSubtitleHighlights(entries, settings, {
      generateStructuredData: modelCaller,
    });

    expect(result).toEqual([]);
  });

  it('wraps model failures with a user-friendly message', async () => {
    await expect(
      generateSubtitleHighlights([createEntry(1, '测试字幕')], settings, {
        generateStructuredData: vi.fn().mockRejectedValue(new Error('network down')),
      }),
    ).rejects.toThrow('字幕关键词高亮生成失败');
  });
});
