// tests/cli-publish-command.test.ts
import { describe, it, expect } from 'vitest';
import { runPublishCommand } from '../cli/src/commands/publish';
import type { ToolCaller } from '../cli/src/client';

function fake() {
  const calls: Array<{ name: string; args?: unknown }> = [];
  const client: ToolCaller = {
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'lingji_get_active_project') return { projectPath: '/proj' };
      if (name === 'lingji_publish_video') return { taskId: 'tk-pub' };
      return { ok: true };
    },
    async close() {},
  };
  return { client, calls };
}

describe('runPublishCommand', () => {
  it('accounts → lingji_list_publish_accounts', async () => {
    const { client, calls } = fake();
    await runPublishCommand('accounts', [], {}, client);
    expect(calls[0].name).toBe('lingji_list_publish_accounts');
  });

  it('check <id> → lingji_check_publish_account', async () => {
    const { client, calls } = fake();
    await runPublishCommand('check', ['douyin_a'], {}, client);
    expect(calls[0]).toEqual({
      name: 'lingji_check_publish_account',
      args: { accountId: 'douyin_a' },
    });
  });

  it('run 组装 filePath/title/accountIds/tags 并透传项目', async () => {
    const { client, calls } = fake();
    const r = await runPublishCommand(
      'run',
      [],
      { file: '/out.mp4', title: '标题', to: 'douyin_a, bilibili_b', tags: 'x,y', desc: '简介', tid: '21' },
      client,
    );
    const call = calls.find((c) => c.name === 'lingji_publish_video');
    expect(call?.args).toMatchObject({
      projectPath: '/proj',
      filePath: '/out.mp4',
      title: '标题',
      accountIds: ['douyin_a', 'bilibili_b'],
      tags: ['x', 'y'],
      desc: '简介',
      bilibiliTid: 21,
    });
    expect(r).toMatchObject({ taskId: 'tk-pub' });
  });

  it('run --headful → headless:false', async () => {
    const { client, calls } = fake();
    await runPublishCommand('run', [], { file: '/o.mp4', title: 't', to: 'douyin_a', headful: true }, client);
    expect(calls.find((c) => c.name === 'lingji_publish_video')?.args).toMatchObject({ headless: false });
  });

  it('run 缺 --file/--title/--to → bad_args', async () => {
    const { client } = fake();
    await expect(runPublishCommand('run', [], { file: '/o.mp4' }, client)).rejects.toMatchObject({
      code: 'bad_args',
    });
  });

  it('login 不支持（在应用内完成）→ bad_args', async () => {
    const { client } = fake();
    await expect(runPublishCommand('login', [], {}, client)).rejects.toMatchObject({ code: 'bad_args' });
  });
});
