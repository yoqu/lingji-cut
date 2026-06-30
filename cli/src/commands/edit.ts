import type { ToolCaller } from '../client';
import { CliError } from '../errors';
import { resolveProjectPath } from '../project-resolve';

function scopeFlag(flags: Record<string, string | boolean>): 'video' | 'script' {
  const scope = flags.scope;
  if (scope === 'video' || scope === 'script') return scope;
  throw new CliError('需要 --scope video|script', 'bad_args', 2);
}

function optionalNumber(value: string | boolean | undefined): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function runEditCommand(
  action: string | undefined,
  flags: Record<string, string | boolean>,
  client: ToolCaller,
): Promise<unknown> {
  switch (action) {
    case 'lock': {
      const projectPath = await resolveProjectPath(flags, client);
      const payload: Record<string, unknown> = {
        projectPath,
        scope: scopeFlag(flags),
      };
      if (typeof flags.owner === 'string') payload.owner = flags.owner;
      if (typeof flags.reason === 'string') payload.reason = flags.reason;
      const ttlMs = optionalNumber(flags.ttl);
      if (ttlMs) payload.ttlMs = ttlMs;
      return client.call('lingji_edit_lock', payload);
    }
    case 'unlock': {
      const projectPath = await resolveProjectPath(flags, client);
      return client.call('lingji_edit_unlock', { projectPath });
    }
    case 'heartbeat': {
      const projectPath = await resolveProjectPath(flags, client);
      return client.call('lingji_edit_heartbeat', { projectPath });
    }
    case 'status': {
      return client.call('lingji_edit_lock_status', {});
    }
    default:
      throw new CliError(
        `未知 edit 子命令: ${action ?? '(空)'}（支持 lock/unlock/heartbeat/status）`,
        'bad_args',
        2,
      );
  }
}
