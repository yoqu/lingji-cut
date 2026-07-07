// cli/src/commands/import.ts
import type { ToolCaller } from '../client';
import { resolveProjectPath } from '../project-resolve';
import { CliError } from '../errors';

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']);
const TERMINAL = new Set(['done', 'error']);

function inferSourceType(source: string, typeFlag?: string): 'douyin' | 'local_video' | 'local_audio' {
  if (typeFlag === 'douyin') return 'douyin';
  if (typeFlag === 'audio') return 'local_audio';
  if (typeFlag === 'video') return 'local_video';
  if (/^https?:\/\//.test(source)) return 'douyin';
  const ext = source.slice(source.lastIndexOf('.')).toLowerCase();
  return AUDIO_EXTS.has(ext) ? 'local_audio' : 'local_video';
}

export interface ImportOptions {
  sleep?: (ms: number) => Promise<void>;
}

/** lingji import <url|file>：启动导入；--wait 轮询到 done/error */
export async function runImportCommand(
  source: string | undefined,
  flags: Record<string, string | boolean>,
  client: ToolCaller,
  opts: ImportOptions = {},
): Promise<unknown> {
  if (!source) {
    throw new CliError('用法: lingji import <抖音链接|本地媒体文件> [--type douyin|video|audio] [--wait]', 'bad_args', 2);
  }
  const projectDir = await resolveProjectPath(flags, client);
  const sourceType = inferSourceType(source, typeof flags.type === 'string' ? flags.type : undefined);
  const args: Record<string, unknown> = { sourceType, projectDir };
  if (sourceType === 'douyin') args.url = source;
  else args.filePath = source;

  const progress = (await client.call('lingji_start_video_import', args)) as {
    importId?: string;
    status?: string;
  };
  if (!progress?.importId || flags.wait !== true) return progress;

  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (;;) {
    const snapshot = (await client.call('lingji_get_video_import_status', {
      importId: progress.importId,
    })) as { status?: string; progress?: number; stepLabel?: string; error?: string };
    process.stderr.write(
      `[import] ${snapshot.status} ${snapshot.progress ?? 0}% ${snapshot.stepLabel ?? ''}\n`,
    );
    if (snapshot.status && TERMINAL.has(snapshot.status)) {
      if (snapshot.status === 'error') {
        throw new CliError(snapshot.error ?? '导入失败', 'import_failed');
      }
      return snapshot;
    }
    await sleep(1000);
  }
}
