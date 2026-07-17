import { app, ipcMain, type BrowserWindow } from 'electron';
import { createDirectorPlan } from '../src/lib/director-planning';
import type { AISettings, PromptBindingMap } from '../src/types/ai';
import type { SrtEntry } from '../src/types';
import { loadEffectivePromptTemplate } from './prompts-io';
import { loadProjectFile, mutateProjectProduction } from './project-file';
import { emitProjectUpdated } from './pipeline/headless-generation';
import { makeMainTelemetry } from './telemetry/main-telemetry';

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
      const [planningTemplate, directorTemplate, motionBibleTemplate, project] = await Promise.all([
        loadEffectivePromptTemplate('planning.segment', { userDataPath, projectDir: args.projectDir }),
        loadEffectivePromptTemplate('production.director', { userDataPath, projectDir: args.projectDir }),
        loadEffectivePromptTemplate('motion.bible', { userDataPath, projectDir: args.projectDir }),
        loadProjectFile(args.projectDir),
      ]);
      const plan = await createDirectorPlan(args.entries, args.settings, {
        revision: args.directorRevision,
        globalPrompt: args.globalPrompt,
        stylePresetId: project.stylePresetId,
        planningTemplate,
        directorTemplate,
        motionBibleTemplate,
        projectBindings: args.projectBindings,
        telemetry,
        onProgress: (phase, percent) => emitProgress(ctx.getMainWindow(), args, phase, percent),
      });
      const production = await mutateProjectProduction(args.projectDir, { kind: 'replace-draft', plan });
      emitProjectUpdated(ctx.getMainWindow, args.projectDir, ['production']);
      telemetry.emit('stage.end', {
        stage: 'director.plan',
        ok: true,
        revision: plan.revision,
        segments: plan.segments.length,
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
