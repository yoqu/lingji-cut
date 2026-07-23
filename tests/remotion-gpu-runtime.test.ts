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
    expect(calls[2]).toContain('color=c=black:s=256x256:r=30:d=0.54');
    expect(result).toMatchObject({
      ffmpegVersion: '8.0.1',
      nvencAdvertised: true,
      nvencSmokeOk: false,
      encoder: 'libx264',
      remotionHardwareAcceleration: 'disable',
    });
    expect(result.fallbackReason).toMatch(/unsupported param/);
  });

  it('uses an explicit h264-ts FFmpeg override after the smoke encode succeeds', async () => {
    const result = await probeFfmpegEncoder('C:/ffmpeg/ffmpeg.exe', {
      run: async (_executable, args) => {
        if (args.includes('-version')) return { code: 0, stdout: 'ffmpeg version 8.0.1-full', stderr: '' };
        if (args.includes('-encoders')) return { code: 0, stdout: 'h264_nvenc', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    expect(result).toMatchObject({
      nvencAdvertised: true,
      nvencSmokeOk: true,
      encoder: 'h264_nvenc',
      remotionHardwareAcceleration: 'disable',
      usesFfmpegOverride: true,
    });
  });

  it('falls back without running a smoke encode when NVENC is absent', async () => {
    let calls = 0;
    const result = await probeFfmpegEncoder('C:/ffmpeg/ffmpeg.exe', {
      run: async (_executable, args) => {
        calls += 1;
        return args.includes('-version')
          ? { code: 0, stdout: 'ffmpeg version 7.1', stderr: '' }
          : { code: 0, stdout: 'libx264', stderr: '' };
      },
    });

    expect(calls).toBe(2);
    expect(result).toMatchObject({
      nvencAdvertised: false,
      nvencSmokeOk: false,
      encoder: 'libx264',
    });
  });
});

describe('createH264TsFfmpegOverride', () => {
  it('replaces only the stitcher video encoder and maps the NVENC preset', () => {
    const override = createH264TsFfmpegOverride('balanced');
    const original = ['-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-f', 'mpegts', 'out.ts'];

    expect(override({ type: 'pre-stitcher', args: original })).toEqual(original);
    expect(override({ type: 'stitcher', args: original })).toEqual([
      '-i', '-', '-c:v', 'h264_nvenc', '-preset', 'p4', '-f', 'mpegts', 'out.ts',
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
    const result = await probeChunkMedia(
      'C:/ffmpeg/ffprobe.exe',
      { videoPath: 'chunk.ts', audioPath: 'chunk.aac' },
      {
        run: async (_executable, args) => ({
          code: 0,
          stdout: JSON.stringify({
            streams: args.at(-1) === 'chunk.ts'
              ? [{ codec_type: 'video', codec_name: 'h264' }]
              : [{ codec_type: 'audio', codec_name: 'aac' }],
          }),
          stderr: '',
        }),
      },
    );

    expect(result).toEqual({ ok: true, videoCodec: 'h264', audioCodec: 'aac' });
  });
});
