import chokidar from 'chokidar';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, shell } from 'electron';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { FSWatcher } from 'chokidar';
import type { MenuContext, MenuEvent, ProjectMetadata } from '../src/lib/electron-api';
import { addAppLog, configureAppLogger, getAppLogFilePath, getAppLogs } from './app-logger';
import { setAgentFeedSender } from './pipeline/agent-feed';
import { parseSrt } from '../src/lib/srt-parser';
import { createApplicationMenuTemplate } from './app-menu';
import {
  loadRuntimeDebugConfigSync,
  resolveAppConfig,
  saveRuntimeDebugConfig,
  type ResolvedAppConfig,
} from './app-config';
import { toRendererConsoleLog } from './console-message';
import { resolveDebugRuntimeState, shouldAutoOpenDevTools } from './debug-runtime';
import { readAudioDurationMs } from './media-duration';
import {
  resolveFfmpegPath,
  resolveFfprobePath,
  resolveGsapPath,
} from './runtime-binaries';
import { compileCards } from './remotion/compile-card-node';
import { renderVideoHeadless, type RenderVideoArgs } from './remotion/render-video-headless';
import { registerAgentIpc } from './acp/ipc';
import { registerConversationIpc } from './conversations/ipc';
import { registerScriptHistoryIpc } from './script-history/ipc';
import { registerPublishIpc } from './publish/ipc';
import { configureBiliupRoot } from './publish/biliup-runtime';
import { getBiliupDestRoot } from './publish/biliup-install';
import { LockMonitor } from './ai-edit/lock-watcher';
import { configureAiEditLockBroadcaster, applyObservedAiEditLock } from './ai-edit/session-lock';
import { validateTimeline, type EditError } from '../src/lib/external-edit-validate';
import { buildEditResult, writeEditResult } from './ai-edit/result-writer';
import { consumeSelfWrite } from './ai-edit/self-write-guard';
import {
  appendAutoRunEvent,
  getAutoRunLogDir,
  getLatestRunId,
  listRecentRuns,
  readRunEvents,
  type AutoRunEvent,
} from './telemetry/auto-run-logger';
import { makeMainTelemetry } from './telemetry/main-telemetry';
import { startControlServer, stopControlServer, getSonarInboxStore, getSonarBridgeInfo } from './control/server';
import { loadProjectFile, saveProjectSection } from './project-file';
import type { ProjectSection } from '../src/lib/project-persistence';
import { materializePreviewMotionCardDataUris } from './remotion/motion-card-assets';
import {
  scanProjectDirectory,
  importProject,
  ImportProjectError,
} from './project-import';
import type { ImportProjectArgs } from '../src/lib/project-import-types';
import { saveCoverEdit } from './cover-editor-io';
import { listSystemFonts } from './system-fonts';
import {
  loadGlobalSettings,
  loadGlobalSettingsSync,
  saveGlobalSettings,
  type GlobalSettingsFile,
} from './global-settings';
import { resolveWindowCloseAction } from './window-close';
import {
  collectBackup,
  validateBackup,
  backupCurrent,
  applyBackup,
  defaultExportFileName,
  ConfigBackupValidationError,
} from './config-backup';
import { migrateLegacyScriptTemplates } from './user-prompts-io';
import { registerAiGenerationIpc } from './ai-generation-ipc';
import { registerTtsIpc } from './tts-ipc';
import { registerPromptsIpc } from './prompts-ipc';
import { registerFileDialogsIpc } from './file-dialogs-ipc';
import { registerRecentProjectsIpc } from './recent-projects-ipc';
import { getVideoImportService } from './video-import/import-service';
import { resolveDouyinVideoSource } from './video-import/douyin-downloader';
import type { VideoImportRequest } from '../src/lib/video-import-types';
import { createWorkbenchTabContextMenuTemplate } from './workbench-tab-context-menu';
import { getWindowChromeOptions } from './window-chrome';
import { getPipelineService, attachTaskProgressBridge } from './pipeline';
import { runSculptCard } from './pipeline/runs/card-run';
import { setActiveProjectPath } from './pipeline/context';
import { lingjiLogin, lingjiLogout, lingjiRefreshConfig, loadAccount } from './lingji-account';

const execFileAsync = promisify(execFile);

const AGENT_CONFIG_PATH = path.join(os.homedir(), '.lingji', 'agent-config.json');

function resolveAppIconPath(): string | null {
  const candidates = [
    path.join(__dirname, '../build/icon.png'),
    path.resolve(app.getAppPath(), 'build/icon.png'),
    path.resolve(process.cwd(), 'build/icon.png'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

let mainWindow: BrowserWindow | null = null;
let menuContext: MenuContext = {
  activePage: 'welcome',
  hasProject: false,
  recentProjects: [],
  isAutoRunning: false,
  isAiEditing: false,
};
let fileWatcher: FSWatcher | null = null;
let lockPollTimer: ReturnType<typeof setInterval> | null = null;
let isAppQuitting = false;
const videoImportService = getVideoImportService();
let appConfig: ResolvedAppConfig | null = null;

function sendMenuEvent(event: MenuEvent) {
  mainWindow?.webContents.send('menu-action', event);
}

function writeAppLog(level: 'info' | 'warn' | 'error', scope: string, message: string, details?: string) {
  const entry = addAppLog(level, scope, message, details);
  if (entry) {
    mainWindow?.webContents.send('app-log', entry);
  }
}

function getCurrentAppConfig(): ResolvedAppConfig {
  if (appConfig) {
    return appConfig;
  }

  appConfig = resolveAppConfig({
    userDataPath: app.getPath('userData'),
    env: {
      MAIN_VITE_DEBUG_MODE: import.meta.env.MAIN_VITE_DEBUG_MODE,
      MAIN_VITE_LOG_LEVEL: import.meta.env.MAIN_VITE_LOG_LEVEL,
    },
  });
  return appConfig;
}

function refreshAppConfig(): ResolvedAppConfig {
  const nextConfig = resolveAppConfig({
    userDataPath: app.getPath('userData'),
    env: {
      MAIN_VITE_DEBUG_MODE: import.meta.env.MAIN_VITE_DEBUG_MODE,
      MAIN_VITE_LOG_LEVEL: import.meta.env.MAIN_VITE_LOG_LEVEL,
    },
    runtimeConfig: loadRuntimeDebugConfigSync(app.getPath('userData')),
  });
  appConfig = nextConfig;
  configureAppLogger({
    logDirPath: nextConfig.logDirPath,
    logLevel: nextConfig.logLevel,
  });
  return nextConfig;
}

async function openLogDirectory(): Promise<void> {
  const currentConfig = getCurrentAppConfig();
  await fs.mkdir(currentConfig.logDirPath, { recursive: true });
  const result = await shell.openPath(currentConfig.logDirPath);
  if (result) {
    writeAppLog('warn', 'log', '打开日志目录失败', result);
  }
}

async function exportLogsArchive(): Promise<void> {
  const currentConfig = getCurrentAppConfig();
  await fs.mkdir(currentConfig.logDirPath, { recursive: true });

  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, {
        title: '导出日志 ZIP',
        defaultPath: path.join(currentConfig.logDirPath, `video-web-master-logs-${Date.now()}.zip`),
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      })
    : await dialog.showSaveDialog({
        title: '导出日志 ZIP',
        defaultPath: path.join(currentConfig.logDirPath, `video-web-master-logs-${Date.now()}.zip`),
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      });

  if (result.canceled || !result.filePath) {
    return;
  }

  const files = (await fs.readdir(currentConfig.logDirPath))
    .filter((fileName) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(fileName))
    .sort();

  if (files.length === 0) {
    await fs.writeFile(result.filePath, '');
    writeAppLog('warn', 'log', '日志目录为空，已导出空归档', result.filePath);
    return;
  }

  const tmpZipDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-web-master-log-export-'));
  try {
    await Promise.all(
      files.map(async (fileName) => {
        await fs.copyFile(
          path.join(currentConfig.logDirPath, fileName),
          path.join(tmpZipDir, fileName),
        );
      }),
    );
    await execFileAsync('zip', ['-r', result.filePath, '.'], {
      cwd: tmpZipDir,
    });
    writeAppLog('info', 'log', '日志归档已导出', result.filePath);
  } finally {
    await fs.rm(tmpZipDir, { recursive: true, force: true });
  }
}

async function toggleRuntimeDebugMode(): Promise<void> {
  const userDataPath = app.getPath('userData');
  const currentRuntimeConfig = loadRuntimeDebugConfigSync(userDataPath);
  const currentConfig = getCurrentAppConfig();
  const nextDebugMode = !(currentRuntimeConfig?.debugMode ?? currentConfig.debugMode);

  await saveRuntimeDebugConfig(userDataPath, {
    debugMode: nextDebugMode,
    logLevel: currentRuntimeConfig?.logLevel ?? currentConfig.logLevel,
  });

  const nextConfig = refreshAppConfig();
  refreshApplicationMenu();

  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, {
        type: 'info',
        buttons: ['稍后手动重启', '立即重启'],
        defaultId: 1,
        cancelId: 0,
        title: '调试模式已更新',
        message: nextDebugMode ? '调试模式已启用。' : '调试模式已关闭。',
        detail: `新的配置会在应用重启后生效。\n日志级别：${nextConfig.logLevel}\n日志文件：${nextConfig.logFilePath}`,
      })
    : await dialog.showMessageBox({
        type: 'info',
        buttons: ['稍后手动重启', '立即重启'],
        defaultId: 1,
        cancelId: 0,
        title: '调试模式已更新',
        message: nextDebugMode ? '调试模式已启用。' : '调试模式已关闭。',
        detail: `新的配置会在应用重启后生效。\n日志级别：${nextConfig.logLevel}\n日志文件：${nextConfig.logFilePath}`,
      });

  if (response === 1) {
    app.relaunch();
    app.quit();
  }
}

function createApplicationMenu() {
  const currentConfig = getCurrentAppConfig();
  const runtimeState = resolveDebugRuntimeState({
    isPackaged: app.isPackaged,
    debugMode: currentConfig.debugMode,
  });
  return Menu.buildFromTemplate(
    createApplicationMenuTemplate(sendMenuEvent, {
      ...menuContext,
      isDevelopment: runtimeState.isDevelopment,
      debugMode: currentConfig.debugMode,
    }, {
      onToggleDebugMode: () => {
        void toggleRuntimeDebugMode();
      },
      onOpenLogDirectory: () => {
        void openLogDirectory();
      },
      onExportLogs: () => {
        void exportLogsArchive();
      },
      onShowAbout: () => {
        void showAboutDialog();
      },
    }),
  );
}

async function showAboutDialog() {
  const wechatId = 'yoqu2020';
  const detail = [
    `版本 ${app.getVersion()}`,
    '',
    '本地优先的口播 / 播客视频创作工具，从素材、文稿、语音、字幕到导出 MP4 一站式完成。',
    '',
    `作者微信：${wechatId}`,
    `微信群：加作者微信，备注「入群」即可加入交流群`,
  ].join('\n');

  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: '关于灵机剪影',
    message: '灵机剪影',
    detail,
    buttons: ['复制微信号', '确定'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };

  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);

  if (response === 0) {
    clipboard.writeText(wechatId);
  }
}

function refreshApplicationMenu() {
  Menu.setApplicationMenu(createApplicationMenu());
}

function resolveRuntimeBinaries() {
  const options = {
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    cwd: process.cwd(),
    moduleDir: __dirname,
    existsSync,
  };
  return {
    ffmpegPath: resolveFfmpegPath(options),
    ffprobePath: resolveFfprobePath(options),
    gsapPath: resolveGsapPath(options),
  };
}

function createWindow() {
  const currentConfig = getCurrentAppConfig();
  const runtimeState = resolveDebugRuntimeState({
    isPackaged: app.isPackaged,
    debugMode: currentConfig.debugMode,
  });
  const appIconPath = resolveAppIconPath();
  const windowChromeOptions = getWindowChromeOptions(process.platform);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 760,
    backgroundColor: '#070b14',
    title: '灵机剪影',
    ...(appIconPath ? { icon: appIconPath } : {}),
    ...windowChromeOptions,
    webPreferences: {
      devTools: runtimeState.allowDevTools,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false, // 允许 file:// 加载本地媒体
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.on('console-message', (details) => {
    const logEntry = toRendererConsoleLog(details);
    writeAppLog(logEntry.level, logEntry.scope, logEntry.message, logEntry.details);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    writeAppLog('error', 'window', `页面加载失败（${errorCode}）`, errorDescription);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeAppLog('error', 'window', `渲染进程退出：${details.reason}`, String(details.exitCode));
  });

  mainWindow.on('close', (event) => {
    const action = resolveWindowCloseAction({
      hasProject: menuContext.hasProject,
      isAppQuitting,
    });

    if (action !== 'close-project') {
      return;
    }

    event.preventDefault();
    sendMenuEvent({
      type: 'command',
      action: 'close-project',
    });
  });

  // 确保标题设置正确
  mainWindow.setTitle('灵机剪影');
  configureAiEditLockBroadcaster(() => mainWindow);

  if (shouldAutoOpenDevTools({ isPackaged: app.isPackaged, debugMode: currentConfig.debugMode })) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  refreshApplicationMenu();
  writeAppLog('info', 'app', '主窗口已创建');
}


async function getDirectorySizeBytes(directoryPath: string): Promise<number> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directoryPath, entry.name);

      if (entry.isSymbolicLink()) {
        return 0;
      }

      if (entry.isDirectory()) {
        return getDirectorySizeBytes(entryPath);
      }

      if (entry.isFile()) {
        const stats = await fs.stat(entryPath);
        return stats.size;
      }

      return 0;
    }),
  );

  return sizes.reduce((total, size) => total + size, 0);
}

async function readProjectMetadata(projectDir: string): Promise<ProjectMetadata> {
  const stats = await fs.stat(projectDir);
  const createdAtMs = Math.round(stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs || Date.now());
  const sizeBytes = await getDirectorySizeBytes(projectDir);

  return {
    projectDir,
    sizeBytes,
    createdAtMs,
  };
}

// 系统通知：后台/长耗时任务完成时提醒用户回到软件（点击聚焦主窗口）
ipcMain.on('system-notification:show', (_event, payload: { title: string; body: string }) => {
  if (!Notification.isSupported() || !payload?.title) return;
  const iconPath = resolveAppIconPath();
  const notification = new Notification({
    title: payload.title,
    body: payload.body ?? '',
    ...(iconPath ? { icon: iconPath } : {}),
  });
  notification.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  notification.show();
});

ipcMain.handle('parse-srt-file', async (_event, filePath: string) => {
  const content = await fs.readFile(filePath, 'utf-8');
  const entries = parseSrt(content);
  const durationMs = entries.length > 0 ? entries[entries.length - 1].endMs : 0;

  return { entries, durationMs };
});

ipcMain.handle('get-audio-duration', async (_event, filePath: string) => {
  return readAudioDurationMs(filePath, { ffprobePath: resolveRuntimeBinaries().ffprobePath });
});

ipcMain.handle(
  'remotion:compile-cards',
  async (
    _event,
    args:
      | { cards: { overlayId: string; tsx: string }[]; projectDir?: string | null }
      | { overlayId: string; tsx: string }[],
  ) => {
    const payload = Array.isArray(args) ? { cards: args, projectDir: null } : args;
    const cards = payload.cards;
    if (!Array.isArray(cards) || cards.length === 0) return {};
    const projectDir = payload.projectDir?.trim() ? payload.projectDir : null;
    const normalizedCards = projectDir
      ? await Promise.all(
          cards.map(async (card) => ({
            ...card,
            tsx: await materializePreviewMotionCardDataUris(card.tsx, {
              projectDir,
              overlayId: card.overlayId,
            }),
          })),
        )
      : cards;
    return compileCards(normalizedCards, {
      onCompileErrors: (errors, total) => {
        const firstError = errors[0];
        writeAppLog(
          'warn',
          'motion-card',
          `预览编译失败 ${errors.length}/${total}，首个失败卡片=${firstError?.overlayId ?? '<unknown>'}`,
          firstError?.error,
        );
      },
    });
  },
);

ipcMain.handle('get-file-mtime', async (_event, filePath: string) => {
  if (!filePath) return null;
  try {
    const stat = await fs.stat(filePath);
    return Math.round(stat.mtimeMs);
  } catch {
    return null;
  }
});

// ─────────────────────────────────────────────────────────────
// 一键成稿 / AI 流水线观测日志：renderer 写事件 + 读取近期运行
// 日志落盘 <userData>/logs/auto-run/<runId>.jsonl
// ─────────────────────────────────────────────────────────────
ipcMain.handle(
  'auto-run-telemetry/append',
  async (_event, event: AutoRunEvent) => {
    if (!event || typeof event.runId !== 'string' || typeof event.kind !== 'string') {
      return;
    }
    // ts 缺省补当前时间，方便 renderer 端少写一个字段
    const normalized: AutoRunEvent = {
      ...event,
      ts: typeof event.ts === 'number' && Number.isFinite(event.ts) ? event.ts : Date.now(),
    };
    await appendAutoRunEvent(normalized);
  },
);

ipcMain.handle('auto-run-telemetry/list-recent', async (_event, limit?: number) => {
  return listRecentRuns(typeof limit === 'number' ? limit : 20);
});

ipcMain.handle('auto-run-telemetry/read-run', async (_event, runId: string) => {
  return readRunEvents(runId);
});

ipcMain.handle('auto-run-telemetry/get-latest', async () => {
  const runId = await getLatestRunId();
  if (!runId) return null;
  return { runId, events: await readRunEvents(runId) };
});

ipcMain.handle('auto-run-telemetry/get-log-dir', async () => getAutoRunLogDir());

registerAiGenerationIpc({
  getMainWindow: () => mainWindow,
  writeAppLog,
});

ipcMain.handle('load-project', async (_event, projectDir: string) => {
  const data = await loadProjectFile(projectDir);
  setActiveProjectPath(projectDir);
  return JSON.stringify(data, null, 2);
});

ipcMain.handle(
  'save-project-section',
  async (_event, projectDir: string, section: string, data: string) => {
    const parsed = JSON.parse(data);
    await saveProjectSection(
      projectDir,
      section as ProjectSection,
      parsed,
    );
  },
);

ipcMain.handle('scan-project-directory', async (_event, projectDir: string) => {
  return scanProjectDirectory(projectDir);
});

ipcMain.handle('import-project', async (_event, args: ImportProjectArgs) => {
  try {
    const result = await importProject(args);
    return { ok: true as const, result };
  } catch (err) {
    if (err instanceof ImportProjectError) {
      return {
        ok: false as const,
        error: { code: err.code, message: err.message },
      };
    }
    return {
      ok: false as const,
      error: { code: 'scan_failed' as const, message: (err as Error).message },
    };
  }
});

ipcMain.handle('load-global-settings', async () => {
  const userDataPath = app.getPath('userData');
  const settings = await loadGlobalSettings(userDataPath);
  return settings ? JSON.stringify(settings) : null;
});

ipcMain.on('load-global-settings-sync', (event) => {
  const userDataPath = app.getPath('userData');
  const settings = loadGlobalSettingsSync(userDataPath);
  event.returnValue = settings ? JSON.stringify(settings) : null;
});

ipcMain.handle('save-global-settings', async (_event, data: string) => {
  const userDataPath = app.getPath('userData');
  const settings = JSON.parse(data) as GlobalSettingsFile;
  await saveGlobalSettings(userDataPath, settings);
});

ipcMain.handle('config-backup:export', async () => {
  const userDataPath = app.getPath('userData');
  const appVersion = app.getVersion();
  const backup = await collectBackup(userDataPath, AGENT_CONFIG_PATH, appVersion);

  const options: Electron.SaveDialogOptions = {
    title: '导出配置备份',
    defaultPath: defaultExportFileName(),
    filters: [{ name: '灵机配置备份', extensions: ['lingji-backup.json', 'json'] }],
  };
  // dialog 接受 null 作为"无父窗口"；单次调用替代 mainWindow 存在与否的双分支。
  const result = await dialog.showSaveDialog(mainWindow as BrowserWindow, options);
  if (result.canceled || !result.filePath) {
    return { canceled: true as const };
  }

  await fs.writeFile(result.filePath, JSON.stringify(backup, null, 2), 'utf-8');
  return { canceled: false as const, filePath: result.filePath };
});

ipcMain.handle('config-backup:preview', async () => {
  const options: Electron.OpenDialogOptions = {
    title: '选择配置备份文件',
    filters: [{ name: '灵机配置备份', extensions: ['lingji-backup.json', 'json'] }],
    properties: ['openFile'],
  };
  // dialog 接受 null 作为"无父窗口"；单次调用替代 mainWindow 存在与否的双分支。
  const result = await dialog.showOpenDialog(mainWindow as BrowserWindow, options);
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true as const };
  }

  const filePath = result.filePaths[0];
  const raw = await fs.readFile(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigBackupValidationError('备份文件不是合法的 JSON');
  }
  const backup = validateBackup(parsed);
  return {
    canceled: false as const,
    filePath,
    schemaVersion: backup.schemaVersion,
    exportedAt: backup.exportedAt,
    appVersion: backup.appVersion,
    platform: backup.platform,
  };
});

ipcMain.handle(
  'config-backup:import',
  async (_event, args: { filePath: string }) => {
    const { filePath } = args;
    const raw = await fs.readFile(filePath, 'utf-8');
    const backup = validateBackup(JSON.parse(raw));

    const userDataPath = app.getPath('userData');
    const { settingsBackupPath, agentBackupPath } = await backupCurrent(
      userDataPath,
      AGENT_CONFIG_PATH,
    );
    await applyBackup(backup, userDataPath, AGENT_CONFIG_PATH);

    return {
      appliedFrom: filePath,
      settingsBackupPath,
      agentBackupPath,
    };
  },
);

registerPromptsIpc();

ipcMain.handle('get-project-metadata', async (_event, projectDir: string) => {
  return readProjectMetadata(projectDir);
});

ipcMain.handle('set-menu-context', async (_event, context: MenuContext) => {
  menuContext = {
    activePage: context.activePage,
    hasProject: context.hasProject,
    recentProjects: Array.isArray(context.recentProjects)
      ? context.recentProjects
          .filter((project) => Boolean(project?.path))
          .map((project) => ({
            path: project.path,
            name: project.name || path.basename(project.path),
          }))
      : [],
    isAutoRunning: Boolean(context.isAutoRunning),
    isAiEditing: Boolean(context.isAiEditing),
  };

  refreshApplicationMenu();
});

ipcMain.handle('show-editor-context-menu', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const menu = Menu.buildFromTemplate([
    { label: '剪切', role: 'cut' },
    { label: '复制', role: 'copy' },
    { label: '粘贴', role: 'paste' },
    { type: 'separator' },
    { label: '全选', role: 'selectAll' },
    { type: 'separator' },
    {
      label: '搜索',
      accelerator: 'CmdOrCtrl+F',
      click: () =>
        event.sender.send('menu-action', { type: 'command', action: 'find' }),
    },
    {
      label: '搜索与替换',
      accelerator: 'CmdOrCtrl+H',
      click: () =>
        event.sender.send('menu-action', { type: 'command', action: 'find-replace' }),
    },
  ]);
  menu.popup({ window: win });
});

ipcMain.handle(
  'show-workbench-tab-context-menu',
  async (
    event,
    request: {
      file: string;
      projectDir: string | null;
      tabIndex: number;
      tabCount: number;
    },
  ) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;

    const absolutePath = request.projectDir
      ? path.resolve(request.projectDir, request.file)
      : null;

    const menu = Menu.buildFromTemplate(
      createWorkbenchTabContextMenuTemplate({
        file: request.file,
        tabIndex: request.tabIndex,
        tabCount: request.tabCount,
        hasResolvedPath: Boolean(absolutePath),
        onMenuAction: (action, file) => {
          win.webContents.send('workbench-tab-menu-action', { action, file });
        },
        onCopyPath: () => {
          if (absolutePath) {
            clipboard.writeText(absolutePath);
          }
        },
        onRevealInFileManager: () => {
          if (absolutePath) {
            shell.showItemInFolder(absolutePath);
          }
        },
      }),
    );

    menu.popup({ window: win });
  },
);

registerFileDialogsIpc({
  getMainWindow: () => mainWindow,
  writeAppLog,
  resolveRuntimeBinaries,
});

ipcMain.handle(
  'save-script-file',
  async (_event, projectDir: string, filename: string, content: string) => {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, filename), content, 'utf-8');
  },
);

ipcMain.handle(
  'load-script-file',
  async (_event, projectDir: string, filename: string) => {
    const filePath = path.join(projectDir, filename);
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  },
);

// —— 声呐「待创作箱」桥（扩展经 /sonar/enqueue 推入，欢迎页消费）——
ipcMain.handle('sonar-inbox-list', async () => {
  const store = getSonarInboxStore();
  return store ? store.list() : [];
});

ipcMain.handle(
  'sonar-inbox-mark-status',
  async (
    _event,
    id: string,
    status: 'pending' | 'creating' | 'drafted' | 'failed',
    patch?: { projectPath?: string; error?: string },
  ) => {
    const store = getSonarInboxStore();
    return store ? store.markStatus(id, status, patch) : null;
  },
);

ipcMain.handle('sonar-inbox-remove', async (_event, id: string) => {
  const store = getSonarInboxStore();
  return store ? store.remove(id) : false;
});

ipcMain.handle('sonar-inbox-clear', async () => {
  const store = getSonarInboxStore();
  return store ? store.clear() : 0;
});

ipcMain.handle('sonar-bridge-info', async () => getSonarBridgeInfo());

// 轻量级抖音链接解析：仅获取标题和视频 ID，不下载视频
ipcMain.handle('resolve-douyin-url', async (_event, url: string) => {
  writeAppLog('info', 'douyin-resolve', '解析抖音链接', url);
  const result = await resolveDouyinVideoSource(url);
  return { title: result.title, videoId: result.videoId };
});

ipcMain.handle('import-video-source', async (_event, request: VideoImportRequest) => {
  writeAppLog(
    'info',
    'video-import',
    '收到视频导入请求',
    `${request.sourceType}: ${request.sourceType === 'douyin' ? request.url : request.filePath}`,
  );
  return videoImportService.startImport(request);
});

ipcMain.handle('get-video-import-status', async (_event, importId: string) => {
  return videoImportService.getImportStatus(importId);
});

// 渲染端取消 MCP/pipeline 任务（底部进度条的取消按钮）。进度推送走
// attachTaskProgressBridge 的 `pipeline:task-update`；取消走这条反向通道。
ipcMain.handle('pipeline:cancel-task', async (_event, taskId: string) => {
  await getPipelineService().cancelTask(taskId);
});

// 精雕 motion 卡（多 agent 导演→雕刻→审查）：fire-and-forget，进度经
// pipeline:task-update 桥到底部任务条，完成经 pipeline:project-updated 刷新卡片。
ipcMain.handle(
  'pipeline:sculpt-card',
  async (_event, args: { projectPath: string; cardId: string; notes?: string }) => {
    const userDataPath = app.getPath('userData');
    const { taskId } = await getPipelineService().createTask(
      'sculpt_card',
      args.projectPath,
      async (handle) => {
        const result = await runSculptCard({
          projectPath: args.projectPath,
          userDataPath,
          handle,
          params: { cardId: args.cardId, notes: args.notes },
        });
        mainWindow?.webContents.send('pipeline:project-updated', {
          projectPath: args.projectPath,
          sections: ['aiAnalysis'],
        });
        return result;
      },
    );
    return { taskId };
  },
);

ipcMain.handle('start-watching', async (_event, dir: string) => {
  await fileWatcher?.close();

  fileWatcher = chokidar.watch(dir, {
    depth: 3,
    ignoreInitial: true,
    ignored: /(^|[/\\])\../,
  });

  fileWatcher.on('change', async (filePath: string) => {
    const relative = path.relative(dir, filePath);
    if (!relative.endsWith('.md') && !relative.endsWith('.json') && !relative.endsWith('.tsx')) return;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      // 自写抑制：若内容与主进程最近一次自写完全相同，判为自身回声，
      // 跳过校验与转发，打断 autosave↔watch 回环（不会误伤真实外部编辑——内容不同）。
      if (consumeSelfWrite(path.resolve(filePath), content)) return;
      if (relative === 'project.json') {
        let errors: EditError[] = [];
        try {
          const parsed = JSON.parse(content);
          errors = parsed?.timeline ? validateTimeline(parsed.timeline) : [];
        } catch (e) {
          errors = [{ field: 'project.json', message: `非法 JSON: ${(e as Error).message}` }];
        }
        await writeEditResult(dir, buildEditResult(errors, new Date().toISOString()));
        if (errors.length > 0) return; // 脏数据不灌回 Renderer
      }
      mainWindow?.webContents.send('file-changed', { file: relative, content });
    } catch {
      // 文件可能已被删除，直接忽略。
    }
  });

  fileWatcher.on('add', (filePath: string) => {
    const relative = path.relative(dir, filePath);
    mainWindow?.webContents.send('file-tree-changed', { type: 'add', file: relative });
  });

  fileWatcher.on('unlink', (filePath: string) => {
    const relative = path.relative(dir, filePath);
    mainWindow?.webContents.send('file-tree-changed', { type: 'unlink', file: relative });
  });

  // AI 编辑会话锁轮询（chokidar 默认忽略点目录，这里用独立定时器轮询 .lingji/edit-lock.json）
  if (lockPollTimer) clearInterval(lockPollTimer);
  const lockMon = new LockMonitor({
    readLock: async () => {
      try {
        return await fs.readFile(path.join(dir, '.lingji', 'edit-lock.json'), 'utf-8');
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
    onChange: (change) => {
      applyObservedAiEditLock(change.lock ? { ...change.lock, projectPath: dir } : null);
    },
  });
  lockPollTimer = setInterval(() => { void lockMon.poll(); }, 500);
  void lockMon.poll();
});

ipcMain.handle('stop-watching', async () => {
  await fileWatcher?.close();
  fileWatcher = null;
  if (lockPollTimer) { clearInterval(lockPollTimer); lockPollTimer = null; }
});

ipcMain.handle('read-directory', async (_event, dir: string) => {
  interface DirectoryEntry {
    name: string;
    type: 'file' | 'directory';
    children?: DirectoryEntry[];
  }

  async function readDir(dirPath: string, currentDepth: number): Promise<DirectoryEntry[]> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const result: DirectoryEntry[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      if (entry.isDirectory() && currentDepth < 3) {
        const children = await readDir(path.join(dirPath, entry.name), currentDepth + 1);
        result.push({ name: entry.name, type: 'directory', children });
        continue;
      }

      if (entry.isFile()) {
        result.push({ name: entry.name, type: 'file' });
      }
    }

    return result.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }

      return a.name.localeCompare(b.name);
    });
  }

  return readDir(dir, 0);
});

registerTtsIpc({
  getMainWindow: () => mainWindow,
  writeAppLog,
  resolveRuntimeBinaries,
});

ipcMain.handle('get-app-logs', () => getAppLogs());

ipcMain.handle('get-app-log-file-path', () => getAppLogFilePath());

ipcMain.handle('toggle-devtools', () => {
  if (!mainWindow) {
    return;
  }

  const currentConfig = getCurrentAppConfig();
  const runtimeState = resolveDebugRuntimeState({
    isPackaged: app.isPackaged,
    debugMode: currentConfig.debugMode,
  });
  if (!runtimeState.allowDevTools) {
    writeAppLog('warn', 'security', '已拦截生产环境 DevTools 打开请求');
    return;
  }

  mainWindow.webContents.toggleDevTools();
});

ipcMain.on('show-item-in-folder', (_event, filePath: string) => {
  shell.showItemInFolder(filePath);
});

ipcMain.on('open-external', (_event, url: string) => {
  shell.openExternal(url);
});

ipcMain.handle('open-path', async (_event, filePath: string): Promise<{ ok: boolean; error?: string }> => {
  try {
    const error = await shell.openPath(filePath);
    if (error) return { ok: false, error };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('quick-look-file', async (_event, filePath: string): Promise<{ ok: boolean; error?: string }> => {
  if (process.platform === 'darwin') {
    try {
      // qlmanage -p 调出 macOS 原生快速预览；detached + unref 不阻塞主进程。
      const child = spawn('qlmanage', ['-p', filePath], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  // 非 macOS 降级为默认 App 打开。
  const error = await shell.openPath(filePath);
  return error ? { ok: false, error } : { ok: true };
});

registerRecentProjectsIpc({
  getMenuContext: () => menuContext,
  refreshApplicationMenu,
});

ipcMain.handle('render-video', async (_event, args: RenderVideoArgs & { telemetryRunId?: string }) => {
  // 与 tts/cover/analyze 一样接 auto-run jsonl：renderer 可选传 telemetryRunId，
  // 在主进程发 run.start / stage.* / run.end，方便后续"导出慢"诊断时直接读 jsonl 找瓶颈。
  const tel = makeMainTelemetry(args.telemetryRunId);
  const startedAt = Date.now();
  tel.emit('run.start', {
    stage: 'export',
    resolution: args.exportConfig?.resolution,
    quality: args.exportConfig?.quality,
  });
  try {
    const result = await renderVideoHeadless(args, {
      onProgress: (f) => mainWindow?.webContents.send('render-progress', f),
      onMotionCardCompileErrors: (errors, total) => {
        const firstError = errors[0];
        writeAppLog(
          'warn',
          'motion-card',
          `导出编译失败 ${errors.length}/${total}，首个失败卡片=${firstError?.overlayId ?? '<unknown>'}`,
          firstError?.error,
        );
      },
      telemetry: tel,
    });
    tel.emit('run.end', { stage: 'export', durationMs: Date.now() - startedAt, ok: true });
    return result;
  } catch (err) {
    tel.emit('run.end', {
      stage: 'export',
      durationMs: Date.now() - startedAt,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
});

ipcMain.handle('save-cover-edit', async (_event, args) => {
  return saveCoverEdit(args);
});

ipcMain.handle('list-system-fonts', async () => {
  return listSystemFonts();
});

// 灵机剪影账户：浏览器授权登录 / 退出 / 读缓存账户（服务器基址烘焙进包，渲染层不可见改）
ipcMain.handle('lingji-login', async () => lingjiLogin());
ipcMain.handle('lingji-logout', async () => lingjiLogout());
ipcMain.handle('lingji-get-account', async () => loadAccount());
ipcMain.handle('lingji-refresh-config', async () => lingjiRefreshConfig());

// 开发模式下让 Ctrl+C 能正常退出 Electron
if (process.env.NODE_ENV_ELECTRON_VITE === 'development') {
  process.on('SIGINT', () => app.quit());
  process.on('SIGTERM', () => app.quit());
}

registerAgentIpc(() => mainWindow);
registerConversationIpc(() => mainWindow);
registerScriptHistoryIpc();
registerPublishIpc();

// 设置 macOS 系统菜单栏应用名称
app.setName('灵机剪影');

app.whenReady().then(async () => {
  refreshAppConfig();
  // biliup 二进制按需下载到用户可写目录，注入该目录作为解析根
  configureBiliupRoot(getBiliupDestRoot());
  // 开发模式下显式设置 Dock 图标；打包后 macOS 会使用 .app 自带的 icns
  if (process.platform === 'darwin' && !app.isPackaged) {
    const iconPath = resolveAppIconPath();
    if (iconPath && app.dock) {
      try {
        app.dock.setIcon(iconPath);
      } catch (err) {
        writeAppLog('warn', 'app', '设置 Dock 图标失败', String(err));
      }
    }
  }
  // 一次性迁移：把旧 customTemplates 转为 userData/prompts/script-template/*.yaml
  try {
    const userDataPath = app.getPath('userData');
    const migrateResult = await migrateLegacyScriptTemplates({ userDataPath });
    if (!migrateResult.skipped) {
      writeAppLog(
        'info',
        'user-prompts',
        `migrated legacy script templates: ${migrateResult.migrated}`,
      );
    }
  } catch (err) {
    writeAppLog('warn', 'user-prompts', '迁移旧口播模板失败', String(err));
  }
  createWindow();
  // 启动 PipelineService 并桥接任务进度到 renderer
  attachTaskProgressBridge(getPipelineService(), () => mainWindow);
  // agent 观测事件（Motion 卡多 agent 生成过程）→ 渲染端观测面板。
  setAgentFeedSender((channel, payload) => mainWindow?.webContents.send(channel, payload));
  // 在 whenReady 内订阅，避免 electron-vite 开发模式下主模块 HMR 重新执行
  // 时多次叠加监听器；广播只发给 mainWindow，与其他通道（analyze-progress /
  // cover-progress / menu-action / app-log）保持一致。
  videoImportService.onProgress((snapshot) => {
    mainWindow?.webContents.send('video-import-progress', snapshot);
    mainWindow?.webContents.send('douyin-import-progress', snapshot);
  });
  // 启动 MCP Server
  try {
    await startControlServer(19820, () => mainWindow);
  } catch (err) {
    console.error('[MCP] Failed to start server:', err);
  }
});

app.on('before-quit', () => {
  isAppQuitting = true;
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('window-all-closed', async () => {
  fileWatcher?.close();
  await stopControlServer();
  app.quit();
});
