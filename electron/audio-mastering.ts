import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface LoudnessMeasurement {
  integratedLufs: number;
  truePeakDbtp: number;
  loudnessRangeLu: number;
  thresholdLufs: number;
  targetOffsetLu: number;
}

interface FfmpegResult {
  code: number;
  stderr: string;
}

function finite(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`ffmpeg loudnorm 未返回有效的 ${label}`);
  return parsed;
}

export function parseLoudnormMeasurement(
  output: string,
  phase: 'input' | 'output' = 'input',
): LoudnessMeasurement {
  const blocks = output.match(/\{[^{}]*\}/gu) ?? [];
  for (const block of blocks.reverse()) {
    try {
      const parsed = JSON.parse(block) as Record<string, unknown>;
      const prefix = phase === 'input' ? 'input' : 'output';
      if (!( `${prefix}_i` in parsed) || !( `${prefix}_tp` in parsed)) continue;
      return {
        integratedLufs: finite(parsed[`${prefix}_i`], `${prefix}_i`),
        truePeakDbtp: finite(parsed[`${prefix}_tp`], `${prefix}_tp`),
        loudnessRangeLu: finite(parsed[`${prefix}_lra`], `${prefix}_lra`),
        thresholdLufs: finite(parsed[`${prefix}_thresh`], `${prefix}_thresh`),
        targetOffsetLu: finite(parsed.target_offset, 'target_offset'),
      };
    } catch {
      // ffmpeg stderr 可能包含其它 JSON，继续寻找 loudnorm 数据块。
    }
  }
  throw new Error('无法从 ffmpeg 输出解析 loudnorm 测量结果');
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<FfmpegResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4 * 1024 * 1024) stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

function loudnormBase(targetLufs: number, maxTruePeakDbtp: number): string {
  return `I=${targetLufs}:LRA=11:TP=${maxTruePeakDbtp}`;
}

export async function measureAudioLoudness(args: {
  ffmpegPath: string;
  inputPath: string;
}): Promise<LoudnessMeasurement> {
  const result = await runFfmpeg(args.ffmpegPath, [
    '-hide_banner', '-nostats', '-i', args.inputPath,
    '-map', '0:a:0', '-af', 'loudnorm=I=-15:LRA=11:TP=-1:print_format=json',
    '-f', 'null', '-',
  ]);
  if (result.code !== 0) throw new Error(`响度分析失败：${result.stderr.slice(-800)}`);
  return parseLoudnormMeasurement(result.stderr, 'input');
}

export async function masterVideoAudio(args: {
  ffmpegPath: string;
  inputPath: string;
  targetLufs: number;
  maxTruePeakDbtp: number;
  audioBitrate?: string;
}): Promise<LoudnessMeasurement> {
  const base = loudnormBase(args.targetLufs, args.maxTruePeakDbtp);
  const firstPass = await runFfmpeg(args.ffmpegPath, [
    '-hide_banner', '-nostats', '-i', args.inputPath,
    '-map', '0:a:0', '-af', `loudnorm=${base}:print_format=json`,
    '-f', 'null', '-',
  ]);
  if (firstPass.code !== 0) throw new Error(`响度分析失败：${firstPass.stderr.slice(-800)}`);
  const measured = parseLoudnormMeasurement(firstPass.stderr, 'input');
  const tempPath = path.join(
    path.dirname(args.inputPath),
    `.${path.basename(args.inputPath, path.extname(args.inputPath))}.master-${crypto.randomUUID()}.mp4`,
  );
  const filter = [
    `loudnorm=${base}`,
    `measured_I=${measured.integratedLufs}`,
    `measured_LRA=${measured.loudnessRangeLu}`,
    `measured_TP=${measured.truePeakDbtp}`,
    `measured_thresh=${measured.thresholdLufs}`,
    `offset=${measured.targetOffsetLu}`,
    'linear=true',
    'print_format=json',
  ].join(':');

  try {
    const secondPass = await runFfmpeg(args.ffmpegPath, [
      '-y', '-hide_banner', '-nostats', '-i', args.inputPath,
      '-map', '0:v?', '-map', '0:a:0', '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', args.audioBitrate ?? '192k',
      '-af', filter, tempPath,
    ]);
    if (secondPass.code !== 0) throw new Error(`响度母带失败：${secondPass.stderr.slice(-800)}`);
    const mastered = parseLoudnormMeasurement(secondPass.stderr, 'output');
    const stat = await fs.stat(tempPath);
    if (!stat.isFile() || stat.size === 0) throw new Error('响度母带没有生成有效文件');
    await fs.copyFile(tempPath, args.inputPath);
    return mastered;
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
