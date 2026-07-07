// cli/src/commands/run.ts
import type { ToolCaller } from '../client';
import { resolveProjectPath } from '../project-resolve';
import { waitForTask } from './task';
import { CliError } from '../errors';

const STEPS = [
  { key: 'audio', tool: 'lingji_generate_audio' },
  { key: 'analyze', tool: 'lingji_analyze_subtitles' },
  { key: 'cover', tool: 'lingji_generate_covers' },
] as const;

export interface RunOptions {
  sleep?: (ms: number) => Promise<void>;
}

/** lingji run：一键流水线 音频→分析→封面，--export 追加导出；--from 断点续跑 */
export async function runRunCommand(
  flags: Record<string, string | boolean>,
  client: ToolCaller,
  opts: RunOptions = {},
): Promise<unknown> {
  const projectPath = await resolveProjectPath(flags, client);
  const from = typeof flags.from === 'string' ? flags.from : 'audio';
  const startIndex = STEPS.findIndex((s) => s.key === from);
  if (startIndex === -1) {
    throw new CliError('--from 仅支持 audio|analyze|cover', 'bad_args', 2);
  }

  const results: Record<string, unknown> = {};
  const steps = [...STEPS.slice(startIndex).map((s) => ({ ...s })) ] as Array<{ key: string; tool: string }>;
  if (flags.export === true) steps.push({ key: 'export', tool: 'lingji_export_video' });

  for (const step of steps) {
    process.stderr.write(`[run] ▶ ${step.key}\n`);
    const started = (await client.call(step.tool, { projectPath })) as { taskId?: string };
    if (!started?.taskId) {
      results[step.key] = started;
      continue;
    }
    const task = (await waitForTask(started.taskId, client, {
      sleep: opts.sleep,
      onUpdate: (t) => {
        const info = t as { status?: string; progress?: { percent?: number; phase?: string } };
        process.stderr.write(
          `[run:${step.key}] ${info.status} ${info.progress?.percent ?? 0}% ${info.progress?.phase ?? ''}\n`,
        );
      },
    })) as { status?: string; error?: string };
    if (task.status !== 'succeeded') {
      throw new CliError(
        `流水线在 ${step.key} 步失败: ${task.error ?? task.status}`,
        'step_failed',
      );
    }
    results[step.key] = task;
  }
  return { projectPath, steps: Object.keys(results), results };
}
