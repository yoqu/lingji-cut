export interface ChunkExecutionConfig {
  workers: number;
  concurrency: number;
  totalPages: number;
}

function positiveInteger(value?: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveFramesPerChunk(fps: number, secondsEnv?: string): number {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('fps must be positive');
  const seconds = Number(secondsEnv);
  const boundedSeconds = Number.isFinite(seconds) && seconds >= 5 && seconds <= 300
    ? seconds
    : 60;
  return Math.max(1, Math.round(fps * boundedSeconds));
}

export function resolveChunkExecutionConfig(
  cpuCount: number,
  workersEnv?: string,
  concurrencyEnv?: string,
): ChunkExecutionConfig {
  const normalizedCpu = Number.isFinite(cpuCount) ? Math.max(1, Math.floor(cpuCount)) : 1;
  let workers = positiveInteger(workersEnv)
    ?? (normalizedCpu <= 2 ? 1 : normalizedCpu >= 24 ? 3 : 2);
  const automaticConcurrency = normalizedCpu <= 2 ? 1 : normalizedCpu >= 16 ? 5 : 3;
  let concurrency = positiveInteger(concurrencyEnv) ?? automaticConcurrency;
  workers = Math.min(6, workers);
  concurrency = Math.min(8, concurrency);
  const maxTotalPages = 16;
  if (workers * concurrency > maxTotalPages) {
    concurrency = Math.max(1, Math.floor(maxTotalPages / workers));
  }
  return { workers, concurrency, totalPages: workers * concurrency };
}

export async function runChunkPool<T>(
  items: readonly T[],
  workers: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error('workers must be a positive integer');
  }
  let cursor = 0;
  let firstError: unknown = null;
  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, async () => {
      while (cursor < items.length && firstError === null) {
        const item = items[cursor];
        cursor += 1;
        try {
          await run(item);
        } catch (error) {
          firstError ??= error;
        }
      }
    }),
  );
  if (firstError !== null) throw firstError;
}

export interface ChunkRenderAttempt {
  concurrency: number;
  encoder: 'h264_nvenc' | 'libx264';
  useAngle: boolean;
}

export type ChunkFallback = 'single-page' | 'cpu-encoder' | 'default-gl' | 'retry';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEncoderFailure(error: unknown): boolean {
  return /nvenc|encoder|preset|cuda|unsupported param/i.test(errorMessage(error));
}

function isGpuFailure(error: unknown): boolean {
  return /angle|gpu|webgl|context|crash|connection reset|no response/i.test(errorMessage(error));
}

export async function renderChunkWithFallback<T>(
  initial: ChunkRenderAttempt,
  render: (attempt: ChunkRenderAttempt) => Promise<T>,
): Promise<{ value: T; attempt: ChunkRenderAttempt; fallbacks: ChunkFallback[] }> {
  let attempt = { ...initial, concurrency: Math.max(1, Math.floor(initial.concurrency)) };
  const fallbacks: ChunkFallback[] = [];
  let genericRetried = false;

  // At most: initial, single-page, CPU encoder, default GL, one generic retry.
  for (let attemptIndex = 0; attemptIndex < 5; attemptIndex += 1) {
    try {
      return { value: await render(attempt), attempt, fallbacks };
    } catch (error) {
      if (attempt.concurrency > 1) {
        attempt = { ...attempt, concurrency: 1 };
        fallbacks.push('single-page');
        continue;
      }
      if (attempt.encoder === 'h264_nvenc' && isEncoderFailure(error)) {
        attempt = { ...attempt, encoder: 'libx264' };
        fallbacks.push('cpu-encoder');
        continue;
      }
      if (attempt.useAngle && isGpuFailure(error)) {
        attempt = { ...attempt, useAngle: false };
        fallbacks.push('default-gl');
        continue;
      }
      if (!genericRetried) {
        genericRetried = true;
        fallbacks.push('retry');
        continue;
      }
      throw error;
    }
  }
  throw new Error('Chunk render exhausted its bounded fallback attempts');
}

export interface ChunkedVideoRenderParams {
  composition: SelectedRemotionComposition;
  serveUrl: string;
  outputPath: string;
  input: ChunkRenderInput;
  framesPerChunk: number;
  workers: number;
  concurrency: number;
  scale: number;
  x264Preset: 'ultrafast' | 'veryfast' | 'medium';
  quality: ExportQualityPreset;
  videoBitrate: string;
  audioBitrate: string;
  jpegQuality: number;
  encoder: 'h264_nvenc' | 'libx264';
  ffprobePath: string;
  binariesDirectory?: string;
  browserExecutable?: string;
  platform?: NodeJS.Platform;
  emit?: (kind: string, extra?: Record<string, unknown>) => void;
  onProgress?: (ratio: number) => void;
}

interface ChunkedVideoRenderDependencies {
  renderChunk?: typeof renderRemotionChunk;
  probeChunk?: typeof probeChunkMedia;
  combine?: typeof combineRemotionChunks;
}

interface RenderedChunkLocation {
  startFrame: number;
  videoPath: string;
  audioPath: string;
}

export async function renderChunkedVideo(
  params: ChunkedVideoRenderParams,
  deps: ChunkedVideoRenderDependencies = {},
): Promise<{
  totalFrames: number;
  fps: number;
  chunks: number;
  renderedChunks: number;
}> {
  const renderChunk = deps.renderChunk ?? renderRemotionChunk;
  const probeChunk = deps.probeChunk ?? probeChunkMedia;
  const combine = deps.combine ?? combineRemotionChunks;
  const emit = params.emit ?? (() => undefined);
  const totalFrames = params.composition.durationInFrames;
  const fps = params.composition.fps;
  const chunks = planRenderChunks(totalFrames, params.framesPerChunk);
  const jobs = chunks.map((chunk) => ({
    chunk,
    input: sliceChunkInput(params.input, chunk, fps),
  }));
  const fullPropsBytes = Buffer.byteLength(JSON.stringify(params.input));
  const chunkPropsBytes = jobs.map((job) => Buffer.byteLength(JSON.stringify(job.input)));
  emit('export.chunk.plan', {
    framesPerChunk: params.framesPerChunk,
    chunks: chunks.length,
    workers: params.workers,
    concurrency: params.concurrency,
    totalPages: params.workers * params.concurrency,
    fullPropsBytes,
    averageChunkPropsBytes: Math.round(
      chunkPropsBytes.reduce((sum, value) => sum + value, 0) / Math.max(1, chunkPropsBytes.length),
    ),
  });

  const progressByChunk = Array.from({ length: chunks.length }, () => 0);
  const reportProgress = () => {
    const completedFrames = chunks.reduce(
      (sum, chunk, index) => sum + chunk.frameCount * progressByChunk[index],
      0,
    );
    params.onProgress?.(Math.max(0, Math.min(0.95, (completedFrames / totalFrames) * 0.95)));
  };
  const locations: RenderedChunkLocation[] = new Array(chunks.length);
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lingji-render-chunks-'));
  let renderedChunks = 0;
  let chunksStageEnded = false;
  const chunksStartedAt = Date.now();
  emit('stage.start', { stage: 'export.render.chunks' });

  try {
    await runChunkPool(jobs, params.workers, async ({ chunk, input }) => {
      const propsBytes = Buffer.byteLength(JSON.stringify(input));
      const preferredAttempt: ChunkRenderAttempt = {
        concurrency: params.concurrency,
        encoder: params.encoder,
        useAngle: params.platform === 'win32',
      };
      emit('export.chunk.start', {
        index: chunk.index,
        startFrame: chunk.startFrame,
        endFrame: chunk.endFrame,
        frameCount: chunk.frameCount,
        propsBytes,
        overlays: input.timeline.overlays.length,
        subtitles: input.srtEntries.length,
        compiledCards: Object.keys(input.compiledCards).length,
      });
      const chunkWorkDir = await fs.mkdtemp(
        path.join(workRoot, `chunk-${String(chunk.index).padStart(4, '0')}-`),
      );
      const videoSource = path.join(chunkWorkDir, 'video.ts');
      const audioSource = path.join(chunkWorkDir, 'audio.aac');
      const startedAt = Date.now();
      try {
        const outcome = await renderChunkWithFallback(preferredAttempt, async (attempt) => {
          await Promise.all([
            fs.rm(videoSource, { force: true }),
            fs.rm(audioSource, { force: true }),
          ]);
          const result = await renderChunk({
            composition: params.composition,
            serveUrl: params.serveUrl,
            outputPath: videoSource,
            audioPath: audioSource,
            input,
            chunk,
            scale: params.scale,
            x264Preset: params.x264Preset,
            quality: params.quality,
            videoBitrate: params.videoBitrate,
            audioBitrate: params.audioBitrate,
            jpegQuality: params.jpegQuality,
            concurrency: attempt.concurrency,
            encoder: attempt.encoder,
            binariesDirectory: params.binariesDirectory,
            browserExecutable: params.browserExecutable,
            platform: params.platform,
            useAngle: attempt.useAngle,
            onProgress: ({ ratio }) => {
              progressByChunk[chunk.index] = ratio;
              reportProgress();
            },
          });
          const probe = await probeChunk(params.ffprobePath, { videoPath: videoSource, audioPath: audioSource });
          if (!probe.ok) throw new Error(probe.error ?? 'Rendered chunk failed ffprobe validation');
          return result;
        });
        renderedChunks += 1;
        locations[chunk.index] = {
          startFrame: chunk.startFrame,
          videoPath: videoSource,
          audioPath: audioSource,
        };
        progressByChunk[chunk.index] = 1;
        reportProgress();
        const durationMs = Date.now() - startedAt;
        const browserLogs: BrowserLogSummary = outcome.value.browserLogs;
        emit('export.gpu.probe', {
          index: chunk.index,
          requestedGl: outcome.attempt.useAngle ? 'angle' : 'default',
          renderer: browserLogs.gpuRenderer,
          hardwareGpu: browserLogs.hardwareGpu,
        });
        emit('export.chunk.end', {
          index: chunk.index,
          startFrame: chunk.startFrame,
          endFrame: chunk.endFrame,
          frameCount: chunk.frameCount,
          durationMs,
          renderFps: Math.round((chunk.frameCount / Math.max(1, durationMs)) * 10_000) / 10,
          ok: true,
          propsBytes,
          encoder: outcome.attempt.encoder,
          gl: outcome.attempt.useAngle ? 'angle' : 'default',
          concurrency: outcome.attempt.concurrency,
          fallbacks: outcome.fallbacks,
          browserLogs,
          slowestFrames: outcome.value.slowestFrames.slice(0, 5),
        });
      } catch (error) {
        emit('export.chunk.end', {
          index: chunk.index,
          startFrame: chunk.startFrame,
          endFrame: chunk.endFrame,
          frameCount: chunk.frameCount,
          durationMs: Date.now() - startedAt,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
    emit('stage.end', {
      stage: 'export.render.chunks',
      durationMs: Date.now() - chunksStartedAt,
      ok: true,
      chunks: chunks.length,
      renderedChunks,
    });
    chunksStageEnded = true;

    const combineStartedAt = Date.now();
    emit('stage.start', { stage: 'export.combine' });
    try {
      await combine({
        chunks: locations,
        outputPath: params.outputPath,
        fps,
        framesPerChunk: params.framesPerChunk,
        compositionDurationInFrames: totalFrames,
        audioBitrate: params.audioBitrate,
        binariesDirectory: params.binariesDirectory,
        onProgress: (ratio) => params.onProgress?.(0.95 + Math.max(0, Math.min(1, ratio)) * 0.05),
      });
      emit('stage.end', {
        stage: 'export.combine',
        durationMs: Date.now() - combineStartedAt,
        ok: true,
      });
    } catch (error) {
      emit('stage.end', {
        stage: 'export.combine',
        durationMs: Date.now() - combineStartedAt,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    return { totalFrames, fps, chunks: chunks.length, renderedChunks };
  } catch (error) {
    if (!chunksStageEnded) {
      emit('stage.end', {
        stage: 'export.render.chunks',
        durationMs: Date.now() - chunksStartedAt,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }
}
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChunkRenderInput, RenderChunk } from './chunk-plan';
import { planRenderChunks, sliceChunkInput } from './chunk-plan';
import {
  combineRemotionChunks,
  renderRemotionChunk,
  type BrowserLogSummary,
  type SelectedRemotionComposition,
} from './render';
import { probeChunkMedia, type ExportQualityPreset } from './gpu-runtime';
