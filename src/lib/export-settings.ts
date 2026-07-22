export type ExportResolution = 'source' | '720p' | '540p' | '480p';
export type ExportQuality = 'speed' | 'balanced' | 'quality';

export interface ExportConfig {
  resolution: ExportResolution;
  quality: ExportQuality;
}

export interface ExportRenderConfig extends ExportConfig {
  renderWidth: number;
  renderHeight: number;
  x264Preset: 'ultrafast' | 'veryfast' | 'medium';
  videoBitrate: string;
  audioBitrate: string;
  /** Chromium 截帧 JPEG 质量（1-100）：影响截帧序列化速度，与最终视频码率无关。 */
  jpegQuality: number;
}

interface ExportOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

const RESOLUTION_LONG_EDGE: Record<Exclude<ExportResolution, 'source'>, number> = {
  '720p': 1280,
  '540p': 960,
  '480p': 854,
};

const QUALITY_PROFILE: Record<
  ExportQuality,
  {
    x264Preset: ExportRenderConfig['x264Preset'];
    audioBitrate: string;
    videoBitrate: Record<ExportResolution, string>;
    jpegQuality: number;
  }
> = {
  speed: {
    x264Preset: 'ultrafast',
    audioBitrate: '96k',
    jpegQuality: 70,
    videoBitrate: {
      source: '3500k',
      '720p': '1800k',
      '540p': '1200k',
      '480p': '900k',
    },
  },
  balanced: {
    x264Preset: 'veryfast',
    audioBitrate: '128k',
    jpegQuality: 80,
    videoBitrate: {
      source: '5500k',
      '720p': '3000k',
      '540p': '1900k',
      '480p': '1400k',
    },
  },
  quality: {
    x264Preset: 'medium',
    audioBitrate: '192k',
    jpegQuality: 90,
    videoBitrate: {
      source: '8000k',
      '720p': '4500k',
      '540p': '2800k',
      '480p': '2000k',
    },
  },
};

export const EXPORT_RESOLUTION_OPTIONS: ExportOption<ExportResolution>[] = [
  {
    value: 'source',
    label: '原始分辨率',
    description: '保持时间线原尺寸，画质最好，但导出会更慢。',
  },
  {
    value: '720p',
    label: '720p',
    description: '推荐。明显提速，仍适合大多数内容预览和分享。',
  },
  {
    value: '540p',
    label: '540p',
    description: '进一步降低分辨率，适合快速检查字幕与节奏。',
  },
  {
    value: '480p',
    label: '480p',
    description: '最快，适合首轮草稿检查。',
  },
];

export const EXPORT_QUALITY_OPTIONS: ExportOption<ExportQuality>[] = [
  {
    value: 'speed',
    label: '极速低码率',
    description: '编码最快，文件更小，适合草稿导出。',
  },
  {
    value: 'balanced',
    label: '平衡',
    description: '推荐。速度和画质更均衡。',
  },
  {
    value: 'quality',
    label: '标准质量',
    description: '更清晰，但导出更慢。',
  },
];

function ensureEvenDimension(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function scaleToLongEdge(
  width: number,
  height: number,
  targetLongEdge: number,
): { width: number; height: number } {
  const sourceLongEdge = Math.max(width, height);
  if (sourceLongEdge <= targetLongEdge) {
    return {
      width: ensureEvenDimension(width),
      height: ensureEvenDimension(height),
    };
  }

  const scale = targetLongEdge / sourceLongEdge;

  return {
    width: ensureEvenDimension(width * scale),
    height: ensureEvenDimension(height * scale),
  };
}

export function getExportDimensions(
  timelineWidth: number,
  timelineHeight: number,
  resolution: ExportResolution,
): { width: number; height: number } {
  if (resolution === 'source') {
    return {
      width: ensureEvenDimension(timelineWidth),
      height: ensureEvenDimension(timelineHeight),
    };
  }

  return scaleToLongEdge(timelineWidth, timelineHeight, RESOLUTION_LONG_EDGE[resolution]);
}

const LAST_EXPORT_DIR_KEY = 'video-web.last-export-dir';
const LAST_EXPORT_RESOLUTION_KEY = 'video-web.last-export-resolution';
const LAST_EXPORT_QUALITY_KEY = 'video-web.last-export-quality';
const DEFAULT_EXPORT_FILE_NAME = 'podcast-export';

const VALID_RESOLUTIONS: ExportResolution[] = ['source', '720p', '540p', '480p'];
const VALID_QUALITIES: ExportQuality[] = ['speed', 'balanced', 'quality'];

function hasBrowserStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function getLastExportDir(): string {
  if (!hasBrowserStorage()) {
    return '';
  }

  return window.localStorage.getItem(LAST_EXPORT_DIR_KEY) || '';
}

export function setLastExportDir(dir: string): void {
  if (!hasBrowserStorage() || !dir) {
    return;
  }

  window.localStorage.setItem(LAST_EXPORT_DIR_KEY, dir);
}

export function getLastExportResolution(): ExportResolution | null {
  if (!hasBrowserStorage()) {
    return null;
  }

  const value = window.localStorage.getItem(LAST_EXPORT_RESOLUTION_KEY);
  return VALID_RESOLUTIONS.includes(value as ExportResolution) ? (value as ExportResolution) : null;
}

export function setLastExportResolution(resolution: ExportResolution): void {
  if (!hasBrowserStorage()) {
    return;
  }

  window.localStorage.setItem(LAST_EXPORT_RESOLUTION_KEY, resolution);
}

export function getLastExportQuality(): ExportQuality | null {
  if (!hasBrowserStorage()) {
    return null;
  }

  const value = window.localStorage.getItem(LAST_EXPORT_QUALITY_KEY);
  return VALID_QUALITIES.includes(value as ExportQuality) ? (value as ExportQuality) : null;
}

export function setLastExportQuality(quality: ExportQuality): void {
  if (!hasBrowserStorage()) {
    return;
  }

  window.localStorage.setItem(LAST_EXPORT_QUALITY_KEY, quality);
}

// 去除文件名中不安全的字符，保留中文、字母、数字及常见符号
export function sanitizeExportFileName(name: string): string {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    return DEFAULT_EXPORT_FILE_NAME;
  }

  const sanitized = trimmed
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return sanitized || DEFAULT_EXPORT_FILE_NAME;
}

function getPathSeparator(sample: string): string {
  if (sample.includes('\\') && !sample.includes('/')) {
    return '\\';
  }
  return '/';
}

export function extractDirFromPath(fullPath: string): string {
  if (!fullPath) {
    return '';
  }

  const separator = getPathSeparator(fullPath);
  const idx = fullPath.lastIndexOf(separator);
  if (idx <= 0) {
    return '';
  }

  return fullPath.slice(0, idx);
}

export function buildDefaultExportPath(
  projectName: string | null | undefined,
  projectDir?: string | null,
): string {
  const fileName = `${sanitizeExportFileName(projectName || '')}.mp4`;
  const preferredDir = (projectDir || '').trim() || getLastExportDir();
  if (!preferredDir) {
    return fileName;
  }

  const separator = getPathSeparator(preferredDir);
  const trimmedDir = preferredDir.replace(/[\\/]+$/, '');
  return `${trimmedDir}${separator}${fileName}`;
}

export function buildExportRenderConfig({
  timelineWidth,
  timelineHeight,
  resolution,
  quality,
}: {
  timelineWidth: number;
  timelineHeight: number;
  resolution: ExportResolution;
  quality: ExportQuality;
}): ExportRenderConfig {
  const dimensions = getExportDimensions(timelineWidth, timelineHeight, resolution);
  const profile = QUALITY_PROFILE[quality];

  return {
    resolution,
    quality,
    renderWidth: dimensions.width,
    renderHeight: dimensions.height,
    x264Preset: profile.x264Preset,
    videoBitrate: profile.videoBitrate[resolution],
    audioBitrate: profile.audioBitrate,
    jpegQuality: profile.jpegQuality,
  };
}
