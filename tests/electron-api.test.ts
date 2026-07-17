import { describe, expect, it } from 'vitest';
import { MENU_ACTIONS, isProjectRequiredCommand } from '../src/lib/electron-api';
import { readFileSync } from 'node:fs';

describe('electron menu actions', () => {
  it('defines the shared command list used by toolbar and native menu', () => {
    expect(MENU_ACTIONS).toEqual([
      'new-project',
      'open-project',
      'open-settings',
      'close-project',
      'show-project-in-folder',
      'undo',
      'redo',
      'replace-audio',
      'replace-srt',
      'add-asset',
      'export',
      'save-script',
      'go-back',
      'find',
      'find-replace',
    ]);
  });

  it('marks commands that require an active project', () => {
    expect(isProjectRequiredCommand('new-project')).toBe(false);
    expect(isProjectRequiredCommand('open-project')).toBe(false);
    expect(isProjectRequiredCommand('open-settings')).toBe(false);
    expect(isProjectRequiredCommand('undo')).toBe(true);
    expect(isProjectRequiredCommand('replace-srt')).toBe(true);
    expect(isProjectRequiredCommand('export')).toBe(true);
  });

  it('declares video import APIs for the script workbench bridge', () => {
    const source = readFileSync(
      new URL('../src/lib/electron-api.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('importVideoSource');
    expect(source).toContain('getVideoImportStatus');
  });

  it('exposes main-process reusable media search for file-health filtering', () => {
    const api = readFileSync(new URL('../src/lib/electron-api.ts', import.meta.url), 'utf8');
    const preload = readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../electron/asset-library.ts', import.meta.url), 'utf8');
    expect(api).toContain('searchReusableMediaAssets');
    expect(preload).toContain("ipcRenderer.invoke('asset-library:search-reusable'");
    expect(main).toContain('normalizeResolvableAssetLibrary(library)');
  });

  it('no longer exposes the deprecated html-card import bridge', () => {
    const source = readFileSync(
      new URL('../src/lib/electron-api.ts', import.meta.url),
      'utf8',
    );

    // Web Card 路径下线后 selectHtmlFile 已从 Preload 桥移除
    expect(source).not.toContain('selectHtmlFile');
  });
});
