// cli/src/commands/cover.ts
import type { ToolCaller } from '../client';
import { runGenerationCommand } from './generation';
import { CliError } from '../errors';

const STEP_MAP: Record<string, string> = {
  prompts: 'lingji_generate_cover_prompts',
  images: 'lingji_generate_cover_images',
};

/** lingji cover gen [--step prompts|images]：默认一次性生成，--step 分步 */
export async function runCoverCommand(
  action: string | undefined,
  flags: Record<string, string | boolean>,
  client: ToolCaller,
): Promise<unknown> {
  if (action !== 'gen') {
    throw new CliError(`未知 cover 子命令: ${action ?? '(空)'}（支持 gen [--step prompts|images]）`, 'bad_args', 2);
  }
  let tool = 'lingji_generate_covers';
  if (typeof flags.step === 'string') {
    tool = STEP_MAP[flags.step];
    if (!tool) throw new CliError('--step 仅支持 prompts|images', 'bad_args', 2);
  }
  return runGenerationCommand({ toolName: tool, flags, client });
}
