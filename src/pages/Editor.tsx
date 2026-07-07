import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AIPanel } from '../components/AIPanel';
import { AssetPanel } from '../components/AssetPanel';
import { EditorInspector, type InspectorSelection } from '../components/EditorInspector';
import { ResizeHandle } from '../components/ResizeHandle';
import { useTaskProgressStore } from '../store/task-progress';
import { ExportSettingsModal } from '../components/ExportSettingsModal';
import { PreviewPanel } from '../components/PreviewPanel';
import type { RemotionPreviewHandle } from '../components/RemotionPreviewPlayer';
import type { SourcePreviewAsset } from '../components/SourceAssetPreviewPlayer';
import { TimelineAIOverlay } from '../components/TimelineAIOverlay';
import { Timeline } from '../components/Timeline';
import type { ProjectOverviewMeta } from '../components/ProjectOverviewPanel';
import type { AppPage, ProjectMetadata } from '../lib/electron-api';
import { createPersistedAIState } from '../lib/ai-persistence';
import { mergeCoverCandidatesFromScannedAssets } from '../lib/ai-persistence';
import { getAISettingsIssue } from '../lib/ai-settings';
import type { ExportConfig } from '../lib/export-settings';
import { createDefaultTextData } from '../lib/text-templates';
import { DEFAULT_VISUAL_TRACK_ID, type OverlayPosition } from '../types';
import type { AIAnalysisResult } from '../types/ai';
import { useAIVideoWorkflow } from '../hooks/useAIVideoWorkflow';
import { useViewportSize } from '../hooks/useViewportSize';
import { getEditorLayoutMode, getTimelinePanelBounds } from '../lib/layout';
import { isTextEditingTarget } from '../lib/native-shortcuts';
import {
  IDLE_SCRUB_STATE,
  beginScrub,
  endScrub,
  resolveSeekResume,
  shouldUpdatePlaybackTime,
} from '../lib/playback';
import {
  getEffectiveTimelineDurationMs,
  getFileNameFromPath,
} from '../lib/utils';
import { loadAISettings, useAIStore } from '../store/ai';
import { useAgentFeedStore } from '../store/agent-feed';
import { useAiEditStore } from '../store/ai-edit';
import { useTimelineStore } from '../store/timeline';
import { usePublishStore } from '../store/publish';
import {
  Alert,
  Button,
  Card,
  CardContent,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../ui';
import { AppIcon } from '../components/AppIcon';
import { AutoRunLauncher } from '../components/AutoRunLauncher';
import { ScriptDriftBanner } from '../components/ScriptDriftBanner';
import styles from './Editor.module.css';

interface EditorProps {
  onAddAsset: () => Promise<void>;
  initialActivePanel?: 'assets' | 'ai';
  onOpenSettings: () => void;
  onUseAsPodcastAudio: (path: string, durationMs: number) => Promise<void>;
  onUseAsPodcastSrt: (path: string) => Promise<void>;
  exportRequestToken: number;
  projectDir?: string;
  isActive?: boolean;
  /** 供 AutoRunResumeBanner 恢复 auto-run 使用 */
  setPage?: (next: AppPage) => void;
}

const TIMELINE_PANEL_HEIGHT_KEY = 'podcast-editor-timeline-panel-height';
const SIDEBAR_WIDTH_KEY = 'podcast-editor-sidebar-width-v4';
const INSPECTOR_WIDTH_KEY = 'podcast-editor-inspector-width';
const RESIZE_HANDLE_THICKNESS = 6;
// 3 列 96px 素材卡 + 2×6px gap + 16px 内边距 + 10px 滚动条槽位 = 326，取 340 留余量
const SIDEBAR_DEFAULT_WIDTH = 340;
const INSPECTOR_DEFAULT_WIDTH = 260;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 480;
const INSPECTOR_MIN_WIDTH = 220;
const INSPECTOR_MAX_WIDTH = 480;
const PREVIEW_MIN_WIDTH = 360;

function readStoredNumber(key: string): number | null {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function Editor({
  onAddAsset,
  initialActivePanel = 'assets',
  onOpenSettings,
  onUseAsPodcastAudio,
  onUseAsPodcastSrt,
  exportRequestToken,
  projectDir = '',
  isActive = false,
  setPage,
}: EditorProps) {
  const viewport = useViewportSize();
  const layout = getEditorLayoutMode(viewport.width, viewport.height);
  const panelBounds = getTimelinePanelBounds(viewport.height, layout.compactTimeline);
  const playerRef = useRef<RemotionPreviewHandle>(null);
  const timelineWrapRef = useRef<HTMLDivElement>(null);
  const currentTimeRef = useRef(0);
  const scrubStateRef = useRef(IDLE_SCRUB_STATE);
  const [timelinePanelHeight, setTimelinePanelHeight] = useState(layout.timelineHeight);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [inspectorWidth, setInspectorWidth] = useState(INSPECTOR_DEFAULT_WIDTH);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [isExportSettingsOpen, setIsExportSettingsOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<{
    outputPath: string;
    elapsedMs: number;
  } | null>(null);
  const [missingScriptDialogOpen, setMissingScriptDialogOpen] = useState(false);
  const [regeneratePodcastDialogOpen, setRegeneratePodcastDialogOpen] = useState(false);
  const [pendingRegenerateScript, setPendingRegenerateScript] = useState<string | null>(null);
  const [pendingReanalyzeEntries, setPendingReanalyzeEntries] = useState<
    ReturnType<typeof useTimelineStore.getState>['srtEntries'] | null
  >(null);
  const [activePanel, setActivePanel] = useState<'assets' | 'ai'>(initialActivePanel);
  const [sourcePreviewAsset, setSourcePreviewAsset] = useState<SourcePreviewAsset | null>(null);
  const [inspectorSelection, setInspectorSelection] = useState<InspectorSelection>({ type: 'empty' });
  const [projectMeta, setProjectMeta] = useState<ProjectOverviewMeta | null>(null);
  const [isProjectMetaLoading, setIsProjectMetaLoading] = useState(false);
  const store = useTimelineStore();
  const clearAIAnalysis = useAIStore((state) => state.clearAnalysis);
  const setAIAnalysisError = useAIStore((state) => state.setAnalysisError);
  const setAIAnalysisResult = useAIStore((state) => state.setAnalysisResult);
  const setCoverCandidates = useAIStore((state) => state.setCoverCandidates);
  const {
    start: startWorkflow,
    cancel: cancelWorkflow,
    retry: retryWorkflow,
    continueFromTtsDone,
    workflow,
  } = useAIVideoWorkflow();
  const aiEditLocked = useAiEditStore((s) => s.locked);
  const aiEditScope = useAiEditStore((s) => s.scope);
  const aiEditReason = useAiEditStore((s) => s.reason);
  const assets = store.assets ?? [];
  const { timeline } = store;
  const overlayCount = timeline.overlays?.length ?? 0;
  const hasAICardOverlays = timeline.overlays?.some(
    (overlay) => overlay.overlayType === 'ai-card',
  ) ?? false;
  const podcastAudioPath = timeline.podcast?.audioPath ?? '';
  const podcastSrtPath = timeline.podcast?.srtPath ?? '';
  const fps = timeline.fps || 30;
  // 时间轴有效时长：取 max(口播音频, 任意 overlay 末端, 1s 兜底)。
  // 没有口播素材时仍保证 Player 能播放完已经添加的动画卡片。
  const effectiveDurationMs = useMemo(
    () => getEffectiveTimelineDurationMs(timeline),
    [timeline],
  );
  const contentLocked = aiEditLocked;
  const lockReasonLabel =
    aiEditScope === 'video' ? '视频内容区已锁定' : aiEditScope === 'script' ? '脚本内容区已锁定' : '内容区已锁定';

  useEffect(() => {
    let cancelled = false;

    if (!projectDir || !window.electronAPI?.getProjectMetadata) {
      setProjectMeta(null);
      setIsProjectMetaLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setIsProjectMetaLoading(true);

    void window.electronAPI
      .getProjectMetadata(projectDir)
      .then((metadata: ProjectMetadata) => {
        if (cancelled) {
          return;
        }

        setProjectMeta(mapProjectMetadata(metadata));
      })
      .catch((error) => {
        console.error('读取项目元数据失败:', error);
        if (!cancelled) {
          setProjectMeta(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsProjectMetaLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [overlayCount, podcastAudioPath, podcastSrtPath, projectDir]);

  // 自动扫描项目目录下的媒体素材
  useEffect(() => {
    if (!projectDir) return;
    let cancelled = false;

    void window.electronAPI
      .scanProjectAssets(projectDir)
      .then((scanned) => {
        if (cancelled || scanned.length === 0) {
          return;
        }

        useTimelineStore.getState().addAssets(scanned);

        const aiState = useAIStore.getState();
        const mergedCandidates = mergeCoverCandidatesFromScannedAssets(
          projectDir,
          aiState.coverCandidates,
          scanned,
          aiState.analysisResult?.coverPrompts[0] ?? '目录扫描封面',
        );

        if (JSON.stringify(mergedCandidates) === JSON.stringify(aiState.coverCandidates)) {
          return;
        }

        setCoverCandidates(mergedCandidates);

        const persistedState = createPersistedAIState(
          aiState.analysisResult,
          mergedCandidates,
        );

        void window.electronAPI.saveProjectSection(
          projectDir,
          'aiAnalysis',
          JSON.stringify({
            analysisResult: persistedState.analysisResult,
            coverCandidates: persistedState.coverCandidates,
          }),
        );
      })
      .catch((err) => {
        console.error('扫描项目素材失败:', err);
      });

    return () => { cancelled = true; };
  }, [projectDir, setCoverCandidates]);

  const sidebarMaxWidth = useMemo(
    () => Math.min(
      SIDEBAR_MAX_WIDTH,
      Math.max(SIDEBAR_MIN_WIDTH, viewport.width - inspectorWidth - PREVIEW_MIN_WIDTH - RESIZE_HANDLE_THICKNESS * 2),
    ),
    [inspectorWidth, viewport.width],
  );

  const inspectorMaxWidth = useMemo(
    () => Math.min(
      INSPECTOR_MAX_WIDTH,
      Math.max(INSPECTOR_MIN_WIDTH, viewport.width - sidebarWidth - PREVIEW_MIN_WIDTH - RESIZE_HANDLE_THICKNESS * 2),
    ),
    [sidebarWidth, viewport.width],
  );

  useEffect(() => {
    setTimelinePanelHeight((currentHeight) => {
      const storedHeight = readStoredNumber(TIMELINE_PANEL_HEIGHT_KEY);
      const nextHeight = storedHeight ?? currentHeight ?? layout.timelineHeight;

      return clamp(nextHeight, panelBounds.minHeight, panelBounds.maxHeight);
    });
  }, [layout.timelineHeight, panelBounds.maxHeight, panelBounds.minHeight]);

  useEffect(() => {
    setSidebarWidth((current) => {
      const stored = readStoredNumber(SIDEBAR_WIDTH_KEY);
      const next = stored ?? current ?? SIDEBAR_DEFAULT_WIDTH;
      return clamp(next, SIDEBAR_MIN_WIDTH, sidebarMaxWidth);
    });
  }, [sidebarMaxWidth]);

  useEffect(() => {
    setInspectorWidth((current) => {
      const stored = readStoredNumber(INSPECTOR_WIDTH_KEY);
      const next = stored ?? current ?? INSPECTOR_DEFAULT_WIDTH;
      return clamp(next, INSPECTOR_MIN_WIDTH, inspectorMaxWidth);
    });
  }, [inspectorMaxWidth]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      return;
    }

    window.localStorage.setItem(TIMELINE_PANEL_HEIGHT_KEY, String(timelinePanelHeight));
  }, [timelinePanelHeight]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      return;
    }
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      return;
    }
    window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorWidth));
  }, [inspectorWidth]);

  useEffect(() => {
    const cleanup = window.electronAPI.onRenderProgress((progress) => {
      setExportProgress(progress);
      // 更新统一进度系统
      const tasks = useTaskProgressStore.getState().tasks;
      for (const [id, task] of tasks) {
        if (task.category === 'export' && task.status === 'active') {
          useTaskProgressStore.getState().updateTask(id, {
            progress: Math.round(progress * 100),
            phase: progress < 0.1 ? 'bundling' : 'rendering',
          });
          break;
        }
      }
    });

    return cleanup;
  }, []);

  const handlePreviewTimeUpdate = useCallback((nextTimeMs: number) => {
    if (!shouldUpdatePlaybackTime(currentTimeRef.current, nextTimeMs)) {
      return;
    }
    currentTimeRef.current = nextTimeMs;
    setCurrentTimeMs(nextTimeMs);
  }, []);

  const handlePreviewPlay = useCallback(() => setIsPlaying(true), []);
  const handlePreviewPause = useCallback(() => setIsPlaying(false), []);
  const handlePreviewEnded = useCallback(() => {
    currentTimeRef.current = effectiveDurationMs;
    setCurrentTimeMs(effectiveDurationMs);
    setIsPlaying(false);
  }, [effectiveDurationMs]);

  const clearSourcePreview = useCallback(() => {
    setSourcePreviewAsset(null);
  }, []);

  const handlePreviewAsset = useCallback((asset: SourcePreviewAsset) => {
    if (asset.type !== 'image' && asset.type !== 'video') {
      return;
    }

    const current = sourcePreviewAsset;
    if (current?.path === asset.path) {
      setSourcePreviewAsset(null);
      return;
    }

    playerRef.current?.pause();
    setIsPlaying(false);
    setSourcePreviewAsset(asset);
  }, [sourcePreviewAsset]);

  useEffect(() => {
    if (!sourcePreviewAsset) {
      return;
    }

    if (!assets.some((asset) => asset.path === sourcePreviewAsset.path)) {
      setSourcePreviewAsset(null);
    }
  }, [assets, sourcePreviewAsset]);

  // exportRequestToken 是 App 级计数器，用户点击菜单/工具栏「导出」时自增。
  // 这里用 ref 记录组件"已处理过的"token 值，仅在 token 真正递增时弹出导出框，
  // 避免 Editor 因 page 切换（welcome → workbench/editor）remount 后拿到陈旧 token
  // 被误判为新的导出请求。
  const lastSeenExportTokenRef = useRef(exportRequestToken);
  useEffect(() => {
    if (exportRequestToken === lastSeenExportTokenRef.current) {
      return;
    }
    lastSeenExportTokenRef.current = exportRequestToken;
    setIsExportSettingsOpen(true);
  }, [exportRequestToken]);

  useEffect(() => {
    if (isActive && workflow.step === 'tts_done' && projectDir) {
      continueFromTtsDone(projectDir);
    }
  }, [continueFromTtsDone, isActive, projectDir, workflow.step]);

  const handleTogglePlay = useCallback(() => {
    const player = playerRef.current;
    if (!player) {
      return;
    }

    if (player.isPlaying()) {
      player.pause();
      return;
    }

    player.play();
  }, []);

  // 空格键快捷键：在视频编辑器激活期间切换播放/暂停；文本输入框内不劫持
  useEffect(() => {
    if (!isActive) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' && event.key !== ' ') {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      if (isTextEditingTarget(event.target)) {
        return;
      }
      event.preventDefault();
      handleTogglePlay();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleTogglePlay, isActive]);

  // 拖动开始：在播放时先暂停，拖动期间播放头只跟随光标，避免边播边拖时画面自行前进。
  const handleSeekStart = useCallback(() => {
    const player = playerRef.current;
    if (!player) {
      return;
    }
    const { state, action } = beginScrub(player.isPlaying());
    scrubStateRef.current = state;
    if (action === 'pause') {
      player.pause();
    }
  }, []);

  // 拖动结束：若拖动开始时在播放，则从拖到的位置续播。
  const handleSeekEnd = useCallback(() => {
    const player = playerRef.current;
    const { state, action } = endScrub(scrubStateRef.current);
    scrubStateRef.current = state;
    if (player && action === 'play') {
      player.play();
    }
  }, []);

  const handleSeek = useCallback(
    (targetMs: number) => {
      if (sourcePreviewAsset) {
        clearSourcePreview();
        currentTimeRef.current = targetMs;
        setCurrentTimeMs(targetMs);
        setIsPlaying(false);
        return;
      }

      const player = playerRef.current;
      if (!player) {
        return;
      }

      // player.seek() 会静默暂停（不派发 pause 事件）。一次性 seek（点击/跳转）若此前在播放，
      // 需要 seek 后显式续播，否则会停在「实际暂停但 isPlaying=true」的错位状态。
      const resume = resolveSeekResume(player.isPlaying(), scrubStateRef.current);
      player.seekToMs(targetMs);
      if (resume === 'play') {
        player.play();
      }
      currentTimeRef.current = targetMs;
      setCurrentTimeMs(targetMs);
    },
    [clearSourcePreview, sourcePreviewAsset],
  );

  const handleTimelineSeekStart = useCallback(() => {
    if (sourcePreviewAsset) {
      playerRef.current?.pause();
      scrubStateRef.current = IDLE_SCRUB_STATE;
      setIsPlaying(false);
      clearSourcePreview();
      return;
    }

    handleSeekStart();
  }, [clearSourcePreview, handleSeekStart, sourcePreviewAsset]);

  const handleExport = useCallback(async () => {
    setIsExportSettingsOpen(true);
  }, []);

  const persistAIState = useCallback(
    async (result: AIAnalysisResult | null) => {
      if (!projectDir) {
        return;
      }

      const persistedState = createPersistedAIState(result, []);
      await window.electronAPI.saveProjectSection(
        projectDir,
        'aiAnalysis',
        JSON.stringify(persistedState),
      );
    },
    [projectDir],
  );

  const rerunAiAnalysisForCurrentSrt = useCallback(
    async (entries: ReturnType<typeof useTimelineStore.getState>['srtEntries']) => {
      const settings = await loadAISettings();
      const settingsIssue = getAISettingsIssue(settings);

      clearAIAnalysis();
      await persistAIState(null);

      if (settingsIssue || !settings) {
        setAIAnalysisError(settingsIssue ?? '请先完成 AI 配置后再重新分析');
        setActivePanel('ai');
        return;
      }

      try {
        const result = (await window.electronAPI.analyzeSrt({
          entries,
          settings,
          projectDir: projectDir || undefined,
          projectBindings: useAIStore.getState().projectBindings,
        })) as AIAnalysisResult;
        setAIAnalysisResult(result);
        setCoverCandidates([]);
        await persistAIState(result);
      } catch (error) {
        console.error('重新分析字幕失败:', error);
        setAIAnalysisError(
          error instanceof Error ? error.message : '重新分析字幕失败，请稍后重试。',
        );
      }
    },
    [
      clearAIAnalysis,
      persistAIState,
      projectDir,
      setAIAnalysisError,
      setAIAnalysisResult,
      setCoverCandidates,
    ],
  );

  // ── 生成观测视图停靠：编辑器在场时 openPanel 路由到右侧 Inspector 而非状态栏浮层 ──
  useEffect(() => {
    useAgentFeedStore.getState().setDockMounted(true);
    return () => useAgentFeedStore.getState().setDockMounted(false);
  }, []);

  // 状态栏图标 / 任务行「查看过程」点击 → 切 Inspector 到观测视图
  const feedFocusToken = useAgentFeedStore((s) => s.focusToken);
  const handledFocusRef = useRef(feedFocusToken);
  useEffect(() => {
    if (feedFocusToken !== handledFocusRef.current) {
      handledFocusRef.current = feedFocusToken;
      setInspectorSelection({ type: 'agent-feed' });
    }
  }, [feedFocusToken]);

  // 生成开始自动切入（false→true 边沿，一轮生成只抢占一次）
  const feedHasActive = useAgentFeedStore((s) => s.hasActive);
  const prevFeedActiveRef = useRef(false);
  useEffect(() => {
    if (feedHasActive && !prevFeedActiveRef.current) {
      setInspectorSelection({ type: 'agent-feed' });
    }
    prevFeedActiveRef.current = feedHasActive;
  }, [feedHasActive]);

  // 清空记录 / 切项目后观测视图不悬空
  const feedSessionCount = useAgentFeedStore((s) => s.sessions.size);
  useEffect(() => {
    if (feedSessionCount === 0 && inspectorSelection.type === 'agent-feed') {
      setInspectorSelection({ type: 'empty' });
    }
  }, [feedSessionCount, inspectorSelection.type]);

  const handleOpenAICardInspector = useCallback((cardId: string) => {
    clearSourcePreview();
    // Motion Card 编排模块已下线；所有卡片统一按 ai-card 类型打开 inspector
    setInspectorSelection({ type: 'ai-card', cardId });
    setActivePanel('ai');
  }, [clearSourcePreview]);

  const handleOpenSubtitleInspector = useCallback(() => {
    clearSourcePreview();
    setInspectorSelection({ type: 'subtitle-style' });
  }, [clearSourcePreview]);

  const handleCloseInspector = useCallback(() => {
    setInspectorSelection({ type: 'empty' });
  }, []);

  const handleOpenOverlayInspector = useCallback(
    (overlayId: string) => {
      clearSourcePreview();
      setInspectorSelection({ type: 'overlay', overlayId });
    },
    [clearSourcePreview],
  );

  const handleReplaceAudio = useCallback(async () => {
    const audioPath = await window.electronAPI.selectMediaFile('audio');
    if (!audioPath) {
      return;
    }

    const durationMs = await window.electronAPI
      .getAudioDuration(audioPath)
      .catch(() => store.timeline.podcast?.durationMs ?? 0);

    store.setPodcast(
      audioPath,
      store.timeline.podcast?.srtPath ?? '',
      durationMs,
    );
  }, [store]);

  const handleReplaceSrt = useCallback(async () => {
    const srtPath = await window.electronAPI.selectMediaFile('srt');
    if (!srtPath) {
      return;
    }

    const { entries, durationMs } = await window.electronAPI.parseSrtFile(srtPath);
    store.setSrtEntries(entries);
    store.setPodcast(store.timeline.podcast?.audioPath ?? '', srtPath, durationMs);

    setPendingReanalyzeEntries(entries);
  }, [store]);

  const handleRegeneratePodcastFromScript = useCallback(async () => {
    if (!projectDir) {
      return;
    }
    if (workflow.step !== 'idle' && workflow.step !== 'error') {
      return;
    }

    const scriptContent = await window.electronAPI
      .loadScriptFile(projectDir, 'script.md')
      .catch(() => null);

    if (!scriptContent?.trim()) {
      setMissingScriptDialogOpen(true);
      return;
    }

    setPendingRegenerateScript(scriptContent);
    setRegeneratePodcastDialogOpen(true);
  }, [projectDir, workflow.step]);

  const handleConfirmRegeneratePodcast = useCallback(() => {
    const scriptContent = pendingRegenerateScript;
    setRegeneratePodcastDialogOpen(false);
    setPendingRegenerateScript(null);
    if (!scriptContent?.trim()) {
      return;
    }
    startWorkflow(scriptContent, {
      startFromStep: 'tts_generating',
      ttsOnly: true,
    });
  }, [pendingRegenerateScript, startWorkflow]);

  const handleAddTextOverlay = useCallback(() => {
    clearSourcePreview();
    const store = useTimelineStore.getState();
    const currentTime = currentTimeRef.current;
    const { width, height } = store.timeline;

    // 找到最顶层（order 最高）的视觉轨道，确保文字渲染在最前面
    const visualTracks = store.timeline.tracks
      .filter((t) => t.kind === 'visual')
      .sort((a, b) => b.order - a.order);
    const trackId = visualTracks[0]?.id ?? DEFAULT_VISUAL_TRACK_ID;

    const overlayId = store.addOverlay({
      type: 'text',
      assetPath: '',
      trackId,
      startMs: Math.max(0, Math.round(currentTime)),
      durationMs: 5000,
      position: {
        x: (width - 800) / 2,
        y: (height - 200) / 2,
        width: 800,
        height: 200,
      },
      textData: createDefaultTextData(),
    });

    // 自动打开 overlay 检查器
    setInspectorSelection({ type: 'overlay', overlayId });

    // 将播放头对齐到文字片段中间，避免入场动画未完成导致预览不可见
    const insertedOverlay = useTimelineStore
      .getState()
      .timeline.overlays.find((o) => o.id === overlayId);
    if (insertedOverlay) {
      const midpointMs = insertedOverlay.startMs + Math.floor(insertedOverlay.durationMs / 2);
      handleSeek(midpointMs);
    }
  }, [clearSourcePreview, handleSeek]);

  const handleSelectOverlayOnCanvas = useCallback(
    (overlayId: string | null) => {
      clearSourcePreview();
      if (overlayId) {
        const overlay = timeline.overlays.find((o) => o.id === overlayId);
        if (overlay) {
          setInspectorSelection({ type: 'overlay', overlayId });
          return;
        }
      }
      setInspectorSelection({ type: 'empty' });
    },
    [clearSourcePreview, timeline.overlays],
  );

  const handleUpdateOverlayPosition = useCallback(
    (overlayId: string, position: OverlayPosition) => {
      useTimelineStore.getState().updateOverlay(overlayId, { position });
    },
    [],
  );

  const handleConfirmExport = useCallback(async ({ outputPath: savePath, exportConfig }: {
    outputPath: string;
    exportConfig: ExportConfig;
  }) => {
    setIsExportSettingsOpen(false);
    setOutputPath(savePath);
    setIsExporting(true);
    setExportProgress(0);
    setExportError(null);

    const exportStartedAt = Date.now();
    const exportTaskId = `export-video-${exportStartedAt}`;
    // 给本次导出生成 auto-run jsonl runId，主进程会写 stage.assets/compile-cards/bundle/render
    // 与 run.start/end，后续"导出慢"诊断时按 AGENTS.md 流程直接读 jsonl 找瓶颈。
    const telemetryRunId = `export-${exportStartedAt}-${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).slice(0, 8)}`;
    useTaskProgressStore.getState().startTask({
      id: exportTaskId,
      category: 'export',
      label: '视频导出',
      mode: 'determinate',
      progress: 0,
      phase: 'bundling',
      level: 2,
      canCancel: false,
    });

    try {
      await window.electronAPI.renderVideo({
        timeline: JSON.stringify(timeline),
        outputPath: savePath,
        exportConfig,
        // 切分后的字幕仅存在于内存 store 中（磁盘 .srt 保持原始 MiniMax 输出），
        // 必须显式传给主进程，导出才能与预览播放器使用同一套切分字幕。
        srtEntries: useTimelineStore.getState().srtEntries,
        telemetryRunId,
      });
      setExportProgress(1);
      const elapsedMs = Date.now() - exportStartedAt;
      useTaskProgressStore.getState().completeTask(exportTaskId, {
        label: '在 Finder 中显示',
        handler: () => window.electronAPI.showItemInFolder(savePath),
      });
      // 联动发布选项卡：记录最近导出的成片路径，供「发布视频」预填视频文件。
      usePublishStore.getState().setLastExportPath(savePath);
      setExportSuccess({ outputPath: savePath, elapsedMs });
    } catch (error) {
      console.error('导出失败:', error);
      const errMsg = '导出失败，请查看控制台日志后重试。';
      setExportError(errMsg);
      useTaskProgressStore.getState().failTask(exportTaskId, errMsg);
    } finally {
      setIsExporting(false);
    }
  }, [timeline]);

  return (
    <div
      className={styles.root}
      data-editor-region="root"
      style={{
        gridTemplateRows: `auto minmax(0, 1fr) ${RESIZE_HANDLE_THICKNESS}px ${timelinePanelHeight}px`,
      }}
    >
      <div data-editor-region="banners">
        {projectDir && setPage ? (
          <AutoRunLauncher projectDir={projectDir} setPage={setPage} />
        ) : null}
        {projectDir ? (
          <ScriptDriftBanner
            projectDir={projectDir}
            podcastAudioPath={podcastAudioPath}
            podcastSrtPath={podcastSrtPath}
            workflowStep={workflow.step}
            isActive={isActive}
            regenerateDisabled={workflow.step !== 'idle' && workflow.step !== 'error'}
            onRegenerate={() => {
              void handleRegeneratePodcastFromScript();
            }}
          />
        ) : null}
      </div>
      <div
        className={styles.workspace}
        data-editor-region="workspace"
        data-locked={contentLocked ? 'true' : 'false'}
        style={{
          gridTemplateColumns: layout.stackSidebar
            ? 'minmax(0, 1fr)'
            : `${sidebarWidth}px ${RESIZE_HANDLE_THICKNESS}px minmax(0, 1fr) ${RESIZE_HANDLE_THICKNESS}px ${inspectorWidth}px`,
          gridTemplateRows: layout.stackSidebar
            ? `minmax(0, 1fr) ${layout.sidebarRailHeight}px`
            : 'minmax(0, 1fr)',
          gap: layout.stackSidebar ? '1px' : '0',
        }}
      >
        {layout.stackSidebar && inspectorSelection.type !== 'empty' ? (
          <>
            <div className={styles.previewWrap}>
              <PreviewPanel
                playerRef={playerRef}
                isPlaying={isPlaying}
                onTogglePlay={handleTogglePlay}
                onSeek={handleSeek}
                onSeekStart={handleSeekStart}
                onSeekEnd={handleSeekEnd}
                onExport={handleExport}
                currentTimeMs={currentTimeMs}
                durationMs={effectiveDurationMs}
                compact={layout.compactToolbar}
                sourcePreviewAsset={sourcePreviewAsset}
                onCloseSourcePreview={clearSourcePreview}
                selectedOverlayId={
                  inspectorSelection.type === 'overlay' ? inspectorSelection.overlayId : null
                }
                onSelectOverlay={handleSelectOverlayOnCanvas}
                onUpdateOverlayPosition={handleUpdateOverlayPosition}
                onPreviewTimeUpdate={handlePreviewTimeUpdate}
                onPreviewPlay={handlePreviewPlay}
                onPreviewPause={handlePreviewPause}
                onPreviewEnded={handlePreviewEnded}
              />
            </div>
            <div className={styles.inspectorWrap}>
              <EditorInspector
                assetCount={assets.length}
                isProjectMetaLoading={isProjectMetaLoading}
                overlayCount={overlayCount}
                projectDir={projectDir}
                projectMeta={projectMeta}
                selection={inspectorSelection}
                timelineFps={fps}
                timelineWidth={timeline.width}
                timelineHeight={timeline.height}
                onClose={handleCloseInspector}
              />
            </div>
          </>
        ) : (
          <>
            <div
              className={styles.sidebarShell}
              data-editor-region="sidebar-shell"
              data-active-panel={activePanel}
              data-editor-sidebar-style="flat-panel"
              data-editor-sidebar-width="340"
            >
              <Tabs
                value={activePanel}
                onValueChange={(next) => {
                  if (next !== 'assets') {
                    clearSourcePreview();
                  }
                  setActivePanel(next as 'assets' | 'ai');
                }}
                className={styles.sidebarTabs}
              >
                <div className={styles.tabStrip}>
                  <TabsList className={styles.sidebarTabsList} aria-label="侧边栏面板切换">
                    <TabsTrigger
                      value="assets"
                      className={styles.sidebarTabsTrigger}
                      icon={<AppIcon name="folder-open" size={14} />}
                    >
                      素材
                    </TabsTrigger>
                    <TabsTrigger
                      value="ai"
                      className={styles.sidebarTabsTrigger}
                      icon={<AppIcon name="sparkles" size={14} />}
                    >
                      AI 助手
                    </TabsTrigger>
                  </TabsList>
                </div>
                <div className={styles.panelBody}>
                  <TabsContent value="assets" className={styles.sidebarTabsContent}>
                    <AssetPanel
                      compact={layout.stackSidebar}
                      railHeight={layout.sidebarRailHeight}
                      onAddAsset={onAddAsset}
                      onOpenSubtitleInspector={handleOpenSubtitleInspector}
                      onAddTextOverlay={handleAddTextOverlay}
                      onPreviewAsset={handlePreviewAsset}
                      selectedPreviewAssetPath={sourcePreviewAsset?.path ?? null}
                      onUseAsPodcastAudio={onUseAsPodcastAudio}
                      onUseAsPodcastSrt={onUseAsPodcastSrt}
                      onReplaceAudio={handleReplaceAudio}
                      onReplaceSrt={handleReplaceSrt}
                      onRegeneratePodcastFromScript={
                        projectDir
                          ? () => {
                              void handleRegeneratePodcastFromScript();
                            }
                          : undefined
                      }
                      regeneratePodcastFromScriptDisabled={
                        workflow.step !== 'idle' && workflow.step !== 'error'
                      }
                    />
                  </TabsContent>
                  <TabsContent value="ai" className={styles.sidebarTabsContent}>
                    <AIPanel
                      compact={layout.stackSidebar}
                      railHeight={layout.sidebarRailHeight}
                      inspectedCardId={inspectorSelection.type === 'ai-card' ? inspectorSelection.cardId : null}
                      onClearInspector={handleCloseInspector}
                      onOpenCardInspector={handleOpenAICardInspector}
                      onOpenSettings={onOpenSettings}
                    />
                  </TabsContent>
                </div>
              </Tabs>
            </div>
            {!layout.stackSidebar ? (
              <ResizeHandle
                axis="x"
                direction="grow"
                value={sidebarWidth}
                min={SIDEBAR_MIN_WIDTH}
                max={sidebarMaxWidth}
                onChange={setSidebarWidth}
                ariaLabel="调整侧边栏宽度"
                thickness={RESIZE_HANDLE_THICKNESS}
              />
            ) : null}
            <div className={styles.previewWrap}>
              <PreviewPanel
                playerRef={playerRef}
                isPlaying={isPlaying}
                onTogglePlay={handleTogglePlay}
                onSeek={handleSeek}
                onSeekStart={handleSeekStart}
                onSeekEnd={handleSeekEnd}
                onExport={handleExport}
                currentTimeMs={currentTimeMs}
                durationMs={effectiveDurationMs}
                compact={layout.compactToolbar}
                sourcePreviewAsset={sourcePreviewAsset}
                onCloseSourcePreview={clearSourcePreview}
                selectedOverlayId={
                  inspectorSelection.type === 'overlay' ? inspectorSelection.overlayId : null
                }
                onSelectOverlay={handleSelectOverlayOnCanvas}
                onUpdateOverlayPosition={handleUpdateOverlayPosition}
                onPreviewTimeUpdate={handlePreviewTimeUpdate}
                onPreviewPlay={handlePreviewPlay}
                onPreviewPause={handlePreviewPause}
                onPreviewEnded={handlePreviewEnded}
              />
            </div>
            {!layout.stackSidebar ? (
              <>
                <ResizeHandle
                  axis="x"
                  direction="shrink"
                  value={inspectorWidth}
                  min={INSPECTOR_MIN_WIDTH}
                  max={inspectorMaxWidth}
                  onChange={setInspectorWidth}
                  ariaLabel="调整详情面板宽度"
                  thickness={RESIZE_HANDLE_THICKNESS}
                />
                <div className={styles.inspectorWrap}>
                  <EditorInspector
                    assetCount={assets.length}
                    isProjectMetaLoading={isProjectMetaLoading}
                    overlayCount={overlayCount}
                    projectDir={projectDir}
                    projectMeta={projectMeta}
                    selection={inspectorSelection}
                    timelineFps={fps}
                    timelineWidth={timeline.width}
                    timelineHeight={timeline.height}
                    onClose={handleCloseInspector}
                  />
                </div>
              </>
            ) : null}
          </>
        )}
      </div>

      {contentLocked ? (
        <div className={styles.lockNotice} role="status" aria-live="polite">
          <div className={styles.lockTitle}>{lockReasonLabel}</div>
          <div className={styles.lockBody}>
            {aiEditReason ?? 'AI 正在处理当前项目，内容编辑区已锁定。AI 面板仍可查看。'}
          </div>
        </div>
      ) : null}

      <ResizeHandle
        axis="y"
        direction="shrink"
        value={timelinePanelHeight}
        min={panelBounds.minHeight}
        max={panelBounds.maxHeight}
        onChange={setTimelinePanelHeight}
        ariaLabel="调整时间线面板高度"
        thickness={RESIZE_HANDLE_THICKNESS}
      />

      <div
        ref={timelineWrapRef}
        className={styles.timelineWrap}
        data-editor-region="timeline-wrap"
        data-locked={contentLocked ? 'true' : 'false'}
      >
        <Timeline
          currentTimeMs={currentTimeMs}
          isPlaying={isPlaying}
          onSeek={handleSeek}
          onSeekStart={handleTimelineSeekStart}
          onSeekEnd={handleSeekEnd}
          compact={layout.compactTimeline}
          onOpenAICardInspector={handleOpenAICardInspector}
          onOpenSubtitleInspector={handleOpenSubtitleInspector}
          onOpenOverlayInspector={handleOpenOverlayInspector}
        />
      </div>

      <TimelineAIOverlay
        workflow={workflow}
        timelineContainerRef={timelineWrapRef}
        compactTimeline={layout.compactTimeline}
        onCancel={cancelWorkflow}
        onRetry={retryWorkflow}
      />

      <ExportSettingsModal
        visible={isExportSettingsOpen}
        timelineWidth={timeline.width}
        timelineHeight={timeline.height}
        projectName={projectDir ? getFileNameFromPath(projectDir) : undefined}
        projectDir={projectDir || undefined}
        onClose={() => setIsExportSettingsOpen(false)}
        onConfirm={handleConfirmExport}
      />
      <Dialog
        open={regeneratePodcastDialogOpen}
        onOpenChange={(open) => {
          setRegeneratePodcastDialogOpen(open);
          if (!open) {
            setPendingRegenerateScript(null);
          }
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>从文稿重新生成口播</DialogTitle>
            <DialogDescription>
              将读取当前工程的 script.md，使用 MiniMax TTS 重新合成口播音频与字幕，并覆盖现有的口播资源。
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Card>
              <CardContent className="grid gap-2.5">
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  当前音频：{getFileNameFromPath(podcastAudioPath) || '未设置'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  当前字幕：{getFileNameFromPath(podcastSrtPath) || '未设置'}
                </div>
              </CardContent>
            </Card>
            {hasAICardOverlays ? (
              <Alert
                variant="warning"
                className="mt-3"
                description={'注意：时间线上已有 AI 内容卡片。新字幕的时间点可能发生变化，卡片位置可能与音频不再对齐，建议随后在 AI 面板重新运行"内容分析"来刷新卡片。'}
              />
            ) : null}
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
              本次仅重跑 TTS，不会自动运行 AI 分析、封面与排版。
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setRegeneratePodcastDialogOpen(false);
                setPendingRegenerateScript(null);
              }}
            >
              取消
            </Button>
            <Button variant="primary" onClick={handleConfirmRegeneratePodcast}>
              开始生成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(pendingReanalyzeEntries)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingReanalyzeEntries(null);
          }
        }}
        title="替换字幕后重新分析？"
        description="替换字幕后，现有 AI 卡片分析会失效。建议立即重新分析以保持卡片内容准确。"
        confirmText="立即重新分析"
        cancelText="稍后再说"
        onConfirm={() => {
          if (!pendingReanalyzeEntries) {
            return;
          }
          void rerunAiAnalysisForCurrentSrt(pendingReanalyzeEntries);
          setPendingReanalyzeEntries(null);
        }}
      />
      <ConfirmDialog
        open={missingScriptDialogOpen}
        onOpenChange={setMissingScriptDialogOpen}
        title="未找到 script.md"
        description="请先在文稿工作台完成口播稿生成，再启动 AI 一键成片。"
        confirmText="我知道了"
        showCancel={false}
        onConfirm={() => setMissingScriptDialogOpen(false)}
      />
      <ConfirmDialog
        open={Boolean(exportSuccess)}
        onOpenChange={(open) => {
          if (!open) {
            setExportSuccess(null);
          }
        }}
        title="导出完成"
        description={
          exportSuccess
            ? `视频已导出到 ${getFileNameFromPath(exportSuccess.outputPath)}，总耗时 ${formatExportDuration(exportSuccess.elapsedMs)}。`
            : undefined
        }
        confirmText="在 Finder 中显示"
        cancelText="完成"
        onConfirm={() => {
          if (exportSuccess) {
            void window.electronAPI.showItemInFolder(exportSuccess.outputPath);
          }
          setExportSuccess(null);
        }}
        onCancel={() => setExportSuccess(null)}
      />
    </div>
  );
}

/**
 * 把导出耗时（毫秒）格式化为「X 分 Y 秒」/「Y.S 秒」，用于导出成功弹窗展示效率。
 */
function formatExportDuration(elapsedMs: number): string {
  const safeMs = Math.max(0, elapsedMs);
  const totalSeconds = safeMs / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (seconds === 0) {
    return `${minutes} 分`;
  }
  return `${minutes} 分 ${seconds} 秒`;
}

function mapProjectMetadata(metadata: ProjectMetadata): ProjectOverviewMeta {
  return {
    projectName: getFileNameFromPath(metadata.projectDir),
    projectPath: metadata.projectDir,
    createdAt: metadata.createdAtMs,
    sizeBytes: metadata.sizeBytes,
  };
}
