import path from 'node:path';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const helperPath = path.resolve(__dirname, '../scripts/remotion-browser-runtime.cjs');

describe('Remotion browser packaging helper', () => {
  it('exists as a dedicated packaging helper', () => {
    expect(existsSync(helperPath)).toBe(true);
  });

  it.each([
    ['win32', 'x64', 'win64', 'chrome-headless-shell-win64/chrome-headless-shell.exe'],
    ['darwin', 'x64', 'mac-x64', 'chrome-headless-shell-mac-x64/chrome-headless-shell'],
    ['darwin', 'arm64', 'mac-arm64', 'chrome-headless-shell-mac-arm64/chrome-headless-shell'],
  ] as const)('maps %s-%s to the matching Chrome artifact', (platform, arch, chromePlatform, executable) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveRemotionBrowserTarget } = require('../scripts/remotion-browser-runtime.cjs');
    expect(resolveRemotionBrowserTarget(platform, arch)).toMatchObject({
      chromePlatform,
      executable: executable.split('/').join(path.sep),
    });
  });

  it('rejects unsupported Windows ia32 instead of producing an online-only package', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveRemotionBrowserTarget } = require('../scripts/remotion-browser-runtime.cjs');
    expect(() => resolveRemotionBrowserTarget('win32', 'ia32')).toThrow(/不支持离线 Remotion 浏览器/);
  });

  it('copies a verified browser into the package stage', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { stageBundledRemotionBrowser } = require('../scripts/remotion-browser-runtime.cjs');
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lingji-browser-stage-test-'));
    const stageDir = path.join(tempRoot, 'stage');
    try {
      const stagedExecutable = await stageBundledRemotionBrowser({
        platform: 'win32',
        arch: 'x64',
        stageDir,
        cacheRoot: path.join(tempRoot, 'cache'),
        prepareCache: async ({ executablePath }: { executablePath: string }) => {
          await mkdir(path.dirname(executablePath), { recursive: true });
          await writeFile(executablePath, 'browser');
        },
      });

      expect(stagedExecutable).toBe(
        path.join(
          stageDir,
          'vendor',
          'remotion-browser',
          'chrome-headless-shell-win64',
          'chrome-headless-shell.exe',
        ),
      );
      expect(readFileSync(stagedExecutable, 'utf8')).toBe('browser');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('wires browser staging into both desktop packagers', () => {
    const windows = readFileSync(new URL('../scripts/package-windows.cjs', import.meta.url), 'utf8');
    const mac = readFileSync(new URL('../scripts/package-mac.cjs', import.meta.url), 'utf8');

    expect(windows).toContain('stageBundledRemotionBrowser');
    expect(mac).toContain('stageBundledRemotionBrowser');
  });
});
