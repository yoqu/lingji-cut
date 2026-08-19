import { AnimatePresence, LayoutGroup, m, useIsPresent } from 'framer-motion';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ConfirmDialog, useToast } from './ui';
import { AgentSidebar } from './components/agent/AgentSidebar';
import { AppStatusBar } from './components/AppStatusBar';
import { AgentOpOverlay } from './components/agent/AgentOpOverlay';
import { Toolbar } from './components/Toolbar';
import type { AppPage, MenuAction, MenuEvent, RecentProjectEntry } from './lib/electron-api';
import { getAISettingsIssue } from './lib/ai-settings';
import { useAgentStore } from './store/agent';
import { hydrateSettingsStorage } from './lib/settings-storage';
import { useViewportSize } from './hooks/useViewportSize';
import { getAppShortcutCommand, isTextEditingTarget } from './lib/native-shortcuts';
import {
  resolvePageTransition,
  type PageTransitionConfig,
  type PageTransitionReason,
} from './lib/page-transition';
import { resolveProjectLandingPage } from './lib/project-navigation';
import { createBlankScriptProjectState } from './lib/script-project';
import { Editor } from './pages/Editor';
import { AssetCenter } from './pages/AssetCenter';
import { DirectorWorkbench } from './pages/DirectorWorkbench';
import { ScriptWorkbench } from './pages/ScriptWorkbench';
import { Settings, type SettingsTab } from './pages/Settings';
import { Setup } from './pages/Setup';
import { PublishHub } from './pages/PublishHub';
import { AutoRunController } from './components/AutoRunController';
import { ImportProjectDialog } from './components/ImportProjectDialog';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import type { ImportProjectResult } from './lib/project-import-types';
import type { VideoImportSourceInput } from './lib/video-import-types';
import type { ImportWechatArticleSource } from './components/script/ImportScriptDialog';
import { materializeWechatArticleWithProgress } from './lib/wechat-import';
import { prefersReducedMotion } from './ui/lib/animation-config';
import { WorkspaceTabs } from './components/WorkspaceTabs';
import { PublishWorkbench } from './components/publish/PublishWorkbench';
import { getFileNameFromPath, readAudioDurationMs } from './lib/utils';
import { createDefaultTimeline } from './types';
import type { AICard } from './types/ai';
import { buildAICardTimelineDraft } from './types/ai';
import { getCurrentAISaveStatus, loadAISettings, subscribeToAISaveStatus, useAIStore, type AutoWorkflowParams } from './store/ai';
import type { ProjectData } from './lib/project-persistence';
import { handleExternalEdit } from './lib/external-edit-sync';
import { useAiEditStore } from './store/ai-edit';
import { useScriptStore } from './store/script';
import { useTaskProgressStore } from './store/task-progress';
import { useAgentFeedStore } from './store/agent-feed';
import { useProjectTreeSync } from './hooks/use-project-tree-sync';
import {
  createPipelineProgressBridge,
  type PipelineTaskSnapshot,
} from './lib/pipeline-progress-bridge';
import { requestDirectorPlan } from './lib/director-plan-client';
import { attachTaskNotificationBridge } from './lib/task-notification-bridge';
import { registerMcpReadonlyHandlers } from './lib/mcp-readonly-handlers';
import { userPromptBindingKey } from './lib/prompts';
import {
  clearCurrentProject,
  getCurrentProjectDir,
  getCurrentSaveStatus,
  mergeSaveStatus,
  setProjectDir,
  subscribeToSaveStatus,
  useTimelineStore,
} from './store/timeline';

const APP_FONT_STACK =
  '"SF Pro Text", "SF Pro Display", "PingFang SC", -apple-system, BlinkMacSystemFont, sans-serif';
const APP_LOADING_BACKGROUND = 'var(--color-window-bg)';
const APP_WINDOW_BACKGROUND = 'var(--color-window-bg)';

function PageTransitionFrame({
  children,
  pageTransition,
}: {
  children: ReactNode;
  pageTransition: PageTransitionConfig;
}) {
  const isPresent = useIsPresent();

  return (
    <m.div
      key={pageTransition.contentKey}
      initial={pageTransition.initial}
      animate={pageTransition.animate}
      exit={pageTransition.exit}
      transition={pageTransition.transition}
      style={{
        position: 'absolute',
        inset: 0,
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        pointerEvents: isPresent ? 'auto' : 'none',
        zIndex: isPresent ? 1 : 0,
      }}
    >
      {children}
    </m.div>
  );
}

export default function App() {
  const viewport = useViewportSize();
  const [page, setPageRaw] = useState<AppPage>('welcome');
  const [previousPage, setPreviousPage] = useState<AppPage>('welcome');
  const [pageTransitionReason, setPageTransitionReason] = useState<PageTransitionReason>('default');
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>(undefined);
  const [assetCenterFocusId, setAssetCenterFocusId] = useState<string | null>(null);

  const setPage = useCallback(
    (next: AppPage, reason: PageTransitionReason = 'default') => {
      setPageRaw((current) => {
        // 目标与当前页相同时不改动过渡状态：否则 contentKey 会从
        // `crossfade:X->script-workbench` 变成退化的 `crossfade:script-workbench->script-workbench`，
        // AnimatePresence mode="wait" 会对同一页面做「退出再进入」并卡住成空白。
        // 典型触发：项目已停在写稿页时，openProject 切到另一个项目仍会 setPage('script-workbench')。
        if (next === current) return current;
        setPreviousPage(current);
        setPageTransitionReason(reason);
        return next;
      });
    },
    [],
  );
  const [isHydrating, setIsHydrating] = useState(() => Boolean(getCurrentProjectDir()));
  const [setupError, setSetupError] = useState<string | null>(null);
  const [currentProjectDir, setCurrentProjectDir] = useState(() => getCurrentProjectDir());
  const [recentProjects, setRecentProjects] = useState<RecentProjectEntry[]>([]);
  const [saveStatus, setSaveStatus] = useState(() => getCurrentSaveStatus());
  const [aiSaveStatus, setAISaveStatus] = useState(() => getCurrentAISaveStatus());
  const aggregatedSaveStatus = mergeSaveStatus(saveStatus, aiSaveStatus);
  const [exportRequestToken, setExportRequestToken] = useState(0);
  const [pendingSubtitleReanalysis, setPendingSubtitleReanalysis] = useState<
    ReturnType<typeof useTimelineStore.getState>['srtEntries'] | null
  >(null);
  const {
    addAsset,
    canRedo,
    canUndo,
    redo,
    setPodcast,
    setSrtEntries,
    setTimeline,
    timeline,
    undo,
  } = useTimelineStore();
  const clearAIAnalysis = useAIStore((state) => state.clearAnalysis);
  const setAIAnalysisResult = useAIStore((state) => state.setAnalysisResult);
  const { showToast } = useToast();
  const setCoverCandidates = useAIStore((state) => state.setCoverCandidates);

  const loadUserPrompts = useAIStore((state) => state.loadUserPrompts);

  useEffect(() => {
    void hydrateSettingsStorage();
    // 启动即加载口播模板分类，MCP / 写稿 / 抽屉都依赖这份缓存
    void loadUserPrompts('script-template');
  }, [loadUserPrompts]);

  // 耗时任务完成 / 失败时弹系统通知，提醒用户回到软件继续下一步
  useEffect(() => attachTaskNotificationBridge(), []);

  // MCP 只读型 handler 全局注册一次（实现见 lib/mcp-readonly-handlers.ts）
  useEffect(() => registerMcpReadonlyHandlers(), []);

  // aiAnalysis 落盘统一走 store/ai.ts 的订阅自动保存，这里只改内存态。
  const rerunAiAnalysisForEntries = useCallback(
    async (entries: ReturnType<typeof useTimelineStore.getState>['srtEntries']) => {
      const settings = await loadAISettings();
      const settingsIssue = getAISettingsIssue(settings);

      if (settingsIssue || !settings) {
        showToast(settingsIssue ?? '请先完成 AI 配置后再重新分析', {
          title: '无法重新分析字幕',
          type: 'error',
          duration: 5000,
        });
        return;
      }

      if (!currentProjectDir) return;
      const taskId = `director-replan-subtitles-${Date.now()}`;
      useTaskProgressStore.getState().startTask({
        id: taskId,
        category: 'ai-analyze',
        label: '根据新字幕重拟导演方案',
        mode: 'determinate',
        progress: 0,
        phase: '保留当前成片并分析影响',
        level: 2,
        canCancel: false,
      });

      try {
        await requestDirectorPlan({
          entries,
          settings,
          projectDir: currentProjectDir,
          taskId,
          onProgress: (progress, phase) => {
            useTaskProgressStore.getState().updateTask(taskId, { progress, phase });
          },
        });
        useTaskProgressStore.getState().completeTask(taskId);
        showToast('新导演方案已生成，原有成片会保留到新版本批准并生成成功。', {
          title: '请在导演台确认影响',
          type: 'success',
        });
        setPage('director-workbench');
      } catch (error) {
        console.error('重新制定导演方案失败:', error);
        const message = error instanceof Error ? error.message : '重新制定导演方案失败，请稍后重试。';
        useTaskProgressStore.getState().failTask(taskId, message);
        showToast(message, {
          title: '重新分析字幕失败',
          type: 'error',
          duration: 5000,
        });
      }
    },
    [currentProjectDir, setPage, showToast],
  );

  const resolveAudioDuration = useCallback(
    async (audioPath: string, fallbackDurationMs: number) => {
      try {
        const durationMs = await window.electronAPI.getAudioDuration(audioPath);
        return durationMs > 0 ? durationMs : fallbackDurationMs;
      } catch (error) {
        console.warn('读取音频时长失败，使用兜底时长:', error);
        return fallbackDurationMs;
      }
    },
    [],
  );

  const replaceSubtitleWithConfirmation = useCallback(
    async (srtPath: string) => {
      const { entries, durationMs } = await window.electronAPI.parseSrtFile(srtPath);
      setSrtEntries(entries);
      setPodcast(timeline.podcast.audioPath, srtPath, durationMs);

      setPendingSubtitleReanalysis(entries);
    },
    [setPodcast, setSrtEntries, timeline.podcast.audioPath],
  );

  const syncWorkspaceState = useCallback(async () => {
    setCurrentProjectDir(getCurrentProjectDir());
    const projects = await window.electronAPI.loadRecentProjects();
    setRecentProjects(projects);
  }, []);

  const resetToSetup = useCallback((reason: PageTransitionReason = 'default') => {
    // 先清掉当前项目目录，避免后续 setTimeline(createDefaultTimeline()) 触发的
    // 自动保存订阅拿到陈旧 projectDir，把空 timeline 写入前一个项目的 project.json。
    clearCurrentProject();
    setTimeline(createDefaultTimeline());
    setSrtEntries([]);
    clearAIAnalysis();
    useScriptStore.getState().clearProjectSession();
    setPage('welcome', reason);
  }, [clearAIAnalysis, setSrtEntries, setTimeline]);

  const openProject = useCallback(
    async (projectDir: string) => {
      try {
        const raw = await window.electronAPI.loadProject(projectDir);
        const projectData = JSON.parse(raw) as ProjectData;

        // 先切换到新的项目目录，保证下面 setTimeline / setSrtEntries 触发的
        // 自动保存订阅把数据写入新项目的 project.json，
        // 而不是之前打开过的旧项目目录（会造成旧项目被空数据覆盖）。
        setProjectDir(projectDir);

        // timeline 段
        if (projectData.timeline) {
          setTimeline(projectData.timeline);
        } else {
          setTimeline(createDefaultTimeline());
        }

        // SRT 解析（从 timeline.podcast.srtPath）
        if (projectData.timeline?.podcast?.srtPath) {
          try {
            const { entries } = await window.electronAPI.parseSrtFile(
              projectData.timeline.podcast.srtPath,
            );
            setSrtEntries(entries);
          } catch (err) {
            const isNotFound = String(err).includes('ENOENT');
            if (isNotFound) {
              // 文件被外部删除——清除配置引用并继续，不中断恢复流程
              if (projectData.timeline) {
                projectData.timeline.podcast = {
                  ...projectData.timeline.podcast,
                  srtPath: '',
                  audioPath: '',
                };
                await window.electronAPI.saveProjectSection(
                  projectDir,
                  'timeline',
                  JSON.stringify(projectData.timeline),
                );
              }
              setSrtEntries([]);
              showToast('字幕文件已被删除，已从工程配置中移除', {
                type: 'warning',
                duration: 5000,
              });
            } else {
              throw err;
            }
          }
        } else {
          setSrtEntries([]);
        }

        // AI 分析段
        if (projectData.aiAnalysis?.analysisResult) {
          setAIAnalysisResult(projectData.aiAnalysis.analysisResult);
          setCoverCandidates(projectData.aiAnalysis.coverCandidates ?? []);
        } else {
          clearAIAnalysis();
          setCoverCandidates(projectData.aiAnalysis?.coverCandidates ?? []);
        }

        // 项目级默认风格预设：旧工程缺该字段时为 undefined（继承全局默认）。
        useAIStore
          .getState()
          .loadProjectStylePresetId(projectData.stylePresetId ?? undefined);

        // 添加到最近项目列表（projectDir 已在前面设置过，不需要重复设置）
        await window.electronAPI.addRecentProject(projectDir);
        void syncWorkspaceState();
        setSetupError(null);
        setPage(resolveProjectLandingPage(projectData));
      } catch (error) {
        console.error('恢复工程失败:', error);
        await window.electronAPI.removeRecentProject(projectDir);
        if (getCurrentProjectDir() === projectDir) {
          clearCurrentProject();
        }
        void syncWorkspaceState();
        resetToSetup();
        setSetupError('恢复工程失败，请重新打开工程或重新导入 MP3 和 SRT。');
      }
    },
    [
      clearAIAnalysis,
      resetToSetup,
      setAIAnalysisResult,
      setCoverCandidates,
      setSrtEntries,
      setTimeline,
      showToast,
      syncWorkspaceState,
    ],
  );

  // headless 任务写回 project.json 后，若该项目正在打开，则刷新对应节
  const reloadProjectSections = useCallback(
    async (projectDir: string, sections: string[]) => {
      try {
        const raw = await window.electronAPI.loadProject(projectDir);
        const projectData = JSON.parse(raw) as ProjectData;
        if (sections.includes('timeline')) {
          if (projectData.timeline) setTimeline(projectData.timeline);
          const srtPath = projectData.timeline?.podcast?.srtPath;
          if (srtPath) {
            try {
              const { entries } = await window.electronAPI.parseSrtFile(srtPath);
              setSrtEntries(entries);
            } catch {
              setSrtEntries([]);
            }
          }
        }
        if (sections.includes('aiAnalysis')) {
          if (projectData.aiAnalysis?.analysisResult) {
            setAIAnalysisResult(projectData.aiAnalysis.analysisResult);
            setCoverCandidates(projectData.aiAnalysis.coverCandidates ?? []);
            // 卡片被外部工具（MCP/CLI regenerate/convert/update）改写后只更新了 aiAnalysis，
            // 这里把更新后的卡片重新灌回已放置的 timeline overlay，使预览实时反映最新
            // motionCard.tsx / 时间 / 展示模式，无需重开项目。只刷新已放置的卡片，绝不自动放置新卡。
            const timelineStore = useTimelineStore.getState();
            const placedSourceIds = new Set(
              timelineStore.timeline.overlays
                .filter((o) => o.overlayType === 'ai-card' && o.aiCardData?.sourceCardId)
                .map((o) => o.aiCardData!.sourceCardId as string),
            );
            const drafts = projectData.aiAnalysis.analysisResult.cards
              .filter((card) => placedSourceIds.has(card.id))
              .map((card) => buildAICardTimelineDraft(card, projectData.aiAnalysis?.analysisResult?.motionBible));
            if (drafts.length > 0) timelineStore.addAICardsToTimeline(drafts);
          } else {
            clearAIAnalysis();
            setCoverCandidates(projectData.aiAnalysis?.coverCandidates ?? []);
          }
        }
      } catch (err) {
        console.error('[project-updated] 刷新失败:', err);
      }
    },
    [setTimeline, setSrtEntries, setAIAnalysisResult, setCoverCandidates, clearAIAnalysis],
  );

  useEffect(() => {
    if (!window.electronAPI?.onProjectUpdated) return;
    const unsubscribe = window.electronAPI.onProjectUpdated((payload) => {
      if (payload.projectPath === getCurrentProjectDir()) {
        void reloadProjectSections(payload.projectPath, payload.sections);
      }
    });
    return unsubscribe;
  }, [reloadProjectSections]);

  // MCP/pipeline 任务（含内置 pi 触发的导出/TTS/分析/封面/卡片/Motion）进度联动：
  // 主进程 attachTaskProgressBridge 把任务发到 `pipeline:task-update`，这里映射进
  // 底部统一进度系统。视频导入走另一条 `video-import-progress` 通道，已有各自的桥。
  useEffect(() => {
    if (!window.electronAPI?.onPipelineTaskUpdate) return;
    const bridge = createPipelineProgressBridge({
      subscribe: (cb) =>
        window.electronAPI!.onPipelineTaskUpdate((task) =>
          cb(task as unknown as PipelineTaskSnapshot),
        ),
      startTask: (input) => useTaskProgressStore.getState().startTask(input),
      updateTask: (id, patch) => useTaskProgressStore.getState().updateTask(id, patch),
      completeTask: (id) => useTaskProgressStore.getState().completeTask(id),
      failTask: (id, error) => useTaskProgressStore.getState().failTask(id, error),
      cancelTask: (id, reason) => useTaskProgressStore.getState().cancelTask(id, reason),
      hasTask: (id) => useTaskProgressStore.getState().tasks.has(id),
      cancel: (taskId) => {
        void window.electronAPI!.cancelPipelineTask?.(taskId);
      },
    });
    return () => bridge.dispose();
  }, []);

  // AI 卡片多 agent 生成的观测事件 → agent-feed store（观测面板数据源）。
  useEffect(() => {
    if (!window.electronAPI?.onAgentFeedEvent) return;
    return window.electronAPI.onAgentFeedEvent((ev) =>
      useAgentFeedStore.getState().applyEvent(ev),
    );
  }, []);

  // 换项目时清空观测记录（记录只在项目会话内有意义）。
  useEffect(() => {
    useAgentFeedStore.getState().clearAll();
  }, [currentProjectDir]);

  // 项目目录树共享数据层：统一加载 fileEntries + 监听 file-tree-changed 刷新。
  // 各 tab（写稿 / 编辑器 / 资产 / 发布）只读 useProjectTreeStore，不再各自加载。
  useProjectTreeSync();

  // AI file-first：订阅外部文件变更（file-changed）与会话锁态（ai-edit-lock-changed）。
  // - project.json 变更 → 重载并替换 timeline
  // - motionCard.tsx 变更 → 替换该卡内存源码触发预览重编译
  // - script.md / original.md → 留钩子给后续脚本灌回（Task 12）
  // - 锁态 → 更新 useAiEditStore（锁定期间 timeline 自动保存会暂停，避免覆盖外部改动）
  // 注意：ScriptWorkbench 另有一个独立的 onFileChanged 订阅（脚本工作台冲突检测），
  // preload 用 ipcRenderer.on 注册，多处订阅互不覆盖，各自返回独立 cleanup。
  useEffect(() => {
    if (!currentProjectDir) return;
    // 项目打开期间常驻文件监听：file-first 编辑 motionCard.tsx / project.json / script.md
    // 都要实时灌回。watcher 由 App 统一管理，不再依赖 ScriptWorkbench 挂载——否则停留在
    // 编辑器页时监听器关闭，AI 改 Motion Card 不刷新，必须重开项目才生效。
    void window.electronAPI?.startWatching?.(currentProjectDir);
    const offEdit = window.electronAPI?.onFileChanged?.((data) => {
      void handleExternalEdit(data, {
        loadProject: async (dir) => {
          const raw = await window.electronAPI.loadProject(dir);
          const project = JSON.parse(raw) as ProjectData;
          return { timeline: project.timeline ?? null };
        },
        projectDir: currentProjectDir,
        applyCardSource: (id, tsx) =>
          useTimelineStore.getState().applyExternalCardSource(id, tsx),
        onScriptChanged: (kind, content) =>
          useScriptStore.getState().applyExternalScriptFile(kind, content),
      });
    });
    const offLock = window.electronAPI?.onAiEditLockChanged?.((change) => {
      useAiEditStore.getState().setLock(change);
    });
    return () => {
      offEdit?.();
      offLock?.();
      void window.electronAPI?.stopWatching?.();
    };
  }, [currentProjectDir]);

  useEffect(() => {
    void syncWorkspaceState();
  }, [syncWorkspaceState]);

  useEffect(() => {
    const hydrate = async () => {
      const projectDir = getCurrentProjectDir();
      if (!projectDir) {
        setIsHydrating(false);
        return;
      }

      await openProject(projectDir);
      setIsHydrating(false);
    };

    void hydrate();
  }, [openProject]);

  useEffect(() => subscribeToSaveStatus(setSaveStatus), []);
  useEffect(() => subscribeToAISaveStatus(setAISaveStatus), []);
  const aiEditLocked = useAiEditStore((s) => s.locked);

  useEffect(() => {
    void window.electronAPI.setMenuContext({
      activePage: page,
      hasProject: Boolean(currentProjectDir),
      recentProjects: recentProjects.map((project) => ({
        path: project.path,
        name: project.name,
      })),
      // 一键成稿运行中：菜单项需要按禁用态渲染，避免误触
      isAutoRunning: page === 'auto-run',
      isAiEditing: aiEditLocked,
    });
  }, [aiEditLocked, currentProjectDir, page, recentProjects]);

  const handleNewProject = useCallback(async () => {
    const projectDir = await window.electronAPI.selectProjectDirectory();
    if (!projectDir) {
      return;
    }

    // 先切到新项目目录，再重置 timeline / srt / AI；否则 setTimeline 触发的
    // 自动保存订阅会把空白 timeline 写入之前打开的项目，造成旧项目内容丢失。
    setProjectDir(projectDir);
    setTimeline(createDefaultTimeline());
    setSrtEntries([]);
    clearAIAnalysis();
    // 添加到最近项目列表
    await window.electronAPI.addRecentProject(projectDir);
    void syncWorkspaceState();
    setSetupError(null);
    setPage(resolveProjectLandingPage());
  }, [clearAIAnalysis, setSrtEntries, setTimeline, syncWorkspaceState]);

  const handleOpenProject = useCallback(async () => {
    const projectDir = await window.electronAPI.selectProjectDirectory();
    if (!projectDir) {
      return;
    }

    await openProject(projectDir);
  }, [openProject]);

  // ── 导入项目（跨机器项目目录识别与路径修复）──
  const [importProjectDialogOpen, setImportProjectDialogOpen] = useState(false);

  const handleOpenImportProject = useCallback(() => {
    setImportProjectDialogOpen(true);
  }, []);

  const handleImportProjectComplete = useCallback(
    async (result: ImportProjectResult) => {
      await window.electronAPI.addRecentProject(result.projectDir, result.projectName);
      setImportProjectDialogOpen(false);
      await openProject(result.projectDir);
    },
    [openProject],
  );

  const handleOpenSettings = useCallback(() => {
    setSettingsInitialTab(undefined);
    setPage('settings');
  }, [setPage]);

  const handleOpenAgentSettings = useCallback(() => {
    setSettingsInitialTab('agent');
    setPage('settings');
  }, [setPage]);

  /** 状态栏连接弹窗的修复入口：定位到对应设置 tab。 */
  const handleOpenSettingsTab = useCallback(
    (tab: SettingsTab) => {
      setSettingsInitialTab(tab);
      setPage('settings');
    },
    [setPage],
  );

  /**
   * 导入类入口（文稿 / 媒体）共用的空白工程引导：
   * 先清旧项目会话（避免自动保存订阅拿陈旧 projectDir 写脏旧工程），
   * 建空白脚本态 → 重置时间线 / 字幕 / AI → 切到新目录 → 记入最近项目。
   */
  const bootstrapImportedProject = useCallback(
    async (projectDir: string) => {
      clearCurrentProject();
      useScriptStore.getState().clearProjectSession();
      useScriptStore.getState().restoreState(createBlankScriptProjectState(projectDir));
      setTimeline(createDefaultTimeline());
      setSrtEntries([]);
      clearAIAnalysis();
      setProjectDir(projectDir);
      await window.electronAPI.addRecentProject(projectDir);
      void syncWorkspaceState();
      setSetupError(null);
    },
    [clearAIAnalysis, setSrtEntries, setTimeline, syncWorkspaceState],
  );

  /** auto-run：把导入弹窗选择的写稿模型写入项目绑定，供起跑时 generateScriptDraft 解析。 */
  const applyAutoRunModelBinding = useCallback(
    async (
      projectDir: string,
      autoParams: AutoWorkflowParams,
      modelBinding: { providerId: string; model: string } | null,
    ) => {
      if (!modelBinding) return;
      await useAIStore.getState().loadProjectBindings(projectDir);
      await useAIStore.getState().setProjectBinding(
        userPromptBindingKey('script-template', autoParams.templateId),
        {
          providerId: modelBinding.providerId,
          model: modelBinding.model,
          imageProviderId: null,
          imageModel: null,
        },
      );
    },
    [],
  );

  /**
   * 导入文稿回调：在指定父目录下创建以项目名命名的文件夹，
   * 初始化空白脚本项目状态，将原稿暂存到 store，
   * 导航到脚本工作台后自动写入 original.md 并触发 AI 写稿。
   */
  const handleImportScript = useCallback(
    async (
      parentDir: string,
      projectName: string,
      content: string,
      autoMode: boolean,
      autoParams: AutoWorkflowParams,
      modelBinding: { providerId: string; model: string } | null,
      wechatArticle: ImportWechatArticleSource | null = null,
    ) => {
      const trimmedName = projectName.trim();
      if (!parentDir || !trimmedName) {
        throw new Error('父目录和项目名不能为空');
      }
      const projectDir = `${parentDir}/${trimmedName}`;

      await bootstrapImportedProject(projectDir);

      // 公众号来源：先把正文中的远程图片下载到项目目录并改写为相对路径
      if (wechatArticle) {
        content = await materializeWechatArticleWithProgress({
          projectDir,
          articleId: wechatArticle.articleId,
          meta: wechatArticle.meta,
          markdown: content,
        });
      }

      // 暂存原稿，进入工作台后由 useEffect 落盘并起飞 AI 写稿
      useScriptStore.getState().setPendingImportedScript({ content });

      if (autoMode) {
        // 先把原稿落盘——失败时直接抛出，pendingAutoParams 不会被污染
        await window.electronAPI.saveScriptFile(projectDir, 'original.md', content);
        await applyAutoRunModelBinding(projectDir, autoParams, modelBinding);
        useAIStore.getState().setPendingAutoParams(autoParams);
        // 同时清掉 pending，否则进 ScriptWorkbench 时会被原写稿流程消费
        useScriptStore.getState().setPendingImportedScript(null);
        setPage('auto-run');
        return;
      }

      setPage('script-workbench');
    },
    [applyAutoRunModelBinding, bootstrapImportedProject, setPage],
  );

  /**
   * 媒体导入回调：在指定父目录下创建以标题命名的项目文件夹，
   * 初始化空白脚本项目状态，保存待导入源（抖音链接 / 本地视频 / 本地音频）到 store，
   * 导航到脚本工作台后自动触发导入 + 转录流程。
   */
  const handleMediaImport = useCallback(async (
    parentDir: string,
    title: string,
    source: VideoImportSourceInput,
    autoMode: boolean,
    autoParams: AutoWorkflowParams,
    modelBinding: { providerId: string; model: string } | null,
  ) => {
    const projectDir = `${parentDir}/${title}`;

    await bootstrapImportedProject(projectDir);
    // 设置待处理导入源，进入工作台后自动触发导入
    useScriptStore.getState().setPendingMediaImport(source);

    if (autoMode) {
      await applyAutoRunModelBinding(projectDir, autoParams, modelBinding);
      useAIStore.getState().setPendingAutoParams(autoParams);
      // 注意：pendingMediaImport 不在这里清理，由 AutoRunController（Task 10/11）
      // 在导入启动后自行清掉，避免 ScriptWorkbench 后续误消费
      setPage('auto-run');
      return;
    }
    setPage('script-workbench');
  }, [applyAutoRunModelBinding, bootstrapImportedProject, setPage]);

  const handleCloseProject = useCallback(() => {
    clearCurrentProject();
    void syncWorkspaceState();
    resetToSetup('close-project');
    setSetupError(null);
  }, [resetToSetup, syncWorkspaceState]);

  const handleRemoveRecentProject = useCallback(
    async (projectDir: string) => {
      await window.electronAPI.removeRecentProject(projectDir);
      await syncWorkspaceState();
    },
    [syncWorkspaceState],
  );

  const handleAddAsset = useCallback(async () => {
    const asset = await window.electronAPI.addAsset();
    if (!asset) {
      return;
    }

    let durationMs = asset.durationMs;
    if (asset.type === 'audio') {
      try {
        const decoded = await readAudioDurationMs(asset.path);
        if (decoded > 0) {
          durationMs = decoded;
        }
      } catch (error) {
        console.warn('读取导入音频时长失败，使用主进程回退值:', error);
      }
    }

    addAsset(asset.path, asset.type, durationMs);
  }, [addAsset]);

  const handleReplaceAudio = useCallback(async () => {
    const audioPath = await window.electronAPI.selectMediaFile('audio');
    if (!audioPath) {
      return;
    }

    const durationMs = await resolveAudioDuration(audioPath, timeline.podcast.durationMs);
    setPodcast(audioPath, timeline.podcast.srtPath, durationMs);
  }, [resolveAudioDuration, setPodcast, timeline.podcast.durationMs, timeline.podcast.srtPath]);

  const handleReplaceSrt = useCallback(async () => {
    const srtPath = await window.electronAPI.selectMediaFile('srt');
    if (!srtPath) {
      return;
    }

    await replaceSubtitleWithConfirmation(srtPath);
  }, [replaceSubtitleWithConfirmation]);

  const handleUseAssetAsPodcastAudio = useCallback(
    async (audioPath: string, durationMs: number) => {
      const resolvedDuration = await resolveAudioDuration(
        audioPath,
        durationMs > 0 ? durationMs : timeline.podcast.durationMs,
      );
      setPodcast(audioPath, timeline.podcast.srtPath, resolvedDuration);
    },
    [resolveAudioDuration, setPodcast, timeline.podcast.durationMs, timeline.podcast.srtPath],
  );

  const handleUseAssetAsPodcastSrt = useCallback(
    async (srtPath: string) => {
      await replaceSubtitleWithConfirmation(srtPath);
    },
    [replaceSubtitleWithConfirmation],
  );

  const handleCommand = useCallback(
    async (command: MenuAction) => {
      switch (command) {
        case 'new-project':
          await handleNewProject();
          return;
        case 'open-project':
          await handleOpenProject();
          return;
        case 'open-settings':
          handleOpenSettings();
          return;
        case 'close-project':
          if (currentProjectDir) {
            handleCloseProject();
          }
          return;
        case 'show-project-in-folder':
          if (currentProjectDir) {
            window.electronAPI.showItemInFolder(currentProjectDir);
          }
          return;
        case 'undo':
          if (page === 'editor' && canUndo) {
            undo();
          }
          return;
        case 'redo':
          if (page === 'editor' && canRedo) {
            redo();
          }
          return;
        case 'replace-audio':
          if (page === 'editor') {
            await handleReplaceAudio();
          }
          return;
        case 'replace-srt':
          if (page === 'editor') {
            await handleReplaceSrt();
          }
          return;
        case 'add-asset':
          if (page === 'editor') {
            await handleAddAsset();
          }
          return;
        case 'export':
          if (page === 'editor') {
            setExportRequestToken((current) => current + 1);
          }
          return;
        case 'save-script': {
          const saveCb = useScriptStore.getState().workbenchCallbacks.save;
          if (page === 'script-workbench' && saveCb) {
            saveCb();
          }
          return;
        }
        case 'go-back':
          if (page === 'script-workbench') {
            setPage('welcome');
          }
          return;
        case 'find': {
          const findCb = useScriptStore.getState().workbenchCallbacks.find;
          if (page === 'script-workbench' && findCb) findCb();
          return;
        }
        case 'find-replace': {
          const findReplaceCb = useScriptStore.getState().workbenchCallbacks.findReplace;
          if (page === 'script-workbench' && findReplaceCb) findReplaceCb();
          return;
        }
      }
    },
    [
      canRedo,
      canUndo,
      currentProjectDir,
      handleAddAsset,
      handleCloseProject,
      handleNewProject,
      handleOpenProject,
      handleOpenSettings,
      handleReplaceAudio,
      handleReplaceSrt,
      page,
      redo,
      undo,
    ],
  );

  const handleMenuEvent = useCallback(
    async (event: MenuEvent) => {
      if (event.type === 'open-recent-project') {
        await openProject(event.projectDir);
        return;
      }

      await handleCommand(event.action);
    },
    [handleCommand, openProject],
  );

  useEffect(() => {
    const unsubscribe = window.electronAPI.onMenuAction((event) => {
      void handleMenuEvent(event);
    });

    return unsubscribe;
  }, [handleMenuEvent]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 一键成稿运行中：屏蔽全部全局快捷键，避免触发撤销 / 重做 /
      // 关闭项目 / 切换 Agent 侧栏等可能干扰自动流程的操作
      if (page === 'auto-run') {
        return;
      }

      // Cmd+Shift+A 切换 Agent 侧边栏
      if (event.metaKey && event.shiftKey && event.key === 'a') {
        event.preventDefault();
        useAgentStore.getState().toggleSidebar();
        return;
      }

      if (isTextEditingTarget(event.target)) {
        return;
      }

      const scopedCommand = getAppShortcutCommand({
        hasProject: Boolean(currentProjectDir),
        ...event,
      });
      if (!scopedCommand) {
        return;
      }

      event.preventDefault();
      void handleCommand(scopedCommand);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentProjectDir, handleCommand, page]);

  // ── 双向同步：ScriptWorkbench ↔ Editor 共享工作目录 ──

  // 方向 A：script store 选定新目录 → 更新 timeline store + App 状态
  useEffect(() => {
    const unsub = useScriptStore.subscribe((state, prev) => {
      if (state.projectDir && state.projectDir !== prev.projectDir) {
        if (state.projectDir !== getCurrentProjectDir()) {
          setProjectDir(state.projectDir);
          void syncWorkspaceState();
        }
      }
    });
    return unsub;
  }, [syncWorkspaceState]);

  // 方向 B：timeline store / App 打开新项目 → 同步到 script store
  useEffect(() => {
    if (!currentProjectDir) return;
    const scriptDir = useScriptStore.getState().projectDir;
    if (scriptDir !== currentProjectDir) {
      useScriptStore.getState().setProjectDir(currentProjectDir);
    }
  }, [currentProjectDir]);

  // 同步当前项目目录到 AIStore，并加载项目级提示词绑定。
  // 否则 ModelSelector / setProjectBinding 等会因 AIStore.currentProjectDir 为 null
  // 而静默忽略写入，导致写稿模型切换无效。
  useEffect(() => {
    const aiProjectDir = useAIStore.getState().currentProjectDir;
    if (aiProjectDir === (currentProjectDir ?? null)) return;
    void useAIStore.getState().loadProjectBindings(currentProjectDir ?? null);
  }, [currentProjectDir]);

  const handleWorkspaceTabSwitch = useCallback(
    (tab: 'script-workbench' | 'director-workbench' | 'editor' | 'asset-center' | 'publish') => {
      if (tab === page) return;
      setPage(tab);
    },
    [page, setPage],
  );

  const showWorkspaceTabs =
    page === 'editor' ||
    page === 'director-workbench' ||
    page === 'script-workbench' ||
    page === 'asset-center' ||
    page === 'publish';
  const reducedMotion = prefersReducedMotion();
  const pageTransition = resolvePageTransition({
    fromPage: previousPage,
    toPage: page,
    reason: pageTransitionReason,
    reducedMotion,
  });

  const agentSidebarOpen = useAgentStore((s) => s.sidebarOpen);
  const projectName = currentProjectDir ? getFileNameFromPath(currentProjectDir) : '';

  // 写稿进度：null=无稿件（隐藏圆环），50=已生成未审，100=审稿完成
  const scriptProgress = useScriptStore((s) => {
    if (!s.workspaceFiles.hasScriptFile) return null;
    const isClean =
      s.reviewState === 'clean' ||
      (s.reviewState === 'issues' && s.annotations.every((a) => a.status !== 'pending'));
    return isClean ? 100 : 50;
  });

  if (isHydrating) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'grid',
          gridTemplateRows: 'auto minmax(0, 1fr) auto',
          background: APP_LOADING_BACKGROUND,
          color: 'var(--color-text-primary)',
          fontFamily: APP_FONT_STACK,
        }}
      >
        <Toolbar
          compact={viewport.width < 960}
          page={page}
          projectName={projectName}
          saveStatus={aggregatedSaveStatus}
          canUndo={canUndo}
          canRedo={canRedo}
          onCommand={(command) => {
            void handleCommand(command);
          }}
        />
        <div style={{ display: 'grid', placeItems: 'center', minHeight: 0 }}>
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                fontSize: 14,
                letterSpacing: '0.16em',
                color: 'var(--color-brand-accent)',
              }}
            >
              VIDEO WEB MASTER
            </div>
            <h1 style={{ margin: '12px 0 0', fontSize: 28 }}>正在恢复上次工程...</h1>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: APP_WINDOW_BACKGROUND,
        color: 'var(--color-text-primary)',
        overflow: 'hidden',
        fontFamily: APP_FONT_STACK,
        display: 'grid',
        gridTemplateRows: showWorkspaceTabs
          ? 'auto auto minmax(0, 1fr) auto'
          : 'auto minmax(0, 1fr) auto',
      }}
    >
      <Toolbar
        compact={viewport.width < 960}
        page={page}
        projectName={projectName}
        saveStatus={aggregatedSaveStatus}
        canUndo={canUndo}
        canRedo={canRedo}
        onCommand={(command) => {
          void handleCommand(command);
        }}
      />
      {showWorkspaceTabs && (
        <WorkspaceTabs
          active={page as 'script-workbench' | 'director-workbench' | 'editor' | 'asset-center' | 'publish'}
          onSwitch={handleWorkspaceTabSwitch}
          scriptProgress={scriptProgress}
          projectDir={currentProjectDir}
        />
      )}
      <div style={{ minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', position: 'relative' }}>
          {/* 页面渲染崩溃时显示错误信息 + 恢复入口，避免整窗黑屏（如项目切换时的中间不一致渲染抛错） */}
          <AppErrorBoundary onReset={() => resetToSetup()}>
          {/* LayoutGroup 让 setup → editor 的 layoutId 共享元素(Hero ② audio thumb)能跨 AnimatePresence morph */}
          <LayoutGroup id="page-shared-elements">
          <AnimatePresence initial={false}>
            <PageTransitionFrame
              key={pageTransition.contentKey}
              pageTransition={pageTransition}
            >
              {page === 'welcome' || page === 'setup' ? (
                <Setup
                  projectName={projectName}
                  recentProjects={recentProjects}
                  onOpenRecentProject={openProject}
                  onRemoveRecentProject={handleRemoveRecentProject}
                  onImportScript={handleImportScript}
                  onOpenSettings={() => setPage('settings')}
                  onMediaImport={handleMediaImport}
                  onImportProject={handleOpenImportProject}
                  onOpenPublishHub={() => setPage('publish-hub')}
                />
              ) : page === 'publish-hub' ? (
                <PublishHub onBack={() => setPage('welcome')} />
              ) : page === 'settings' ? (
                <Settings onBack={() => setPage(previousPage)} initialTab={settingsInitialTab} />
              ) : page === 'auto-run' ? (
                <AutoRunController setPage={setPage} />
              ) : (
                <>
                  {/* 写稿工作台和编辑器保持同时挂载，用 display 切换，避免重新挂载引起的布局振荡 */}
                  <div style={{ display: page === 'script-workbench' ? 'contents' : 'none' }}>
                    <ScriptWorkbench
                      onBack={() => setPage('welcome')}
                      onNavigateToEditor={() => setPage('director-workbench')}
                      setPage={setPage}
                    />
                  </div>
                  <div style={{ display: page === 'director-workbench' ? 'contents' : 'none' }}>
                    <DirectorWorkbench projectDir={currentProjectDir ?? ''} setPage={setPage} />
                  </div>
                  <div style={{ display: page === 'editor' ? 'contents' : 'none' }}>
                    <Editor
                      onAddAsset={handleAddAsset}
                      onOpenSettings={handleOpenSettings}
                      onUseAsPodcastAudio={handleUseAssetAsPodcastAudio}
                      onUseAsPodcastSrt={handleUseAssetAsPodcastSrt}
                      exportRequestToken={exportRequestToken}
                      projectDir={currentProjectDir}
                      isActive={page === 'editor'}
                      setPage={setPage}
                      onOpenAssetCenter={(assetId) => {
                        setAssetCenterFocusId(assetId ?? null);
                        setPage('asset-center');
                      }}
                    />
                  </div>
                  <div style={{ display: page === 'asset-center' ? 'contents' : 'none' }}>
                    <AssetCenter projectDir={currentProjectDir} focusAssetId={assetCenterFocusId} />
                  </div>
                  <div style={{ display: page === 'publish' ? 'contents' : 'none' }}>
                    <PublishWorkbench projectDir={currentProjectDir} />
                  </div>
                </>
              )}
            </PageTransitionFrame>
          </AnimatePresence>
          </LayoutGroup>
          </AppErrorBoundary>
        </div>
        <AnimatePresence initial={false}>
          {agentSidebarOpen && (
            // 对话侧边栏独立纳入错误边界：任一渲染异常只关闭面板，不整窗黑屏
            <AppErrorBoundary onReset={() => useAgentStore.getState().toggleSidebar()}>
              <AgentSidebar onOpenAgentSettings={handleOpenAgentSettings} />
            </AppErrorBoundary>
          )}
        </AnimatePresence>
      </div>
      <AppStatusBar onOpenSettings={handleOpenSettingsTab} />
      <AgentOpOverlay />
      <ImportProjectDialog
        open={importProjectDialogOpen}
        onOpenChange={setImportProjectDialogOpen}
        onImported={handleImportProjectComplete}
      />
      <ConfirmDialog
        open={Boolean(pendingSubtitleReanalysis)}
        onOpenChange={(open) => {
          if (!open) setPendingSubtitleReanalysis(null);
        }}
        title="重新分析字幕？"
        description="字幕已经替换，现有内容卡片可能与新时间点不一致。重新分析会生成新的分段与内容卡片。"
        confirmText="重新分析"
        cancelText="暂不分析"
        onConfirm={async () => {
          const entries = pendingSubtitleReanalysis;
          if (entries) await rerunAiAnalysisForEntries(entries);
        }}
      />
    </div>
  );
}
