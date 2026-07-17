import { useState } from 'react';
import type { SrtEntry } from '../../types';
import type { AIAnalysisResult, CoverCandidate } from '../../types/ai';
import type { ProjectProductionState } from '../../types/director';
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
  entries: SrtEntry[];
  busy: 'prompt' | 'images' | null;
  setBusy: (value: 'prompt' | 'images' | null) => void;
  setError: (value: string | null) => void;
  setAnalysis: (value: AIAnalysisResult) => void;
  setCandidates: (value: CoverCandidate[]) => void;
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
  if (context.busy) return;
  context.setBusy(kind);
  context.setError(null);
  const release = registerProductionSaveGuard(context.guard);
  try {
    await action();
  } catch (reason) {
    context.setError(reason instanceof Error ? reason.message : String(reason));
  } finally {
    release();
    context.setBusy(null);
  }
}

async function savePrompt(context: CoverContext, prompt: string): Promise<void> {
  if (!context.analysis || prompt.trim() === context.analysis.coverPrompts[0]?.trim()) return;
  const release = registerProductionSaveGuard(context.guard);
  try {
    const next = { ...context.analysis, coverPrompts: prompt.trim() ? [prompt.trim()] : [] };
    context.setAnalysis(next);
    await persist(context, next);
    await updateStatus(context, 'stale');
  } finally {
    release();
  }
}

async function selectCover(context: CoverContext, candidateId: string): Promise<void> {
  const release = registerProductionSaveGuard(context.guard);
  try {
    const next = selectCoverCandidate(context.candidates, candidateId);
    context.setCandidates(next);
    const selected = next.find((candidate) => candidate.id === candidateId);
    if (selected?.imageUrl) useTimelineStore.getState().setGlobalBackground(selected.imageUrl);
    await persist(context, context.analysis, next);
    await updateStatus(context, 'current');
  } finally {
    release();
  }
}

async function rewritePrompt(context: CoverContext): Promise<void> {
  await runBusy(context, 'prompt', async () => {
    if (!context.analysis || context.entries.length === 0) return;
    const settings = await loadAISettings();
    if (!settings) throw new Error('请先完成 AI 配置');
    const prompts = await window.electronAPI.regenerateCoverPrompt({
      entries: context.entries,
      settings,
      globalPrompt: context.analysis.globalPrompt,
      currentPrompt: context.analysis.coverPrompts[0],
      projectDir: context.projectDir,
      projectBindings: useAIStore.getState().projectBindings,
    });
    const next = { ...context.analysis, coverPrompts: prompts };
    context.setAnalysis(next);
    await persist(context, next);
    await updateStatus(context, 'stale');
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
    const prompts = context.analysis?.coverPrompts.filter((prompt) => prompt.trim()) ?? [];
    if (prompts.length === 0 || !context.production.approvedPlan) return;
    const settings = await loadAISettings();
    if (!settings?.defaultImageProviderId || settings.imageProviders.length === 0) {
      throw new Error('请先在 AI 配置中添加图片生成服务');
    }
    const generated = await window.electronAPI.generateCoverImages({
      prompts,
      settings,
      projectDir: context.projectDir,
      projectBindings: useAIStore.getState().projectBindings,
    });
    const now = Date.now();
    const next = generatedCandidates(context, generated, now);
    context.setCandidates(next);
    await persist(context, context.analysis, next);
    await updateStatus(context, 'current', now);
  });
}

export function useDirectorCoverControls(
  projectDir: string,
  production: ProjectProductionState,
) {
  const [busy, setBusy] = useState<'prompt' | 'images' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const analysis = useAIStore((state) => state.analysisResult);
  const candidates = useAIStore((state) => state.coverCandidates);
  const setAnalysis = useAIStore((state) => state.setAnalysisResult);
  const setCandidates = useAIStore((state) => state.setCoverCandidates);
  const entries = useTimelineStore((state) => state.srtEntries);
  const guard = production.approvedPlan
    ? { expectedDirectorRevision: production.approvedPlan.revision }
    : {};
  const context: CoverContext = {
    projectDir, production, guard, analysis, candidates, entries, busy,
    setBusy, setError, setAnalysis, setCandidates,
  };
  return {
    analysisResult: analysis,
    coverCandidates: candidates,
    entries,
    busy,
    error,
    savePrompt: (prompt: string) => savePrompt(context, prompt),
    selectCover: (candidateId: string) => selectCover(context, candidateId),
    rewritePrompt: () => rewritePrompt(context),
    generateCovers: () => generateCovers(context),
  };
}
