// cli/src/commands/state.ts
import type { ToolCaller } from '../client';
import { resolveProjectPath } from '../project-resolve';

/** lingji state：默认项目产物状态；--editor/--context/--files/--settings 查其他状态面 */
export async function runStateCommand(
  flags: Record<string, string | boolean>,
  client: ToolCaller,
): Promise<unknown> {
  if (flags.editor === true) return client.call('lingji_get_editor_state', {});
  if (flags.context === true) return client.call('lingji_get_project_context', {});
  if (flags.settings === true) return client.call('lingji_get_settings', {});
  if (flags.files === true) {
    const args: Record<string, unknown> = {};
    if (typeof flags.dir === 'string') args.directory = flags.dir;
    return client.call('lingji_list_project_files', args);
  }
  const projectPath = await resolveProjectPath(flags, client);
  return client.call('lingji_get_project_state', { projectPath });
}
