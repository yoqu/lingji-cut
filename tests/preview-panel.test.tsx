import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDefaultTimeline } from '../src/types';
import { useTimelineStore } from '../src/store/timeline';
import { PreviewPanel } from '../src/components/PreviewPanel';

vi.mock('../src/components/RemotionPreviewPlayer', async () => {
  const React = await import('react');

  return {
    RemotionPreviewPlayer: React.forwardRef(
      (
        {
          timeline,
          podcastRevision,
        }: {
          timeline: { width: number; height: number };
          podcastRevision: number;
        },
        ref,
      ) => {
        React.useImperativeHandle(ref, () => ({
          play: () => undefined,
          pause: () => undefined,
          seekToMs: () => undefined,
          isPlaying: () => false,
          setVolume: () => undefined,
          mute: () => undefined,
          unmute: () => undefined,
        }));
        return React.createElement(
          'div',
          {
            'data-player': 'remotion',
            'data-size': `${timeline.width}x${timeline.height}`,
            'data-podcast-revision': podcastRevision,
          },
          'Mock Remotion Player',
        );
      },
    ),
  };
});

vi.mock('../src/store/ai', () => ({
  useAIStore: (selector: (state: { currentProjectDir: string | null }) => unknown) =>
    selector({ currentProjectDir: null }),
}));

vi.mock('../src/ui', async () => {
  const React = await import('react');

  return {
    Button: ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement('button', props, children),
    Card: React.forwardRef(
      ({ children, ...props }: { children?: React.ReactNode }, ref) =>
        React.createElement('div', { ...props, ref }, children),
    ),
    Tooltip: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    TooltipContent: ({ children }: { children?: React.ReactNode }) =>
      React.createElement('div', null, children),
    TooltipTrigger: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock('../src/components/AppIcon', async () => {
  const React = await import('react');
  return {
    AppIcon: ({ name }: { name: string }) =>
      React.createElement(
        'span',
        { 'data-icon': name },
        name,
      ),
  };
});

describe('PreviewPanel', () => {
  beforeEach(() => {
    const timeline = createDefaultTimeline();
    timeline.podcast.durationMs = 90_000;

    useTimelineStore.setState({
      timeline,
      srtEntries: [],
      assets: [],
    });
  });

  it('renders playback and export controls beneath the preview player', () => {
    const html = renderToStaticMarkup(
      <PreviewPanel
        playerRef={{ current: null }}
        isPlaying={false}
        onTogglePlay={() => undefined}
        onExport={() => undefined}
        currentTimeMs={15_000}
        durationMs={90_000}
        compact={false}
        onPreviewTimeUpdate={() => undefined}
        onPreviewPlay={() => undefined}
        onPreviewPause={() => undefined}
        onPreviewEnded={() => undefined}
      />,
    );

    expect(html).toContain('播放');
    expect(html).toContain('00:15');
    expect(html).toContain('01:30');
    expect(html).toContain('data-player="remotion"');
  });

});
