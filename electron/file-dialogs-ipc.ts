import { dialog, ipcMain, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  readAudioDurationMs,
  readVideoDurationMs,
} from './media-duration';

export interface FileDialogsIpcContext {
  getMainWindow: () => BrowserWindow | null;
  writeAppLog: (level: 'info' | 'warn' | 'error', scope: string, message: string, details?: string) => void;
  resolveRuntimeBinaries: () => { ffprobePath: string | null };
}

const AUDIO_EXTENSIONS_FILTER = ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus'];
const VIDEO_EXTENSIONS_FILTER = ['mp4', 'mov', 'webm', 'm4v'];
const IMAGE_EXTENSIONS_FILTER = ['jpg', 'jpeg', 'png', 'gif', 'webp'];

/** 解析图片像素尺寸（PNG / JPEG / WebP 头部）；无法识别返回 null。 */
function readImageSize(buf: Buffer): { width: number; height: number } | null {
  // PNG: 8 字节签名 + IHDR(长度4+类型4) 后是 width/height
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  // JPEG: 扫描 SOF 标记
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
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
  // WebP (RIFF....WEBP)
  if (
    buf.length >= 30 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
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

/** 读取图片文件头解析像素尺寸；无法识别返回 null。 */
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

/** 发布封面可用的图片格式（与 scan-cover-images 的识别范围一致）。 */
const COVER_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];

// ── 自动扫描项目目录下的媒体素材 ──

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg']);
const SRT_EXTS = new Set(['.srt']);

type ScannedAssetType = 'video' | 'image' | 'audio' | 'srt';

function classifyExtension(ext: string): ScannedAssetType | null {
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (SRT_EXTS.has(ext)) return 'srt';
  return null;
}

export function registerFileDialogsIpc(ctx: FileDialogsIpcContext): void {
  const { getMainWindow, writeAppLog, resolveRuntimeBinaries } = ctx;

  ipcMain.handle('select-project-directory', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
    });

    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('select-media-file', async (_event, kind: 'audio' | 'video' | 'srt' | 'image') => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters:
        kind === 'audio'
          ? [{ name: '音频文件', extensions: AUDIO_EXTENSIONS_FILTER }]
          : kind === 'video'
            ? [{ name: '视频文件', extensions: VIDEO_EXTENSIONS_FILTER }]
            : kind === 'image'
              ? [{ name: '图片文件', extensions: IMAGE_EXTENSIONS_FILTER }]
              : [{ name: 'SRT Subtitle', extensions: ['srt'] }],
    });

    return result.canceled ? null : result.filePaths[0];
  });

  // 发布封面：扫描项目 covers/ 目录下的图片，读取真实像素尺寸，供发布选项卡按比例分桶展示。
  ipcMain.handle('scan-cover-images', async (_event, projectDir: string) => {
    if (!projectDir) return [];
    const dir = path.join(projectDir, 'covers');
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const out: { path: string; width: number; height: number; mtimeMs: number }[] = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/\.(png|jpe?g|webp)$/i.test(entry.name)) continue;
        const full = path.join(dir, entry.name);
        try {
          const size = await readImageSizeAtPath(full);
          if (!size) continue;
          const stat = await fs.stat(full);
          out.push({ path: full, width: size.width, height: size.height, mtimeMs: stat.mtimeMs });
        } catch {
          // 跳过无法读取的文件
        }
      }
      return out;
    } catch {
      return [];
    }
  });

  // 发布封面：手动选择本地图片并复制进 covers/，文件名带比例标记（local-4x3-…），
  // 便于重启后按用户指定比例而非像素判定分组。
  ipcMain.handle('import-cover-images', async (_event, dir: string, ratio?: string) => {
    const mainWindow = getMainWindow();
    if (!mainWindow || !dir) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择本地封面图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片文件', extensions: COVER_IMAGE_EXTENSIONS }],
    });
    if (result.canceled || result.filePaths.length === 0) return [];

    const coversDir = path.join(dir, 'covers');
    await fs.mkdir(coversDir, { recursive: true });
    const tag = typeof ratio === 'string' ? ratio.replace(':', 'x') : '';
    const stamp = Date.now();
    const out: { path: string; width: number; height: number; mtimeMs: number }[] = [];
    for (let i = 0; i < result.filePaths.length; i += 1) {
      const source = result.filePaths[i];
      const ext = path.extname(source).toLowerCase() || '.png';
      const target = path.join(coversDir, `local-${tag ? `${tag}-` : ''}${stamp}-${i}${ext}`);
      try {
        await fs.copyFile(source, target);
        const size = await readImageSizeAtPath(target);
        const stat = await fs.stat(target);
        out.push({
          path: target,
          width: size?.width ?? 0,
          height: size?.height ?? 0,
          mtimeMs: stat.mtimeMs,
        });
      } catch (error) {
        writeAppLog(
          'warn',
          'import-cover-images',
          `导入本地封面失败: ${source}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return out;
  });

  // 发布联动兜底：扫描项目目录顶层最新的 .mp4 成片（用于 App 重启后预填发布视频文件）。
  ipcMain.handle('find-latest-export', async (_event, projectDir: string) => {
    if (!projectDir) return null;
    try {
      const entries = await fs.readdir(projectDir, { withFileTypes: true });
      let best: { path: string; mtimeMs: number } | null = null;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.toLowerCase().endsWith('.mp4')) continue;
        const full = path.join(projectDir, entry.name);
        const stat = await fs.stat(full);
        if (!best || stat.mtimeMs > best.mtimeMs) {
          best = { path: full, mtimeMs: stat.mtimeMs };
        }
      }
      return best ? best.path : null;
    } catch {
      return null;
    }
  });

  ipcMain.handle('add-asset', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        {
          name: '媒体素材',
          extensions: [
            ...VIDEO_EXTENSIONS_FILTER,
            ...IMAGE_EXTENSIONS_FILTER,
            ...AUDIO_EXTENSIONS_FILTER,
          ],
        },
      ],
    });

    if (result.canceled) {
      return null;
    }

    const assetPath = result.filePaths[0];
    const extension = path.extname(assetPath).toLowerCase().replace(/^\./, '');
    const isVideo = VIDEO_EXTENSIONS_FILTER.includes(extension);
    const isAudio = AUDIO_EXTENSIONS_FILTER.includes(extension);
    let durationMs = isAudio || isVideo ? 10000 : 5000;

    const { ffprobePath } = resolveRuntimeBinaries();
    if (isAudio) {
      try {
        durationMs = await readAudioDurationMs(assetPath, { ffprobePath });
      } catch {
        durationMs = 10000;
      }
    }

    if (isVideo) {
      try {
        durationMs = await readVideoDurationMs(assetPath, { ffprobePath });
      } catch (error) {
        writeAppLog(
          'warn',
          'add-asset',
          `读取媒体时长失败: ${assetPath}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const type: 'video' | 'audio' | 'image' = isVideo ? 'video' : isAudio ? 'audio' : 'image';

    return {
      path: assetPath,
      type,
      durationMs,
    };
  });

  ipcMain.handle('scan-project-assets', async (_event, projectDir: string) => {
    const results: { path: string; type: ScannedAssetType; durationMs: number }[] = [];
    const { ffprobePath } = resolveRuntimeBinaries();

    async function scanDir(dir: string, depth: number) {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory() && depth < 2) {
          await scanDir(fullPath, depth + 1);
          continue;
        }

        if (!entry.isFile()) continue;

        const ext = path.extname(entry.name).toLowerCase();
        const assetType = classifyExtension(ext);
        if (!assetType) continue;

        let durationMs = assetType === 'image' ? 5000 : 10000;

        if (assetType === 'audio') {
          try {
            durationMs = await readAudioDurationMs(fullPath, { ffprobePath });
          } catch {
            durationMs = 10000;
          }
        }

        if (assetType === 'video') {
          try {
            durationMs = await readVideoDurationMs(fullPath, { ffprobePath });
          } catch (error) {
            writeAppLog(
              'warn',
              'asset-scan',
              `读取媒体时长失败: ${fullPath}`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }

        results.push({ path: fullPath, type: assetType, durationMs });
      }
    }

    await scanDir(projectDir, 0);
    return results;
  });

  ipcMain.handle('select-text-file', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择报告文件',
      filters: [{ name: '文本文件', extensions: ['txt', 'md', 'html', 'htm'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    const filePath = result.filePaths[0];
    const content = await fs.readFile(filePath, 'utf-8');
    return { path: filePath, content };
  });

  ipcMain.handle('select-output-path', async (_event, defaultPath?: string) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;
    const resolvedDefault =
      typeof defaultPath === 'string' && defaultPath.trim().length > 0
        ? defaultPath
        : 'podcast-export.mp4';
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: resolvedDefault,
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
    });

    return result.canceled ? null : result.filePath;
  });

  ipcMain.handle('check-file-exists', async (_event, targetPath?: string) => {
    if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
      return false;
    }
    try {
      const stat = await fs.stat(targetPath);
      return stat.isFile();
    } catch {
      return false;
    }
  });

  ipcMain.handle('confirm-overwrite', async (_event, targetPath?: string) => {
    if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
      return true;
    }
    const fileName = path.basename(targetPath);
    const options = {
      type: 'warning' as const,
      buttons: ['取消', '覆盖导出'],
      defaultId: 0,
      cancelId: 0,
      title: '文件已存在',
      message: `目标位置已存在同名文件 "${fileName}"`,
      detail: `继续导出将覆盖该文件。\n\n${targetPath}`,
    };
    const mainWindow = getMainWindow();
    const { response } = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    return response === 1;
  });
}
