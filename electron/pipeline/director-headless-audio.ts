import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importGeneratedMediaAsset, resolveReusableMediaAssetForProject } from '../asset-library';
import { createSunoApiProvider } from '../../src/lib/audio-gen/sunoapi';
import { normalizeSunoAudioSettings } from '../../src/lib/audio-gen/settings';
import type { AudioCandidate, AudioGenerationProvider } from '../../src/lib/audio-gen/types';
import { audioRequestForCue, generationRequestForCue } from '../../src/lib/production-workbench';
import type { AISettings } from '../../src/types/ai';
import type { AssetRecord } from '../../src/types/assets';
import type { AudioCuePlan, MotionProductionPlan } from '../../src/types/production';
import type { HeadlessAudioPlacement } from './director-headless-timeline';

export interface HeadlessAudioResult {
  execution: MotionProductionPlan;
  placements: HeadlessAudioPlacement[];
  outcome: 'disabled' | 'reused' | 'generated' | 'missing';
  reusedSounds: number;
  error?: string;
}

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus']);

function safeFileName(value: string): string {
  return value.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64) || 'audio';
}

function assetPlacement(cue: AudioCuePlan, asset: AssetRecord): HeadlessAudioPlacement {
  return {
    cue,
    assetPath: asset.files.processed || asset.files.original,
    sourceDurationMs: asset.metadata.durationMs ?? cue.durationMs ?? 2_000,
  };
}

function patchCues(
  execution: MotionProductionPlan,
  assets: Map<string, AssetRecord>,
): MotionProductionPlan {
  const patch = (cue: AudioCuePlan) => {
    const asset = assets.get(cue.id);
    return asset ? { ...cue, assetId: asset.id } : cue;
  };
  return {
    ...execution,
    audioPlan: {
      ...execution.audioPlan,
      bgm: execution.audioPlan.bgm.map(patch),
      ambience: execution.audioPlan.ambience.map(patch),
      stingers: execution.audioPlan.stingers.map(patch),
      sfx: execution.audioPlan.sfx.map(patch),
    },
  };
}

async function waitForAudio(options: {
  provider: Pick<AudioGenerationProvider, 'getMusicTask'>;
  taskId: string;
  pollIntervalMs: number;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<AudioCandidate> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < options.timeoutMs) {
    if (options.signal.aborted) throw new DOMException('制作已暂停', 'AbortError');
    const status = await options.provider.getMusicTask(options.taskId);
    if (status.state === 'succeeded') {
      const candidate = status.candidates[0];
      if (!candidate) throw new Error('声音任务完成但没有可用候选');
      return candidate;
    }
    if (status.state === 'failed') {
      throw new Error(status.errorMessage || `声音任务失败（${status.vendorStatus}）`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, options.pollIntervalMs));
  }
  throw new Error(`声音任务超过 ${Math.round(options.timeoutMs / 1_000)} 秒仍未完成`);
}

async function downloadCandidate(candidate: AudioCandidate, taskId: string): Promise<string> {
  const url = new URL(candidate.audioUrl);
  if (url.protocol !== 'https:') throw new Error('声音下载地址必须使用 HTTPS');
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`声音下载失败（HTTP ${response.status}）`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > 100 * 1024 * 1024) throw new Error('声音文件超过 100MB 安全限制');
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && !contentType.startsWith('audio/') && !contentType.includes('octet-stream')) {
    throw new Error(`生成结果不是音频（${contentType}）`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > 100 * 1024 * 1024) throw new Error('声音文件大小异常');
  const dir = path.join(os.tmpdir(), 'lingji-headless-audio');
  await fs.mkdir(dir, { recursive: true });
  const candidateExtension = path.extname(url.pathname).toLowerCase();
  const ext = AUDIO_EXTENSIONS.has(candidateExtension) ? candidateExtension : '.mp3';
  const filePath = path.join(
    dir,
    `${safeFileName(taskId)}-${safeFileName(candidate.id || 'bgm')}${ext}`,
  );
  await fs.writeFile(filePath, buffer);
  return filePath;
}

async function generateBgm(options: {
  cue: AudioCuePlan;
  projectPath: string;
  provider: AudioGenerationProvider;
  settings: ReturnType<typeof normalizeSunoAudioSettings>;
  signal: AbortSignal;
}): Promise<AssetRecord> {
  const request = generationRequestForCue(options.cue).music;
  const task = await options.provider.createMusic(request);
  const candidate = await waitForAudio({
    provider: options.provider,
    taskId: task.taskId,
    pollIntervalMs: options.settings.pollIntervalMs ?? 10_000,
    timeoutMs: options.settings.timeoutMs ?? 600_000,
    signal: options.signal,
  });
  const filePath = await downloadCandidate(candidate, task.taskId);
  try {
    return await importGeneratedMediaAsset({
      filePath,
      projectDir: options.projectPath,
      name: candidate.title || '播客主 BGM',
      role: 'bgm',
      reuseKey: options.cue.reuseKey,
      semantic: { tags: [options.cue.query, 'bgm'], style: candidate.tags ? [candidate.tags] : [] },
      licenseNote: 'SunoAPI.org 生成；商业使用权由当前账号条款决定。',
      provenance: {
        provider: 'sunoapi',
        model: candidate.modelName || options.settings.musicModel,
        taskId: task.taskId,
        promptHash: createHash('sha256').update(options.cue.query).digest('hex'),
        generatedAt: new Date().toISOString(),
      },
      audio: { loopable: false },
    }, null);
  } finally {
    await fs.rm(filePath, { force: true }).catch(() => undefined);
  }
}

async function resolveCue(projectPath: string, cue: AudioCuePlan): Promise<AssetRecord | null> {
  const candidate = await resolveReusableMediaAssetForProject({
    projectDir: projectPath,
    request: audioRequestForCue(cue),
    minScore: 75,
  });
  return candidate?.asset ?? null;
}

export async function runHeadlessDirectorAudio(options: {
  projectPath: string;
  settings: AISettings;
  execution: MotionProductionPlan;
  signal: AbortSignal;
  onProgress?: (percent: number, message: string) => void;
}): Promise<HeadlessAudioResult> {
  const hasCues = [
    ...options.execution.audioPlan.bgm,
    ...options.execution.audioPlan.ambience,
    ...options.execution.audioPlan.stingers,
    ...options.execution.audioPlan.sfx,
  ].length > 0;
  if (!hasCues) {
    return { execution: options.execution, placements: [], outcome: 'disabled', reusedSounds: 0 };
  }
  const config = normalizeSunoAudioSettings(options.settings.audioGeneration);
  if (!config.enabled) {
    return { execution: options.execution, placements: [], outcome: 'disabled', reusedSounds: 0 };
  }
  try {
    const assets = new Map<string, AssetRecord>();
    const bgm = options.execution.audioPlan.bgm[0];
    let outcome: HeadlessAudioResult['outcome'] = 'missing';
    if (bgm) {
      options.onProgress?.(10, '匹配可复用 BGM');
      const reusable = await resolveCue(options.projectPath, bgm);
      const asset = reusable ?? await generateBgm({
        cue: bgm,
        projectPath: options.projectPath,
        provider: createSunoApiProvider(config),
        settings: config,
        signal: options.signal,
      });
      assets.set(bgm.id, asset);
      outcome = reusable ? 'reused' : 'generated';
    }
    const sounds = [
      ...options.execution.audioPlan.ambience,
      ...options.execution.audioPlan.stingers,
      ...options.execution.audioPlan.sfx,
    ];
    for (let index = 0; index < sounds.length; index += 1) {
      if (options.signal.aborted) throw new DOMException('制作已暂停', 'AbortError');
      const asset = await resolveCue(options.projectPath, sounds[index]);
      if (asset) assets.set(sounds[index].id, asset);
      options.onProgress?.(70 + Math.round(((index + 1) / Math.max(1, sounds.length)) * 30), '匹配可复用音效');
    }
    const execution = patchCues(options.execution, assets);
    const cueById = new Map([
      ...execution.audioPlan.bgm,
      ...execution.audioPlan.ambience,
      ...execution.audioPlan.stingers,
      ...execution.audioPlan.sfx,
    ].map((cue) => [cue.id, cue]));
    return {
      execution,
      placements: [...assets].map(([cueId, asset]) => assetPlacement(cueById.get(cueId)!, asset)),
      outcome,
      reusedSounds: [...assets.keys()].filter((id) => id !== bgm?.id).length,
    };
  } catch (error) {
    return {
      execution: options.execution,
      placements: [],
      outcome: 'missing',
      reusedSounds: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
