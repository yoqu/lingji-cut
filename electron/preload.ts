import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppLogEntry } from '../src/lib/app-log';
import type {
  FileEntry,
  GenerateAICardForSegmentArgs,
  MenuContext,
  MenuEvent,
  ProjectMetadata,
  WorkbenchTabContextMenuRequest,
  WorkbenchTabMenuEvent,
  DirectoryTreeContextMenuRequest,
  DirectoryTreeMenuEvent,
  ProjectTreeCrudResult,
} from '../src/lib/electron-api';
import type { ExportConfig } from '../src/lib/export-settings';
import type { SrtEntry } from '../src/types';
import type { AICard, AISegment, AISettings, PromptBindingMap } from '../src/types/ai';
import type { MotionBible } from '../src/types/motion';
import type { ConversationAPI } from '../src/types/conversation';
import type { VideoImportRequest } from '../src/lib/video-import-types';
import type { VideoImportTaskSnapshot } from './video-import/types';
import type { PipelineTask } from './pipeline/types';
import type { AgentFeedEvent } from './pipeline/agent-feed';

type PipelineTaskUpdate = PipelineTask & { bridgeId: string };

contextBridge.exposeInMainWorld('electronAPI', {
  parseSrtFile: (filePath: string) => ipcRenderer.invoke('parse-srt-file', filePath),
  showSystemNotification: (payload: { title: string; body: string }) =>
    ipcRenderer.send('system-notification:show', payload),
  getAudioDuration: (filePath: string) => ipcRenderer.invoke('get-audio-duration', filePath),
  createSunoMusic: (request: import('../src/lib/audio-gen/types').MusicGenerationRequest) =>
    ipcRenderer.invoke('audio-generation:create-music', request),
  createSunoSound: (request: import('../src/lib/audio-gen/types').SoundGenerationRequest) =>
    ipcRenderer.invoke('audio-generation:create-sound', request),
  getSunoAudioTask: (taskId: string) =>
    ipcRenderer.invoke('audio-generation:get-task', taskId),
  getSunoCredits: () => ipcRenderer.invoke('audio-generation:get-credits'),
  testSunoAudioGeneration: () => ipcRenderer.invoke('audio-generation:smoke-test'),
  materializeSunoAudio: (args: {
    taskId: string;
    projectDir?: string | null;
    role: 'bgm' | 'stinger' | 'sfx' | 'ambience' | 'transition-sound';
    query: string;
    reuseKey: string;
    audio?: Pick<NonNullable<import('../src/types/assets').AssetMetadata['audio']>, 'energy' | 'transientType'>;
  }) => ipcRenderer.invoke('audio-generation:materialize', args),
  analyzeSrt: (args: {
    entries?: SrtEntry[];
    srtContent?: string;
    settings: AISettings;
    globalPrompt?: string;
    projectDir?: string;
    projectBindings?: PromptBindingMap | null;
    /** 一键流水线观测 runId；用于把内部耗时事件写进 auto-run jsonl */
    telemetryRunId?: string | null;
    /** 观测面板关联键（渲染端任务 id）；缺省不上报 agent 观测事件。 */
    feedId?: string;
  }) =>
    ipcRenderer.invoke('analyze-srt', args),
  onAnalyzePlanningDone: (
    callback: (planning: {
      segments: import('../src/types/ai').AISegmentAnalysis[];
      coverPrompts: string[];
      summary: string;
      keywords: string[];
      globalPrompt?: string;
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      planning: {
        segments: import('../src/types/ai').AISegmentAnalysis[];
        coverPrompts: string[];
        summary: string;
        keywords: string[];
        globalPrompt?: string;
      },
    ) => callback(planning);
    ipcRenderer.on('analyze-planning-done', handler);
    return () => ipcRenderer.removeListener('analyze-planning-done', handler);
  },
  onAnalyzeCoverPromptsReady: (
    callback: (payload: { prompts: string[] }) => void,
  ) => {
    const handler = (_event: unknown, payload: { prompts: string[] }) =>
      callback(payload);
    ipcRenderer.on('analyze-cover-prompts-ready', handler);
    return () => ipcRenderer.removeListener('analyze-cover-prompts-ready', handler);
  },
  onAnalyzeCardCompleted: (
    callback: (payload: { card: AICard; index: number }) => void,
  ) => {
    const handler = (_event: unknown, payload: { card: AICard; index: number }) =>
      callback(payload);
    ipcRenderer.on('analyze-card-completed', handler);
    return () => ipcRenderer.removeListener('analyze-card-completed', handler);
  },
  regenerateAICard: (args: {
    entries: SrtEntry[];
    card: AICard;
    segment: AISegment;
    settings: AISettings;
    globalPrompt?: string;
    cardPrompt?: string;
    programSummary?: string;
    keywords?: string[];
    motionBible?: MotionBible;
    projectDir?: string;
    projectBindings?: PromptBindingMap | null;
    feedId?: string;
    refineExistingMotion?: boolean;
  }) => ipcRenderer.invoke('regenerate-ai-card', args),
  generateAnimationDirection: (args: {
    entries: SrtEntry[];
    segment: AISegment;
    settings: AISettings;
    globalPrompt?: string;
    programSummary?: string;
    keywords?: string[];
    cardPrompt?: string;
    motionBible?: MotionBible;
    projectDir?: string;
    projectBindings?: PromptBindingMap | null;
  }) => ipcRenderer.invoke('generate-animation-direction', args),
  generateAICardForSegment: (args: GenerateAICardForSegmentArgs) =>
    ipcRenderer.invoke('generate-ai-card-for-segment', args),
  generateCardFromSubtitles: (args: {
    entries: SrtEntry[];
    draft: import('../src/lib/ai-analysis').SubtitleCardDraftInput;
    settings: AISettings;
    globalPrompt?: string;
    programSummary?: string;
    keywords?: string[];
    motionBible?: MotionBible;
    projectDir?: string;
    projectBindings?: PromptBindingMap | null;
    feedId?: string;
  }) => ipcRenderer.invoke('generate-card-from-subtitles', args),
  compileMotionCards: (args: {
    cards: { overlayId: string; tsx: string }[];
    projectDir?: string | null;
  }) =>
    ipcRenderer.invoke('remotion:compile-cards', args) as Promise<Record<string, string>>,
  regenerateCoverPrompt: (args: {
    entries: SrtEntry[];
    settings: AISettings;
    globalPrompt?: string;
    currentPrompt?: string;
    projectDir?: string;
    projectBindings?: PromptBindingMap | null;
  }) => ipcRenderer.invoke('regenerate-cover-prompt', args),
  generateCoverImages: (args: {
    prompts: string[];
    settings: AISettings;
    projectDir: string;
    projectBindings?: PromptBindingMap | null;
    telemetryRunId?: string | null;
    aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
    n?: number;
  }) => ipcRenderer.invoke('generate-cover-images', args),
  generatePublishMetadata: (args: {
    settings: AISettings;
    sourceText: string;
    currentTitle?: string;
    projectDir?: string;
    projectBindings?: PromptBindingMap | null;
  }) => ipcRenderer.invoke('generate-publish-metadata', args),
  recommendBilibiliPartition: (args: {
    settings: AISettings;
    title: string;
    desc: string;
    fallbackSource?: string;
    projectDir?: string;
    projectBindings?: PromptBindingMap | null;
  }) => ipcRenderer.invoke('recommend-bilibili-partition', args),
  generateCardImage: (args: import('../src/lib/electron-api').GenerateCardImageArgs) =>
    ipcRenderer.invoke('generate-card-image', args),
  generateCardVideo: (args: import('../src/lib/electron-api').GenerateCardVideoArgs) =>
    ipcRenderer.invoke('generate-card-video', args),
  cancelCardMediaGeneration: (cardId: string) =>
    ipcRenderer.invoke('cancel-card-media-generation', { cardId }),
  deleteCardMediaAssets: (projectDir: string, cardId: string) =>
    ipcRenderer.invoke('delete-card-media-assets', { projectDir, cardId }),
  saveCoverEdit: (args: import('../src/lib/cover-editor/contracts').SaveCoverEditArgs) =>
    ipcRenderer.invoke('save-cover-edit', args),
  lingjiLogin: () =>
    ipcRenderer.invoke('lingji-login') as Promise<{
      session: import('../src/lib/llm/lingji-gateway').LingjiSession;
      base: string;
    }>,
  lingjiLogout: () => ipcRenderer.invoke('lingji-logout') as Promise<void>,
  lingjiGetAccount: () =>
    ipcRenderer.invoke('lingji-get-account') as Promise<
      import('./lingji-account').LingjiAccount | null
    >,
  lingjiRefreshConfig: () =>
    ipcRenderer.invoke('lingji-refresh-config') as Promise<{
      session: import('../src/lib/llm/lingji-gateway').LingjiSession;
      base: string;
    } | null>,
  listSystemFonts: () =>
    ipcRenderer.invoke('list-system-fonts') as Promise<
      import('../src/lib/cover-editor/contracts').ListSystemFontsResult
    >,
  loadProject: (projectDir: string) =>
    ipcRenderer.invoke('load-project', projectDir),
  saveProjectSection: (
    projectDir: string,
    section: string,
    data: string,
    productionGuard?: import('../src/lib/production-mutations').ProductionMutationGuard,
  ) => ipcRenderer.invoke('save-project-section', projectDir, section, data, productionGuard),
  mutateProjectProduction: (
    projectDir: string,
    mutation: import('../src/lib/production-mutations').ProductionMutation,
  ) => ipcRenderer.invoke('mutate-project-production', projectDir, mutation) as Promise<
    import('../src/types/director').ProjectProductionState
  >,
  startDirectorPlan: (args: import('./director-workflow-ipc').StartDirectorPlanArgs) =>
    ipcRenderer.invoke('director:start-plan', args) as Promise<import('../src/types/director').ProjectProductionState>,
  approveDirectorPlanAndStartProduction: (projectDir: string, expectedRevision: number, taskId?: string) =>
    ipcRenderer.invoke('director:approve-and-start', projectDir, expectedRevision, taskId) as Promise<
      import('../src/types/director').ProjectProductionState
    >,
  resumeProduction: (projectDir: string, taskId?: string, mode?: 'auto' | 'director') =>
    ipcRenderer.invoke('director:resume-production', projectDir, taskId, mode) as Promise<
      import('../src/types/director').ProjectProductionState
    >,
  cancelProduction: (projectDir: string, taskId?: string, directorRevision?: number) =>
    ipcRenderer.invoke('director:cancel-production', projectDir, taskId, directorRevision) as Promise<
      import('../src/types/director').ProjectProductionState
    >,
  onDirectorPlanProgress: (callback: (progress: {
    taskId: string;
    directorRevision: number;
    phase: 'planning' | 'motion-bible';
    percent: number;
  }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof callback>[0]) => callback(progress);
    ipcRenderer.on('director-plan-progress', handler);
    return () => ipcRenderer.removeListener('director-plan-progress', handler);
  },
  scanProjectDirectory: (projectDir: string) =>
    ipcRenderer.invoke('scan-project-directory', projectDir),
  importProject: (args: { projectDir: string; acceptMissingAssets: boolean }) =>
    ipcRenderer.invoke('import-project', args),
  getInitialGlobalSettings: () =>
    ipcRenderer.sendSync('load-global-settings-sync') as string | null,
  loadGlobalSettings: () =>
    ipcRenderer.invoke('load-global-settings'),
  saveGlobalSettings: (data: string) =>
    ipcRenderer.invoke('save-global-settings', data),
  exportConfigBackup: () =>
    ipcRenderer.invoke('config-backup:export') as Promise<
      { canceled: true } | { canceled: false; filePath: string }
    >,
  previewConfigBackup: () =>
    ipcRenderer.invoke('config-backup:preview') as Promise<
      | { canceled: true }
      | {
          canceled: false;
          filePath: string;
          schemaVersion: string;
          exportedAt: string;
          appVersion: string;
          platform: string;
        }
    >,
  importConfigBackup: (args: { filePath: string }) =>
    ipcRenderer.invoke('config-backup:import', args) as Promise<{
      appliedFrom: string;
      settingsBackupPath: string;
      agentBackupPath?: string;
    }>,
  getProjectMetadata: (projectDir: string) =>
    ipcRenderer.invoke('get-project-metadata', projectDir) as Promise<ProjectMetadata>,
  selectProjectDirectory: () => ipcRenderer.invoke('select-project-directory'),
  selectMediaFile: (kind: 'audio' | 'video' | 'srt' | 'image') => ipcRenderer.invoke('select-media-file', kind),
  findLatestExport: (projectDir: string) => ipcRenderer.invoke('find-latest-export', projectDir),
  scanCoverImages: (projectDir: string) => ipcRenderer.invoke('scan-cover-images', projectDir),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  addAsset: () => ipcRenderer.invoke('add-asset'),
  scanProjectAssets: (projectDir: string) =>
    ipcRenderer.invoke('scan-project-assets', projectDir) as Promise<
      { path: string; type: 'video' | 'image' | 'audio' | 'srt'; durationMs: number }[]
    >,
  getAssetLibraryState: (projectDir?: string | null) =>
    ipcRenderer.invoke('asset-library:get-state', projectDir) as Promise<
      import('../src/types/assets').AssetLibraryState
    >,
  searchReusableMediaAssets: (args: {
    projectDir: string;
    request: import('../src/types/production').MediaAssetRequest;
  }) => ipcRenderer.invoke('asset-library:search-reusable', args) as Promise<
    import('../src/lib/media-asset-resolution').MediaAssetCandidate[]
  >,
  importAssetLibraryFiles: (request?: import('../src/types/assets').AssetImportRequest) =>
    ipcRenderer.invoke('asset-library:import-files', request) as Promise<
      import('../src/types/assets').AssetImportResult
    >,
  updateAssetLibraryAsset: (
    assetId: string,
    patch: import('../src/types/assets').AssetUpdatePatch,
  ) =>
    ipcRenderer.invoke('asset-library:update-asset', assetId, patch) as Promise<
      import('../src/types/assets').AssetLibraryFile
    >,
  chromaKeyAssetLibraryAsset: (request: import('../src/types/assets').AssetChromaKeyRequest) =>
    ipcRenderer.invoke('asset-library:chroma-key-asset', request) as Promise<
      import('../src/types/assets').AssetChromaKeyResult
    >,
  deleteAssetLibraryAsset: (request: import('../src/types/assets').AssetDeleteRequest) =>
    ipcRenderer.invoke('asset-library:delete-asset', request) as Promise<
      import('../src/types/assets').AssetDeleteResult
    >,
  replaceAssetOriginalWithProcessed: (assetId: string, projectDir?: string | null) =>
    ipcRenderer.invoke('asset-library:replace-original-with-processed', assetId, projectDir) as Promise<
      import('../src/types/assets').AssetReplaceOriginalResult
    >,
  sampleAssetLibraryColor: (request: import('../src/types/assets').AssetSampleColorRequest) =>
    ipcRenderer.invoke('asset-library:sample-color', request) as Promise<
      import('../src/types/assets').AssetSampleColorResult
    >,
  addAssetToProjectLibrary: (projectDir: string, assetId: string) =>
    ipcRenderer.invoke('asset-library:add-to-project', projectDir, assetId) as Promise<
      import('../src/types/assets').ProjectAssetManifest | null
    >,
  resolveAssetLibraryRequests: (args: {
    projectDir: string;
    requests: import('../src/types/assets').StoryboardAssetRequest[];
    sourceCardId?: string;
  }) =>
    ipcRenderer.invoke('asset-library:resolve-requests', args) as Promise<
      import('../src/types/assets').AssetResolutionState
    >,
  acceptGeneratedAssetFile: (args: {
    projectDir: string;
    requestId: string;
    filePath: string;
  }) =>
    ipcRenderer.invoke('asset-library:accept-generated-file', args) as Promise<
      import('../src/types/assets').AssetAcceptGeneratedResult
    >,
  updateAssetGenerationRequest: (args: {
    projectDir: string;
    requestId: string;
    patch: Partial<import('../src/types/assets').AssetGenerationRequest>;
  }) =>
    ipcRenderer.invoke('asset-library:update-generation-request', args) as Promise<
      import('../src/types/assets').ProjectAssetManifest | null
    >,
  renderVideo: (args: {
    timeline: string;
    outputPath: string;
    exportConfig: ExportConfig;
    srtEntries?: SrtEntry[];
    /** 可选 auto-run jsonl runId；主进程据此写 stage.* / run.* 事件。不传则不记录。 */
    telemetryRunId?: string;
  }) => ipcRenderer.invoke('render-video', args),
  onRenderProgress: (callback: (progress: number) => void) => {
    const handler = (_event: unknown, progress: number) => callback(progress);
    ipcRenderer.on('render-progress', handler);
    return () => ipcRenderer.removeListener('render-progress', handler);
  },
  onProjectUpdated: (
    callback: (payload: { projectPath: string; sections: string[] }) => void,
  ) => {
    const handler = (_event: unknown, payload: { projectPath: string; sections: string[] }) =>
      callback(payload);
    ipcRenderer.on('pipeline:project-updated', handler);
    return () => ipcRenderer.removeListener('pipeline:project-updated', handler);
  },
  onPipelineTaskUpdate: (callback: (task: PipelineTaskUpdate) => void) => {
    const handler = (_event: unknown, task: PipelineTaskUpdate) => callback(task);
    ipcRenderer.on('pipeline:task-update', handler);
    return () => ipcRenderer.removeListener('pipeline:task-update', handler);
  },
  onControlOpEvent: (
    callback: (ev: { op: string; title: string; phase: 'start' | 'success' | 'error'; error?: string; ts: number }) => void,
  ) => {
    const handler = (
      _event: unknown,
      ev: { op: string; title: string; phase: 'start' | 'success' | 'error'; error?: string; ts: number },
    ) => callback(ev);
    ipcRenderer.on('control:op-event', handler);
    return () => ipcRenderer.removeListener('control:op-event', handler);
  },
  onAgentFeedEvent: (callback: (ev: AgentFeedEvent) => void) => {
    const handler = (_event: unknown, ev: AgentFeedEvent) => callback(ev);
    ipcRenderer.on('agent-feed:event', handler);
    return () => ipcRenderer.removeListener('agent-feed:event', handler);
  },
  cancelPipelineTask: (taskId: string) =>
    ipcRenderer.invoke('pipeline:cancel-task', taskId) as Promise<void>,
  sculptCard: (args: { projectPath: string; cardId: string; notes?: string }) =>
    ipcRenderer.invoke('pipeline:sculpt-card', args) as Promise<{ taskId: string }>,
  onMenuAction: (callback: (event: MenuEvent) => void) => {
    const handler = (_event: unknown, event: MenuEvent) => callback(event);
    ipcRenderer.on('menu-action', handler);
    return () => ipcRenderer.removeListener('menu-action', handler);
  },
  getAppLogs: () => ipcRenderer.invoke('get-app-logs') as Promise<AppLogEntry[]>,
  getAppLogFilePath: () => ipcRenderer.invoke('get-app-log-file-path') as Promise<string>,
  onAppLog: (callback: (entry: AppLogEntry) => void) => {
    const handler = (_event: unknown, entry: AppLogEntry) => callback(entry);
    ipcRenderer.on('app-log', handler);
    return () => ipcRenderer.removeListener('app-log', handler);
  },
  toggleDevTools: () => ipcRenderer.invoke('toggle-devtools'),
  showItemInFolder: (filePath: string) => ipcRenderer.send('show-item-in-folder', filePath),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  openPath: (filePath: string) =>
    ipcRenderer.invoke('open-path', filePath) as Promise<{ ok: boolean; error?: string }>,
  quickLookFile: (filePath: string) =>
    ipcRenderer.invoke('quick-look-file', filePath) as Promise<{ ok: boolean; error?: string }>,
  saveScriptFile: (projectDir: string, filename: string, content: string) =>
    ipcRenderer.invoke('save-script-file', projectDir, filename, content),
  loadScriptFile: (projectDir: string, filename: string) =>
    ipcRenderer.invoke('load-script-file', projectDir, filename),
  // —— 声呐「待创作箱」桥 ——
  sonarInboxList: () => ipcRenderer.invoke('sonar-inbox-list'),
  sonarInboxMarkStatus: (
    id: string,
    status: 'pending' | 'creating' | 'drafted' | 'failed',
    patch?: { projectPath?: string; error?: string },
  ) => ipcRenderer.invoke('sonar-inbox-mark-status', id, status, patch),
  sonarInboxRemove: (id: string) => ipcRenderer.invoke('sonar-inbox-remove', id),
  sonarInboxClear: () => ipcRenderer.invoke('sonar-inbox-clear'),
  sonarBridgeInfo: () => ipcRenderer.invoke('sonar-bridge-info'),
  onSonarInboxUpdated: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('sonar-inbox-updated', handler);
    return () => ipcRenderer.removeListener('sonar-inbox-updated', handler);
  },
  getFileMtime: (filePath: string) =>
    ipcRenderer.invoke('get-file-mtime', filePath) as Promise<number | null>,
  selectTextFile: () =>
    ipcRenderer.invoke('select-text-file') as Promise<{ path: string; content: string } | null>,
  // 轻量级抖音链接解析：仅返回标题和视频 ID
  resolveDouyinUrl: (url: string) =>
    ipcRenderer.invoke('resolve-douyin-url', url) as Promise<{ title: string; videoId: string }>,
  importVideoSource: (request: VideoImportRequest) =>
    ipcRenderer.invoke('import-video-source', request),
  getVideoImportStatus: (importId: string) =>
    ipcRenderer.invoke('get-video-import-status', importId),
  onVideoImportProgress: (callback: (snapshot: VideoImportTaskSnapshot) => void) => {
    const handler = (_event: unknown, snapshot: VideoImportTaskSnapshot) => callback(snapshot);
    ipcRenderer.on('video-import-progress', handler);
    return () => ipcRenderer.removeListener('video-import-progress', handler);
  },
  onDouyinImportProgress: (callback: (snapshot: VideoImportTaskSnapshot) => void) => {
    const handler = (_event: unknown, snapshot: VideoImportTaskSnapshot) => callback(snapshot);
    ipcRenderer.on('douyin-import-progress', handler);
    return () => ipcRenderer.removeListener('douyin-import-progress', handler);
  },
  startWatching: (dir: string) => ipcRenderer.invoke('start-watching', dir),
  stopWatching: () => ipcRenderer.invoke('stop-watching'),
  onFileChanged: (callback: (data: { file: string; content: string }) => void) => {
    const handler = (_event: unknown, data: { file: string; content: string }) => callback(data);
    ipcRenderer.on('file-changed', handler);
    return () => ipcRenderer.removeListener('file-changed', handler);
  },
  onAiEditLockChanged: (
    callback: (change: {
      active: boolean;
      scope?: 'video' | 'script';
      owner?: string;
      projectPath?: string;
      reason?: string;
      startedAt?: number;
      heartbeat?: number;
      ttlMs?: number;
    }) => void,
  ) => {
    const handler = (_event: unknown, change: {
      active: boolean;
      scope?: 'video' | 'script';
      owner?: string;
      projectPath?: string;
      reason?: string;
      startedAt?: number;
      heartbeat?: number;
      ttlMs?: number;
    }) => callback(change);
    ipcRenderer.on('ai-edit-lock-changed', handler);
    return () => ipcRenderer.removeListener('ai-edit-lock-changed', handler);
  },
  onFileTreeChanged: (callback: (data: { type: string; file: string }) => void) => {
    const handler = (_event: unknown, data: { type: string; file: string }) => callback(data);
    ipcRenderer.on('file-tree-changed', handler);
    return () => ipcRenderer.removeListener('file-tree-changed', handler);
  },
  readDirectory: (dir: string) =>
    ipcRenderer.invoke('read-directory', dir) as Promise<FileEntry[]>,
  setMenuContext: (context: MenuContext) => ipcRenderer.invoke('set-menu-context', context),
  generateTTS: (args: {
    requestId: string;
    text: string;
    provider?: import('../src/types/ai').TTSProvider;
    voice?: import('../src/types/ai').TTSVoicePreset;
    voiceId?: string;
    speed?: number;
    vol?: number;
    pitch?: number;
    emotion?: string;
    model?: string;
    apiKey?: string;
    styleInstruction?: string;
    sentences?: Array<{ subtitle: string; speak: string }>;
    projectDir: string;
    telemetryRunId?: string | null;
  }) => ipcRenderer.invoke('generate-tts', args),
  onTTSProgress: (callback: (pct: number) => void) => {
    const handler = (_event: unknown, pct: number) => callback(pct);
    ipcRenderer.on('tts-progress', handler);
    return () => ipcRenderer.removeListener('tts-progress', handler);
  },
  onAnalyzeProgress: (
    callback: (progress: {
      phase: 'planning' | 'cards' | 'done';
      percent: number;
      message?: string;
      cardIndex?: number;
      cardTotal?: number;
      card?: {
        segmentIndex: number;
        segmentId: string;
        title?: string;
        visualType?: string;
        status: 'start' | 'generating-image' | 'done' | 'failed';
        error?: string;
      };
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      progress: {
        phase: 'planning' | 'cards' | 'done';
        percent: number;
        message?: string;
        cardIndex?: number;
        cardTotal?: number;
        card?: {
          segmentIndex: number;
          segmentId: string;
          title?: string;
          visualType?: string;
          status: 'start' | 'generating-image' | 'done' | 'failed';
          error?: string;
        };
      },
    ) => callback(progress);
    ipcRenderer.on('analyze-progress', handler);
    return () => ipcRenderer.removeListener('analyze-progress', handler);
  },
  onCoverProgress: (
    callback: (progress: {
      percent: number;
      phase: string;
      message: string;
      total: number;
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      progress: { percent: number; phase: string; message: string; total: number },
    ) => callback(progress);
    ipcRenderer.on('cover-progress', handler);
    return () => ipcRenderer.removeListener('cover-progress', handler);
  },
  onCardMediaProgress: (
    callback: (payload: import('../src/lib/electron-api').CardMediaProgressPayload) => void,
  ) => {
    const handler = (
      _event: unknown,
      payload: import('../src/lib/electron-api').CardMediaProgressPayload,
    ) => callback(payload);
    ipcRenderer.on('card-media-progress', handler);
    return () => ipcRenderer.removeListener('card-media-progress', handler);
  },
  cancelTTS: (requestId: string) => ipcRenderer.invoke('cancel-tts', requestId),
  selectOutputPath: (defaultPath?: string) =>
    ipcRenderer.invoke('select-output-path', defaultPath),
  checkFileExists: (targetPath: string) =>
    ipcRenderer.invoke('check-file-exists', targetPath),
  confirmOverwrite: (targetPath: string) =>
    ipcRenderer.invoke('confirm-overwrite', targetPath),
  showEditorContextMenu: () => ipcRenderer.invoke('show-editor-context-menu'),
  showWorkbenchTabContextMenu: (request: WorkbenchTabContextMenuRequest) =>
    ipcRenderer.invoke('show-workbench-tab-context-menu', request),
  onWorkbenchTabMenuAction: (callback: (event: WorkbenchTabMenuEvent) => void) => {
    const handler = (_event: unknown, payload: WorkbenchTabMenuEvent) => callback(payload);
    ipcRenderer.on('workbench-tab-menu-action', handler);
    return () => ipcRenderer.removeListener('workbench-tab-menu-action', handler);
  },
  // 目录树共享组件：CRUD + 右键菜单
  createDirectory: (args: { projectDir: string; relativePath: string }) =>
    ipcRenderer.invoke('project-tree:create-directory', args) as Promise<ProjectTreeCrudResult>,
  createFile: (args: { projectDir: string; relativePath: string; content?: string }) =>
    ipcRenderer.invoke('project-tree:create-file', args) as Promise<ProjectTreeCrudResult>,
  renamePath: (args: { projectDir: string; oldRelative: string; newRelative: string }) =>
    ipcRenderer.invoke('project-tree:rename', args) as Promise<ProjectTreeCrudResult>,
  deletePath: (args: { projectDir: string; relativePath: string; recursive?: boolean }) =>
    ipcRenderer.invoke('project-tree:delete', args) as Promise<ProjectTreeCrudResult>,
  showDirectoryTreeContextMenu: (request: DirectoryTreeContextMenuRequest) =>
    ipcRenderer.invoke('project-tree:show-context-menu', request),
  onDirectoryTreeMenuAction: (callback: (event: DirectoryTreeMenuEvent) => void) => {
    const handler = (_event: unknown, payload: DirectoryTreeMenuEvent) => callback(payload);
    ipcRenderer.on('directory-tree-menu-action', handler);
    return () => ipcRenderer.removeListener('directory-tree-menu-action', handler);
  },
  // ── 一键成稿 / AI 流水线观测日志 ──
  appendAutoRunEvent: (event: import('../src/lib/telemetry/auto-run').AutoRunEvent) =>
    ipcRenderer.invoke('auto-run-telemetry/append', event),
  listAutoRunLogs: (limit?: number) =>
    ipcRenderer.invoke('auto-run-telemetry/list-recent', limit) as Promise<
      import('../src/lib/telemetry/auto-run').AutoRunLogMeta[]
    >,
  readAutoRunLog: (runId: string) =>
    ipcRenderer.invoke('auto-run-telemetry/read-run', runId) as Promise<
      import('../src/lib/telemetry/auto-run').AutoRunEvent[]
    >,
  getLatestAutoRunLog: () =>
    ipcRenderer.invoke('auto-run-telemetry/get-latest') as Promise<{
      runId: string;
      events: import('../src/lib/telemetry/auto-run').AutoRunEvent[];
    } | null>,
  getAutoRunLogDir: () => ipcRenderer.invoke('auto-run-telemetry/get-log-dir') as Promise<string>,
  loadRecentProjects: () => ipcRenderer.invoke('load-recent-projects'),
  addRecentProject: (projectDir: string, projectName?: string) =>
    ipcRenderer.invoke('add-recent-project', projectDir, projectName),
  removeRecentProject: (projectDir: string) =>
    ipcRenderer.invoke('remove-recent-project', projectDir),
  refreshRecentProjects: () => ipcRenderer.invoke('refresh-recent-projects'),

  // ─── 提示词配置 ─────────────────────────────────────
  listPrompts: (args: { projectDir?: string } = {}) =>
    ipcRenderer.invoke('prompts:list', args),
  listPromptKinds: () => ipcRenderer.invoke('prompts:kinds'),
  readPrompt: (args: { kind: string; scope: 'builtin' | 'global' | 'project'; projectDir?: string }) =>
    ipcRenderer.invoke('prompts:read', args),
  readEffectivePrompt: (args: { kind: string; projectDir?: string }) =>
    ipcRenderer.invoke('prompts:read-effective', args),
  writePrompt: (args: {
    kind: string;
    scope: 'global' | 'project';
    content: string;
    projectDir?: string;
  }) => ipcRenderer.invoke('prompts:write', args),
  deletePrompt: (args: { kind: string; scope: 'global' | 'project'; projectDir?: string }) =>
    ipcRenderer.invoke('prompts:delete', args),
  getDefaultPrompt: (args: { kind: string }) =>
    ipcRenderer.invoke('prompts:default', args),
  readPromptBindings: (scope: 'project', projectDir: string) =>
    ipcRenderer.invoke('prompts:readBindings', { scope, projectDir }),
  writePromptBindings: (scope: 'project', bindings: unknown, projectDir: string) =>
    ipcRenderer.invoke('prompts:writeBindings', { scope, bindings, projectDir }),

  // ─── 用户自定义提示词条目（script-template 等分类） ──────
  listUserPromptCategories: () => ipcRenderer.invoke('user-prompts:categories'),
  listUserPrompts: (category: string) =>
    ipcRenderer.invoke('user-prompts:list', { category }),
  readUserPrompt: (category: string, id: string) =>
    ipcRenderer.invoke('user-prompts:read', { category, id }),
  writeUserPrompt: (input: {
    category: string;
    id: string;
    name: string;
    description: string;
    version?: number;
    system: string;
    user: string;
    ttsStyle?: string;
    ttsAnnotateHint?: string;
  }) => ipcRenderer.invoke('user-prompts:write', input),
  deleteUserPrompt: (category: string, id: string) =>
    ipcRenderer.invoke('user-prompts:delete', { category, id }),
  getUserPromptSeed: (category: string, id: string) =>
    ipcRenderer.invoke('user-prompts:seed', { category, id }),
});

// ─── Agent API ────────────────────────────────────────────

contextBridge.exposeInMainWorld('agentAPI', {
  getConfig: () => ipcRenderer.invoke('agent:get-config'),
  saveConfig: (data: unknown) => ipcRenderer.invoke('agent:save-config', data),
  setActiveAgent: (agentId: string) => ipcRenderer.invoke('agent:set-active-agent', agentId),
  getApiKey: (agentId: string) => ipcRenderer.invoke('agent:get-api-key', agentId),
  setApiKey: (agentId: string, key: string) => ipcRenderer.invoke('agent:set-api-key', agentId, key),
  getPermissionPolicy: () => ipcRenderer.invoke('agent:get-permission-policy'),
  setPermissionPolicy: (policy: string) => ipcRenderer.invoke('agent:set-permission-policy', policy),

  runPreflight: (agentId?: string) => ipcRenderer.invoke('agent:run-preflight', agentId),
  listModels: (agentId: string) => ipcRenderer.invoke('agent:list-models', agentId),

  connectRuntime: (input: { conversationId: number; projectDir: string; sessionId?: string | null; agentType?: string }) =>
    ipcRenderer.invoke('agent:connect-runtime', input),
  disconnectRuntime: (conversationId: number) => ipcRenderer.invoke('agent:disconnect-runtime', conversationId),
  listSkills: (agentId: string) => ipcRenderer.invoke('agent:list-skills', agentId),
  addSkill: () => ipcRenderer.invoke('agent:add-skill'),
  removeSkill: (skillId: string) => ipcRenderer.invoke('agent:remove-skill', skillId),
  readSkillTree: (skillId: string) => ipcRenderer.invoke('agent:read-skill-tree', skillId),
  readSkillFile: (skillId: string, relPath: string) =>
    ipcRenderer.invoke('agent:read-skill-file', skillId, relPath),
  openSkillDir: (skillId?: string) => ipcRenderer.invoke('agent:open-skill-dir', skillId),
  sendPromptToConversation: (
    conversationId: number,
    contents: unknown[],
    opts?: { model?: string; reasoning?: string; skillIds?: string[] },
  ) => ipcRenderer.invoke('agent:send-prompt-runtime', conversationId, contents, opts),
  cancelConversationTurn: (conversationId: number) =>
    ipcRenderer.invoke('agent:cancel-turn-runtime', conversationId),
  setConversationMode: (conversationId: number, modeId: string) =>
    ipcRenderer.invoke('agent:set-mode-runtime', conversationId, modeId),
  setConversationConfigOption: (conversationId: number, configId: string, valueId: string) =>
    ipcRenderer.invoke('agent:set-config-option-runtime', conversationId, configId, valueId),
  respondConversationPermission: (conversationId: number, requestId: string, optionId: string) =>
    ipcRenderer.invoke('agent:respond-permission-runtime', conversationId, requestId, optionId),
  onRuntimeStatusChanged: (callback: (payload: { conversationId: number; status: string }) => void) => {
    const handler = (_event: unknown, payload: { conversationId: number; status: string }) => callback(payload);
    ipcRenderer.on('agent:runtime-status', handler);
    return () => ipcRenderer.removeListener('agent:runtime-status', handler);
  },
  onRuntimeEvent: (callback: (payload: { conversationId: number; event: unknown }) => void) => {
    const handler = (_event: unknown, payload: { conversationId: number; event: unknown }) => callback(payload);
    ipcRenderer.on('agent:runtime-event', handler);
    return () => ipcRenderer.removeListener('agent:runtime-event', handler);
  },
  onRuntimeCapabilities: (callback: (payload: { conversationId: number; capabilities: unknown }) => void) => {
    const handler = (_event: unknown, payload: { conversationId: number; capabilities: unknown }) => callback(payload);
    ipcRenderer.on('agent:runtime-capabilities', handler);
    return () => ipcRenderer.removeListener('agent:runtime-capabilities', handler);
  },
});

contextBridge.exposeInMainWorld('conversationAPI', {
  list: (projectId: string) => ipcRenderer.invoke('conversation:list', projectId),
  detail: (conversationId: number, projectId?: string) => {
    if (!projectId) {
      throw new Error('conversationAPI.detail requires projectId');
    }
    return ipcRenderer.invoke('conversation:detail', projectId, conversationId);
  },
  create: (input: { projectId: string; agentType: string; title?: string }) =>
    ipcRenderer.invoke('conversation:create', input),
  fork: (sourceConversationId: number, projectId?: string, title?: string) => {
    if (!projectId) {
      throw new Error('conversationAPI.fork requires projectId');
    }
    return ipcRenderer.invoke('conversation:fork', projectId, sourceConversationId, title);
  },
  update: (
    conversationId: number,
    patch: {
      title?: string;
      status?: string;
      externalId?: string | null;
      sessionStatsJson?: string | null;
      messageCount?: number;
    },
    projectId?: string,
  ) => {
    if (!projectId) {
      throw new Error('conversationAPI.update requires projectId');
    }
    return ipcRenderer.invoke('conversation:update', projectId, conversationId, patch);
  },
  delete: (conversationId: number, projectId?: string) => {
    if (!projectId) {
      throw new Error('conversationAPI.delete requires projectId');
    }
    return ipcRenderer.invoke('conversation:delete', projectId, conversationId);
  },
  open: (projectId: string, conversationId: number) => {
    if (!projectId) {
      throw new Error('conversationAPI.open requires projectId');
    }
    return ipcRenderer.invoke('conversation:open', projectId, conversationId);
  },
  appendTurn: (
    conversationId: number,
    input: { role: string; blocks: unknown[]; sessionStatsJson?: string | null },
    projectId?: string,
  ) => {
    if (!projectId) {
      throw new Error('conversationAPI.appendTurn requires projectId');
    }
    return ipcRenderer.invoke('conversation:append-turn', projectId, conversationId, input);
  },
  getOpenedConversation: (projectId: string) => ipcRenderer.invoke('conversation:get-opened', projectId),
  setOpenedConversation: (projectId: string, conversationId: number | null) =>
    ipcRenderer.invoke('conversation:set-opened', projectId, conversationId),
} satisfies ConversationAPI);

// ─── MCP API ─────────────────────────────────────────────

contextBridge.exposeInMainWorld('mcpAPI', {
  // 控制服务工具事件桥（Main → Renderer；lingji_* 编辑器类工具的落地通道）
  onGetEditorState: (handler: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on('mcp:get-editor-state', listener);
    return () => ipcRenderer.removeListener('mcp:get-editor-state', listener);
  },
  onReadScript: (handler: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on('mcp:read-script', listener);
    return () => ipcRenderer.removeListener('mcp:read-script', listener);
  },
  onGenerateScript: (handler: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on('mcp:generate-script', listener);
    return () => ipcRenderer.removeListener('mcp:generate-script', listener);
  },
  onUpdateScript: (handler: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on('mcp:update-script', listener);
    return () => ipcRenderer.removeListener('mcp:update-script', listener);
  },
  onSubmitReview: (handler: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on('mcp:submit-review', listener);
    return () => ipcRenderer.removeListener('mcp:submit-review', listener);
  },
  onListProjectFiles: (handler: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on('mcp:list-project-files', listener);
    return () => ipcRenderer.removeListener('mcp:list-project-files', listener);
  },
  onGetProjectContext: (handler: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on('mcp:get-project-context', listener);
    return () => ipcRenderer.removeListener('mcp:get-project-context', listener);
  },

  // MCP 日志监听（Main → Renderer）
  onLog: (handler: (data: { level: string; message: string }) => void) => {
    const listener = (_event: unknown, data: { level: string; message: string }) => handler(data);
    ipcRenderer.on('mcp:log', listener);
    return () => ipcRenderer.removeListener('mcp:log', listener);
  },

  // 回复辅助（Renderer → Main）
  reply: (replyChannel: string, data: unknown) => ipcRenderer.invoke(replyChannel, data),
});

// ─── Script History API ───────────────────────────────

contextBridge.exposeInMainWorld('scriptHistoryAPI', {
  create: (input: {
    projectId: string;
    fileName: string;
    content: string;
    source: string;
    providerId?: string | null;
    providerName?: string | null;
    modelName?: string | null;
  }) => ipcRenderer.invoke('script-history:create', input),
  list: (projectId: string, fileName: string, opts?: {
    sourceFilter?: string[];
    limit?: number;
    offset?: number;
  }) => ipcRenderer.invoke('script-history:list', projectId, fileName, opts),
  get: (projectId: string, versionId: number) =>
    ipcRenderer.invoke('script-history:get', projectId, versionId),
  rollback: (versionId: number, currentContent: string, projectId: string, fileName: string) =>
    ipcRenderer.invoke('script-history:rollback', versionId, currentContent, projectId, fileName),
  updateLabel: (projectId: string, versionId: number, label: string | null) =>
    ipcRenderer.invoke('script-history:update-label', projectId, versionId, label),
  delete: (projectId: string, versionId: number) =>
    ipcRenderer.invoke('script-history:delete', projectId, versionId),
});

// ─── Publish API ──────────────────────────────────────────

contextBridge.exposeInMainWorld('publishAPI', {
  listAccounts: () => ipcRenderer.invoke('publish:list-accounts'),
  deleteAccount: (id: string) => ipcRenderer.invoke('publish:delete-account', id),
  login: (platform: string, accountName: string, headless?: boolean) =>
    ipcRenderer.invoke('publish:login', platform, accountName, headless),
  check: (id: string) => ipcRenderer.invoke('publish:check', id),
  getSettings: () => ipcRenderer.invoke('publish:get-settings'),
  setSettings: (patch: { headlessLogin?: boolean }) =>
    ipcRenderer.invoke('publish:set-settings', patch),
  run: (job: import('../src/lib/electron-api').PublishJobInput, headless?: boolean) =>
    ipcRenderer.invoke('publish:run', job, headless),
  cancel: () => ipcRenderer.invoke('publish:cancel'),
  onQrcode: (cb: (payload: { platform: string; accountName: string; png: string }) => void) => {
    const handler = (_e: unknown, payload: { platform: string; accountName: string; png: string }) =>
      cb(payload);
    ipcRenderer.on('publish:qrcode', handler);
    return () => ipcRenderer.removeListener('publish:qrcode', handler);
  },
  onProgress: (
    cb: (payload: {
      jobId: string;
      accountId: string;
      state: string;
      percent?: number;
      message?: string;
    }) => void,
  ) => {
    const handler = (
      _e: unknown,
      payload: {
        jobId: string;
        accountId: string;
        state: string;
        percent?: number;
        message?: string;
      },
    ) => cb(payload);
    ipcRenderer.on('publish:progress', handler);
    return () => ipcRenderer.removeListener('publish:progress', handler);
  },
  getBiliupStatus: () => ipcRenderer.invoke('publish:biliup-status'),
  downloadBiliup: () => ipcRenderer.invoke('publish:download-biliup'),
  cancelBiliupDownload: () => ipcRenderer.invoke('publish:cancel-biliup-download'),
  onBiliupDownloadProgress: (
    cb: (p: { phase: string; received?: number; total?: number; speed?: number }) => void,
  ) => {
    const handler = (
      _e: unknown,
      p: { phase: string; received?: number; total?: number; speed?: number },
    ) => cb(p);
    ipcRenderer.on('publish:biliup-download-progress', handler);
    return () => ipcRenderer.removeListener('publish:biliup-download-progress', handler);
  },
  getChromiumStatus: () => ipcRenderer.invoke('publish:chromium-status'),
  downloadChromium: () => ipcRenderer.invoke('publish:download-chromium'),
  cancelChromiumDownload: () => ipcRenderer.invoke('publish:cancel-chromium-download'),
  onChromiumDownloadProgress: (
    cb: (p: { phase: string; percent?: number; received?: number; total?: number }) => void,
  ) => {
    const handler = (
      _e: unknown,
      p: { phase: string; percent?: number; received?: number; total?: number },
    ) => cb(p);
    ipcRenderer.on('publish:chromium-download-progress', handler);
    return () => ipcRenderer.removeListener('publish:chromium-download-progress', handler);
  },
});
