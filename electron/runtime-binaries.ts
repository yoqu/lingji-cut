import { existsSync } from 'node:fs';
import path from 'node:path';

export interface RuntimeBinaryResolutionOptions {
  appPath: string;
  resourcesPath: string;
  cwd: string;
  moduleDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  existsSync?: (candidate: string) => boolean;
  readdirSync?: (candidate: string) => string[];
}
function appAsarUnpackedPath(appPath: string): string | null {
  if (!appPath.includes('app.asar')) return null;
  return appPath.replace(/app\.asar(?:[/\\].*)?$/, 'app.asar.unpacked');
}

function ffmpegRelativePaths(platform: NodeJS.Platform, arch: string): string[] {
  if (platform === 'win32') {
    return [
      path.join('vendor', 'ffmpeg', 'win32', arch, 'ffmpeg.exe'),
      path.join('node_modules', '@ffmpeg-installer', `win32-${arch}`, 'ffmpeg.exe'),
      path.join('node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
    ];
  }

  return [path.join('node_modules', 'ffmpeg-static', 'ffmpeg')];
}

function ffprobeRelativePaths(platform: NodeJS.Platform, arch: string): string[] {
  // @ffprobe-installer 按 <platform>-<arch> 发布真原生二进制（含 darwin-arm64），
  // 与 @ffmpeg-installer 同系列布局；取代仅含 x86_64 的 ffprobe-static。
  const binary = platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  return [path.join('node_modules', '@ffprobe-installer', `${platform}-${arch}`, binary)];
}

function gsapRelativePath(): string {
  return path.join('node_modules', 'gsap', 'dist', 'gsap.min.js');
}

function candidateRoots(options: RuntimeBinaryResolutionOptions): string[] {
  const roots: string[] = [];
  const unpackedAppPath = appAsarUnpackedPath(options.appPath);
  if (unpackedAppPath) roots.push(unpackedAppPath);
  if (options.resourcesPath) roots.push(path.join(options.resourcesPath, 'app.asar.unpacked'));
  roots.push(options.appPath);
  roots.push(options.cwd);
  roots.push(path.resolve(options.moduleDir, '..'));
  return Array.from(new Set(roots));
}

function findFirstExisting(
  relativePath: string,
  options: RuntimeBinaryResolutionOptions,
): string | null {
  const hasFile = options.existsSync ?? existsSync;
  return (
    candidateRoots(options)
      .map((root) => path.join(root, relativePath))
      .find((candidate) => hasFile(candidate)) ?? null
  );
}

function findFirstExistingFromList(
  relativePaths: string[],
  options: RuntimeBinaryResolutionOptions,
): string | null {
  for (const relativePath of relativePaths) {
    const hit = findFirstExisting(relativePath, options);
    if (hit) return hit;
  }
  return null;
}

export function resolveFfmpegPath(options: RuntimeBinaryResolutionOptions): string | null {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  return findFirstExistingFromList(ffmpegRelativePaths(platform, arch), options);
}

export function resolveFfprobePath(options: RuntimeBinaryResolutionOptions): string | null {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  return findFirstExistingFromList(ffprobeRelativePaths(platform, arch), options);
}

export function resolveGsapPath(options: RuntimeBinaryResolutionOptions): string | null {
  return findFirstExisting(gsapRelativePath(), options);
}

function parseVersionSegments(versionDir: string): number[] | null {
  const dashIndex = versionDir.indexOf('-');
  const versionPart = dashIndex >= 0 ? versionDir.slice(dashIndex + 1) : versionDir;
  const parsed = versionPart
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .filter((segment) => Number.isFinite(segment));
  return parsed.length > 0 ? parsed : null;
}
