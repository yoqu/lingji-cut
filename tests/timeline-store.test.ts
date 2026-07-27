import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_VISUAL_TRACK_ID,
  DEFAULT_AI_CARDS_TRACK_ID,
  createDefaultTimeline,
  createDefaultSubtitleStyle,
} from '../src/types';
import { useTimelineStore } from '../src/store/timeline';

describe('useTimelineStore', () => {
  beforeEach(() => {
    useTimelineStore.setState({
      timeline: createDefaultTimeline(),
      srtEntries: [],
      assets: [],
      overlayClipboard: null,
    });
  });

  it('creates default subtitle highlight settings', () => {
    expect(createDefaultTimeline().subtitle).toEqual(createDefaultSubtitleStyle());
    expect(createDefaultTimeline().subtitleHighlights).toEqual([]);
  });

  it('sets podcast metadata', () => {
    useTimelineStore.getState().setPodcast('/tmp/audio.mp3', '/tmp/subtitles.srt', 12000);

    expect(useTimelineStore.getState().timeline.podcast).toEqual({
      audioPath: '/tmp/audio.mp3',
      srtPath: '/tmp/subtitles.srt',
      durationMs: 12000,
    });
    expect(useTimelineStore.getState().assets).toEqual([
      {
        path: '/tmp/audio.mp3',
        type: 'audio',
        name: 'audio.mp3',
        durationMs: 12000,
        locked: true,
      },
      {
        path: '/tmp/subtitles.srt',
        type: 'srt',
        name: 'subtitles.srt',
        durationMs: 12000,
        locked: true,
      },
    ]);
  });

  it('advances the preview revision when same-path podcast files are replaced', () => {
    const initialRevision = useTimelineStore.getState().podcastRevision;

    useTimelineStore.getState().setSrtEntries([
      { index: 1, startMs: 0, endMs: 1000, text: '旧字幕' },
    ]);
    useTimelineStore.getState().setPodcast('/tmp/audio.mp3', '/tmp/subtitles.srt', 12000);
    useTimelineStore.getState().setSrtEntries([
      { index: 1, startMs: 0, endMs: 1200, text: '新字幕' },
    ]);
    useTimelineStore.getState().setPodcast('/tmp/audio.mp3', '/tmp/subtitles.srt', 12000);

    expect(useTimelineStore.getState().podcastRevision).toBe(initialRevision + 2);
    expect(useTimelineStore.getState().srtEntries).toEqual([
      { index: 1, startMs: 0, endMs: 1200, text: '新字幕' },
    ]);
  });

  it('stores imported assets and uses their durations for overlays', () => {
    const store = useTimelineStore.getState();
    store.addAsset('/tmp/intro.mp4', 'video', 9000);
    const overlayId = store.addOverlay({
      type: 'video',
      assetPath: '/tmp/intro.mp4',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 3000,
      durationMs: 9000,
      position: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    expect(useTimelineStore.getState().assets).toEqual([
      {
        path: '/tmp/intro.mp4',
        type: 'video',
        name: 'intro.mp4',
        durationMs: 9000,
      },
    ]);
    expect(overlayId).toBeTruthy();
    expect(useTimelineStore.getState().timeline.overlays[0]?.assetPath).toBe('/tmp/intro.mp4');
  });

  it('updates and removes overlays', () => {
    const store = useTimelineStore.getState();
    const newTrackId = store.addTrack();
    const overlayId = store.addOverlay({
      type: 'image',
      assetPath: '/tmp/cover.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 5000,
      position: { x: 10, y: 20, width: 300, height: 200 },
    });

    store.updateOverlay(overlayId, { startMs: 2000, durationMs: 7000, trackId: newTrackId });
    expect(useTimelineStore.getState().timeline.overlays[0]).toMatchObject({
      id: overlayId,
      startMs: 2000,
      durationMs: 7000,
      trackId: newTrackId,
    });

    store.removeOverlay(overlayId);
    expect(useTimelineStore.getState().timeline.overlays).toEqual([]);
  });

  it('copies an overlay into the timeline clipboard without changing the timeline', () => {
    const store = useTimelineStore.getState();
    const overlayId = store.addOverlay({
      type: 'image',
      assetPath: '/tmp/cover.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 5000,
      position: { x: 10, y: 20, width: 300, height: 200 },
    });

    expect(store.copyOverlay(overlayId)).toBe(true);
    expect(useTimelineStore.getState().timeline.overlays).toHaveLength(1);
    expect(useTimelineStore.getState().overlayClipboard).toMatchObject({
      mode: 'copy',
      assetPath: '/tmp/cover.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
    });
  });

  it('cuts an overlay into the timeline clipboard and removes the original item', () => {
    const store = useTimelineStore.getState();
    const overlayId = store.addOverlay({
      type: 'image',
      assetPath: '/tmp/cover.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 5000,
      position: { x: 10, y: 20, width: 300, height: 200 },
    });

    expect(store.cutOverlay(overlayId)).toBe(true);
    expect(useTimelineStore.getState().timeline.overlays).toEqual([]);
    expect(useTimelineStore.getState().overlayClipboard).toMatchObject({
      mode: 'cut',
      assetPath: '/tmp/cover.png',
      startMs: 0,
    });
  });

  it('pastes a copied overlay onto the requested track and time with a new id', () => {
    const store = useTimelineStore.getState();
    const overlayId = store.addOverlay({
      type: 'image',
      assetPath: '/tmp/cover.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 5000,
      position: { x: 10, y: 20, width: 300, height: 200 },
    });
    const targetTrackId = store.addTrack();

    store.copyOverlay(overlayId);
    const pastedOverlayId = store.pasteOverlay({
      trackId: targetTrackId,
      startMs: 9000,
    });

    expect(pastedOverlayId).toBeTruthy();
    expect(pastedOverlayId).not.toBe(overlayId);
    expect(useTimelineStore.getState().timeline.overlays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: pastedOverlayId,
          assetPath: '/tmp/cover.png',
          trackId: targetTrackId,
          startMs: 9000,
          durationMs: 5000,
        }),
      ]),
    );
    expect(useTimelineStore.getState().overlayClipboard?.mode).toBe('copy');
  });

  it('pastes a cut overlay once and then clears the clipboard', () => {
    const store = useTimelineStore.getState();
    const overlayId = store.addOverlay({
      type: 'image',
      assetPath: '/tmp/cover.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 5000,
      position: { x: 10, y: 20, width: 300, height: 200 },
    });

    store.cutOverlay(overlayId);
    const pastedOverlayId = store.pasteOverlay({
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 6500,
    });

    expect(pastedOverlayId).toBeTruthy();
    expect(useTimelineStore.getState().timeline.overlays).toEqual([
      expect.objectContaining({
        id: pastedOverlayId,
        trackId: DEFAULT_VISUAL_TRACK_ID,
        startMs: 6500,
      }),
    ]);
    expect(useTimelineStore.getState().overlayClipboard).toBeNull();
    expect(
      useTimelineStore.getState().pasteOverlay({
        trackId: DEFAULT_VISUAL_TRACK_ID,
        startMs: 12000,
      }),
    ).toBeNull();
  });

  it('copies an overlay into the timeline clipboard and pastes it onto the requested track', () => {
    const store = useTimelineStore.getState();
    const newTrackId = store.addTrack();
    const overlayId = store.addOverlay({
      type: 'image',
      assetPath: '/tmp/cover.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 5000,
      position: { x: 10, y: 20, width: 300, height: 200 },
    });

    expect(store.copyOverlay(overlayId)).toBe(true);
    expect(useTimelineStore.getState().overlayClipboard).toMatchObject({
      type: 'image',
      assetPath: '/tmp/cover.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 5000,
    });

    const pastedOverlayId = store.pasteOverlay({
      trackId: newTrackId,
      startMs: 2000,
    });

    expect(pastedOverlayId).toBeTruthy();
    expect(pastedOverlayId).not.toBe(overlayId);

    const pastedOverlay = useTimelineStore
      .getState()
      .timeline.overlays.find((overlay) => overlay.id === pastedOverlayId);

    expect(pastedOverlay).toMatchObject({
      type: 'image',
      assetPath: '/tmp/cover.png',
      trackId: newTrackId,
      startMs: 2000,
      durationMs: 5000,
      position: { x: 10, y: 20, width: 300, height: 200 },
    });
  });

  it('cuts an overlay into the timeline clipboard and pastes it back as a new overlay', () => {
    const store = useTimelineStore.getState();
    const overlayId = store.addOverlay({
      type: 'image',
      assetPath: '/tmp/cover.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 1000,
      durationMs: 5000,
      position: { x: 10, y: 20, width: 300, height: 200 },
    });

    expect(store.cutOverlay(overlayId)).toBe(true);
    expect(useTimelineStore.getState().timeline.overlays).toEqual([]);
    expect(useTimelineStore.getState().overlayClipboard).toMatchObject({
      type: 'image',
      assetPath: '/tmp/cover.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 1000,
      durationMs: 5000,
    });

    const pastedOverlayId = store.pasteOverlay({
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 3000,
    });

    expect(pastedOverlayId).toBeTruthy();
    expect(pastedOverlayId).not.toBe(overlayId);
    expect(useTimelineStore.getState().timeline.overlays).toHaveLength(1);
    expect(useTimelineStore.getState().timeline.overlays[0]).toMatchObject({
      id: pastedOverlayId,
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 3000,
      durationMs: 5000,
    });
  });

  it('falls back to a new visual track when pasting into an occupied slot', () => {
    const store = useTimelineStore.getState();
    const firstOverlayId = store.addOverlay({
      type: 'image',
      assetPath: '/tmp/cover.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 5000,
      position: { x: 10, y: 20, width: 300, height: 200 },
    });

    expect(store.copyOverlay(firstOverlayId)).toBe(true);

    const pastedOverlayId = store.pasteOverlay({
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
    });

    const pastedOverlay = useTimelineStore
      .getState()
      .timeline.overlays.find((overlay) => overlay.id === pastedOverlayId);

    // 粘贴链路保留"自动新建 visual 轨道"退路（不覆盖占位）
    expect(pastedOverlay?.trackId).not.toBe(DEFAULT_VISUAL_TRACK_ID);
    expect(pastedOverlay?.startMs).toBe(0);
    expect(pastedOverlay?.durationMs).toBe(5000);
  });

  it('removes dependent overlays when deleting an imported asset', () => {
    const store = useTimelineStore.getState();
    store.addAsset('/tmp/cover.png', 'image', 5000);
    store.addOverlay({
      type: 'image',
      assetPath: '/tmp/cover.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 5000,
      position: { x: 10, y: 20, width: 300, height: 200 },
    });

    store.removeAsset('/tmp/cover.png');

    expect(useTimelineStore.getState().timeline.overlays).toEqual([]);
    expect(useTimelineStore.getState().assets).toEqual([]);
  });

  it('undoes and redoes overlay edits', () => {
    const store = useTimelineStore.getState();
    const overlayId = store.addOverlay({
      type: 'image',
      assetPath: '/tmp/cover.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 5000,
      position: { x: 10, y: 20, width: 300, height: 200 },
    });

    store.updateOverlay(overlayId, { startMs: 2000, durationMs: 7000 });
    store.undo();

    expect(useTimelineStore.getState().timeline.overlays[0]).toMatchObject({
      id: overlayId,
      startMs: 0,
      durationMs: 5000,
    });
    expect(useTimelineStore.getState().canUndo).toBe(true);
    expect(useTimelineStore.getState().canRedo).toBe(true);

    store.redo();

    expect(useTimelineStore.getState().timeline.overlays[0]).toMatchObject({
      id: overlayId,
      startMs: 2000,
      durationMs: 7000,
    });
  });

  it('stores subtitle highlights and keeps them in undo history', () => {
    const store = useTimelineStore.getState();
    const highlight = {
      entryIndex: 1,
      start: 8,
      end: 12,
      highlightText: '世界冠军',
      sourceText: '中国品牌首次拿下世界冠军',
    };

    store.setSubtitleHighlights([highlight]);

    expect(useTimelineStore.getState().timeline.subtitleHighlights).toEqual([highlight]);

    store.undo();
    expect(useTimelineStore.getState().timeline.subtitleHighlights).toEqual([]);

    store.redo();
    expect(useTimelineStore.getState().timeline.subtitleHighlights).toEqual([highlight]);
  });

  it('clears subtitle highlights through a committed timeline update', () => {
    const store = useTimelineStore.getState();

    store.setSubtitleHighlights([
      {
        entryIndex: 1,
        start: 8,
        end: 12,
        highlightText: '世界冠军',
        sourceText: '中国品牌首次拿下世界冠军',
      },
    ]);

    store.clearSubtitleHighlights();

    expect(useTimelineStore.getState().timeline.subtitleHighlights).toEqual([]);
    expect(useTimelineStore.getState().canUndo).toBe(true);
  });

  it('updates subtitle style through a committed timeline update', () => {
    const store = useTimelineStore.getState();

    store.updateSubtitleStyle({
      highlightEnabled: true,
      highlightBackgroundColor: '#FFD400',
    });

    expect(useTimelineStore.getState().timeline.subtitle).toMatchObject({
      highlightEnabled: true,
      highlightBackgroundColor: '#FFD400',
      highlightAnimation: 'wipe',
    });
    expect(useTimelineStore.getState().canUndo).toBe(true);
  });

  it('migrates legacy timelines without tracks and backfills overlay track ids', () => {
    useTimelineStore.getState().setTimeline({
      version: 1,
      fps: 30,
      width: 1920,
      height: 1080,
      podcast: {
        audioPath: '/tmp/audio.mp3',
        srtPath: '/tmp/subtitles.srt',
        durationMs: 12000,
      },
      overlays: [
        {
          id: 'legacy-overlay',
          type: 'image',
          assetPath: '/tmp/cover.png',
          startMs: 0,
          durationMs: 5000,
          position: { x: 0, y: 0, width: 1920, height: 1080 },
        },
      ],
      subtitle: {
        fontSize: 48,
        color: '#FFFFFF',
        position: 'bottom',
      },
    } as never);

    const { assets, timeline } = useTimelineStore.getState();

    expect(timeline.version).toBe(2);
    expect(timeline.tracks.map((track) => track.id)).toEqual(['audio', 'subtitle', 'visual-1']);
    expect(timeline.overlays[0]?.trackId).toBe(DEFAULT_VISUAL_TRACK_ID);
    expect(timeline.subtitle).toEqual({
      ...createDefaultSubtitleStyle(),
      fontSize: 48,
      color: '#FFFFFF',
      position: 'bottom',
    });
    expect(timeline.subtitleHighlights).toEqual([]);
    expect(assets.map((asset) => asset.path)).toEqual([
      '/tmp/audio.mp3',
      '/tmp/subtitles.srt',
      '/tmp/cover.png',
    ]);
  });

  it('migrates legacy text overlay animation into overlay motion', () => {
    useTimelineStore.getState().setTimeline({
      version: 1,
      fps: 30,
      width: 1920,
      height: 1080,
      podcast: {
        audioPath: '',
        srtPath: '',
        durationMs: 12000,
      },
      tracks: [],
      overlays: [
        {
          id: 'legacy-text-overlay',
          type: 'text',
          assetPath: '',
          startMs: 1000,
          durationMs: 5000,
          position: { x: 100, y: 200, width: 800, height: 200 },
          textData: {
            content: '旧文字',
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
              enter: 'slideInLeft',
              enterDurationMs: 600,
              exit: 'fadeOut',
              exitDurationMs: 700,
              loop: 'flicker',
            },
          },
        },
      ],
      subtitle: {
        fontSize: 48,
        color: '#FFFFFF',
        position: 'bottom',
      },
    } as never);

    const overlay = useTimelineStore.getState().timeline.overlays[0];

    expect(overlay?.motion).toEqual({
      enter: 'slideInLeft',
      enterDurationMs: 600,
      exit: 'fadeOut',
      exitDurationMs: 700,
      loop: 'flicker',
    });
    expect(overlay?.textData?.content).toBe('旧文字');
    expect(overlay?.textData?.fontFamily).toBe('PingFang SC');
  });

  it('adds visual tracks and attaches overlays to the chosen track', () => {
    const store = useTimelineStore.getState();
    const newTrackId = store.addTrack();

    expect(useTimelineStore.getState().timeline.tracks.find((track) => track.id === newTrackId))
      .toMatchObject({
        id: newTrackId,
        kind: 'visual',
        order: 2,
      });

    const overlayId = store.addOverlay({
      type: 'video',
      assetPath: '/tmp/intro.mp4',
      trackId: newTrackId,
      startMs: 1000,
      durationMs: 4000,
      position: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    expect(useTimelineStore.getState().timeline.overlays.find((overlay) => overlay.id === overlayId))
      .toMatchObject({
        trackId: newTrackId,
      });
  });

  it('adds ai-card overlays without creating phantom media assets', () => {
    const store = useTimelineStore.getState();

    store.addAICardsToTimeline([
      {
        sourceCardId: 'ai-card-1',
        startMs: 2_000,
        durationMs: 5_000,
        aiCardData: {
          sourceCardId: 'ai-card-1',
          cardType: 'summary',
          title: '总结卡',
          content: '重点内容',
          template: 'summary-default',
          displayMode: 'fullscreen',
          style: {
            primaryColor: '#6366f1',
            backgroundColor: '#0f172a',
            fontSize: 48,
          },
        },
      },
    ]);

    expect(useTimelineStore.getState().timeline.overlays[0]).toMatchObject({
      overlayType: 'ai-card',
    });
    expect(useTimelineStore.getState().timeline.overlays[0]?.id).toMatch(/^ai-card-1-/);
    expect(useTimelineStore.getState().timeline.overlays[0]?.aiCardData?.sourceCardId).toBe(
      'ai-card-1',
    );
    expect(useTimelineStore.getState().assets).toEqual([]);
  });

  it('updates the existing overlay when applying the same ai card multiple times', () => {
    const store = useTimelineStore.getState();

    store.addAICardsToTimeline([
      {
        sourceCardId: 'ai-card-1',
        startMs: 2_000,
        durationMs: 5_000,
        aiCardData: {
          sourceCardId: 'ai-card-1',
          cardType: 'summary',
          title: '总结卡',
          content: '重点内容',
          template: 'summary-default',
          displayMode: 'fullscreen',
          style: {
            primaryColor: '#6366f1',
            backgroundColor: '#0f172a',
            fontSize: 48,
          },
        },
      },
    ]);
    store.addAICardsToTimeline([
      {
        sourceCardId: 'ai-card-1',
        startMs: 8_000,
        durationMs: 5_000,
        aiCardData: {
          sourceCardId: 'ai-card-1',
          cardType: 'summary',
          title: '总结卡',
          content: '重点内容',
          template: 'summary-default',
          displayMode: 'fullscreen',
          style: {
            primaryColor: '#6366f1',
            backgroundColor: '#0f172a',
            fontSize: 48,
          },
        },
      },
    ]);

    expect(useTimelineStore.getState().timeline.overlays).toHaveLength(1);
    expect(useTimelineStore.getState().timeline.overlays[0]).toMatchObject({
      startMs: 8_000,
      durationMs: 5_000,
      overlayType: 'ai-card',
    });
  });

  it('uses a smaller bottom-right layout when the ai card display mode is pip', () => {
    const store = useTimelineStore.getState();

    store.addAICardsToTimeline([
      {
        sourceCardId: 'ai-card-pip',
        startMs: 2_000,
        durationMs: 5_000,
        aiCardData: {
          sourceCardId: 'ai-card-pip',
          cardType: 'summary',
          title: '总结卡',
          content: '重点内容',
          template: 'summary-default',
          displayMode: 'pip',
          style: {
            primaryColor: '#6366f1',
            backgroundColor: '#0f172a',
            fontSize: 48,
          },
        },
      },
    ]);

    expect(useTimelineStore.getState().timeline.overlays[0]).toMatchObject({
      overlayType: 'ai-card',
      position: {
        x: 1224,
        y: 670,
        width: 653,
        height: 367,
      },
    });
  });

  it('reflows an existing ai card overlay when display mode changes to pip', () => {
    const store = useTimelineStore.getState();

    store.addAICardsToTimeline([
      {
        sourceCardId: 'ai-card-1',
        startMs: 2_000,
        durationMs: 5_000,
        aiCardData: {
          sourceCardId: 'ai-card-1',
          cardType: 'summary',
          title: '总结卡',
          content: '重点内容',
          template: 'summary-default',
          displayMode: 'fullscreen',
          style: {
            primaryColor: '#6366f1',
            backgroundColor: '#0f172a',
            fontSize: 48,
          },
        },
      },
    ]);
    store.addAICardsToTimeline([
      {
        sourceCardId: 'ai-card-1',
        startMs: 8_000,
        durationMs: 5_000,
        aiCardData: {
          sourceCardId: 'ai-card-1',
          cardType: 'summary',
          title: '总结卡',
          content: '重点内容',
          template: 'summary-default',
          displayMode: 'pip',
          style: {
            primaryColor: '#6366f1',
            backgroundColor: '#0f172a',
            fontSize: 48,
          },
        },
      },
    ]);

    expect(useTimelineStore.getState().timeline.overlays).toHaveLength(1);
    expect(useTimelineStore.getState().timeline.overlays[0]).toMatchObject({
      startMs: 8_000,
      durationMs: 5_000,
      position: {
        x: 1224,
        y: 670,
        width: 653,
        height: 367,
      },
    });
  });

  it('stores the selected cover as a full-duration default background', () => {
    const store = useTimelineStore.getState();
    store.setPodcast('/tmp/audio.mp3', '/tmp/subtitles.srt', 12_000);

    store.setGlobalBackground('/tmp/cover.png');

    expect(useTimelineStore.getState().timeline.overlays[0]).toMatchObject({
      type: 'image',
      assetPath: '/tmp/cover.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 12_000,
      overlayRole: 'default-background',
      position: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    expect(useTimelineStore.getState().assets.map((asset) => asset.path)).toContain('/tmp/cover.png');
  });

  it('reuses the existing default background overlay when changing covers', () => {
    const store = useTimelineStore.getState();
    store.setPodcast('/tmp/audio.mp3', '/tmp/subtitles.srt', 12_000);

    store.setGlobalBackground('/tmp/cover-a.png');
    const initialOverlayId = useTimelineStore.getState().timeline.overlays[0]?.id;

    store.setGlobalBackground('/tmp/cover-b.png');

    expect(useTimelineStore.getState().timeline.overlays).toHaveLength(1);
    expect(useTimelineStore.getState().timeline.overlays[0]).toMatchObject({
      id: initialOverlayId,
      assetPath: '/tmp/cover-b.png',
      durationMs: 12_000,
      overlayRole: 'default-background',
    });
  });

  it('adds a text overlay to the timeline', () => {
    const store = useTimelineStore.getState();
    const overlayId = store.addOverlay({
      type: 'text',
      assetPath: '',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 1000,
      durationMs: 5000,
      position: { x: 100, y: 200, width: 800, height: 200 },
      textData: {
        content: '测试',
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
          enterDurationMs: 500,
          exit: 'fadeOut',
          exitDurationMs: 500,
          loop: 'none',
        },
      },
    });

    expect(overlayId).toBeTruthy();
    const overlay = useTimelineStore.getState().timeline.overlays.find((o) => o.id === overlayId);
    expect(overlay?.type).toBe('text');
    expect(overlay?.textData?.content).toBe('测试');
  });

  it('does not add text overlays to asset list', () => {
    const store = useTimelineStore.getState();
    store.addOverlay({
      type: 'text',
      assetPath: '',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 5000,
      position: { x: 0, y: 0, width: 800, height: 200 },
      textData: {
        content: '测试',
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
          enter: 'none',
          enterDurationMs: 500,
          exit: 'none',
          exitDurationMs: 500,
          loop: 'none',
        },
      },
    });

    const assets = useTimelineStore.getState().assets;
    expect(assets.filter((a) => a.type === 'text')).toHaveLength(0);
  });

  it('keeps the default background stretched to the latest podcast duration', () => {
    const store = useTimelineStore.getState();
    store.setPodcast('/tmp/audio.mp3', '/tmp/subtitles.srt', 12_000);
    store.setGlobalBackground('/tmp/cover.png');

    store.setPodcast('/tmp/audio.mp3', '/tmp/subtitles.srt', 18_000);

    expect(useTimelineStore.getState().timeline.overlays[0]).toMatchObject({
      startMs: 0,
      durationMs: 18_000,
      overlayRole: 'default-background',
    });
  });

  it('falls back to a new visual track when addOverlay hits an occupied slot', () => {
    const store = useTimelineStore.getState();
    store.addOverlay({
      type: 'image',
      assetPath: '/tmp/a.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 5000,
      position: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    // 新增一个 overlay，起始时间与已有 overlay 重叠
    store.addOverlay({
      type: 'image',
      assetPath: '/tmp/b.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 2000,
      durationMs: 3000,
      position: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    const overlays = useTimelineStore.getState().timeline.overlays;
    expect(overlays).toHaveLength(2);

    // 第二个 overlay 不再被同轨 snap，而是落到新建 visual 轨道
    const first = overlays.find((o) => o.assetPath === '/tmp/a.png')!;
    const second = overlays.find((o) => o.assetPath === '/tmp/b.png')!;
    expect(first.trackId).toBe(DEFAULT_VISUAL_TRACK_ID);
    expect(second.trackId).not.toBe(DEFAULT_VISUAL_TRACK_ID);
    expect(second.startMs).toBe(2000);
  });

  it('creates a new visual track when addOverlay has no room on the target track', () => {
    const store = useTimelineStore.getState();

    // 先放一个 0-10000ms 的 overlay
    store.addOverlay({
      type: 'image',
      assetPath: '/tmp/a.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 10000,
      position: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    // 放第二个 20000-25000ms
    store.addOverlay({
      type: 'image',
      assetPath: '/tmp/b.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 20000,
      durationMs: 5000,
      position: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    // 在 5000ms 处放入一个 12000ms 的 overlay → 与第一个 overlay 碰撞
    // 新语义：不再同轨自动 snap，而是退到新建 visual 轨道，保留请求位置
    store.addOverlay({
      type: 'video',
      assetPath: '/tmp/c.mp4',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 5000,
      durationMs: 12000,
      position: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    const overlay = useTimelineStore.getState().timeline.overlays.find(
      (o) => o.assetPath === '/tmp/c.mp4',
    );
    expect(overlay?.startMs).toBe(5000);
    expect(overlay?.trackId).not.toBe(DEFAULT_VISUAL_TRACK_ID);
  });

  it('adjusts overlay position when moved to a conflicting slot via updateOverlay', () => {
    const store = useTimelineStore.getState();
    const id1 = store.addOverlay({
      type: 'image',
      assetPath: '/tmp/a.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 5000,
      position: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    const id2 = store.addOverlay({
      type: 'image',
      assetPath: '/tmp/b.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 10000,
      durationMs: 5000,
      position: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    // 尝试把第二个 overlay 移到与第一个重叠的位置 → 应被调整
    store.updateOverlay(id2, { startMs: 2000 });

    const overlay = useTimelineStore.getState().timeline.overlays.find((o) => o.id === id2);
    expect(overlay?.startMs).toBeGreaterThanOrEqual(5000);
  });

  it('clamps resize duration to the next overlay boundary', () => {
    const store = useTimelineStore.getState();
    const id1 = store.addOverlay({
      type: 'image',
      assetPath: '/tmp/a.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 5000,
      position: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    store.addOverlay({
      type: 'image',
      assetPath: '/tmp/b.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 8000,
      durationMs: 5000,
      position: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    // 尝试把第一个 overlay 拉伸到 15000ms → 应被 clamp 到 8000ms
    store.updateOverlay(id1, { durationMs: 15000 });

    const overlay = useTimelineStore.getState().timeline.overlays.find((o) => o.id === id1);
    expect(overlay?.durationMs).toBe(8000);
  });

  it('keeps default background out of managed collision rules, but ai-cards now participate', () => {
    const store = useTimelineStore.getState();
    store.setPodcast('/tmp/audio.mp3', '/tmp/subtitles.srt', 60_000);
    store.setGlobalBackground('/tmp/bg.png');

    // 在默认背景占据的同一轨道同一时间段添加普通 overlay → 不应被碰撞规则阻止
    const overlayId = store.addOverlay({
      type: 'image',
      assetPath: '/tmp/cover.png',
      trackId: DEFAULT_VISUAL_TRACK_ID,
      startMs: 0,
      durationMs: 5000,
      position: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    const state = useTimelineStore.getState();
    const overlay = state.timeline.overlays.find((o) => o.id === overlayId);
    // 普通 overlay 应该放在原始位置，不被默认背景影响
    expect(overlay?.startMs).toBe(0);
    expect(overlay?.trackId).toBe(DEFAULT_VISUAL_TRACK_ID);

    // AI 卡片现在参与碰撞检测（Task 1：isOverlayTrackManaged 只排除 default-background）
    store.addAICardsToTimeline([{
      sourceCardId: 'ai-card-test',
      startMs: 0,
      durationMs: 5000,
      aiCardData: {
        sourceCardId: 'ai-card-test',
        cardType: 'summary',
        title: '测试',
        content: '内容',
        template: 'summary-default',
        displayMode: 'fullscreen',
        style: { primaryColor: '#000', backgroundColor: '#fff', fontSize: 48 },
      },
    }]);

    // 在 AI 卡片同时间段同一轨道添加普通 overlay → 由于 AI 卡片参与碰撞，
    // 新语义：落到新建 visual 轨道（paste/addOverlay 链路的退路）
    const id2 = store.addOverlay({
      type: 'text',
      assetPath: '',
      trackId: DEFAULT_AI_CARDS_TRACK_ID,
      startMs: 0,
      durationMs: 3000,
      position: { x: 100, y: 200, width: 800, height: 200 },
      textData: {
        content: '文字',
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
          enter: 'none',
          enterDurationMs: 500,
          exit: 'none',
          exitDurationMs: 500,
          loop: 'none',
        },
      },
    });

    // 文字 overlay 与 AI 卡片冲突 → 落到新建 visual 轨道
    const textOverlay = useTimelineStore.getState().timeline.overlays.find((o) => o.id === id2);
    expect(textOverlay?.startMs).toBe(0);
    expect(textOverlay?.trackId).not.toBe(DEFAULT_AI_CARDS_TRACK_ID);
  });
});
