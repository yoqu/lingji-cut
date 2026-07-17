import type { AICard, AIAnalysisResult } from '../types/ai';
import { buildAICardTimelineDraft } from '../types/ai';
import { useAIStore, loadAISettings } from '../store/ai';
import { useTimelineStore, getProjectDir } from '../store/timeline';
import { useTaskProgressStore } from '../store/task-progress';
import type { SubtitleCardDraftInput } from './ai-analysis';

interface GenerateSingleCardParams {
  draft: SubtitleCardDraftInput;
}

/**
 * 渲染进程侧：串起 Settings 加载 → IPC 生成 → aiStore 写入 → aiAnalysis.json 持久化 → 时间轴插入。
 *
 * 进度反馈接入底部统一进度条。失败时抛错由调用方决定 UI 路径（当前实现：统一进度条标红）。
 */
export async function generateAndInsertSingleCardFromSubtitles(
  params: GenerateSingleCardParams,
): Promise<AICard> {
  const { draft } = params;
  const taskId = `ai-card-single-${Date.now()}`;
  const taskStore = useTaskProgressStore.getState();

  taskStore.startTask({
    id: taskId,
    category: 'ai-analyze',
    label: '生成手选内容卡片',
    mode: 'indeterminate',
    progress: 0,
    phase: '加载配置',
    level: 2,
    canCancel: false,
  });

  try {
    if (typeof window === 'undefined' || !window.electronAPI?.generateCardFromSubtitles) {
      throw new Error('当前环境不支持单卡生成');
    }

    const settings = await loadAISettings();
    if (!settings) {
      throw new Error('未找到可用的 AI 配置');
    }

    const aiState = useAIStore.getState();
    const timelineState = useTimelineStore.getState();
    const projectDir = getProjectDir();

    taskStore.updateTask(taskId, { phase: '调用 LLM' });

    const card = await window.electronAPI.generateCardFromSubtitles({
      entries: timelineState.srtEntries,
      draft,
      settings,
      globalPrompt: aiState.analysisResult?.globalPrompt,
      programSummary: aiState.analysisResult?.summary,
      keywords: aiState.analysisResult?.keywords,
      motionBible: aiState.analysisResult?.motionBible,
      projectDir: projectDir || undefined,
      projectBindings: aiState.projectBindings,
      feedId: taskId,
    });

    if (card.renderMode !== 'motion-card' || !card.motionCard?.tsx?.trim()) {
      throw new Error('生成结果不是可用的 Remotion motion-card，请重新生成');
    }

    taskStore.updateTask(taskId, { phase: '写入项目配置' });

    const baseResult: AIAnalysisResult = aiState.analysisResult ?? {
      segments: [],
      cards: [],
      coverPrompts: [],
      summary: '',
      keywords: [],
    };
    const nextResult: AIAnalysisResult = {
      ...baseResult,
      cards: [...baseResult.cards, card],
    };
    // 落盘由 store/ai.ts 订阅自动完成。
    useAIStore.getState().setAnalysisResult(nextResult);

    taskStore.updateTask(taskId, { phase: '插入时间轴' });

    useTimelineStore.getState().addAICardsToTimeline([buildAICardTimelineDraft(card)]);

    taskStore.completeTask(taskId);
    return card;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    taskStore.failTask(taskId, message);
    throw error;
  }
}
