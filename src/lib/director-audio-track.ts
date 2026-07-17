import type { AISettings } from '../types/ai';
import type { AudioCuePlan, MotionProductionPlan } from '../types/production';
import { createDefaultAudioOverlayData, DEFAULT_AUDIO_OVERLAY_TRACK_ID } from '../types';
import { useTimelineStore } from '../store/timeline';
import { emptyAudioAssetLibrary, resolveOrGenerateAudioAsset } from './audio-gen/local-first';
import { audioRequestForCue, generationRequestForCue } from './production-workbench';

export interface DirectorAudioTrackOptions {
  projectDir: string;
  durationMs: number;
  settings: AISettings;
  execution: MotionProductionPlan;
  onProgress?: (percent: number, message: string) => void;
  shouldCancel?: () => boolean;
}

export interface DirectorAudioTrackResult {
  execution: MotionProductionPlan;
  outcome: 'disabled' | 'reused' | 'generated' | 'needs-review' | 'missing';
  reusedSounds: number;
  error?: string;
}

function placeAudioCue(
  cue: AudioCuePlan,
  assetPath: string,
  sourceDurationMs: number,
  ducking?: MotionProductionPlan['audioPlan']['ducking'],
): void {
  const timeline = useTimelineStore.getState();
  const existing = timeline.timeline.overlays.find((overlay) => overlay.type === 'audio' && (
    overlay.audioData?.cueId === cue.id
    || (cue.role === 'bgm' && overlay.audioData?.role === 'bgm')
  ));
  if (existing?.assetPath === assetPath) return;
  if (existing) timeline.removeOverlaysByIds([existing.id], { ignoreTrackLock: true });
  timeline.addOverlay({
    type: 'audio', assetPath, trackId: DEFAULT_AUDIO_OVERLAY_TRACK_ID,
    startMs: cue.startMs, durationMs: cue.durationMs ?? sourceDurationMs,
    position: { x: 0, y: 0, width: 0, height: 0 },
    audioData: {
      ...createDefaultAudioOverlayData(sourceDurationMs),
      cueId: cue.id, role: cue.role,
      loop: cue.loop === true && sourceDurationMs < (cue.durationMs ?? sourceDurationMs),
      volume: 10 ** ((cue.volumeDb ?? -12) / 20),
      fadeInMs: cue.fadeInMs ?? 0, fadeOutMs: cue.fadeOutMs ?? 80,
      ...(cue.role === 'bgm' && ducking ? { ducking } : {}),
    },
  });
}

function removeDisabledAudioOverlays(execution: MotionProductionPlan): void {
  const timeline = useTimelineStore.getState();
  const hasBgm = execution.audioPlan.bgm.length > 0;
  const hasEffects = [
    ...execution.audioPlan.ambience,
    ...execution.audioPlan.stingers,
    ...execution.audioPlan.sfx,
  ].length > 0;
  const ids = timeline.timeline.overlays
    .filter((overlay) => overlay.type === 'audio' && Boolean(overlay.audioData?.cueId))
    .filter((overlay) => overlay.audioData?.role === 'bgm' ? !hasBgm : !hasEffects)
    .map((overlay) => overlay.id);
  timeline.removeOverlaysByIds(ids, { ignoreTrackLock: true });
}

async function materializeBgm(
  options: DirectorAudioTrackOptions,
): Promise<Pick<DirectorAudioTrackResult, 'execution' | 'outcome'>> {
  const cue = options.execution.audioPlan.bgm[0];
  if (!options.settings.audioGeneration?.enabled || !cue) {
    return { execution: options.execution, outcome: 'disabled' };
  }
  const request = audioRequestForCue(cue);
  const reusable = (await window.electronAPI.searchReusableMediaAssets({
    projectDir: options.projectDir,
    request,
  }))[0];
  const result = reusable?.score >= 75
    ? { kind: 'reused' as const, ...reusable }
    : await resolveOrGenerateAudioAsset({
        request,
        library: emptyAudioAssetLibrary(),
        projectDir: options.projectDir,
        mode: 'auto',
        music: generationRequestForCue(cue).music,
        pollIntervalMs: options.settings.audioGeneration.pollIntervalMs,
        timeoutMs: options.settings.audioGeneration.timeoutMs,
        deps: {
          createMusic: window.electronAPI.createSunoMusic,
          createSound: window.electronAPI.createSunoSound,
          getTask: window.electronAPI.getSunoAudioTask,
          materialize: window.electronAPI.materializeSunoAudio,
        },
      });
  if (result.kind === 'needs-review') return { execution: options.execution, outcome: result.kind };
  const asset = result.kind === 'reused' ? result.asset : result.assets[0];
  if (!asset) return { execution: options.execution, outcome: 'missing' };
  if (result.kind === 'reused') {
    await window.electronAPI.addAssetToProjectLibrary(options.projectDir, asset.id);
  }
  placeAudioCue(
    cue,
    asset.files.processed || asset.files.original,
    asset.metadata.durationMs ?? options.durationMs,
    options.execution.audioPlan.ducking,
  );
  return {
    outcome: result.kind,
    execution: {
      ...options.execution,
      audioPlan: {
        ...options.execution.audioPlan,
        bgm: options.execution.audioPlan.bgm.map((item) => (
          item.id === cue.id ? { ...item, assetId: asset.id } : item
        )),
      },
    },
  };
}

async function attachReusableSounds(
  projectDir: string,
  execution: MotionProductionPlan,
): Promise<{ execution: MotionProductionPlan; reused: number }> {
  const resolved = new Map<string, string>();
  for (const cue of [...execution.audioPlan.ambience, ...execution.audioPlan.stingers, ...execution.audioPlan.sfx]) {
    const candidate = (await window.electronAPI.searchReusableMediaAssets({
      projectDir,
      request: audioRequestForCue(cue),
    }))[0];
    if (!candidate || candidate.score < 75) continue;
    await window.electronAPI.addAssetToProjectLibrary(projectDir, candidate.asset.id);
    resolved.set(cue.id, candidate.asset.id);
    placeAudioCue(
      cue,
      candidate.asset.files.processed || candidate.asset.files.original,
      candidate.asset.metadata.durationMs ?? cue.durationMs ?? 2_000,
    );
  }
  const patch = (cues: AudioCuePlan[]) => cues.map((cue) => (
    resolved.has(cue.id) ? { ...cue, assetId: resolved.get(cue.id) } : cue
  ));
  return {
    reused: resolved.size,
    execution: {
      ...execution,
      audioPlan: {
        ...execution.audioPlan,
        ambience: patch(execution.audioPlan.ambience),
        stingers: patch(execution.audioPlan.stingers),
        sfx: patch(execution.audioPlan.sfx),
      },
    },
  };
}

export async function runDirectorAudioTrack(
  options: DirectorAudioTrackOptions,
): Promise<DirectorAudioTrackResult> {
  try {
    removeDisabledAudioOverlays(options.execution);
    const hasCues = [
      ...options.execution.audioPlan.bgm,
      ...options.execution.audioPlan.ambience,
      ...options.execution.audioPlan.stingers,
      ...options.execution.audioPlan.sfx,
    ].length > 0;
    if (!hasCues) {
      options.onProgress?.(100, '背景音乐与音效已关闭');
      return { execution: options.execution, outcome: 'disabled', reusedSounds: 0 };
    }
    options.onProgress?.(5, '解析声音方向');
    const bgm = await materializeBgm(options);
    if (options.shouldCancel?.()) {
      return { ...bgm, reusedSounds: 0, error: '制作已暂停' };
    }
    options.onProgress?.(75, '匹配可复用音效');
    const sounds = await attachReusableSounds(options.projectDir, bgm.execution);
    options.onProgress?.(100, '声音资产已就绪');
    return { execution: sounds.execution, outcome: bgm.outcome, reusedSounds: sounds.reused };
  } catch (error) {
    return {
      execution: options.execution,
      outcome: 'missing',
      reusedSounds: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
