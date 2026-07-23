import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  buildWindowsPackagerOptions,
  buildNvencSmokeArgs,
  createIcoFromPng,
  normalizePackageArch,
  patchStagedRemotionAacEncoder,
  resolvePackageArch,
  resolveSpawnCommand,
  resolveSpawnOptions,
  selectWindowsPlatformPackages,
  windowsFfmpegPackages,
} = require('../scripts/package-windows.cjs');

describe('package windows helpers', () => {
  it('patches the staged Remotion AAC mapping to the native Windows FFmpeg encoder', async () => {
    const stageDir = await mkdtemp(path.join(tmpdir(), 'lingji-win-stage-aac-'));
    const codecPath = path.join(
      stageDir,
      'node_modules',
      '@remotion',
      'renderer',
      'dist',
      'options',
      'audio-codec.js',
    );
    await mkdir(path.dirname(codecPath), { recursive: true });
    await writeFile(
      codecPath,
      [
        "const audioCodecNames = ['libfdk_aac'];",
        "if (audioCodec === 'aac') {",
        "  return 'libfdk_aac';",
        '}',
      ].join('\n'),
      'utf8',
    );

    try {
      await patchStagedRemotionAacEncoder(stageDir);

      const patched = await readFile(codecPath, 'utf8');
      expect(patched).toContain("const audioCodecNames = ['libfdk_aac'];");
      expect(patched).toContain("return 'aac';");
      expect(patched).not.toContain("return 'libfdk_aac';");
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
  });

  it('fails staging when the pinned Remotion AAC mapping drifts', async () => {
    const stageDir = await mkdtemp(path.join(tmpdir(), 'lingji-win-stage-aac-drift-'));
    const codecPath = path.join(
      stageDir,
      'node_modules',
      '@remotion',
      'renderer',
      'dist',
      'options',
      'audio-codec.js',
    );
    await mkdir(path.dirname(codecPath), { recursive: true });
    await writeFile(codecPath, "return 'aac';\n", 'utf8');

    try {
      await expect(patchStagedRemotionAacEncoder(stageDir)).rejects.toThrow(/exactly one/i);
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
  });

  it('normalizes Node architectures to Electron packager architectures', () => {
    expect(normalizePackageArch('x64')).toBe('x64');
    expect(normalizePackageArch('ia32')).toBe('ia32');
    expect(normalizePackageArch('arm64')).toBeNull();
    expect(normalizePackageArch('x86')).toBeNull();
  });

  it('defaults cross-platform Windows packages to x64 on non-Windows hosts', () => {
    expect(resolvePackageArch({ hostPlatform: 'darwin', hostArch: 'arm64' })).toBe('x64');
    expect(resolvePackageArch({ hostPlatform: 'linux', hostArch: 'arm64' })).toBe('x64');
    expect(resolvePackageArch({ hostPlatform: 'win32', hostArch: 'ia32' })).toBe('ia32');
    expect(resolvePackageArch({ requestedArch: 'ia32', hostPlatform: 'darwin', hostArch: 'arm64' })).toBe(
      'ia32',
    );
  });

  it('pins a modern hashed Windows FFmpeg build for the supported architecture', () => {
    expect(windowsFfmpegPackages.x64).toMatchObject({
      version: '8.0.1',
      url: 'https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-full_build.zip',
      archiveSha256: '467CDE100A47ED4B03A897988AEB4A296890C1E2B2D2864204657D002BC5FB90',
      ffmpegSha256: '74DB6C184A03DBA2BDFE23E1A1F41CF5A8385BC1DE6A7A1B26DB1DC541ABEF93',
    });
    expect(windowsFfmpegPackages.ia32).toBeUndefined();
    expect(windowsFfmpegPackages.arm64).toBeUndefined();
  });

  it('uses a real sixteen-frame NVENC encode for packaging smoke checks', () => {
    expect(buildNvencSmokeArgs()).toEqual(expect.arrayContaining([
      'color=c=black:s=256x256:r=30:d=0.54',
      '-frames:v', '16', '-c:v', 'h264_nvenc', '-preset', 'p4', '-f', 'null', '-',
    ]));
  });

  it('resolves npm to npm.cmd on Windows so spawn does not ENOENT', () => {
    expect(resolveSpawnCommand('npm', 'win32')).toBe('npm.cmd');
    expect(resolveSpawnCommand('npm', 'darwin')).toBe('npm');
    expect(resolveSpawnCommand('npm', 'linux')).toBe('npm');
    // 非 npm 命令在任何平台都保持原样（Windows 上 tar 是真实 exe）。
    expect(resolveSpawnCommand('tar', 'win32')).toBe('tar');
  });

  it('spawns Windows npm.cmd with shell:true so Node does not throw EINVAL', () => {
    // Node spawn .cmd 需要 shell:true（CVE-2024-27980 之后）。
    expect(resolveSpawnOptions('npm', {}, 'win32')).toMatchObject({ shell: true });
    // 非 Windows 或非 npm 不应启用 shell（避免参数转义风险）。
    expect(resolveSpawnOptions('npm', {}, 'darwin').shell).toBeUndefined();
    expect(resolveSpawnOptions('tar', {}, 'win32').shell).toBeUndefined();
    // 调用方传入的 options 仍可覆盖默认值。
    expect(resolveSpawnOptions('npm', { cwd: '/custom' }, 'win32')).toMatchObject({
      cwd: '/custom',
      shell: true,
    });
  });

  it('builds win32 packager options with Windows icon and asar unpack rules', () => {
    const options = buildWindowsPackagerOptions({
      appName: 'Lingji',
      arch: 'x64',
      iconPath: 'F:/repo/build/icon.ico',
      releaseDir: 'F:/repo/release',
      stageDir: 'F:/repo/.tmp/package-stage/win32-x64',
      existsSync: () => true,
    });

    expect(options.platform).toBe('win32');
    expect(options.arch).toBe('x64');
    expect(options.name).toBe('Lingji');
    expect(options.icon).toBe('F:/repo/build/icon.ico');
    expect(options.asar).toEqual({
      unpackDir: expect.stringContaining('vendor/remotion-browser'),
    });
  });

  it('selects missing win32 platform packages from the lockfile by os/cpu', () => {
    const lockPackages = {
      'node_modules/@rspack/binding-win32-x64-msvc': {
        version: '1.7.11',
        optional: true,
        os: ['win32'],
        cpu: ['x64'],
      },
      'node_modules/@rspack/binding-win32-ia32-msvc': {
        version: '1.7.11',
        optional: true,
        os: ['win32'],
        cpu: ['ia32'],
      },
      'node_modules/@rspack/binding-darwin-arm64': {
        version: '1.7.11',
        optional: true,
        os: ['darwin'],
        cpu: ['arm64'],
      },
      'node_modules/@ffprobe-installer/win32-x64': {
        version: '5.1.0',
        optional: true,
        os: ['win32'],
        cpu: ['x64'],
      },
      // universal optional 包（无 os 声明）不应被跨平台补装（如 canvas）。
      'node_modules/canvas': { version: '3.0.0', optional: true },
    };

    const selected = selectWindowsPlatformPackages(
      [
        '@rspack/binding-win32-x64-msvc',
        '@rspack/binding-win32-ia32-msvc',
        '@rspack/binding-darwin-arm64',
        '@ffprobe-installer/win32-x64',
        'canvas',
        'not-in-lockfile',
      ],
      lockPackages,
      'x64',
    );

    expect(selected).toEqual([
      { name: '@ffprobe-installer/win32-x64', version: '5.1.0' },
      { name: '@rspack/binding-win32-x64-msvc', version: '1.7.11' },
    ]);
  });

  it('excludes ffmpeg-installer packages already staged via the vendor channel', () => {
    const lockPackages = {
      'node_modules/@ffmpeg-installer/win32-x64': {
        version: '4.1.0',
        optional: true,
        os: ['win32'],
        cpu: ['x64'],
      },
    };

    expect(
      selectWindowsPlatformPackages(['@ffmpeg-installer/win32-x64'], lockPackages, 'x64'),
    ).toEqual([]);
  });

  it('wraps a PNG buffer in a valid single-image ICO container', () => {
    const pngBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x00,
    ]);

    const icoBuffer = createIcoFromPng(pngBuffer);

    expect(icoBuffer.readUInt16LE(0)).toBe(0);
    expect(icoBuffer.readUInt16LE(2)).toBe(1);
    expect(icoBuffer.readUInt16LE(4)).toBe(1);
    expect(icoBuffer[6]).toBe(0);
    expect(icoBuffer[7]).toBe(0);
    expect(icoBuffer.readUInt32LE(14)).toBe(pngBuffer.length);
    expect(icoBuffer.readUInt32LE(18)).toBe(22);
    expect(icoBuffer.subarray(22)).toEqual(pngBuffer);
  });
});
