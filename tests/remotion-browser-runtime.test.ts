import path from 'node:path';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const modulePath = path.resolve(__dirname, '../electron/remotion/browser-runtime.ts');

describe('packaged Remotion browser runtime', () => {
  it('provides a runtime resolver module', () => {
    expect(existsSync(modulePath)).toBe(true);
  });

  it('resolves the packaged Windows x64 executable', async () => {
    const { resolveBundledRemotionBrowserExecutable } = await import(
      '../electron/remotion/browser-runtime'
    );
    const resolved = resolveBundledRemotionBrowserExecutable({
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\Lingji\\resources',
      platform: 'win32',
      arch: 'x64',
      existsSync: () => true,
    });

    expect(resolved).toBe(
      path.join(
        'C:\\Program Files\\Lingji\\resources',
        'app.asar.unpacked',
        'vendor',
        'remotion-browser',
        'chrome-headless-shell-win64',
        'chrome-headless-shell.exe',
      ),
    );
  });

  it.each([
    ['x64', 'chrome-headless-shell-mac-x64'],
    ['arm64', 'chrome-headless-shell-mac-arm64'],
  ] as const)('resolves the packaged macOS %s executable', async (arch, folder) => {
    const { resolveBundledRemotionBrowserExecutable } = await import(
      '../electron/remotion/browser-runtime'
    );
    const resolved = resolveBundledRemotionBrowserExecutable({
      isPackaged: true,
      resourcesPath: '/Applications/Lingji.app/Contents/Resources',
      platform: 'darwin',
      arch,
      existsSync: () => true,
    });

    expect(resolved).toBe(
      path.join(
        '/Applications/Lingji.app/Contents/Resources',
        'app.asar.unpacked',
        'vendor',
        'remotion-browser',
        folder,
        'chrome-headless-shell',
      ),
    );
  });

  it('uses Remotion defaults in development', async () => {
    const { resolveBundledRemotionBrowserExecutable } = await import(
      '../electron/remotion/browser-runtime'
    );
    expect(
      resolveBundledRemotionBrowserExecutable({
        isPackaged: false,
        resourcesPath: '/unused',
        platform: 'win32',
        arch: 'x64',
      }),
    ).toBeUndefined();
  });

  it('fails clearly when a packaged browser is absent', async () => {
    const { resolveBundledRemotionBrowserExecutable } = await import(
      '../electron/remotion/browser-runtime'
    );
    expect(() =>
      resolveBundledRemotionBrowserExecutable({
        isPackaged: true,
        resourcesPath: 'C:\\Lingji\\resources',
        platform: 'win32',
        arch: 'x64',
        existsSync: () => false,
      }),
    ).toThrow(/内置 Remotion 浏览器不存在/);
  });
});
