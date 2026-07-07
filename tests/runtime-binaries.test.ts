import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveFfmpegPath,
  resolveFfprobePath,
  resolveGsapPath,
} from '../electron/runtime-binaries';

describe('runtime binary resolution', () => {
  it('prefers app.asar.unpacked binaries for packaged apps', () => {
    const ffmpegPath = path.join(
      '/app/Contents/Resources/app.asar.unpacked',
      'node_modules',
      'ffmpeg-static',
      'ffmpeg',
    );
    const ffprobePath = path.join(
      '/app/Contents/Resources/app.asar.unpacked',
      'node_modules',
      '@ffprobe-installer',
      'darwin-arm64',
      'ffprobe',
    );
    const options = {
      appPath: '/app/Contents/Resources/app.asar',
      resourcesPath: '/app/Contents/Resources',
      cwd: '/workspace',
      moduleDir: '/app/Contents/Resources/app.asar/dist-electron',
      platform: 'darwin' as const,
      arch: 'arm64',
      existsSync: (candidate: string) => candidate === ffmpegPath || candidate === ffprobePath,
    };

    expect(resolveFfmpegPath(options)).toBe(ffmpegPath);
    expect(resolveFfprobePath(options)).toBe(ffprobePath);
  });

  it('resolves packaged GSAP next to other runtime assets', () => {
    const gsapPath = path.join(
      '/app/Contents/Resources/app.asar.unpacked',
      'node_modules',
      'gsap',
      'dist',
      'gsap.min.js',
    );

    const resolved = resolveGsapPath({
      appPath: '/app/Contents/Resources/app.asar',
      resourcesPath: '/app/Contents/Resources',
      cwd: '/workspace',
      moduleDir: '/app/Contents/Resources/app.asar/dist-electron',
      existsSync: (candidate) => candidate === gsapPath,
    });

    expect(resolved).toBe(gsapPath);
  });

  it('prefers staged Windows FFmpeg vendor binaries over node_modules fallbacks', () => {
    const ffmpegPath = path.join(
      'C:/app/resources/app.asar.unpacked',
      'vendor',
      'ffmpeg',
      'win32',
      'x64',
      'ffmpeg.exe',
    );

    const resolved = resolveFfmpegPath({
      appPath: 'C:/app/resources/app.asar',
      resourcesPath: 'C:/app/resources',
      cwd: 'C:/workspace',
      moduleDir: 'C:/app/resources/app.asar/dist-electron',
      platform: 'win32',
      arch: 'x64',
      existsSync: (candidate) => candidate === ffmpegPath,
    });

    expect(resolved).toBe(ffmpegPath);
  });

  it('falls back to Windows ffmpeg installer packages during development', () => {
    const ffmpegPath = path.join(
      'C:/workspace',
      'node_modules',
      '@ffmpeg-installer',
      'win32-ia32',
      'ffmpeg.exe',
    );

    const resolved = resolveFfmpegPath({
      appPath: 'C:/app/resources/app.asar',
      resourcesPath: 'C:/app/resources',
      cwd: 'C:/workspace',
      moduleDir: 'C:/app/resources/app.asar/dist-electron',
      platform: 'win32',
      arch: 'ia32',
      existsSync: (candidate) => candidate === ffmpegPath,
    });

    expect(resolved).toBe(ffmpegPath);
  });

  it('resolves Windows executable names and ffprobe architecture directories', () => {
    const ffprobePath = path.join(
      'C:/app/resources/app.asar.unpacked',
      'node_modules',
      '@ffprobe-installer',
      'win32-x64',
      'ffprobe.exe',
    );

    const resolved = resolveFfprobePath({
      appPath: 'C:/app/resources/app.asar',
      resourcesPath: 'C:/app/resources',
      cwd: 'C:/workspace',
      moduleDir: 'C:/app/resources/app.asar/dist-electron',
      platform: 'win32',
      arch: 'x64',
      existsSync: (candidate) => candidate === ffprobePath,
    });

    expect(resolved).toBe(ffprobePath);
  });
});
