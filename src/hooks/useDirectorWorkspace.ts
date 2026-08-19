import { useCallback, useEffect, useRef, useState } from 'react';
import { getAISettingsIssue } from '../lib/ai-settings';
import { createEmptyProductionState } from '../lib/director-workflow';
import {
  runDirectorProductionClient,
  type DirectorProductionProgress,
} from '../lib/director-production-client';
import { isDirectorProductionCancellation } from '../lib/director-production';
import { monotonicDirectorProductionProgress } from '../lib/director-production-progress';
import { legacyShowDirectorPlanVersion } from '../lib/show-director-version';
import { createAutoRunTelemetry } from '../lib/telemetry/auto-run';
import { loadAISettings, useAIStore } from '../store/ai';
import { useTaskProgressStore } from '../store/task-progress';
import { useTimelineStore } from '../store/timeline';
import type { ProjectData } from '../lib/project-persistence';
import type { AISettings } from '../types/ai';
import type { DirectorPlan, ProjectProductionState } from '../types/director';

type ProgressMap = Partial<Record<DirectorProductionProgress['track'] | 'director', DirectorProductionProgress>>;

function startTask(id: string, label: string, phase: string): void {
  useTaskProgressStore.getState().startTask({
    id,
    category: 'ai-analyze',
    label,
    mode: 'determinate',
    progress: 0,
    phase,
    level: 2,
    canCancel: false,
  });
}

function nextRevision(production: ProjectProductionState): number {
  if (production.draftPlan) return production.draftPlan.revision;
  return (production.approvedPlan?.revision ?? 0) + 1;
}

async function loadValidatedAISettings(): Promise<AISettings> {
  const settings = await loadAISettings();
  const issue = getAISettingsIssue(settings);
  if (!settings || issue) throw new Error(issue ?? '请先完成 AI 配置');
  return settings;
}

export function useDirectorWorkspace(projectDir: string) {
  const entries = useTimelineStore((state) => state.srtEntries);
  const [production, setProduction] = useState<ProjectProductionState>(() => createEmptyProductionState());
  const [loading, setLoading] = useState(true);
  const [workKind, setWorkKind] = useState<'idle' | 'planning' | 'production'>('idle');
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftSaveStatus, setDraftSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [progress, setProgress] = useState<ProgressMap>({});
  const progressRef = useRef<ProgressMap>({});
  const overallProgressRef = useRef(0);
  const cancelRequested = useRef(false);
  const activeTaskIdRef = useRef<string | null>(null);
  const activeDirectorRevisionRef = useRef<number | undefined>(undefined);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pausePromiseRef = useRef<Promise<ProjectProductionState> | null>(null);
  const reloadSequenceRef = useRef(0);
  const working = workKind !== 'idle';
  const producing = workKind === 'production';

  const reload = useCallback(async () => {
    const sequence = ++reloadSequenceRef.current;
    if (!projectDir) {
      if (sequence === reloadSequenceRef.current) setProduction(createEmptyProductionState());
      return;
    }
    const raw = await window.electronAPI.loadProject(projectDir);
    const project = JSON.parse(raw) as ProjectData;
    if (sequence === reloadSequenceRef.current) {
      const next = project.production ?? createEmptyProductionState();
      setProduction(next);
      setError(next.workflow.error ?? null);
    }
  }, [projectDir]);

  useEffect(() => {
    setLoading(true);
    setDraftSaveStatus('idle');
    void reload().catch((reason) => setError(messageOf(reason))).finally(() => setLoading(false));
    return window.electronAPI.onProjectUpdated?.((payload) => {
      if (payload.projectPath === projectDir && payload.sections.includes('production')) void reload();
    });
  }, [projectDir, reload]);

  const generatePlan = useCallback(async (globalPrompt?: string) => {
    if (!projectDir || working) return;
    const settings = await loadAISettings();
    const issue = getAISettingsIssue(settings);
    if (!settings || issue) return setError(issue ?? '请先完成 AI 配置');
    if (entries.length === 0) return setError('请先生成或导入口播字幕，再制定导演方案');
    const revision = nextRevision(production);
    const taskId = `director-plan-${Date.now()}`;
    const telemetry = createAutoRunTelemetry(`autorun-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
    const materialSearchEnabled = settings.kacut?.enabled === true;
    startTask(taskId, '生成导演方案', '分析内容结构');
    setWorkKind('planning');
    setError(null);
    const off = window.electronAPI.onDirectorPlanProgress((event) => {
      if (event.taskId !== taskId || event.directorRevision !== revision) return;
      const percent = event.phase === 'planning' ? Math.round(event.percent * 0.65) : 65 + Math.round(event.percent * 0.35);
      const message = event.phase === 'planning'
        ? materialSearchEnabled
          ? '规划镜头并检索素材'
          : '规划镜头与媒介策略（素材联动未启用）'
        : '复核镜头与媒介策略';
      setProgress((current) => ({ ...current, director: { track: 'cards', percent, message } }));
      useTaskProgressStore.getState().updateTask(taskId, { progress: percent, phase: message });
    });
    try {
      telemetry.event('run.start', { source: 'director-workbench', revision, entries: entries.length });
      const next = await window.electronAPI.startDirectorPlan({
        taskId,
        directorRevision: revision,
        entries,
        settings,
        projectDir,
        globalPrompt,
        projectBindings: useAIStore.getState().projectBindings,
        telemetryRunId: telemetry.runId,
      });
      setProduction(next);
      setDraftSaveStatus('saved');
      useTaskProgressStore.getState().completeTask(taskId);
      telemetry.event('run.end', { ok: true, awaitingDirectorReview: true, revision });
    } catch (reason) {
      const message = messageOf(reason);
      setError(message);
      useTaskProgressStore.getState().failTask(taskId, message);
      telemetry.event('run.end', { ok: false, failedStage: 'director.plan', error: message });
      await reload().catch(() => undefined);
    } finally {
      off();
      setWorkKind('idle');
    }
  }, [entries, production, projectDir, reload, working]);

  const saveDraft = useCallback(async (plan: DirectorPlan) => {
    if (!projectDir) return;
    setDraftSaveStatus('saving');
    setError(null);
    try {
      const next = await window.electronAPI.mutateProjectProduction(projectDir, {
        kind: 'replace-draft',
        plan,
      });
      setProduction(next);
      setDraftSaveStatus('saved');
      return next;
    } catch (reason) {
      const message = messageOf(reason);
      setDraftSaveStatus('error');
      setError(message);
      throw reason;
    }
  }, [projectDir]);

  const requestProductionPause = useCallback((): Promise<ProjectProductionState> => {
    if (!projectDir) return Promise.reject(new Error('当前没有可暂停的项目'));
    const taskId = activeTaskIdRef.current;
    const directorRevision = activeDirectorRevisionRef.current;
    if (!taskId || directorRevision == null) {
      return Promise.reject(new Error('当前没有正在执行的制作任务'));
    }
    cancelRequested.current = true;
    abortControllerRef.current?.abort();
    setCancelling(true);
    if (!pausePromiseRef.current) {
      pausePromiseRef.current = window.electronAPI.cancelProduction(
        projectDir,
        taskId,
        directorRevision,
      );
    }
    return pausePromiseRef.current;
  }, [projectDir]);

  const runProduction = useCallback(async (
    approved: ProjectProductionState,
    settings: AISettings,
    providedTaskId?: string,
    resumed = false,
  ) => {
    const taskId = providedTaskId ?? `director-production-${Date.now()}`;
    const directorRevision = approved.approvedPlan?.revision;
    const abortController = new AbortController();
    activeTaskIdRef.current = taskId;
    activeDirectorRevisionRef.current = directorRevision;
    abortControllerRef.current = abortController;
    pausePromiseRef.current = null;
    const telemetry = createAutoRunTelemetry(`autorun-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
    startTask(taskId, '执行导演方案', '准备制作');
    cancelRequested.current = false;
    setCancelling(false);
    setWorkKind('production');
    progressRef.current = {};
    overallProgressRef.current = 0;
    setProgress({});
    telemetry.event('run.start', {
      source: 'director-production',
      revision: approved.approvedPlan?.revision,
      mode: approved.workflow.mode,
    });
    telemetry.event(resumed ? 'production.resume' : 'director.approved', {
      taskId,
      directorRevision: approved.approvedPlan?.revision,
      impact: approved.pendingImpact,
    });
    try {
      const next = await runDirectorProductionClient({
        projectDir,
        production: approved,
        entries,
        settings,
        taskId,
        telemetryRunId: telemetry.runId,
        shouldCancel: () => cancelRequested.current,
        signal: abortController.signal,
        pauseProduction: requestProductionPause,
        onProgress: (event) => {
          progressRef.current = { ...progressRef.current, [event.track]: event };
          setProgress(progressRef.current);
          const overallProgress = monotonicDirectorProductionProgress(
            progressRef.current,
            overallProgressRef.current,
          );
          overallProgressRef.current = overallProgress;
          useTaskProgressStore.getState().updateTask(taskId, {
            progress: overallProgress,
            phase: event.message,
          });
        },
      });
      setProduction(next);
      setError(next.workflow.error ?? null);
      if (next.workflow.stage === 'production-paused' || cancelRequested.current) {
        useTaskProgressStore.getState().cancelTask(taskId, '制作已暂停');
        telemetry.event('run.end', { ok: false, cancelled: true, productionPaused: true });
      } else {
        useTaskProgressStore.getState().completeTask(taskId);
        telemetry.event('run.end', {
          ok: true,
          awaitingAnimaticReview: next.workflow.stage === 'animatic-review',
        });
      }
    } catch (reason) {
      const message = messageOf(reason);
      const cancelled = cancelRequested.current
        || abortController.signal.aborted
        || isDirectorProductionCancellation(reason);
      if (cancelled || isProductionConflict(reason)) {
        await reload().catch(() => undefined);
        if (cancelled) {
          setError(null);
          useTaskProgressStore.getState().cancelTask(taskId, '制作已暂停');
          telemetry.event('run.end', { ok: false, cancelled: true, productionPaused: true });
        } else {
          setError(message);
          useTaskProgressStore.getState().failTask(taskId, message);
          telemetry.event('run.end', { ok: false, staleTask: true, error: message });
        }
      } else {
        try {
          const next = await window.electronAPI.mutateProjectProduction(projectDir, {
            kind: 'set-workflow',
            stage: 'error',
            error: message,
            expectedTaskId: taskId,
            expectedDirectorRevision: directorRevision,
          });
          setProduction(next);
        } catch (mutationError) {
          // 失败落盘前任务若已被暂停或替换，只刷新磁盘状态，不能用旧任务覆盖它。
          if (isProductionConflict(mutationError)) await reload().catch(() => undefined);
          else throw mutationError;
        }
        setError(message);
        useTaskProgressStore.getState().failTask(taskId, message);
        telemetry.event('run.end', { ok: false, failedStage: 'production', error: message });
      }
    } finally {
      if (activeTaskIdRef.current === taskId) {
        activeTaskIdRef.current = null;
        activeDirectorRevisionRef.current = undefined;
        abortControllerRef.current = null;
        pausePromiseRef.current = null;
        setCancelling(false);
        setWorkKind('idle');
      }
    }
  }, [entries, projectDir, reload, requestProductionPause]);

  const approveAndProduce = useCallback(async (draft?: DirectorPlan) => {
    if (!projectDir || working) return;
    setWorkKind('production');
    setError(null);
    try {
      // Validate before approve changes the persisted workflow to production-running.
      // Otherwise a missing or invalid provider strands the project in a running state
      // without ever starting a production task.
      const settings = await loadValidatedAISettings();
      let current = production;
      if (draft) {
        current = await window.electronAPI.mutateProjectProduction(projectDir, {
          kind: 'replace-draft', plan: draft,
        });
        setProduction(current);
      }
      const revision = current.draftPlan?.revision;
      if (revision == null) throw new Error('当前没有可批准的导演草案');
      const taskId = `director-production-${Date.now()}`;
      const approved = await window.electronAPI.approveDirectorPlanAndStartProduction(
        projectDir,
        revision,
        taskId,
      );
      setProduction(approved);
      await runProduction(approved, settings, taskId);
    } catch (reason) {
      setError(messageOf(reason));
      setWorkKind('idle');
    }
  }, [production, projectDir, runProduction, working]);

  const resume = useCallback(async () => {
    if (!projectDir || working) return;
    setWorkKind('production');
    setError(null);
    try {
      if (production.workflow.mode === 'director' && production.approvedPlan) {
        const legacyVersion = legacyShowDirectorPlanVersion(production.approvedPlan);
        if (legacyVersion) {
          throw new Error(
            `旧版导演方案不能继续制作（角色 v${legacyVersion.role} · 工作流 v${legacyVersion.workflow}），请先用当前导演重新编排`,
          );
        }
      }
      // Resume has the same preflight requirement: do not persist production-running
      // until the renderer has a usable text-generation provider.
      const settings = await loadValidatedAISettings();
      const taskId = `director-production-${Date.now()}`;
      const next = await window.electronAPI.resumeProduction(projectDir, taskId, 'director');
      setProduction(next);
      await runProduction(next, settings, taskId, true);
    } catch (reason) {
      setError(messageOf(reason));
      setWorkKind('idle');
    }
  }, [production, projectDir, runProduction, working]);

  const cancel = useCallback(async () => {
    if (!projectDir || !producing) return;
    try {
      setProduction(await requestProductionPause());
    } catch (reason) {
      if (isProductionConflict(reason)) await reload().catch(() => undefined);
      else setError(messageOf(reason));
    }
  }, [producing, projectDir, reload, requestProductionPause]);

  const approveAnimatic = useCallback(async () => {
    if (!projectDir) return;
    setProduction(await window.electronAPI.mutateProjectProduction(projectDir, {
      kind: 'approve-animatic', complete: false,
    }));
  }, [projectDir]);

  return {
    production, loading, working, planning: workKind === 'planning', producing, cancelling,
    error, progress, draftSaveStatus, setError,
    generatePlan, saveDraft, approveAndProduce, resume, cancel, approveAnimatic, reload,
  };
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isProductionConflict(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  const code = (value as Error & { code?: unknown }).code;
  return code === 'director_task_conflict'
    || code === 'director_revision_conflict'
    || value.name === 'ProductionTaskConflictError'
    || value.name === 'ProductionRevisionConflictError'
    || value.message.includes('制作任务已变化')
    || value.message.includes('导演方案版本已变化');
}
