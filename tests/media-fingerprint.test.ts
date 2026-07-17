import { describe, expect, it } from 'vitest';
import { computeVideoFrameDHashes } from '../src/lib/media-fingerprint';

describe('computeVideoFrameDHashes', () => {
  it('为每个 9x8 灰度帧生成稳定的 64-bit dHash', () => {
    const rising = Uint8Array.from({ length: 72 }, (_, index) => index % 9);
    const falling = Uint8Array.from({ length: 72 }, (_, index) => 8 - (index % 9));
    const hashes = computeVideoFrameDHashes(new Uint8Array([...rising, ...falling]));
    expect(hashes).toEqual(['0000000000000000', 'ffffffffffffffff']);
  });

  it('忽略亮度整体平移，保留画面结构指纹', () => {
    const first = Uint8Array.from({ length: 72 }, (_, index) => (index % 9) * 8);
    const shifted = Uint8Array.from(first, (value) => value + 20);
    expect(computeVideoFrameDHashes(first)).toEqual(computeVideoFrameDHashes(shifted));
  });
});
