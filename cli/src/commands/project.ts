// cli/src/commands/project.ts
import type { ToolCaller } from '../client';
import { CliError } from '../errors';

export async function runProjectCommand(
  action: string | undefined,
  positionals: string[],
  flags: Record<string, string | boolean>,
  client: ToolCaller,
): Promise<unknown> {
  switch (action) {
    case 'current':
      return client.call('lingji_get_active_project', {});
    case 'list':
      return client.call('lingji_list_recent_projects', {});
    case 'open': {
      const path = positionals[0];
      if (!path) throw new CliError('用法: lingji project open <path>', 'bad_args', 2);
      return client.call('lingji_open_project', { path });
    }
    case 'create': {
      const path = positionals[0];
      if (!path) throw new CliError('用法: lingji project create <path> [--name <n>]', 'bad_args', 2);
      const options: Record<string, unknown> = {};
      if (typeof flags.name === 'string') options.name = flags.name;
      return client.call('lingji_create_project', {
        path,
        ...(Object.keys(options).length ? { options } : {}),
      });
    }
    default:
      throw new CliError(
        `未知 project 子命令: ${action ?? '(空)'}（支持 current/list/open/create）`,
        'bad_args',
        2,
      );
  }
}
