import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeSrt } from '../../../src/lib/ai-analysis';
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
import { loadProjectFile } from '../../project-file';
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
  const [planningTemplate, { cardTemplate, imageTemplate, animationTemplate }, coverTemplate, publishTemplate] =
    await Promise.all([
      loadEffectivePromptTemplate('planning.segment', { userDataPath, projectDir: projectPath }),
      loadCardTemplates({ userDataPath, projectDir: projectPath }),
      loadEffectivePromptTemplate('cover.regeneration', { userDataPath, projectDir: projectPath }),
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
  const analyze =
    deps.analyze ??
    ((srtEntries: SrtEntry[], aiSettings: AISettings, options: Record<string, unknown>) =>
      analyzeSrt(srtEntries, aiSettings, {
        ...options,
        generateCardImage: async (invoke) =>
          handleGenerateCardImage(
            {
              projectDir: projectPath,
              cardId: invoke.cardId,
              prompt: invoke.prompt,
              aspectRatio: invoke.aspectRatio,
            },
            {
              settings: aiSettings,
              projectBindings,
              onProgress: () => {
                // analyze 主进度已由 onProgress 覆盖；图像生成内部进度暂不上报
              },
              signal: handle.signal,
            },
          ),
        generateMotionCard,
        validateMotionSource: assertCardRenders,
      }));

  handle.update({ phase: '分析与卡片', percent: 20 });
  const result = await analyze(entries, settings, {
    projectStylePresetId,
    defaultStylePresetId: settings.defaultStylePresetId,
    planningTemplate,
    cardTemplate,
    imageTemplate,
    animationTemplate,
    coverTemplate,
    projectBindings,
    generateWorkTitle,
    onProgress: (p: { phase?: string; percent?: number }) =>
      handle.update({ phase: p.phase ?? '分析', percent: Math.min(95, 20 + (p.percent ?? 0) * 0.75) }),
  });

  handle.update({ phase: '写入', percent: 96 });
  const persisted = createPersistedAIState(result, []);
  const headless = new HeadlessProjectContext(projectPath);
  const existing = (await loadProjectFile(projectPath)).aiAnalysis;
  await headless.saveSection('aiAnalysis', {
    analysisResult: persisted.analysisResult,
    coverCandidates: existing?.coverCandidates ?? [],
  });

  handle.update({ phase: '完成', percent: 100 });
  return result;
}
