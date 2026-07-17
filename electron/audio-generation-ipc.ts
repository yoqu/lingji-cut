import { app, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadGlobalSettings } from './global-settings';
import { importGeneratedMediaAsset } from './asset-library';
import { normalizeSunoAudioSettings } from '../src/lib/audio-gen/settings';
import { createSunoApiProvider } from '../src/lib/audio-gen/sunoapi';
import type {
  AudioCandidate,
  AudioGenerationProvider,
  AudioGenerationSmokeTestResult,
  AudioTaskStatus,
  MusicGenerationRequest,
  SoundGenerationRequest,
} from '../src/lib/audio-gen/types';
import type { AssetRole } from '../src/types/assets';
import { readAudioDurationMs } from './media-duration';

export interface AudioGenerationIpcContext {
  resolveRuntimeBinaries: () => { ffprobePath: string | null; ffmpegPath?: string | null };
  writeAppLog: (level: 'info' | 'warn' | 'error', scope: string, message: string, details?: string) => void;
}

async function providerFromSettings() {
  const global = await loadGlobalSettings(app.getPath('userData'));
  const settings = normalizeSunoAudioSettings(global?.aiSettings?.audioGeneration);
  if (!settings.enabled) throw new Error('请先在 AI 基础配置中启用 SunoAPI.org');
  return {
    provider: createSunoApiProvider(settings),
    settings,
  };
}

function safeName(value: string): string {
  return value.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64) || 'audio';
}

async function fetchCandidate(url: URL): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt));
    }
  }
  const details = lastError instanceof Error ? `：${lastError.message}` : '';
  throw new Error(`下载生成音频失败${details}`);
}

async function downloadCandidate(candidate: AudioCandidate, taskId: string): Promise<string> {
  const url = new URL(candidate.audioUrl);
  if (url.protocol !== 'https:') throw new Error('供应商音频下载地址必须使用 HTTPS');
  const response = await fetchCandidate(url);
  if (!response.ok || !response.body) throw new Error(`下载生成音频失败（HTTP ${response.status}）`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > 100 * 1024 * 1024) throw new Error('生成音频超过 100MB 安全限制');
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && !contentType.startsWith('audio/') && !contentType.includes('octet-stream')) {
    throw new Error(`生成结果不是音频（${contentType}）`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0 || buffer.byteLength > 100 * 1024 * 1024) throw new Error('生成音频大小异常');
  const tempDir = path.join(os.tmpdir(), 'lingji-sunoapi');
  await fs.mkdir(tempDir, { recursive: true });
  const ext = path.extname(url.pathname).toLowerCase() || '.mp3';
  const filePath = path.join(tempDir, `${safeName(taskId)}-${safeName(candidate.id)}${ext}`);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

function promptHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function pollSunoAudioTask(args: {
  provider: Pick<AudioGenerationProvider, 'getMusicTask'>;
  taskId: string;
  pollIntervalMs: number;
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<AudioTaskStatus> {
  const startedAt = Date.now();
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (Date.now() - startedAt < args.timeoutMs) {
    const status = await args.provider.getMusicTask(args.taskId);
    if (status.state === 'succeeded') return status;
    if (status.state === 'failed') {
      throw new Error(status.errorMessage || `音效生成失败（${status.vendorStatus}）`);
    }
    await sleep(args.pollIntervalMs);
  }
  throw new Error(`SunoAPI 音效任务超过 ${Math.round(args.timeoutMs / 1_000)} 秒仍未完成`);
}

async function runAudioGenerationSmokeTest(
  ctx: AudioGenerationIpcContext,
): Promise<AudioGenerationSmokeTestResult> {
  const { provider, settings } = await providerFromSettings();
  const creditsBefore = await provider.getCredits();
  const task = await provider.createSound({
    prompt: 'A single clean soft UI confirmation chime, no voice, no ambience, short decay',
    soundLoop: false,
    soundKey: 'Any',
  });
  const status = await pollSunoAudioTask({
    provider,
    taskId: task.taskId,
    pollIntervalMs: Math.min(settings.pollIntervalMs ?? 10_000, 5_000),
    timeoutMs: settings.timeoutMs ?? 600_000,
  });
  const candidate = status.candidates[0];
  if (!candidate) throw new Error('SunoAPI 任务完成，但没有返回可下载音效');
  const filePath = await downloadCandidate(candidate, task.taskId);
  try {
    const { ffprobePath } = ctx.resolveRuntimeBinaries();
    const [durationMs, stat, creditsRemaining] = await Promise.all([
      readAudioDurationMs(filePath, { ffprobePath }),
      fs.stat(filePath),
      provider.getCredits(),
    ]);
    ctx.writeAppLog(
      'info',
      'audio-generation',
      `SunoAPI 完整链路测试通过：${durationMs}ms / ${stat.size} bytes`,
      `taskId=${task.taskId}`,
    );
    return {
      taskId: task.taskId,
      candidateCount: status.candidates.length,
      durationMs,
      fileSizeBytes: stat.size,
      creditsBefore,
      creditsRemaining,
    };
  } finally {
    await fs.rm(filePath, { force: true }).catch(() => undefined);
  }
}

async function createLoopDerivative(args: {
  sourcePath: string;
  taskId: string;
  candidateId: string;
  durationSeconds?: number;
  ffmpegPath?: string | null;
}): Promise<{ filePath: string; durationMs: number } | null> {
  if (!args.ffmpegPath || !args.durationSeconds || args.durationSeconds < 4) return null;
  const fade = Math.min(2, Math.max(0.5, args.durationSeconds * 0.05));
  const bodyEnd = args.durationSeconds - fade;
  const outputPath = path.join(
    os.tmpdir(),
    'lingji-sunoapi',
    `${safeName(args.taskId)}-${safeName(args.candidateId)}-loop.flac`,
  );
  const filter = [
    '[0:a]asplit=3[head][body][tail]',
    `[head]atrim=0:${fade},asetpts=PTS-STARTPTS[head1]`,
    `[body]atrim=start=${fade}:end=${bodyEnd},asetpts=PTS-STARTPTS[body1]`,
    `[tail]atrim=start=${bodyEnd}:end=${args.durationSeconds},asetpts=PTS-STARTPTS[tail1]`,
    `[tail1][head1]acrossfade=d=${fade}:c1=tri:c2=tri[wrap]`,
    '[body1][wrap]concat=n=2:v=0:a=1[out]',
  ].join(';');
  const code = await new Promise<number>((resolve) => {
    const child = spawn(args.ffmpegPath!, [
      '-y', '-v', 'error', '-i', args.sourcePath,
      '-filter_complex', filter, '-map', '[out]', outputPath,
    ], { stdio: 'ignore' });
    child.on('error', () => resolve(-1));
    child.on('close', (exitCode) => resolve(exitCode ?? -1));
  });
  if (code !== 0) {
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
    return null;
  }
  return { filePath: outputPath, durationMs: Math.round((args.durationSeconds - fade) * 1_000) };
}

export function registerAudioGenerationIpc(ctx: AudioGenerationIpcContext): void {
  ipcMain.handle('audio-generation:create-music', async (_event, request: MusicGenerationRequest) => {
    const { provider } = await providerFromSettings();
    return provider.createMusic(request);
  });
  ipcMain.handle('audio-generation:create-sound', async (_event, request: SoundGenerationRequest) => {
    const { provider } = await providerFromSettings();
    return provider.createSound(request);
  });
  ipcMain.handle('audio-generation:get-task', async (_event, taskId: string) => {
    const { provider } = await providerFromSettings();
    return provider.getMusicTask(taskId);
  });
  ipcMain.handle('audio-generation:get-credits', async () => {
    const { provider } = await providerFromSettings();
    return provider.getCredits();
  });
  ipcMain.handle('audio-generation:smoke-test', async () => runAudioGenerationSmokeTest(ctx));
  ipcMain.handle('audio-generation:materialize', async (_event, args: {
    taskId: string;
    projectDir?: string | null;
    role: Extract<AssetRole, 'bgm' | 'stinger' | 'sfx' | 'ambience' | 'transition-sound'>;
    query: string;
    reuseKey: string;
    audio?: Pick<NonNullable<import('../src/types/assets').AssetMetadata['audio']>, 'energy' | 'transientType'>;
  }) => {
    const { provider, settings } = await providerFromSettings();
    const status = await provider.getMusicTask(args.taskId);
    if (status.state !== 'succeeded' || status.candidates.length === 0) {
      throw new Error(status.errorMessage || `音频任务尚未完成（${status.vendorStatus}）`);
    }
    const variantGroupId = `suno-${args.taskId}`;
    const imported = [];
    const { ffprobePath, ffmpegPath } = ctx.resolveRuntimeBinaries();
    for (const candidate of status.candidates) {
      const filePath = await downloadCandidate(candidate, args.taskId);
      const provenance = {
        provider: 'sunoapi',
        model: candidate.modelName || settings.musicModel,
        taskId: args.taskId,
        promptHash: promptHash(args.query),
        requestHash: promptHash(`${args.role}:${args.reuseKey}`),
        variantGroupId,
        generatedAt: new Date().toISOString(),
      };
      const loopDerivative = ['bgm', 'ambience'].includes(args.role)
        ? await createLoopDerivative({
            sourcePath: filePath,
            taskId: args.taskId,
            candidateId: candidate.id,
            durationSeconds: candidate.durationSeconds,
            ffmpegPath,
          })
        : null;
      if (loopDerivative) {
        const derivative = await importGeneratedMediaAsset({
          filePath: loopDerivative.filePath,
          projectDir: args.projectDir,
          name: `${candidate.title || args.query}（循环版）`,
          role: args.role,
          reuseKey: args.reuseKey,
          semantic: { tags: [args.query, args.role, 'loopable'], style: candidate.tags ? [candidate.tags] : [] },
          licenseNote: 'SunoAPI.org 生成；循环版由本地 ffmpeg 处理；商业使用权由当前账号条款决定。',
          provenance,
          audio: {
            ...args.audio,
            loopable: true,
            loopStartMs: 0,
            loopEndMs: loopDerivative.durationMs,
          },
        }, ffprobePath, ffmpegPath);
        imported.push(derivative);
        await fs.rm(loopDerivative.filePath, { force: true }).catch(() => undefined);
      }
      const asset = await importGeneratedMediaAsset({
        filePath,
        projectDir: args.projectDir,
        name: candidate.title || args.query,
        role: args.role,
        reuseKey: args.reuseKey,
        semantic: { tags: [args.query, args.role], style: candidate.tags ? [candidate.tags] : [] },
        licenseNote: 'SunoAPI.org 生成；商业使用权由当前账号条款决定。',
        provenance,
        audio: { ...args.audio, loopable: false },
      }, ffprobePath, ffmpegPath);
      imported.push(asset);
      await fs.rm(filePath, { force: true }).catch(() => undefined);
    }
    ctx.writeAppLog('info', 'audio-generation', `SunoAPI 音频已本地化并入库：${imported.length} 个`, `taskId=${args.taskId}`);
    return imported;
  });
}
