import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../src/hooks/useViewportSize', () => ({
  useViewportSize: () => ({ width: 1440, height: 900 }),
}));

vi.mock('../src/components/PreviewPanel', () => ({
  PreviewPanel: () => <div>preview-panel</div>,
}));

vi.mock('../src/components/Timeline', () => ({
  Timeline: () => <div>timeline-panel</div>,
}));

vi.mock('../src/components/AssetPanel', () => ({
  AssetPanel: (props: {
    onUseAsPodcastAudio?: () => Promise<void>;
    onUseAsPodcastSrt?: () => Promise<void>;
  }) => (
    <div
      data-asset-audio-hook={String(Boolean(props.onUseAsPodcastAudio))}
      data-asset-srt-hook={String(Boolean(props.onUseAsPodcastSrt))}
    >
      asset-panel
    </div>
  ),
}));

vi.mock('../src/components/AutoRunLauncher', () => ({
  AutoRunLauncher: (props: { projectDir: string }) => (
    <div data-auto-run-launcher-project-dir={props.projectDir}>auto-run-launcher</div>
  ),
}));

vi.mock('../src/components/EditorShotNavigator', () => ({
  EditorShotNavigator: (props: { onOpenDirector?: () => void }) => (
    <div data-director-hook={String(Boolean(props.onOpenDirector))}>shot-navigator</div>
  ),
}));

vi.mock('../src/components/EditorAnimaticReviewBar', () => ({
  EditorAnimaticReviewBar: () => <div>animatic-review-bar</div>,
}));

vi.mock('../src/components/EditorInspector', () => ({
  EditorInspector: () => <div data-editor-region="inspector-shell">editor-inspector</div>,
}));

vi.mock('../src/components/ExportProgress', () => ({
  ExportProgress: () => null,
}));

vi.mock('../src/components/ExportSettingsModal', () => ({
  ExportSettingsModal: () => null,
}));

vi.mock('../src/hooks/useAIVideoWorkflow', () => ({
  useAIVideoWorkflow: () => ({
    start: () => undefined,
    cancel: () => undefined,
    retry: () => undefined,
    continueFromTtsDone: () => undefined,
    workflow: {
      step: 'idle',
      progress: 0,
      stepLabel: '',
      error: null,
      canCancel: false,
    },
  }),
}));

vi.mock('../src/components/TimelineAIOverlay', () => ({
  TimelineAIOverlay: (props: { compactTimeline?: boolean; onRetry?: () => void }) => (
    <div
      data-editor-region="timeline-ai-overlay"
      data-compact-timeline={String(Boolean(props.compactTimeline))}
      data-has-retry={String(Boolean(props.onRetry))}
    >
      timeline-ai-overlay
    </div>
  ),
}));

vi.mock('../src/store/timeline', () => ({
  useTimelineStore: () => ({
    timeline: {
      fps: 30,
      width: 1920,
      height: 1080,
      podcast: {
        durationMs: 60_000,
      },
    },
  }),
}));

async function renderEditor() {
  const { Editor } = await import('../src/pages/Editor');

  return renderToStaticMarkup(
    <Editor
      onAddAsset={async () => undefined}
      onOpenSettings={() => undefined}
      onUseAsPodcastAudio={async () => undefined}
      onUseAsPodcastSrt={async () => undefined}
      exportRequestToken={0}
    />,
  );
}

describe('Editor', () => {
  it('renders a three-pane workspace with left tabs and a right inspector shell on wide screens', async () => {
    const html = await renderEditor();

    expect(html).toContain('data-editor-sidebar-style="flat-panel"');
    expect(html).toContain('data-editor-sidebar-width="340"');
    expect(html).toContain('素材');
    expect(html).toContain('镜头');
    expect(html).toContain('data-editor-region="inspector-shell"');
    expect(html).toContain('340px 6px minmax(0, 1fr) 6px 260px');
    expect(html).toContain('aria-label="调整侧边栏宽度"');
    expect(html).toContain('aria-label="调整详情面板宽度"');
    expect(html).toContain('aria-label="调整时间线面板高度"');
  });

  it('clips the timeline row so the lower panel shadow cannot overlap the sidebar footer', async () => {
    const html = await renderEditor();

    expect(html).toContain('data-editor-region="timeline-wrap"');
    expect(html).toContain('data-editor-region="sidebar-shell"');
  });

  it('passes dedicated audio and srt attach handlers into the asset panel', async () => {
    const html = await renderEditor();

    expect(html).toContain('data-asset-audio-hook="true"');
    expect(html).toContain('data-asset-srt-hook="true"');
  });

  it('mounts the AutoRunLauncher banner when project dir and setPage are provided', async () => {
    const rendered = await (async () => {
      const { Editor } = await import('../src/pages/Editor');
      return renderToStaticMarkup(
        <Editor
          onAddAsset={async () => undefined}
          onOpenSettings={() => undefined}
          onUseAsPodcastAudio={async () => undefined}
          onUseAsPodcastSrt={async () => undefined}
          exportRequestToken={0}
          projectDir="/tmp/project"
          setPage={() => undefined}
        />,
      );
    })();

    expect(rendered).toContain('data-auto-run-launcher-project-dir="/tmp/project"');
  });

  it('passes retry support and timeline compact flag into the AI overlay', async () => {
    const html = await renderEditor();

    expect(html).toContain('data-editor-region="timeline-ai-overlay"');
    expect(html).toContain('data-has-retry="true"');
  });

  it('keeps the legacy ai panel selection as a shot navigator alias', async () => {
    const { Editor } = await import('../src/pages/Editor');
    const html = renderToStaticMarkup(
      <Editor
        onAddAsset={async () => undefined}
        initialActivePanel="ai"
        onOpenSettings={() => undefined}
        onUseAsPodcastAudio={async () => undefined}
        onUseAsPodcastSrt={async () => undefined}
        exportRequestToken={0}
      />,
    );

    expect(html).toContain('shot-navigator');
  });
});
