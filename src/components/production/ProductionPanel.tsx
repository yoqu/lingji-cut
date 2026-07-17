import { useCallback, useEffect, useState } from 'react';
import { AudioLines, Clapperboard, ListVideo, ShieldCheck } from 'lucide-react';
import { buildMotionProductionPlan } from '../../lib/production-plan';
import { evaluateProductionQuality } from '../../lib/production-quality';
import {
  audioRequestForCue,
  allProductionCues,
  generationRequestForCue,
  updateProductionCue,
  updateShotAssetPrompt,
} from '../../lib/production-workbench';
import { emptyAudioAssetLibrary, resolveOrGenerateAudioAsset } from '../../lib/audio-gen/local-first';
import type { MediaAssetCandidate } from '../../lib/media-asset-resolution';
import { loadAISettings } from '../../store/ai';
import { useAIStore } from '../../store/ai';
import { useTimelineStore } from '../../store/timeline';
import type { ProjectData } from '../../lib/project-persistence';
import type { AssetRecord } from '../../types/assets';
import type { MediaCardContent } from '../../types/ai';
import type { AudioCuePlan, MotionProductionPlan } from '../../types/production';
import type { ProjectProductionState } from '../../types/director';
import type { ProductionMutation } from '../../lib/production-mutations';
import { createDefaultAudioOverlayData, DEFAULT_AUDIO_OVERLAY_TRACK_ID } from '../../types';
import { Alert, Button, PillGroup, Spinner } from '../../ui';
import { ProductionAudio } from './ProductionAudio';
import { ProductionOverview } from './ProductionOverview';
import { ProductionQuality } from './ProductionQuality';
import { ProductionShots } from './ProductionShots';
import styles from './ProductionPanel.module.css';

export type ProductionView = 'overview' | 'shots' | 'audio' | 'quality';

export function ProductionPanel({ projectDir, compact: _compact, onOpenCardInspector, fixedView }: {
  projectDir: string;
  compact: boolean;
  onOpenCardInspector?: (cardId: string) => void;
  fixedView?: ProductionView;
}) {
  const analysisResult = useAIStore((state) => state.analysisResult);
  const [project, setProject] = useState<ProjectData | null>(null);
  const [workspace, setWorkspace] = useState<ProjectProductionState | null>(null);
  const [plan, setPlan] = useState<MotionProductionPlan | null>(null);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [credits, setCredits] = useState<number | null>(null);
  const [view, setView] = useState<ProductionView>('overview');
  const activeView = fixedView ?? view;
  const [loading, setLoading] = useState(true);
  const [workingCueId, setWorkingCueId] = useState<string | null>(null);
  const [cueCandidates, setCueCandidates] = useState<Record<string, MediaAssetCandidate[]>>({});
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!projectDir) return;
    const [raw, library] = await Promise.all([
      window.electronAPI.loadProject(projectDir),
      window.electronAPI.getAssetLibraryState(projectDir),
    ]);
    const nextProject = JSON.parse(raw) as ProjectData;
    const nextWorkspace = nextProject.production ?? null;
    setProject(nextProject);
    setWorkspace(nextWorkspace);
    setPlan(nextWorkspace?.execution ?? null);
    setAssets(library.library.assets);
    void window.electronAPI.getSunoCredits().then(setCredits).catch(() => setCredits(null));
  }, [projectDir]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    void reload().catch((reason) => setError(messageOf(reason))).finally(() => setLoading(false));
    return window.electronAPI.onProjectUpdated?.((payload) => {
      if (payload.projectPath !== projectDir || !payload.sections.includes('production')) return;
      void reload();
    });
  }, [projectDir, reload]);

  const mutateWorkspace = useCallback(async (mutation: ProductionMutation) => {
    const next = await window.electronAPI.mutateProjectProduction(projectDir, mutation);
    setWorkspace(next);
    setPlan(next.execution);
    setProject((current) => current ? { ...current, production: next } : current);
    return next;
  }, [projectDir]);

  const persist = useCallback(async (nextPlan: MotionProductionPlan) => {
    await mutateWorkspace({ kind: 'set-execution', execution: nextPlan });
  }, [mutateWorkspace]);

  const createPlan = useCallback(async () => {
    if (!workspace?.approvedPlan) return setError('director_approval_required：请先批准导演方案');
    if (!analysisResult) return setError('请先完成 AI 内容分析，再生成制作计划');
    const durationMs = useTimelineStore.getState().timeline.podcast.durationMs;
    const next = buildMotionProductionPlan(analysisResult, durationMs);
    await persist(next);
  }, [analysisResult, persist, workspace?.approvedPlan]);

  const runQuality = useCallback(async () => {
    if (!project || !plan) return;
    const report = evaluateProductionQuality(project, useTimelineStore.getState().timeline);
    await mutateWorkspace({
      kind: 'set-execution',
      execution: { ...plan, qualityReport: report },
    });
    await mutateWorkspace({
      kind: 'set-workflow',
      stage: report.exportAllowed ? 'refining' : 'quality-blocked',
    });
    if (!report.exportAllowed) setError('制作检查未通过，请处理错误项后再次批准');
    return report.exportAllowed;
  }, [mutateWorkspace, plan, project]);

  const approve = useCallback(async () => {
    setError(null);
    if (!plan || plan.shots.length === 0) return setError('Animatic 尚未包含可确认的镜头');
    const missingPrompts = plan.shots.some((shot) => shot.assetRequests.some((item) => !item.query.trim()));
    if (missingPrompts) return setError('仍有镜头素材提示词为空，请补全后再批准 Animatic');
    await mutateWorkspace({ kind: 'approve-animatic', complete: false });
    setView('audio');
  }, [mutateWorkspace, plan]);

  const reopen = useCallback(async () => {
    if (!plan) return;
    await mutateWorkspace({ kind: 'set-workflow', stage: 'animatic-review' });
  }, [mutateWorkspace, plan]);

  const acceptCueAsset = useCallback(async (cue: AudioCuePlan, asset: AssetRecord) => {
    if (!plan) return;
    await window.electronAPI.addAssetToProjectLibrary(projectDir, asset.id);
    placeAudioCue(cue, asset, plan);
    await persist(updateProductionCue(plan, cue.id, { assetId: asset.id }));
    setCueCandidates((current) => ({ ...current, [cue.id]: [] }));
    await reload();
  }, [persist, plan, projectDir, reload]);

  const searchCue = useCallback(async (cue: AudioCuePlan) => {
    if (!plan) return;
    setWorkingCueId(cue.id);
    setError(null);
    try {
      const candidates = await window.electronAPI.searchReusableMediaAssets({
        projectDir,
        request: audioRequestForCue(cue),
      });
      if (candidates[0]?.score >= 75) return await acceptCueAsset(cue, candidates[0].asset);
      setCueCandidates((current) => ({ ...current, [cue.id]: candidates }));
      if (candidates.length === 0) setError('本地素材库没有达到 55 分的候选，可调用 Suno 生成缺失素材');
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setWorkingCueId(null);
    }
  }, [acceptCueAsset, plan, projectDir]);

  const commitShotPrompt = useCallback(async (shotId: string, requestId: string, query: string) => {
    if (!plan) return;
    await persist(updateShotAssetPrompt(plan, shotId, requestId, query));
    const card = useAIStore.getState().analysisResult?.cards.find((item) => item.id === shotId);
    const content = card?.content;
    if (!content || typeof content !== 'object' || !('mediaType' in content)) return;
    useAIStore.getState().updateCard(shotId, {
      content: { ...(content as MediaCardContent), prompt: query, generationStatus: 'idle' },
    });
  }, [persist, plan]);

  const commitCuePrompt = useCallback(async (cueId: string, query: string) => {
    if (!plan) return;
    const cue = allProductionCues(plan).find((item) => item.id === cueId);
    if (cue) {
      const timeline = useTimelineStore.getState();
      const boundOverlays = timeline.timeline.overlays.filter((overlay) => overlay.type === 'audio' && (
        overlay.audioData?.cueId === cue.id || (
          !overlay.audioData?.cueId
          && overlay.audioData?.role === cue.role
          && (cue.role === 'bgm' || Math.abs(overlay.startMs - cue.startMs) < 2)
        )
      ));
      boundOverlays.forEach((overlay) => timeline.removeOverlay(overlay.id));
    }
    setCueCandidates((current) => ({ ...current, [cueId]: [] }));
    await persist(updateProductionCue(plan, cueId, { query }));
  }, [persist, plan]);

  const generateCue = useCallback(async (cue: AudioCuePlan) => {
    if (!plan) return;
    setWorkingCueId(cue.id);
    setError(null);
    try {
      const settings = await loadAISettings();
      if (!settings?.audioGeneration?.enabled) throw new Error('请先在系统设置 → BGM 与音效中启用 SunoAPI.org');
      if (credits === 0) throw new Error('SunoAPI credits 为 0，请充值后生成，或先使用本地候选');
      const requests = generationRequestForCue(cue);
      const request = audioRequestForCue(cue);
      const reusable = (await window.electronAPI.searchReusableMediaAssets({ projectDir, request }))[0];
      const result = reusable?.score >= 75
        ? { kind: 'reused' as const, ...reusable }
        : await resolveOrGenerateAudioAsset({
            request,
            library: emptyAudioAssetLibrary(),
            projectDir,
            mode: 'auto',
            music: requests.music,
            sound: requests.sound,
            pollIntervalMs: settings.audioGeneration.pollIntervalMs,
            timeoutMs: settings.audioGeneration.timeoutMs,
            deps: {
              createMusic: window.electronAPI.createSunoMusic,
              createSound: window.electronAPI.createSunoSound,
              getTask: window.electronAPI.getSunoAudioTask,
              materialize: window.electronAPI.materializeSunoAudio,
            },
          });
      if (result.kind === 'needs-review') {
        setCueCandidates((current) => ({ ...current, [cue.id]: result.candidates }));
        return;
      }
      const asset = result.kind === 'reused' ? result.asset : result.assets[0];
      if (!asset) throw new Error('没有可用的声音结果');
      await acceptCueAsset(cue, asset);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setWorkingCueId(null);
    }
  }, [acceptCueAsset, credits, plan, projectDir]);

  if (loading) return <div className={styles.loading}><Spinner size={14} />读取制作计划…</div>;
  if (!plan || !project) return <EmptyProduction error={error} onCreate={createPlan} />;
  return (
    <div className={styles.root}>
      {!fixedView ? <PillGroup
        fullWidth
        wrap={false}
        value={view}
        onChange={setView}
        items={[
          { value: 'overview', label: <><Clapperboard size={12} />总览</> },
          { value: 'shots', label: <><ListVideo size={12} />镜头</> },
          { value: 'audio', label: <><AudioLines size={12} />声音</> },
          { value: 'quality', label: <><ShieldCheck size={12} />质检</> },
        ]}
      /> : null}
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {activeView === 'overview' ? <ProductionOverview project={project} plan={plan} workflow={workspace?.workflow} onApprove={approve} onReopen={reopen} onRunQuality={runQuality} /> : null}
      {activeView === 'shots' ? <ProductionShots plan={plan} cards={analysisResult?.cards ?? []} projectDir={projectDir} onOpenCardInspector={onOpenCardInspector} onPromptChange={(shotId, requestId, query) => void commitShotPrompt(shotId, requestId, query)} /> : null}
      {activeView === 'audio' ? <ProductionAudio plan={plan} assets={assets} credits={credits} candidates={cueCandidates} workingCueId={workingCueId} onPromptChange={(cueId, query) => void commitCuePrompt(cueId, query)} onSearch={(cue) => void searchCue(cue)} onGenerate={(cue) => void generateCue(cue)} onSelect={(cue, asset) => void acceptCueAsset(cue, asset)} /> : null}
      {activeView === 'quality' ? <ProductionQuality plan={plan} onRun={() => void runQuality()} /> : null}
    </div>
  );
}

function EmptyProduction({ error, onCreate }: { error: string | null; onCreate: () => void }) {
  return <div className={styles.empty}>{error ? <Alert variant="destructive">{error}</Alert> : null}<strong>当前项目还没有制作计划</strong><Button variant="primary" size="sm" onClick={onCreate}>根据当前口播生成计划</Button></div>;
}

function messageOf(value: unknown): string { return value instanceof Error ? value.message : String(value); }

function placeAudioCue(cue: AudioCuePlan, asset: AssetRecord, plan: MotionProductionPlan): void {
  const store = useTimelineStore.getState();
  const assetPath = asset.files.processed || asset.files.original;
  const existing = store.timeline.overlays.find((overlay) => overlay.type === 'audio' && (
    overlay.audioData?.cueId === cue.id || (
      !overlay.audioData?.cueId
      && overlay.audioData?.role === cue.role
      && (cue.role === 'bgm' || Math.abs(overlay.startMs - cue.startMs) < 2)
    )
  ));
  const sourceDurationMs = asset.metadata.durationMs ?? cue.durationMs ?? 2_000;
  const audioData = { ...createDefaultAudioOverlayData(sourceDurationMs), cueId: cue.id, role: cue.role, loop: cue.loop === true, volume: 10 ** ((cue.volumeDb ?? -12) / 20), fadeInMs: cue.fadeInMs ?? 0, fadeOutMs: cue.fadeOutMs ?? 80, ducking: cue.role === 'bgm' ? plan.audioPlan.ducking : undefined };
  if (existing) return store.updateOverlay(existing.id, { assetPath, startMs: cue.startMs, durationMs: cue.durationMs ?? sourceDurationMs, audioData });
  store.addOverlay({ type: 'audio', assetPath, trackId: DEFAULT_AUDIO_OVERLAY_TRACK_ID, startMs: cue.startMs, durationMs: cue.durationMs ?? sourceDurationMs, position: { x: 0, y: 0, width: 0, height: 0 }, audioData });
}
