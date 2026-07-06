import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { regenerateCoverPrompt } from '../../../src/lib/ai-analysis';
import { generateCoverCandidates } from '../../../src/lib/cover-generation';
import { createPersistedAIState } from '../../../src/lib/ai-persistence';
import { resolvePromptBinding } from '../../../src/lib/llm/binding-resolver';
import { parseSrt } from '../../../src/lib/srt-parser';
import { loadFullHeadlessAISettings, loadHeadlessProjectBindings } from '../headless-settings';
import { GenerationError } from '../generation-error';
import { HeadlessProjectContext } from '../context';
import { loadEffectivePromptTemplate } from '../../prompts-io';
import { loadProjectFile } from '../../project-file';
import { resolveWorkTitle } from '../../../src/lib/project-persistence';
import type { GenerationRunCtx } from '../headless-generation';
import type { SrtEntry } from '../../../src/types';
import type { AISettings, CoverCandidate, ImageProvider } from '../../../src/types/ai';
import type { ImageGenerationContext } from '../../../src/lib/image-gen/types';

async function readEntries(projectPath: string): Promise<SrtEntry[]> {
  let srt: string;
  try {
    srt = await readFile(join(projectPath, 'podcast-subtitles.srt'), 'utf-8');
  } catch {
    throw new GenerationError('no_subtitles', '未找到 podcast-subtitles.srt，请先生成音频/字幕。');
  }
  return parseSrt(srt);
}

interface PromptDeps {
  regenerate?: (
    entries: SrtEntry[],
    settings: AISettings,
    opts: Parameters<typeof regenerateCoverPrompt>[2],
  ) => Promise<string[]>;
}

/**
 * 生成封面提示词并写入 analysisResult.coverPrompts（需已存在分析）。
 *
 * 装配照搬 electron/main.ts 的 `regenerate-cover-prompt` IPC 处理体：
 * coverTemplate（cover.regeneration 模板）+ projectStylePresetId（项目 project.json
 * 的 stylePresetId）+ defaultStylePresetId（settings）+ globalPrompt（analysisResult）
 * + currentPrompt（现有第一条封面提示词）+ projectBindings。
 */
export async function runCoverPromptHeadless(
  ctx: GenerationRunCtx,
  deps: PromptDeps = {},
): Promise<string[]> {
  const regenerate = deps.regenerate ?? regenerateCoverPrompt;
  const { projectPath, userDataPath, handle } = ctx;

  handle.update({ phase: '装配设置', percent: 10 });
  const settings = await loadFullHeadlessAISettings(userDataPath);
  const projectBindings = await loadHeadlessProjectBindings(projectPath);
  const project = await loadProjectFile(projectPath);
  const analysisResult = project.aiAnalysis?.analysisResult ?? null;
  if (!analysisResult) {
    throw new GenerationError('need_analysis', '尚无分析结果，请先运行 subtitle analyze 再生成封面提示词。');
  }
  const entries = await readEntries(projectPath);
  if (entries.length === 0) {
    throw new GenerationError('empty_subtitles', '字幕为空。');
  }
  const coverTemplate = await loadEffectivePromptTemplate('cover.regeneration', {
    userDataPath,
    projectDir: projectPath,
  });

  handle.update({ phase: '生成提示词', percent: 40 });
  const prompts = await regenerate(entries, settings, {
    globalPrompt: analysisResult.globalPrompt,
    // 项目级默认风格：取自 project.json（loadProjectStylePresetId 等价），缺省时 undefined。
    projectStylePresetId: project.stylePresetId,
    defaultStylePresetId: settings.defaultStylePresetId,
    currentPrompt: analysisResult.coverPrompts?.[0],
    coverTemplate,
    projectBindings,
    workTitle: resolveWorkTitle(project) || undefined,
  });

  handle.update({ phase: '写入', percent: 90 });
  const headless = new HeadlessProjectContext(projectPath);
  const persisted = createPersistedAIState(
    { ...analysisResult, coverPrompts: prompts },
    project.aiAnalysis?.coverCandidates ?? [],
  );
  await headless.saveSection('aiAnalysis', {
    analysisResult: persisted.analysisResult,
    coverCandidates: persisted.coverCandidates,
  });
  handle.update({ phase: '完成', percent: 100 });
  return prompts;
}

interface ImagesDeps {
  generate?: (
    prompts: string[],
    provider: ImageProvider,
    model: string,
    coversDir: string,
    ctx: ImageGenerationContext,
  ) => Promise<CoverCandidate[]>;
}

/**
 * 由现有 coverPrompts 出封面图并写入 coverCandidates。
 *
 * 装配照搬 electron/main.ts 的 `generate-cover-images` IPC 处理体：
 * resolvePromptBinding('cover.regeneration', …) 取 imageProvider/imageModel，
 * 守卫缺失绑定，合并 globalCoverImagePrompt 后缀（`${prompt.trim()}\n${suffix}`），
 * 计算 coversDir = <project>/covers，调用 generateCoverCandidates(prompts,
 * provider, model, coversDir, ctx)。ctx = { taskId, signal, onProgress }。
 */
export async function runCoverImagesHeadless(
  ctx: GenerationRunCtx,
  deps: ImagesDeps = {},
): Promise<CoverCandidate[]> {
  const generate = deps.generate ?? generateCoverCandidates;
  const { projectPath, userDataPath, handle } = ctx;

  handle.update({ phase: '装配设置', percent: 10 });
  const settings = await loadFullHeadlessAISettings(userDataPath);
  const projectBindings = await loadHeadlessProjectBindings(projectPath);
  const project = await loadProjectFile(projectPath);
  const analysisResult = project.aiAnalysis?.analysisResult ?? null;
  const prompts = (analysisResult?.coverPrompts ?? []).filter(Boolean);
  if (prompts.length === 0) {
    throw new GenerationError('no_cover_prompts', '没有封面提示词，请先生成封面提示词。');
  }

  const binding = resolvePromptBinding('cover.regeneration', settings, projectBindings);
  if (!binding.imageProvider || !binding.imageModel) {
    throw new GenerationError('no_image_provider', 'cover.regeneration 未绑定 ImageProvider/Model。');
  }

  // 后缀合并：与 main.ts generate-cover-images 一致，使用换行拼接并 trim 原提示词。
  const coverSuffix = (settings.globalCoverImagePrompt ?? '').trim();
  const mergedPrompts = prompts.map((prompt) =>
    coverSuffix ? `${prompt.trim()}\n${coverSuffix}` : prompt,
  );
  const total = mergedPrompts.length;
  const coversDir = join(projectPath, 'covers');

  handle.update({ phase: '生成封面图', percent: 30 });
  const candidates = await generate(mergedPrompts, binding.imageProvider, binding.imageModel, coversDir, {
    taskId: handle.taskId,
    signal: handle.signal,
    onProgress: (update) =>
      handle.update({
        phase: update.phase ?? '生成封面图',
        percent: 30 + Math.round(((update.percent ?? 0) / 100) * 60),
        message: update.message ? `${update.message}（共 ${total} 张）` : undefined,
      }),
  });

  handle.update({ phase: '写入', percent: 95 });
  const headless = new HeadlessProjectContext(projectPath);
  const persisted = createPersistedAIState(analysisResult, candidates);
  await headless.saveSection('aiAnalysis', {
    analysisResult: persisted.analysisResult,
    coverCandidates: persisted.coverCandidates,
  });
  handle.update({ phase: '完成', percent: 100 });
  return candidates;
}

/** 先生成封面提示词，再出图（一次性）。 */
export async function runCoversHeadless(ctx: GenerationRunCtx): Promise<CoverCandidate[]> {
  await runCoverPromptHeadless(ctx);
  return runCoverImagesHeadless(ctx);
}
