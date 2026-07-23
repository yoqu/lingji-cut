import { spawn } from 'node:child_process';

export type ExportQualityPreset = 'speed' | 'balanced' | 'quality';

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ProbeDependencies {
  run?: (executable: string, args: string[]) => Promise<ProcessResult>;
}

export interface MediaProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  nb_frames?: string;
}

export interface MediaProbeResult {
  ok: boolean;
  streams: MediaProbeStream[];
  durationSeconds: number | null;
  error?: string;
}

export interface FfmpegEncoderProbe {
  ffmpegVersion: string;
  nvencAdvertised: boolean;
  nvencSmokeOk: boolean;
  encoder: 'h264_nvenc' | 'libx264';
  /** h264-ts is rejected by Remotion's native hardwareAcceleration gate; NVENC is applied below it via ffmpegOverride. */
  remotionHardwareAcceleration: 'disable';
  usesFfmpegOverride: boolean;
  fallbackReason?: string;
}

const NVENC_PRESETS: Record<ExportQualityPreset, string> = {
  speed: 'p1',
  balanced: 'p4',
  quality: 'p6',
};

async function runProcess(executable: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxCaptureBytes = 256 * 1024;
    let capturedStdout = 0;
    let capturedStderr = 0;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`FFmpeg probe timed out: ${args.join(' ')}`));
    }, 30_000);

    child.stdout?.on('data', (data: Buffer) => {
      if (capturedStdout >= maxCaptureBytes) return;
      const slice = data.subarray(0, maxCaptureBytes - capturedStdout);
      capturedStdout += slice.length;
      stdout.push(slice);
    });
    child.stderr?.on('data', (data: Buffer) => {
      if (capturedStderr >= maxCaptureBytes) return;
      const slice = data.subarray(0, maxCaptureBytes - capturedStderr);
      capturedStderr += slice.length;
      stderr.push(slice);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function firstUsefulLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';
}

function parseFfmpegVersion(output: string): string {
  const match = output.match(/ffmpeg version\s+([^\s]+)/i);
  return match?.[1] ?? 'unknown';
}

export async function probeFfmpegEncoder(
  ffmpegPath: string,
  deps: ProbeDependencies = {},
): Promise<FfmpegEncoderProbe> {
  const run = deps.run ?? runProcess;
  const version = await run(ffmpegPath, ['-version']);
  const encoderList = await run(ffmpegPath, ['-hide_banner', '-encoders']);
  const ffmpegVersion = parseFfmpegVersion(`${version.stdout}\n${version.stderr}`);
  const nvencAdvertised = encoderList.code === 0 && /\bh264_nvenc\b/.test(
    `${encoderList.stdout}\n${encoderList.stderr}`,
  );

  if (!nvencAdvertised) {
    return {
      ffmpegVersion,
      nvencAdvertised: false,
      nvencSmokeOk: false,
      encoder: 'libx264',
      remotionHardwareAcceleration: 'disable',
      usesFfmpegOverride: false,
      fallbackReason: encoderList.code === 0
        ? 'FFmpeg does not advertise h264_nvenc'
        : firstUsefulLine(encoderList.stderr) || `ffmpeg -encoders exited ${encoderList.code}`,
    };
  }

  const smoke = await run(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=256x256:r=30:d=0.54',
    '-frames:v',
    '16',
    '-c:v',
    'h264_nvenc',
    '-preset',
    'p4',
    '-pix_fmt',
    'yuv420p',
    '-f',
    'null',
    '-',
  ]);
  const nvencSmokeOk = smoke.code === 0;
  return {
    ffmpegVersion,
    nvencAdvertised: true,
    nvencSmokeOk,
    encoder: nvencSmokeOk ? 'h264_nvenc' : 'libx264',
    remotionHardwareAcceleration: 'disable',
    usesFfmpegOverride: nvencSmokeOk,
    ...(nvencSmokeOk
      ? {}
      : {
          fallbackReason:
            firstUsefulLine(smoke.stderr) || `NVENC smoke encode exited ${smoke.code}`,
        }),
  };
}

export async function probeMediaFile(
  ffprobePath: string,
  mediaPath: string,
  deps: ProbeDependencies = {},
): Promise<MediaProbeResult> {
  const result = await (deps.run ?? runProcess)(ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,nb_frames:format=duration',
    '-of',
    'json',
    mediaPath,
  ]);
  if (result.code !== 0) {
    return {
      ok: false,
      streams: [],
      durationSeconds: null,
      error: firstUsefulLine(result.stderr) || `ffprobe exited ${result.code}`,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      streams?: MediaProbeStream[];
      format?: { duration?: string };
    };
    const duration = Number(parsed.format?.duration);
    return {
      ok: true,
      streams: Array.isArray(parsed.streams) ? parsed.streams : [],
      durationSeconds: Number.isFinite(duration) ? duration : null,
    };
  } catch (error) {
    return {
      ok: false,
      streams: [],
      durationSeconds: null,
      error: `Invalid ffprobe JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function probeChunkMedia(
  ffprobePath: string,
  paths: { videoPath: string; audioPath: string },
  deps: ProbeDependencies = {},
): Promise<{ ok: boolean; videoCodec: string | null; audioCodec: string | null; error?: string }> {
  const [video, audio] = await Promise.all([
    probeMediaFile(ffprobePath, paths.videoPath, deps),
    probeMediaFile(ffprobePath, paths.audioPath, deps),
  ]);
  const videoCodec = video.streams.find((stream) => stream.codec_type === 'video')?.codec_name ?? null;
  const audioCodec = audio.streams.find((stream) => stream.codec_type === 'audio')?.codec_name ?? null;
  const ok = video.ok && audio.ok && videoCodec === 'h264' && audioCodec === 'aac';
  return {
    ok,
    videoCodec,
    audioCodec,
    ...(!ok
      ? { error: video.error ?? audio.error ?? `Unexpected codecs: ${videoCodec}/${audioCodec}` }
      : {}),
  };
}

export function createH264TsFfmpegOverride(quality: ExportQualityPreset): (info: {
  type: 'pre-stitcher' | 'stitcher';
  args: string[];
}) => string[] {
  return ({ type, args }) => {
    if (type !== 'stitcher') return args;
    const next = [...args];
    const codecIndex = next.findIndex(
      (entry, index) => entry === '-c:v' && next[index + 1] === 'libx264',
    );
    if (codecIndex === -1) {
      throw new Error('Cannot enable NVENC: Remotion stitcher did not select libx264');
    }
    next[codecIndex + 1] = 'h264_nvenc';
    const presetIndex = next.indexOf('-preset');
    if (presetIndex >= 0 && presetIndex + 1 < next.length) {
      next[presetIndex + 1] = NVENC_PRESETS[quality];
    } else {
      next.splice(codecIndex + 2, 0, '-preset', NVENC_PRESETS[quality]);
    }
    return next;
  };
}

export interface GpuRendererClassification {
  requestedGl: 'angle';
  renderer: string | null;
  hardwareGpu: boolean;
}

export function classifyGpuRenderer(logs: string[]): GpuRendererClassification {
  const rendererLine = logs.find((line) => line.includes('[lingji-gpu]')) ?? null;
  const renderer = rendererLine
    ? rendererLine.slice(rendererLine.indexOf('[lingji-gpu]') + '[lingji-gpu]'.length).trim()
    : null;
  const hardwareName = renderer ? /\b(?:NVIDIA|AMD|ATI|Intel)\b/i.test(renderer) : false;
  const softwareRenderer = renderer
    ? /SwiftShader|llvmpipe|software rasterizer|Microsoft Basic Render/i.test(renderer)
    : false;
  return {
    requestedGl: 'angle',
    renderer,
    hardwareGpu: Boolean(renderer && hardwareName && !softwareRenderer),
  };
}

export function chromiumOptionsForPlatform(platform = process.platform, useAngle = true): {
  ignoreCertificateErrors: false;
  gl?: 'angle';
} {
  return platform === 'win32' && useAngle
    ? { ignoreCertificateErrors: false, gl: 'angle' }
    : { ignoreCertificateErrors: false };
}
