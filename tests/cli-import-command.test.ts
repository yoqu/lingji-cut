// tests/cli-import-command.test.ts
import { describe, it, expect } from 'vitest';
import { runImportCommand } from '../cli/src/commands/import';
import type { ToolCaller } from '../cli/src/client';

function fake(statuses: Array<Record<string, unknown>>) {
  const calls: Array<{ name: string; args?: unknown }> = [];
  let i = 0;
  const client: ToolCaller = {
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'lingji_get_active_project') return { projectPath: '/proj' };
      if (name === 'lingji_start_video_import') return { importId: 'imp-1', status: 'downloading' };
      if (name === 'lingji_get_video_import_status') return statuses[Math.min(i++, statuses.length - 1)];
      return {};
    },
    async close() {},
  };
  return { client, calls };
}

const noSleep = { sleep: async () => {} };

describe('runImportCommand', () => {
  it('infers douyin from url and starts import', async () => {
    const { client, calls } = fake([]);
    const r = await runImportCommand('https://v.douyin.com/xyz', {}, client, noSleep);
    const start = calls.find((c) => c.name === 'lingji_start_video_import');
    expect(start?.args).toMatchObject({ sourceType: 'douyin', url: 'https://v.douyin.com/xyz', projectDir: '/proj' });
    expect(r).toMatchObject({ importId: 'imp-1' });
  });

  it('infers local_audio from extension', async () => {
    const { client, calls } = fake([]);
    await runImportCommand('/tmp/a.mp3', {}, client, noSleep);
    expect(calls.find((c) => c.name === 'lingji_start_video_import')?.args).toMatchObject({
      sourceType: 'local_audio',
      filePath: '/tmp/a.mp3',
    });
  });

  it('--type video overrides inference', async () => {
    const { client, calls } = fake([]);
    await runImportCommand('/tmp/a.mp3', { type: 'video' }, client, noSleep);
    expect(calls.find((c) => c.name === 'lingji_start_video_import')?.args).toMatchObject({
      sourceType: 'local_video',
    });
  });

  it('--wait polls until done', async () => {
    const { client } = fake([
      { status: 'transcribing', progress: 50 },
      { status: 'done', progress: 100 },
    ]);
    const r = await runImportCommand('/tmp/a.mp4', { wait: true }, client, noSleep);
    expect(r).toMatchObject({ status: 'done' });
  });

  it('--wait throws import_failed on error status', async () => {
    const { client } = fake([{ status: 'error', error: '下载失败' }]);
    await expect(runImportCommand('/tmp/a.mp4', { wait: true }, client, noSleep)).rejects.toMatchObject({
      code: 'import_failed',
    });
  });

  it('missing source throws bad_args', async () => {
    const { client } = fake([]);
    await expect(runImportCommand(undefined, {}, client, noSleep)).rejects.toMatchObject({ code: 'bad_args' });
  });
});
