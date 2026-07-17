import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateCardsFromDirectorPlan } from '../../../src/lib/director-production';
import { migrateLegacyProductionState } from '../../../src/lib/director-workflow';
import { resolveStylePresetId } from '../../../src/lib/card-style';
import { parseSrt } from '../../../src/lib/srt-parser';
import { createPersistedAIState } from '../../../src/lib/ai-persistence';
import { handleGenerateCardImage } from '../../card-media-handlers';
import { assertCardRenders } from '../../remotion/smoke-render';
import { createMotionCardAgentProvider } from '../motion-agent-run';
import { makeAgentFeedCallback } from '../agent-feed';
import type { MotionCardAgentProvider, SegmentPlanningResult } from '../../../src/lib/ai-analysis';
import { loadFullHeadlessAISettings, loadHeadlessProjectBindings } from '../headless-settings';
import { GenerationError } from '../generation-error';
import { HeadlessProjectContext } from '../context';
import { loadCardTemplates, loadEffectivePromptTemplate } from '../../prompts-io';
import { loadProjectFile, mutateProjectProduction } from '../../project-file';
import {
  buildMetadataSource,
  buildWorkTitlePatch,
  generatePublishMetadata,
} from '../../../src/lib/publish-metadata';
import { resolvePromptBinding } from '../../../src/lib/llm/binding-resolver';
import { resolveWorkTitle } from '../../../src/lib/project-persistence';
import type { GenerationRunCtx } from '../headless-generation';
import type { SrtEntry } from '../../../src/types';
import type { AISettings, AIAnalysisResult } from '../../../src/types/ai';
import { runDirectorApproveHeadless, runDirectorPlanHeadless } from './director-run';

interface AnalyzeDeps {
  analyze?: (
    entries: SrtEntry[],
    settings: AISettings,
    options: Record<string, unknown>,
  ) => Promise<AIAnalysisResult>;
}

/**
 * 主进程 headless：分析字幕 → segments+cards → 写 project.json aiAnalysis 节。
 *
 * 默认 analyze 装配与 electron/main.ts 的 `analyze-srt` IPC 处理体保持一致的注入：
 * generateStructuredData/generateText 由 lib 层默认实现；motion TSX 走
 * generateMotionCard = pi 多 agent provider（唯一路径，无直连 LLM 回退）；
 * validateMotionSource = assertCardRenders；generateCardImage = handleGenerateCardImage。
 * deps.analyze 仅用于单测，跳过真实 LLM/网络。
 */
export async function runAnalyzeHeadless(
  ctx: GenerationRunCtx,
  deps: AnalyzeDeps = {},
): Promise<AIAnalysisResult> {
  const { projectPath, userDataPath, handle } = ctx;

  handle.update({ phase: '装配设置', percent: 5 });
  const settings = await loadFullHeadlessAISettings(userDataPath);
  const projectBindings = await loadHeadlessProjectBindings(projectPath);

  let srt: string;
  try {
    srt = await readFile(join(projectPath, 'podcast-subtitles.srt'), 'utf-8');
  } catch {
    throw new GenerationError('no_subtitles', '未找到 podcast-subtitles.srt，请先生成音频/字幕。');
  }
  const entries = parseSrt(srt);
  if (entries.length === 0) {
    throw new GenerationError('empty_subtitles', '字幕为空。');
  }

  // 模板与样式（mirror electron/main.ts 的 analyze-srt 处理体；kind 以源码为准）
  const [directorTemplate, planningTemplate, { cardTemplate, imageTemplate, animationTemplate }, coverTemplate, motionBibleTemplate, publishTemplate] =
    await Promise.all([
      loadEffectivePromptTemplate('production.director', { userDataPath, projectDir: projectPath }),
      loadEffectivePromptTemplate('planning.segment', { userDataPath, projectDir: projectPath }),
      loadCardTemplates({ userDataPath, projectDir: projectPath }),
      loadEffectivePromptTemplate('cover.regeneration', { userDataPath, projectDir: projectPath }),
      loadEffectivePromptTemplate('motion.bible', { userDataPath, projectDir: projectPath }),
      loadEffectivePromptTemplate('publish.metadata', { userDataPath, projectDir: projectPath }),
    ]);
  const projectStylePresetId = (await loadProjectFile(projectPath)).stylePresetId;

  // Motion TSX 多 agent provider（懒构造 electron 依赖，vitest 下 deps.analyze mock 不触达）。
  const generateMotionCard: MotionCardAgentProvider = async (mctx) => {
    const { app } = await import('electron');
    const provider = createMotionCardAgentProvider({
      userDataPath,
      projectPath,
      rolesSeedDir: join(app.getAppPath(), 'resources', 'pi-agents', 'agents'),
      contactSheetCacheDir: join(userDataPath, 'motion-contact-sheets'),
      signal: handle.signal,
      onPhase: (phase) => handle.update({ phase: `卡片:${phase}` }),
      // 观测面板关联键与统一进度条的 bridgeId 同值（pipeline:<taskId>）。
      onAgentEvent: makeAgentFeedCallback(`pipeline:${handle.taskId}`),
    });
    return provider(mctx);
  };

  // 作品标题：planning 完成后生成（fill-if-empty），落盘 meta + publish（title 镜像）。
  const generateWorkTitle = async (planning: SegmentPlanningResult): Promise<string | null> => {
    try {
      const project = await loadProjectFile(projectPath);
      const existing = resolveWorkTitle(project);
      if (existing) return existing;
      const sourceText = buildMetadataSource(planning, '');
      if (!sourceText.trim()) return null;
      const binding = resolvePromptBinding('publish.metadata', settings, projectBindings);
      const md = await generatePublishMetadata(
        settings,
        { sourceText },
        { template: publishTemplate, binding },
      );
      const headless = new HeadlessProjectContext(projectPath);
      const patch = buildWorkTitlePatch(project, md);
      await headless.saveSection('meta', patch.meta);
      await headless.saveSection('publish', patch.publish);
      return md.title;
    } catch {
      return null; // 标题失败不阻断分析与封面
    }
  };

  // 默认 analyzeSrt 装配：复刻 main.ts analyze-srt 的 LLM 注入。
  // generateCardImage 复用主进程 handleGenerateCardImage（与 UI 行为一致，即时 materialize 图片卡）。
  handle.update({ phase: '分析与卡片', percent: 20 });
  let result: AIAnalysisResult;
  if (deps.analyze) {
    result = await deps.analyze(entries, settings, {
      projectStylePresetId,
      defaultStylePresetId: settings.defaultStylePresetId,
      planningTemplate,
      directorTemplate,
      cardTemplate,
      imageTemplate,
      animationTemplate,
      coverTemplate,
      motionBibleTemplate,
      projectBindings,
      generateWorkTitle,
      onProgress: (p: { phase?: string; percent?: number }) =>
        handle.update({ phase: p.phase ?? '分析', percent: Math.min(95, 20 + (p.percent ?? 0) * 0.75) }),
    });
    // 测试/旧注入点保持兼容；真实路径在下方先生成并批准方案，再生成卡片。
    const migrated = migrateLegacyProductionState({
      analysisResult: result,
      legacyPlan: null,
      timeline: null,
      mode: 'auto',
    });
    if (migrated.approvedPlan) {
      await mutateProjectProduction(projectPath, {
        kind: 'set-workflow', stage: 'director-planning', mode: 'auto', taskId: handle.taskId,
      });
      await mutateProjectProduction(projectPath, { kind: 'replace-draft', plan: migrated.approvedPlan });
      await mutateProjectProduction(projectPath, {
        kind: 'approve-draft',
        expectedRevision: migrated.approvedPlan.revision,
        taskId: handle.taskId,
      });
    }
  } else {
    const useApprovedPlan = ctx.params?.useApprovedPlan === true;
    const approvedState = useApprovedPlan
      ? (await loadProjectFile(projectPath)).production
      : await (async () => {
          const autoCtx = { ...ctx, params: { ...ctx.params, mode: 'auto' } };
          const draft = await runDirectorPlanHeadless(autoCtx);
          return runDirectorApproveHeadless({
            ...autoCtx,
            params: { ...autoCtx.params, revision: draft.revision },
          });
        })();
    const approvedPlan = approvedState?.approvedPlan;
    if (!approvedPlan) throw new GenerationError('director_approval_required', '导演方案批准失败。');
    await generateWorkTitle({
      segments: approvedPlan.segments,
      coverPrompts: approvedPlan.coverDirection.prompt ? [approvedPlan.coverDirection.prompt] : [],
      summary: approvedPlan.summary,
      keywords: approvedPlan.keywords,
      globalPrompt: approvedPlan.globalPrompt,
    });
    result = await generateCardsFromDirectorPlan(entries, approvedPlan, settings, {
      existingCards: (await loadProjectFile(projectPath)).aiAnalysis?.analysisResult?.cards ?? [],
      generateCardImage: async (invoke) =>
        handleGenerateCardImage(
          {
            projectDir: projectPath,
            cardId: invoke.cardId,
            prompt: invoke.prompt,
            aspectRatio: invoke.aspectRatio,
          },
          {
            settings,
            projectBindings,
            onProgress: () => {},
            signal: handle.signal,
          },
        ),
      cardOptions: {
        generateMotionCard,
        validateMotionSource: assertCardRenders,
        stylePresetId: resolveStylePresetId({
          project: projectStylePresetId,
          global: settings.defaultStylePresetId,
        }),
        cardTemplate,
        imageTemplate,
        animationTemplate,
        projectBindings,
      },
      onProgress: (p) =>
        handle.update({
          phase: p.message ?? '生成卡片',
          percent: Math.min(95, 20 + (p.percent ?? 0) * 0.75),
        }),
    });
  }

  handle.update({ phase: '写入', percent: 96 });
  const persisted = createPersistedAIState(result, []);
  const headless = new HeadlessProjectContext(projectPath);
  const existing = (await loadProjectFile(projectPath)).aiAnalysis;
  await headless.saveSection('aiAnalysis', {
    analysisResult: persisted.analysisResult,
    coverCandidates: existing?.coverCandidates ?? [],
  });

  const production = (await loadProjectFile(projectPath)).production;
  if (production?.approvedPlan) {
    await mutateProjectProduction(projectPath, {
      kind: 'set-output',
      output: 'cards',
      state: {
        status: result.cardErrors?.length ? 'failed' : 'current',
        directorRevision: production.approvedPlan.revision,
        updatedAt: Date.now(),
        error: result.cardErrors?.length ? `${result.cardErrors.length} 个镜头生成失败` : undefined,
      },
      expectedDirectorRevision: production.approvedPlan.revision,
      expectedTaskId: handle.taskId,
    });
  }

  handle.update({ phase: '完成', percent: 100 });
  return result;
}
