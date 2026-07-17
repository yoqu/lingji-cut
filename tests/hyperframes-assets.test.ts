import { describe, expect, it } from 'vitest';
import { DEFAULT_VISUAL_TRACK_ID, createDefaultTimeline } from '../src/types';
import { prepareTimelineForHyperframes } from '../src/hyperframes/assets';

describe('prepareTimelineForHyperframes', () => {
  it('rewrites local filesystem media paths into public asset paths', () => {
    const timeline = createDefaultTimeline();
    timeline.podcast.audioPath = '/tmp/audio.mp3';
    timeline.overlays = [
      {
        id: 'overlay-1',
        type: 'image',
        assetPath: '/tmp/cover.png',
        trackId: DEFAULT_VISUAL_TRACK_ID,
        startMs: 0,
        durationMs: 5_000,
        position: { x: 0, y: 0, width: 1920, height: 1080 },
      },
      {
        id: 'overlay-2',
        type: 'video',
        assetPath: 'https://example.com/remote.mp4',
        trackId: DEFAULT_VISUAL_TRACK_ID,
        startMs: 2_000,
        durationMs: 8_000,
        position: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ];

    const result = prepareTimelineForHyperframes(timeline);

    expect(result.timeline.podcast.audioPath).toBe('assets/podcast-audio.mp3');
    expect(result.timeline.overlays[0]?.assetPath).toBe('assets/overlay-1.png');
    expect(result.timeline.overlays[1]?.assetPath).toBe('https://example.com/remote.mp4');
    expect(result.assets).toEqual([
      {
        sourcePath: '/tmp/audio.mp3',
        publicPath: 'assets/podcast-audio.mp3',
      },
      {
        sourcePath: '/tmp/cover.png',
        publicPath: 'assets/overlay-1.png',
      },
    ]);
  });

  it('hydrates relative AI card media paths from the project directory before staging', () => {
    const timeline = createDefaultTimeline();
    timeline.overlays = [
      {
        id: 'ov1',
        type: 'image',
        overlayType: 'ai-card',
        assetPath: '',
        trackId: DEFAULT_VISUAL_TRACK_ID,
        startMs: 0,
        durationMs: 5_000,
        position: { x: 0, y: 0, width: 1920, height: 1080 },
        aiCardData: {
          sourceCardId: 'c1',
          cardType: 'image',
          title: 't',
          content: {
            mediaType: 'image',
            assetPath: 'ai-cards/c1/image.png',
            aspectRatio: '16:9',
            prompt: '',
            providerId: 'p',
            model: 'm',
            generationStatus: 'ready',
          },
          template: 'image-default',
          displayMode: 'fullscreen',
          style: { primaryColor: '#fff', backgroundColor: '#000', fontSize: 48 },
        },
      },
    ];

    const { timeline: out, assets } = prepareTimelineForHyperframes(timeline, '/abs/projectDir');
    expect(assets.some((a) => a.sourcePath === '/abs/projectDir/ai-cards/c1/image.png')).toBe(true);
    const media = out.overlays[0]?.aiCardData?.content;
    expect(typeof media === 'object' && media && 'assetPath' in media ? media.assetPath : null).toBe(
      'assets/ov1-media.png',
    );
  });

  it('stages motion card asset bindings and rewrites them to public paths', () => {
    const timeline = createDefaultTimeline();
    timeline.overlays = [
      {
        id: 'motion-1',
        type: 'image',
        overlayType: 'ai-card',
        assetPath: '',
        trackId: DEFAULT_VISUAL_TRACK_ID,
        startMs: 0,
        durationMs: 5_000,
        position: { x: 0, y: 0, width: 1920, height: 1080 },
        aiCardData: {
          sourceCardId: 'card-1',
          cardType: 'motion',
          title: 'Motion',
          content: '',
          template: 'motion-default',
          displayMode: 'fullscreen',
          style: { primaryColor: '#fff', backgroundColor: '#000', fontSize: 48 },
          assetBindings: [
            {
              slot: 'main-prop',
              assetId: 'asset-1',
              filePath: 'assets/generated/prop-cutout.png',
              treatment: {
                profile: 'editorial-realist-cutout',
                lighting: 'soft-left',
                palette: 'low-saturation',
                shadow: 'soft-ground',
                perspective: 'front-3q',
              },
              placement: { x: 100, y: 200, width: 400, depth: 'foreground' },
            },
          ],
        },
      },
    ];

    const { timeline: out, assets } = prepareTimelineForHyperframes(timeline, '/abs/project');
    const binding = out.overlays[0]?.aiCardData?.assetBindings?.[0];

    expect(binding?.filePath).toBe('assets/motion-1-asset-main-prop-asset-1.png');
    expect(assets).toContainEqual({
      sourcePath: '/abs/project/assets/generated/prop-cutout.png',
      publicPath: 'assets/motion-1-asset-main-prop-asset-1.png',
    });
  });
});
