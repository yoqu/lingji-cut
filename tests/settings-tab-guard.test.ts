import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  buildUnsavedChangesConfirmMessage,
  runSettingsLeaveGuard,
} from '../src/components/settings/useSettingsTabGuard';

describe('useSettingsTabGuard', () => {
  it('builds a consistent leave-confirm message for settings tabs', () => {
    expect(buildUnsavedChangesConfirmMessage('口播配置')).toBe(
      '口播配置还有未保存的更改。\n点击“确定”会先保存再离开，点击“取消”将留在当前页面。',
    );
  });

  it('returns immediately when there are no unsaved changes', async () => {
    const confirm = vi.fn();
    const save = vi.fn();

    await expect(
      runSettingsLeaveGuard({
        title: 'AI 基础配置',
        hasUnsavedChanges: false,
        onSave: save,
        confirm,
      }),
    ).resolves.toBe(true);

    expect(confirm).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('blocks leaving when user cancels the confirmation', async () => {
    const confirm = vi.fn(() => false);
    const save = vi.fn();

    await expect(
      runSettingsLeaveGuard({
        title: 'AI 基础配置',
        hasUnsavedChanges: true,
        onSave: save,
        confirm,
      }),
    ).resolves.toBe(false);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('delegates to save when user chooses to save before leaving', async () => {
    const confirm = vi.fn(() => true);
    const save = vi.fn(async () => true);

    await expect(
      runSettingsLeaveGuard({
        title: '审查规范',
        hasUnsavedChanges: true,
        onSave: save,
        confirm,
      }),
    ).resolves.toBe(true);

    expect(confirm).toHaveBeenCalledWith(buildUnsavedChangesConfirmMessage('审查规范'));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('supports the product confirmation dialog through an async confirmation adapter', async () => {
    const confirm = vi.fn(async () => true);
    const save = vi.fn(async () => true);

    await expect(
      runSettingsLeaveGuard({
        title: '口播配置',
        hasUnsavedChanges: true,
        onSave: save,
        confirm,
      }),
    ).resolves.toBe(true);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('wires the generic hook into settings tabs and navigation shell', () => {
    const settingsSource = readFileSync(
      new URL('../src/pages/Settings.tsx', import.meta.url),
      'utf8',
    );
    const aiSource = readFileSync(
      new URL('../src/components/settings/AIConfigTab.tsx', import.meta.url),
      'utf8',
    );
    const ttsSource = readFileSync(
      new URL('../src/components/settings/TTSConfigTab.tsx', import.meta.url),
      'utf8',
    );

    expect(settingsSource).toContain('tabLeaveGuardRef');
    expect(settingsSource).toContain('onRegisterLeaveGuard');
    expect(settingsSource).toContain('<ConfirmDialog');
    expect(settingsSource).toContain('confirmLeave={confirmLeave}');
    expect(aiSource).toContain('useSettingsTabGuard');
    expect(ttsSource).toContain('useSettingsTabGuard');
  });
});
