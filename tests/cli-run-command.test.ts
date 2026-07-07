// tests/cli-run-command.test.ts
import { describe, it, expect } from 'vitest';
import { runRunCommand } from '../cli/src/commands/run';
import type { ToolCaller } from '../cli/src/client';

function fake(failAt?: string) {
  const calls: Array<{ name: string; args?: unknown }> = [];
  const client: ToolCaller = {
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'lingji_get_active_project') return { projectPath: '/p' };
      if (name === 'lingji_get_task_status') {
        const lastStart = [...calls].reverse().find((c) => c.name.startsWith('lingji_generate') || c.name === 'lingji_analyze_subtitles' || c.name === 'lingji_export_video');
        const failed = failAt && lastStart?.name === failAt;
        return failed ? { status: 'failed', error: '炸了' } : { status: 'succeeded' };
      }
      return { taskId: `tk-${name}` };
    },
    async close() {},
  };
  return { client, calls };
}

const noSleep = { sleep: async () => {} };

describe('runRunCommand', () => {
  it('依次跑 audio→analyze→cover 并等待每步', async () => {
    const { client, calls } = fake();
    const r = (await runRunCommand({}, client, noSleep)) as { steps: string[] };
    const started = calls.filter((c) => ['lingji_generate_audio', 'lingji_analyze_subtitles', 'lingji_generate_covers'].includes(c.name)).map((c) => c.name);
    expect(started).toEqual(['lingji_generate_audio', 'lingji_analyze_subtitles', 'lingji_generate_covers']);
    expect(r.steps).toEqual(['audio', 'analyze', 'cover']);
  });

  it('--from analyze 跳过音频', async () => {
    const { client, calls } = fake();
    await runRunCommand({ from: 'analyze' }, client, noSleep);
    expect(calls.some((c) => c.name === 'lingji_generate_audio')).toBe(false);
    expect(calls.some((c) => c.name === 'lingji_analyze_subtitles')).toBe(true);
  });

  it('--export 追加导出步', async () => {
    const { client, calls } = fake();
    const r = (await runRunCommand({ export: true }, client, noSleep)) as { steps: string[] };
    expect(calls.some((c) => c.name === 'lingji_export_video')).toBe(true);
    expect(r.steps).toContain('export');
  });

  it('某步失败 → step_failed 并停止后续', async () => {
    const { client, calls } = fake('lingji_analyze_subtitles');
    await expect(runRunCommand({}, client, noSleep)).rejects.toMatchObject({ code: 'step_failed' });
    expect(calls.some((c) => c.name === 'lingji_generate_covers')).toBe(false);
  });

  it('--from 非法 → bad_args', async () => {
    const { client } = fake();
    await expect(runRunCommand({ from: 'frob' }, client, noSleep)).rejects.toMatchObject({ code: 'bad_args' });
  });
});
