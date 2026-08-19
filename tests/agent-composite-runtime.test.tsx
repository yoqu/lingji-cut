import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverlayItem } from '../src/types';
import type { CardAssetBinding } from '../src/types/assets';

const remotionState = vi.hoisted(() => ({ isRendering: true }));

vi.mock('remotion', async () => {
  const ReactModule = await import('react');
  const createElement = ReactModule.createElement;
  const identity = (value: number) => value;
  return {
    AbsoluteFill: ({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) =>
      createElement('div', { 'data-remotion': 'absolute-fill', style }, children),
    Img: ({ src, className, style, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) =>
      createElement('img', { ...props, src, className, style, 'data-remotion': 'img' }),
    OffthreadVideo: ({
      src,
      className,
      style,
      muted,
      trimBefore,
      trimAfter,
      volume: _volume,
      loop: _loop,
      playbackRate: _playbackRate,
      ...props
    }: Record<string, unknown>) => createElement('video', {
      ...props,
      className,
      style,
      muted,
      'data-src': src,
      'data-trim-before': trimBefore,
      'data-trim-after': trimAfter,
      'data-remotion': 'offthread-video',
    }),
    Video: ({
      src,
      trimBefore,
      trimAfter,
      volume: _volume,
      loop: _loop,
      playbackRate: _playbackRate,
      ...props
    }: Record<string, unknown>) => createElement('video', {
      ...props,
      'data-src': src,
      'data-trim-before': trimBefore,
      'data-trim-after': trimAfter,
      'data-remotion': 'video',
    }),
    staticFile: (src: string) => `/public/${src}`,
    getRemotionEnvironment: () => ({ isRendering: remotionState.isRendering }),
    useCurrentFrame: () => 0,
    useVideoConfig: () => ({ width: 1920, height: 1080, fps: 30, durationInFrames: 150 }),
    interpolate: () => 0,
    spring: () => 0,
    Easing: {
      in: (fn: (value: number) => number) => fn,
      out: (fn: (value: number) => number) => fn,
      inOut: (fn: (value: number) => number) => fn,
      quad: identity,
      cubic: identity,
      sin: identity,
      back: () => identity,
      poly: () => identity,
    },
  };
});

import { AICardOverlay } from '../src/remotion/overlays/AICardOverlay';

const treatment: CardAssetBinding['treatment'] = {
  profile: 'editorial-realist-cutout',
  lighting: 'soft-left',
  palette: 'low-saturation',
  shadow: 'soft-ground',
  perspective: 'front-3q',
};

function mediaBinding(overrides: Partial<CardAssetBinding> = {}): CardAssetBinding {
  return {
    slot: 'primary',
    assetId: 'asset-primary',
    filePath: '/tmp/agent-media.jpg',
    kind: 'image',
    required: true,
    lockedByUser: true,
    treatment,
    placement: { x: 120, y: 80, width: 820, height: 620, depth: 'foreground' },
    ...overrides,
  };
}

function overlay(binding: CardAssetBinding, agentComposite = true): OverlayItem {
  return {
    id: 'overlay-agent-composite',
    type: 'image',
    assetPath: '',
    trackId: 'visual-2',
    startMs: 0,
    durationMs: 5_000,
    position: { x: 0, y: 0, width: 1920, height: 1080 },
    overlayType: 'ai-card',
    aiCardData: {
      cardType: 'motion',
      title: 'Agent composite',
      content: '',
      template: 'motion-default',
      displayMode: 'fullscreen',
      style: { primaryColor: '#fff', backgroundColor: '#000', fontSize: 48 },
      renderMode: 'motion-card',
      renderStrategy: agentComposite ? 'agent-composite' : 'motion-card',
      assetBindings: [binding],
      motionCard: { tsx: 'export default () => <div>card</div>;' } as never,
    },
  };
}

const IMAGE_COMPILED_JS = `
  const React = require('react');
  module.exports.default = function CompositeCard(props) {
    return React.createElement(
      'main',
      {'data-media-kind': props.mediaAssets[0].kind, 'data-media-count': props.mediaAssets.length},
      React.createElement(props.BoundMedia, {slot: 'primary', fit: 'contain'})
    );
  };
`;

const VIDEO_COMPILED_JS = `
  const React = require('react');
  module.exports.default = function CompositeCard(props) {
    const media = props.mediaAssets[0];
    return React.createElement(
      'main',
      {'data-media-kind': media.kind, 'data-required': String(media.required), 'data-locked': String(media.lockedByUser)},
      React.createElement(props.BoundMedia, {assetId: media.assetId})
    );
  };
`;

describe('Agent composite media runtime', () => {
  afterEach(() => {
    remotionState.isRendering = true;
  });

  it('injects an image through mediaAssets and does not duplicate the legacy asset layer', () => {
    const html = renderToStaticMarkup(
      <AICardOverlay
        overlay={overlay(mediaBinding())}
        zIndex={2}
        compiledJs={IMAGE_COMPILED_JS}
        durationFrames={150}
      />,
    );

    expect(html).toContain('data-media-kind="image"');
    expect(html).toContain('data-media-count="1"');
    expect(html).toContain('src="file:///tmp/agent-media.jpg"');
    expect(html).toContain('object-fit:contain');
    expect(html.match(/data-remotion="img"/g)).toHaveLength(1);
    expect(html).toContain('data-agent-media-required="true"');
    expect(html).toContain('data-agent-media-locked="true"');
  });

  it('renders real video frames through OffthreadVideo with trim metadata and muted audio', () => {
    const html = renderToStaticMarkup(
      <AICardOverlay
        overlay={overlay(mediaBinding({
          filePath: 'assets/selected-clip.mp4',
          kind: 'video',
          trimStartMs: 1_250,
          durationMs: 8_000,
          metadata: { width: 1920, height: 1080, durationMs: 8_000, mimeHint: 'video/mp4' },
        }))}
        zIndex={2}
        compiledJs={VIDEO_COMPILED_JS}
        durationFrames={150}
      />,
    );

    expect(html).toContain('data-media-kind="video"');
    expect(html).toContain('data-required="true"');
    expect(html).toContain('data-locked="true"');
    expect(html).toContain('data-remotion="offthread-video"');
    expect(html).toContain('data-src="/public/assets/selected-clip.mp4"');
    expect(html).toContain('data-trim-before="38"');
    expect(html).toContain('data-trim-after="240"');
    expect(html).toContain('muted=""');
  });

  it('uses the preview Video implementation with the same bound source and trim contract', () => {
    remotionState.isRendering = false;
    const html = renderToStaticMarkup(
      <AICardOverlay
        overlay={overlay(mediaBinding({
          filePath: '/tmp/preview-clip.mp4',
          kind: 'video',
          trimStartMs: 500,
          durationMs: 4_000,
        }))}
        zIndex={2}
        compiledJs={VIDEO_COMPILED_JS}
        durationFrames={150}
      />,
    );

    expect(html).toContain('data-remotion="video"');
    expect(html).toContain('data-src="file:///tmp/preview-clip.mp4"');
    expect(html).toContain('data-agent-media-slot="primary"');
  });

  it('keeps ordinary motion cards on the legacy external image layer', () => {
    const html = renderToStaticMarkup(
      <AICardOverlay
        overlay={overlay(mediaBinding(), false)}
        zIndex={2}
        compiledJs={`const React = require('react'); module.exports.default = () => React.createElement('main', {'data-legacy-card': 'true'});`}
        durationFrames={150}
      />,
    );

    expect(html).toContain('data-legacy-card="true"');
    expect(html.match(/data-remotion="img"/g)).toHaveLength(1);
    expect(html).not.toContain('data-agent-media-slot');
  });
});
