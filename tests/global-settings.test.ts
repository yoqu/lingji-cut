import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  loadGlobalSettings,
  saveGlobalSettings,
  type GlobalSettingsFile,
} from '../electron/global-settings';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('loadGlobalSettings', () => {
  it('文件不存在时返回 null', async () => {
    const result = await loadGlobalSettings(tmpDir);
    expect(result).toBeNull();
  });

  it('读取已有设置', async () => {
    const settings: GlobalSettingsFile = {
      aiSettings: {
        llmBaseUrl: 'https://api.openai.com/v1',
        llmApiKey: 'sk-test',
        llmModel: 'gpt-4o',
        minimaxApiKey: '',
        minimaxVoiceId: 'male-qn-qingse',
        minimaxSpeed: 1.0,
      } as any,
    };
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify(settings),
    );
    const result = await loadGlobalSettings(tmpDir);
    expect(result?.aiSettings.llmApiKey).toBe('sk-test');
  });
});

describe('saveGlobalSettings', () => {
  it('写入设置后可读回', async () => {
    const settings: GlobalSettingsFile = {
      aiSettings: {
        llmBaseUrl: 'https://custom.api/v1',
        llmApiKey: 'sk-123',
        llmModel: 'gpt-4o-mini',
        minimaxApiKey: 'mm-key',
        minimaxVoiceId: 'female',
        minimaxSpeed: 1.5,
      } as any,
    };
    await saveGlobalSettings(tmpDir, settings);
    const result = await loadGlobalSettings(tmpDir);
    expect(result?.aiSettings.llmApiKey).toBe('sk-123');
    expect(result?.aiSettings.minimaxSpeed).toBe(1.5);
  });
});
