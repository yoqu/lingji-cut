// cli/src/commands/settings.ts
import type { ToolCaller } from '../client';
import { CliError } from '../errors';

function coerce(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return value;
}

/** lingji settings show/set：读取与白名单写入全局默认设置 */
export async function runSettingsCommand(
  action: string | undefined,
  positionals: string[],
  client: ToolCaller,
): Promise<unknown> {
  switch (action) {
    case 'show':
      return client.call('lingji_get_settings', {});
    case 'set': {
      const [key, value] = positionals;
      if (!key || value === undefined) {
        throw new CliError('用法: lingji settings set <key> <value>', 'bad_args', 2);
      }
      return client.call('lingji_update_settings', { updates: { [key]: coerce(value) } });
    }
    default:
      throw new CliError(
        `未知 settings 子命令: ${action ?? '(空)'}（支持 show/set）`,
        'bad_args',
        2,
      );
  }
}
