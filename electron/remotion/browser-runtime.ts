import { existsSync as nodeExistsSync } from 'node:fs';
import path from 'node:path';

export interface BundledRemotionBrowserOptions {
  isPackaged: boolean;
  resourcesPath: string;
  platform: NodeJS.Platform;
  arch: string;
  existsSync?: (filePath: string) => boolean;
}

function browserExecutableParts(platform: NodeJS.Platform, arch: string): string[] | null {
  if (platform === 'win32' && arch === 'x64') {
    return ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'];
  }
  if (platform === 'darwin' && arch === 'x64') {
    return ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'];
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'];
  }
  return null;
}

export function resolveBundledRemotionBrowserExecutable(
  options: BundledRemotionBrowserOptions,
): string | undefined {
  if (!options.isPackaged) return undefined;

  const parts = browserExecutableParts(options.platform, options.arch);
  if (!parts) {
    throw new Error(`当前平台不支持内置 Remotion 浏览器：${options.platform}-${options.arch}`);
  }

  const executable = path.join(
    options.resourcesPath,
    'app.asar.unpacked',
    'vendor',
    'remotion-browser',
    ...parts,
  );
  if (!(options.existsSync ?? nodeExistsSync)(executable)) {
    throw new Error(`内置 Remotion 浏览器不存在：${executable}`);
  }
  return executable;
}
