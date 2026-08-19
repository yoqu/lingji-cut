import { combineChunks, selectComposition, renderMedia } from '@remotion/renderer';
import type { SrtEntry, TimelineData } from '../../src/types';
import type { ChunkRenderInput, RenderChunk } from './chunk-plan';
import {
  chromiumOptionsForPlatform,
  classifyGpuRenderer,
  createH264TsFfmpegOverride,
  type ChunkVideoEncoder,
  type ExportQualityPreset,
} from './gpu-runtime';

export interface RemotionRenderParams {
  serveUrl: string;
  outputPath: string;
  timeline: TimelineData;
  srtEntries: SrtEntry[];
  compiledCards: Record<string, string>;
  /** 项目级视觉主题预设 id（project.json 的 stylePresetId）；字幕 followTheme 渲染用。 */
  themePresetId?: string;
  /**
   * 缩放比例：React 树仍按 timeline 原始 width/height 渲染，
   * 导出拍照时按 scale 像素化（最终导出尺寸 = 原始尺寸 × scale）。
   * 由 buildExportRenderConfig 算 renderWidth 后用 renderWidth/timelineWidth 得出。
   * 好处：所有 px 字号/padding/偏移完全不动，预览与导出 1:1 一致。
   */
  scale: number;
  /** x264 编码 preset；硬件加速可用时 ffmpeg 会忽略，但软编回退仍受益。 */
  x264Preset: 'ultrafast' | 'veryfast' | 'medium';
  /** 视频码率，形如 '1800k' / '3000k' / '4500k'；与 crf 互斥，硬件加速路径下必填。 */
  videoBitrate: string;
  audioBitrate: string;
  /** Chromium 截帧 JPEG 质量（1-100），只影响截帧速度与中间帧画质，不改变输出码率。 */
  jpegQuality: number;
  concurrency: number;
  /**
   * 硬件加速策略：'if-possible' 表示能用就用、不能就软编回退，零失败风险；
   * 'disable' 强制软编；'required' 拿不到 GPU 时直接报错。
   */
  hardwareAcceleration: 'disable' | 'if-possible' | 'required';
  /**
   * 打包态：Remotion 的 compositor / ffmpeg / ffprobe 二进制经 asar-unpack 落在
   * app.asar.unpacked，但 Remotion 默认用 require('@remotion/compositor-*').dir 得到
   * app.asar 逻辑路径，启动时 chmod 该路径会 ENOTDIR（asar 是文件非目录、未被重定向）。
   * 显式指向 unpacked 真实目录绕过 asar；dev 态为 undefined，沿用 Remotion 默认。
   */
  binariesDirectory?: string;
  /** 打包态内置的 Chrome Headless Shell；开发态留空并沿用 Remotion 默认。 */
  browserExecutable?: string;
  /** renderedFrames/encodedFrames 用于判断瓶颈在截帧端还是编码端（编码追不上时两者差距拉大）。 */
  onProgress?: (progress: { ratio: number; renderedFrames: number; encodedFrames: number }) => void;
  onDiagnostic?: (event: {
    phase: string;
    ok?: boolean;
    durationMs?: number;
    error?: string;
    browserLogType?: string;
    browserLogChars?: number;
    total?: number;
    debug?: number;
    warn?: number;
    errorCount?: number;
    firstError?: string | null;
    gpuRenderer?: string | null;
    hardwareGpu?: boolean;
  }) => void;
}

const COMPOSITION_ID = 'lingji-composition';

export async function renderRemotionVideo(
  params: RemotionRenderParams,
): Promise<{ totalFrames: number; fps: number }> {
  const inputProps = {
    timeline: params.timeline,
    srtEntries: params.srtEntries,
    compiledCards: params.compiledCards,
    themePresetId: params.themePresetId,
  };

  const browserLogs = createBrowserLogCollector();
  const onBrowserLog = browserLogs.onBrowserLog;

  const selectStartedAt = Date.now();
  params.onDiagnostic?.({ phase: 'select-composition.start' });
  let composition;
  try {
    composition = await selectComposition({
      serveUrl: params.serveUrl,
      id: COMPOSITION_ID,
      inputProps,
      binariesDirectory: params.binariesDirectory ?? null,
      browserExecutable: params.browserExecutable,
      logLevel: 'verbose',
      onBrowserLog,
    });
    params.onDiagnostic?.({
      phase: 'select-composition.end',
      ok: true,
      durationMs: Date.now() - selectStartedAt,
    });
  } catch (error) {
    params.onDiagnostic?.({
      phase: 'select-composition.end',
      ok: false,
      durationMs: Date.now() - selectStartedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const renderStartedAt = Date.now();
  params.onDiagnostic?.({ phase: 'render-media.start' });
  try {
    await renderMedia({
      composition,
      serveUrl: params.serveUrl,
      codec: 'h264',
      outputLocation: params.outputPath,
      inputProps,
      concurrency: Math.max(1, params.concurrency),
      scale: params.scale,
      jpegQuality: params.jpegQuality,
      x264Preset: params.x264Preset,
      // buildExportRenderConfig 产出的字符串始终满足 Remotion 的 Bitrate 模板类型（如 '1800k'），
      // 这里 as 收窄一下，TS 才不会因为返回值是普通 string 而拒绝。
      videoBitrate: params.videoBitrate as `${number}k`,
      audioBitrate: params.audioBitrate as `${number}k`,
      hardwareAcceleration: params.hardwareAcceleration,
      binariesDirectory: params.binariesDirectory ?? null,
      browserExecutable: params.browserExecutable,
      chromiumOptions: { ignoreCertificateErrors: false },
      logLevel: 'verbose',
      onBrowserLog,
      onProgress: ({ progress, renderedFrames, encodedFrames }) =>
        params.onProgress?.({ ratio: progress, renderedFrames, encodedFrames }),
    });
    params.onDiagnostic?.({
      phase: 'render-media.end',
      ok: true,
      durationMs: Date.now() - renderStartedAt,
    });
    const summary = browserLogs.summary();
    params.onDiagnostic?.({
      phase: 'browser.log.summary',
      total: summary.total,
      debug: summary.debug,
      warn: summary.warn,
      errorCount: summary.error,
      firstError: summary.firstError,
      gpuRenderer: summary.gpuRenderer,
      hardwareGpu: summary.hardwareGpu,
    });
  } catch (error) {
    params.onDiagnostic?.({
      phase: 'render-media.end',
      ok: false,
      durationMs: Date.now() - renderStartedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  return { totalFrames: composition.durationInFrames, fps: composition.fps };
}

export type SelectedRemotionComposition = Awaited<ReturnType<typeof selectComposition>>;

export interface BrowserLogSummary {
  total: number;
  debug: number;
  warn: number;
  error: number;
  firstError: string | null;
  gpuRenderer: string | null;
  hardwareGpu: boolean;
}

function createBrowserLogCollector(): {
  onBrowserLog: (log: { type: string; text: string }) => void;
  summary: () => BrowserLogSummary;
} {
  const counts = { total: 0, debug: 0, warn: 0, error: 0 };
  let firstError: string | null = null;
  const gpuLogs: string[] = [];
  return {
    onBrowserLog: (log) => {
      counts.total += 1;
      if (log.type === 'error') {
        counts.error += 1;
        firstError ??= log.text.slice(0, 1_000);
      } else if (log.type === 'warning' || log.type === 'warn') {
        counts.warn += 1;
      } else {
        counts.debug += 1;
      }
      if (log.text.includes('[lingji-gpu]') && gpuLogs.length < 8) {
        gpuLogs.push(log.text);
      }
    },
    summary: () => {
      const gpu = classifyGpuRenderer(gpuLogs);
      return {
        ...counts,
        firstError,
        gpuRenderer: gpu.renderer,
        hardwareGpu: gpu.hardwareGpu,
      };
    },
  };
}

export async function selectRemotionComposition(params: {
  serveUrl: string;
  input: ChunkRenderInput;
  binariesDirectory?: string;
  browserExecutable?: string;
  platform?: NodeJS.Platform;
  useAngle?: boolean;
}): Promise<SelectedRemotionComposition> {
  const inputProps = params.input as unknown as Record<string, unknown>;
  return selectComposition({
    serveUrl: params.serveUrl,
    id: COMPOSITION_ID,
    inputProps,
    binariesDirectory: params.binariesDirectory ?? null,
    browserExecutable: params.browserExecutable,
    chromiumOptions: chromiumOptionsForPlatform(params.platform, params.useAngle ?? true),
    logLevel: 'verbose',
  });
}

export interface RemotionChunkRenderParams {
  composition: SelectedRemotionComposition;
  serveUrl: string;
  outputPath: string;
  audioPath: string;
  input: ChunkRenderInput;
  chunk: RenderChunk;
  scale: number;
  x264Preset: 'ultrafast' | 'veryfast' | 'medium';
  quality: ExportQualityPreset;
  videoBitrate: string;
  audioBitrate: string;
  jpegQuality: number;
  concurrency: number;
  encoder: ChunkVideoEncoder;
  binariesDirectory?: string;
  browserExecutable?: string;
  platform?: NodeJS.Platform;
  useAngle?: boolean;
  onProgress?: (progress: {
    ratio: number;
    renderedFrames: number;
    encodedFrames: number;
  }) => void;
}

/**
 * Remotion refuses hardwareAcceleration=required for h264-ts. When NVENC has passed our
 * real smoke encode, replace only the stitcher's libx264 encoder through the supported
 * ffmpegOverride hook. This keeps Remotion's distributed-rendering chunk format intact.
 */
export async function renderRemotionChunk(
  params: RemotionChunkRenderParams,
): Promise<{
  durationMs: number;
  slowestFrames: Array<{ frame: number; time: number }>;
  browserLogs: BrowserLogSummary;
}> {
  const browserLogs = createBrowserLogCollector();
  const startedAt = Date.now();
  // renderMedia serializes both inputProps and composition.props. When a Composition uses
  // calculateMetadata(), Remotion mounts the component with the already-resolved
  // composition.props. The shared composition is intentionally selected with a tiny empty
  // timeline, so reusing it verbatim would make every chunk render only the background even
  // though inputProps contains the sliced timeline. Keep the shared metadata (dimensions,
  // duration and fps), but resolve the component props to this chunk's input.
  const chunkComposition: SelectedRemotionComposition = {
    ...params.composition,
    props: params.input as unknown as Record<string, unknown>,
  };
  const result = await renderMedia({
    composition: chunkComposition,
    serveUrl: params.serveUrl,
    codec: 'h264-ts',
    outputLocation: params.outputPath,
    separateAudioTo: params.audioPath,
    inputProps: params.input as unknown as Record<string, unknown>,
    frameRange: [params.chunk.startFrame, params.chunk.endFrame],
    compositionStart: 0,
    enforceAudioTrack: true,
    forSeamlessAacConcatenation: true,
    audioCodec: 'aac',
    concurrency: Math.max(1, params.concurrency),
    scale: params.scale,
    jpegQuality: params.jpegQuality,
    x264Preset: params.x264Preset,
    videoBitrate: params.videoBitrate as `${number}k`,
    audioBitrate: params.audioBitrate as `${number}k`,
    // h264-ts has no native Remotion HW path; the tested override below owns encoder choice.
    hardwareAcceleration: 'disable',
    ...(params.encoder !== 'libx264'
      ? { ffmpegOverride: createH264TsFfmpegOverride(params.encoder, params.quality) }
      : {}),
    binariesDirectory: params.binariesDirectory ?? null,
    browserExecutable: params.browserExecutable,
    chromiumOptions: chromiumOptionsForPlatform(params.platform, params.useAngle ?? true),
    logLevel: 'verbose',
    onBrowserLog: browserLogs.onBrowserLog,
    onProgress: ({ progress, renderedFrames, encodedFrames }) =>
      params.onProgress?.({ ratio: progress, renderedFrames, encodedFrames }),
  });
  return {
    durationMs: Date.now() - startedAt,
    slowestFrames: result.slowestFrames,
    browserLogs: browserLogs.summary(),
  };
}

export async function combineRemotionChunks(params: {
  chunks: Array<{ startFrame: number; videoPath: string; audioPath: string }>;
  outputPath: string;
  fps: number;
  framesPerChunk: number;
  compositionDurationInFrames: number;
  audioBitrate: string;
  binariesDirectory?: string;
  onProgress?: (ratio: number) => void;
}): Promise<void> {
  const sorted = [...params.chunks].sort((left, right) => left.startFrame - right.startFrame);
  await combineChunks({
    videoFiles: sorted.map((chunk) => chunk.videoPath),
    audioFiles: sorted.map((chunk) => chunk.audioPath),
    outputLocation: params.outputPath,
    codec: 'h264',
    fps: params.fps,
    framesPerChunk: params.framesPerChunk,
    preferLossless: false,
    compositionDurationInFrames: params.compositionDurationInFrames,
    audioCodec: 'aac',
    audioBitrate: params.audioBitrate,
    binariesDirectory: params.binariesDirectory ?? null,
    logLevel: 'verbose',
    onProgress: ({ totalProgress }) => params.onProgress?.(totalProgress),
  });
}
