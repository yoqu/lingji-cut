import { generateScriptDraft } from './script-utils';
import type { AutoWorkflowParams } from '../store/ai';

export interface RunScriptGeneratingInput {
  originalText: string;
  projectDir: string;
  params: AutoWorkflowParams;
  signal?: AbortSignal;
}

/**
 * 自动模式下的写稿步骤：
 * - 调 LLM 生成口播稿（非流式，无虚拟光标动画）
 * - 落盘 script.md
 * - 返回生成文本，供后续 TTS 阶段使用
 */
export async function runScriptGenerating(input: RunScriptGeneratingInput): Promise<string> {
  const text = input.originalText.trim();
  if (!text) {
    throw new Error('原始素材为空');
  }
  if (!input.projectDir) {
    throw new Error('未选择项目目录');
  }

  const generated = await generateScriptDraft(
    text,
    input.params.templateId,
    input.params.roleId,
    input.signal,
  );
  await window.electronAPI.saveScriptFile(input.projectDir, 'script.md', generated);
  return generated;
}
