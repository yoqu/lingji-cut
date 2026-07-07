// cli/src/commands/cards.ts
import type { ToolCaller } from '../client';
import { runGenerationCommand } from './generation';
import { resolveProjectPath } from '../project-resolve';
import { CliError } from '../errors';

const UPDATE_FIELDS: Record<string, 'string' | 'boolean' | 'number'> = {
  title: 'string', enabled: 'boolean', 'display-mode': 'string',
  start: 'number', end: 'number', duration: 'number',
  template: 'string', 'style-preset': 'string', 'card-prompt': 'string',
};
const FIELD_TO_ARG: Record<string, string> = {
  title: 'title', enabled: 'enabled', 'display-mode': 'displayMode',
  start: 'startMs', end: 'endMs', duration: 'displayDurationMs',
  template: 'template', 'style-preset': 'stylePresetId', 'card-prompt': 'cardPrompt',
};

function requireId(positionals: string[]): string {
  const id = positionals[0];
  if (!id) throw new CliError('需要 cardId：lingji cards <show|update|regenerate|regen-media|convert|delete> <cardId>', 'bad_args', 2);
  return id;
}

export async function runCardsCommand(
  action: string | undefined,
  positionals: string[],
  flags: Record<string, string | boolean>,
  client: ToolCaller,
): Promise<unknown> {
  switch (action) {
    case 'context': {
      const projectPath = await resolveProjectPath(flags, client);
      const payload: Record<string, unknown> = {
        projectPath,
      };
      if (typeof flags.card === 'string') payload.cardId = flags.card;
      if (typeof flags.segment === 'string') payload.segmentId = flags.segment;
      if (typeof flags['visual-type'] === 'string') payload.visualType = flags['visual-type'];
      return client.call('lingji_get_card_context', payload);
    }
    case 'list': {
      const projectPath = await resolveProjectPath(flags, client);
      return client.call('lingji_list_cards', { projectPath });
    }
    case 'show': {
      const projectPath = await resolveProjectPath(flags, client);
      return client.call('lingji_get_card', { projectPath, cardId: requireId(positionals) });
    }
    case 'update': {
      const projectPath = await resolveProjectPath(flags, client);
      const cardId = requireId(positionals);
      const updates: Record<string, unknown> = {};
      for (const [flag, type] of Object.entries(UPDATE_FIELDS)) {
        if (!(flag in flags)) continue;
        const raw = flags[flag];
        const arg = FIELD_TO_ARG[flag];
        if (type === 'boolean') updates[arg] = raw === true || raw === 'true';
        else if (type === 'number') updates[arg] = Number(raw);
        else updates[arg] = String(raw);
      }
      return client.call('lingji_update_card', { projectPath, cardId, ...updates });
    }
    case 'delete': {
      const projectPath = await resolveProjectPath(flags, client);
      return client.call('lingji_delete_card', { projectPath, cardId: requireId(positionals) });
    }
    case 'validate': {
      const projectPath = await resolveProjectPath(flags, client);
      const cardId = requireId(positionals);
      return client.call('lingji_validate_card', { projectPath, cardId });
    }
    case 'regenerate':
      return runGenerationCommand({ toolName: 'lingji_regenerate_card', flags, client, extraArgs: { cardId: requireId(positionals) } });
    case 'sculpt': {
      const extraArgs: Record<string, unknown> = { cardId: requireId(positionals) };
      if (typeof flags.notes === 'string' && flags.notes.trim()) extraArgs.notes = flags.notes.trim();
      return runGenerationCommand({ toolName: 'lingji_sculpt_card', flags, client, extraArgs });
    }
    case 'regen-media':
      return runGenerationCommand({ toolName: 'lingji_regenerate_card_media', flags, client, extraArgs: { cardId: requireId(positionals) } });
    case 'convert': {
      const to = typeof flags.to === 'string' ? flags.to : '';
      if (!['image', 'video', 'motion'].includes(to)) throw new CliError('convert 需要 --to image|video|motion', 'bad_args', 2);
      return runGenerationCommand({ toolName: 'lingji_convert_card', flags, client, extraArgs: { cardId: requireId(positionals), to } });
    }
    default:
      throw new CliError(`未知 cards 子命令: ${action ?? '(空)'}（支持 context/list/show/update/validate/regenerate/sculpt/regen-media/convert/delete；生成卡片用 subtitle analyze）`, 'bad_args', 2);
  }
}
