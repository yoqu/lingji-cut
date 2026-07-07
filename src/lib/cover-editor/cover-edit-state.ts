import type { CoverEditState } from './contracts';

export function createEmptyEditState(): CoverEditState {
  return {
    version: 1,
    aspectRatio: 'timeline',
    textOverlays: [],
    filters: { preset: 'none' },
    transform: {},
  };
}

export function normalizeEditState(state: CoverEditState | undefined): CoverEditState {
  const base = state ?? createEmptyEditState();
  return {
    version: 1,
    aspectRatio: base.aspectRatio ?? 'timeline',
    crop: base.crop,
    textOverlays: base.textOverlays ?? [],
    filters: {
      brightness: base.filters?.brightness ?? 0,
      contrast: base.filters?.contrast ?? 0,
      saturation: base.filters?.saturation ?? 0,
      temperature: base.filters?.temperature ?? 0,
      preset: base.filters?.preset ?? 'none',
    },
    transform: base.transform ?? {},
  };
}
