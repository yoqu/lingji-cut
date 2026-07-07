import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDefaultTimeline } from '../src/types';
import { Timeline } from '../src/components/Timeline';
import subtitleStyles from '../src/components/TimelineSubtitleBlocks.module.css';

function createTimelineState() {
  const timeline = createDefaultTimeline();
  timeline.podcast.audioPath = '/tmp/podcast.mp3';
  timeline.podcast.srtPath = '/tmp/subtitles.srt';
  timeline.podcast.durationMs = 12_000;
  return timeline;
}

function createEntries() {
  return [
    {
      index: 1,
      startMs: 0,
      endMs: 2_000,
      text: '第一句真实字幕内容',
    },
    {
      index: 2,
      startMs: 2_000,
      endMs: 6_000,
      text: '这是一段特别长特别长特别长的字幕内容，用来验证时间轴里超出宽度后会被隐藏',
    },
  ];
}

const timelineState: Record<string, unknown> = {
  timeline: createTimelineState(),
  srtEntries: createEntries(),
  subtitleSelection: [],
  setSubtitleSelection: () => undefined,
  clearSubtitleSelection: () => undefined,
  addOverlay: () => undefined,
  addTrack: () => 'visual-2',
  setSubtitleHighlights: () => undefined,
  clearSubtitleHighlights: () => undefined,
  updateSubtitleStyle: () => undefined,
  setGlobalBackground: () => undefined,
};

vi.mock('../src/store/timeline', () => ({
  useTimelineStore: (selector?: (state: Record<string, unknown>) => unknown) =>
    typeof selector === 'function' ? selector(timelineState) : timelineState,
  getProjectDir: () => '',
  getCurrentSaveStatus: () => 'idle',
  subscribeToSaveStatus: () => () => undefined,
}));

vi.mock('../src/store/ai', () => ({
  loadAISettings: () => ({
    llmBaseUrl: 'https://api.openai.com/v1',
    llmApiKey: 'sk-test',
    llmModel: 'gpt-4o-mini',
  }),
}));

describe('Timeline', () => {
  beforeEach(() => {
    timelineState.timeline = createTimelineState();
    timelineState.srtEntries = createEntries();
  });

  it('renders real subtitle text from srt entries on the subtitle lane', () => {
    const html = renderToStaticMarkup(
      <Timeline currentTimeMs={0} onSeek={() => undefined} compact={false} />,
    );

    expect(html).toContain('第一句真实字幕内容');
    expect(html).toContain('这是一段特别长特别长特别长的字幕内容');
    expect(html).toContain('data-subtitle-entry="subtitle-1"');
    expect(html).toContain('data-subtitle-entry="subtitle-2"');
  });

  it('uses subtitle clipping classes for long subtitle content', () => {
    const html = renderToStaticMarkup(
      <Timeline currentTimeMs={0} onSeek={() => undefined} compact={false} />,
    );

    expect(html).toContain(`class="${subtitleStyles.block}"`);
    expect(html).toContain(`class="${subtitleStyles.text}"`);
    expect(html).toContain('这是一段特别长特别长特别长的字幕内容');
  });

  it('shows the subtitle track and the missing-highlight hint', () => {
    const html = renderToStaticMarkup(
      <Timeline currentTimeMs={0} onSeek={() => undefined} compact={false} />,
    );

    expect(html).toContain('data-subtitle-entry="subtitle-1"');
    expect(html).toContain('未生成高亮');
  });

  it('shows the expired-highlight hint when stored highlights no longer match subtitle text', () => {
    timelineState.timeline.subtitleHighlights = [
      {
        entryIndex: 1,
        start: 4,
        end: 8,
        highlightText: '真实字幕',
        sourceText: '第一句旧版字幕内容',
      },
    ];

    const html = renderToStaticMarkup(
      <Timeline currentTimeMs={0} onSeek={() => undefined} compact={false} />,
    );

    expect(html).toContain('高亮已过期');
  });
});
