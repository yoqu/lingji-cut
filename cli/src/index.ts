// cli/src/index.ts
import { parseArgs } from './args';
import { resolveServerUrl } from './endpoint';
import { connectClient, type ToolCaller } from './client';
import { output } from './format';
import { runProjectCommand } from './commands/project';
import { runTaskCommand } from './commands/task';
import { runAudioCommand } from './commands/audio';
import { runSubtitleCommand } from './commands/subtitle';
import { runCardsCommand } from './commands/cards';
import { runCoverCommand } from './commands/cover';
import { runEditCommand } from './commands/edit';
import { runExportCommand } from './commands/export';
import { CliError } from './errors';

const HELP = `灵机 CLI (lingji)

用法:
  lingji project current            显示应用当前活动项目
  lingji project list               列出最近项目
  lingji project open <path>        校验并显示项目状态
  lingji task status <id>           查询任务状态
  lingji task list [--project <p>]  列出任务
  lingji task cancel <id>           取消任务
  lingji task wait <id>             轮询任务直到完成
  lingji audio gen [--project <p>] [--wait]   生成口播音频(TTS)
  lingji subtitle analyze [--wait]            字幕分析 + 卡片生成
  lingji edit lock --scope video|script [--project <p>] [--reason <text>]
  lingji edit unlock|heartbeat|status [--project <p>]
  lingji cards context [--card <id>|--segment <id>] [--visual-type motion|image]
  lingji cards gen|list|show|update|validate|regenerate|regen-media|convert|delete [<cardId>] [字段/--to/--wait]
  lingji cover prompt|image|gen [--wait]      封面提示词 / 出图 / 一次性
  lingji export [--out <file>] [--wait]       导出 MP4

全局开关:
  --json                JSON 输出
  --server <url>        覆盖 MCP 服务地址
`;

async function dispatch(
  group: string,
  action: string | undefined,
  positionals: string[],
  flags: Record<string, string | boolean>,
  client: ToolCaller,
): Promise<unknown> {
  switch (group) {
    case 'project':
      return runProjectCommand(action, positionals, client);
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
    default:
      throw new CliError(`未知命令组: ${group}（支持 project/task/audio/subtitle/edit/cards/cover/export）`, 'bad_args', 2);
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
    process.stdout.write(HELP);
    return 0;
  }

  const url = resolveServerUrl({
    serverFlag: typeof parsed.flags.server === 'string' ? parsed.flags.server : undefined,
  });

  let client: ToolCaller;
  try {
    client = await connectClient(url);
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
