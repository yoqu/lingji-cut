// tests/cli-settings-command.test.ts
import { describe, it, expect } from 'vitest';
import { runSettingsCommand } from '../cli/src/commands/settings';
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

describe('runSettingsCommand', () => {
  it('show → lingji_get_settings', async () => {
    const { client, calls } = fake();
    await runSettingsCommand('show', [], client);
    expect(calls[0].name).toBe('lingji_get_settings');
  });

  it('set 数字值自动转 number', async () => {
    const { client, calls } = fake();
    await runSettingsCommand('set', ['minimaxSpeed', '1.2'], client);
    expect(calls[0]).toEqual({
      name: 'lingji_update_settings',
      args: { updates: { minimaxSpeed: 1.2 } },
    });
  });

  it('set 字符串值原样传递', async () => {
    const { client, calls } = fake();
    await runSettingsCommand('set', ['defaultModel', 'glm-4.7'], client);
    expect(calls[0].args).toEqual({ updates: { defaultModel: 'glm-4.7' } });
  });

  it('set 缺 value → bad_args', async () => {
    const { client } = fake();
    await expect(runSettingsCommand('set', ['defaultModel'], client)).rejects.toMatchObject({
      code: 'bad_args',
    });
  });
});
