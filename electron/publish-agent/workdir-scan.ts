import fs from 'node:fs/promises';
import path from 'node:path';
import { readVideoDurationMs } from '../media-duration';
import type { PublishIngestCoverRatio } from './contract';

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.lingji',
  'dist',
  'dist-electron',
  'release',
  '__pycache__',
  '.venv',
  'compiled',
]);
const MAX_WALK_DEPTH = 3;
const MAX_WALK_ENTRIES = 250;
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const TEXT_EXTS = new Set(['.md', '.txt', '.json', '.srt', '.csv', '.yaml', '.yml']);
const COVER_TARGETS: Array<{ ratio: PublishIngestCoverRatio; value: number }> = [
  { ratio: '16:9', value: 16 / 9 },
  { ratio: '4:3', value: 4 / 3 },
  { ratio: '3:4', value: 3 / 4 },
];
const COVER_RATIO_TOLERANCE = 0.06;
const MIN_COVER_EDGE = 320;
const MAX_EXCERPT_FILES = 6;
const MAX_EXCERPT_CHARS = 8_000;

export interface ScannedVideo {
  absPath: string;
  relativePath: string;
  size: number;
  durationMs: number | null;
}

export interface ScannedCover {
  absPath: string;
  relativePath: string;
  width: number;
  height: number;
  size: number;
  ratio: PublishIngestCoverRatio;
}

export interface ScannedTextExcerpt {
  relativePath: string;
  truncated: boolean;
  text: string;
}

export interface WorkdirMediaScan {
  video: ScannedVideo | null;
  covers: Partial<Record<PublishIngestCoverRatio, ScannedCover>>;
  excerpts: ScannedTextExcerpt[];
  videoCount: number;
  imageCount: number;
  textCount: number;
}

export function classifyCoverRatio(width: number, height: number): PublishIngestCoverRatio | null {
  if (!width || !height) return null;
  const actual = width / height;
  let best: PublishIngestCoverRatio | null = null;
  let bestErr = Infinity;
  for (const target of COVER_TARGETS) {
    const err = Math.abs(actual - target.value) / target.value;
    if (err < bestErr) {
      bestErr = err;
      best = target.ratio;
    }
  }
  return bestErr <= COVER_RATIO_TOLERANCE ? best : null;
}

export function readImageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = buf.readUInt16BE(offset + 5);
        const width = buf.readUInt16BE(offset + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      const segLen = buf.readUInt16BE(offset + 2);
      if (segLen < 2) return null;
      offset += 2 + segLen;
    }
    return null;
  }
  if (
    buf.length >= 30
    && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (fmt === 'VP8X') {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width, height };
    }
  }
  return null;
}

async function readImageSizeAtPath(full: string): Promise<{ width: number; height: number } | null> {
  const fh = await fs.open(full, 'r');
  try {
    const head = Buffer.alloc(131072);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    return readImageSize(head.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

function rel(workDir: string, absPath: string): string {
  return path.relative(workDir, absPath) || path.basename(absPath);
}

export function formatWorkdirScanSummary(scan: WorkdirMediaScan): string {
  const parts: string[] = [];
  if (scan.video) {
    const duration = scan.video.durationMs
      ? ` · ${Math.round(scan.video.durationMs / 1000)} 秒`
      : '';
    parts.push(`成片 ${scan.video.relativePath}${duration}`);
  } else {
    parts.push('未找到视频成片');
  }
  const ratios = (Object.keys(scan.covers) as PublishIngestCoverRatio[])
    .filter((ratio) => scan.covers[ratio]);
  if (ratios.length > 0) {
    parts.push(`封面 ${ratios.join(' / ')}`);
  } else {
    parts.push('未找到可用封面');
  }
  if (scan.excerpts.length > 0) {
    parts.push(`文案 ${scan.excerpts.map((item) => item.relativePath).join('、')}`);
  }
  return parts.join(' · ');
}

export function coverPathsFromScan(
  scan: WorkdirMediaScan,
): Partial<Record<PublishIngestCoverRatio, string>> {
  const covers: Partial<Record<PublishIngestCoverRatio, string>> = {};
  for (const ratio of COVER_TARGETS.map((item) => item.ratio)) {
    const cover = scan.covers[ratio];
    if (cover) covers[ratio] = cover.absPath;
  }
  return covers;
}

export async function scanWorkdirMedia(
  workDir: string,
  options: { ffprobePath?: string | null } = {},
): Promise<WorkdirMediaScan> {
  const videos: ScannedVideo[] = [];
  const images: Array<Omit<ScannedCover, 'ratio'> & { ratio: PublishIngestCoverRatio | null }> = [];
  const texts: Array<{ absPath: string; relativePath: string; size: number }> = [];
  let entries = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (entries >= MAX_WALK_ENTRIES || depth > MAX_WALK_DEPTH) return;
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (entries >= MAX_WALK_ENTRIES) return;
      if (name === '.DS_Store') continue;
      const full = path.join(dir, name);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (SKIP_DIR_NAMES.has(name)) continue;
        entries += 1;
        await walk(full, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      entries += 1;
      const ext = path.extname(name).toLowerCase();
      if (VIDEO_EXTS.has(ext)) {
        let durationMs: number | null = null;
        try {
          durationMs = await readVideoDurationMs(full, { ffprobePath: options.ffprobePath });
        } catch {
          durationMs = null;
        }
        videos.push({
          absPath: full,
          relativePath: rel(workDir, full),
          size: stat.size,
          durationMs,
        });
      } else if (IMAGE_EXTS.has(ext)) {
        const size = await readImageSizeAtPath(full);
        if (!size) continue;
        if (Math.min(size.width, size.height) < MIN_COVER_EDGE) continue;
        images.push({
          absPath: full,
          relativePath: rel(workDir, full),
          width: size.width,
          height: size.height,
          size: stat.size,
          ratio: classifyCoverRatio(size.width, size.height),
        });
      } else if (TEXT_EXTS.has(ext)) {
        texts.push({
          absPath: full,
          relativePath: rel(workDir, full),
          size: stat.size,
        });
      }
    }
  };

  await walk(path.resolve(workDir), 0);

  videos.sort((a, b) => {
    const durationDelta = (b.durationMs ?? 0) - (a.durationMs ?? 0);
    if (durationDelta !== 0) return durationDelta;
    return b.size - a.size;
  });

  const covers: Partial<Record<PublishIngestCoverRatio, ScannedCover>> = {};
  for (const image of images) {
    if (!image.ratio) continue;
    const current = covers[image.ratio];
    const area = image.width * image.height;
    const currentArea = current ? current.width * current.height : 0;
    if (!current || area > currentArea || (area === currentArea && image.size > current.size)) {
      covers[image.ratio] = image as ScannedCover;
    }
  }

  texts.sort((a, b) => b.size - a.size);
  const excerpts: ScannedTextExcerpt[] = [];
  for (const file of texts.slice(0, MAX_EXCERPT_FILES)) {
    try {
      const raw = await fs.readFile(file.absPath, 'utf-8');
      const truncated = raw.length > MAX_EXCERPT_CHARS;
      excerpts.push({
        relativePath: file.relativePath,
        truncated,
        text: truncated ? raw.slice(0, MAX_EXCERPT_CHARS) : raw,
      });
    } catch {
      // skip unreadable text
    }
  }

  return {
    video: videos[0] ?? null,
    covers,
    excerpts,
    videoCount: videos.length,
    imageCount: images.length,
    textCount: texts.length,
  };
}
