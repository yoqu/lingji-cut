import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import {
  createPersistedAIState,
  selectCoverCandidate,
  toggleCardEnabledInResult,
  updateCardInResult,
} from '../lib/ai-persistence';
import { getProductionSaveGuard } from '../lib/production-save-guard';
import { migrateToProviders } from '../lib/llm/provider-utils';
import { isLingjiManagedProviderId } from '../lib/llm/lingji-gateway';
import { migrateImageProviders } from '../lib/llm/migrate-image-providers';
import { normalizeTTSSettings } from '../lib/tts-settings';
import { normalizeSunoAudioSettings } from '../lib/audio-gen/settings';
import { loadGlobalSettingsFile, updateGlobalSettingsFile } from '../lib/global-settings-client';
import {
  DEFAULT_CARD_STYLE,
  DEFAULT_STYLE_PRESET_ID,
  getDefaultTemplate,
  buildAICardTimelineDraft,
  normalizeCardGenerationConcurrency,
  type AIAnalysisResult,
  type AICard,
  type AICardDisplayMode,
  type AISettings,
  type CoverCandidate,
  type CoverEditState,
  type ImageAspectRatio,
  type MediaCardContent,
  type PromptBinding,
  type PromptBindingMap,
  type VideoAspectRatio,
} from '../types/ai';
import { useTaskProgressStore } from './task-progress';
import type {
  PromptCategory,
  PromptKind,
  UserPromptEntry,
} from '../lib/prompts/types';
import { SCRIPT_TEMPLATE_SEEDS } from '../lib/prompts/script-template-defaults';
import type { SaveStatus } from './timeline';
import { getCurrentProjectDir, useTimelineStore } from './timeline';
import { getAISettingsIssue } from '../lib/ai-settings';
import { planMotionConversion, mergeMotionConversionResult } from '../lib/ai-card-conversion';
import type { AssetLibraryFile } from '../types/assets';
import { buildMotionCardProductionReport } from '../lib/motion-production-report';

export type WorkflowStep =
  | 'idle'
  | 'douyin_importing'
  | 'script_generating'
  | 'tts_generating'
  | 'tts_done'
  | 'director_planning'
  | 'director_review'
  | 'production_running'
  | 'production_paused'
  | 'ai_analyzing'
  | 'cover_generating'
  | 'arranging'
  | 'animatic_review'
  | 'done'
  | 'error';

export interface AutoWorkflowParams {
  templateId: string;
  roleId: string;
  voiceId: string;
  /** 旧项目缺省为 auto。director 会在时间轴草稿生成后停下供人工确认。 */
  productionMode?: 'auto' | 'director';
}

export interface WorkflowState {
  step: WorkflowStep;
  progress: number;
  stepLabel: string;
  error: string | null;
  canCancel: boolean;
  /** 进入 error 态时由阶段回调写入，AutoRunOverlay 用于决定跳转目标。 */
  failedStep: WorkflowStep | null;
}

export const DEFAULT_WORKFLOW: WorkflowState = {
  step: 'idle',
  progress: 0,
  stepLabel: '',
  error: null,
  canCancel: false,
  failedStep: null,
};

const MEDIA_DEFAULT_DURATION_MS: Record<'image' | 'video', number> = {
  image: 5_000,
  video: 6_000,
};

interface MediaCardSkeletonOptions {
  prompt?: string;
  aspectRatio: ImageAspectRatio | VideoAspectRatio;
  displayMode: AICardDisplayMode;
  durationSeconds?: number;
}

function buildMediaCardSkeleton(
  type: 'image' | 'video',
  segmentId: string,
  analysis: AIAnalysisResult | null,
  opts: MediaCardSkeletonOptions,
): AICard {
  const segment = analysis?.segments.find((s) => s.id === segmentId);
  const fallbackTitle = type === 'image' ? '图片卡' : '视频卡';
  const title = segment?.title?.trim() || fallbackTitle;
  const promptFallback = opts.prompt ?? segment?.summary ?? '';
  const startMs = segment?.startMs ?? 0;
  const endMs = segment?.endMs ?? startMs;
  const displayDurationMs =
    type === 'video' && typeof opts.durationSeconds === 'number'
      ? Math.max(1000, Math.round(opts.durationSeconds * 1000))
      : MEDIA_DEFAULT_DURATION_MS[type];

  const content: MediaCardContent = {
    mediaType: type,
    assetPath: null,
    aspectRatio: opts.aspectRatio as ImageAspectRatio,
    prompt: promptFallback,
    providerId: null,
    model: null,
    generationStatus: 'idle',
  };

  return {
    id: uuid(),
    segmentId,
    type,
    title,
    content,
    startMs,
    endMs,
    displayDurationMs,
    displayMode: opts.displayMode,
    template: getDefaultTemplate(type),
    enabled: true,
    style: { ...DEFAULT_CARD_STYLE[type] },
  };
}

function appendCardToStore(
  set: (
    partial:
      | Partial<AIStore>
      | ((state: AIStore) => Partial<AIStore>),
  ) => void,
  get: () => AIStore,
  card: AICard,
): void {
  const current = get().analysisResult;
  if (!current) {
    const empty: AIAnalysisResult = {
      segments: [],
      cards: [card],
      coverPrompts: [],
      summary: '',
      keywords: [],
    };
    set({ analysisResult: empty });
    return;
  }
  set({
    analysisResult: { ...current, cards: [...current.cards, card] },
  });
}

function markCardAsUserModified(
  result: AIAnalysisResult | null,
  cardId: string,
): AIAnalysisResult | null {
  const card = result?.cards.find((item) => item.id === cardId);
  if (!card?.generationProvenance) return result;
  return updateCardInResult(result, cardId, {
    generationProvenance: {
      ...card.generationProvenance,
      modifiedByUser: true,
    },
  });
}

function markCoverAsUserModified(candidate: CoverCandidate): CoverCandidate {
  return candidate.generationProvenance
    ? {
        ...candidate,
        generationProvenance: { ...candidate.generationProvenance, modifiedByUser: true },
      }
    : candidate;
}


export function buildDefaultAISettings(): AISettings {
  return {
    llmProviders: [],
    defaultProviderId: null,
    defaultModel: null,
    enableThinking: true,
    minimaxApiKey: '',
    minimaxVoiceId: 'male-qn-qingse',
    minimaxSpeed: 1.0,
    minimaxVol: 1.0,
    minimaxPitch: 0,
    minimaxEmotion: '',
    minimaxModel: 'speech-2.8-hd',
    ttsProviders: [],
    defaultTtsProviderId: null,
    defaultTtsVoiceId: null,
    ttsVoices: [],
    audioGeneration: normalizeSunoAudioSettings(),
    imageProviders: [],
    defaultImageProviderId: null,
    defaultImageModel: null,
    globalCoverImagePrompt: '',
    videoProviders: [],
    defaultVideoProviderId: null,
    defaultVideoModel: null,
    promptBindings: {},
    cardGenerationConcurrency: normalizeCardGenerationConcurrency(undefined),
    defaultStylePresetId: DEFAULT_STYLE_PRESET_ID,
  };
}

export type AITab = 'cards' | 'cover' | 'production';

/** 单个分段骨架占位（增量分析期间的瞬态 UI 状态）。 */
export interface IncrementalSkeleton {
  segmentId: string;
  title: string;
  status: 'pending' | 'failed';
}

/**
 * 增量分析瞬态 slice：仅渲染层使用，不持久化到 project.json。
 * 规划完成时 active=true，每个分段先以 skeleton 占位，真实卡片到达后替换其骨架。
 */
export interface IncrementalAnalysisState {
  active: boolean;
  skeletons: IncrementalSkeleton[];
  cards: AICard[];
}

export const DEFAULT_INCREMENTAL_ANALYSIS: IncrementalAnalysisState = {
  active: false,
  skeletons: [],
  cards: [],
};

export type AIPlanningSnapshot = Pick<
  AIAnalysisResult,
  'segments' | 'coverPrompts' | 'summary' | 'keywords' | 'globalPrompt'
>;

export interface AIStore {
  analysisResult: AIAnalysisResult | null;
  isAnalyzing: boolean;
  analysisError: string | null;
  coverCandidates: CoverCandidate[];
  isGeneratingCovers: boolean;
  pendingAutoParams: AutoWorkflowParams | null;
  setPendingAutoParams: (params: AutoWorkflowParams | null) => void;
  /**
   * auto-run 恢复起点：AutoRunResumeBanner 触发恢复时写入，
   * AutoRunController 在起跑 useAIVideoWorkflow.start 时作为 startFromStep。
   * 离开 auto-run 页或恢复完成后由 AutoRunController 清空。
   */
  pendingAutoResumeStep: Extract<
    WorkflowStep,
    | 'script_generating'
    | 'tts_generating'
    | 'director_planning'
    | 'production_running'
    | 'ai_analyzing'
    | 'cover_generating'
    | 'arranging'
  > | null;
  setPendingAutoResumeStep: (
    step:
      | Extract<
          WorkflowStep,
          | 'script_generating'
          | 'tts_generating'
          | 'director_planning'
          | 'production_running'
          | 'ai_analyzing'
          | 'cover_generating'
          | 'arranging'
        >
      | null,
  ) => void;
  activeTab: AITab;
  // —— 提示词 × AI 绑定（项目级）——
  projectBindings: PromptBindingMap;
  currentProjectDir: string | null;
  /**
   * 项目级默认风格预设 id；undefined 表示继承全局默认。
   * 解析优先级：单卡 → 项目（此值）→ 全局 → 内置默认（见 resolveStylePresetId）。
   */
  projectStylePresetId: string | undefined;
  /** 打开项目时把 project.json 的 stylePresetId 注入 store（缺省为 undefined）。 */
  loadProjectStylePresetId: (id: string | undefined) => void;
  /** 写入/清除项目级默认风格，并通过 save-project-section 持久化到 project.json。 */
  setProjectStylePresetId: (id: string | undefined) => Promise<void>;
  loadProjectBindings: (projectDir: string | null) => Promise<void>;
  /**
   * 写入/清除单个提示词在当前项目下的 AI 绑定。
   * key 支持：PromptKind（如 'script.review'）或 userPromptBindingKey(...)（如 'user:script-template:xxx'）
   */
  setProjectBinding: (key: string, binding: PromptBinding | null) => Promise<void>;
  setGlobalBinding: (kind: PromptKind, binding: PromptBinding | null) => Promise<void>;
  // —— 用户自定义提示词条目（分类：script-template 等）——
  userPromptEntries: Record<PromptCategory, UserPromptEntry[]>;
  userPromptsLoaded: Record<PromptCategory, boolean>;
  loadUserPrompts: (category: PromptCategory) => Promise<void>;
  saveUserPrompt: (input: {
    category: PromptCategory;
    id: string;
    name: string;
    description: string;
    version?: number;
    system: string;
    user: string;
    ttsStyle?: string;
    ttsAnnotateHint?: string;
  }) => Promise<UserPromptEntry>;
  deleteUserPrompt: (category: PromptCategory, id: string) => Promise<void>;
  setAnalysisResult: (result: AIAnalysisResult) => void;
  /** planning.segment 完成后立即写入正式分析结果，触发项目自动保存。 */
  setPlannedAnalysisResult: (planning: AIPlanningSnapshot) => void;
  setAnalyzing: (analyzing: boolean) => void;
  setAnalysisError: (error: string | null) => void;
  toggleCardEnabled: (cardId: string) => void;
  updateCard: (cardId: string, updates: Partial<AICard>) => void;
  reconcileAssetBindings: (library: AssetLibraryFile) => void;
  // —— 媒体卡（image/video）actions ——
  cardMediaTasks: Record<string, { taskId: string; phase: string; percent: number }>;
  createImageCard: (
    segmentId: string,
    opts?: {
      prompt?: string;
      aspectRatio?: ImageAspectRatio;
      displayMode?: AICardDisplayMode;
    },
  ) => Promise<AICard>;
  createVideoCard: (
    segmentId: string,
    opts?: {
      prompt?: string;
      aspectRatio?: VideoAspectRatio;
      durationSeconds?: number;
      displayMode?: AICardDisplayMode;
    },
  ) => Promise<AICard>;
  regenerateCardMedia: (
    cardId: string,
    overrides?: Partial<MediaCardContent>,
  ) => Promise<void>;
  /**
   * 把现有卡片转换为 image/video 卡，保持 cardId / segmentId / 时间区间 / displayMode 不变。
   * 用于「转为图片卡」「转为视频卡」入口；返回新 card；若卡片不存在或目标类型与当前一致则返回 null。
   */
  convertCardToMedia: (
    cardId: string,
    mediaType: 'image' | 'video',
  ) => Promise<AICard | null>;
  /**
   * 把 image/video 卡转换为 motion 动画卡：调 LLM 生成 Remotion TSX，
   * 保留 cardId / segmentId / 时间区间 / displayMode / enabled。
   * 有背景段走 regenerateAICard，手动卡走 generateCardFromSubtitles。
   * 卡片不存在、已是 motion、AI 未配置或生成失败时返回 null。
   */
  convertCardToMotion: (cardId: string) => Promise<AICard | null>;
  cancelCardMediaGeneration: (cardId: string) => Promise<void>;
  deleteCard: (cardId: string) => Promise<void>;
  setCoverCandidates: (candidates: CoverCandidate[]) => void;
  appendCoverCandidate: (candidate: CoverCandidate) => void;
  replaceCoverCandidate: (candidateId: string, patch: Partial<CoverCandidate>) => void;
  updateCoverEdits: (candidateId: string, edits: CoverEditState) => void;
  selectCover: (candidateId: string) => void;
  setGeneratingCovers: (generating: boolean) => void;
  setActiveTab: (tab: AITab) => void;
  clearAnalysis: () => void;
  workflow: WorkflowState;
  setWorkflow: (updates: Partial<WorkflowState>) => void;
  resetWorkflow: () => void;
  // —— 增量分析（瞬态，不持久化）——
  incrementalAnalysis: IncrementalAnalysisState;
  /** 规划完成：进入 active，按计划顺序铺出 pending 骨架，清空已到达卡片。 */
  beginIncrementalAnalysis: (
    planned: Array<{ segmentId: string; title: string }>,
  ) => void;
  /** 某分段真实卡片到达：插入/替换 cards（按计划顺序排序），并移除其骨架。 */
  upsertAnalyzedCard: (card: AICard) => void;
  /** 某分段分析失败：把其骨架标记为 failed（保留骨架，不新增卡片）。 */
  markAnalyzedCardFailed: (segmentId: string) => void;
  /** 结束增量分析：重置为默认。 */
  endIncrementalAnalysis: () => void;
}

/**
 * 增量分析内部排序基准：beginIncrementalAnalysis 时按计划顺序记录的 segmentId 序列。
 * 用于 upsertAnalyzedCard 把 cards 始终维持在计划顺序（即便乱序到达），与持久化无关。
 */
let incrementalPlannedOrder: string[] = [];

function sortCardsBySegmentOrder(cards: AICard[], segmentOrder: string[]): AICard[] {
  return [...cards].sort((a, b) => {
    const ia = segmentOrder.indexOf(a.segmentId);
    const ib = segmentOrder.indexOf(b.segmentId);
    const ra = ia === -1 ? Number.MAX_SAFE_INTEGER : ia;
    const rb = ib === -1 ? Number.MAX_SAFE_INTEGER : ib;
    return ra - rb || a.startMs - b.startMs;
  });
}

export const useAIStore = create<AIStore>((set, get) => ({
  analysisResult: null,
  isAnalyzing: false,
  analysisError: null,
  coverCandidates: [],
  isGeneratingCovers: false,
  pendingAutoParams: null,
  pendingAutoResumeStep: null,
  activeTab: 'cards',
  projectBindings: {},
  currentProjectDir: null,
  projectStylePresetId: undefined,
  loadProjectStylePresetId: (id) => {
    set({ projectStylePresetId: id });
  },
  setProjectStylePresetId: async (id) => {
    const projectDir = get().currentProjectDir;
    set({ projectStylePresetId: id });
    if (!projectDir) {
      console.warn('setProjectStylePresetId: 无当前项目目录，仅更新内存状态');
      return;
    }
    if (typeof window === 'undefined' || !window.electronAPI?.saveProjectSection) {
      return;
    }
    try {
      await window.electronAPI.saveProjectSection(
        projectDir,
        'stylePresetId',
        // undefined 传给 JSON.stringify 会得到 undefined（非 "null"），故先归一为 null 再持久化
        JSON.stringify(id ?? null),
      );
    } catch (error) {
      console.error('保存项目级默认风格失败:', error);
      throw error;
    }
  },
  userPromptEntries: { 'script-template': [] },
  userPromptsLoaded: { 'script-template': false },
  loadUserPrompts: async (category) => {
    if (typeof window === 'undefined' || !window.electronAPI?.listUserPrompts) {
      // 非 Electron 环境：直接使用内置 seeds 作为 fallback
      if (category === 'script-template') {
        const fallback: UserPromptEntry[] = SCRIPT_TEMPLATE_SEEDS.map((seed) => ({
          id: seed.id,
          category: seed.category,
          name: seed.name,
          description: seed.description,
          version: seed.version,
          system: seed.system,
          user: seed.user,
          isBuiltin: true,
        }));
        set((state) => ({
          userPromptEntries: { ...state.userPromptEntries, [category]: fallback },
          userPromptsLoaded: { ...state.userPromptsLoaded, [category]: true },
        }));
      }
      return;
    }
    try {
      const entries = await window.electronAPI.listUserPrompts(category);
      set((state) => ({
        userPromptEntries: { ...state.userPromptEntries, [category]: entries },
        userPromptsLoaded: { ...state.userPromptsLoaded, [category]: true },
      }));
    } catch (err) {
      console.error('加载用户提示词失败:', err);
    }
  },
  saveUserPrompt: async (input) => {
    if (typeof window === 'undefined' || !window.electronAPI?.writeUserPrompt) {
      throw new Error('当前环境不支持写入用户提示词');
    }
    const entry = await window.electronAPI.writeUserPrompt(input);
    set((state) => {
      const list = state.userPromptEntries[input.category] ?? [];
      const idx = list.findIndex((e) => e.id === entry.id);
      const nextList = idx >= 0
        ? list.map((e, i) => (i === idx ? entry : e))
        : [...list, entry];
      return {
        userPromptEntries: { ...state.userPromptEntries, [input.category]: nextList },
      };
    });
    return entry;
  },
  deleteUserPrompt: async (category, id) => {
    if (typeof window === 'undefined' || !window.electronAPI?.deleteUserPrompt) {
      throw new Error('当前环境不支持删除用户提示词');
    }
    const result = await window.electronAPI.deleteUserPrompt(category, id);
    // 删除后重新从主进程拉一次（以便 seed 恢复/自定义消失都能一致反映）
    if (result.removed) {
      try {
        const entries = await window.electronAPI.listUserPrompts(category);
        set((state) => ({
          userPromptEntries: { ...state.userPromptEntries, [category]: entries },
        }));
      } catch (err) {
        console.error('删除后刷新用户提示词失败:', err);
      }
    }
  },
  loadProjectBindings: async (projectDir) => {
    // 切换为无项目状态时，清空内存快照（包含项目级风格预设，避免跨项目污染）
    if (!projectDir) {
      set({ projectBindings: {}, currentProjectDir: null, projectStylePresetId: undefined });
      return;
    }
    // 非 Electron 环境（如测试渲染环境）不做任何 IO，只更新 projectDir
    if (typeof window === 'undefined' || !window.electronAPI?.readPromptBindings) {
      set({ projectBindings: {}, currentProjectDir: projectDir });
      return;
    }
    try {
      const bindings = await window.electronAPI.readPromptBindings('project', projectDir);
      set({ projectBindings: bindings ?? {}, currentProjectDir: projectDir });
    } catch (error) {
      console.error('加载项目提示词绑定失败:', error);
      set({ projectBindings: {}, currentProjectDir: projectDir });
    }
  },
  setProjectBinding: async (key, binding) => {
    const { currentProjectDir, projectBindings } = get();
    // 不可在无项目上下文写入
    if (!currentProjectDir) {
      console.warn('setProjectBinding: 无当前项目目录，已忽略');
      return;
    }
    const next: PromptBindingMap = { ...projectBindings };
    if (binding === null) {
      delete next[key];
    } else {
      next[key] = binding;
    }
    set({ projectBindings: next });
    if (typeof window !== 'undefined' && window.electronAPI?.writePromptBindings) {
      try {
        await window.electronAPI.writePromptBindings('project', next, currentProjectDir);
      } catch (error) {
        console.error('写入项目提示词绑定失败:', error);
        throw error;
      }
    }
  },
  setGlobalBinding: async (kind, binding) => {
    const current = await loadAISettings();
    const baseSettings: AISettings = current ?? buildDefaultAISettings();
    const nextBindings: PromptBindingMap = { ...(baseSettings.promptBindings ?? {}) };
    if (binding === null) {
      delete nextBindings[kind];
    } else {
      nextBindings[kind] = binding;
    }
    await saveAISettings({ ...baseSettings, promptBindings: nextBindings });
  },
  setAnalysisResult: (result) => set({ analysisResult: result, analysisError: null }),
  setPlannedAnalysisResult: (planning) =>
    set({
      analysisResult: {
        segments: planning.segments,
        cards: [],
        coverPrompts: planning.coverPrompts,
        summary: planning.summary,
        keywords: planning.keywords,
        globalPrompt: planning.globalPrompt,
      },
      analysisError: null,
    }),
  setAnalyzing: (analyzing) => set({ isAnalyzing: analyzing }),
  setAnalysisError: (error) =>
    set((state) => ({
      analysisError: error,
      isAnalyzing: error ? false : state.isAnalyzing,
    })),
  toggleCardEnabled: (cardId) =>
    set((state) => {
      const toggled = toggleCardEnabledInResult(state.analysisResult, cardId);
      return { analysisResult: markCardAsUserModified(toggled, cardId) };
    }),
  updateCard: (cardId, updates) =>
    set((state) => {
      const updated = updateCardInResult(state.analysisResult, cardId, updates);
      return { analysisResult: markCardAsUserModified(updated, cardId) };
    }),
  reconcileAssetBindings: (library) => {
    const result = get().analysisResult;
    if (!result) return;
    const byId = new Map(library.assets.map((asset) => [asset.id, asset]));
    const changedCards: AICard[] = [];
    const cards = result.cards.map((card) => {
      if (!card.assetBindings?.length) return card;
      const missing = card.assetBindings.filter((binding) => !byId.has(binding.assetId));
      const bindings = card.assetBindings.flatMap((binding) => {
        const asset = byId.get(binding.assetId);
        if (!asset) return [];
        return [{
          ...binding,
          filePath: asset.files.processed || asset.files.thumbnail || asset.files.original,
          treatment: asset.treatment,
          metadata: {
            width: asset.metadata.width,
            height: asset.metadata.height,
            hasAlpha: asset.metadata.hasAlpha,
            processedAt: asset.metadata.processedAt,
            processedColorKey: asset.metadata.processedColorKey,
          },
        }];
      });
      const existingReport = card.motionCard?.productionReport;
      const retainedIssues = (existingReport?.assetIssues ?? [])
        .filter((issue) => issue.code !== 'asset-binding-missing');
      const missingIssues = missing.map((binding) => ({
        severity: 'error' as const,
        code: 'asset-binding-missing',
        message: `资产“${binding.request?.query ?? binding.slot}”已不存在，请重新选择或生成。`,
      }));
      const productionReport = existingReport
        ? {
            ...existingReport,
            status: missingIssues.length > 0 ? 'risk' as const : existingReport.status,
            assetIssues: [...retainedIssues, ...missingIssues.map((issue) => ({ ...issue, source: 'asset' as const }))],
          }
        : missingIssues.length > 0
          ? buildMotionCardProductionReport({ assetIssues: missingIssues })
          : undefined;
      const nextCard = {
        ...card,
        assetBindings: bindings,
        motionCard: card.motionCard && productionReport
          ? { ...card.motionCard, productionReport }
          : card.motionCard,
      };
      if (JSON.stringify(nextCard.assetBindings) !== JSON.stringify(card.assetBindings) || missing.length > 0) {
        changedCards.push(nextCard);
        return nextCard;
      }
      return card;
    });
    if (changedCards.length === 0) return;
    set({ analysisResult: { ...result, cards } });
    const timeline = useTimelineStore.getState();
    for (const card of changedCards) {
      if (timeline.timeline.overlays.some((overlay) =>
        overlay.overlayType === 'ai-card' && overlay.aiCardData?.sourceCardId === card.id)) {
        timeline.addAICardsToTimeline([buildAICardTimelineDraft(card, result.motionBible)]);
      }
    }
  },
  cardMediaTasks: {},
  createImageCard: async (segmentId, opts) => {
    const card = buildMediaCardSkeleton('image', segmentId, get().analysisResult, {
      prompt: opts?.prompt,
      aspectRatio: opts?.aspectRatio ?? '16:9',
      displayMode: opts?.displayMode ?? 'fullscreen',
    });
    appendCardToStore(set, get, card);
    return card;
  },
  createVideoCard: async (segmentId, opts) => {
    const durationSeconds = opts?.durationSeconds ?? 6;
    const card = buildMediaCardSkeleton('video', segmentId, get().analysisResult, {
      prompt: opts?.prompt,
      aspectRatio: opts?.aspectRatio ?? '16:9',
      displayMode: opts?.displayMode ?? 'fullscreen',
      durationSeconds,
    });
    appendCardToStore(set, get, card);
    return card;
  },
  convertCardToMedia: async (cardId, mediaType) => {
    const state = get();
    const result = state.analysisResult;
    const card = result?.cards.find((c) => c.id === cardId);
    if (!card) return null;
    if (card.type === mediaType) return null;

    // prompt 种子：原 title + segment.summary（若可用）
    const segment = result?.segments.find((s) => s.id === card.segmentId);
    const seedParts: string[] = [];
    if (card.title?.trim()) seedParts.push(card.title.trim());
    if (segment?.summary?.trim()) seedParts.push(segment.summary.trim());
    const seedPrompt = seedParts.join('\n');

    const defaultDurationMs = MEDIA_DEFAULT_DURATION_MS[mediaType];
    const newContent: MediaCardContent = {
      mediaType,
      assetPath: null,
      aspectRatio: '16:9',
      prompt: seedPrompt,
      providerId: null,
      model: null,
      generationStatus: 'idle',
    };

    const newCard: AICard = {
      ...card,
      type: mediaType,
      content: newContent,
      template: getDefaultTemplate(mediaType),
      style: { ...DEFAULT_CARD_STYLE[mediaType] },
      // image/video 默认时长按媒体默认；保留原 displayDurationMs 当其有效
      displayDurationMs:
        card.displayDurationMs && card.displayDurationMs > 0
          ? card.displayDurationMs
          : defaultDurationMs,
    };

    set((s) => {
      if (!s.analysisResult) return {};
      return {
        analysisResult: {
          ...s.analysisResult,
          cards: s.analysisResult.cards.map((c) => (c.id === cardId ? newCard : c)),
        },
      };
    });
    return newCard;
  },
  convertCardToMotion: async (cardId) => {
    const state = get();
    const result = state.analysisResult;
    const card = result?.cards.find((c) => c.id === cardId);
    if (!card || !result) return null;

    const plan = planMotionConversion(card, result);
    if (plan.kind === 'noop') return null;

    const settings = await loadAISettings();
    const issue = getAISettingsIssue(settings);
    if (issue || !settings) {
      get().setAnalysisError(issue ?? '请先完成 AI 配置');
      return null;
    }

    const taskId = `convert-card-motion-${card.id}-${Date.now()}`;
    const taskProgress = useTaskProgressStore.getState();
    taskProgress.startTask({
      id: taskId,
      category: 'ai-analyze',
      label: `转为动画卡：${card.title}`,
      mode: 'indeterminate',
      progress: 0,
      phase: '生成 Motion 卡片',
      level: 2,
      canCancel: false,
    });

    try {
      const timeline = useTimelineStore.getState();
      const projectBindings = get().projectBindings;
      const projectDir = getCurrentProjectDir() || undefined;
      const globalPrompt = result.globalPrompt?.trim() || undefined;

      let generated: AICard;
      if (plan.kind === 'segment') {
        generated = await window.electronAPI.regenerateAICard({
          entries: timeline.srtEntries,
          card,
          segment: plan.segment,
          settings,
          globalPrompt,
          cardPrompt: card.cardPrompt,
          programSummary: result.summary,
          keywords: result.keywords,
          motionBible: result.motionBible,
          projectDir,
          projectBindings,
          feedId: taskId,
        });
      } else {
        generated = await window.electronAPI.generateCardFromSubtitles({
          entries: timeline.srtEntries,
          draft: plan.draft,
          settings,
          globalPrompt,
          programSummary: result.summary,
          keywords: result.keywords,
          motionBible: result.motionBible,
          projectDir,
          projectBindings,
          feedId: taskId,
        });
      }

      const merged = mergeMotionConversionResult(card, generated);

      set((s) => {
        if (!s.analysisResult) return {};
        return {
          analysisResult: {
            ...s.analysisResult,
            cards: s.analysisResult.cards.map((c) => (c.id === cardId ? merged : c)),
          },
        };
      });
      get().setAnalysisError(null);

      const placed = timeline.timeline.overlays.some(
        (o) => o.overlayType === 'ai-card' && o.aiCardData?.sourceCardId === cardId,
      );
      if (placed) {
        timeline.addAICardsToTimeline([buildAICardTimelineDraft(merged, result.motionBible)]);
      }

      taskProgress.completeTask(taskId);
      return merged;
    } catch (error) {
      const message = error instanceof Error ? error.message : '转换为动画卡失败';
      get().setAnalysisError(message);
      taskProgress.failTask(taskId, message);
      return null;
    }
  },
  regenerateCardMedia: async (cardId, overrides) => {
    const state = get();
    const result = state.analysisResult;
    const card = result?.cards.find((c) => c.id === cardId);
    if (!card || (card.type !== 'image' && card.type !== 'video')) {
      throw new Error(`regenerateCardMedia: 卡片不存在或类型非 image/video: ${cardId}`);
    }
    const baseContent = card.content as MediaCardContent;
    const mergedContent: MediaCardContent = {
      ...baseContent,
      ...(overrides ?? {}),
      generationStatus: 'generating',
      errorMessage: undefined,
    };

    // 先把 generating 状态写回 store
    set((s) => ({
      analysisResult: updateCardInResult(s.analysisResult, cardId, {
        content: mergedContent,
      }),
    }));

    const taskId = `card-media-${cardId}`;
    const cardTypeLabel = card.type === 'image' ? '图片卡' : '视频卡';
    const taskProgress = useTaskProgressStore.getState();
    taskProgress.startTask({
      id: taskId,
      category: card.type === 'image' ? 'cover' : 'export',
      label: `生成${cardTypeLabel}：${card.title}`,
      mode: 'determinate',
      progress: 0,
      phase: '准备生成',
      level: 1,
      canCancel: true,
      onCancel: () => {
        void get().cancelCardMediaGeneration(cardId);
      },
    });

    set((s) => ({
      cardMediaTasks: {
        ...s.cardMediaTasks,
        [cardId]: { taskId, phase: '准备生成', percent: 0 },
      },
    }));

    let unsubscribe: (() => void) | null = null;
    if (typeof window !== 'undefined' && window.electronAPI?.onCardMediaProgress) {
      unsubscribe = window.electronAPI.onCardMediaProgress((payload) => {
        if (payload.cardId !== cardId) return;
        const phase = payload.phase ?? payload.message ?? '生成中';
        const percent = typeof payload.percent === 'number' ? payload.percent : 0;
        useTaskProgressStore.getState().updateTask(taskId, {
          progress: percent,
          phase,
        });
        set((s) => ({
          cardMediaTasks: {
            ...s.cardMediaTasks,
            [cardId]: { taskId, phase, percent },
          },
        }));
      });
    }

    const cleanup = () => {
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          // ignore
        }
        unsubscribe = null;
      }
      set((s) => {
        const next = { ...s.cardMediaTasks };
        delete next[cardId];
        return { cardMediaTasks: next };
      });
    };

    try {
      if (typeof window === 'undefined' || !window.electronAPI) {
        throw new Error('当前环境不支持媒体生成 IPC');
      }
      const projectDir = get().currentProjectDir ?? '';
      const settings = (await loadAISettings()) ?? buildDefaultAISettings();
      const projectBindings = get().projectBindings;
      let nextContent: MediaCardContent;
      if (card.type === 'image') {
        nextContent = await window.electronAPI.generateCardImage({
          projectDir,
          cardId,
          prompt: mergedContent.prompt,
          negativePrompt: mergedContent.negativePrompt,
          backgroundRemoval: mergedContent.backgroundRemoval ?? 'none',
          aspectRatio: mergedContent.aspectRatio,
          providerId: mergedContent.providerId,
          model: mergedContent.model,
          extraParams: mergedContent.extraParams,
          settings,
          projectBindings,
        });
      } else {
        // video 仅接受 16:9 / 9:16 / 1:1
        const ar = mergedContent.aspectRatio as VideoAspectRatio;
        const durationSeconds = Math.max(
          1,
          Math.round((card.displayDurationMs ?? 6000) / 1000),
        );
        nextContent = await window.electronAPI.generateCardVideo({
          projectDir,
          cardId,
          prompt: mergedContent.prompt,
          negativePrompt: mergedContent.negativePrompt,
          aspectRatio: ar,
          durationSeconds,
          providerId: mergedContent.providerId,
          model: mergedContent.model,
          extraParams: mergedContent.extraParams,
          settings,
          projectBindings,
        });
      }

      // 写回新 content；video 卡同步 displayDurationMs
      set((s) => {
        const updates: Partial<AICard> = { content: nextContent };
        if (card.type === 'video' && nextContent.mediaDurationMs && nextContent.mediaDurationMs > 0) {
          updates.displayDurationMs = nextContent.mediaDurationMs;
        }
        return {
          analysisResult: updateCardInResult(s.analysisResult, cardId, updates),
        };
      });
      useTaskProgressStore.getState().completeTask(taskId);
      cleanup();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 若非 cancelled，标记 failed
      const currentCard = get().analysisResult?.cards.find((c) => c.id === cardId);
      const currentStatus =
        currentCard && (currentCard.content as MediaCardContent)?.generationStatus;
      if (currentStatus !== 'cancelled') {
        set((s) => ({
          analysisResult: updateCardInResult(s.analysisResult, cardId, {
            content: {
              ...mergedContent,
              generationStatus: 'failed',
              errorMessage: message,
            },
          }),
        }));
        useTaskProgressStore.getState().failTask(taskId, message);
      }
      cleanup();
    }
  },
  cancelCardMediaGeneration: async (cardId) => {
    const state = get();
    const taskEntry = state.cardMediaTasks[cardId];
    const card = state.analysisResult?.cards.find((c) => c.id === cardId);
    if (typeof window !== 'undefined' && window.electronAPI?.cancelCardMediaGeneration) {
      try {
        await window.electronAPI.cancelCardMediaGeneration(cardId);
      } catch (error) {
        console.error('取消媒体卡生成失败:', error);
      }
    }
    if (card && (card.type === 'image' || card.type === 'video')) {
      const baseContent = card.content as MediaCardContent;
      set((s) => ({
        analysisResult: updateCardInResult(s.analysisResult, cardId, {
          content: {
            ...baseContent,
            generationStatus: 'cancelled',
          },
        }),
      }));
    }
    if (taskEntry) {
      useTaskProgressStore.getState().cancelTask(taskEntry.taskId, '用户取消生成');
      set((s) => {
        const next = { ...s.cardMediaTasks };
        delete next[cardId];
        return { cardMediaTasks: next };
      });
    }
  },
  deleteCard: async (cardId) => {
    const state = get();
    const result = state.analysisResult;
    const card = result?.cards.find((c) => c.id === cardId);
    // 媒体卡：先清理资产
    if (card && (card.type === 'image' || card.type === 'video')) {
      const projectDir = state.currentProjectDir;
      if (
        projectDir &&
        typeof window !== 'undefined' &&
        window.electronAPI?.deleteCardMediaAssets
      ) {
        try {
          await window.electronAPI.deleteCardMediaAssets(projectDir, cardId);
        } catch (error) {
          console.error('删除媒体卡资产失败:', error);
        }
      }
    }
    set((s) => {
      if (!s.analysisResult) return {};
      return {
        analysisResult: {
          ...s.analysisResult,
          cards: s.analysisResult.cards.filter((c) => c.id !== cardId),
        },
      };
    });
  },
  setCoverCandidates: (candidates) => set({ coverCandidates: candidates }),
  appendCoverCandidate: (candidate) =>
    set((state) => ({ coverCandidates: [...state.coverCandidates, candidate] })),
  replaceCoverCandidate: (candidateId, patch) =>
    set((state) => ({
      coverCandidates: state.coverCandidates.map((c) =>
        c.id === candidateId ? markCoverAsUserModified({ ...c, ...patch }) : c,
      ),
    })),
  updateCoverEdits: (candidateId, edits) =>
    set((state) => ({
      coverCandidates: state.coverCandidates.map((c) =>
        c.id === candidateId ? markCoverAsUserModified({ ...c, edits }) : c,
      ),
    })),
  selectCover: (candidateId) =>
    set((state) => ({
      coverCandidates: selectCoverCandidate(state.coverCandidates, candidateId),
    })),
  setGeneratingCovers: (generating) => set({ isGeneratingCovers: generating }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setPendingAutoParams: (params) => set({ pendingAutoParams: params }),
  setPendingAutoResumeStep: (step) => set({ pendingAutoResumeStep: step }),
  clearAnalysis: () =>
    set({
      analysisResult: null,
      analysisError: null,
      coverCandidates: [],
    }),
  workflow: { ...DEFAULT_WORKFLOW },
  setWorkflow: (updates) =>
    set((state) => ({
      workflow: { ...state.workflow, ...updates },
    })),
  resetWorkflow: () => set({ workflow: { ...DEFAULT_WORKFLOW } }),
  incrementalAnalysis: { ...DEFAULT_INCREMENTAL_ANALYSIS },
  beginIncrementalAnalysis: (planned) => {
    incrementalPlannedOrder = planned.map((p) => p.segmentId);
    set({
      incrementalAnalysis: {
        active: true,
        skeletons: planned.map((p) => ({
          segmentId: p.segmentId,
          title: p.title,
          status: 'pending' as const,
        })),
        cards: [],
      },
    });
  },
  upsertAnalyzedCard: (card) =>
    set((state) => {
      const prev = state.incrementalAnalysis;
      // 插入/替换 cards：按 segmentId 去重，再按计划顺序排序（乱序到达也稳定）
      const withoutSame = prev.cards.filter((c) => c.segmentId !== card.segmentId);
      const nextCards = sortCardsBySegmentOrder(
        [...withoutSame, card],
        incrementalPlannedOrder,
      );
      // 该分段已由真实卡片代表，移除其骨架
      const nextSkeletons = prev.skeletons.filter(
        (s) => s.segmentId !== card.segmentId,
      );
      const result = state.analysisResult;
      const nextAnalysisResult = result
        ? {
            ...result,
            cards: sortCardsBySegmentOrder(
              [
                ...result.cards.filter((c) => c.segmentId !== card.segmentId),
                card,
              ],
              result.segments.map((segment) => segment.id),
            ),
          }
        : result;
      return {
        analysisResult: nextAnalysisResult,
        incrementalAnalysis: {
          ...prev,
          cards: nextCards,
          skeletons: nextSkeletons,
        },
      };
    }),
  markAnalyzedCardFailed: (segmentId) =>
    set((state) => {
      const prev = state.incrementalAnalysis;
      return {
        incrementalAnalysis: {
          ...prev,
          skeletons: prev.skeletons.map((s) =>
            s.segmentId === segmentId ? { ...s, status: 'failed' as const } : s,
          ),
        },
      };
    }),
  endIncrementalAnalysis: () => {
    incrementalPlannedOrder = [];
    set({ incrementalAnalysis: { ...DEFAULT_INCREMENTAL_ANALYSIS } });
  },
}));

/**
 * 清洗已下线的视频 / TTS provider 类型：
 * - 网关托管视频（lingji-fallback-video，历史下发过 'custom'）归一为 'vidu'；
 * - 其余无运行时实现的类型（kling/runway/minimax_video/custom_openai_audio）直接剔除。
 */
function sanitizeRemovedMediaProviders(raw: AISettings): Pick<
  AISettings,
  'videoProviders' | 'defaultVideoProviderId' | 'ttsProviders' | 'defaultTtsProviderId'
> {
  const videoProviders = (raw.videoProviders ?? [])
    .map((p) =>
      (p.type as string) !== 'vidu' && isLingjiManagedProviderId(p.id)
        ? { ...p, type: 'vidu' as const }
        : p,
    )
    .filter((p) => (p.type as string) === 'vidu');
  const ttsProviders = (raw.ttsProviders ?? []).filter(
    (p) => (p.type as string) !== 'custom_openai_audio',
  );
  return {
    videoProviders,
    defaultVideoProviderId: videoProviders.some((p) => p.id === raw.defaultVideoProviderId)
      ? (raw.defaultVideoProviderId ?? null)
      : (videoProviders[0]?.id ?? null),
    ttsProviders,
    defaultTtsProviderId: ttsProviders.some((p) => p.id === raw.defaultTtsProviderId)
      ? (raw.defaultTtsProviderId ?? null)
      : (ttsProviders[0]?.id ?? null),
  };
}

/** 补默认值 + 跑迁移链，Electron 文件与 localStorage 两条加载路径共用。 */
function normalizeRawAISettings(raw: AISettings): AISettings {
  const media = sanitizeRemovedMediaProviders(raw);
  const filled: AISettings = {
    ...raw,
    llmProviders: raw.llmProviders ?? [],
    defaultProviderId: raw.defaultProviderId ?? null,
    defaultModel: raw.defaultModel ?? null,
    enableThinking: raw.enableThinking ?? true,
    minimaxApiKey: raw.minimaxApiKey ?? '',
    minimaxVoiceId: raw.minimaxVoiceId ?? 'male-qn-qingse',
    minimaxSpeed: raw.minimaxSpeed ?? 1.0,
    minimaxVol: raw.minimaxVol ?? 1.0,
    minimaxPitch: raw.minimaxPitch ?? 0,
    minimaxEmotion: raw.minimaxEmotion ?? '',
    minimaxModel: raw.minimaxModel ?? 'speech-2.8-hd',
    ttsProviders: media.ttsProviders,
    defaultTtsProviderId: media.defaultTtsProviderId,
    defaultTtsVoiceId: raw.defaultTtsVoiceId ?? null,
    ttsVoices: raw.ttsVoices ?? [],
    audioGeneration: normalizeSunoAudioSettings(raw.audioGeneration),
    imageProviders: raw.imageProviders ?? [],
    defaultImageProviderId: raw.defaultImageProviderId ?? null,
    defaultImageModel: raw.defaultImageModel ?? null,
    globalCoverImagePrompt: raw.globalCoverImagePrompt ?? '',
    videoProviders: media.videoProviders,
    defaultVideoProviderId: media.defaultVideoProviderId,
    defaultVideoModel: raw.defaultVideoModel ?? null,
    promptBindings: raw.promptBindings ?? {},
    cardGenerationConcurrency: normalizeCardGenerationConcurrency(raw.cardGenerationConcurrency),
    defaultStylePresetId:
      typeof raw.defaultStylePresetId === 'string' && raw.defaultStylePresetId.trim()
        ? raw.defaultStylePresetId
        : DEFAULT_STYLE_PRESET_ID,
  };
  return normalizeTTSSettings(migrateImageProviders(migrateToProviders(filled)));
}

export async function loadAISettings(): Promise<AISettings | null> {
  if (typeof window === 'undefined' || !window.electronAPI) return null;
  try {
    const file = await loadGlobalSettingsFile();
    if (!file?.aiSettings) return null;
    const settings = normalizeRawAISettings(file.aiSettings);
    // 迁移链改变了持久化形态时回写一次。归一化会新建数组，引用比较永真，
    // 这里用结构比较；加载每次仅一回，序列化开销可忽略。
    if (JSON.stringify(settings) !== JSON.stringify(file.aiSettings)) {
      void saveAISettings(settings);
    }
    return settings;
  } catch (error) {
    console.warn('[ai-settings] 读取全局设置失败', error);
    return null;
  }
}

export async function saveAISettings(settings: AISettings): Promise<void> {
  const normalized: AISettings = normalizeTTSSettings(settings);
  if (typeof window !== 'undefined' && window.electronAPI) {
    await updateGlobalSettingsFile((current) => ({
      ...current,
      aiSettings: normalized,
    }));
  }
}

// ─── AI Save Status ──────────────────────────────────────────────────────────

let currentAISaveStatus: SaveStatus = 'idle';
const aiSaveStatusListeners = new Set<(status: SaveStatus) => void>();

function emitAISaveStatus(status: SaveStatus): void {
  currentAISaveStatus = status;
  for (const listener of aiSaveStatusListeners) {
    listener(status);
  }
}

export function getCurrentAISaveStatus(): SaveStatus {
  return currentAISaveStatus;
}

export function subscribeToAISaveStatus(listener: (status: SaveStatus) => void): () => void {
  aiSaveStatusListeners.add(listener);
  listener(currentAISaveStatus);
  return () => {
    aiSaveStatusListeners.delete(listener);
  };
}

// ─── Auto-save subscription ──────────────────────────────────────────────────

let aiSaveTimer: ReturnType<typeof setTimeout> | null = null;

if (typeof window !== 'undefined') {
  useAIStore.subscribe((state, prevState) => {
    if (
      state.analysisResult === prevState.analysisResult &&
      state.coverCandidates === prevState.coverCandidates
    ) {
      return;
    }

    const projectDir = getCurrentProjectDir();
    if (!projectDir || !window.electronAPI?.saveProjectSection) {
      return;
    }

    emitAISaveStatus('saving');
    const productionGuard = getProductionSaveGuard();
    if (aiSaveTimer) {
      clearTimeout(aiSaveTimer);
    }

    aiSaveTimer = setTimeout(() => {
      const persistedState = createPersistedAIState(
        state.analysisResult,
        state.coverCandidates,
      );
      const saveRequest = productionGuard
        ? window.electronAPI.saveProjectSection(
            projectDir,
            'aiAnalysis',
            JSON.stringify(persistedState),
            productionGuard,
          )
        : window.electronAPI.saveProjectSection(
            projectDir,
            'aiAnalysis',
            JSON.stringify(persistedState),
          );
      void saveRequest
        .then(() => {
          emitAISaveStatus('saved');
        })
        .catch((error) => {
          console.error('保存 AI 分析数据失败:', error);
          emitAISaveStatus('error');
        });
    }, 300);
  });
}
