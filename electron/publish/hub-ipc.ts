import { app, ipcMain, type BrowserWindow } from 'electron';
import path from 'node:path';
import type { AISettings, PromptBindingMap } from '../../src/types/ai';
import type { HubJobState } from '../../src/lib/publish/hub-state';
import { loadEffectivePromptTemplate } from '../prompts-io';
import { makeMainTelemetry } from '../telemetry/main-telemetry';
import { resolveFfprobePath } from '../runtime-binaries';
import { runPublishIngestAgent } from '../publish-agent/ingest-run';
import { getPublishStore } from './ipc';
import {
  addHubJob,
  loadHubCatalog,
  loadHubJobState,
  removeHubJob,
  saveHubJobState,
  touchHubJob,
} from './hub-store';

export interface PublishIngestProgress {
  taskId: string;
  workDir: string;
  phase: string;
  percent: number;
  toolName?: string;
}

export interface PublishIngestTracePayload {
  taskId: string;
  workDir: string;
  event: import('../../src/lib/publish/ingest-trace').PublishIngestTraceEvent;
}

export interface StartPublishIngestArgs {
  taskId: string;
  workDir: string;
  settings: AISettings;
  projectBindings?: PromptBindingMap | null;
  telemetryRunId?: string | null;
}

let ingestAbort: AbortController | null = null;
let ingestTaskId: string | null = null;

function emitProgress(win: BrowserWindow | null, payload: PublishIngestProgress): void {
  win?.webContents.send('publish:ingest-progress', payload);
}

function emitTrace(win: BrowserWindow | null, payload: PublishIngestTracePayload): void {
  win?.webContents.send('publish:ingest-event', payload);
}

export function registerPublishHubIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('publish:hub-list', async () => {
    const catalog = await loadHubCatalog(app.getPath('userData'));
    return catalog.jobs;
  });

  ipcMain.handle('publish:hub-add', async (_event, workDir: string) => {
    if (!workDir || typeof workDir !== 'string') throw new Error('缺少工作目录');
    return addHubJob(app.getPath('userData'), workDir);
  });

  ipcMain.handle('publish:hub-remove', async (_event, workDir: string) => {
    if (!workDir || typeof workDir !== 'string') throw new Error('缺少工作目录');
    const catalog = await removeHubJob(app.getPath('userData'), workDir);
    return catalog.jobs;
  });

  ipcMain.handle('publish:hub-load', async (_event, workDir: string) => {
    if (!workDir || typeof workDir !== 'string') throw new Error('缺少工作目录');
    return loadHubJobState(workDir);
  });

  ipcMain.handle('publish:hub-save', async (_event, workDir: string, state: HubJobState) => {
    if (!workDir || typeof workDir !== 'string') throw new Error('缺少工作目录');
    await saveHubJobState(workDir, state);
    return touchHubJob(app.getPath('userData'), workDir, state);
  });

  ipcMain.handle('publish:ingest-start', async (_event, args: StartPublishIngestArgs) => {
    if (!args?.workDir) throw new Error('缺少工作目录');
    ingestAbort?.abort();
    ingestAbort = new AbortController();
    ingestTaskId = args.taskId;
    const userDataPath = app.getPath('userData');
    const existingState = await loadHubJobState(args.workDir);
    const [metadataTemplate, partitionTemplate, coverTemplate] = await Promise.all([
      loadEffectivePromptTemplate('publish.metadata', { userDataPath }),
      loadEffectivePromptTemplate('publish.partition', { userDataPath }),
      loadEffectivePromptTemplate('cover.regeneration', { userDataPath }),
    ]);
    const telemetry = makeMainTelemetry(args.telemetryRunId);
    try {
      const submitted = await runPublishIngestAgent({
        userDataPath,
        workDir: args.workDir,
        resourcesRoot: path.join(app.getAppPath(), 'resources', 'pi-agents'),
        settings: args.settings,
        accounts: getPublishStore().list(),
        existingState,
        metadataTemplate,
        partitionTemplate,
        coverTemplate,
        projectBindings: args.projectBindings,
        ffprobePath: resolveFfprobePath({
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath,
          cwd: process.cwd(),
          moduleDir: __dirname,
        }),
        signal: ingestAbort.signal,
        telemetry,
        persistDraft: async (state) => {
          await saveHubJobState(args.workDir, state);
          await touchHubJob(userDataPath, args.workDir, state);
        },
        onProgress: (phase, percent, toolName) => {
          emitProgress(getMainWindow(), {
            taskId: args.taskId,
            workDir: args.workDir,
            phase,
            percent,
            toolName,
          });
        },
        onTrace: (event) => {
          emitTrace(getMainWindow(), {
            taskId: args.taskId,
            workDir: args.workDir,
            event,
          });
        },
      });
      return submitted;
    } finally {
      if (ingestTaskId === args.taskId) {
        ingestAbort = null;
        ingestTaskId = null;
      }
    }
  });

  ipcMain.handle('publish:ingest-cancel', async () => {
    ingestAbort?.abort();
    ingestAbort = null;
    ingestTaskId = null;
  });
}
