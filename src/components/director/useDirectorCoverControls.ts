import { useEffect, useRef, useState } from 'react';
import type { SrtEntry } from '../../types';
import type { AIAnalysisResult, CoverCandidate } from '../../types/ai';
import type { GenerationProvenance, ProjectProductionState } from '../../types/director';
import { createPersistedAIState, selectCoverCandidate } from '../../lib/ai-persistence';
import type { ProductionMutationGuard } from '../../lib/production-mutations';
import { registerProductionSaveGuard } from '../../lib/production-save-guard';
import { loadAISettings, useAIStore } from '../../store/ai';
import { useTimelineStore } from '../../store/timeline';

interface CoverContext {
  projectDir: string;
  production: ProjectProductionState;
  guard: ProductionMutationGuard;
  analysis: AIAnalysisResult | null;
  candidates: CoverCandidate[];
  coverPrompt: string;
  locked: boolean;
  entries: SrtEntry[];
  busy: 'prompt' | 'images' | null;
  setBusy: (value: 'prompt' | 'images' | null) => void;
  setError: (value: string | null) => void;
  setAnalysis: (value: AIAnalysisResult) => void;
  setCandidates: (value: CoverCandidate[]) => void;
  canCommit: () => boolean;
  isMounted: () => boolean;
}

function coverPromptProvenance(
  context: CoverContext,
  modifiedByUser: boolean,
  generatedAt = Date.now(),
): GenerationProvenance {
  const approved = context.production.approvedPlan!;
  return {
    directorRevision: approved.revision,
    fingerprint: `cover-prompt-${approved.inputFingerprint}-${approved.revision}`,
    generatedAt,
    modifiedByUser,
  };
}

async function persist(
  context: CoverContext,
  analysis = context.analysis,
  candidates = context.candidates,
): Promise<void> {
  await window.electronAPI.saveProjectSection(
    context.projectDir,
    'aiAnalysis',
    JSON.stringify(createPersistedAIState(analysis, candidates)),
    context.guard,
  );
}

async function updateStatus(
  context: CoverContext,
  status: 'current' | 'stale',
  updatedAt = Date.now(),
): Promise<void> {
  await window.electronAPI.mutateProjectProduction(context.projectDir, {
    kind: 'set-output',
    output: 'cover',
    state: {
      status,
      directorRevision: context.production.approvedPlan?.revision,
      updatedAt,
    },
    ...context.guard,
  });
}

async function runBusy(
  context: CoverContext,
  kind: 'prompt' | 'images',
  action: () => Promise<void>,
): Promise<void> {
  if (context.busy || context.locked) return;
  context.setBusy(kind);
  context.setError(null);
  const release = registerProductionSaveGuard(context.guard);
  try {
    await action();
  } catch (reason) {
    if (context.canCommit()) {
      context.setError(reason instanceof Error ? reason.message : String(reason));
    }
  } finally {
    release();
    if (context.isMounted()) context.setBusy(null);
  }
}

async function savePrompt(context: CoverContext, prompt: string): Promise<void> {
  if (
    context.locked
    || !context.analysis
    || !context.production.approvedPlan
    || prompt.trim() === context.coverPrompt.trim()
  ) return;
  const release = registerProductionSaveGuard(context.guard);
  try {
    const next = {
      ...context.analysis,
      coverPrompts: prompt.trim() ? [prompt.trim()] : [],
      coverPromptProvenance: coverPromptProvenance(context, true),
    };
    await persist(context, next);
    await updateStatus(context, 'stale');
    context.setAnalysis(next);
  } finally {
    release();
  }
}

async function selectCover(context: CoverContext, candidateId: string): Promise<void> {
  if (context.locked || !context.candidates.some((candidate) => candidate.id === candidateId)) return;
  const release = registerProductionSaveGuard(context.guard);
  try {
    const next = selectCoverCandidate(context.candidates, candidateId);
    const selected = next.find((candidate) => candidate.id === candidateId);
    await persist(context, context.analysis, next);
    await updateStatus(context, 'current');
    context.setCandidates(next);
    if (selected?.imageUrl) useTimelineStore.getState().setGlobalBackground(selected.imageUrl);
  } finally {
    release();
  }
}

async function rewritePrompt(context: CoverContext): Promise<void> {
  await runBusy(context, 'prompt', async () => {
    if (!context.analysis || context.entries.length === 0) return;
    const settings = await loadAISettings();
    if (!settings) throw new Error('请先完成 AI 配置');
    if (!context.canCommit()) return;
    const prompts = await window.electronAPI.regenerateCoverPrompt({
      entries: context.entries,
      settings,
      globalPrompt: context.analysis.globalPrompt,
      currentPrompt: context.coverPrompt,
      projectDir: context.projectDir,
      projectBindings: useAIStore.getState().projectBindings,
    });
    if (!context.canCommit()) return;
    const next = {
      ...context.analysis,
      coverPrompts: prompts,
      coverPromptProvenance: coverPromptProvenance(context, false),
    };
    await persist(context, next);
    await updateStatus(context, 'stale');
    context.setAnalysis(next);
  });
}

function generatedCandidates(context: CoverContext, generated: CoverCandidate[], now: number) {
  const approved = context.production.approvedPlan!;
  const protectedCandidates = context.candidates.filter(
    (candidate) => candidate.generationProvenance?.modifiedByUser,
  );
  return [...protectedCandidates, ...generated.map((candidate) => ({
    ...candidate,
    generationProvenance: {
      directorRevision: approved.revision,
      fingerprint: `cover-${approved.inputFingerprint}-${approved.revision}`,
      generatedAt: now,
      modifiedByUser: false,
    },
  }))];
}

async function generateCovers(context: CoverContext): Promise<void> {
  await runBusy(context, 'images', async () => {
    // analysis 可能仍保存上一批准版本的提示词；只使用已按 revision 解析后的可见提示词。
    const prompts = context.coverPrompt.trim() ? [context.coverPrompt.trim()] : [];
    if (prompts.length === 0 || !context.production.approvedPlan) return;
    const settings = await loadAISettings();
    if (!settings?.defaultImageProviderId || settings.imageProviders.length === 0) {
      throw new Error('请先在 AI 配置中添加图片生成服务');
    }
    if (!context.canCommit()) return;
    const generated = await window.electronAPI.generateCoverImages({
      prompts,
      settings,
      projectDir: context.projectDir,
      projectBindings: useAIStore.getState().projectBindings,
    });
    if (!context.canCommit()) return;
    const now = Date.now();
    const next = generatedCandidates(context, generated, now);
    await persist(context, context.analysis, next);
    await updateStatus(context, 'current', now);
    context.setCandidates(next);
  });
}

export function useDirectorCoverControls(
  projectDir: string,
  production: ProjectProductionState,
  externallyLocked = false,
) {
  const [busy, setBusy] = useState<'prompt' | 'images' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const analysis = useAIStore((state) => state.analysisResult);
  const storedCandidates = useAIStore((state) => state.coverCandidates);
  const setAnalysis = useAIStore((state) => state.setAnalysisResult);
  const setCandidates = useAIStore((state) => state.setCoverCandidates);
  const entries = useTimelineStore((state) => state.srtEntries);
  const approvedRevision = production.approvedPlan?.revision;
  const candidates = approvedRevision == null
    ? []
    : storedCandidates.filter(
        (candidate) => candidate.generationProvenance?.directorRevision === approvedRevision,
      );
  const promptMatchesRevision = approvedRevision != null
    && analysis?.coverPromptProvenance?.directorRevision === approvedRevision;
  const coverPrompt = promptMatchesRevision
    ? analysis?.coverPrompts[0] ?? ''
    : production.approvedPlan?.coverDirection.prompt ?? '';
  const locked = externallyLocked || production.workflow.stage === 'production-running';
  const lifecycleRef = useRef({
    epoch: 0,
    mounted: true,
    revision: approvedRevision,
    locked,
  });
  if (
    lifecycleRef.current.revision !== approvedRevision
    || lifecycleRef.current.locked !== locked
  ) {
    lifecycleRef.current.epoch += 1;
    lifecycleRef.current.revision = approvedRevision;
    lifecycleRef.current.locked = locked;
  }
  useEffect(() => {
    lifecycleRef.current.mounted = true;
    return () => {
      lifecycleRef.current.mounted = false;
      lifecycleRef.current.epoch += 1;
    };
  }, []);
  const operationEpoch = lifecycleRef.current.epoch;
  const guard = production.approvedPlan
    ? {
        expectedDirectorRevision: production.approvedPlan.revision,
        ...(production.workflow.activeTaskId
          ? { expectedTaskId: production.workflow.activeTaskId }
          : {}),
      }
    : {};
  const context: CoverContext = {
    projectDir, production, guard, analysis, candidates, coverPrompt, locked, entries, busy,
    setBusy, setError, setAnalysis, setCandidates,
    canCommit: () => (
      lifecycleRef.current.mounted
      && lifecycleRef.current.epoch === operationEpoch
      && !lifecycleRef.current.locked
      && lifecycleRef.current.revision === approvedRevision
    ),
    isMounted: () => lifecycleRef.current.mounted,
  };
  return {
    analysisResult: analysis,
    coverCandidates: candidates,
    coverPrompt,
    locked,
    entries,
    busy,
    error,
    savePrompt: (prompt: string) => savePrompt(context, prompt),
    selectCover: (candidateId: string) => selectCover(context, candidateId),
    rewritePrompt: () => rewritePrompt(context),
    generateCovers: () => generateCovers(context),
  };
}
