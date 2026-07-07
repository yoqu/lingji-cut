// cli/src/index.ts
import { parseArgs } from './args';
import { resolveEndpoint } from './endpoint';
import { connectClient, type ToolCaller } from './client';
import { output } from './format';
import { buildHelp } from './manifest';
import { runProjectCommand } from './commands/project';
import { runTaskCommand } from './commands/task';
import { runAudioCommand } from './commands/audio';
import { runSubtitleCommand } from './commands/subtitle';
import { runCardsCommand } from './commands/cards';
import { runCoverCommand } from './commands/cover';
import { runEditCommand } from './commands/edit';
import { runExportCommand } from './commands/export';
import { runStateCommand } from './commands/state';
import { runImportCommand } from './commands/import';
import { runScriptCommand } from './commands/script';
import { runSettingsCommand } from './commands/settings';
import { runRunCommand } from './commands/run';
import { runPublishCommand } from './commands/publish';
import { CliError } from './errors';

async function dispatch(
  group: string,
  action: string | undefined,
  positionals: string[],
  flags: Record<string, string | boolean>,
  client: ToolCaller,
): Promise<unknown> {
  switch (group) {
    case 'project':
      return runProjectCommand(action, positionals, flags, client);
    case 'task':
      return runTaskCommand(action, positionals, flags, client);
    case 'audio':
      return runAudioCommand(action, flags, client);
    case 'subtitle':
      return runSubtitleCommand(action, flags, client);
    case 'cards':
      return runCardsCommand(action, positionals, flags, client);
    case 'cover':
      return runCoverCommand(action, flags, client);
    case 'edit':
      return runEditCommand(action, flags, client);
    case 'export':
      return runExportCommand(flags, client);
    case 'state':
      return runStateCommand(flags, client);
    case 'import':
      return runImportCommand(action, flags, client);
    case 'script':
      return runScriptCommand(action, positionals, client);
    case 'settings':
      return runSettingsCommand(action, positionals, client);
    case 'run':
      return runRunCommand(flags, client);
    case 'publish':
      return runPublishCommand(action, positionals, flags, client);
    default:
      throw new CliError(
        `未知命令组: ${group}（支持 project/state/import/script/task/audio/subtitle/edit/cards/cover/publish/settings/run/export）`,
        'bad_args',
        2,
      );
  }
}

function fail(err: unknown, json: boolean): number {
  const e = err as CliError;
  const message = e?.message ?? String(err);
  if (json) {
    process.stderr.write(JSON.stringify({ error: message, code: e?.code ?? 'unknown_error' }) + '\n');
  } else {
    process.stderr.write(`错误: ${message}\n`);
  }
  return typeof e?.exitCode === 'number' ? e.exitCode : 1;
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const json = parsed.flags.json === true;

  if (!parsed.group || parsed.group === 'help' || parsed.flags.help === true) {
    process.stdout.write(buildHelp());
    return 0;
  }

  const endpoint = resolveEndpoint({
    serverFlag: typeof parsed.flags.server === 'string' ? parsed.flags.server : undefined,
    tokenFlag: typeof parsed.flags.token === 'string' ? parsed.flags.token : undefined,
  });

  let client: ToolCaller;
  try {
    client = await connectClient(endpoint);
  } catch (err) {
    return fail(err, json);
  }

  try {
    const result = await dispatch(parsed.group, parsed.action, parsed.positionals, parsed.flags, client);
    process.stdout.write(output(result, json) + '\n');
    return 0;
  } catch (err) {
    return fail(err, json);
  } finally {
    await client.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`致命错误: ${err?.message ?? String(err)}\n`);
    process.exit(1);
  },
);
