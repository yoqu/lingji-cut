import { describe, it, expect } from 'vitest';
import {
  createEmptyEditState,
  normalizeEditState,
} from '../src/lib/cover-editor/cover-edit-state';

describe('cover-edit-state', () => {
  it('createEmptyEditState 返回 version 1', () => {
    expect(createEmptyEditState().version).toBe(1);
  });

  it('normalizeEditState 兜住缺失字段', () => {
    const normalized = normalizeEditState({ version: 1 });
    expect(normalized.textOverlays).toEqual([]);
    expect(normalized.filters?.preset).toBe('none');
  });
});
