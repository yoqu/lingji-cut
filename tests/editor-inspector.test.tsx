import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorInspector } from '../src/components/EditorInspector';
import { createDefaultTimeline } from '../src/types';

const { timelineStoreState } = vi.hoisted(() => ({
  timelineStoreState: {
    timeline: null as unknown,
    srtEntries: [],
    assets: [],
    updateOverlay: vi.fn(),
    removeOverlay: vi.fn(),
  },
}));

interface ProjectMeta {
  projectName: string;
  projectPath: string;
  createdAt: number;
  sizeBytes: number;
}

vi.mock('../src/hooks/useAICardInspector', () => ({
  useAICardInspector: () => ({
    card: {
      id: 'card-2',
      type: 'summary' as const,
      title: 'AI 驱动的未来',
      content: '人工智能正在改变创作方式。',
      startMs: 10_000,
      endMs: 55_000,
      displayDurationMs: 5_000,
      displayMode: 'fullscreen' as const,
      template: 'summary-default',
      enabled: true,
      style: {
        primaryColor: '#6366f1',
        backgroundColor: '#0f172a',
        fontSize: 48,
      },
    },
    cardSequenceLabel: '第 2 段',
    errorMessage: null,
    isPlacedOnTimeline: true,
    isRegeneratingCard: false,
    regenerateCard: async () => null,
    saveCard: () => undefined,
    deleteCard: () => undefined,
  }),
}));

vi.mock('../src/store/timeline', () => ({
  useTimelineStore: (selector?: (state: typeof timelineStoreState) => unknown) =>
    selector ? selector(timelineStoreState) : timelineStoreState,
}));

describe('EditorInspector', () => {
  beforeEach(() => {
    const timeline = createDefaultTimeline();
    timeline.overlays = [
      {
        id: 'text-overlay-1',
        type: 'text',
        assetPath: '',
        trackId: 'visual-1',
        startMs: 1000,
        durationMs: 5000,
        position: { x: 100, y: 120, width: 800, height: 200 },
        motion: {
          enter: 'fadeIn',
          enterDurationMs: 400,
          exit: 'fadeOut',
          exitDurationMs: 400,
          loop: 'none',
        },
        textData: {
          content: '这是文字标题',
          fontFamily: 'PingFang SC',
          fontSize: 64,
          fontColor: '#FFFFFF',
          bold: false,
          italic: false,
          underline: false,
          textAlign: 'center',
          backgroundColor: 'transparent',
          strokeColor: '#000000',
          strokeWidth: 0,
          shadowColor: '#000000',
          shadowOffsetX: 0,
          shadowOffsetY: 2,
          shadowBlur: 0,
          letterSpacing: 0,
          lineHeight: 1.5,
          opacity: 1,
          rotation: 0,
          animation: {
            enter: 'fadeIn',
            enterDurationMs: 400,
            exit: 'fadeOut',
            exitDurationMs: 400,
            loop: 'none',
          },
        },
      },
      {
        id: 'image-overlay-1',
        type: 'image',
        assetPath: '/tmp/cover.png',
        trackId: 'visual-1',
        startMs: 7000,
        durationMs: 3000,
        position: { x: 0, y: 0, width: 1920, height: 1080 },
        motion: {
          enter: 'slideInLeft',
          enterDurationMs: 500,
          exit: 'none',
          exitDurationMs: 400,
          loop: 'pulse',
        },
      },
    ];

    timelineStoreState.timeline = timeline;
    timelineStoreState.srtEntries = [];
    timelineStoreState.assets = [];
    timelineStoreState.updateOverlay.mockReset();
    timelineStoreState.removeOverlay.mockReset();
  });

  it('renders project overview details instead of an empty placeholder when nothing is selected', () => {
    const projectMeta: ProjectMeta = {
      projectName: 'video-web-demo',
      projectPath: '/Users/yoqu/Projects/video-web-demo',
      createdAt: Date.UTC(2026, 3, 5, 4, 30, 0),
      sizeBytes: 15 * 1024 * 1024,
    };

    const html = renderToStaticMarkup(
      <EditorInspector
        selection={{ type: 'empty' }}
        timelineWidth={1920}
        timelineHeight={1080}
        onClose={() => undefined}
        {...({
          timelineFps: 30,
          overlayCount: 0,
          projectDir: projectMeta.projectPath,
          projectMeta,
        } as Record<string, unknown>)}
      />,
    );

    expect(html).toContain('项目概览');
    expect(html).toContain('video-web-demo');
    expect(html).toContain('/Users/yoqu/Projects/video-web-demo');
    expect(html).toContain('1920 × 1080');
    expect(html).toContain('30 fps');
    expect(html).toContain('15.0 MB');
  });

  it('renders the design-aligned ai card header metadata', () => {
    const html = renderToStaticMarkup(
      <EditorInspector
        selection={{ type: 'ai-card', cardId: 'card-2' }}
        timelineWidth={1920}
        timelineHeight={1080}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('AI 卡片');
    expect(html).toContain('第 2 段');
    expect(html).not.toContain('仅素材');
    expect(html).not.toContain('已上轨');
  });

  it('renders text overlay details through the unified overlay selection', () => {
    const html = renderToStaticMarkup(
      <EditorInspector
        selection={{ type: 'overlay', overlayId: 'text-overlay-1' }}
        timelineWidth={1920}
        timelineHeight={1080}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('文字');
    expect(html).toContain('动画');
    expect(html).toContain('这是文字标题');
  });

  it('renders media overlay details through the unified overlay selection', () => {
    const html = renderToStaticMarkup(
      <EditorInspector
        selection={{ type: 'overlay', overlayId: 'image-overlay-1' }}
        timelineWidth={1920}
        timelineHeight={1080}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('素材图层');
    expect(html).toContain('cover.png');
    // 动效下拉展示共享预设的中文标签（slideInLeft → 左滑入）
    expect(html).toContain('左滑入');
  });
});
