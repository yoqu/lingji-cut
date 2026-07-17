import type { AssetLibraryFile, AssetRecord } from '../../types/assets';
import type { MediaAssetRequest } from '../../types/production';
import type { AudioAssetConstraints } from '../../types/production';
import { findReusableMediaAssets } from '../media-asset-resolution';
import type { AudioTaskStatus, MusicGenerationRequest, SoundGenerationRequest } from './types';

export interface LocalFirstAudioDeps {
  createMusic: (request: MusicGenerationRequest) => Promise<{ taskId: string }>;
  createSound: (request: SoundGenerationRequest) => Promise<{ taskId: string }>;
  getTask: (taskId: string) => Promise<AudioTaskStatus>;
  materialize: (args: {
    taskId: string;
    projectDir?: string | null;
    role: 'bgm' | 'stinger' | 'sfx' | 'ambience' | 'transition-sound';
    query: string;
    reuseKey: string;
    audio?: {
      energy?: 1 | 2 | 3;
      transientType?: string | null;
    };
  }) => Promise<AssetRecord[]>;
  sleep?: (ms: number) => Promise<void>;
}

export type LocalFirstAudioResult =
  | { kind: 'reused'; asset: AssetRecord; score: number; reasons: string[] }
  | { kind: 'needs-review'; candidates: ReturnType<typeof findReusableMediaAssets> }
  | { kind: 'generated'; assets: AssetRecord[]; taskId: string };

const inFlightGenerations = new Map<string, Promise<LocalFirstAudioResult>>();

export function emptyAudioAssetLibrary(): AssetLibraryFile {
  return {
    version: 2,
    libraryId: 'normalized-empty',
    settings: {
      rootDir: '',
      defaultImportMode: 'copy',
      defaultProjectReferenceMode: 'reference-global',
    },
    assets: [],
    updatedAt: new Date().toISOString(),
  };
}

async function waitForTask(
  taskId: string,
  deps: LocalFirstAudioDeps,
  pollIntervalMs: number,
  timeoutMs: number,
): Promise<AudioTaskStatus> {
  const startedAt = Date.now();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (Date.now() - startedAt < timeoutMs) {
    const status = await deps.getTask(taskId);
    if (status.state === 'succeeded') return status;
    if (status.state === 'failed') throw new Error(status.errorMessage || `音频生成失败（${status.vendorStatus}）`);
    await sleep(pollIntervalMs);
  }
  throw new Error(`音频任务 ${taskId} 超过 ${Math.round(timeoutMs / 1000)} 秒仍未完成`);
}

function isMusicRole(role: string): role is 'bgm' | 'stinger' {
  return role === 'bgm' || role === 'stinger';
}

export async function resolveOrGenerateAudioAsset(args: {
  request: MediaAssetRequest;
  library: AssetLibraryFile;
  projectDir?: string | null;
  mode: 'auto' | 'director';
  music?: MusicGenerationRequest;
  sound?: SoundGenerationRequest;
  pollIntervalMs?: number;
  timeoutMs?: number;
  deps: LocalFirstAudioDeps;
}): Promise<LocalFirstAudioResult> {
  if (args.request.kind !== 'audio') throw new Error('本地优先音频流程只接受 audio 请求');
  const role = args.request.role as 'bgm' | 'stinger' | 'sfx' | 'ambience' | 'transition-sound';
  const candidates = findReusableMediaAssets(args.request, args.library);
  if (candidates[0]?.score >= 75) {
    return { kind: 'reused', ...candidates[0] };
  }
  if (args.mode === 'director' && candidates.length > 0) return { kind: 'needs-review', candidates };
  if (args.request.reusePolicy === 'manual-only') return { kind: 'needs-review', candidates };

  const existing = inFlightGenerations.get(args.request.reuseKey);
  if (existing) return existing;
  const generation = (async (): Promise<LocalFirstAudioResult> => {
    const task = isMusicRole(role)
      ? await args.deps.createMusic(args.music ?? {
          title: args.request.query,
          style: args.request.query,
        })
      : await args.deps.createSound(args.sound ?? { prompt: args.request.query });
    await waitForTask(
      task.taskId,
      args.deps,
      args.pollIntervalMs ?? 10_000,
      args.timeoutMs ?? 600_000,
    );
    const assets = await args.deps.materialize({
      taskId: task.taskId,
      projectDir: args.projectDir,
      role,
      query: args.request.query,
      reuseKey: args.request.reuseKey,
      audio: {
        energy: (args.request.constraints as AudioAssetConstraints).energy,
        transientType: (args.request.constraints as AudioAssetConstraints).transientType,
      },
    });
    return { kind: 'generated', assets, taskId: task.taskId };
  })();
  inFlightGenerations.set(args.request.reuseKey, generation);
  try {
    return await generation;
  } finally {
    if (inFlightGenerations.get(args.request.reuseKey) === generation) {
      inFlightGenerations.delete(args.request.reuseKey);
    }
  }
}
