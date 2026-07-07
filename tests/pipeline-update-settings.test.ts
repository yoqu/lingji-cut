// tests/pipeline-update-settings.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { updateSettings } from '../electron/pipeline/tools/project-tools';

describe('updateSettings', () => {
  it('writes whitelisted keys into aiSettings and preserves others', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-upset-'));
    try {
      writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({ aiSettings: { defaultModel: 'old', llmApiKey: 'sk-secret' }, other: 1 }),
      );
      const r = await updateSettings({
        userDataPath: dir,
        updates: { defaultModel: 'new-model', minimaxSpeed: 1.1, llmApiKey: 'hack' },
      });
      expect(r.updated.sort()).toEqual(['defaultModel', 'minimaxSpeed']);
      expect(r.rejected).toEqual(['llmApiKey']);
      const saved = JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf-8'));
      expect(saved.aiSettings.defaultModel).toBe('new-model');
      expect(saved.aiSettings.minimaxSpeed).toBe(1.1);
      expect(saved.aiSettings.llmApiKey).toBe('sk-secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws invalid_settings_key when nothing whitelisted', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-upset-'));
    try {
      await expect(
        updateSettings({ userDataPath: dir, updates: { llmApiKey: 'x' } }),
      ).rejects.toMatchObject({ code: 'invalid_settings_key' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
