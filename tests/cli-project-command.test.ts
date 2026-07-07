// tests/cli-project-command.test.ts
import { describe, it, expect } from 'vitest';
import { runProjectCommand } from '../cli/src/commands/project';
import type { ToolCaller } from '../cli/src/client';

function fakeClient(): ToolCaller & { calls: Array<{ name: string; args?: unknown }> } {
  const calls: Array<{ name: string; args?: unknown }> = [];
  return {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      return { ok: true };
    },
    async close() {},
  };
}

describe('runProjectCommand', () => {
  it('current → lingji_get_active_project', async () => {
    const c = fakeClient();
    await runProjectCommand('current', [], {}, c);
    expect(c.calls[0]).toEqual({ name: 'lingji_get_active_project', args: {} });
  });

  it('list → lingji_list_recent_projects', async () => {
    const c = fakeClient();
    await runProjectCommand('list', [], {}, c);
    expect(c.calls[0].name).toBe('lingji_list_recent_projects');
  });

  it('open <path> → lingji_open_project with path', async () => {
    const c = fakeClient();
    await runProjectCommand('open', ['/my/proj'], {}, c);
    expect(c.calls[0]).toEqual({ name: 'lingji_open_project', args: { path: '/my/proj' } });
  });

  it('open without path throws bad_args', async () => {
    const c = fakeClient();
    await expect(runProjectCommand('open', [], {}, c)).rejects.toMatchObject({ code: 'bad_args' });
  });

  it('create <path> --name → lingji_create_project with options', async () => {
    const c = fakeClient();
    await runProjectCommand('create', ['/new/proj'], { name: '演示' }, c);
    expect(c.calls[0]).toEqual({
      name: 'lingji_create_project',
      args: { path: '/new/proj', options: { name: '演示' } },
    });
  });

  it('create without path throws bad_args', async () => {
    const c = fakeClient();
    await expect(runProjectCommand('create', [], {}, c)).rejects.toMatchObject({ code: 'bad_args' });
  });

  it('unknown action throws bad_args', async () => {
    const c = fakeClient();
    await expect(runProjectCommand('frob', [], {}, c)).rejects.toMatchObject({ code: 'bad_args' });
  });
});
