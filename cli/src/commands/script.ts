// cli/src/commands/script.ts
import { readFileSync } from 'node:fs';
import type { ToolCaller } from '../client';
import { CliError } from '../errors';

/** lingji script read/review：文稿读取与审稿批注（写稿走 file-first，不设写命令） */
export async function runScriptCommand(
  action: string | undefined,
  positionals: string[],
  client: ToolCaller,
): Promise<unknown> {
  switch (action) {
    case 'read': {
      const args: Record<string, unknown> = {};
      if (positionals[0]) args.filePath = positionals[0];
      return client.call('lingji_read_script', args);
    }
    case 'review': {
      const file = positionals[0];
      if (!file) {
        throw new CliError('用法: lingji script review <annotations.json>', 'bad_args', 2);
      }
      let payload: {
        filePath?: string;
        summary?: string;
        score?: number;
        annotations?: unknown[];
      };
      try {
        payload = JSON.parse(readFileSync(file, 'utf-8'));
      } catch (err) {
        throw new CliError(
          `读取批注文件失败: ${err instanceof Error ? err.message : String(err)}`,
          'bad_args',
          2,
        );
      }
      if (!Array.isArray(payload.annotations) || payload.annotations.length === 0) {
        throw new CliError('批注文件必须包含非空 annotations 数组', 'bad_args', 2);
      }
      return client.call('lingji_review_script', payload as Record<string, unknown>);
    }
    default:
      throw new CliError(
        `未知 script 子命令: ${action ?? '(空)'}（支持 read/review）`,
        'bad_args',
        2,
      );
  }
}
