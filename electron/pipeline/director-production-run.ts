import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateSubtitleHighlights } from '../../src/lib/subtitle-highlight-runner';
import { syncDirectorPlanMotionBible } from '../../src/lib/director-workflow';
import { buildDirectorExecutionPlan } from '../../src/lib/production-plan';
import { parseSrt } from '../../src/lib/srt-parser';
import type { SrtEntry, SubtitleHighlight } from '../../src/types';
import type { AISettings } from '../../src/types/ai';
import {
  resolveDirectorRenderStrategy,
  type ProjectProductionState,
} from '../../src/types/director';
import { loadProjectFile, mutateProjectProduction, saveProjectSection } from '../project-file';
import { loadFullHeadlessAISettings } from './headless-settings';
import { GenerationError } from './generation-error';
import type { GenerationRunCtx } from './headless-generation';
import { runAnalyzeHeadless } from './runs/analyze-run';
import { runDirectorApproveHeadless } from './runs/director-run';
import { runHeadlessDirectorAudio, type HeadlessAudioResult } from './director-headless-audio';
import { runHeadlessDirectorCover } from './director-headless-cover';
import { buildHeadlessDirectorTimeline } from './director-headless-timeline';
import {
  needsProductionTrack,
  runHeadlessCardsTrack,
  runHeadlessCoverTrack,
} from './director-headless-visual-tracks';
import { runHeadlessFootageTrack } from './director-headless-footage';
import type { FootageTrackResult } from '../../src/types/footage';

interface DirectorProductionRunDeps {
  approve?: typeof runDirectorApproveHeadless;
  cards?: typeof runAnalyzeHeadless;
  covers?: typeof runHeadlessDirectorCover;
  highlights?: typeof generateSubtitleHighlights;
  audio?: typeof runHeadlessDirectorAudio;
}

function guard(revision: number, taskId: string) {
  return { expectedDirectorRevision: revision, expectedTaskId: taskId };
}

async function assertActive(ctx: GenerationRunCtx, revision: number): Promise<ProjectProductionState> {
  if (ctx.handle.signal.aborted) throw new DOMException('制作已暂停', 'AbortError');
  const production = (await loadProjectFile(ctx.projectPath)).production;
  if (production?.approvedPlan?.revision !== revision) {
    throw new GenerationError('director_revision_conflict', '导演方案版本已变化，已丢弃过期制作结果。');
  }
  if (production.workflow.activeTaskId !== ctx.handle.taskId) {
    throw new GenerationError('director_task_conflict', '制作任务已变化，已丢弃过期制作结果。');
  }
  return production;
}

async function readEntries(projectPath: string): Promise<SrtEntry[]> {
  const source = await readFile(join(projectPath, 'podcast-subtitles.srt'), 'utf-8').catch(() => {
    throw new GenerationError('no_subtitles', '未找到 podcast-subtitles.srt，请先生成音频/字幕。');
  });
  const entries = parseSrt(source);
  if (entries.length === 0) throw new GenerationError('empty_subtitles', '字幕为空。');
  return entries;
}

async function setOutput(options: {
  ctx: GenerationRunCtx;
  revision: number;
  output: 'cards' | 'cover' | 'audio' | 'timeline' | 'footage';
  error?: string;
}): Promise<ProjectProductionState> {
  return mutateProjectProduction(options.ctx.projectPath, {
    kind: 'set-output',
    output: options.output,
    state: {
      status: options.error ? 'failed' : 'current',
      directorRevision: options.revision,
      updatedAt: Date.now(),
      error: options.error,
    },
    ...guard(options.revision, options.ctx.handle.taskId),
  });
}

async function stageHeadlessFootageForCardGeneration(options: {
  ctx: GenerationRunCtx;
  production: ProjectProductionState;
  footage: FootageTrackResult;
}): Promise<ProjectProductionState> {
  const { ctx, production, footage } = options;
  if (footage.reused) return production;
  const plan = production.approvedPlan!;
  const revision = plan.revision;
  await mutateProjectProduction(ctx.projectPath, {
    kind: 'set-footage',
    footage: {
      placements: footage.placements,
      compositionInputs: footage.compositionInputs ?? [],
      claimedSegmentIds: footage.claimedSegmentIds,
      fallbacks: footage.fallbacks,
      blockedSegmentIds: footage.blockedSegmentIds ?? [],
      generationProvenance: {
        directorRevision: revision,
        fingerprint: `footage-${plan.inputFingerprint}-${revision}`,
        generatedAt: Date.now(),
        modifiedByUser: false,
      },
    },
    ...guard(revision, ctx.handle.taskId),
  });
  return setOutput({ ctx, revision, output: 'footage', error: footage.error });
}

async function approveOrResume(
  ctx: GenerationRunCtx,
  approve: typeof runDirectorApproveHeadless,
): Promise<ProjectProductionState> {
  const current = (await loadProjectFile(ctx.projectPath)).production;
  if (current?.draftPlan) return approve(ctx);
  const plan = current?.approvedPlan;
  if (!current || !plan) {
    throw new GenerationError('director_plan_required', '没有可批准或恢复的导演方案，请先运行 director plan。');
  }
  const requested = ctx.params?.revision;
  if (typeof requested === 'number' && requested !== plan.revision) {
    throw new GenerationError('director_revision_conflict', `导演方案版本已变化：期望 v${requested}，当前为 v${plan.revision}`);
  }
  return mutateProjectProduction(ctx.projectPath, {
    kind: 'set-workflow',
    stage: 'production-running',
    taskId: ctx.handle.taskId,
    expectedDirectorRevision: plan.revision,
  });
}

async function finalizeWorkflow(
  ctx: GenerationRunCtx,
  revision: number,
): Promise<ProjectProductionState> {
  await mutateProjectProduction(ctx.projectPath, {
    kind: 'set-impact', impact: null, ...guard(revision, ctx.handle.taskId),
  });
  let production = await mutateProjectProduction(ctx.projectPath, {
    kind: 'set-workflow', stage: 'animatic-review', taskId: ctx.handle.taskId,
    ...guard(revision, ctx.handle.taskId),
  });
  if (production.workflow.mode === 'auto') {
    production = await mutateProjectProduction(ctx.projectPath, {
      kind: 'approve-animatic', complete: true, ...guard(revision, ctx.handle.taskId),
    });
  }
  return production;
}

interface ProductionTrackResults {
  footage: FootageTrackResult;
  cards: Awaited<ReturnType<typeof runHeadlessCardsTrack>>;
  cover: Awaited<ReturnType<typeof runHeadlessCoverTrack>>;
  audio: HeadlessAudioResult;
  highlights: { highlights: SubtitleHighlight[]; error?: string };
}

async function runProductionTracks(options: {
  ctx: GenerationRunCtx;
  production: ProjectProductionState;
  settings: AISettings;
  entries: SrtEntry[];
  timelineHighlights: SubtitleHighlight[];
  execution: NonNullable<ProjectProductionState['execution']>;
  deps: DirectorProductionRunDeps;
}): Promise<ProductionTrackResults> {
  const { ctx, production, settings, entries, execution, deps } = options;
  // 与桌面制作一致：先完成本机素材检索并确定认领名单，再启动卡片等制作轨，
  // 避免同一 footage 段既生成昂贵 Motion 卡又上真实素材。
  const footage = await runHeadlessFootageTrack({
    production,
    plan: production.approvedPlan!,
    settings,
    projectPath: ctx.projectPath,
  });
  await assertActive(ctx, production.approvedPlan!.revision);
  const stagedProduction = await stageHeadlessFootageForCardGeneration({
    ctx,
    production,
    footage,
  });
  const cardsPromise = runHeadlessCardsTrack({
    ctx,
    production: stagedProduction,
    cards: deps.cards ?? runAnalyzeHeadless,
    footage,
  });
  const audioPromise: Promise<HeadlessAudioResult> = needsProductionTrack(stagedProduction, 'audio')
    ? (deps.audio ?? runHeadlessDirectorAudio)({
        projectPath: ctx.projectPath,
        settings,
        execution,
        signal: ctx.handle.signal,
        onProgress: (percent, message) => ctx.handle.update({ phase: message, percent }),
      })
    : Promise.resolve({ execution, placements: [], outcome: 'disabled', reusedSounds: 0 });
  const highlightsPromise = needsProductionTrack(stagedProduction, 'timeline')
    ? (deps.highlights ?? generateSubtitleHighlights)(entries, settings, {
        concurrency: 4,
        shouldCancel: () => ctx.handle.signal.aborted,
      }).then((highlights) => ({ highlights })).catch((error) => ({
        highlights: options.timelineHighlights,
        error: error instanceof Error ? error.message : String(error),
      }))
    : Promise.resolve({ highlights: options.timelineHighlights });
  const coverPromise = cardsPromise.then((cards) => runHeadlessCoverTrack({
    ctx, production: stagedProduction, entries, settings, analysis: cards.analysis,
    covers: deps.covers ?? runHeadlessDirectorCover,
    assertActive: () => assertActive(ctx, production.approvedPlan!.revision).then(() => undefined),
  }));
  const [cards, cover, audio, highlights] = await Promise.all([
    cardsPromise, coverPromise, audioPromise, highlightsPromise,
  ]);
  return { footage, cards, cover, audio, highlights };
}

async function commitProductionTracks(options: {
  ctx: GenerationRunCtx;
  production: ProjectProductionState;
  results: ProductionTrackResults;
}): Promise<ProjectProductionState> {
  const { ctx, production, results } = options;
  const plan = production.approvedPlan!;
  const revision = plan.revision;
  await assertActive(ctx, revision);
  await mutateProjectProduction(ctx.projectPath, {
    kind: 'set-execution', execution: results.audio.execution, ...guard(revision, ctx.handle.taskId),
  });
  await Promise.all([
    setOutput({ ctx, revision, output: 'cards', error: results.cards.error }),
    setOutput({ ctx, revision, output: 'cover', error: results.cover.error }),
    setOutput({ ctx, revision, output: 'audio', error: results.audio.error }),
  ]);
  const cardErrorCount = results.cards.analysis.cardErrors?.length ?? 0;
  if (results.cards.error) {
    await setOutput({
      ctx,
      revision,
      output: 'timeline',
      error: cardErrorCount > 0
        ? `${cardErrorCount} 个镜头未通过质量门禁，时间线未替换`
        : `卡片轨失败，时间线未替换：${results.cards.error}`,
    });
    const error = cardErrorCount > 0
      ? `${cardErrorCount} 个镜头未通过质量门禁，请修复后恢复制作`
      : `卡片轨未完成：${results.cards.error}`;
    ctx.handle.update({ phase: '质检未通过', percent: 100 });
    return mutateProjectProduction(ctx.projectPath, {
      kind: 'set-workflow',
      stage: 'quality-blocked',
      taskId: ctx.handle.taskId,
      error,
      ...guard(revision, ctx.handle.taskId),
    });
  }
  const hasNonMotionShot = plan.segments.some((segment) => (
    segment.enabled && resolveDirectorRenderStrategy(segment) !== 'motion-card'
  ));
  if (results.footage.error && hasNonMotionShot) {
    await setOutput({
      ctx,
      revision,
      output: 'timeline',
      error: `素材轨失败，时间线未替换：${results.footage.error}`,
    });
    const error = `素材轨未完成，非 Motion 镜头尚未确认：${results.footage.error}`;
    ctx.handle.update({ phase: '素材轨待恢复', percent: 100 });
    return mutateProjectProduction(ctx.projectPath, {
      kind: 'set-workflow',
      stage: 'quality-blocked',
      taskId: ctx.handle.taskId,
      error,
      ...guard(revision, ctx.handle.taskId),
    });
  }
  if (needsProductionTrack(production, 'timeline')) {
    const latest = await loadProjectFile(ctx.projectPath);
    const timeline = buildHeadlessDirectorTimeline({
      current: latest.timeline,
      analysis: results.cards.analysis,
      plan,
      highlights: results.highlights.highlights,
      audioPlacements: results.audio.placements,
      footagePlacements: results.footage.placements,
    });
    await assertActive(ctx, revision);
    await saveProjectSection(
      ctx.projectPath,
      'timeline',
      timeline,
      guard(revision, ctx.handle.taskId),
    );
    await setOutput({ ctx, revision, output: 'timeline' });
  }
  ctx.handle.log(`production.tracks.end revision=${revision} highlightsError=${results.highlights.error ?? ''}`);
  ctx.handle.update({ phase: '等待 Animatic 审查', percent: 100 });
  return finalizeWorkflow(ctx, revision);
}

async function runDirectorProductionCore(
  ctx: GenerationRunCtx,
  deps: DirectorProductionRunDeps,
): Promise<ProjectProductionState> {
  const approve = deps.approve ?? runDirectorApproveHeadless;
  const production = await approveOrResume(ctx, approve);
  const plan = production.approvedPlan;
  if (!plan) throw new GenerationError('director_approval_required', '导演方案批准失败。');
  const revision = plan.revision;
  const project = await loadProjectFile(ctx.projectPath);
  const settings = await loadFullHeadlessAISettings(ctx.userDataPath);
  const entries = await readEntries(ctx.projectPath);
  const durationMs = project.timeline?.podcast.durationMs
    || Math.max(0, ...plan.segments.map((segment) => segment.endMs));
  const execution = production.execution?.generationProvenance?.directorRevision === revision
    ? { ...production.execution, motionBible: syncDirectorPlanMotionBible(plan) }
    : buildDirectorExecutionPlan(plan, durationMs);
  await mutateProjectProduction(ctx.projectPath, {
    kind: 'set-execution', execution, ...guard(revision, ctx.handle.taskId),
  });
  ctx.handle.log(`production.tracks.start revision=${revision}`);
  const results = await runProductionTracks({
    ctx, production, settings, entries, execution, deps,
    timelineHighlights: project.timeline?.subtitleHighlights ?? [],
  });
  return commitProductionTracks({ ctx, production, results });
}

async function persistTerminalFailure(ctx: GenerationRunCtx, error: unknown): Promise<void> {
  const project = await loadProjectFile(ctx.projectPath).catch(() => null);
  const revision = project?.production?.approvedPlan?.revision;
  if (!revision) return;
  const aborted = ctx.handle.signal.aborted || (error as { name?: string })?.name === 'AbortError';
  if (
    aborted
    && project?.production?.outputs.footage.status === 'current'
    && project.production.outputs.footage.directorRevision === revision
  ) {
    await mutateProjectProduction(ctx.projectPath, {
      kind: 'set-output',
      output: 'footage',
      state: { status: 'stale', directorRevision: revision, updatedAt: Date.now() },
      expectedDirectorRevision: revision,
    }).catch(() => undefined);
  }
  await mutateProjectProduction(ctx.projectPath, {
    kind: 'set-workflow',
    stage: aborted ? 'production-paused' : 'error',
    taskId: aborted ? undefined : ctx.handle.taskId,
    error: aborted ? undefined : error instanceof Error ? error.message : String(error),
    expectedDirectorRevision: revision,
    ...(aborted ? {} : { expectedTaskId: ctx.handle.taskId }),
  }).catch(() => undefined);
}

export async function runDirectorProductionHeadless(
  ctx: GenerationRunCtx,
  deps: DirectorProductionRunDeps = {},
): Promise<ProjectProductionState> {
  try {
    return await runDirectorProductionCore(ctx, deps);
  } catch (error) {
    await persistTerminalFailure(ctx, error);
    throw error;
  }
}
