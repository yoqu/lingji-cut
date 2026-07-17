import { join } from 'node:path';
import { regenerateCoverPrompt } from '../../src/lib/ai-analysis';
import { generateCoverCandidates } from '../../src/lib/cover-generation';
import { resolvePromptBinding } from '../../src/lib/llm/binding-resolver';
import { resolveWorkTitle } from '../../src/lib/project-persistence';
import type { SrtEntry } from '../../src/types';
import type { AIAnalysisResult, AISettings, CoverCandidate } from '../../src/types/ai';
import type { DirectorPlan } from '../../src/types/director';
import { loadEffectivePromptTemplate } from '../prompts-io';
import { loadProjectFile } from '../project-file';
import { GenerationError } from './generation-error';
import { loadHeadlessProjectBindings } from './headless-settings';

export interface HeadlessCoverResult {
  prompts: string[];
  candidates: CoverCandidate[];
}

export async function runHeadlessDirectorCover(options: {
  projectPath: string;
  userDataPath: string;
  taskId: string;
  signal: AbortSignal;
  entries: SrtEntry[];
  settings: AISettings;
  plan: DirectorPlan;
  analysis: AIAnalysisResult;
  onProgress?: (percent: number, message: string) => void;
}): Promise<HeadlessCoverResult> {
  const project = await loadProjectFile(options.projectPath);
  const [projectBindings, coverTemplate] = await Promise.all([
    loadHeadlessProjectBindings(options.projectPath),
    loadEffectivePromptTemplate('cover.regeneration', {
      userDataPath: options.userDataPath,
      projectDir: options.projectPath,
    }),
  ]);
  options.onProgress?.(10, '生成封面提示词');
  const prompts = await regenerateCoverPrompt(options.entries, options.settings, {
    globalPrompt: options.plan.globalPrompt,
    projectStylePresetId: project.stylePresetId,
    defaultStylePresetId: options.settings.defaultStylePresetId,
    currentPrompt: options.plan.coverDirection.prompt,
    coverTemplate,
    projectBindings,
    workTitle: resolveWorkTitle(project) || undefined,
  });
  if (options.signal.aborted) throw new DOMException('制作已暂停', 'AbortError');
  const binding = resolvePromptBinding('cover.regeneration', options.settings, projectBindings);
  if (!binding.imageProvider || !binding.imageModel) {
    throw new GenerationError('no_image_provider', 'cover.regeneration 未绑定 ImageProvider/Model。');
  }
  const suffix = (options.settings.globalCoverImagePrompt ?? '').trim();
  const mergedPrompts = prompts.map((prompt) => (
    suffix ? `${prompt.trim()}\n${suffix}` : prompt
  ));
  options.onProgress?.(45, '生成封面图');
  const candidates = await generateCoverCandidates(
    mergedPrompts,
    binding.imageProvider,
    binding.imageModel,
    join(options.projectPath, 'covers'),
    {
      taskId: options.taskId,
      signal: options.signal,
      onProgress: (progress) => options.onProgress?.(
        45 + Math.round(((progress.percent ?? 0) / 100) * 55),
        progress.message ?? '生成封面图',
      ),
    },
  );
  return { prompts, candidates };
}
