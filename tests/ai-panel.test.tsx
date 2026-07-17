import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AIPanel } from '../src/components/AIPanel';

const mockModules = vi.hoisted(() => {
  const buildAnalysisResult = () => ({
    segments: [
      {
        id: 'seg-1',
        title: '开场段落',
        summary: '开场总结',
        startMs: 0,
        endMs: 45_000,
      },
    ],
    cards: [
      {
        id: 'card-1',
        segmentId: 'seg-1',
        type: 'summary' as const,
        title: '本期要点',
        content: '重点内容',
        startMs: 0,
        endMs: 45_000,
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
    ],
    coverPrompts: ['提示词'],
    summary: '总结',
    keywords: ['AI'],
    globalPrompt: '整体偏商业分析风',
  });

  const buildTimeline = () => ({
    podcast: {
      srtPath: '/tmp/test.srt',
    },
    tracks: [{ id: 'visual-1', kind: 'visual', label: '轨道 1', order: 1 }],
    overlays: [
      {
        id: 'overlay-1',
        type: 'image',
        assetPath: '',
        trackId: 'visual-1',
        startMs: 0,
        durationMs: 5_000,
        position: { x: 0, y: 0, width: 1920, height: 1080 },
        overlayType: 'ai-card' as const,
        aiCardData: {
          sourceCardId: 'card-1',
          cardType: 'summary' as const,
          title: '本期要点',
          content: '重点内容',
          template: 'summary-default',
          displayMode: 'fullscreen' as const,
          style: {
            primaryColor: '#6366f1',
            backgroundColor: '#0f172a',
            fontSize: 48,
          },
        },
      },
    ],
  });

  return {
    buildAnalysisResult,
    buildTimeline,
    aiStoreState: {
      analysisResult: buildAnalysisResult(),
      isAnalyzing: false,
      analysisError: null as string | null,
      coverCandidates: [],
      isGeneratingCovers: false,
      incrementalAnalysis: {
        active: false,
        skeletons: [] as Array<{
          segmentId: string;
          title: string;
          status: 'pending' | 'failed';
        }>,
        cards: [] as ReturnType<typeof buildAnalysisResult>['cards'],
      },
      activeTab: 'cards' as const,
      setAnalysisResult: () => undefined,
      setAnalyzing: () => undefined,
      setAnalysisError: () => undefined,
      toggleCardEnabled: () => undefined,
      updateCard: () => undefined,
      setCoverCandidates: () => undefined,
      selectCover: () => undefined,
      setGeneratingCovers: () => undefined,
      setActiveTab: () => undefined,
      clearAnalysis: () => undefined,
    },
    timelineState: {
      srtEntries: [{ index: 1, startMs: 0, endMs: 2_000, text: 'hello' }],
      timeline: buildTimeline(),
      addAICardsToTimeline: () => undefined,
      removeAICardOverlaysBySourceIds: () => undefined,
    },
  };
});

vi.mock('../src/store/ai', () => ({
  useAIStore: () => mockModules.aiStoreState,
  loadAISettings: () => ({
    llmBaseUrl: 'https://api.openai.com/v1',
    llmApiKey: 'sk-test',
    llmModel: 'gpt-4o',
  }),
  saveAISettings: () => undefined,
}));

vi.mock('../src/store/timeline', () => ({
  useTimelineStore: () => mockModules.timelineState,
  getProjectDir: () => '/tmp/project',
}));

describe('AIPanel', () => {
  beforeEach(() => {
    mockModules.aiStoreState.analysisResult = mockModules.buildAnalysisResult();
    mockModules.aiStoreState.isAnalyzing = false;
    mockModules.aiStoreState.analysisError = null;
    mockModules.aiStoreState.coverCandidates = [];
    mockModules.aiStoreState.isGeneratingCovers = false;
    mockModules.aiStoreState.activeTab = 'cards';
    mockModules.timelineState.srtEntries = [{ index: 1, startMs: 0, endMs: 2_000, text: 'hello' }];
    mockModules.timelineState.timeline = mockModules.buildTimeline();
  });

  it('renders the assistant header, tabs and apply action', () => {
    const html = renderToStaticMarkup(<AIPanel compact={false} />);

    expect(html).toContain('data-ai-panel-root="true"');
    expect(html).toContain('data-ai-panel-tab="cards"');
    expect(html).toContain('data-ai-panel-header="true"');
    expect(html).toContain('内容卡片');
    expect(html).toContain('封面');
    expect(html).toContain('制作');
    // 视觉编排 tab 已下线
    expect(html).not.toContain('视觉编排');
    expect(html).toContain('内容生成');
    expect(html).toContain('已选 1/1');
    // HTML 卡片导入入口已随 Web Card 一并下线，不再出现 import-row 按钮
    expect(html).not.toContain('data-ai-import-row="true"');
    expect(html).not.toContain('支持点击选择，也支持把 .html / .htm 文件直接拖到这里');
    expect(html).toContain('data-ai-selection-summary="true"');
    expect(html).toContain('整体创作提示词');
    expect(html).toContain('data-ai-action-bar="true"');
    expect(html).toContain('本期要点');
    expect(html).toContain('删除已选');
    expect(html).toContain('全选');
    expect(html).toContain('data-ai-footer-button="true"');
    expect(html).toContain('上轨 1');
  });

  it('shows explicit loading feedback while analyzing content', () => {
    mockModules.aiStoreState.analysisResult = null;
    mockModules.aiStoreState.isAnalyzing = true;

    const html = renderToStaticMarkup(<AIPanel compact={false} />);

    expect(html).toContain('生成中...');
    expect(html).toContain('生成内容卡片');
    expect(html).toContain('准备分析字幕内容');
    expect(html).not.toContain('提炼重点');
    expect(html).not.toContain('aria-current="step"');
    expect(html).toContain('aria-busy="true"');
  });

  it('keeps existing cards visible with lightweight status while regenerating', () => {
    mockModules.aiStoreState.isAnalyzing = true;

    const html = renderToStaticMarkup(<AIPanel compact={false} />);

    expect(html).toContain('重新生成内容卡片');
    expect(html).toContain('准备重新生成内容卡片');
    expect(html).toContain('重新生成中');
    expect(html).not.toContain('当前卡片区会暂时锁定');
  });

  it('keeps a regenerate entry visible after all cards are deleted', () => {
    mockModules.aiStoreState.analysisResult = {
      ...mockModules.buildAnalysisResult(),
      cards: [],
    };

    const html = renderToStaticMarkup(<AIPanel compact={false} />);

    expect(html).toContain('卡片已清空');
    expect(html).toContain('内容卡片已全部删除');
    // 在 SSR 中 useEffect 不运行，因此会展示缺少配置时的引导文案
    expect(html).toContain('前往系统设置');
    expect(html).not.toContain('应用到时间线');
  });

  it('keeps the compact assistant footer action visible', () => {
    const html = renderToStaticMarkup(<AIPanel compact railHeight={154} />);

    expect(html).toContain('data-ai-panel-root="true"');
    expect(html).toContain('内容生成');
    expect(html).toContain('data-ai-footer-button="true"');
    expect(html).toContain('上轨 1');
    expect(html).toContain('卡片');
  });

  it('disables the header analyze trigger while analyzing to prevent duplicate runs', () => {
    mockModules.aiStoreState.isAnalyzing = true;

    const html = renderToStaticMarkup(<AIPanel compact={false} />);

    // 用 disabled="" 属性而非子串 'disabled'：className 含 Tailwind 的 disabled: 工具类会污染匹配。
    const m = html.match(/<button([^>]*)data-ai-analyze-trigger="header"([^>]*)>/);
    expect(m).not.toBeNull();
    expect(`${m![1]}${m![2]}`).toContain('disabled="');
  });

  it('keeps the header analyze trigger enabled when idle', () => {
    mockModules.aiStoreState.isAnalyzing = false;

    const html = renderToStaticMarkup(<AIPanel compact={false} />);

    const m = html.match(/<button([^>]*)data-ai-analyze-trigger="header"([^>]*)>/);
    expect(m).not.toBeNull();
    expect(`${m![1]}${m![2]}`).not.toContain('disabled="');
  });

  it('renders failed segment retry entries from analysisResult.cardErrors', () => {
    mockModules.aiStoreState.analysisResult = {
      ...mockModules.buildAnalysisResult(),
      segments: [
        ...mockModules.buildAnalysisResult().segments,
        {
          id: 'seg-2',
          title: '模型选择',
          summary: '讲模型选择',
          startMs: 45_000,
          endMs: 90_000,
        },
      ],
      cardErrors: [
        {
          segmentId: 'seg-1',
          segmentIndex: 0,
          totalSegments: 2,
          segmentTitle: '开场段落',
          message: '空闲超时',
        },
        {
          segmentId: 'seg-2',
          segmentIndex: 1,
          totalSegments: 2,
          message: '模型返回空内容',
        },
      ],
    };

    const html = renderToStaticMarkup(<AIPanel compact={false} />);

    expect(html).toContain('data-ai-card-errors="true"');
    expect(html).toContain('失败段 2');
    expect(html).toContain('卡片生成失败，可单独重试');
    expect(html).toContain('data-ai-card-error-item="seg-1"');
    expect(html).toContain('data-ai-card-error-item="seg-2"');
    expect(html).toContain('开场段落');
    expect(html).toContain('模型选择');
    expect(html).toContain('空闲超时');
    expect(html).toContain('模型返回空内容');
    expect(html).toContain('data-ai-retry-card-errors-all="true"');
    expect(html).toContain('data-ai-retry-card-error="seg-1"');
  });

});
