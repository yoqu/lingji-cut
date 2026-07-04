import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPersistedScriptState,
  isSavingFile,
  saveAllDirtyFiles,
} from '../src/lib/script-persistence';

describe('script persistence helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      electronAPI: {
        saveScriptFile: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('saves only dirty files during save all', async () => {
    const getText = vi.fn((file: string) => `content:${file}`);

    await saveAllDirtyFiles(
      '/tmp/script-project',
      {
        'original.md': true,
        'script.md': false,
        'notes.md': true,
      },
      getText,
    );

    expect(getText).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.saveScriptFile).toHaveBeenNthCalledWith(
      1,
      '/tmp/script-project',
      'original.md',
      'content:original.md',
    );
    expect(window.electronAPI.saveScriptFile).toHaveBeenNthCalledWith(
      2,
      '/tmp/script-project',
      'notes.md',
      'content:notes.md',
    );
  });

  it('marks files as saving until the ignore window elapses', async () => {
    await saveAllDirtyFiles(
      '/tmp/script-project',
      { 'original.md': true },
      () => '# hello',
    );

    expect(isSavingFile('original.md')).toBe(true);

    await vi.advanceTimersByTimeAsync(500);

    expect(isSavingFile('original.md')).toBe(false);
  });
});

describe('fileTreeView persistence', () => {
  it('defaults to "resources" when option not provided', () => {
    const state = createPersistedScriptState('idle', 0, 'news-broadcast', []);
    expect(state.fileTreeView).toBe('resources');
  });

  it('persists explicit fileTreeView option', () => {
    const state = createPersistedScriptState('idle', 0, 'news-broadcast', [], {
      fileTreeView: 'resources',
    });
    expect(state.fileTreeView).toBe('resources');
  });
});
