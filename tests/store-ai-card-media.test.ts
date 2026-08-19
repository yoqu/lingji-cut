import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { useAIStore } from '../src/store/ai';
import { useTimelineStore } from '../src/store/timeline';
import type { AIAnalysisResult, MediaCardContent } from '../src/types/ai';
import { DEFAULT_ASSET_TREATMENT, EMPTY_ASSET_SEMANTIC, type AssetLibraryFile } from '../src/types/assets';

function makeAnalysis(): AIAnalysisResult {
  return {
    segments: [
      {
        id: 'seg-1',
        title: 't',
        summary: 's',
        startMs: 0,
        endMs: 1000,
      },
    ],
    cards: [],
    coverPrompts: [],
    summary: '',
    keywords: [],
  };
}

describe('AI store: media card actions', () => {
  beforeEach(() => {
    useAIStore.setState({
      analysisResult: makeAnalysis(),
      currentProjectDir: null,
      cardMediaTasks: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createImageCard 插入 idle 状态卡片', async () => {
    const card = await useAIStore.getState().createImageCard('seg-1', {
      prompt: 'a cat',
      aspectRatio: '16:9',
    });
    expect(card.type).toBe('image');
    const content = card.content as MediaCardContent;
    expect(content.generationStatus).toBe('idle');
    expect(content.prompt).toBe('a cat');
    expect(content.mediaType).toBe('image');
    expect(content.aspectRatio).toBe('16:9');
    // 入 store
    const found = useAIStore.getState().analysisResult!.cards.find((c) => c.id === card.id);
    expect(found).toBeTruthy();
  });

  it('createVideoCard displayDurationMs = durationSeconds*1000', async () => {
    const card = await useAIStore.getState().createVideoCard('seg-1', {
      durationSeconds: 8,
      aspectRatio: '16:9',
    });
    expect(card.type).toBe('video');
    expect(card.displayDurationMs).toBe(8000);
    const content = card.content as MediaCardContent;
    expect(content.mediaType).toBe('video');
    expect(content.aspectRatio).toBe('16:9');
    expect(content.generationStatus).toBe('idle');
  });

  it('资产处理结果变化后刷新绑定，资产删除后写入生产风险', () => {
    const motionCard = {
      id: 'motion-1',
      segmentId: 'seg-1',
      type: 'motion' as const,
      title: 'Motion',
      content: 'content',
      startMs: 0,
      endMs: 1000,
      displayDurationMs: 1000,
      displayMode: 'fullscreen' as const,
      template: 'motion',
      enabled: true,
      style: {} as never,
      assetBindings: [{
        slot: 'hero',
        assetId: 'asset-1',
        filePath: '/old.png',
        treatment: DEFAULT_ASSET_TREATMENT,
        placement: { x: 0, y: 0, width: 500 },
      }],
      motionCard: { tsx: 'export default () => null', compiledAt: 0, prompt: '', retryCount: 0 },
    };
    useAIStore.setState({
      analysisResult: { ...makeAnalysis(), cards: [motionCard] },
    });
    const library: AssetLibraryFile = {
      version: 2,
      libraryId: 'test',
      settings: { rootDir: '/tmp', defaultImportMode: 'copy', defaultProjectReferenceMode: 'copy-to-project' },
      updatedAt: '2026-07-10T00:00:00.000Z',
      assets: [{
        id: 'asset-1',
        name: 'Hero',
        kind: 'image',
        role: 'object',
        sourceType: 'manual-import',
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
        files: { original: '/original.png', processed: '/cutout.png' },
        metadata: { contentHash: 'hash', byteSize: 100, hasAlpha: true },
        semantic: EMPTY_ASSET_SEMANTIC,
        treatment: DEFAULT_ASSET_TREATMENT,
        usage: { projectRefs: [], favorite: false },
      }],
    };

    useAIStore.getState().reconcileAssetBindings(library);
    expect(useAIStore.getState().analysisResult?.cards[0]?.assetBindings?.[0]?.filePath).toBe('/cutout.png');

    useAIStore.getState().reconcileAssetBindings({ ...library, assets: [] });
    const deleted = useAIStore.getState().analysisResult?.cards[0];
    expect(deleted?.assetBindings).toEqual([]);
    expect(deleted?.motionCard?.productionReport?.status).toBe('risk');
    expect(deleted?.motionCard?.productionReport?.assetIssues[0]?.code).toBe('asset-binding-missing');
  });

  it('不删除导演已冻结但不属于 Asset Center 的用户锁定素材', () => {
    const binding = {
      slot: 'media-1',
      assetId: 'lingji-material-1',
      filePath: '/external/evidence.jpg',
      kind: 'image' as const,
      usage: 'required' as const,
      required: true,
      lockedByUser: true,
      fileFingerprint: 'stat:1:2',
      treatment: DEFAULT_ASSET_TREATMENT,
      placement: { x: 0, y: 0, width: 1920 },
    };
    useAIStore.setState({
      analysisResult: {
        ...makeAnalysis(),
        cards: [{
          id: 'composite-1',
          segmentId: 'seg-1',
          type: 'motion',
          title: 'Composite',
          content: 'content',
          startMs: 0,
          endMs: 1_000,
          displayDurationMs: 1_000,
          displayMode: 'fullscreen',
          template: 'motion',
          enabled: true,
          style: {} as never,
          renderStrategy: 'agent-composite',
          assetBindings: [binding],
          motionCard: { tsx: 'export default () => null', compiledAt: 0, prompt: '', retryCount: 0 },
        }],
      },
    });
    useAIStore.getState().reconcileAssetBindings({
      version: 2,
      libraryId: 'empty',
      settings: { rootDir: '/tmp', defaultImportMode: 'copy', defaultProjectReferenceMode: 'copy-to-project' },
      updatedAt: '2026-07-31T00:00:00.000Z',
      assets: [],
    });

    const card = useAIStore.getState().analysisResult?.cards[0];
    expect(card?.assetBindings).toEqual([binding]);
    expect(card?.motionCard?.productionReport?.assetIssues ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'asset-binding-missing' })]),
    );
  });

  it('regenerateCardMedia 成功后写回 ready 与新内容', async () => {
    const fakeMedia: MediaCardContent = {
      mediaType: 'image',
      assetPath: 'ai-cards/c/image.png',
      aspectRatio: '16:9',
      prompt: 'p',
      providerId: 'p1',
      model: 'm1',
      generationStatus: 'ready',
      generatedAt: 1,
    };
    vi.stubGlobal('window', {
      electronAPI: {
        generateCardImage: async () => fakeMedia,
        onCardMediaProgress: () => () => {},
      },
    });
    useAIStore.setState({ currentProjectDir: '/tmp/proj' });
    const card = await useAIStore.getState().createImageCard('seg-1');
    await useAIStore.getState().regenerateCardMedia(card.id);
    const updated = useAIStore.getState().analysisResult!.cards.find((c) => c.id === card.id)!;
    const content = updated.content as MediaCardContent;
    expect(content.generationStatus).toBe('ready');
    expect(content.assetPath).toBe('ai-cards/c/image.png');
  });

  it('convertCardToMotion: 有背景段 → 走 regenerateAICard 并保号', async () => {
    useAIStore.setState({
      analysisResult: {
        segments: [{ id: 'seg-1', title: 't', summary: 's', startMs: 0, endMs: 1000 }],
        cards: [
          {
            id: 'card-x',
            segmentId: 'seg-1',
            type: 'image',
            title: '原标题',
            content: {
              mediaType: 'image',
              assetPath: 'ai-cards/c/i.png',
              aspectRatio: '16:9',
              prompt: 'p',
              providerId: null,
              model: null,
              generationStatus: 'ready',
            },
            startMs: 0,
            endMs: 1000,
            displayDurationMs: 1000,
            displayMode: 'fullscreen',
            template: 'image',
            enabled: true,
            style: {} as never,
            renderMode: 'legacy',
          },
        ],
        coverPrompts: [],
        summary: '',
        keywords: [],
      },
      currentProjectDir: '/tmp/proj',
      projectBindings: null,
    });

    const calls: { regen: number; subs: number } = { regen: 0, subs: 0 };
    vi.stubGlobal('window', {
      electronAPI: {
        loadGlobalSettings: async () =>
          JSON.stringify({
            aiSettings: {
              llmProviders: [{ id: 'p1', name: 'p', type: 'openai', baseUrl: 'x', apiKey: 'k', models: ['m'] }],
              defaultProviderId: 'p1',
              defaultModel: 'm',
            },
          }),
        regenerateAICard: async (args: { card: { id: string } }) => {
          calls.regen += 1;
          return {
            ...args.card,
            id: args.card.id,
            type: 'motion',
            content: '逐字稿',
            renderMode: 'motion-card',
            motionCard: { tsx: 'export default () => null', compiledAt: 0, prompt: '', retryCount: 0 },
          };
        },
        generateCardFromSubtitles: async () => {
          calls.subs += 1;
          throw new Error('不该走到 subtitles 路径');
        },
        saveProjectSection: async () => undefined,
      },
    });

    const result = await useAIStore.getState().convertCardToMotion('card-x');
    expect(calls.regen).toBe(1);
    expect(calls.subs).toBe(0);
    expect(result?.type).toBe('motion');
    expect(result?.renderMode).toBe('motion-card');
    const stored = useAIStore.getState().analysisResult!.cards.find((c) => c.id === 'card-x')!;
    expect(stored.type).toBe('motion');
    expect(stored.title).toBe('原标题'); // 保号
    expect(stored.motionCard?.tsx).toContain('export default');
  });

  it('convertCardToMotion: 无背景段（手动卡）→ 走 generateCardFromSubtitles', async () => {
    useAIStore.setState({
      analysisResult: {
        segments: [],
        cards: [
          {
            id: 'manual-1',
            segmentId: 'manual:abc',
            type: 'image',
            title: '手动卡',
            content: {
              mediaType: 'image',
              assetPath: null,
              aspectRatio: '16:9',
              prompt: '海边日落',
              providerId: null,
              model: null,
              generationStatus: 'idle',
            },
            startMs: 0,
            endMs: 0,
            displayDurationMs: 5000,
            displayMode: 'fullscreen',
            template: 'image',
            enabled: true,
            style: {} as never,
            renderMode: 'legacy',
          },
        ],
        coverPrompts: [],
        summary: '',
        keywords: [],
      },
      currentProjectDir: '/tmp/proj',
      projectBindings: null,
    });

    let draftSeen: { text: string; type: string } | null = null;
    vi.stubGlobal('window', {
      electronAPI: {
        loadGlobalSettings: async () =>
          JSON.stringify({
            aiSettings: {
              llmProviders: [{ id: 'p1', name: 'p', type: 'openai', baseUrl: 'x', apiKey: 'k', models: ['m'] }],
              defaultProviderId: 'p1',
              defaultModel: 'm',
            },
          }),
        generateCardFromSubtitles: async (args: { draft: { text: string; type: string } }) => {
          draftSeen = args.draft;
          return {
            id: 'GEN',
            segmentId: 'manual-xyz',
            type: 'motion',
            title: '生成',
            content: '海边日落',
            startMs: 0,
            endMs: 5000,
            displayDurationMs: 5000,
            displayMode: 'fullscreen',
            template: 'motion',
            enabled: true,
            style: {},
            renderMode: 'motion-card',
            motionCard: { tsx: 'export default () => null', compiledAt: 0, prompt: '', retryCount: 0 },
          };
        },
        saveProjectSection: async () => undefined,
      },
    });

    const result = await useAIStore.getState().convertCardToMotion('manual-1');
    expect(draftSeen).not.toBeNull();
    expect(draftSeen!.text).toBe('海边日落');
    expect(draftSeen!.type).toBe('motion');
    expect(result?.id).toBe('manual-1'); // 保号
    expect(result?.title).toBe('手动卡');
  });

  it('convertCardToMotion: 已是 motion 家族 → 返回 null 不调用 IPC', async () => {
    useAIStore.setState({
      analysisResult: {
        segments: [],
        cards: [
          {
            id: 'm1',
            segmentId: 'seg',
            type: 'motion',
            title: 't',
            content: 'x',
            startMs: 0,
            endMs: 1000,
            displayDurationMs: 1000,
            displayMode: 'fullscreen',
            template: 'motion',
            enabled: true,
            style: {} as never,
            renderMode: 'motion-card',
          },
        ],
        coverPrompts: [],
        summary: '',
        keywords: [],
      },
    });
    const result = await useAIStore.getState().convertCardToMotion('m1');
    expect(result).toBeNull();
  });

  it('convertCardToMotion: 生成失败 → 返回 null 且原卡片不被破坏', async () => {
    const originalCard = {
      id: 'card-fail',
      segmentId: 'seg-1',
      type: 'image' as const,
      title: '原图卡',
      content: {
        mediaType: 'image' as const,
        assetPath: 'ai-cards/c/i.png',
        aspectRatio: '16:9' as const,
        prompt: 'p',
        providerId: null,
        model: null,
        generationStatus: 'ready' as const,
      },
      startMs: 0,
      endMs: 1000,
      displayDurationMs: 1000,
      displayMode: 'fullscreen' as const,
      template: 'image',
      enabled: true,
      style: {} as never,
      renderMode: 'legacy' as const,
    };
    useAIStore.setState({
      analysisResult: {
        segments: [{ id: 'seg-1', title: 't', summary: 's', startMs: 0, endMs: 1000 }],
        cards: [originalCard],
        coverPrompts: [],
        summary: '',
        keywords: [],
      },
      currentProjectDir: '/tmp/proj',
      projectBindings: null,
    });

    vi.stubGlobal('window', {
      electronAPI: {
        loadGlobalSettings: async () =>
          JSON.stringify({
            aiSettings: {
              llmProviders: [{ id: 'p1', name: 'p', type: 'openai', baseUrl: 'x', apiKey: 'k', models: ['m'] }],
              defaultProviderId: 'p1',
              defaultModel: 'm',
            },
          }),
        regenerateAICard: async () => {
          throw new Error('TSX 编译失败');
        },
        saveProjectSection: async () => undefined,
      },
    });

    const result = await useAIStore.getState().convertCardToMotion('card-fail');
    expect(result).toBeNull();
    const stored = useAIStore.getState().analysisResult!.cards.find((c) => c.id === 'card-fail')!;
    expect(stored.type).toBe('image'); // 原卡片保持不变
    expect(stored.renderMode).toBe('legacy');
    expect(useAIStore.getState().analysisError).toContain('TSX 编译失败');
  });

  it('convertCardToMotion: 卡片已上轨 → 触发 addAICardsToTimeline 刷新 overlay', async () => {
    useAIStore.setState({
      analysisResult: {
        segments: [{ id: 'seg-1', title: 't', summary: 's', startMs: 0, endMs: 1000 }],
        cards: [
          {
            id: 'placed-1',
            segmentId: 'seg-1',
            type: 'image',
            title: '上轨卡',
            content: {
              mediaType: 'image',
              assetPath: 'ai-cards/c/i.png',
              aspectRatio: '16:9',
              prompt: 'p',
              providerId: null,
              model: null,
              generationStatus: 'ready',
            },
            startMs: 0,
            endMs: 1000,
            displayDurationMs: 1000,
            displayMode: 'fullscreen',
            template: 'image',
            enabled: true,
            style: {} as never,
            renderMode: 'legacy',
          },
        ],
        coverPrompts: [],
        summary: '',
        keywords: [],
      },
      currentProjectDir: '/tmp/proj',
      projectBindings: null,
    });

    const addSpy = vi.fn();
    const prevTimeline = useTimelineStore.getState().timeline;
    useTimelineStore.setState({
      addAICardsToTimeline: addSpy,
      timeline: {
        ...prevTimeline,
        overlays: [
          {
            id: 'ov-1',
            overlayType: 'ai-card',
            aiCardData: { sourceCardId: 'placed-1' },
          } as never,
        ],
      },
    });

    vi.stubGlobal('window', {
      electronAPI: {
        loadGlobalSettings: async () =>
          JSON.stringify({
            aiSettings: {
              llmProviders: [{ id: 'p1', name: 'p', type: 'openai', baseUrl: 'x', apiKey: 'k', models: ['m'] }],
              defaultProviderId: 'p1',
              defaultModel: 'm',
            },
          }),
        regenerateAICard: async (args: { card: { id: string } }) => ({
          ...args.card,
          type: 'motion',
          content: '逐字稿',
          renderMode: 'motion-card',
          motionCard: { tsx: 'export default () => null', compiledAt: 0, prompt: '', retryCount: 0 },
        }),
        saveProjectSection: async () => undefined,
      },
    });

    const result = await useAIStore.getState().convertCardToMotion('placed-1');
    expect(result?.type).toBe('motion');
    expect(addSpy).toHaveBeenCalledTimes(1);
    const draftArg = addSpy.mock.calls[0][0];
    expect(Array.isArray(draftArg)).toBe(true);
    expect(draftArg[0].sourceCardId).toBe('placed-1');

    useTimelineStore.setState({ timeline: prevTimeline });
  });
});
