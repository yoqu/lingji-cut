import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDirectorPlan } from '../../../src/lib/director-planning';
import { parseSrt } from '../../../src/lib/srt-parser';
import type { DirectorPlan, ProjectProductionState } from '../../../src/types/director';
import { loadEffectivePromptTemplate } from '../../prompts-io';
import { loadProjectFile, mutateProjectProduction } from '../../project-file';
import { loadFullHeadlessAISettings, loadHeadlessProjectBindings } from '../headless-settings';
import { GenerationError } from '../generation-error';
import type { GenerationRunCtx } from '../headless-generation';

function nextRevision(production: ProjectProductionState | undefined): number {
  if (production?.draftPlan) return production.draftPlan.revision;
  return (production?.approvedPlan?.revision ?? 0) + 1;
}

async function readSubtitleEntries(projectPath: string) {
  let source: string;
  try {
    source = await readFile(join(projectPath, 'podcast-subtitles.srt'), 'utf-8');
  } catch {
    throw new GenerationError(
      'no_subtitles',
      '未找到 podcast-subtitles.srt，请先生成音频/字幕。',
    );
  }
  const entries = parseSrt(source);
  if (entries.length === 0) throw new GenerationError('empty_subtitles', '字幕为空。');
  return entries;
}

function reportPlanProgress(
  handle: GenerationRunCtx['handle'],
  phase: 'planning' | 'motion-bible',
  percent: number,
): void {
  const base = phase === 'planning' ? 15 : 70;
  const scale = phase === 'planning' ? 0.55 : 0.25;
  handle.update({
    phase: phase === 'planning' ? '分析内容结构' : '制定 Motion Bible',
    percent: Math.round(base + percent * scale),
  });
}

async function loadPlanDependencies(userDataPath: string, projectPath: string) {
  return Promise.all([
    loadFullHeadlessAISettings(userDataPath),
    loadHeadlessProjectBindings(projectPath),
    loadEffectivePromptTemplate('planning.segment', { userDataPath, projectDir: projectPath }),
    loadEffectivePromptTemplate('production.director', { userDataPath, projectDir: projectPath }),
    loadEffectivePromptTemplate('motion.bible', { userDataPath, projectDir: projectPath }),
  ]);
}

export async function runDirectorPlanHeadless(ctx: GenerationRunCtx): Promise<DirectorPlan> {
  const { projectPath, userDataPath, handle } = ctx;
  const project = await loadProjectFile(projectPath);
  const revision = nextRevision(project.production);
  await mutateProjectProduction(projectPath, {
    kind: 'set-workflow',
    stage: 'director-planning',
    mode: ctx.params?.mode === 'auto' ? 'auto' : 'director',
    taskId: handle.taskId,
  });
  try {
    handle.update({ phase: '读取字幕', percent: 5 });
    const entries = await readSubtitleEntries(projectPath);
    const [settings, projectBindings, planningTemplate, directorTemplate, motionBibleTemplate] =
      await loadPlanDependencies(userDataPath, projectPath);
    handle.update({ phase: '制定导演方案', percent: 15 });
    const plan = await createDirectorPlan(entries, settings, {
      revision,
      globalPrompt:
        typeof ctx.params?.globalPrompt === 'string' ? ctx.params.globalPrompt.trim() : undefined,
      stylePresetId: project.stylePresetId,
      planningTemplate,
      directorTemplate,
      motionBibleTemplate,
      projectBindings,
      onProgress: (phase, percent) => reportPlanProgress(handle, phase, percent),
    });
    handle.update({ phase: '保存草案', percent: 96 });
    await mutateProjectProduction(projectPath, { kind: 'replace-draft', plan });
    handle.update({ phase: '等待导演批准', percent: 100 });
    return plan;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await mutateProjectProduction(projectPath, {
      kind: 'set-workflow',
      stage: 'error',
      error: message,
    });
    throw error;
  }
}

export async function runDirectorApproveHeadless(
  ctx: GenerationRunCtx,
): Promise<ProjectProductionState> {
  const { projectPath, handle } = ctx;
  const project = await loadProjectFile(projectPath);
  const draft = project.production?.draftPlan;
  if (!draft) {
    throw new GenerationError('director_plan_required', '没有待批准的导演方案，请先运行 director plan。');
  }
  const requested = ctx.params?.revision;
  const revision = typeof requested === 'number' ? requested : draft.revision;
  handle.update({ phase: '批准导演方案', percent: 30 });
  const production = await mutateProjectProduction(projectPath, {
    kind: 'approve-draft',
    expectedRevision: revision,
    taskId: handle.taskId,
  });
  handle.update({ phase: '制作已启动', percent: 100 });
  return production;
}
