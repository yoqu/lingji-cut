import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('control video import tools', () => {
  it('registers video import tools near the script workflow tools', () => {
    const source = readFileSync(
      new URL('../electron/control/tools.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('lingji_import_video_source');
    expect(source).toContain('lingji_start_video_import');
    expect(source).toContain('lingji_get_video_import_status');
  });
});
