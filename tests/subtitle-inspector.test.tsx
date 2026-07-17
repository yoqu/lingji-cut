import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SubtitleInspector } from '../src/components/SubtitleInspector';

vi.mock('../src/store/timeline', () => ({
  useTimelineStore: () => ({
    srtEntries: [{ index: 1, startMs: 0, endMs: 2_000, text: 'hello world' }],
    originalSrtEntries: [{ index: 1, startMs: 0, endMs: 2_000, text: 'hello world' }],
    setSubtitleHighlights: () => undefined,
    updateSubtitleStyle: () => undefined,
    setSubtitleMaxChars: () => undefined,
    setAutoResegment: () => undefined,
    resegmentSubtitles: () => ({ droppedHighlights: 0 }),
    restoreOriginalSubtitles: () => undefined,
    timeline: {
      podcast: { srtPath: '/tmp/test.srt' },
      subtitleHighlights: [
        {
          entryIndex: 1,
          start: 6,
          end: 11,
          highlightText: 'world',
          sourceText: 'hello world',
        },
      ],
      subtitle: {
        fontSize: 48,
        color: '#FFFFFF',
        position: 'bottom',
        highlightEnabled: true,
        highlightBackgroundColor: '#F8DC48',
        highlightTextColor: '#111827',
        highlightPaddingX: 10,
        highlightPaddingY: 4,
        highlightRadius: 12,
        highlightAnimation: 'pop',
        maxCharsPerEntry: 35,
        autoResegment: true,
      },
    },
  }),
}));

describe('SubtitleInspector', () => {
  it('renders the design-aligned subtitle highlight detail panel', () => {
    const html = renderToStaticMarkup(<SubtitleInspector />);

    expect(html).toContain('关键词高亮');
    expect(html).toContain('颜色与圆角');
    expect(html).toContain('动画与预览');
    expect(html).toContain('重新生成关键词高亮');
    expect(html).toContain('高亮已生成');
    expect(html).toContain('启用高亮');
    expect(html).toContain('动画效果');
    expect(html).toContain('#F8DC48');
    expect(html).toContain('#111827');
    expect(html).toContain('关键词高亮');
    expect(html).toContain('test.srt');
    expect(html).not.toContain('这一句真正的重点是');
    expect(html).not.toContain('启用关键词高亮');
  });

  it('renders subtitle layout section with default max chars 35', () => {
    const html = renderToStaticMarkup(<SubtitleInspector />);
    expect(html).toContain('字幕排版');
    expect(html).toContain('单条最多字数');
    expect(html).toContain('超过自动切分');
    expect(html).toContain('立即重新切分');
    expect(html).toContain('还原原始字幕');
    expect(html).toMatch(/value="?35"?/);
  });

  it('shows "未切分" status when srtEntries equals originalSrtEntries', () => {
    const html = renderToStaticMarkup(<SubtitleInspector />);
    expect(html).toContain('未切分');
  });
});
