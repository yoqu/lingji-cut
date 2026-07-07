// tests/cli-state-command.test.ts
import { describe, it, expect } from 'vitest';
import { runStateCommand } from '../cli/src/commands/state';
import type { ToolCaller } from '../cli/src/client';

function fake() {
  const calls: Array<{ name: string; args?: unknown }> = [];
  const client: ToolCaller = {
    async call(name, args) {
      calls.push({ name, args });
      return name === 'lingji_get_active_project' ? { projectPath: '/active' } : { ok: true };
    },
    async close() {},
  };
  return { client, calls };
}

describe('runStateCommand', () => {
  it('default → lingji_get_project_state with resolved project', async () => {
    const { client, calls } = fake();
    await runStateCommand({}, client);
    expect(calls.find((c) => c.name === 'lingji_get_project_state')?.args).toEqual({
      projectPath: '/active',
    });
  });

  it('--editor → lingji_get_editor_state', async () => {
    const { client, calls } = fake();
    await runStateCommand({ editor: true }, client);
    expect(calls[0].name).toBe('lingji_get_editor_state');
  });

  it('--context → lingji_get_project_context', async () => {
    const { client, calls } = fake();
    await runStateCommand({ context: true }, client);
    expect(calls[0].name).toBe('lingji_get_project_context');
  });

  it('--settings → lingji_get_settings', async () => {
    const { client, calls } = fake();
    await runStateCommand({ settings: true }, client);
    expect(calls[0].name).toBe('lingji_get_settings');
  });

  it('--files --dir covers → lingji_list_project_files with directory', async () => {
    const { client, calls } = fake();
    await runStateCommand({ files: true, dir: 'covers' }, client);
    expect(calls[0]).toEqual({ name: 'lingji_list_project_files', args: { directory: 'covers' } });
  });
});
