import { app, ipcMain, type BrowserWindow } from 'electron';
import path from 'node:path';
import type { AISettings, PromptBindingMap } from '../src/types/ai';
import type { SrtEntry } from '../src/types';
import { loadEffectivePromptTemplate } from './prompts-io';
import { loadProjectFile, mutateProjectProduction } from './project-file';
import { emitProjectUpdated } from './pipeline/headless-generation';
import { makeMainTelemetry } from './telemetry/main-telemetry';
import { runShowDirectorAgent } from './director-agent/show-director-run';
import { resolveFfmpegPath } from './runtime-binaries';

interface DirectorWorkflowIpcContext {
  getMainWindow: () => BrowserWindow | null;
  writeAppLog: (level: 'info' | 'warn' | 'error', scope: string, message: string, details?: string) => void;
}

export interface StartDirectorPlanArgs {
  taskId: string;
  directorRevision: number;
  entries: SrtEntry[];
  settings: AISettings;
  projectDir: string;
  globalPrompt?: string;
  projectBindings?: PromptBindingMap | null;
  telemetryRunId?: string | null;
  mode?: 'auto' | 'director';
  /** 缺省为 true；false 时方案关闭背景音乐。 */
  bgmEnabled?: boolean;
}

function emitProgress(
  win: BrowserWindow | null,
  args: StartDirectorPlanArgs,
  phase: 'planning' | 'motion-bible',
  percent: number,
): void {
  win?.webContents.send('director-plan-progress', {
    taskId: args.taskId,
    directorRevision: args.directorRevision,
    phase,
    percent,
  });
}

export function registerDirectorWorkflowIpc(ctx: DirectorWorkflowIpcContext): void {
  ipcMain.handle('director:start-plan', async (_event, args: StartDirectorPlanArgs) => {
    const telemetry = makeMainTelemetry(args.telemetryRunId);
    await mutateProjectProduction(args.projectDir, {
      kind: 'set-workflow',
      stage: 'director-planning',
      mode: args.mode,
      taskId: args.taskId,
    });
    telemetry.emit('stage.start', { stage: 'director.plan', revision: args.directorRevision });
    try {
      const userDataPath = app.getPath('userData');
      const [directorTemplate] = await Promise.all([
        loadEffectivePromptTemplate('production.director', { userDataPath, projectDir: args.projectDir }),
      ]);
      const plan = await runShowDirectorAgent({
        userDataPath,
        projectDir: args.projectDir,
        resourcesRoot: path.join(app.getAppPath(), 'resources', 'pi-agents'),
        entries: args.entries,
        settings: args.settings,
        revision: args.directorRevision,
        globalPrompt: args.globalPrompt,
        bgmEnabled: args.bgmEnabled,
        directorTemplate,
        projectBindings: args.projectBindings,
        telemetry,
        ffmpegPath: resolveFfmpegPath({
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath,
          cwd: process.cwd(),
          moduleDir: __dirname,
        }),
        onProgress: (phase, percent) => emitProgress(ctx.getMainWindow(), args, phase, percent),
      });
      const production = (await loadProjectFile(args.projectDir)).production;
      if (!production?.draftPlan || production.draftPlan.revision !== plan.revision) {
        throw new Error('Pi 总导演已返回方案，但项目草案未成功落盘');
      }
      emitProjectUpdated(ctx.getMainWindow, args.projectDir, ['production', 'meta', 'publish']);
      telemetry.emit('stage.end', {
        stage: 'director.plan',
        ok: true,
        revision: plan.revision,
        segments: plan.segments.length,
        carrierRebalanced: plan.motionBible.carrierRebalanceCount ?? 0,
      });
      return production;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await mutateProjectProduction(args.projectDir, { kind: 'set-workflow', stage: 'error', error: message });
      telemetry.emit('stage.end', { stage: 'director.plan', ok: false, error: message });
      ctx.writeAppLog('error', 'director', '导演方案生成失败', message);
      throw error;
    }
  });

  ipcMain.handle('director:approve-and-start', async (
    _event,
    projectDir: string,
    expectedRevision: number,
    taskId?: string,
  ) => {
    const production = await mutateProjectProduction(projectDir, {
      kind: 'approve-draft',
      expectedRevision,
      taskId,
    });
    emitProjectUpdated(ctx.getMainWindow, projectDir, ['production']);
    return production;
  });

  ipcMain.handle('director:resume-production', async (
    _event,
    projectDir: string,
    taskId?: string,
    mode?: 'auto' | 'director',
  ) => {
    const production = await mutateProjectProduction(projectDir, {
      kind: 'set-workflow',
      stage: 'production-running',
      taskId,
      mode,
    });
    emitProjectUpdated(ctx.getMainWindow, projectDir, ['production']);
    return production;
  });

  ipcMain.handle('director:cancel-production', async (
    _event,
    projectDir: string,
    taskId?: string,
    directorRevision?: number,
  ) => {
    const production = await mutateProjectProduction(projectDir, {
      kind: 'set-workflow',
      stage: 'production-paused',
      expectedTaskId: taskId,
      expectedDirectorRevision: directorRevision,
    });
    emitProjectUpdated(ctx.getMainWindow, projectDir, ['production']);
    return production;
  });
}
