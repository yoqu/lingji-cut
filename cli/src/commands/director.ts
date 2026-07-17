import type { ToolCaller } from '../client';
import { CliError } from '../errors';
import { resolveProjectPath } from '../project-resolve';
import { runGenerationCommand } from './generation';

export async function runDirectorCommand(
  action: string | undefined,
  flags: Record<string, string | boolean>,
  client: ToolCaller,
): Promise<unknown> {
  if (action === 'plan') {
    const extraArgs: Record<string, unknown> = {};
    if (typeof flags.prompt === 'string' && flags.prompt.trim()) {
      extraArgs.globalPrompt = flags.prompt.trim();
    }
    return runGenerationCommand({
      toolName: 'lingji_director_plan',
      flags,
      client,
      extraArgs,
    });
  }
  if (action === 'status') {
    const projectPath = await resolveProjectPath(flags, client);
    return client.call('lingji_director_status', { projectPath });
  }
  if (action === 'approve') {
    const extraArgs: Record<string, unknown> = {};
    if (typeof flags.revision === 'string') {
      const revision = Number(flags.revision);
      if (!Number.isInteger(revision) || revision < 1) {
        throw new CliError('--revision 必须为正整数', 'bad_args', 2);
      }
      extraArgs.revision = revision;
    }
    return runGenerationCommand({
      toolName: 'lingji_director_approve',
      flags,
      client,
      extraArgs,
    });
  }
  throw new CliError(
    `未知 director 子命令: ${action ?? '(空)'}（支持 plan/status/approve）`,
    'bad_args',
    2,
  );
}
