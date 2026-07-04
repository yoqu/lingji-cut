import { describe, expect, it } from 'vitest';
import { buildExportRenderConfig } from '../src/lib/export-settings';

describe('buildExportRenderConfig', () => {
  it('downscales 1080p timelines to 720p for faster export', () => {
    expect(
      buildExportRenderConfig({
        timelineWidth: 1920,
        timelineHeight: 1080,
        resolution: '720p',
        quality: 'speed',
      }),
    ).toMatchObject({
      renderWidth: 1280,
      renderHeight: 720,
      x264Preset: 'ultrafast',
      videoBitrate: '1800k',
      audioBitrate: '96k',
      jpegQuality: 70,
    });
  });

  it('keeps source resolution for standard quality exports', () => {
    expect(
      buildExportRenderConfig({
        timelineWidth: 1080,
        timelineHeight: 1920,
        resolution: 'source',
        quality: 'quality',
      }),
    ).toMatchObject({
      renderWidth: 1080,
      renderHeight: 1920,
      x264Preset: 'medium',
      videoBitrate: '8000k',
      audioBitrate: '192k',
      jpegQuality: 90,
    });
  });
});
