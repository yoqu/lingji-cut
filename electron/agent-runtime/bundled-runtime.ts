import { existsSync as nodeExistsSync } from 'node:fs';
import path from 'node:path';

export interface ResolveBundledEntryOptions {
  appPath: string;
  resourcesPath: string;
  cwd: string;
  existsSync?: (candidate: string) => boolean;
}

function appAsarUnpackedPath(appPath: string): string | null {
  if (!appPath.includes('app.asar')) return null;
  return appPath.replace(/app\.asar(?:[/\\].*)?$/, 'app.asar.unpacked');
}

/** 解析内置入口（相对 staged 根的路径，如 'resources/pi/dist/cli.js'）。 */
export function resolveBundledEntry(
  relPath: string,
  options: ResolveBundledEntryOptions,
): string | null {
  const has = options.existsSync ?? nodeExistsSync;
  const roots: string[] = [];
  const unpacked = appAsarUnpackedPath(options.appPath);
  if (unpacked) roots.push(unpacked);
  if (options.resourcesPath) roots.push(path.join(options.resourcesPath, 'app.asar.unpacked'));
  roots.push(options.appPath);
  roots.push(options.cwd);
  for (const root of Array.from(new Set(roots))) {
    const candidate = path.join(root, relPath);
    if (has(candidate)) return candidate;
  }
  return null;
}
