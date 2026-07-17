import { useCallback, useEffect, useRef, useState } from 'react';
import { getAISettingsIssue } from '../lib/ai-settings';
import { createEmptyProductionState } from '../lib/director-workflow';
import {
  runDirectorProductionClient,
  type DirectorProductionProgress,
} from '../lib/director-production-client';
import { createAutoRunTelemetry } from '../lib/telemetry/auto-run';
import { loadAISettings, useAIStore } from '../store/ai';
import { useTaskProgressStore } from '../store/task-progress';
import { useTimelineStore } from '../store/timeline';
import type { ProjectData } from '../lib/project-persistence';
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

export function useDirectorWorkspace(projectDir: string) {
  const entries = useTimelineStore((state) => state.srtEntries);
  const [production, setProduction] = useState<ProjectProductionState>(() => createEmptyProductionState());
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressMap>({});
  const progressRef = useRef<ProgressMap>({});
  const cancelRequested = useRef(false);
  const activeTaskIdRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    if (!projectDir) {
      setProduction(createEmptyProductionState());
      return;
    }
    const raw = await window.electronAPI.loadProject(projectDir);
    const project = JSON.parse(raw) as ProjectData;
    setProduction(project.production ?? createEmptyProductionState());
  }, [projectDir]);

  useEffect(() => {
    setLoading(true);
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
    startTask(taskId, '生成导演方案', '分析内容结构');
    setWorking(true);
    setError(null);
    const off = window.electronAPI.onDirectorPlanProgress((event) => {
      if (event.taskId !== taskId || event.directorRevision !== revision) return;
      const percent = event.phase === 'planning' ? Math.round(event.percent * 0.65) : 65 + Math.round(event.percent * 0.35);
      const message = event.phase === 'planning' ? '分析内容结构' : '制定 Motion Bible';
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
      useTaskProgressStore.getState().completeTask(taskId);
      telemetry.event('run.end', { ok: true, awaitingDirectorReview: true, revision });
    } catch (reason) {
      const message = messageOf(reason);
      setError(message);
      useTaskProgressStore.getState().failTask(taskId, message);
      telemetry.event('run.end', { ok: false, failedStage: 'director.plan', error: message });
    } finally {
      off();
      setWorking(false);
    }
  }, [entries, production, projectDir, working]);

  const saveDraft = useCallback(async (plan: DirectorPlan) => {
    if (!projectDir) return;
    const next = await window.electronAPI.mutateProjectProduction(projectDir, {
      kind: 'replace-draft',
      plan,
    });
    setProduction(next);
  }, [projectDir]);

  const runProduction = useCallback(async (
    approved: ProjectProductionState,
    providedTaskId?: string,
    resumed = false,
  ) => {
    const settings = await loadAISettings();
    if (!settings) throw new Error('请先完成 AI 配置');
    const taskId = providedTaskId ?? `director-production-${Date.now()}`;
    activeTaskIdRef.current = taskId;
    const telemetry = createAutoRunTelemetry(`autorun-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
    startTask(taskId, '执行导演方案', '准备制作');
    cancelRequested.current = false;
    setWorking(true);
    progressRef.current = {};
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
        onProgress: (event) => {
          progressRef.current = { ...progressRef.current, [event.track]: event };
          setProgress(progressRef.current);
          const values = Object.values(progressRef.current);
          const total = values.reduce((sum, item) => sum + (item?.percent ?? 0), 0);
          useTaskProgressStore.getState().updateTask(taskId, {
            progress: Math.round(total / Math.max(1, values.length)),
            phase: event.message,
          });
        },
      });
      setProduction(next);
      useTaskProgressStore.getState().completeTask(taskId);
      telemetry.event('run.end', {
        ok: true,
        awaitingAnimaticReview: next.workflow.stage === 'animatic-review',
      });
    } catch (reason) {
      const message = messageOf(reason);
      const next = await window.electronAPI.mutateProjectProduction(projectDir, {
        kind: 'set-workflow', stage: 'error', error: message,
      });
      setProduction(next);
      setError(message);
      useTaskProgressStore.getState().failTask(taskId, message);
      telemetry.event('run.end', { ok: false, failedStage: 'production', error: message });
    } finally {
      if (activeTaskIdRef.current === taskId) activeTaskIdRef.current = null;
      setWorking(false);
    }
  }, [entries, projectDir]);

  const approveAndProduce = useCallback(async (draft?: DirectorPlan) => {
    let current = production;
    if (draft && projectDir) {
      current = await window.electronAPI.mutateProjectProduction(projectDir, {
        kind: 'replace-draft', plan: draft,
      });
      setProduction(current);
    }
    const revision = current.draftPlan?.revision;
    if (!projectDir || revision == null || working) return;
    setError(null);
    const taskId = `director-production-${Date.now()}`;
    const approved = await window.electronAPI.approveDirectorPlanAndStartProduction(
      projectDir,
      revision,
      taskId,
    );
    setProduction(approved);
    await runProduction(approved, taskId);
  }, [production, projectDir, runProduction, working]);

  const resume = useCallback(async () => {
    if (!projectDir || working) return;
    const taskId = `director-production-${Date.now()}`;
    const next = await window.electronAPI.resumeProduction(projectDir, taskId, 'director');
    setProduction(next);
    await runProduction(next, taskId, true);
  }, [projectDir, runProduction, working]);

  const cancel = useCallback(async () => {
    if (!projectDir) return;
    cancelRequested.current = true;
    setProduction(await window.electronAPI.cancelProduction(
      projectDir,
      activeTaskIdRef.current ?? undefined,
      production.approvedPlan?.revision,
    ));
  }, [production.approvedPlan?.revision, projectDir]);

  const approveAnimatic = useCallback(async () => {
    if (!projectDir) return;
    setProduction(await window.electronAPI.mutateProjectProduction(projectDir, {
      kind: 'approve-animatic', complete: false,
    }));
  }, [projectDir]);

  return {
    production, loading, working, error, progress, setError,
    generatePlan, saveDraft, approveAndProduce, resume, cancel, approveAnimatic, reload,
  };
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
