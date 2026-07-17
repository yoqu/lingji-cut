import { create } from 'zustand';
import {
  debouncedSaveScriptSection,
  persistScriptProjectDir,
} from '../lib/script-persistence';
import type { WorkbenchStage } from '../lib/script-workbench-stage';
import { loadSelectedRole, saveSelectedRole } from '../lib/settings-storage';
import type {
  VideoImportProgress,
  VideoImportResult,
  VideoImportSourceInput,
  VideoImportStatus,
} from '../lib/video-import-types';

export type AnnotationSeverity = 'error' | 'warning' | 'info';
export type AnnotationStatus = 'pending' | 'accepted' | 'dismissed';

export type ReviewState = 'idle' | 'pending' | 'issues' | 'clean' | 'stale';

export interface WorkspaceFilesState {
  hasOriginalFile: boolean;
  hasScriptFile: boolean;
}

export interface AgentOperationState {
  isOperating: boolean;
  operationType: 'generate' | 'review' | 'rewrite' | 'custom' | null;
  progress: number;
  canInterrupt: boolean;
  /** 用户点击界面后转入后台模式：视觉层关闭，底层操作继续 */
  backgrounded: boolean;
}

export interface EditorAgentState {
  readOnly: boolean;
  virtualCursorPos: number | null;
  streamingActive: boolean;
}

export interface ActiveStreamState {
  streamId: string | null;
  filePath: string | null;
  kind: 'generate' | 'rewrite' | 'update' | null;
  phase: 'idle' | 'preparing' | 'streaming' | 'playing' | 'finalizing' | 'awaiting_commit' | 'stopped';
}

export interface Annotation {
  id: string;
  startOffset: number;
  endOffset: number;
  originalText: string;
  quotedText: string;
  docVersion: number;
  stale?: boolean;
  issue: string;
  suggestion: string;
  severity: AnnotationSeverity;
  status: AnnotationStatus;
}

/** 工作台回调：由 ScriptWorkbench ���册，供 GuideCards 等组件调用 */
export interface WorkbenchCallbacks {
  importText: (() => void) | null;
  createBlank: (() => void) | null;
  focusEditor: (() => void) | null;
  /** 选择工作区文件并创建 original.md */
  importFileAsOriginal: ((relativePath: string) => Promise<void>) | null;
  /** 内置 LLM 首次/直接生成口播稿（流式打字机动画） */
  generateScript: (() => Promise<void>) | null;
  /** 直接复用工作台内部生成链路重新生成口播稿 */
  regenerateScript: (() => Promise<void>) | null;
  /** 内置 LLM 审稿（带扫描动画） */
  reviewScript: (() => Promise<void>) | null;
  /** 保存所有脏文件 */
  save: (() => void) | null;
  /** 打开搜索面板 */
  find: (() => void) | null;
  /** 打开搜索替换面板 */
  findReplace: (() => void) | null;
}

interface ScriptState {
  projectDir: string | null;
  originalText: string;
  scriptText: string;
  selectedTemplate: string;
  annotations: Annotation[];
  generating: boolean;
  reviewing: boolean;
  openedFile: string | null;
  fileDirtyMap: Record<string, boolean>;
  fileConflictMap: Record<string, boolean>;
  stashedContent: Record<string, string>;
  /** @deprecated 将在集成阶段移除 */
  drawerVisible: boolean;
  /** @deprecated 将在集成阶段移除 */
  drawerContent: 'template' | 'annotations' | null;
  // --- 新增工作区/审查/流式会话状态 ---
  workspaceFiles: WorkspaceFilesState;
  agentOperation: AgentOperationState;
  editorAgent: EditorAgentState;
  reviewState: ReviewState;
  scriptDocVersion: number;
  activeStream: ActiveStreamState;
  workbenchCallbacks: WorkbenchCallbacks;
  /** 非 original/script 文件的编辑器内容 */
  extraFileContents: Record<string, string>;
  /** MCP 更新后需要高亮的行号列表 */
  mcpChangeHighlightLines: number[];
  /** 当前选中的口播角色 ID */
  selectedRole: string;
  /** 生成完成后显示审稿推荐横幅 */
  showReviewBanner: boolean;
  /** 审稿浮动光标的屏幕坐标（null 时隐藏） */
  reviewCursorPos: { x: number; y: number } | null;
  /** 审稿呼吸光效是否激活 */
  reviewBreathing: boolean;
  /** 写稿工作台是否已挂载 */
  workbenchMounted: boolean;
  /** 用户手动校准工作台阶段，null 表示继续自动判断 */
  manualStageOverride: WorkbenchStage | null;
  videoImportStatus: VideoImportStatus | null;
  videoImportProgress: VideoImportProgress | null;
  lastVideoImport: VideoImportResult | null;
  historyPreview: {
    active: boolean;
    versionId: number | null;
    content: string | null;
    versionMeta: {
      id: number;
      fileName: string;
      source: string;
      providerName: string | null;
      modelName: string | null;
      label: string | null;
      byteSize: number;
      createdAt: string;
    } | null;
  };
  /** 从欢迎页传入的待处理导入源（抖音链接 / 本地视频 / 本地音频），进入工作台后自动触发导入 */
  pendingMediaImport: VideoImportSourceInput | null;
  /** 从欢迎页传入的待写入文稿内容，进入工作台后自动写入 original.md 并起飞 AI 写稿 */
  pendingImportedScript: { content: string } | null;
  /** 文件树当前视图：'all' 显示全部文件，'resources' 显示稿件资源过滤视图 */
  fileTreeView: 'all' | 'resources';
}

interface ScriptActions {
  setProjectDir: (dir: string | null) => void;
  setOriginalText: (text: string) => void;
  setScriptText: (text: string) => void;
  /**
   * 外部直接改 script.md / original.md（file-first）后把内容真实灌回工作台。
   * 与流式生成不同：不播光标/打字动画，直接 set 内存正文（编辑器即绑定该正文）。
   * kind==='script' 时额外补建一个版本快照（source: 'external'），保住"script.md 保存即生成版本"。
   * 防回环：内容与当前一致则直接返回，不建版本、不更新。
   */
  applyExternalScriptFile: (kind: 'script' | 'original', content: string) => void;
  setSelectedTemplate: (id: string) => void;
  setAnnotations: (annotations: Annotation[]) => void;
  setGenerating: (generating: boolean) => void;
  setReviewing: (reviewing: boolean) => void;
  setOpenedFile: (file: string | null) => void;
  setFileDirty: (file: string, dirty: boolean) => void;
  setFileConflict: (file: string, conflict: boolean) => void;
  stashExternalContent: (file: string, content: string) => void;
  clearAllDirty: () => void;
  clearConflict: (file: string) => void;
  /** @deprecated 将在集成阶段移除 */
  openDrawer: (content: 'template' | 'annotations') => void;
  /** @deprecated 将在集成阶段移除 */
  closeDrawer: () => void;
  acceptAnnotation: (id: string) => void;
  dismissAnnotation: (id: string) => void;
  acceptAllAnnotations: () => void;
  dismissAllAnnotations: () => void;
  restoreState: (params: {
    projectDir: string;
    originalText: string;
    scriptText: string;
    selectedTemplate: string;
    annotations: Annotation[];
    workspaceFiles?: WorkspaceFilesState;
    reviewState?: ReviewState;
    scriptDocVersion?: number;
    manualStageOverride?: WorkbenchStage | null;
    fileTreeView?: 'all' | 'resources';
  }) => void;
  reset: () => void;
  clearProjectSession: () => void;
  // --- 新增 actions ---
  setWorkspaceFiles: (state: Partial<WorkspaceFilesState>) => void;
  setAgentOperation: (state: Partial<AgentOperationState>) => void;
  setEditorAgent: (state: Partial<EditorAgentState>) => void;
  setReviewState: (state: ReviewState) => void;
  bumpScriptDocVersion: () => void;
  setActiveStream: (state: Partial<ActiveStreamState>) => void;
  markReviewStale: () => void;
  startAgentOperation: (type: AgentOperationState['operationType']) => void;
  /** 将当前操作转入后台：关闭视觉层，底层继续 */
  backgroundAgentOperation: () => void;
  stopAgentOperation: (options?: { resetStream?: boolean }) => void;
  clearActiveStream: () => void;
  registerWorkbenchCallbacks: (cbs: Partial<WorkbenchCallbacks>) => void;
  setExtraFileContent: (file: string, content: string) => void;
  removeExtraFile: (file: string) => void;
  setMcpChangeHighlightLines: (lines: number[]) => void;
  clearMcpChangeHighlight: () => void;
  setSelectedRole: (roleId: string) => void;
  setShowReviewBanner: (show: boolean) => void;
  setReviewCursorPos: (pos: { x: number; y: number } | null) => void;
  setReviewBreathing: (active: boolean) => void;
  setWorkbenchMounted: (mounted: boolean) => void;
  setManualStageOverride: (stage: WorkbenchStage | null) => void;
  clearManualStageOverride: () => void;
  setVideoImportProgress: (progress: VideoImportProgress | null) => void;
  setLastVideoImport: (result: VideoImportResult | null) => void;
  clearVideoImportState: () => void;
  enterHistoryPreview: (versionId: number, content: string, meta: ScriptState['historyPreview']['versionMeta']) => void;
  exitHistoryPreview: () => void;
  setPendingMediaImport: (source: VideoImportSourceInput | null) => void;
  setPendingImportedScript: (payload: { content: string } | null) => void;
  setFileTreeView: (view: 'all' | 'resources') => void;
}

const initialState: ScriptState = {
  projectDir: null,
  originalText: '',
  scriptText: '',
  selectedTemplate: 'news-broadcast',
  annotations: [],
  generating: false,
  reviewing: false,
  openedFile: null,
  fileDirtyMap: {},
  fileConflictMap: {},
  stashedContent: {},
  drawerVisible: false,
  drawerContent: null,
  workspaceFiles: {
    hasOriginalFile: false,
    hasScriptFile: false,
  },
  agentOperation: {
    isOperating: false,
    operationType: null,
    progress: 0,
    canInterrupt: true,
    backgrounded: false,
  },
  editorAgent: {
    readOnly: false,
    virtualCursorPos: null,
    streamingActive: false,
  },
  reviewState: 'idle',
  scriptDocVersion: 0,
  activeStream: {
    streamId: null,
    filePath: null,
    kind: null,
    phase: 'idle',
  },
  workbenchCallbacks: {
    importText: null,
    createBlank: null,
    focusEditor: null,
    importFileAsOriginal: null,
    generateScript: null,
    regenerateScript: null,
    reviewScript: null,
    save: null,
    find: null,
    findReplace: null,
  },
  extraFileContents: {},
  mcpChangeHighlightLines: [],
  selectedRole: loadSelectedRole(),
  showReviewBanner: false,
  reviewCursorPos: null,
  reviewBreathing: false,
  workbenchMounted: false,
  manualStageOverride: null,
  videoImportStatus: null,
  videoImportProgress: null,
  lastVideoImport: null,
  historyPreview: {
    active: false,
    versionId: null,
    content: null,
    versionMeta: null,
  },
  pendingMediaImport: null,
  pendingImportedScript: null,
  fileTreeView: 'resources',
};

export const useScriptStore = create<ScriptState & ScriptActions>((set, get) => ({
  ...initialState,

  setProjectDir: (dir) => {
    set({ projectDir: dir });
    persistScriptProjectDir(dir);
  },
  setOriginalText: (text) => set({ originalText: text }),
  setScriptText: (text) => set({ scriptText: text }),
  applyExternalScriptFile: (kind, content) => {
    const { scriptText, originalText, projectDir } = get();
    if (kind === 'original') {
      // 防回环：内容一致则不动
      if (content === originalText) return;
      set({ originalText: content });
      return;
    }
    // kind === 'script'
    // 防回环：与当前正文一致则不灌回、不补建版本
    if (content === scriptText) return;
    set({ scriptText: content });
    // 补建版本快照（保住"script.md 保存即生成版本"的能力）。
    // 复用脚本历史 IPC（与工作台保存同一通道），标记 source: 'external'。
    if (projectDir && typeof window !== 'undefined' && window.scriptHistoryAPI) {
      void window.scriptHistoryAPI.create({
        projectId: projectDir,
        fileName: 'script.md',
        content,
        source: 'external',
      });
    }
  },
  setSelectedTemplate: (id) => set({ selectedTemplate: id }),
  setAnnotations: (annotations) => set({ annotations }),
  setGenerating: (generating) => set({ generating }),
  setReviewing: (reviewing) => set({ reviewing }),
  setOpenedFile: (file) => set({ openedFile: file }),
  setFileDirty: (file, dirty) =>
    set((state) => {
      if (dirty) {
        return {
          fileDirtyMap: { ...state.fileDirtyMap, [file]: true },
        };
      }

      const { [file]: _removed, ...rest } = state.fileDirtyMap;
      return { fileDirtyMap: rest };
    }),
  setFileConflict: (file, conflict) =>
    set((state) => {
      if (conflict) {
        return {
          fileConflictMap: { ...state.fileConflictMap, [file]: true },
        };
      }

      const { [file]: _removed, ...rest } = state.fileConflictMap;
      return { fileConflictMap: rest };
    }),
  stashExternalContent: (file, content) =>
    set((state) => ({
      stashedContent: { ...state.stashedContent, [file]: content },
    })),
  clearAllDirty: () => set({ fileDirtyMap: {} }),
  clearConflict: (file) =>
    set((state) => {
      const { [file]: _removedConflict, ...nextConflictMap } = state.fileConflictMap;
      const { [file]: _removedStash, ...nextStashedContent } = state.stashedContent;
      return {
        fileConflictMap: nextConflictMap,
        stashedContent: nextStashedContent,
      };
    }),
  openDrawer: (content) => set({ drawerVisible: true, drawerContent: content }),
  closeDrawer: () => set({ drawerVisible: false, drawerContent: null }),

  acceptAnnotation: (id) => {
    const { annotations, scriptText } = get();
    const annotation = annotations.find((a) => a.id === id);
    if (!annotation || annotation.status !== 'pending') return;

    const hasSuggestion = annotation.suggestion && annotation.suggestion !== annotation.originalText;
    let updatedText = scriptText;
    if (hasSuggestion) {
      // 使用 offset 精确替换，避免 String.replace 首次匹配问题
      const { startOffset, endOffset, suggestion } = annotation;
      if (startOffset >= 0 && endOffset <= scriptText.length && startOffset <= endOffset) {
        updatedText = scriptText.slice(0, startOffset) + suggestion + scriptText.slice(endOffset);
      }
    }

    // 计算偏移增量，调整后续批注的 offset
    const delta = hasSuggestion ? annotation.suggestion.length - (annotation.endOffset - annotation.startOffset) : 0;

    set({
      scriptText: updatedText,
      ...(hasSuggestion ? { fileDirtyMap: { ...get().fileDirtyMap, 'script.md': true } } : {}),
      annotations: annotations.map((a) => {
        if (a.id === id) return { ...a, status: 'accepted' as const };
        // 调整替换位置之后的批注偏移
        if (delta !== 0 && a.startOffset > annotation.startOffset) {
          return { ...a, startOffset: a.startOffset + delta, endOffset: a.endOffset + delta };
        }
        return a;
      }),
    });
  },

  dismissAnnotation: (id) => {
    set({
      annotations: get().annotations.map((a) =>
        a.id === id ? { ...a, status: 'dismissed' as const } : a,
      ),
    });
  },

  acceptAllAnnotations: () => {
    const { annotations, scriptText } = get();
    const pending = annotations.filter((a) => a.status === 'pending');
    // 按 startOffset 降序排列，从后往前替换，避免偏移错位
    const sorted = [...pending].sort((a, b) => b.startOffset - a.startOffset);

    let updatedText = scriptText;
    let hasChange = false;
    for (const annotation of sorted) {
      if (annotation.suggestion && annotation.suggestion !== annotation.originalText) {
        const { startOffset, endOffset, suggestion } = annotation;
        if (startOffset >= 0 && endOffset <= updatedText.length && startOffset <= endOffset) {
          updatedText = updatedText.slice(0, startOffset) + suggestion + updatedText.slice(endOffset);
          hasChange = true;
        }
      }
    }

    set({
      scriptText: updatedText,
      ...(hasChange ? { fileDirtyMap: { ...get().fileDirtyMap, 'script.md': true } } : {}),
      annotations: annotations.map((a) =>
        a.status === 'pending' ? { ...a, status: 'accepted' as const } : a,
      ),
    });
  },

  dismissAllAnnotations: () => {
    set({
      annotations: get().annotations.map((a) =>
        a.status === 'pending' ? { ...a, status: 'dismissed' as const } : a,
      ),
    });
  },

  restoreState: (params) =>
    set({
      projectDir: params.projectDir,
      originalText: params.originalText,
      scriptText: params.scriptText,
      selectedTemplate: params.selectedTemplate,
      annotations: params.annotations,
      generating: false,
      reviewing: false,
      openedFile: null,
      fileDirtyMap: {},
      fileConflictMap: {},
      stashedContent: {},
      drawerVisible: false,
      drawerContent: null,
      workspaceFiles: params.workspaceFiles ?? {
        hasOriginalFile: false,
        hasScriptFile: false,
      },
      reviewState: params.reviewState ?? 'idle',
      scriptDocVersion: params.scriptDocVersion ?? 0,
      manualStageOverride: params.manualStageOverride ?? null,
      ...(params.fileTreeView ? { fileTreeView: params.fileTreeView } : {}),
    }),

  reset: () => {
    const { projectDir, selectedRole } = get();
    // 重置脚本内容但保留工作目录（与 Editor 共享）
    set({ ...initialState, projectDir, selectedRole, fileTreeView: 'resources' });
  },

  clearProjectSession: () => {
    const { selectedRole } = get();
    set({ ...initialState, projectDir: null, selectedRole, fileTreeView: 'resources' });
  },

  // --- 新增 actions ---

  setWorkspaceFiles: (partial) =>
    set((s) => ({ workspaceFiles: { ...s.workspaceFiles, ...partial } })),

  setAgentOperation: (partial) =>
    set((s) => ({ agentOperation: { ...s.agentOperation, ...partial } })),

  setEditorAgent: (partial) =>
    set((s) => ({ editorAgent: { ...s.editorAgent, ...partial } })),

  setReviewState: (reviewState) => set({ reviewState }),

  bumpScriptDocVersion: () =>
    set((s) => ({ scriptDocVersion: s.scriptDocVersion + 1 })),

  setActiveStream: (partial) =>
    set((s) => ({ activeStream: { ...s.activeStream, ...partial } })),

  markReviewStale: () => set({ reviewState: 'stale' }),

  startAgentOperation: (type) =>
    set({
      agentOperation: {
        isOperating: true,
        operationType: type,
        progress: 0,
        canInterrupt: true,
        backgrounded: false,
      },
      editorAgent: {
        readOnly: true,
        virtualCursorPos: null,
        streamingActive: type !== 'review',
      },
    }),

  backgroundAgentOperation: () =>
    set((s) => ({
      agentOperation: { ...s.agentOperation, backgrounded: true },
      editorAgent: { readOnly: false, virtualCursorPos: null, streamingActive: false },
    })),

  stopAgentOperation: (options) =>
    set((s) => ({
      agentOperation: {
        isOperating: false,
        operationType: null,
        progress: 0,
        canInterrupt: true,
        backgrounded: false,
      },
      editorAgent: { readOnly: false, virtualCursorPos: null, streamingActive: false },
      activeStream: options?.resetStream === false
        ? s.activeStream
        : { streamId: null, filePath: null, kind: null, phase: 'idle' },
    })),

  clearActiveStream: () =>
    set({
      activeStream: { streamId: null, filePath: null, kind: null, phase: 'idle' },
    }),

  registerWorkbenchCallbacks: (cbs) =>
    set((s) => ({
      workbenchCallbacks: { ...s.workbenchCallbacks, ...cbs },
    })),

  setExtraFileContent: (file, content) =>
    set((s) => ({
      extraFileContents: { ...s.extraFileContents, [file]: content },
    })),

  removeExtraFile: (file) =>
    set((s) => {
      const { [file]: _, ...rest } = s.extraFileContents;
      return { extraFileContents: rest };
    }),

  setMcpChangeHighlightLines: (lines) => set({ mcpChangeHighlightLines: lines }),
  clearMcpChangeHighlight: () => set({ mcpChangeHighlightLines: [] }),

  setSelectedRole: (roleId) => {
    set({ selectedRole: roleId });
    saveSelectedRole(roleId);
  },

  setShowReviewBanner: (show) => set({ showReviewBanner: show }),
  setReviewCursorPos: (pos) => set({ reviewCursorPos: pos }),
  setReviewBreathing: (active) => set({ reviewBreathing: active }),
  setWorkbenchMounted: (mounted) => set({ workbenchMounted: mounted }),
  setManualStageOverride: (stage) => set({ manualStageOverride: stage }),
  clearManualStageOverride: () => set({ manualStageOverride: null }),
  setVideoImportProgress: (progress) =>
    set({
      videoImportStatus: progress?.status ?? null,
      videoImportProgress: progress,
    }),
  setLastVideoImport: (result) => set({ lastVideoImport: result }),
  clearVideoImportState: () =>
    set({
      videoImportStatus: null,
      videoImportProgress: null,
      lastVideoImport: null,
    }),

  enterHistoryPreview: (versionId, content, meta) =>
    set({
      historyPreview: { active: true, versionId, content, versionMeta: meta },
      editorAgent: { readOnly: true, virtualCursorPos: null, streamingActive: false },
    }),

  exitHistoryPreview: () =>
    set({
      historyPreview: { active: false, versionId: null, content: null, versionMeta: null },
      editorAgent: { readOnly: false, virtualCursorPos: null, streamingActive: false },
    }),

  setPendingMediaImport: (source) => set({ pendingMediaImport: source }),

  setPendingImportedScript: (payload) => set({ pendingImportedScript: payload }),

  setFileTreeView: (view) => set({ fileTreeView: view }),
}));

// 自动保存：当 reviewState / scriptDocVersion / template / annotations 变化时，
// 通过 save-project-section IPC 写入 project.json 的 script 段
useScriptStore.subscribe((state, prevState) => {
  if (!state.projectDir) return;

  const changed =
    state.reviewState !== prevState.reviewState ||
    state.scriptDocVersion !== prevState.scriptDocVersion ||
    state.selectedTemplate !== prevState.selectedTemplate ||
    state.annotations !== prevState.annotations ||
    state.manualStageOverride !== prevState.manualStageOverride;

  if (!changed) return;

  const scriptSection = {
    templateId: state.selectedTemplate,
    annotations: state.annotations,
    reviewState: state.reviewState,
    lastReviewedDocVersion: state.scriptDocVersion,
    manualStageOverride: state.manualStageOverride,
  };

  debouncedSaveScriptSection(state.projectDir, scriptSection);
});
