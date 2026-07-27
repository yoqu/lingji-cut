import { describe, expect, it } from 'vitest';
import {
  classifyGpuRenderer,
  createH264TsFfmpegOverride,
  probeChunkMedia,
  probeFfmpegEncoder,
} from '../electron/remotion/gpu-runtime';

describe('probeFfmpegEncoder', () => {
  it('falls back when NVENC is advertised but the real smoke encode fails', async () => {
    const calls: string[][] = [];
    const result = await probeFfmpegEncoder('C:/ffmpeg/ffmpeg.exe', {
      platform: 'win32',
      run: async (_executable, args) => {
        calls.push(args);
        if (args.includes('-version')) {
          return { code: 0, stdout: 'ffmpeg version 8.0.1', stderr: '' };
        }
        if (args.includes('-encoders')) {
          return { code: 0, stdout: ' V....D h264_nvenc NVIDIA NVENC H.264 encoder', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: 'Cannot get the preset configuration: unsupported param (12)' };
      },
    });

    expect(calls).toHaveLength(3);
    // The bundled trimmed ffmpeg lacks lavfi sources (`color`/`nullsrc` need the absent
    // wrapped_avframe decoder), so the smoke encode must loop a real PNG through image2.
    expect(calls[2]).toContain('-loop');
    expect(calls[2].some((arg) => arg.endsWith('.png'))).toBe(true);
    expect(calls[2]).toContain('h264_nvenc');
    expect(result).toMatchObject({
      ffmpegVersion: '8.0.1',
      candidate: 'h264_nvenc',
      advertised: true,
      smokeOk: false,
      encoder: 'libx264',
      remotionHardwareAcceleration: 'disable',
    });
    expect(result.fallbackReason).toMatch(/unsupported param/);
  });

  it('uses an explicit h264-ts FFmpeg override after the smoke encode succeeds', async () => {
    const result = await probeFfmpegEncoder('C:/ffmpeg/ffmpeg.exe', {
      platform: 'win32',
      run: async (_executable, args) => {
        if (args.includes('-version')) return { code: 0, stdout: 'ffmpeg version 8.0.1-full', stderr: '' };
        if (args.includes('-encoders')) return { code: 0, stdout: 'h264_nvenc', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    expect(result).toMatchObject({
      candidate: 'h264_nvenc',
      advertised: true,
      smokeOk: true,
      encoder: 'h264_nvenc',
      remotionHardwareAcceleration: 'disable',
      usesFfmpegOverride: true,
    });
  });

  it('falls back without running a smoke encode when NVENC is absent', async () => {
    let calls = 0;
    const result = await probeFfmpegEncoder('C:/ffmpeg/ffmpeg.exe', {
      platform: 'win32',
      run: async (_executable, args) => {
        calls += 1;
        return args.includes('-version')
          ? { code: 0, stdout: 'ffmpeg version 7.1', stderr: '' }
          : { code: 0, stdout: 'libx264', stderr: '' };
      },
    });

    expect(calls).toBe(2);
    expect(result).toMatchObject({
      candidate: 'h264_nvenc',
      advertised: false,
      smokeOk: false,
      encoder: 'libx264',
    });
  });

  it('probes VideoToolbox on darwin with a bitrate-driven smoke encode and no x264 preset', async () => {
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const result = await probeFfmpegEncoder('/opt/remotion/ffmpeg', {
      platform: 'darwin',
      run: async (_executable, args, options) => {
        calls.push({ args, cwd: options?.cwd });
        if (args.includes('-version')) return { code: 0, stdout: 'ffmpeg version n7.1', stderr: '' };
        if (args.includes('-encoders')) {
          return { code: 0, stdout: ' V....D h264_videotoolbox VideoToolbox H.264 Encoder', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    // The bundled ffmpeg references its dylibs by bare name; dyld only resolves them from cwd.
    expect(calls.every((call) => call.cwd === '/opt/remotion')).toBe(true);
    const smoke = calls[2].args;
    expect(smoke).toContain('-loop');
    expect(smoke.some((arg) => arg.endsWith('.png'))).toBe(true);
    expect(smoke).toContain('h264_videotoolbox');
    expect(smoke).toContain('-b:v');
    expect(smoke).not.toContain('-preset');
    expect(result).toMatchObject({
      candidate: 'h264_videotoolbox',
      advertised: true,
      smokeOk: true,
      encoder: 'h264_videotoolbox',
      remotionHardwareAcceleration: 'disable',
      usesFfmpegOverride: true,
    });
  });

  it('falls back to libx264 when the VideoToolbox smoke encode fails', async () => {
    const result = await probeFfmpegEncoder('/opt/remotion/ffmpeg', {
      platform: 'darwin',
      run: async (_executable, args) => {
        if (args.includes('-version')) return { code: 0, stdout: 'ffmpeg version n7.1', stderr: '' };
        if (args.includes('-encoders')) return { code: 0, stdout: 'h264_videotoolbox', stderr: '' };
        return { code: 1, stdout: '', stderr: 'Error: cannot create compression session' };
      },
    });

    expect(result).toMatchObject({
      candidate: 'h264_videotoolbox',
      advertised: true,
      smokeOk: false,
      encoder: 'libx264',
    });
    expect(result.fallbackReason).toMatch(/compression session/);
  });

  it('skips probing entirely on platforms without a hardware encoder candidate', async () => {
    let calls = 0;
    const result = await probeFfmpegEncoder('/usr/bin/ffmpeg', {
      platform: 'linux',
      run: async () => {
        calls += 1;
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    expect(calls).toBe(0);
    expect(result).toMatchObject({
      candidate: null,
      advertised: false,
      smokeOk: false,
      encoder: 'libx264',
      usesFfmpegOverride: false,
    });
  });
});

describe('createH264TsFfmpegOverride', () => {
  const original = ['-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-f', 'mpegts', 'out.ts'];

  it('replaces only the stitcher video encoder and maps the NVENC preset', () => {
    const override = createH264TsFfmpegOverride('h264_nvenc', 'balanced');

    expect(override({ type: 'pre-stitcher', args: original })).toEqual(original);
    expect(override({ type: 'stitcher', args: original })).toEqual([
      '-i', '-', '-c:v', 'h264_nvenc', '-preset', 'p4', '-f', 'mpegts', 'out.ts',
    ]);
  });

  it('swaps in VideoToolbox and strips the x264 preset pair it does not understand', () => {
    const override = createH264TsFfmpegOverride('h264_videotoolbox', 'balanced');

    expect(override({ type: 'pre-stitcher', args: original })).toEqual(original);
    expect(override({ type: 'stitcher', args: original })).toEqual([
      '-i', '-', '-c:v', 'h264_videotoolbox', '-f', 'mpegts', 'out.ts',
    ]);
  });
});

describe('classifyGpuRenderer', () => {
  it('accepts hardware ANGLE and rejects SwiftShader', () => {
    expect(classifyGpuRenderer(['[lingji-gpu] ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Ti Direct3D11)']))
      .toMatchObject({ hardwareGpu: true, renderer: expect.stringContaining('RTX 4060 Ti') });
    expect(classifyGpuRenderer(['[lingji-gpu] ANGLE (Google, Vulkan 1.3 SwiftShader Device)']))
      .toMatchObject({ hardwareGpu: false, renderer: expect.stringContaining('SwiftShader') });
  });
});

describe('probeChunkMedia', () => {
  it('requires an H.264 video stream and an AAC audio stream', async () => {
    const cwds: Array<string | undefined> = [];
    const result = await probeChunkMedia(
      'C:/ffmpeg/ffprobe.exe',
      { videoPath: 'chunk.ts', audioPath: 'chunk.aac' },
      {
        run: async (_executable, args, options) => {
          cwds.push(options?.cwd);
          return {
            code: 0,
            stdout: JSON.stringify({
              streams: args.at(-1) === 'chunk.ts'
                ? [{ codec_type: 'video', codec_name: 'h264' }]
                : [{ codec_type: 'audio', codec_name: 'aac' }],
            }),
            stderr: '',
          };
        },
      },
    );

    expect(result).toEqual({ ok: true, videoCodec: 'h264', audioCodec: 'aac' });
    // ffprobe has the same bare-name dylib layout as ffmpeg; it must also run from its own dir.
    expect(cwds).toEqual(['C:/ffmpeg', 'C:/ffmpeg']);
  });
});
