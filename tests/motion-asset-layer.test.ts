import { describe, expect, it } from 'vitest';
import { isMotionAssetUnderlay, motionAssetSignature, motionAssetStyle } from '../src/lib/motion-asset-layer';
import { DEFAULT_ASSET_TREATMENT, type CardAssetBinding } from '../src/types/assets';

function binding(overrides: Partial<CardAssetBinding> = {}): CardAssetBinding {
  return {
    slot: 'hero',
    assetId: 'asset-1',
    filePath: '/tmp/hero.png',
    treatment: DEFAULT_ASSET_TREATMENT,
    placement: {
      x: 100,
      y: 200,
      width: 500,
      referenceWidth: 1920,
      referenceHeight: 1080,
      depth: 'foreground',
    },
    motion: { enter: 'fade-up-soft', exit: 'fade-out', revealBeat: 2 },
    ...overrides,
  };
}

describe('motion asset layer', () => {
  it('按实际画布缩放 placement，并在 reveal beat 前隐藏', () => {
    const item = binding();
    const context = {
      width: 960,
      height: 540,
      durationInFrames: 150,
      timingPlan: {
        fps: 30,
        cues: [],
        pauses: [],
        accents: [],
        beats: [{ storyboardBeatIndex: 2, role: 'reveal' as const, startFrame: 45, landFrame: 60 }],
      },
    };
    const hidden = motionAssetStyle(item, 30, context);
    const visible = motionAssetStyle(item, 63, context);

    expect(hidden.left).toBe(50);
    expect(hidden.top).toBe(100);
    expect(hidden.width).toBe(250);
    expect(hidden.opacity).toBe(0);
    expect(visible.opacity).toBeGreaterThan(0.9);
  });

  it('区分 underlay/foreground，并兑现 fade-out', () => {
    const foreground = binding();
    const background = binding({ placement: { ...binding().placement, depth: 'background' } });
    expect(isMotionAssetUnderlay(background)).toBe(true);
    expect(isMotionAssetUnderlay(foreground)).toBe(false);
    expect(motionAssetStyle(foreground, 149, {
      width: 1920,
      height: 1080,
      durationInFrames: 150,
    }).opacity).toBeLessThan(0.1);
  });

  it('冻结文件指纹变化会让素材签名失效', () => {
    const original = motionAssetSignature([binding({ fileFingerprint: 'stat:100:1' })]);
    const replaced = motionAssetSignature([binding({ fileFingerprint: 'stat:220:2' })]);

    expect(replaced).not.toBe(original);
  });
});
