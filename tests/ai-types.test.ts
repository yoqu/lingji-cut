import { describe, expect, it } from 'vitest';
import type {
  AICard,
  AIAnalysisResult,
  AISettings,
  DataContent,
} from '../src/types/ai';
import { buildAICardOverlayData, buildAICardTimelineDraft } from '../src/types/ai';
import type { OverlayItem } from '../src/types';
import { DEFAULT_ASSET_TREATMENT, type CardAssetBinding, type StoryboardAssetRequest } from '../src/types/assets';

describe('AI type definitions', () => {
  it('creates a summary card with the expected fields', () => {
    const card: AICard = {
      id: 'card-1',
      type: 'summary',
      title: '本期要点',
      content: '要点一\n要点二',
      startMs: 0,
      endMs: 45_000,
      displayDurationMs: 5_000,
      displayMode: 'fullscreen',
      template: 'summary-default',
      enabled: true,
      style: {
        primaryColor: '#6366f1',
        backgroundColor: '#0f172a',
        fontSize: 48,
      },
    };

    expect(card.type).toBe('summary');
    expect(card.enabled).toBe(true);
  });

  it('supports data cards with structured chart content', () => {
    const content: DataContent = {
      chartType: 'bar',
      items: [
        { label: 'React', value: 72, highlight: true },
        { label: 'Vue', value: 45 },
      ],
    };
    const card: AICard = {
      id: 'card-2',
      type: 'data',
      title: '框架使用率',
      content,
      startMs: 200_000,
      endMs: 230_000,
      displayDurationMs: 6_000,
      displayMode: 'fullscreen',
      template: 'data-default',
      enabled: true,
      style: {
        primaryColor: '#10b981',
        backgroundColor: '#0f172a',
        fontSize: 48,
      },
    };

    expect(card.type).toBe('data');
    expect((card.content as DataContent).chartType).toBe('bar');
  });

  it('creates a valid AI analysis result', () => {
    const result: AIAnalysisResult = {
      cards: [],
      coverPrompts: ['prompt 1'],
      summary: '本期讨论了 AI 编程',
      keywords: ['AI', '编程'],
      globalPrompt: '整体偏商业分析风',
    };

    expect(result.coverPrompts).toHaveLength(1);
    expect(result.keywords).toContain('AI');
    expect(result.globalPrompt).toContain('商业分析');
  });

  it('supports overlay items carrying ai-card data', () => {
    const overlay: OverlayItem = {
      id: 'ov-1',
      type: 'image',
      assetPath: '',
      trackId: 'visual-1',
      startMs: 0,
      durationMs: 5_000,
      position: { x: 0, y: 0, width: 1_920, height: 1_080 },
      overlayType: 'ai-card',
      aiCardData: {
        sourceCardId: 'card-1',
        cardType: 'summary',
        title: '总结',
        content: '内容',
        template: 'summary-default',
        displayMode: 'fullscreen',
        renderMode: 'legacy',
        style: {
          primaryColor: '#6366f1',
          backgroundColor: '#0f172a',
          fontSize: 48,
        },
        sourceStartMs: 0,
        sourceEndMs: 30_000,
      },
    };

    expect(overlay.overlayType).toBe('ai-card');
    expect(overlay.aiCardData?.cardType).toBe('summary');
    expect(overlay.aiCardData?.sourceCardId).toBe('card-1');
    expect(overlay.aiCardData?.sourceEndMs).toBe(30_000);
  });

  it('supports the basic llm settings structure', () => {
    const settings: AISettings = {
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'sk-test',
      llmModel: 'gpt-4o',
    };

    expect(settings.llmBaseUrl).toContain('openai');
    expect(settings.llmModel).toBe('gpt-4o');
  });

  it('builds reusable timeline draft data from an AI card', () => {
    const card: AICard = {
      id: 'card-helper',
      segmentId: 'seg-helper',
      type: 'insight',
      title: '关键判断',
      content: '现金流比增速更重要',
      startMs: 12_000,
      endMs: 28_000,
      displayDurationMs: 4_000,
      displayMode: 'pip',
      template: 'insight-default',
      enabled: true,
      style: {
        primaryColor: '#f59e0b',
        backgroundColor: '#0f172a',
        fontSize: 48,
      },
    };

    expect(buildAICardOverlayData(card)).toEqual({
      sourceCardId: 'card-helper',
      cardType: 'insight',
      title: '关键判断',
      content: '现金流比增速更重要',
      template: 'insight-default',
      displayMode: 'pip',
      style: {
        primaryColor: '#f59e0b',
        backgroundColor: '#0f172a',
        fontSize: 48,
      },
      renderMode: 'legacy',
      cardPrompt: undefined,
      assetRequests: undefined,
      assetBindings: undefined,
      motionCard: undefined,
      sourceStartMs: 12_000,
      sourceEndMs: 28_000,
      segmentId: 'seg-helper',
      stylePresetId: undefined,
    });

    expect(buildAICardTimelineDraft(card)).toEqual({
      sourceCardId: 'card-helper',
      startMs: 24_000,
      durationMs: 4_000,
      aiCardData: buildAICardOverlayData(card),
    });
  });

  it('anchors a short timeline card near the end of its source topic window', () => {
    const card: AICard = {
      id: 'card-anchor',
      segmentId: 'seg-anchor',
      type: 'summary',
      title: '滞后出现的核心观点',
      content: '真正的主题在后半段才说出来',
      startMs: 30_000,
      endMs: 42_000,
      displayDurationMs: 5_000,
      displayMode: 'fullscreen',
      template: 'summary-default',
      enabled: true,
      style: {
        primaryColor: '#6366f1',
        backgroundColor: '#0f172a',
        fontSize: 48,
      },
    };

    expect(buildAICardTimelineDraft(card)).toEqual({
      sourceCardId: 'card-anchor',
      startMs: 37_000,
      durationMs: 5_000,
      aiCardData: buildAICardOverlayData(card),
    });
  });

  it('passes storyboard asset requests and resolved bindings into overlay data', () => {
    const assetRequests: StoryboardAssetRequest[] = [
      {
        slot: 'chip_prop',
        query: '芯片样品',
        role: 'object',
        importance: 'primary',
        reusePolicy: 'generate-if-missing',
        visualTreatment: 'technical-product',
        placementHint: '右下角前景',
      },
    ];
    const assetBindings: CardAssetBinding[] = [
      {
        slot: 'chip_prop',
        assetId: 'asset-chip',
        filePath: '/tmp/chip.png',
        treatment: DEFAULT_ASSET_TREATMENT,
        placement: {
          x: 120,
          y: 240,
          width: 220,
          depth: 'foreground',
        },
      },
    ];
    const card: AICard = {
      id: 'card-assets',
      type: 'insight',
      title: '硬件约束',
      content: '芯片成为关键变量',
      startMs: 0,
      endMs: 10_000,
      displayDurationMs: 4_000,
      displayMode: 'fullscreen',
      template: 'insight-default',
      enabled: true,
      style: {
        primaryColor: '#0A84FF',
        backgroundColor: '#1C1C1E',
        fontSize: 48,
      },
      assetRequests,
      assetBindings,
    };

    const data = buildAICardOverlayData(card);
    expect(data.assetRequests).toBe(assetRequests);
    expect(data.assetBindings).toBe(assetBindings);
  });
});
