import { describe, expect, it } from 'vitest';

import {
  UNINSTALL_REGISTRY_ROOT,
  resolveInstallerOutputName,
  resolveMakensisCommand,
  buildMakensisArgs,
  prepareNsisSource,
  buildNsisScript,
  makensisMissingMessage,
} from '../scripts/package-windows-installer.cjs';

describe('resolveInstallerOutputName', () => {
  it('matches the <appName>-<version>-<arch>-setup.exe release naming', () => {
    expect(
      resolveInstallerOutputName({ appName: '灵机剪影', version: '1.3.1', arch: 'x64' }),
    ).toBe('灵机剪影-1.3.1-x64-setup.exe');
  });
});

describe('resolveMakensisCommand', () => {
  it('falls back to makensis on PATH', () => {
    expect(resolveMakensisCommand({})).toBe('makensis');
  });

  it('prefers the MAKENSIS env override', () => {
    expect(resolveMakensisCommand({ MAKENSIS: '/opt/nsis/makensis' })).toBe('/opt/nsis/makensis');
  });

  it('ignores blank MAKENSIS', () => {
    expect(resolveMakensisCommand({ MAKENSIS: '   ' })).toBe('makensis');
  });

  it('finds NSIS in the default Windows installation directory when it is not on PATH', () => {
    const defaultMakensis = 'C:\\Program Files (x86)\\NSIS\\makensis.exe';
    expect(
      resolveMakensisCommand(
        { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
        {
          platform: 'win32',
          existsSync: (candidate: string) => candidate === defaultMakensis,
        },
      ),
    ).toBe(defaultMakensis);
  });
});

describe('buildMakensisArgs', () => {
  it('forces UTF-8 when compiling an NSIS script containing Chinese paths', () => {
    expect(buildMakensisArgs('F:\\项目\\installer.nsi', 'win32')).toEqual([
      '/INPUTCHARSET',
      'UTF8',
      'F:\\项目\\installer.nsi',
    ]);
  });
});

describe('prepareNsisSource', () => {
  it('uses a short Windows junction so deeply nested package files stay below MAX_PATH', async () => {
    const calls: unknown[][] = [];
    const prepared = await prepareNsisSource({
      appDir: 'F:\\ai\\video-web-master\\release\\灵机剪影-win32-x64',
      tmpDir: 'F:\\ai\\video-web-master\\.tmp\\win-installer-x64',
      platform: 'win32',
      linkName: 'n',
      remove: async (...args: unknown[]) => calls.push(['remove', ...args]),
      symlink: async (...args: unknown[]) => calls.push(['symlink', ...args]),
    });

    expect(prepared.sourceDir).toBe('F:\\n');
    expect(calls).toContainEqual([
      'symlink',
      'F:\\ai\\video-web-master\\release\\灵机剪影-win32-x64',
      'F:\\n',
      'junction',
    ]);
    await prepared.cleanup();
    expect(calls.at(-1)?.[0]).toBe('remove');
  });
});

describe('buildNsisScript', () => {
  const script = buildNsisScript({
    appName: '灵机剪影',
    version: '1.3.1',
    arch: 'x64',
    appDir: '/root/release/灵机剪影-win32-x64',
    exeName: '灵机剪影.exe',
    iconPath: '/root/build/icon.ico',
    outFile: '/root/release/灵机剪影-1.3.1-x64-setup.exe',
  });

  it('installs into a short Program Files root to avoid MAX_PATH', () => {
    expect(script).toContain('InstallDir "$PROGRAMFILES64\\灵机剪影"');
  });

  it('enables Unicode for chinese paths and requires admin', () => {
    expect(script).toContain('Unicode true');
    expect(script).toContain('RequestExecutionLevel admin');
  });

  it('bundles the packaged app folder recursively with windows separators', () => {
    expect(script).toContain('File /r "\\root\\release\\灵机剪影-win32-x64\\*.*"');
  });

  it('registers uninstall metadata and shortcuts', () => {
    expect(script).toContain(`${UNINSTALL_REGISTRY_ROOT}\\灵机剪影`);
    expect(script).toContain('WriteUninstaller "$INSTDIR\\Uninstall.exe"');
    expect(script).toContain('CreateShortcut "$DESKTOP\\灵机剪影.lnk" "$INSTDIR\\灵机剪影.exe"');
  });

  it('refuses to install over a running app and does not relaunch it elevated', () => {
    expect(script).toContain('Function .onInit');
    expect(script).toContain('FindWindow $0 ""');
    expect(script).toContain('Abort');
    expect(script).not.toContain('MUI_FINISHPAGE_RUN');
  });

  it('uses the icon when provided', () => {
    expect(script).toContain('!define MUI_ICON "\\root\\build\\icon.ico"');
  });

  it('omits icon defines when no icon is given', () => {
    const noIcon = buildNsisScript({
      appName: 'App',
      version: '1.0.0',
      arch: 'x64',
      appDir: '/a',
      exeName: 'App.exe',
      outFile: '/o/App-setup.exe',
    });
    expect(noIcon).not.toContain('MUI_ICON');
  });
});

describe('makensisMissingMessage', () => {
  it('explains how to install NSIS', () => {
    const message = makensisMissingMessage('makensis');
    expect(message).toContain('choco install nsis');
    expect(message).toContain('brew install makensis');
    expect(message).toContain('MAKENSIS');
  });
});
