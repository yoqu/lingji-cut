import { useCallback } from 'react';
import { runScriptGenerating } from '../lib/auto-workflow';
import { createPersistedAIState, selectCoverCandidate } from '../lib/ai-persistence';
import { getAISettingsIssue } from '../lib/ai-settings';
import { resolveDefaultTTSConfig } from '../lib/tts-settings';
import { createAutoRunTelemetry, type AutoRunTelemetry } from '../lib/telemetry/auto-run';
import {
  DEFAULT_WORKFLOW_META,
  type ProjectData,
  type ProjectWorkflowMeta,
} from '../lib/project-persistence';
import { hashScriptForPodcast } from '../lib/script-hash';
import { serializeSrtEntries } from '../lib/srt-parser';
import { generateSubtitleHighlights } from '../lib/subtitle-highlight-runner';
import { splitIntoSentences } from '../lib/tts/sentence-split';
import { resolveMimoStyleInstruction } from '../lib/tts/mimo-style';
import { annotateForMimo } from '../lib/tts/mimo-annotate';
import {
  DEFAULT_WORKFLOW,
  loadAISettings,
  type WorkflowStep,
  useAIStore,
} from '../store/ai';
import type { AutoWorkflowParams } from '../store/ai';
import { getProjectDir, useTimelineStore } from '../store/timeline';
import { useScriptStore } from '../store/script';
import { useTaskProgressStore } from '../store/task-progress';
import {
  buildAICardTimelineDraft,
  type AIAnalysisResult,
  type CoverCandidate,
} from '../types/ai';
import { applyCardEvent } from '../lib/analyze-progress-bridge';

interface WorkflowStartOptions {
  pauseAfterTts?: boolean;
  /**
   * 仅重跑 TTS：TTS 完成后直接把 workflow 状态回到 idle，
   * 不触发 Editor 侧的 tts_done 自动续跑（AI 分析/封面/排版）。
   * 用于"从文稿重新生成口播"的场景。
   */
  ttsOnly?: boolean;
  startFromStep?: Extract<
    WorkflowStep,
    'script_generating' | 'tts_generating' | 'ai_analyzing' | 'cover_generating' | 'arranging'
  >;
  /** autoMode：从 script_generating 开始的一键全流程 */
  autoMode?: boolean;
  /** autoMode 必传：模板/角色/音色 */
  autoParams?: AutoWorkflowParams;
  /** autoMode=true 时必传：用作 script_generating 的输入 */
  originalText?: string;
}

interface WorkflowSessionState {
  requestId: string;
  retryStep: WorkflowStep;
  scriptText: string;
  projectDir: string;
  pauseAfterTts: boolean;
  ttsOnly: boolean;
  cancelled: boolean;
  taskId: string;
  autoMode: boolean;
  autoParams: AutoWorkflowParams | null;
  originalText: string;
  /** 一键流水线观测：每次 start() 生成一个新的 runId，贯穿写稿→TTS→分析→封面→排布 */
  telemetryRunId: string;
  telemetry: AutoRunTelemetry | null;
}

const workflowSession: WorkflowSessionState = {
  requestId: '',
  retryStep: 'tts_generating',
  scriptText: '',
  projectDir: '',
  pauseAfterTts: false,
  ttsOnly: false,
  cancelled: false,
  taskId: '',
  autoMode: false,
  autoParams: null,
  originalText: '',
  telemetryRunId: '',
  telemetry: null,
};

function resetWorkflowSession(): void {
  workflowSession.requestId = '';
  workflowSession.retryStep = 'tts_generating';
  workflowSession.scriptText = '';
  workflowSession.projectDir = '';
  workflowSession.pauseAfterTts = false;
  workflowSession.ttsOnly = false;
  workflowSession.cancelled = false;
  workflowSession.taskId = '';
  workflowSession.autoMode = false;
  workflowSession.autoParams = null;
  workflowSession.originalText = '';
  workflowSession.telemetryRunId = '';
  workflowSession.telemetry = null;
}

function buildWorkflowError(prefix: string, error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return `${prefix}: ${error.message}`;
  }

  return prefix;
}

// 整个 workflow 的步骤定义：6 个阶段平分全局进度，全局进度 = baseStart + (子进度 * span)
// script 阶段仅 autoMode 启用；非 autoMode 的传统流程从 tts 起步，其余阶段进度区间一致。
type PhaseKey = 'script' | 'tts' | 'analyze' | 'highlights' | 'cover' | 'arrange';

interface PhaseSpec {
  key: PhaseKey;
  index: number; // 1..TOTAL_STEPS
  label: string;
  baseStart: number;
  span: number;
  category: 'tts' | 'ai-analyze' | 'cover' | 'ai-write';
}

const TOTAL_STEPS = 6;
const PHASES: Record<PhaseKey, PhaseSpec> = {
  script: {
    key: 'script',
    index: 1,
    label: '撰写口播稿',
    baseStart: 0,
    span: 16,
    category: 'ai-write',
  },
  tts: { key: 'tts', index: 2, label: '语音合成', baseStart: 16, span: 17, category: 'tts' },
  analyze: {
    key: 'analyze',
    index: 3,
    label: '内容分析',
    baseStart: 33,
    span: 17,
    category: 'ai-analyze',
  },
  highlights: {
    key: 'highlights',
    index: 4,
    label: '字幕高亮',
    baseStart: 50,
    span: 17,
    category: 'ai-analyze',
  },
  cover: { key: 'cover', index: 5, label: '封面生成', baseStart: 67, span: 17, category: 'cover' },
  arrange: {
    key: 'arrange',
    index: 6,
    label: '时间轴排布',
    baseStart: 84,
    span: 16,
    category: 'ai-analyze',
  },
};

function buildStepLabel(phase: PhaseSpec, suffix?: string): string {
  const base = `步骤 ${phase.index}/${TOTAL_STEPS} · ${phase.label}`;
  return suffix ? `${base} · ${suffix}` : base;
}

function mapSubProgressToGlobal(phase: PhaseSpec, subPercent: number): number {
  const clamped = Math.max(0, Math.min(100, subPercent));
  return Math.min(100, Math.round(phase.baseStart + (clamped / 100) * phase.span));
}

function ensureWorkflowTask(
  taskId: string,
  phase: PhaseSpec,
  params: {
    subPercent: number;
    subMessage?: string;
    canCancel: boolean;
    onCancel?: () => void;
  },
): void {
  const store = useTaskProgressStore.getState();
  const globalProgress = mapSubProgressToGlobal(phase, params.subPercent);
  const label = buildStepLabel(phase);

  if (store.tasks.has(taskId)) {
    store.updateTask(taskId, {
      category: phase.category,
      label,
      mode: 'determinate',
      progress: globalProgress,
      phase: params.subMessage ?? phase.label,
      canCancel: params.canCancel,
      onCancel: params.onCancel,
    });
    return;
  }

  store.startTask({
    id: taskId,
    category: phase.category,
    label,
    mode: 'determinate',
    progress: globalProgress,
    phase: params.subMessage ?? phase.label,
    level: 2,
    canCancel: params.canCancel,
    onCancel: params.onCancel,
  });
}

async function hydrateReusablePodcastMedia(): Promise<void> {
  const timelineState = useTimelineStore.getState();
  const audioPath = timelineState.timeline.podcast.audioPath?.trim() ?? '';
  const srtPath = timelineState.timeline.podcast.srtPath?.trim() ?? '';

  if (!srtPath) {
    throw new Error('未找到可复用的字幕文件，请重新生成音频与字幕');
  }

  if (timelineState.srtEntries.length > 0 && timelineState.timeline.podcast.durationMs > 0) {
    return;
  }

  const { entries, durationMs } = await window.electronAPI.parseSrtFile(srtPath);
  const actualDurationMs = audioPath
    ? await window.electronAPI.getAudioDuration(audioPath).catch(() => 0)
    : 0;

  timelineState.setSrtEntries(entries);

  // 若 autoResegment 触发了切分，将切分结果写回主 SRT 文件；
  // .original.srt 由 main 进程在首次 TTS 时落盘，此处不改动。
  {
    const postSetState = useTimelineStore.getState();
    if (postSetState.srtEntries.length !== postSetState.originalSrtEntries.length) {
      const hydrateProjectDir = getProjectDir();
      if (hydrateProjectDir) {
        const splitSrtText = serializeSrtEntries(postSetState.srtEntries);
        const projectFileName = srtPath.split(/[\\/]/).pop() ?? 'podcast-subtitles.srt';
        try {
          await window.electronAPI.saveScriptFile(hydrateProjectDir, projectFileName, splitSrtText);
        } catch (error) {
          // 非致命：内存状态已正确，磁盘回写仅做最佳努力
          console.warn('[subtitle] hydrate 切分后写回 SRT 失败，磁盘保留原始版本', error);
        }
      }
    }
  }

  timelineState.setPodcast(
    audioPath,
    srtPath,
    actualDurationMs > 0
      ? actualDurationMs
      : timelineState.timeline.podcast.durationMs > 0
        ? timelineState.timeline.podcast.durationMs
        : durationMs,
  );
}

/**
 * 读取项目当前 workflowMeta 并合并 patch 后写回。
 * 避免不同调用点各自全量覆盖丢掉彼此写入的字段
 * （例如 autoMode 启动写入 lastAutoParams 时不应清空 lastPodcastScriptHash）。
 */
async function patchWorkflowMeta(
  projectDir: string,
  patch: Partial<ProjectWorkflowMeta>,
): Promise<void> {
  if (!projectDir) {
    return;
  }

  let current: ProjectWorkflowMeta = { ...DEFAULT_WORKFLOW_META };
  try {
    const raw = await window.electronAPI.loadProject(projectDir);
    const parsed = JSON.parse(raw) as ProjectData;
    current = { ...DEFAULT_WORKFLOW_META, ...(parsed.workflowMeta ?? {}) };
  } catch {
    // 首次写入或项目文件不可读时使用默认值；忽略错误以不阻塞主流程
  }

  const next: ProjectWorkflowMeta = { ...current, ...patch };
  try {
    await window.electronAPI.saveProjectSection(
      projectDir,
      'workflowMeta',
      JSON.stringify(next),
    );
  } catch {
    // 持久化失败不阻塞主流程——下次成功写入会修正
  }
}

async function persistAIState(
  projectDir: string,
  analysisResult: AIAnalysisResult | null,
  coverCandidates: CoverCandidate[],
): Promise<void> {
  if (!projectDir) {
    return;
  }

  const persistedState = createPersistedAIState(analysisResult, coverCandidates);
  await window.electronAPI.saveProjectSection(
    projectDir,
    'aiAnalysis',
    JSON.stringify(persistedState),
  );
}

/** 统一的取消入口：立即把 task 标记为错误状态，避免停止后进度条"停止但不消失"。 */
function cancelWorkflowTask(taskId: string, reason = '任务已取消'): void {
  const store = useTaskProgressStore.getState();
  const existing = store.tasks.get(taskId);
  if (!existing || existing.status !== 'active') {
    return;
  }
  store.failTask(taskId, reason);
}

export function useAIVideoWorkflow() {
  const workflow = useAIStore((state) => state.workflow);
  const setWorkflow = useAIStore((state) => state.setWorkflow);
  const resetWorkflow = useAIStore((state) => state.resetWorkflow);
  const setAnalysisResult = useAIStore((state) => state.setAnalysisResult);
  const setCoverCandidates = useAIStore((state) => state.setCoverCandidates);
  const selectCover = useAIStore((state) => state.selectCover);
  const timelineStore = useTimelineStore();

  const runFromStep = useCallback(
    async (
      fromStep: WorkflowStep,
      scriptText: string,
      projectDir: string,
    ) => {
      const workflowTaskId = workflowSession.taskId || `ai-workflow-${Date.now()}`;
      workflowSession.taskId = workflowTaskId;
      const currentRequestId = workflowSession.requestId;
      const isStaleRun = () =>
        workflowSession.cancelled || workflowSession.requestId !== currentRequestId;
      const settings = await loadAISettings();
      const llmSettingsIssue = getAISettingsIssue(settings);

      // phaseKey → WorkflowStep（用于 retryStep / failedStep）
      const phaseToStep = (phaseKey: PhaseKey): WorkflowStep =>
        phaseKey === 'script'
          ? 'script_generating'
          : phaseKey === 'tts'
            ? 'tts_generating'
            : phaseKey === 'analyze'
              ? 'ai_analyzing'
              : phaseKey === 'highlights'
                ? 'ai_analyzing'
                : phaseKey === 'cover'
                  ? 'cover_generating'
                  : 'arranging';

      // 统一的阶段级取消回调：停 TTS + 打标记 + 立即让面板里的任务进入错误态
      const buildPhaseOnCancel = (phaseKey: PhaseKey) => () => {
        if (workflowSession.cancelled) return;
        workflowSession.cancelled = true;
        if (phaseKey === 'tts' && currentRequestId) {
          void window.electronAPI.cancelTTS(currentRequestId);
        }
        cancelWorkflowTask(workflowTaskId, '任务已取消');
        const failedStep = phaseToStep(phaseKey);
        setWorkflow({
          step: 'error',
          progress: 0,
          stepLabel: '',
          error: '任务已取消',
          canCancel: false,
          failedStep,
        });
        workflowSession.retryStep = failedStep;
      };

      if (!projectDir) {
        setWorkflow({
          ...DEFAULT_WORKFLOW,
          step: 'error',
          error: '请先选择工程目录后再生成视频',
          failedStep: fromStep,
        });
        return;
      }

      if (fromStep !== 'script_generating' && !scriptText.trim()) {
        setWorkflow({
          ...DEFAULT_WORKFLOW,
          step: 'error',
          error: '未找到可用于生成视频的文稿内容',
          failedStep: fromStep,
        });
        return;
      }

      if (!settings) {
        setWorkflow({
          ...DEFAULT_WORKFLOW,
          step: 'error',
          error: '请先完成 AI 配置后再生成视频',
          failedStep: fromStep,
        });
        return;
      }

      const defaultTtsConfig = resolveDefaultTTSConfig(settings);
      if (fromStep === 'tts_generating' || fromStep === 'script_generating') {
        if (!defaultTtsConfig.provider || !defaultTtsConfig.voice) {
          setWorkflow({
            ...DEFAULT_WORKFLOW,
            step: 'error',
            error: '请先在设置 → TTS 语音合成中配置默认 Provider 和默认音色',
            failedStep: fromStep,
          });
          return;
        }
        if (!defaultTtsConfig.provider.apiKey.trim()) {
          setWorkflow({
            ...DEFAULT_WORKFLOW,
            step: 'error',
            error: '请先在设置 → TTS 语音合成中填写默认 Provider 的 API Key',
            failedStep: fromStep,
          });
          return;
        }
      }

      if (
        (fromStep === 'ai_analyzing' ||
          fromStep === 'tts_done' ||
          fromStep === 'cover_generating' ||
          fromStep === 'arranging') &&
        llmSettingsIssue
      ) {
        setWorkflow({
          ...DEFAULT_WORKFLOW,
          step: 'error',
          error: llmSettingsIssue,
          failedStep: fromStep,
        });
        workflowSession.retryStep = 'ai_analyzing';
        return;
      }

      // ===== 阶段 0: 写口播稿（仅 autoMode） =====
      if (fromStep === 'script_generating') {
        const phase = PHASES.script;
        const originalForScript = workflowSession.originalText;
        const params = workflowSession.autoParams;

        if (!originalForScript.trim() || !params) {
          setWorkflow({
            ...DEFAULT_WORKFLOW,
            step: 'error',
            error: '自动模式缺少原始素材或参数',
            failedStep: 'script_generating',
          });
          return;
        }

        setWorkflow({
          step: 'script_generating',
          progress: mapSubProgressToGlobal(phase, 0),
          stepLabel: buildStepLabel(phase, '准备中'),
          error: null,
          canCancel: true,
        });
        ensureWorkflowTask(workflowTaskId, phase, {
          subPercent: 0,
          subMessage: '准备中',
          canCancel: true,
          onCancel: buildPhaseOnCancel('script'),
        });

        try {
          const generated = await runScriptGenerating({
            originalText: originalForScript,
            projectDir,
            params,
          });
          workflowSession.scriptText = generated;
          scriptText = generated;

          if (isStaleRun()) return;

          setWorkflow({
            step: 'tts_generating',
            progress: mapSubProgressToGlobal(phase, 100),
            stepLabel: buildStepLabel(phase, '完成'),
            error: null,
            canCancel: true,
          });
          workflowSession.retryStep = 'tts_generating';
          fromStep = 'tts_generating';
        } catch (error) {
          if (isStaleRun()) return;
          const msg = buildWorkflowError('写稿失败', error);
          setWorkflow({
            step: 'error',
            progress: 0,
            stepLabel: '',
            error: msg,
            canCancel: false,
            failedStep: 'script_generating',
          });
          useTaskProgressStore.getState().failTask(workflowTaskId, msg);
          workflowSession.retryStep = 'script_generating';
          workflowSession.telemetry?.event('run.end', {
            ok: false,
            failedStage: 'script',
            error: msg,
          });
          return;
        }
      }

      if (isStaleRun()) {
        return;
      }

      // ===== 阶段 1: TTS =====
      if (fromStep === 'tts_generating') {
        const phase = PHASES.tts;
        setWorkflow({
          step: 'tts_generating',
          progress: mapSubProgressToGlobal(phase, 0),
          stepLabel: buildStepLabel(phase, '准备中'),
          error: null,
          canCancel: true,
        });

        ensureWorkflowTask(workflowTaskId, phase, {
          subPercent: 0,
          subMessage: '准备中',
          canCancel: true,
          onCancel: buildPhaseOnCancel('tts'),
        });

        const cleanupProgress = window.electronAPI.onTTSProgress((pct) => {
          if (isStaleRun()) return;
          const global = mapSubProgressToGlobal(phase, pct);
          setWorkflow({ progress: global, stepLabel: buildStepLabel(phase, `${pct}%`) });
          useTaskProgressStore.getState().updateTask(workflowTaskId, {
            progress: global,
            phase: `合成语音 ${pct}%`,
          });
        });

        try {
          // —— MiMo：取当前口播模板演绎人设 + 分句 + AI 句级打标 ——
          let mimoStyleInstruction: string | undefined;
          let mimoSentences: Array<{ subtitle: string; speak: string }> | undefined;
          if (defaultTtsConfig.provider?.type === 'xiaomi_mimo') {
            const templateId = useScriptStore.getState().selectedTemplate;
            const templates = useAIStore.getState().userPromptEntries['script-template'] ?? [];
            const template = templates.find((t) => t.id === templateId);
            mimoStyleInstruction = resolveMimoStyleInstruction(template);
            const clean = splitIntoSentences(scriptText);
            if (clean.length > 0) {
              const tags = await annotateForMimo(clean, template?.ttsAnnotateHint ?? '', settings);
              mimoSentences = clean.map((s, i) => ({
                subtitle: s,
                speak: tags[i] ? `(${tags[i]})${s}` : s,
              }));
            }
          }

          const ttsResult = await window.electronAPI.generateTTS({
            requestId: currentRequestId,
            text: scriptText,
            provider: defaultTtsConfig.provider ?? undefined,
            voice: defaultTtsConfig.voice
              ? {
                  ...defaultTtsConfig.voice,
                  voiceId:
                    workflowSession.autoParams?.voiceId && defaultTtsConfig.voice.providerType === 'minimax'
                      ? workflowSession.autoParams.voiceId
                      : defaultTtsConfig.voice.voiceId,
                }
              : undefined,
            styleInstruction: mimoStyleInstruction,
            sentences: mimoSentences,
            projectDir,
            telemetryRunId: workflowSession.telemetryRunId,
          });

          cleanupProgress();

          if (isStaleRun()) {
            return;
          }

          const { entries } = await window.electronAPI.parseSrtFile(ttsResult.srtPath);
          const actualDurationMs = await window.electronAPI.getAudioDuration(ttsResult.audioPath).catch(() => 0);
          timelineStore.setSrtEntries(entries);

          // 若 autoResegment 触发了切分，store 中的 srtEntries 比 originalSrtEntries 更多；
          // 将切分结果写回主 SRT 文件，.original.srt 已由 main 进程保留原始副本。
          {
            const postSetState = useTimelineStore.getState();
            if (postSetState.srtEntries.length !== postSetState.originalSrtEntries.length) {
              const splitSrtText = serializeSrtEntries(postSetState.srtEntries);
              const projectFileName = ttsResult.srtPath.split(/[\\/]/).pop() ?? 'podcast-subtitles.srt';
              try {
                await window.electronAPI.saveScriptFile(projectDir, projectFileName, splitSrtText);
              } catch (error) {
                // 非致命：内存状态已正确，磁盘回写仅做最佳努力
                console.warn('[subtitle] 切分后写回 SRT 失败，磁盘保留原始版本', error);
              }
            }
          }

          timelineStore.setPodcast(
            ttsResult.audioPath,
            ttsResult.srtPath,
            actualDurationMs > 0 ? actualDurationMs : ttsResult.durationMs,
          );

          // 记录本次 TTS 使用的文稿哈希：用于 Editor 顶部的"文稿已修改"提示
          void patchWorkflowMeta(projectDir, {
            lastPodcastScriptHash: hashScriptForPodcast(scriptText),
          });

          // ttsOnly：仅重跑口播，完成后立刻收回到 idle，
          // 避免 Editor 里 tts_done 自动续跑 AI 分析/封面/排版。
          if (workflowSession.ttsOnly) {
            useTaskProgressStore.getState().updateTask(workflowTaskId, {
              label: '口播音频已更新',
              phase: '完成',
              progress: 100,
              canCancel: false,
              onCancel: undefined,
            });
            useTaskProgressStore.getState().completeTask(workflowTaskId);
            setWorkflow({ ...DEFAULT_WORKFLOW });
            workflowSession.retryStep = 'tts_generating';
            return;
          }

          setWorkflow({
            step: 'tts_done',
            progress: mapSubProgressToGlobal(phase, 100),
            stepLabel: buildStepLabel(phase, '完成'),
            error: null,
            canCancel: false,
          });

          workflowSession.retryStep = 'ai_analyzing';

          if (workflowSession.pauseAfterTts) {
            return;
          }

          fromStep = 'ai_analyzing';
        } catch (error) {
          cleanupProgress();

          if (isStaleRun()) {
            // 取消分支：task 已在 onCancel 里被 failTask，这里不再覆盖
            return;
          }

          const ttsErrorMsg = buildWorkflowError('语音生成失败', error);
          setWorkflow({
            step: 'error',
            progress: 0,
            stepLabel: '',
            error: ttsErrorMsg,
            canCancel: false,
            failedStep: 'tts_generating',
          });
          useTaskProgressStore.getState().failTask(workflowTaskId, ttsErrorMsg);
          workflowSession.retryStep = 'tts_generating';
          workflowSession.telemetry?.event('run.end', {
            ok: false,
            failedStage: 'tts',
            error: ttsErrorMsg,
          });
          return;
        }
      }

      if (isStaleRun()) {
        return;
      }

      // ===== 阶段 2-3-5（合并并行）: AI 分析 + 字幕高亮 + 封面生成 =====
      //
      // 旧链路是串行：planning → cards → 然后 highlights ‖ cover。
      // 新链路最多三路并行：
      //   Track A: planning → cards（由 main 的 analyzeSrt 内部完成）
      //   Track B: 字幕高亮（只依赖 srtEntries，TTS 完成即可启动）
      //   Track C: 封面图生成（依赖 planning 的 coverPrompts，
      //           main 在 planning 完成的瞬间通过 'analyze-planning-done' 事件回传 coverPrompts，
      //           Track C 收到事件后立即启动，不再等 cards 全部完成）
      // 三路 progress 取激活轨道的平均值，统一映射到 33-84% 区间。
      if (fromStep === 'ai_analyzing' || fromStep === 'tts_done') {
        const phase = PHASES.analyze;
        const tel = workflowSession.telemetry;
        ensureWorkflowTask(workflowTaskId, phase, {
          subPercent: 0,
          subMessage: '准备素材',
          canCancel: true,
          onCancel: buildPhaseOnCancel('analyze'),
        });

        try {
          await hydrateReusablePodcastMedia();
        } catch (error) {
          const reuseErrorMsg = buildWorkflowError('复用已有音频与字幕失败', error);
          setWorkflow({
            step: 'error',
            progress: 0,
            stepLabel: '',
            error: reuseErrorMsg,
            canCancel: false,
            failedStep: 'tts_generating',
          });
          useTaskProgressStore.getState().failTask(workflowTaskId, reuseErrorMsg);
          workflowSession.retryStep = 'tts_generating';
          return;
        }

        if (isStaleRun()) {
          return;
        }

        // 合并进度区间：analyze + highlights + cover 共享 baseStart .. arrange.baseStart
        const postStart = phase.baseStart;
        const postEnd = PHASES.arrange.baseStart;
        const postSpan = postEnd - postStart;
        const timelineStateAtStart = useTimelineStore.getState();
        const srtEntries = timelineStateAtStart.srtEntries;
        const hasHighlightWork = srtEntries.length > 0;
        let analyzePercent = 0;
        let highlightPercent = hasHighlightWork ? 0 : 100;
        let coverPercent = 100; // 默认满分，确认有 coverPrompts 后再降到 0
        let analyzeActive = true;
        let highlightsActive = hasHighlightWork;
        // 封面是否激活要等 planning.coverPrompts 回传后才能确定
        let coverActive = false;
        let coverDecided = false;
        let postGlobalProgress = postStart;
        const refreshCombinedProgress = (subMessage?: string): void => {
          const activeUnits =
            Number(analyzeActive) + Number(highlightsActive) + Number(coverActive);
          // 用平均权重；任何一个轨道完成（active=false）就退出权重池
          const combinedPercent =
            activeUnits > 0
              ? (
                  (analyzeActive ? analyzePercent : 100) +
                  (highlightsActive ? highlightPercent : 100) +
                  (coverActive ? coverPercent : 100)
                ) /
                (Number(analyzeActive) + Number(highlightsActive) + Number(coverActive) + 0.000001)
              : 100;
          const nextGlobal = Math.round(
            postStart + (Math.max(0, Math.min(100, combinedPercent)) / 100) * postSpan,
          );
          const global = Math.max(postGlobalProgress, nextGlobal);
          postGlobalProgress = global;
          const composedMessage =
            subMessage ??
            `分析 ${analyzePercent}% · 高亮 ${hasHighlightWork ? `${highlightPercent}%` : '跳过'} · 封面 ${
              coverDecided ? `${coverPercent}%` : '等待规划'
            }`;
          setWorkflow({
            step: 'ai_analyzing',
            progress: global,
            stepLabel: buildStepLabel(phase, composedMessage),
            error: null,
            canCancel: true,
          });
          useTaskProgressStore.getState().updateTask(workflowTaskId, {
            category: phase.category,
            label: buildStepLabel(phase),
            progress: global,
            phase: composedMessage,
            canCancel: true,
            onCancel: buildPhaseOnCancel('analyze'),
          });
        };

        ensureWorkflowTask(workflowTaskId, phase, {
          subPercent: 0,
          subMessage: '启动 3 路并行：分析 / 高亮 / 封面',
          canCancel: true,
          onCancel: buildPhaseOnCancel('analyze'),
        });
        refreshCombinedProgress('启动 3 路并行：分析 / 高亮 / 封面');

        // ── Track A: analyze (main 进程内部按 planning → cards 顺序跑) ──
        const cleanupAnalyzeProgress = window.electronAPI.onAnalyzeProgress((progress) => {
          if (isStaleRun()) return;
          if (progress.card) {
            applyCardEvent(workflowTaskId, progress.card, {
              startTask: (input) => useTaskProgressStore.getState().startTask(input),
              updateTask: (id, patch) => useTaskProgressStore.getState().updateTask(id, patch),
              completeTask: (id) => useTaskProgressStore.getState().completeTask(id),
              failTask: (id, error) => useTaskProgressStore.getState().failTask(id, error),
              hasTask: (id) => useTaskProgressStore.getState().tasks.has(id),
            });
            return; // card 事件不参与 3 轨合成百分比
          }
          analyzePercent = progress.percent;
          refreshCombinedProgress();
        });

        // ── Track C 触发器：等独立的 cover.regeneration LLM 调用（COVER_REGENERATION）完成 ──
        //
        // 旧链路：planning-done 事件直接附带 coverPrompts → 立刻启动封面图生成。
        // 新链路：planning-done 仅用于上报 segments；真正的封面提示词来自 main 的
        //         'analyze-cover-prompts-ready'（ai-analysis 内部独立跑 cover.regeneration）。
        // 失败 / fallback 时 ai-analysis 仍会以 planning.coverPrompts 兜底回吐，保证此事件必发。
        let coverPromptsBuffer: string[] = [];
        let resolveCoverPrompts: () => void = () => undefined;
        let rejectCoverPrompts: (err: unknown) => void = () => undefined;
        const coverPromptsReadyPromise = new Promise<void>((resolve, reject) => {
          resolveCoverPrompts = resolve;
          rejectCoverPrompts = reject;
        });
        const cleanupPlanningDone = window.electronAPI.onAnalyzePlanningDone((planning) => {
          if (isStaleRun()) return;
          tel?.event('planning.done.received', {
            coverPrompts: planning.coverPrompts?.length ?? 0,
            segments: planning.segments?.length ?? 0,
          });
        });
        const cleanupCoverPromptsReady = window.electronAPI.onAnalyzeCoverPromptsReady(
          ({ prompts }) => {
            if (isStaleRun()) return;
            coverPromptsBuffer = prompts ?? [];
            coverDecided = true;
            coverActive = coverPromptsBuffer.length > 0;
            coverPercent = coverActive ? 0 : 100;
            tel?.event('cover-prompts.ready.received', {
              coverPrompts: coverPromptsBuffer.length,
            });
            resolveCoverPrompts();
            refreshCombinedProgress();
          },
        );

        // ── Track B: highlights，立刻启动，与 planning/cards 完全并行 ──
        const highlightsTrack = (async (): Promise<void> => {
          if (!hasHighlightWork) {
            tel?.event('highlights.skipped', { reason: 'no-srt' });
            return;
          }
          try {
            const highlights = await generateSubtitleHighlights(srtEntries, settings, {
              concurrency: 4,
              onProgress: (p) => {
                if (isStaleRun()) return;
                highlightPercent = p.percent;
                refreshCombinedProgress();
              },
              shouldCancel: isStaleRun,
              telemetry: tel ? { emit: (k, e) => tel.event(k, e) } : undefined,
            });
            if (isStaleRun()) return;
            if (highlights.length > 0) {
              timelineStore.setSubtitleHighlights(highlights);
              timelineStore.updateSubtitleStyle({ highlightEnabled: true });
            }
          } catch (error) {
            // 字幕高亮失败不阻断后续
            console.warn('字幕高亮生成失败，继续后续流程:', error);
            tel?.event('highlights.error', {
              message: error instanceof Error ? error.message : String(error),
            });
          } finally {
            highlightPercent = 100;
            highlightsActive = false;
            if (!isStaleRun()) refreshCombinedProgress();
          }
        })();

        // ── Track C: cover，等 cover-prompts-ready 后立即启动（不等卡片生成完成） ──
        const coverTrack = (async (): Promise<CoverCandidate[] | null> => {
          try {
            await coverPromptsReadyPromise;
          } catch {
            // analyze 失败提前 reject：cover 直接放弃
            coverActive = false;
            coverPercent = 100;
            return null;
          }
          if (isStaleRun() || coverPromptsBuffer.length === 0) {
            coverActive = false;
            coverPercent = 100;
            refreshCombinedProgress();
            return null;
          }
          const cleanupCoverProgress = window.electronAPI.onCoverProgress((progress) => {
            if (isStaleRun()) return;
            coverPercent = progress.percent;
            refreshCombinedProgress();
          });
          try {
            let nextCandidates = await window.electronAPI.generateCoverImages({
              prompts: coverPromptsBuffer,
              settings,
              projectDir,
              projectBindings: useAIStore.getState().projectBindings,
              telemetryRunId: workflowSession.telemetryRunId,
            });
            if (isStaleRun()) return null;
            const validCandidates = nextCandidates.filter(
              (candidate) => candidate.imageUrl && !candidate.error,
            );
            if (validCandidates.length > 0) {
              const randomPick =
                validCandidates[Math.floor(Math.random() * validCandidates.length)];
              nextCandidates = selectCoverCandidate(nextCandidates, randomPick.id);
              selectCover(randomPick.id);
              timelineStore.setGlobalBackground(randomPick.imageUrl);
            }
            setCoverCandidates(nextCandidates);
            return nextCandidates;
          } catch (error) {
            console.warn('封面生成失败，继续后续时间轴排布:', error);
            tel?.event('cover.error', {
              message: error instanceof Error ? error.message : String(error),
            });
            return null;
          } finally {
            cleanupCoverProgress();
            coverPercent = 100;
            coverActive = false;
            if (!isStaleRun()) refreshCombinedProgress();
          }
        })();

        // ── Track A 主等待 ──
        let analysisResult: AIAnalysisResult | null = null;
        try {
          analysisResult = (await window.electronAPI.analyzeSrt({
            entries: srtEntries,
            settings,
            projectDir,
            projectBindings: useAIStore.getState().projectBindings,
            telemetryRunId: workflowSession.telemetryRunId,
            feedId: workflowSession.taskId || undefined,
          })) as AIAnalysisResult;
        } catch (error) {
          // analyze 失败：cover-prompts-ready 可能根本没发出，主动解除 cover 的等待
          rejectCoverPrompts(error);
          cleanupAnalyzeProgress();
          cleanupPlanningDone();
          cleanupCoverPromptsReady();
          analyzeActive = false;
          // 等高亮/封面收尾（封面会 catch reject）
          await Promise.allSettled([highlightsTrack, coverTrack]);
          if (isStaleRun()) {
            return;
          }
          const analyzeErrorMsg = buildWorkflowError('内容分析失败', error);
          setWorkflow({
            step: 'error',
            progress: 0,
            stepLabel: '',
            error: analyzeErrorMsg,
            canCancel: false,
            failedStep: 'ai_analyzing',
          });
          useTaskProgressStore.getState().failTask(workflowTaskId, analyzeErrorMsg);
          workflowSession.retryStep = 'ai_analyzing';
          tel?.event('run.end', {
            ok: false,
            failedStage: 'analyze',
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }

        // analyze 成功收尾
        cleanupAnalyzeProgress();
        cleanupPlanningDone();
        cleanupCoverPromptsReady();
        analyzeActive = false;
        analyzePercent = 100;
        if (isStaleRun()) return;

        setAnalysisResult(analysisResult);
        setCoverCandidates([]);
        await persistAIState(projectDir, analysisResult, []);

        // 等高亮 / 封面跑完（多数情况下封面已经在 cards 期间就启动了）
        const [, coverCandidatesResult] = await Promise.all([highlightsTrack, coverTrack]);

        if (isStaleRun()) return;

        if (coverCandidatesResult && coverCandidatesResult.length > 0) {
          // 用 cover 完成后的候选覆盖之前空写的占位
          await persistAIState(projectDir, analysisResult, coverCandidatesResult);
        }

        // 阶段切换：进入 arrange 起点
        const arrangePhase = PHASES.arrange;
        setWorkflow({
          step: 'arranging',
          progress: mapSubProgressToGlobal(arrangePhase, 0),
          stepLabel: buildStepLabel(arrangePhase, '准备中'),
          error: null,
          canCancel: true,
        });
        ensureWorkflowTask(workflowTaskId, arrangePhase, {
          subPercent: 0,
          subMessage: '准备中',
          canCancel: true,
          onCancel: buildPhaseOnCancel('arrange'),
        });
        workflowSession.retryStep = 'arranging';
        fromStep = 'arranging';
      }

      if (isStaleRun()) {
        return;
      }

      // ===== 阶段 3: 封面生成 =====
      if (fromStep === 'cover_generating') {
        const phase = PHASES.cover;
        const { analysisResult } = useAIStore.getState();
        const coverPrompts = analysisResult?.coverPrompts ?? [];

        ensureWorkflowTask(workflowTaskId, phase, {
          subPercent: 0,
          subMessage: coverPrompts.length > 0 ? `准备生成 ${coverPrompts.length} 张封面` : '跳过封面',
          canCancel: true,
          onCancel: buildPhaseOnCancel('cover'),
        });

        const cleanupCoverProgress = window.electronAPI.onCoverProgress((progress) => {
          if (isStaleRun()) return;
          const global = mapSubProgressToGlobal(phase, progress.percent);
          const subMessage = progress.message || phase.label;
          setWorkflow({
            progress: global,
            stepLabel: buildStepLabel(phase, subMessage),
          });
          useTaskProgressStore.getState().updateTask(workflowTaskId, {
            progress: global,
            phase: subMessage,
          });
        });

        if (coverPrompts.length > 0) {
          try {
            let nextCandidates = await window.electronAPI.generateCoverImages({
              prompts: coverPrompts,
              settings,
              projectDir,
              projectBindings: useAIStore.getState().projectBindings,
            });

            if (isStaleRun()) {
              cleanupCoverProgress();
              return;
            }

            const validCandidates = nextCandidates.filter(
              (candidate) => candidate.imageUrl && !candidate.error,
            );

            if (validCandidates.length > 0) {
              const randomPick =
                validCandidates[Math.floor(Math.random() * validCandidates.length)];
              nextCandidates = selectCoverCandidate(nextCandidates, randomPick.id);
              selectCover(randomPick.id);
              timelineStore.setGlobalBackground(randomPick.imageUrl);
            }

            setCoverCandidates(nextCandidates);
            await persistAIState(projectDir, analysisResult, nextCandidates);
          } catch (error) {
            console.warn('封面生成失败，继续后续时间轴排布:', error);
          }
        } else {
          setCoverCandidates([]);
          await persistAIState(projectDir, analysisResult, []);
        }

        cleanupCoverProgress();

        if (isStaleRun()) {
          return;
        }

        // 阶段切换：进入 arrange 起点
        const arrangePhase = PHASES.arrange;
        setWorkflow({
          step: 'arranging',
          progress: mapSubProgressToGlobal(arrangePhase, 0),
          stepLabel: buildStepLabel(arrangePhase, '准备中'),
          error: null,
          canCancel: true,
        });
        ensureWorkflowTask(workflowTaskId, arrangePhase, {
          subPercent: 0,
          subMessage: '准备中',
          canCancel: true,
          onCancel: buildPhaseOnCancel('arrange'),
        });
        workflowSession.retryStep = 'arranging';
        fromStep = 'arranging';
      }

      if (isStaleRun()) {
        return;
      }

      // ===== 阶段 4: 时间轴排布 =====
      if (fromStep === 'arranging') {
        const phase = PHASES.arrange;
        try {
          const { analysisResult } = useAIStore.getState();
          const allCards = analysisResult?.cards ?? [];
          const drafts = allCards
            .filter((card) => card.enabled)
            .map(buildAICardTimelineDraft);

          if (isStaleRun()) {
            return;
          }

          timelineStore.removeAICardOverlaysBySourceIds(allCards.map((card) => card.id));

          if (drafts.length > 0) {
            timelineStore.addAICardsToTimeline(drafts);
            const global = mapSubProgressToGlobal(phase, 100);
            const subMessage = `排布卡片 ${drafts.length}/${drafts.length}`;
            setWorkflow({
              progress: global,
              stepLabel: buildStepLabel(phase, subMessage),
            });
            useTaskProgressStore.getState().updateTask(workflowTaskId, {
              progress: global,
              phase: subMessage,
              canCancel: true,
              onCancel: buildPhaseOnCancel('arrange'),
            });
          }

          setWorkflow({
            step: 'done',
            progress: 100,
            stepLabel: '视频草稿已准备完成',
            error: null,
            canCancel: false,
          });
          useTaskProgressStore.getState().updateTask(workflowTaskId, {
            label: '视频草稿已准备完成',
            phase: '完成',
            progress: 100,
            canCancel: false,
            onCancel: undefined,
          });
          useTaskProgressStore.getState().completeTask(workflowTaskId);
          workflowSession.telemetry?.event('run.end', { ok: true });
        } catch (error) {
          if (isStaleRun()) {
            return;
          }
          const arrangingErrorMsg = buildWorkflowError('时间轴排布失败', error);
          setWorkflow({
            step: 'error',
            progress: 0,
            stepLabel: '',
            error: arrangingErrorMsg,
            canCancel: false,
            failedStep: 'arranging',
          });
          useTaskProgressStore.getState().failTask(workflowTaskId, arrangingErrorMsg);
          workflowSession.retryStep = 'arranging';
          workflowSession.telemetry?.event('run.end', {
            ok: false,
            failedStage: 'arrange',
            error: arrangingErrorMsg,
          });
        }
      }
    },
    [
      selectCover,
      setAnalysisResult,
      setCoverCandidates,
      setWorkflow,
      timelineStore,
    ],
  );

  const start = useCallback(
    async (scriptText: string, options?: WorkflowStartOptions) => {
      resetWorkflowSession();
      workflowSession.requestId = crypto.randomUUID();
      workflowSession.taskId = `ai-workflow-${Date.now()}`;
      // 给本次一键流程生成唯一 runId，所有阶段（TTS / 分析 / 封面 / 排布）共用，
      // jsonl 日志路径 = <userData>/logs/auto-run/<runId>.jsonl
      workflowSession.telemetryRunId = `autorun-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      workflowSession.telemetry = createAutoRunTelemetry(workflowSession.telemetryRunId);
      workflowSession.telemetry.event('run.start', {
        autoMode: options?.autoMode ?? false,
        startFromStep: options?.startFromStep ?? null,
        pauseAfterTts: options?.pauseAfterTts ?? false,
        ttsOnly: options?.ttsOnly ?? false,
        projectDir: getProjectDir() ?? '',
      });
      const initialStep =
        options?.startFromStep ?? (options?.autoMode ? 'script_generating' : 'tts_generating');
      workflowSession.retryStep = initialStep;
      workflowSession.projectDir = getProjectDir() ?? '';
      workflowSession.pauseAfterTts = options?.pauseAfterTts ?? false;
      workflowSession.ttsOnly = options?.ttsOnly ?? false;
      workflowSession.autoMode = options?.autoMode ?? false;
      workflowSession.autoParams = options?.autoParams ?? null;
      workflowSession.originalText = options?.originalText ?? '';

      // 优先使用传入文本，否则从磁盘读取 script.md；
      // autoMode（initialStep === 'script_generating'）阶段会自己写稿，无需读 script.md
      let text = scriptText;
      if (!text.trim() && workflowSession.projectDir && initialStep !== 'script_generating') {
        const diskText = await window.electronAPI.loadScriptFile(
          workflowSession.projectDir,
          'script.md',
        );
        text = diskText ?? '';
      }
      workflowSession.scriptText = text;

      // autoMode 启动时把 autoParams 落盘到 project.json.workflowMeta，
      // 为 Editor 顶部的"恢复横幅"提供精确的参数来源（avoid race: 不 await）。
      // 使用 patchWorkflowMeta 合并写入，避免覆盖 lastPodcastScriptHash 等已有字段。
      if (
        workflowSession.autoMode &&
        workflowSession.autoParams &&
        workflowSession.projectDir
      ) {
        void patchWorkflowMeta(workflowSession.projectDir, {
          lastAutoParams: workflowSession.autoParams,
          lastAutoRunAt: new Date().toISOString(),
        });
      }

      void runFromStep(initialStep, text, workflowSession.projectDir);
    },
    [runFromStep],
  );

  const cancel = useCallback(() => {
    const currentRequestId = workflowSession.requestId;
    const currentTaskId = workflowSession.taskId;
    workflowSession.cancelled = true;

    if (currentRequestId) {
      void window.electronAPI.cancelTTS(currentRequestId);
    }

    if (currentTaskId) {
      cancelWorkflowTask(currentTaskId, '任务已取消');
    }

    workflowSession.telemetry?.event('run.end', { ok: false, cancelled: true });
    resetWorkflow();
  }, [resetWorkflow]);

  const retry = useCallback(() => {
    workflowSession.cancelled = false;
    if (
      !workflowSession.requestId ||
      workflowSession.retryStep === 'tts_generating'
    ) {
      workflowSession.requestId = crypto.randomUUID();
    }
    // 重试生成新的 taskId，避免复用已失败的 task 条目
    workflowSession.taskId = `ai-workflow-${Date.now()}`;

    if (!workflowSession.projectDir) {
      workflowSession.projectDir = getProjectDir() ?? '';
    }

    void runFromStep(
      workflowSession.retryStep,
      workflowSession.scriptText,
      workflowSession.projectDir,
    );
  }, [runFromStep]);

  const continueFromTtsDone = useCallback(
    (projectDir?: string) => {
      workflowSession.cancelled = false;
      workflowSession.pauseAfterTts = false;
      workflowSession.projectDir = projectDir || workflowSession.projectDir || getProjectDir() || '';
      if (!workflowSession.taskId) {
        workflowSession.taskId = `ai-workflow-${Date.now()}`;
      }
      void runFromStep(
        'ai_analyzing',
        workflowSession.scriptText,
        workflowSession.projectDir,
      );
    },
    [runFromStep],
  );

  return {
    start,
    cancel,
    retry,
    continueFromTtsDone,
    workflow,
  };
}
