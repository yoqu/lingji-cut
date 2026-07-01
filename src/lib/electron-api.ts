import type { ExportConfig } from './export-settings';
import type { AppLogEntry } from './app-log';
import type { SrtEntry } from '../types';
import type {
  AICard,
  AISegment,
  AISegmentVisualType,
  AISettings,
  CoverCandidate,
  PromptBindingMap,
  MediaCardContent,
  ImageAspectRatio,
  TTSProvider,
  TTSVoicePreset,
  VideoAspectRatio,
} from '../types/ai';
import type { ImportKind } from './import-files';
import type {
  VideoImportProgress,
  VideoImportRequest,
} from './video-import-types';
import type { VideoImportTaskSnapshot } from '../../electron/video-import/types';
import type { PipelineTask } from '../../electron/pipeline/types';
import type {
  PromptKind,
  PromptKindMeta,
  PromptScope,
  EffectivePromptTemplate,
  PromptCategory,
  PromptCategoryMeta,
  UserPromptEntry,
  UserPromptSeed,
} from './prompts';
import type { PublishAccount, PublishPlatform } from '../../electron/publish/types';
export type { PublishAccount, PublishPlatform };

export type AppPage = 'welcome' | 'setup' | 'editor' | 'script-workbench' | 'settings' | 'auto-run' | 'publish';

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  children?: FileEntry[];
}

export interface WorkbenchTabContextMenuRequest {
  file: string;
  projectDir: string | null;
  tabIndex: number;
  tabCount: number;
}

export interface WorkbenchTabMenuEvent {
  action: 'close-current' | 'close-others' | 'close-right';
  file: string;
}

export const MENU_ACTIONS = [
  'new-project',
  'open-project',
  'open-settings',
  'close-project',
  'show-project-in-folder',
  'undo',
  'redo',
  'replace-audio',
  'replace-srt',
  'add-asset',
  'export',
  'save-script',
  'go-back',
  'find',
  'find-replace',
] as const;

export type MenuAction = (typeof MENU_ACTIONS)[number];

export interface MenuRecentProject {
  path: string;
  name: string;
}

export interface MenuContext {
  activePage: AppPage;
  hasProject: boolean;
  recentProjects: MenuRecentProject[];
  /**
   * 一键成稿（auto-run）页运行中。开启后菜单项会被禁用、
   * 全局快捷键被屏蔽，避免在自动流程中触发副作用操作。
   */
  isAutoRunning?: boolean;
  /** AI/Agent 正在编辑项目时锁定内容操作与写文件菜单。 */
  isAiEditing?: boolean;
}

export type MenuEvent =
  | {
      type: 'command';
      action: MenuAction;
    }
  | {
      type: 'open-recent-project';
      projectDir: string;
    };

const PROJECT_REQUIRED_COMMANDS = new Set<MenuAction>([
  'close-project',
  'show-project-in-folder',
  'undo',
  'redo',
  'replace-audio',
  'replace-srt',
  'add-asset',
  'export',
]);

export function isProjectRequiredCommand(command: MenuAction): boolean {
  return PROJECT_REQUIRED_COMMANDS.has(command);
}

export interface GenerateCardImageArgs {
  projectDir: string;
  cardId: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio: ImageAspectRatio;
  providerId?: string | null;
  model?: string | null;
  extraParams?: Record<string, unknown>;
  settings: AISettings;
  projectBindings?: PromptBindingMap | null;
}

export interface GenerateCardVideoArgs {
  projectDir: string;
  cardId: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio: VideoAspectRatio;
  durationSeconds: number;
  providerId?: string | null;
  model?: string | null;
  extraParams?: Record<string, unknown>;
  settings: AISettings;
  projectBindings?: PromptBindingMap | null;
}

export interface GenerateAICardForSegmentArgs {
  entries: SrtEntry[];
  segment: AISegment;
  settings: AISettings;
  globalPrompt?: string;
  cardPrompt?: string;
  programSummary?: string;
  keywords?: string[];
  projectDir?: string;
  projectBindings?: PromptBindingMap | null;
  segmentIndex?: number;
  totalSegments?: number;
  prevSegment?: AISegment;
  nextSegment?: AISegment;
  visualType?: AISegmentVisualType;
}

export interface CardMediaProgressPayload {
  cardId: string;
  taskId: string;
  percent?: number;
  phase?: string;
  message?: string;
}

export type ClaudeCodeAcpLLMEvent =
  | { type: 'content_delta'; text: string }
  | { type: 'thinking'; text: string };

export interface ClaudeCodeAcpLLMRunRequest {
  requestId: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  projectDir?: string | null;
  jsonMode?: boolean;
}

export interface ClaudeCodeAcpLLMRunResult {
  text: string;
}

export interface ClaudeCodeAcpModelInfo {
  modelId: string;
  name: string;
  description?: string;
}

export interface ProjectMetadata {
  projectDir: string;
  sizeBytes: number;
  createdAtMs: number;
}

export interface RecentProjectEntry {
  path: string;
  name: string;
  lastOpenedAt: number;
  createdAt?: string;
  updatedAt?: string;
  coverImageUrl?: string;
}

/** 灵机剪影缓存账户（主进程 safeStorage 落盘结构，含长效网关密钥 lj_ 与服务端下发配置）。 */
export interface LingjiAccount {
  email: string;
  displayName?: string;
  avatarUrl?: string;
  tier: string;
  balance: number;
  apiKey: string;
  connectedAt: string;
  providers?: import('./llm/lingji-gateway').LingjiGatewayConfig;
}

export interface ElectronAPI {
  parseSrtFile: (filePath: string) => Promise<{ entries: SrtEntry[]; durationMs: number }>;
  /** 弹出系统通知（mac 通知中心 / Windows 通知）。点击通知聚焦主窗口。 */
  showSystemNotification: (payload: { title: string; body: string }) => void;
  getAudioDuration: (filePath: string) => Promise<number>;
  /** 返回文件的 mtime（毫秒整数）。文件不存在或读取失败时返回 null。 */
  getFileMtime: (filePath: string) => Promise<number | null>;
  analyzeSrt: (args: {
    entries?: SrtEntry[];
    srtContent?: string;
    settings: AISettings;
    globalPrompt?: string;
    projectDir?: string;
    projectBindings?: PromptBindingMap | null;
    telemetryRunId?: string | null;
  }) => Promise<unknown>;
  onAnalyzePlanningDone: (
    callback: (planning: {
      segments: import('../types/ai').AISegmentAnalysis[];
      coverPrompts: string[];
      summary: string;
      keywords: string[];
      globalPrompt?: string;
    }) => void,
  ) => () => void;
  onAnalyzeCoverPromptsReady: (
    callback: (payload: { prompts: string[] }) => void,
  ) => () => void;
  onAnalyzeCardCompleted: (
    callback: (payload: { card: AICard; index: number }) => void,
  ) => () => void;
  regenerateAICard: (args: {
    entries: SrtEntry[];
    card: AICard;
    segment: AISegment;
    settings: AISettings;
    globalPrompt?: string;
    cardPrompt?: string;
    programSummary?: string;
    keywords?: string[];
    projectDir?: string;
    projectBindings?: PromptBindingMap | null;
  }) => Promise<AICard>;
  generateAnimationDirection: (args: {
    entries: SrtEntry[];
    segment: AISegment;
    settings: AISettings;
    globalPrompt?: string;
    programSummary?: string;
    keywords?: string[];
    cardPrompt?: string;
    projectDir?: string;
    projectBindings?: PromptBindingMap | null;
  }) => Promise<string>;
  generateAICardForSegment: (args: GenerateAICardForSegmentArgs) => Promise<AICard>;
  generateCardFromSubtitles: (args: {
    entries: SrtEntry[];
    draft: import('./ai-analysis').SubtitleCardDraftInput;
    settings: AISettings;
    globalPrompt?: string;
    programSummary?: string;
    keywords?: string[];
    projectDir?: string;
    projectBindings?: PromptBindingMap | null;
  }) => Promise<AICard>;
  /** 把 motion 卡片 TSX 批量编译为可执行 CJS（overlayId → js）。 */
  compileMotionCards: (args: {
    cards: { overlayId: string; tsx: string }[];
    projectDir?: string | null;
  }) => Promise<Record<string, string>>;
  regenerateCoverPrompt: (args: {
    entries: SrtEntry[];
    settings: AISettings;
    globalPrompt?: string;
    currentPrompt?: string;
    projectDir?: string;
    projectBindings?: PromptBindingMap | null;
  }) => Promise<string[]>;
  generateCoverImages: (args: {
    prompts: string[];
    settings: AISettings;
    projectDir: string;
    projectBindings?: PromptBindingMap | null;
    telemetryRunId?: string | null;
    aspectRatio?: ImageAspectRatio;
    n?: number;
  }) => Promise<CoverCandidate[]>;
  generatePublishMetadata: (args: {
    settings: AISettings;
    sourceText: string;
    currentTitle?: string;
    projectDir?: string;
    projectBindings?: PromptBindingMap | null;
  }) => Promise<{ title: string; desc: string; tags: string[] }>;
  recommendBilibiliPartition: (args: {
    settings: AISettings;
    title: string;
    desc: string;
    fallbackSource?: string;
    projectDir?: string;
    projectBindings?: PromptBindingMap | null;
  }) => Promise<{ tid: number }>;
  generateCardImage: (args: GenerateCardImageArgs) => Promise<MediaCardContent>;
  generateCardVideo: (args: GenerateCardVideoArgs) => Promise<MediaCardContent>;
  cancelCardMediaGeneration: (cardId: string) => Promise<{ ok: true }>;
  deleteCardMediaAssets: (
    projectDir: string,
    cardId: string,
  ) => Promise<{ ok: true }>;
  onCardMediaProgress: (
    callback: (payload: CardMediaProgressPayload) => void,
  ) => () => void;
  runClaudeCodeAcpLLM: (
    args: ClaudeCodeAcpLLMRunRequest,
  ) => Promise<ClaudeCodeAcpLLMRunResult>;
  cancelClaudeCodeAcpLLM: (requestId: string) => Promise<{ ok: true }>;
  listClaudeCodeAcpModels: () => Promise<ClaudeCodeAcpModelInfo[]>;
  onClaudeCodeAcpLLMEvent: (
    callback: (payload: { requestId: string; event: ClaudeCodeAcpLLMEvent }) => void,
  ) => () => void;
  saveCoverEdit: (
    args: import('./cover-editor/contracts').SaveCoverEditArgs,
  ) => Promise<import('./cover-editor/contracts').SaveCoverEditResult>;
  listSystemFonts: () => Promise<import('./cover-editor/contracts').ListSystemFontsResult>;
  /** 灵机剪影账户浏览器授权登录；返回会话与烘焙服务器基址（用于 upsert 兜底 provider）。 */
  lingjiLogin: () => Promise<{
    session: import('./llm/lingji-gateway').LingjiSession;
    base: string;
  }>;
  lingjiLogout: () => Promise<void>;
  lingjiGetAccount: () => Promise<LingjiAccount | null>;
  /** 用缓存账户拉取最新下发配置并回灌；返回可重建四类 provider 的 session 与基址，未登录返回 null。 */
  lingjiRefreshConfig: () => Promise<{
    session: import('./llm/lingji-gateway').LingjiSession;
    base: string;
  } | null>;
  saveTimeline: (projectDir: string, data: string) => Promise<string>;
  loadTimeline: (projectDir: string) => Promise<string | null>;
  saveAIAnalysis: (projectDir: string, data: string) => Promise<string>;
  loadAIAnalysis: (projectDir: string) => Promise<string | null>;
  loadProject: (projectDir: string) => Promise<string>;
  saveProjectSection: (projectDir: string, section: string, data: string) => Promise<void>;
  scanProjectDirectory: (
    projectDir: string,
  ) => Promise<import('./project-import-types').ImportProjectScanResult>;
  importProject: (
    args: import('./project-import-types').ImportProjectArgs,
  ) => Promise<
    | {
        ok: true;
        result: import('./project-import-types').ImportProjectResult;
      }
    | {
        ok: false;
        error: import('./project-import-types').ImportProjectErrorPayload;
      }
  >;
  getInitialGlobalSettings: () => string | null;
  loadGlobalSettings: () => Promise<string | null>;
  saveGlobalSettings: (data: string) => Promise<void>;
  getProjectMetadata: (projectDir: string) => Promise<ProjectMetadata>;
  selectProjectDirectory: () => Promise<string | null>;
  selectSetupFile: (kind: ImportKind) => Promise<string | null>;
  selectMediaFile: (kind: 'audio' | 'video' | 'srt' | 'image') => Promise<string | null>;
  /** 扫描项目目录顶层最新的 .mp4 成片；无则返回 null（发布选项卡联动兜底）。 */
  findLatestExport: (projectDir: string) => Promise<string | null>;
  /** 扫描项目 covers/ 下的图片并读取真实像素尺寸（发布选项卡按比例分桶）。 */
  scanCoverImages: (
    projectDir: string,
  ) => Promise<{ path: string; width: number; height: number; mtimeMs: number }[]>;
  getPathForFile: (file: File) => string;
  addAsset: () => Promise<{
    path: string;
    type: 'video' | 'image' | 'audio';
    durationMs: number;
  } | null>;
  scanProjectAssets: (projectDir: string) => Promise<
    { path: string; type: 'video' | 'image' | 'audio' | 'srt'; durationMs: number }[]
  >;
  scanImportDirectory: (dir: string) => Promise<{
    audioFiles: string[];
    srtFiles: string[];
  }>;
  renderVideo: (args: {
    timeline: string;
    outputPath: string;
    exportConfig: ExportConfig;
    srtEntries?: SrtEntry[];
    /** 可选 auto-run jsonl runId；主进程据此写 stage.* / run.* 事件。 */
    telemetryRunId?: string;
  }) => Promise<{ outputPath: string }>;
  getAppLogs: () => Promise<AppLogEntry[]>;
  getAppLogFilePath: () => Promise<string>;
  onRenderProgress: (callback: (progress: number) => void) => () => void;
  onProjectUpdated: (
    callback: (payload: { projectPath: string; sections: string[] }) => void,
  ) => () => void;
  /** 订阅 MCP/pipeline 任务进度（导出/TTS/分析/封面/卡片/Motion）。 */
  onPipelineTaskUpdate: (
    callback: (task: PipelineTask & { bridgeId: string }) => void,
  ) => () => void;
  /** 取消 MCP/pipeline 任务。 */
  cancelPipelineTask: (taskId: string) => Promise<void>;
  onMenuAction: (callback: (event: MenuEvent) => void) => () => void;
  onAppLog: (callback: (entry: AppLogEntry) => void) => () => void;
  toggleDevTools: () => Promise<void>;
  showItemInFolder: (filePath: string) => void;
  openExternal: (url: string) => void;
  /** 用系统默认 App 打开文件，返回成功标记。 */
  openPath: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
  /** macOS 调用 Quick Look 预览；非 macOS 降级为默认 App 打开。 */
  quickLookFile: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
  // Script workbench
  saveScriptFile: (projectDir: string, filename: string, content: string) => Promise<void>;
  loadScriptFile: (projectDir: string, filename: string) => Promise<string | null>;
  // —— 声呐「待创作箱」桥（扩展推入的二创素材）——
  sonarInboxList: () => Promise<import('./sonar-inbox').SonarInboxItem[]>;
  sonarInboxMarkStatus: (
    id: string,
    status: import('./sonar-inbox').SonarInboxStatus,
    patch?: { projectPath?: string; error?: string },
  ) => Promise<import('./sonar-inbox').SonarInboxItem | null>;
  sonarInboxRemove: (id: string) => Promise<boolean>;
  /** 清空待创作箱全部素材，返回删除条数。 */
  sonarInboxClear: () => Promise<number>;
  sonarBridgeInfo: () => Promise<{ port: number; token: string }>;
  /** 收件箱新增/刷新时触发（扩展推送到桥后），用于待创作箱实时刷新。返回取消订阅函数。 */
  onSonarInboxUpdated: (callback: () => void) => () => void;
  saveScriptState: (projectDir: string, state: string) => Promise<void>;
  loadScriptState: (projectDir: string) => Promise<string | null>;
  selectTextFile: () => Promise<{ path: string; content: string } | null>;
  /** 轻量级抖音链接解析：仅返回标题和视频 ID，不下载视频 */
  resolveDouyinUrl: (url: string) => Promise<{ title: string; videoId: string }>;
  importVideoSource: (request: VideoImportRequest) => Promise<VideoImportProgress>;
  getVideoImportStatus: (importId: string) => Promise<VideoImportProgress | null>;
  onVideoImportProgress: (
    callback: (snapshot: VideoImportTaskSnapshot) => void,
  ) => () => void;
  onDouyinImportProgress: (
    callback: (snapshot: VideoImportTaskSnapshot) => void,
  ) => () => void;
  startWatching: (dir: string) => Promise<void>;
  stopWatching: () => Promise<void>;
  onFileChanged: (callback: (data: { file: string; content: string }) => void) => () => void;
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
  ) => () => void;
  onFileTreeChanged: (callback: (data: { type: string; file: string }) => void) => () => void;
  readDirectory: (dir: string) => Promise<FileEntry[]>;
  setMenuContext: (context: MenuContext) => Promise<void>;
  generateTTS: (args: {
    requestId: string;
    text: string;
    provider?: TTSProvider;
    voice?: TTSVoicePreset;
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
  }) => Promise<{ audioPath: string; srtPath: string; durationMs: number }>;
  onTTSProgress: (callback: (pct: number) => void) => () => void;
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
  ) => () => void;
  onCoverProgress: (
    callback: (progress: {
      percent: number;
      phase: string;
      message: string;
      total: number;
    }) => void,
  ) => () => void;
  cancelTTS: (requestId: string) => Promise<void>;
  selectOutputPath: (defaultPath?: string) => Promise<string | null>;
  checkFileExists: (targetPath: string) => Promise<boolean>;
  confirmOverwrite: (targetPath: string) => Promise<boolean>;
  showEditorContextMenu: () => Promise<void>;
  showWorkbenchTabContextMenu: (request: WorkbenchTabContextMenuRequest) => Promise<void>;
  onWorkbenchTabMenuAction: (callback: (event: WorkbenchTabMenuEvent) => void) => () => void;
  // 一键成稿观测日志
  appendAutoRunEvent: (event: import('./telemetry/auto-run').AutoRunEvent) => Promise<void>;
  listAutoRunLogs: (limit?: number) => Promise<import('./telemetry/auto-run').AutoRunLogMeta[]>;
  readAutoRunLog: (runId: string) => Promise<import('./telemetry/auto-run').AutoRunEvent[]>;
  getLatestAutoRunLog: () => Promise<{
    runId: string;
    events: import('./telemetry/auto-run').AutoRunEvent[];
  } | null>;
  getAutoRunLogDir: () => Promise<string>;
  // 最近项目管理
  loadRecentProjects: () => Promise<RecentProjectEntry[]>;
  addRecentProject: (projectDir: string, projectName?: string) => Promise<RecentProjectEntry[]>;
  removeRecentProject: (projectDir: string) => Promise<RecentProjectEntry[]>;
  refreshRecentProjects: () => Promise<RecentProjectEntry[]>;
  exportConfigBackup: () => Promise<
    { canceled: true } | { canceled: false; filePath: string }
  >;
  previewConfigBackup: () => Promise<
    | { canceled: true }
    | {
        canceled: false;
        filePath: string;
        schemaVersion: string;
        exportedAt: string;
        appVersion: string;
        platform: string;
      }
  >;
  importConfigBackup: (args: { filePath: string }) => Promise<{
    appliedFrom: string;
    settingsBackupPath: string;
    agentBackupPath?: string;
  }>;

  // 提示词配置
  listPrompts: (args?: { projectDir?: string }) => Promise<
    Array<{
      kind: PromptKind;
      effectiveScope: PromptScope;
      hasGlobal: boolean;
      hasProject: boolean;
      meta: PromptKindMeta;
    }>
  >;
  listPromptKinds: () => Promise<Array<{ kind: PromptKind; meta: PromptKindMeta }>>;
  readPrompt: (args: {
    kind: PromptKind;
    scope: PromptScope;
    projectDir?: string;
  }) => Promise<{ kind: PromptKind; scope: PromptScope; content: string | null }>;
  readEffectivePrompt: (args: { kind: PromptKind; projectDir?: string }) => Promise<
    EffectivePromptTemplate & { kind: PromptKind }
  >;
  writePrompt: (args: {
    kind: PromptKind;
    scope: 'global' | 'project';
    /** 用户编辑的纯文本 user 段；主进程负责拼接为合法 YAML。 */
    content: string;
    projectDir?: string;
  }) => Promise<{ kind: PromptKind; scope: 'global' | 'project'; filePath: string }>;
  deletePrompt: (args: {
    kind: PromptKind;
    scope: 'global' | 'project';
    projectDir?: string;
  }) => Promise<{ kind: PromptKind; scope: 'global' | 'project'; removed: boolean }>;
  getDefaultPrompt: (args: { kind: PromptKind }) => Promise<{ kind: PromptKind; content: string }>;
  readPromptBindings(scope: 'project', projectDir: string): Promise<PromptBindingMap>;
  writePromptBindings(scope: 'project', bindings: PromptBindingMap, projectDir: string): Promise<void>;

  // 用户自定义提示词条目（如口播模板）
  listUserPromptCategories: () => Promise<PromptCategoryMeta[]>;
  listUserPrompts: (category: PromptCategory) => Promise<UserPromptEntry[]>;
  readUserPrompt: (category: PromptCategory, id: string) => Promise<UserPromptEntry | null>;
  writeUserPrompt: (input: {
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
  deleteUserPrompt: (
    category: PromptCategory,
    id: string,
  ) => Promise<{ removed: boolean; restoredToSeed: boolean }>;
  getUserPromptSeed: (category: PromptCategory, id: string) => Promise<UserPromptSeed | null>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

// ─── ScriptHistoryAPI ─────────────────────────────────

export interface ScriptHistoryAPI {
  create(input: {
    projectId: string;
    fileName: string;
    content: string;
    source: string;
    providerId?: string | null;
    providerName?: string | null;
    modelName?: string | null;
  }): Promise<{
    id: number;
    fileName: string;
    source: string;
    providerName: string | null;
    modelName: string | null;
    label: string | null;
    byteSize: number;
    createdAt: string;
  }>;
  list(projectId: string, fileName: string, opts?: {
    sourceFilter?: string[];
    limit?: number;
    offset?: number;
  }): Promise<Array<{
    id: number;
    fileName: string;
    source: string;
    providerName: string | null;
    modelName: string | null;
    label: string | null;
    byteSize: number;
    createdAt: string;
  }>>;
  get(projectId: string, versionId: number): Promise<{
    id: number;
    projectId: string;
    fileName: string;
    content: string;
    source: string;
    providerId: string | null;
    providerName: string | null;
    modelName: string | null;
    label: string | null;
    byteSize: number;
    createdAt: string;
  } | null>;
  rollback(versionId: number, currentContent: string, projectId: string, fileName: string): Promise<{
    rollbackContent: string;
    savedCurrentVersionId: number;
  }>;
  updateLabel(projectId: string, versionId: number, label: string | null): Promise<void>;
  delete(projectId: string, versionId: number): Promise<void>;
}

declare global {
  interface Window {
    scriptHistoryAPI: ScriptHistoryAPI;
  }
}

// 引入 AgentAPI 类型声明
import './agent-api';

// ─── PublishAPI ───────────────────────────────────────────

export interface PublishProgressPayload {
  jobId: string;
  accountId: string;
  state: string;
  percent?: number;
  message?: string;
}

/** 发布封面比例键（封面工作台按真实像素归类到这三种）。 */
export type PublishCoverRatio = '16:9' | '4:3' | '3:4';
/** 按比例提供的多张封面；各平台按需取用（视频号 4:3+3:4，抖音 3:4+16:9）。 */
export type PublishCovers = Partial<Record<PublishCoverRatio, string>>;

export interface PublishShared {
  title: string;
  desc: string;
  tags: string[];
  /** 单封面兜底（旧字段 / 仅取一张的平台）。 */
  thumbnail?: string;
  /** 多比例封面，优先于 thumbnail。 */
  covers?: PublishCovers;
  scheduleAt?: number;
}

export interface PublishTarget {
  accountId: string;
  overrides?: { title?: string; desc?: string; tags?: string[] };
  bilibili?: { tid: number };
}

export interface PublishJobInput {
  id: string;
  filePath: string;
  shared: PublishShared;
  targets: PublishTarget[];
}

/** 发布全局设置（持久化于 userData/publish/settings.json）。 */
export interface PublishSettings {
  /** 登录是否使用无头浏览器，默认 true。 */
  headlessLogin: boolean;
}

export interface PublishAPI {
  listAccounts(): Promise<PublishAccount[]>;
  deleteAccount(id: string): Promise<void>;
  login(
    platform: PublishPlatform,
    accountName: string,
    headless?: boolean,
  ): Promise<{ success: boolean; message: string }>;
  check(id: string): Promise<boolean>;
  getSettings(): Promise<PublishSettings>;
  setSettings(patch: Partial<PublishSettings>): Promise<PublishSettings>;
  run(job: PublishJobInput, headless?: boolean): Promise<void>;
  cancel(): Promise<void>;
  onQrcode(cb: (p: { platform: string; accountName: string; png: string }) => void): () => void;
  onProgress(cb: (payload: PublishProgressPayload) => void): () => void;
  /** 查询 B 站 biliup 二进制是否已安装到用户目录。 */
  getBiliupStatus(): Promise<DependencyStatus>;
  /** 下载并安装 biliup 到用户目录；过程经 onBiliupDownloadProgress 回报。 */
  downloadBiliup(): Promise<DependencyDownloadResult>;
  cancelBiliupDownload(): Promise<void>;
  onBiliupDownloadProgress(cb: (p: DependencyDownloadProgress) => void): () => void;
  /** 查询 Chromium（playwright 浏览器）是否已安装到用户目录。 */
  getChromiumStatus(): Promise<DependencyStatus>;
  /** 下载并安装 Chromium 到用户目录；过程经 onChromiumDownloadProgress 回报。 */
  downloadChromium(): Promise<DependencyDownloadResult>;
  cancelChromiumDownload(): Promise<void>;
  onChromiumDownloadProgress(cb: (p: DependencyDownloadProgress) => void): () => void;
}

/** 依赖（biliup / chromium）安装状态。 */
export interface DependencyStatus {
  installed: boolean;
  path: string;
  /** 可执行文件完整路径（chromium 提供）。 */
  executablePath?: string;
}

/** 依赖下载结果。 */
export interface DependencyDownloadResult {
  success: boolean;
  path?: string;
  error?: string;
}

/** 依赖下载进度。biliup 走 received/total/speed 字节型；chromium 走 percent 百分比型。 */
export interface DependencyDownloadProgress {
  phase: 'resolve' | 'download' | 'extract' | 'install' | string;
  percent?: number;
  received?: number;
  total?: number;
  speed?: number;
}

/** @deprecated 改用 DependencyStatus。 */
export type BiliupStatus = DependencyStatus;
/** @deprecated 改用 DependencyStatus。 */
export type ChromiumStatus = DependencyStatus;
/** @deprecated 改用 DependencyDownloadResult。 */
export type BiliupDownloadResult = DependencyDownloadResult;
/** @deprecated 改用 DependencyDownloadResult。 */
export type ChromiumDownloadResult = DependencyDownloadResult;
/** @deprecated 改用 DependencyDownloadProgress。 */
export type BiliupDownloadProgress = DependencyDownloadProgress;
/** @deprecated 改用 DependencyDownloadProgress。 */
export type ChromiumDownloadProgress = DependencyDownloadProgress;

declare global {
  interface Window {
    publishAPI: PublishAPI;
  }
}

export {};
