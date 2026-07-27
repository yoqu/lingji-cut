import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineData } from '../src/types';

const renderer = vi.hoisted(() => ({
  renderMedia: vi.fn(),
  selectComposition: vi.fn(),
  combineChunks: vi.fn(),
}));

vi.mock('@remotion/renderer', () => renderer);

import {
  combineRemotionChunks,
  renderRemotionChunk,
} from '../electron/remotion/render';
import {
  renderChunkedVideo,
  renderChunkWithFallback,
  resolveFramesPerChunk,
  resolveChunkExecutionConfig,
  runChunkPool,
} from '../electron/remotion/chunk-renderer';

function timeline(): TimelineData {
  return {
    version: 2,
    fps: 30,
    width: 1920,
    height: 1080,
    podcast: { audioPath: 'podcast.mp3', srtPath: '', durationMs: 120_000 },
    tracks: [],
    overlays: [],
    subtitle: {
      fontSize: 48,
      color: '#fff',
      position: 'bottom',
      highlightEnabled: false,
      highlightBackgroundColor: '#000',
      highlightTextColor: '#fff',
      highlightPaddingX: 0,
      highlightPaddingY: 0,
      highlightRadius: 0,
      highlightAnimation: 'none',
      maxCharsPerEntry: 35,
      autoResegment: true,
    },
  };
}

describe('renderRemotionChunk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renderer.renderMedia.mockResolvedValue({
      buffer: null,
      contentType: 'video/mp2t',
      slowestFrames: [{ frame: 42, time: 123 }],
    });
  });

  it('renders an absolute h264-ts frame range with separate seamless AAC', async () => {
    const input = { timeline: timeline(), srtEntries: [], compiledCards: {} };
    const result = await renderRemotionChunk({
      composition: {
        id: 'lingji-composition',
        width: 1920,
        height: 1080,
        fps: 30,
        durationInFrames: 3_600,
        defaultProps: {},
        props: {},
        defaultCodec: null,
        defaultOutName: null,
        defaultVideoImageFormat: null,
        defaultPixelFormat: null,
      } as never,
      serveUrl: 'http://127.0.0.1:32123/index.html',
      outputPath: 'C:/tmp/chunk-1.ts',
      audioPath: 'C:/tmp/chunk-1.aac',
      input,
      chunk: { index: 1, startFrame: 1_800, endFrame: 3_599, frameCount: 1_800 },
      scale: 0.5,
      x264Preset: 'veryfast',
      quality: 'balanced',
      videoBitrate: '3000k',
      audioBitrate: '192k',
      jpegQuality: 80,
      concurrency: 2,
      encoder: 'h264_nvenc',
      binariesDirectory: 'C:/runtime/remotion',
      browserExecutable: 'C:/runtime/chrome.exe',
      platform: 'win32',
    });

    expect(renderer.renderMedia).toHaveBeenCalledTimes(1);
    const options = renderer.renderMedia.mock.calls[0][0];
    expect(options).toMatchObject({
      composition: expect.objectContaining({ props: input }),
      codec: 'h264-ts',
      outputLocation: 'C:/tmp/chunk-1.ts',
      separateAudioTo: 'C:/tmp/chunk-1.aac',
      frameRange: [1_800, 3_599],
      compositionStart: 0,
      enforceAudioTrack: true,
      forSeamlessAacConcatenation: true,
      audioCodec: 'aac',
      hardwareAcceleration: 'disable',
      concurrency: 2,
      inputProps: input,
      binariesDirectory: 'C:/runtime/remotion',
      browserExecutable: 'C:/runtime/chrome.exe',
      chromiumOptions: { ignoreCertificateErrors: false, gl: 'angle' },
    });
    expect(options.ffmpegOverride({
      type: 'stitcher',
      args: ['-c:v', 'libx264', '-preset', 'veryfast'],
    })).toEqual(['-c:v', 'h264_nvenc', '-preset', 'p4']);
    expect(result.slowestFrames).toEqual([{ frame: 42, time: 123 }]);
  });

  it('aggregates browser logs instead of forwarding every event', async () => {
    renderer.renderMedia.mockImplementation(async (options) => {
      options.onBrowserLog({ type: 'log', text: 'frame debug' });
      options.onBrowserLog({ type: 'warning', text: 'warning text' });
      options.onBrowserLog({ type: 'error', text: 'first error' });
      options.onBrowserLog({ type: 'error', text: 'second error' });
      options.onBrowserLog({ type: 'log', text: '[lingji-gpu] ANGLE (NVIDIA GeForce RTX 4060 Ti)' });
      return { buffer: null, contentType: 'video/mp2t', slowestFrames: [] };
    });

    const result = await renderRemotionChunk({
      composition: {} as never,
      serveUrl: 'http://127.0.0.1/index.html',
      outputPath: 'chunk.ts',
      audioPath: 'chunk.aac',
      input: { timeline: timeline(), srtEntries: [], compiledCards: {} },
      chunk: { index: 0, startFrame: 0, endFrame: 59, frameCount: 60 },
      scale: 1,
      x264Preset: 'veryfast',
      quality: 'balanced',
      videoBitrate: '3000k',
      audioBitrate: '192k',
      jpegQuality: 80,
      concurrency: 1,
      encoder: 'libx264',
      platform: 'win32',
    });

    expect(result.browserLogs).toMatchObject({
      total: 5,
      debug: 2,
      warn: 1,
      error: 2,
      firstError: 'first error',
      gpuRenderer: expect.stringContaining('RTX 4060 Ti'),
    });
  });
});

describe('combineRemotionChunks', () => {
  it('sorts chunks and maps all required combineChunks parameters', async () => {
    renderer.combineChunks.mockResolvedValue(undefined);
    await combineRemotionChunks({
      chunks: [
        { startFrame: 1_800, videoPath: 'b.ts', audioPath: 'b.aac' },
        { startFrame: 0, videoPath: 'a.ts', audioPath: 'a.aac' },
      ],
      outputPath: 'final.mp4',
      fps: 30,
      framesPerChunk: 1_800,
      compositionDurationInFrames: 3_600,
      audioBitrate: '192k',
      binariesDirectory: 'C:/runtime/remotion',
    });

    expect(renderer.combineChunks).toHaveBeenCalledWith(expect.objectContaining({
      videoFiles: ['a.ts', 'b.ts'],
      audioFiles: ['a.aac', 'b.aac'],
      outputLocation: 'final.mp4',
      codec: 'h264',
      fps: 30,
      framesPerChunk: 1_800,
      preferLossless: false,
      compositionDurationInFrames: 3_600,
      audioCodec: 'aac',
      audioBitrate: '192k',
      binariesDirectory: 'C:/runtime/remotion',
    }));
  });
});

describe('chunk scheduling', () => {
  it('defaults 24-plus-core machines to the measured three workers by five pages and allows diagnostics up to sixteen pages', () => {
    expect(resolveChunkExecutionConfig(28)).toEqual({ workers: 3, concurrency: 5, totalPages: 15 });
    expect(resolveChunkExecutionConfig(16)).toEqual({ workers: 2, concurrency: 5, totalPages: 10 });
    expect(resolveChunkExecutionConfig(15)).toEqual({ workers: 2, concurrency: 3, totalPages: 6 });
    expect(resolveChunkExecutionConfig(28, '2', '4')).toEqual({
      workers: 2,
      concurrency: 4,
      totalPages: 8,
    });
    expect(resolveChunkExecutionConfig(28, '2', '5')).toEqual({
      workers: 2,
      concurrency: 5,
      totalPages: 10,
    });
    expect(resolveChunkExecutionConfig(28, '2', '6')).toEqual({
      workers: 2,
      concurrency: 6,
      totalPages: 12,
    });
    expect(resolveChunkExecutionConfig(28, '2', '7')).toEqual({
      workers: 2,
      concurrency: 7,
      totalPages: 14,
    });
    expect(resolveChunkExecutionConfig(28, '2', '8')).toEqual({
      workers: 2,
      concurrency: 8,
      totalPages: 16,
    });
    expect(resolveChunkExecutionConfig(28, '3', '6')).toEqual({
      workers: 3,
      concurrency: 5,
      totalPages: 15,
    });
    expect(resolveChunkExecutionConfig(28, '3', '3')).toEqual({
      workers: 3,
      concurrency: 3,
      totalPages: 9,
    });
    expect(resolveChunkExecutionConfig(2)).toEqual({ workers: 1, concurrency: 1, totalPages: 1 });
  });

  it('uses sixty-second chunks unless a bounded diagnostic override is provided', () => {
    expect(resolveFramesPerChunk(30)).toBe(1_800);
    expect(resolveFramesPerChunk(30, '45')).toBe(1_350);
    expect(resolveFramesPerChunk(30, '1')).toBe(1_800);
    expect(resolveFramesPerChunk(30, 'invalid')).toBe(1_800);
  });

  it('never runs more items than the configured worker count', async () => {
    let active = 0;
    let peak = 0;
    const completed: number[] = [];
    await runChunkPool([0, 1, 2, 3, 4], 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      completed.push(item);
      active -= 1;
    });

    expect(peak).toBe(2);
    expect(completed.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('drops to one page and then disables NVENC after a matching encoder failure', async () => {
    const attempts: Array<{ concurrency: number; encoder: string; useAngle: boolean }> = [];
    const result = await renderChunkWithFallback(
      { concurrency: 2, encoder: 'h264_nvenc', useAngle: true },
      async (attempt) => {
        attempts.push(attempt);
        if (attempt.encoder === 'h264_nvenc') {
          throw new Error('NVENC encoder initialization failed');
        }
        return 'ok';
      },
    );

    expect(result.value).toBe('ok');
    expect(attempts).toEqual([
      { concurrency: 2, encoder: 'h264_nvenc', useAngle: true },
      { concurrency: 1, encoder: 'h264_nvenc', useAngle: true },
      { concurrency: 1, encoder: 'libx264', useAngle: true },
    ]);
    expect(result.fallbacks).toEqual(['single-page', 'cpu-encoder']);
  });

  it('disables VideoToolbox after a matching encoder failure', async () => {
    const attempts: Array<{ concurrency: number; encoder: string; useAngle: boolean }> = [];
    const result = await renderChunkWithFallback(
      { concurrency: 1, encoder: 'h264_videotoolbox', useAngle: false },
      async (attempt) => {
        attempts.push(attempt);
        if (attempt.encoder === 'h264_videotoolbox') {
          throw new Error('Error while opening encoder h264_videotoolbox');
        }
        return 'ok';
      },
    );

    expect(result.value).toBe('ok');
    expect(attempts).toEqual([
      { concurrency: 1, encoder: 'h264_videotoolbox', useAngle: false },
      { concurrency: 1, encoder: 'libx264', useAngle: false },
    ]);
    expect(result.fallbacks).toEqual(['cpu-encoder']);
  });

  it('disables ANGLE after a GPU process failure without retrying forever', async () => {
    const attempts: Array<{ concurrency: number; encoder: string; useAngle: boolean }> = [];
    const result = await renderChunkWithFallback(
      { concurrency: 1, encoder: 'libx264', useAngle: true },
      async (attempt) => {
        attempts.push(attempt);
        if (attempt.useAngle) throw new Error('ANGLE GPU process crashed');
        return 'ok';
      },
    );

    expect(result.value).toBe('ok');
    expect(attempts).toEqual([
      { concurrency: 1, encoder: 'libx264', useAngle: true },
      { concurrency: 1, encoder: 'libx264', useAngle: false },
    ]);
    expect(result.fallbacks).toEqual(['default-gl']);
  });

  it('renders every chunk on every export without consulting a render cache', async () => {
    const events: Array<{ kind: string; extra?: Record<string, unknown> }> = [];
    const rendered: number[] = [];
    let combined: Array<{ startFrame: number; videoPath: string; audioPath: string }> = [];
    const createCacheKey = vi.fn(async ({ chunk }: { chunk: { index: number } }) => `key-${chunk.index}`);
    const readCache = vi.fn(async () => ({
      hit: true,
      videoPath: 'stale-cache.ts',
      audioPath: 'stale-cache.aac',
      manifest: {},
    }));
    const commitCache = vi.fn(async () => ({
      videoPath: 'new-cache.ts',
      audioPath: 'new-cache.aac',
      manifest: {},
    }));
    const pruneCache = vi.fn(async () => ({ removedKeys: [], remainingBytes: 0 }));
    const sourceTimeline = timeline();
    sourceTimeline.podcast.durationMs = 180_000;

    const result = await renderChunkedVideo(
      ({
        composition: { durationInFrames: 5_400, fps: 30 } as never,
        serveUrl: 'http://127.0.0.1/index.html',
        outputPath: 'final.tmp.mp4',
        input: { timeline: sourceTimeline, srtEntries: [], compiledCards: {} },
        publicDir: 'C:/public',
        framesPerChunk: 1_800,
        workers: 2,
        concurrency: 2,
        scale: 0.5,
        x264Preset: 'veryfast',
        quality: 'balanced',
        videoBitrate: '3000k',
        audioBitrate: '128k',
        jpegQuality: 80,
        encoder: 'h264_nvenc',
        ffprobePath: 'ffprobe.exe',
        emit: (kind, extra) => events.push({ kind, extra }),
      } as never),
      ({
        createCacheKey,
        readCache,
        renderChunk: async ({ chunk }) => {
          rendered.push(chunk.index);
          return {
            durationMs: 1_000,
            slowestFrames: [],
            browserLogs: {
              total: 1,
              debug: 1,
              warn: 0,
              error: 0,
              firstError: null,
              gpuRenderer: 'ANGLE (NVIDIA RTX 4060 Ti)',
              hardwareGpu: true,
            },
          };
        },
        probeChunk: async () => ({ ok: true, videoCodec: 'h264', audioCodec: 'aac' }),
        commitCache,
        combine: async ({ chunks }) => {
          combined = chunks;
        },
        pruneCache,
      } as never),
    );

    expect(rendered.sort()).toEqual([0, 1, 2]);
    expect(combined.map((entry) => entry.startFrame)).toEqual([0, 1_800, 3_600]);
    expect(combined.map((entry) => entry.videoPath)).toSatisfy((paths: string[]) =>
      paths.every((entry) => entry.endsWith('video.ts')),
    );
    expect(result).toMatchObject({ totalFrames: 5_400, renderedChunks: 3 });
    expect(result).not.toHaveProperty('cacheHits');
    expect(createCacheKey).not.toHaveBeenCalled();
    expect(readCache).not.toHaveBeenCalled();
    expect(commitCache).not.toHaveBeenCalled();
    expect(pruneCache).not.toHaveBeenCalled();
    expect(events.filter((event) => event.kind.startsWith('export.chunk.cache.'))).toHaveLength(0);
    expect(events.filter((event) => event.kind === 'export.chunk.end')).toHaveLength(3);
  });
});
