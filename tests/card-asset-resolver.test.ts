import { describe, expect, it } from 'vitest';
import {
  makeCardAssetResolver,
  resolveAgentMediaAssets,
} from '../src/remotion/card-asset';
import type { CardAssetBinding } from '../src/types/assets';

const deps = {
  staticFile: (rel: string) => `STATIC:${rel}`,
  toFileSrc: (abs: string) => `FILE:${abs}`,
};

describe('makeCardAssetResolver', () => {
  it('uses staticFile when rendering (export)', () => {
    const cardAsset = makeCardAssetResolver({ isRendering: true, projectDir: '/p', ...deps });
    expect(cardAsset('assets/x.png')).toBe('STATIC:assets/x.png');
    expect(cardAsset('./assets/x.png')).toBe('STATIC:assets/x.png');
  });

  it('uses file:// under project dir when previewing', () => {
    const cardAsset = makeCardAssetResolver({
      isRendering: false,
      projectDir: '/Users/me/proj/',
      ...deps,
    });
    expect(cardAsset('assets/x.png')).toBe('FILE:/Users/me/proj/assets/x.png');
  });

  it('falls back to staticFile in preview when no project dir', () => {
    const cardAsset = makeCardAssetResolver({ isRendering: false, projectDir: null, ...deps });
    expect(cardAsset('assets/x.png')).toBe('STATIC:assets/x.png');
  });

  it('passes through absolute/remote/data sources untouched', () => {
    const cardAsset = makeCardAssetResolver({ isRendering: false, projectDir: '/p', ...deps });
    expect(cardAsset('https://e.com/a.png')).toBe('https://e.com/a.png');
    expect(cardAsset('data:image/png;base64,abc')).toBe('data:image/png;base64,abc');
    expect(cardAsset('file:///x.png')).toBe('file:///x.png');
  });
});

const treatment: CardAssetBinding['treatment'] = {
  profile: 'editorial-realist-cutout',
  lighting: 'soft-left',
  palette: 'low-saturation',
  shadow: 'soft-ground',
  perspective: 'front-3q',
};

function binding(overrides: Partial<CardAssetBinding>): CardAssetBinding {
  return {
    slot: 'primary',
    assetId: 'asset-1',
    filePath: 'assets/photo.jpg',
    treatment,
    placement: { x: 0, y: 0, width: 1920, height: 1080 },
    ...overrides,
  };
}

describe('resolveAgentMediaAssets', () => {
  it('exposes an image as a resolved runtime prop without legacy placement data', () => {
    const [asset] = resolveAgentMediaAssets([
      binding({
        kind: 'image',
        usage: 'required',
        lockedByUser: true,
        metadata: { width: 1600, height: 900, mimeHint: 'image/jpeg' },
      }),
    ], (src) => `resolved:${src}`);

    expect(asset).toEqual({
      slot: 'primary',
      assetId: 'asset-1',
      kind: 'image',
      src: 'resolved:assets/photo.jpg',
      trimStartMs: 0,
      durationMs: undefined,
      metadata: { width: 1600, height: 900, mimeHint: 'image/jpeg' },
      usage: 'required',
      required: true,
      lockedByUser: true,
    });
    expect(asset).not.toHaveProperty('filePath');
    expect(asset).not.toHaveProperty('placement');
  });

  it('infers video bindings and preserves trim, duration and media metadata', () => {
    const [asset] = resolveAgentMediaAssets([
      binding({
        filePath: 'assets/clip.MP4?revision=2',
        trimStartMs: 1_250,
        required: false,
        metadata: {
          width: 3840,
          height: 2160,
          durationMs: 12_000,
          video: { fps: 30, hasAudio: true },
        },
      }),
    ], (src) => `resolved:${src}`);

    expect(asset).toMatchObject({
      kind: 'video',
      src: 'resolved:assets/clip.MP4?revision=2',
      trimStartMs: 1_250,
      durationMs: 12_000,
      usage: 'optional',
      required: false,
      lockedByUser: false,
    });
  });
});
