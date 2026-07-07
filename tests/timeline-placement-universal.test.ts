import { describe, it, expect } from 'vitest';
import {
  isOverlayTrackManaged,
  canPlaceAt,
  overlaysOverlap,
} from '../src/lib/timeline-placement';
import type { OverlayItem } from '../src/types';

function makeOverlay(partial: Partial<OverlayItem>): OverlayItem {
  return {
    id: 'o1',
    type: 'image',
    assetPath: '',
    trackId: 'visual-1',
    startMs: 0,
    durationMs: 1000,
    position: { x: 0, y: 0, width: 100, height: 100 },
    ...partial,
  } as OverlayItem;
}

describe('isOverlayTrackManaged (universal)', () => {
  it('treats ai-card as managed', () => {
    const overlay = makeOverlay({ overlayType: 'ai-card' });
    expect(isOverlayTrackManaged(overlay)).toBe(true);
  });

  it('excludes default-background', () => {
    const overlay = makeOverlay({ overlayRole: 'default-background' });
    expect(isOverlayTrackManaged(overlay)).toBe(false);
  });

  it('treats text overlay as managed', () => {
    const overlay = makeOverlay({ type: 'text' });
    expect(isOverlayTrackManaged(overlay)).toBe(true);
  });
});

describe('canPlaceAt', () => {
  const existing: OverlayItem[] = [
    makeOverlay({ id: 'a', trackId: 'visual-1', startMs: 1000, durationMs: 2000 }),
    makeOverlay({ id: 'b', trackId: 'visual-1', startMs: 5000, durationMs: 1000, overlayType: 'ai-card' }),
  ];

  it('returns ok=true when slot is empty', () => {
    const result = canPlaceAt({
      trackId: 'visual-1',
      startMs: 3500,
      durationMs: 1000,
      overlays: existing,
    });
    expect(result.ok).toBe(true);
  });

  it('returns ok=false with reason=overlap when colliding with ai-card', () => {
    const result = canPlaceAt({
      trackId: 'visual-1',
      startMs: 5500,
      durationMs: 500,
      overlays: existing,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('overlap');
  });

  it('respects excludeOverlayId', () => {
    const result = canPlaceAt({
      trackId: 'visual-1',
      startMs: 1000,
      durationMs: 2000,
      excludeOverlayId: 'a',
      overlays: existing,
    });
    expect(result.ok).toBe(true);
  });
});

describe('overlaysOverlap (sanity)', () => {
  it('is accessible via the module', () => {
    expect(typeof overlaysOverlap).toBe('function');
  });
});
