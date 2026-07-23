import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false,
  },
}));

import * as renderVideoModule from '../electron/remotion/render-video-headless';

describe('resolveExportConcurrency', () => {
  it('caps the automatic concurrency at four browser pages', () => {
    const resolveExportConcurrency = (
      renderVideoModule as typeof renderVideoModule & {
        resolveExportConcurrency?: (cpuCount: number, envValue?: string) => number;
      }
    ).resolveExportConcurrency;

    expect(resolveExportConcurrency).toBeTypeOf('function');
    expect(resolveExportConcurrency?.(28)).toBe(4);
    expect(resolveExportConcurrency?.(4)).toBe(2);
    expect(resolveExportConcurrency?.(1)).toBe(1);
  });

  it('keeps a positive explicit override for controlled diagnostics', () => {
    const resolveExportConcurrency = (
      renderVideoModule as typeof renderVideoModule & {
        resolveExportConcurrency?: (cpuCount: number, envValue?: string) => number;
      }
    ).resolveExportConcurrency;

    expect(resolveExportConcurrency).toBeTypeOf('function');
    expect(resolveExportConcurrency?.(28, '6')).toBe(6);
    expect(resolveExportConcurrency?.(28, '0')).toBe(4);
    expect(resolveExportConcurrency?.(28, 'invalid')).toBe(4);
  });
});
