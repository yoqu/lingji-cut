import type { TimelineData } from '../types';
import type { AutoWorkflowParams, WorkflowStep } from '../store/ai';
import type { AIAnalysisResult } from '../types/ai';
import type { ProjectData } from './project-persistence';

export type ResumableAutoRunStep = Extract<
  WorkflowStep,
  | 'script_generating'
  | 'tts_generating'
  | 'director_planning'
  | 'production_running'
  | 'ai_analyzing'
  | 'cover_generating'
  | 'arranging'
>;

export interface ResumableAutoRunInfo {
  nextStep: ResumableAutoRunStep;
  nextStepLabel: string;
  /** 已完成项目主动重新制作，不应显示成“检测到未完成”。 */
  restart?: boolean;
  /** 已有制作计划时，写稿工作台可直接进入制作总览，不必重复跑流程。 */
  hasProductionPlan?: boolean;
  checkpoint?: 'director-review' | 'animatic-review';
  /**
   * 上次 autoMode 运行时持久化到 project.json 的参数。
   * 非 null 表示用户曾经跑过一键流程 → UI 可以"继续运行"；
   * null 表示首次启动（或未跑过 autoMode）→ UI 需要让用户先配置角色/音色。
   */
  persistedAutoParams: AutoWorkflowParams | null;
}

export type ResumableAutoRunResult =
  | { kind: 'none' }
  | ({ kind: 'resumable' } & ResumableAutoRunInfo);

const STEP_LABELS: Record<ResumableAutoRunStep, string> = {
  script_generating: '撰写口播稿',
  tts_generating: '语音合成',
  director_planning: '导演规划',
  production_running: '制作执行',
  ai_analyzing: '内容分析',
  cover_generating: '封面生成',
  arranging: '时间轴排布',
};

export function getResumableStepLabel(step: ResumableAutoRunStep): string {
  return STEP_LABELS[step];
}

const LINEAR_STEP_ORDER: ResumableAutoRunStep[] = [
  'script_generating',
  'tts_generating',
  'ai_analyzing',
  'cover_generating',
  'arranging',
];

/**
 * 手动选择起始阶段的可选集合：检测点及其之前的线性阶段（前置产物均已满足）。
 * restart（全部产物齐备的重新制作）允许任意线性阶段；
 * director 阶段走 checkpoint 路径，不提供手动起点。
 */
export function listStartableSteps(
  detected: ResumableAutoRunStep,
  options?: { restart?: boolean },
): ResumableAutoRunStep[] {
  if (options?.restart) return [...LINEAR_STEP_ORDER];
  const idx = LINEAR_STEP_ORDER.indexOf(detected);
  if (idx < 0) return [];
  return LINEAR_STEP_ORDER.slice(0, idx + 1);
}

export interface DetectResumableAutoRunInput {
  scriptContent: string | null;
  originalContent: string | null;
  project: ProjectData | null;
}

/**
 * 根据磁盘产物判断一键全量剪辑是否有可恢复的中断点，并给出下一步。
 *
 * 规则（按顺序）：
 *   1. 时间轴已出现 AI 卡片 overlay → 已完成，返回 none
 *   2. script.md 缺失或为空：
 *      - original.md 也为空 → 从未启动，返回 none
 *      - original.md 非空（说明曾经启动过一键流程，但写稿未完成）→ 从 script_generating 继续
 *   3. script.md 非空：
 *      - 缺 audio/srt → 从 tts_generating 继续
 *      - 有 audio/srt 但缺 analysisResult → 从 ai_analyzing 继续
 *      - 有 analysisResult 但 coverCandidates 为空 → 从 cover_generating 继续
 *      - 有 coverCandidates 但时间轴还没 AI 卡片 → 从 arranging 继续
 *
 * autoParams 优先从 project.json.workflowMeta.lastAutoParams 读取，
 * 若为空则使用 fallbackAutoParams（通常由 AI settings 兜底）。
 */
export function detectResumableAutoRun(
  input: DetectResumableAutoRunInput,
): ResumableAutoRunResult {
  const scriptContent = (input.scriptContent ?? '').trim();
  const originalContent = (input.originalContent ?? '').trim();
  const project = input.project;
  const timeline: TimelineData | null = project?.timeline ?? null;
  const aiAnalysis = project?.aiAnalysis ?? null;

  const v3Result = detectV3Production(project);
  if (v3Result) {
    return {
      kind: 'resumable',
      ...v3Result,
      persistedAutoParams: project?.workflowMeta?.lastAutoParams ?? null,
    };
  }
  if (project?.production?.workflow?.stage === 'complete') return { kind: 'none' };

  // 已完成：时间轴里已经有 AI 卡片，视为跑完
  if (timelineHasAICard(timeline)) {
    return { kind: 'none' };
  }

  const persistedAutoParams = project?.workflowMeta?.lastAutoParams ?? null;

  // script.md 为空：看 original.md 是否存在
  if (!scriptContent) {
    if (!originalContent) {
      return { kind: 'none' };
    }
    return {
      kind: 'resumable',
      nextStep: 'script_generating',
      nextStepLabel: STEP_LABELS.script_generating,
      persistedAutoParams,
    };
  }

  // script.md 非空：按其它阶段推断
  const nextStep = pickNextStep({
    timeline,
    analysisResult: aiAnalysis?.analysisResult ?? null,
    coverCount: aiAnalysis?.coverCandidates?.length ?? 0,
  });

  if (!nextStep) {
    return { kind: 'none' };
  }

  return {
    kind: 'resumable',
    nextStep,
    nextStepLabel: STEP_LABELS[nextStep],
    persistedAutoParams,
  };
}

function detectV3Production(
  project: ProjectData | null,
): Omit<ResumableAutoRunInfo, 'persistedAutoParams'> | null {
  const production = project?.production;
  if (!production?.workflow) return null;
  const stage = production.workflow.stage;
  if (stage === 'director-review') {
    return {
      nextStep: 'director_planning',
      nextStepLabel: STEP_LABELS.director_planning,
      checkpoint: 'director-review',
    };
  }
  if (stage === 'animatic-review') {
    return {
      nextStep: 'production_running',
      nextStepLabel: STEP_LABELS.production_running,
      checkpoint: 'animatic-review',
    };
  }
  if (stage === 'director-planning') {
    return { nextStep: 'director_planning', nextStepLabel: STEP_LABELS.director_planning };
  }
  if (production.approvedPlan && [
    'production-running',
    'production-paused',
    'error',
  ].includes(stage)) {
    return { nextStep: 'production_running', nextStepLabel: STEP_LABELS.production_running };
  }
  const hasIncompleteOutput = Object.values(production.outputs).some(
    (output) => output.status !== 'current',
  );
  if (production.approvedPlan && hasIncompleteOutput) {
    return { nextStep: 'production_running', nextStepLabel: STEP_LABELS.production_running };
  }
  return null;
}

interface PickNextStepInput {
  timeline: TimelineData | null;
  analysisResult: AIAnalysisResult | null;
  coverCount: number;
}

function pickNextStep(
  input: PickNextStepInput,
): Exclude<ResumableAutoRunStep, 'script_generating'> | null {
  const { timeline, analysisResult, coverCount } = input;

  if (!hasPodcastMedia(timeline)) {
    return 'tts_generating';
  }
  if (!analysisResult) {
    return 'ai_analyzing';
  }
  if (coverCount <= 0) {
    return 'cover_generating';
  }
  if (!timelineHasAICard(timeline)) {
    return 'arranging';
  }
  return null;
}

function hasPodcastMedia(timeline: TimelineData | null): boolean {
  if (!timeline?.podcast) return false;
  const audio = timeline.podcast.audioPath?.trim() ?? '';
  const srt = timeline.podcast.srtPath?.trim() ?? '';
  return Boolean(audio && srt);
}

function timelineHasAICard(timeline: TimelineData | null): boolean {
  if (!timeline?.overlays?.length) return false;
  return timeline.overlays.some((overlay) => overlay.overlayType === 'ai-card');
}
