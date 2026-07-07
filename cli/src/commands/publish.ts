// cli/src/commands/publish.ts
import type { ToolCaller } from '../client';
import { resolveProjectPath } from '../project-resolve';
import { runGenerationCommand } from './generation';
import { CliError } from '../errors';

/** lingji publish accounts/check/run：发布账号与视频上传（登录仍在应用发布页扫码完成） */
export async function runPublishCommand(
  action: string | undefined,
  positionals: string[],
  flags: Record<string, string | boolean>,
  client: ToolCaller,
): Promise<unknown> {
  switch (action) {
    case 'accounts':
      return client.call('lingji_list_publish_accounts', {});
    case 'check': {
      const accountId = positionals[0];
      if (!accountId) throw new CliError('用法: lingji publish check <accountId>', 'bad_args', 2);
      return client.call('lingji_check_publish_account', { accountId });
    }
    case 'run': {
      const filePath = typeof flags.file === 'string' ? flags.file : '';
      const title = typeof flags.title === 'string' ? flags.title : '';
      const to = typeof flags.to === 'string' ? flags.to : '';
      if (!filePath || !title || !to) {
        throw new CliError(
          '用法: lingji publish run --file <mp4> --title <t> --to <acc1,acc2> [--desc <d>] [--tags <a,b>] [--thumbnail <img>] [--schedule <ms>] [--tid <n>] [--headful] [--wait]',
          'bad_args',
          2,
        );
      }
      const projectPath = await resolveProjectPath(flags, client);
      const extraArgs: Record<string, unknown> = {
        filePath,
        title,
        accountIds: to.split(',').map((s) => s.trim()).filter(Boolean),
      };
      if (typeof flags.desc === 'string') extraArgs.desc = flags.desc;
      if (typeof flags.tags === 'string') {
        extraArgs.tags = flags.tags.split(',').map((s) => s.trim()).filter(Boolean);
      }
      if (typeof flags.thumbnail === 'string') extraArgs.thumbnail = flags.thumbnail;
      if (typeof flags.schedule === 'string') extraArgs.scheduleAt = Number(flags.schedule);
      if (typeof flags.tid === 'string') extraArgs.bilibiliTid = Number(flags.tid);
      if (flags.headful === true) extraArgs.headless = false;
      return runGenerationCommand({
        toolName: 'lingji_publish_video',
        flags: { ...flags, project: projectPath },
        client,
        extraArgs,
      });
    }
    case 'meta': {
      const extraArgs: Record<string, unknown> = {};
      if (flags.force === true) extraArgs.force = true;
      return runGenerationCommand({
        toolName: 'lingji_generate_publish_metadata',
        flags,
        client,
        extraArgs,
      });
    }
    default:
      throw new CliError(
        `未知 publish 子命令: ${action ?? '(空)'}（支持 accounts/check/run/meta；账号登录在应用发布页完成）`,
        'bad_args',
        2,
      );
  }
}
