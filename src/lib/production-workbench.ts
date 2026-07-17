import type { MediaAssetRequest } from '../types/production';
import type {
  AudioCuePlan,
  MotionProductionPlan,
} from '../types/production';
import { buildMediaReuseKey } from './media-asset-resolution';
import { PODCAST_BGM_NEGATIVE_TAGS } from './production-audio-prompts';
import { rebalanceProductionSoundPlan } from './production-audio-plan';
import type { MusicGenerationRequest, SoundGenerationRequest } from './audio-gen/types';

function transientTypeForCue(cue: AudioCuePlan): string | undefined {
  if (cue.role === 'stinger') return 'chapter-stinger';
  if (cue.role === 'transition-sound') return 'whoosh';
  if (cue.role !== 'sfx') return undefined;
  if (/whoosh|sweep|swish|掠过|转场/iu.test(cue.query)) return 'whoosh';
  if (/riser|上升|渐强/iu.test(cue.query)) return 'riser';
  return 'impact';
}

export function generationRequestForCue(cue: AudioCuePlan): {
  music: MusicGenerationRequest;
  sound: SoundGenerationRequest;
} {
  return {
    music: {
      title: cue.role === 'bgm' ? '播客主 BGM' : cue.query.slice(0, 80),
      style: cue.query,
      model: 'V5',
      negativeTags: PODCAST_BGM_NEGATIVE_TAGS,
    },
    sound: {
      prompt: cue.query,
      soundLoop: cue.role === 'ambience',
    },
  };
}

export function restoreProductionWorkflow(
  plan: MotionProductionPlan,
  persistedMode: 'auto' | 'director' | undefined,
  hasAnimatic: boolean,
): MotionProductionPlan {
  const balanced = rebalanceProductionSoundPlan(plan);
  if (balanced.workflow) return balanced;
  const mode = persistedMode === 'director' ? 'director' : 'auto';
  return {
    ...balanced,
    workflow: {
      mode,
      stage: hasAnimatic ? (mode === 'director' ? 'animatic-review' : 'approved') : 'planning',
      updatedAt: Date.now(),
    },
  };
}

export function audioRequestForCue(cue: AudioCuePlan): MediaAssetRequest {
  const loopable = cue.role === 'bgm' || cue.role === 'ambience';
  const durationRangeMs: [number, number] = loopable
    ? [15_000, Math.max(60_000, cue.durationMs ?? 180_000)]
    : cue.role === 'stinger'
      ? [1_500, 4_000]
      : [200, 2_000];
  return {
    id: cue.id,
    kind: 'audio',
    role: cue.role,
    query: cue.query,
    reusePolicy: 'prefer-library',
    constraints: {
      durationRangeMs,
      loopable,
      transientType: transientTypeForCue(cue),
    },
    reuseKey: cue.reuseKey,
    required: cue.required,
  };
}

function patchCueGroups(
  plan: MotionProductionPlan,
  patch: (cue: AudioCuePlan) => AudioCuePlan,
): MotionProductionPlan {
  return {
    ...plan,
    audioPlan: {
      ...plan.audioPlan,
      bgm: plan.audioPlan.bgm.map(patch),
      ambience: plan.audioPlan.ambience.map(patch),
      stingers: plan.audioPlan.stingers.map(patch),
      sfx: plan.audioPlan.sfx.map(patch),
    },
  };
}

export function updateProductionCue(
  plan: MotionProductionPlan,
  cueId: string,
  patch: Partial<AudioCuePlan>,
): MotionProductionPlan {
  return patchCueGroups(plan, (cue) => {
    if (cue.id !== cueId) return cue;
    const next = 'query' in patch && !('assetId' in patch)
      ? { ...cue, ...patch, assetId: undefined }
      : { ...cue, ...patch };
    if (!('query' in patch)) return next;
    return { ...next, reuseKey: buildMediaReuseKey(audioRequestForCue(next)) };
  });
}

export function updateShotAssetPrompt(
  plan: MotionProductionPlan,
  shotId: string,
  requestId: string,
  query: string,
): MotionProductionPlan {
  return {
    ...plan,
    shots: plan.shots.map((shot) => {
      if (shot.id !== shotId) return shot;
      return {
        ...shot,
        assetRequests: shot.assetRequests.map((request) => {
          if (request.id !== requestId) return request;
          const next = { ...request, query };
          return { ...next, reuseKey: buildMediaReuseKey(next) };
        }),
      };
    }),
  };
}

export function allProductionCues(plan: MotionProductionPlan): AudioCuePlan[] {
  return [
    ...plan.audioPlan.bgm,
    ...plan.audioPlan.ambience,
    ...plan.audioPlan.stingers,
    ...plan.audioPlan.sfx,
  ];
}
