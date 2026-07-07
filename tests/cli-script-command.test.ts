// tests/cli-script-command.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runScriptCommand } from '../cli/src/commands/script';
import type { ToolCaller } from '../cli/src/client';

function fake() {
  const calls: Array<{ name: string; args?: unknown }> = [];
  const client: ToolCaller = {
    async call(name, args) {
      calls.push({ name, args });
      return { ok: true };
    },
    async close() {},
  };
  return { client, calls };
}

describe('runScriptCommand', () => {
  it('read → lingji_read_script（默认当前文件）', async () => {
    const { client, calls } = fake();
    await runScriptCommand('read', [], client);
    expect(calls[0]).toEqual({ name: 'lingji_read_script', args: {} });
  });

  it('read original.md → filePath 透传', async () => {
    const { client, calls } = fake();
    await runScriptCommand('read', ['original.md'], client);
    expect(calls[0].args).toEqual({ filePath: 'original.md' });
  });

  it('review <json> → lingji_review_script with annotations', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-review-'));
    const file = path.join(dir, 'anno.json');
    try {
      writeFileSync(
        file,
        JSON.stringify({
          summary: '总体不错',
          score: 85,
          annotations: [{ quotedText: '有100万人', text: '缺来源', severity: 'warning' }],
        }),
      );
      const { client, calls } = fake();
      await runScriptCommand('review', [file], client);
      expect(calls[0].name).toBe('lingji_review_script');
      expect(calls[0].args).toMatchObject({ summary: '总体不错', score: 85 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('review 空 annotations → bad_args', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lingji-review-'));
    const file = path.join(dir, 'anno.json');
    try {
      writeFileSync(file, JSON.stringify({ annotations: [] }));
      const { client } = fake();
      await expect(runScriptCommand('review', [file], client)).rejects.toMatchObject({ code: 'bad_args' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unknown action → bad_args', async () => {
    const { client } = fake();
    await expect(runScriptCommand('write', [], client)).rejects.toMatchObject({ code: 'bad_args' });
  });
});
