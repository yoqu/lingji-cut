// tests/cli-cover-command.test.ts
import { describe, it, expect } from 'vitest';
import { runCoverCommand } from '../cli/src/commands/cover';
import type { ToolCaller } from '../cli/src/client';

function fake() {
  const calls: Array<{ name: string; args?: unknown }> = [];
  const client: ToolCaller = {
    async call(name, args) { calls.push({ name, args }); return name === 'lingji_get_active_project' ? { projectPath: '/p' } : { taskId: 'tk' }; },
    async close() {},
  };
  return { client, calls };
}

describe('runCoverCommand', () => {
  it('gen → lingji_generate_covers', async () => {
    const { client, calls } = fake();
    await runCoverCommand('gen', {}, client);
    expect(calls.some((c) => c.name === 'lingji_generate_covers')).toBe(true);
  });
  it('gen --step prompts → lingji_generate_cover_prompts', async () => {
    const { client, calls } = fake();
    await runCoverCommand('gen', { step: 'prompts' }, client);
    expect(calls.some((c) => c.name === 'lingji_generate_cover_prompts')).toBe(true);
  });
  it('gen --step images → lingji_generate_cover_images', async () => {
    const { client, calls } = fake();
    await runCoverCommand('gen', { step: 'images' }, client);
    expect(calls.some((c) => c.name === 'lingji_generate_cover_images')).toBe(true);
  });
  it('gen --step frob → bad_args', async () => {
    const { client } = fake();
    await expect(runCoverCommand('gen', { step: 'frob' }, client)).rejects.toMatchObject({ code: 'bad_args' });
  });
  it('unknown action → bad_args', async () => {
    const { client } = fake();
    await expect(runCoverCommand('prompt', {}, client)).rejects.toMatchObject({ code: 'bad_args' });
  });
});
