import { dialog, ipcMain, nativeImage, shell, type BrowserWindow } from 'electron';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EMPTY_ASSET_SEMANTIC,
  DEFAULT_ASSET_TREATMENT,
  type AssetChromaKeyRequest,
  type AssetChromaKeyResult,
  type AssetDeleteRequest,
  type AssetDeleteResult,
  type AssetGenerationRequest,
  type AssetImportRequest,
  type AssetImportResult,
  type GeneratedAssetImportRequest,
  type AssetKind,
  type AssetLibraryFile,
  type AssetLibrarySettings,
  type AssetRecord,
  type AssetReplaceOriginalResult,
  type AssetRole,
  type AssetSampleColorRequest,
  type AssetSampleColorResult,
  type AssetUpdatePatch,
  type ProjectAssetHealth,
  type StoryboardAssetRequest,
  type ProjectAssetManifest,
  type ProjectAssetRef,
} from '../src/types/assets';
import { resolveStoryboardAssets } from '../src/lib/asset-resolution';
import { findReusableMediaAssets } from '../src/lib/media-asset-resolution';
import type { MediaAssetRequest } from '../src/types/production';
import {
  readAudioDurationMs,
  readVideoDurationMs,
} from './media-duration';
import {
  chromaKeyPngBuffer,
  decodePng,
  keyGreenScreenPngBuffer,
  type ChromaKeyColor,
} from './green-screen-keyer';
import { measureAudioLoudness } from './audio-mastering';
import { computeVideoFrameDHashes } from '../src/lib/media-fingerprint';

export interface AssetLibraryIpcContext {
  getMainWindow: () => BrowserWindow | null;
  writeAppLog: (
    level: 'info' | 'warn' | 'error',
    scope: string,
    message: string,
    details?: string,
  ) => void;
  resolveRuntimeBinaries: () => { ffprobePath: string | null; ffmpegPath?: string | null };
}

export type GenerateMissingAssetFileFn = (
  request: AssetGenerationRequest,
  context: { signal?: AbortSignal },
) => Promise<{ filePath: string }>;

let assetMutationQueue: Promise<void> = Promise.resolve();

function serializeAssetMutation<T>(work: () => Promise<T>): Promise<T> {
  const run = assetMutationQueue.then(work, work);
  assetMutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

interface ResolveAssetRequestsArgs {
  projectDir: string;
  requests: StoryboardAssetRequest[];
  sourceCardId?: string;
  generateMissing?: GenerateMissingAssetFileFn;
  signal?: AbortSignal;
}

async function initializeAssetResolution(args: ResolveAssetRequestsArgs) {
  const library = await loadLibraryWithProjectAssets(args.projectDir);
  const resolvableLibrary = await normalizeResolvableAssetLibrary(library);
  let projectManifest = await loadProjectManifest(args.projectDir);
  const result = resolveStoryboardAssets({
    requests: args.requests,
    library: resolvableLibrary,
    projectManifest,
    sourceCardId: args.sourceCardId,
  });
  for (const binding of result.bindings) {
    const asset = library.assets.find((item) => item.id === binding.assetId);
    if (!asset) continue;
    projectManifest = addProjectRef(projectManifest, asset, {
      type: 'motion-card',
      id: args.sourceCardId,
      slot: binding.slot,
    });
  }
  if (projectManifest) {
    projectManifest = upsertGenerationRequests(projectManifest, result.generationRequests);
    projectManifest = await saveProjectManifest(projectManifest);
  }
  return { result, library, projectManifest };
}

function patchGenerationRequest(
  projectDir: string,
  requestId: string,
  patch: Partial<AssetGenerationRequest>,
): Promise<ProjectAssetManifest | null> {
  return serializeAssetMutation(async () => {
    const manifest = await loadProjectManifest(projectDir);
    if (!manifest) return null;
    return saveProjectManifest(updateGenerationRequest(manifest, requestId, patch));
  });
}

async function finalizeAssetResolution(args: ResolveAssetRequestsArgs) {
  const library = await loadLibraryWithProjectAssets(args.projectDir);
  const resolvableLibrary = await normalizeResolvableAssetLibrary(library);
  let projectManifest = await loadProjectManifest(args.projectDir);
  const result = resolveStoryboardAssets({
    requests: args.requests,
    library: resolvableLibrary,
    projectManifest,
    sourceCardId: args.sourceCardId,
  });
  for (const binding of result.bindings) {
    const asset = library.assets.find((item) => item.id === binding.assetId);
    if (!asset) continue;
    projectManifest = addProjectRef(projectManifest, asset, {
      type: 'motion-card',
      id: args.sourceCardId,
      slot: binding.slot,
    });
  }
  if (projectManifest) projectManifest = await saveProjectManifest(projectManifest);
  return { result, library, projectManifest };
}

export async function resolveAssetRequestsForProject(args: ResolveAssetRequestsArgs) {
  const startedAt = Date.now();
  const throwIfAborted = () => {
    if (!args.signal?.aborted) return;
    throw args.signal.reason instanceof Error ? args.signal.reason : new Error('资产生成已取消');
  };
  throwIfAborted();
  const initial = await serializeAssetMutation(() => initializeAssetResolution(args));
  let { result, library, projectManifest } = initial;
  const activity = {
    requested: args.requests.length,
    matched: result.bindings.length,
    generated: 0,
    failed: 0,
    cutoutReady: 0,
    cutoutFailed: 0,
    durationMs: 0,
  };

  if (args.generateMissing && projectManifest && result.generationRequests.length > 0) {
    for (const request of result.generationRequests) {
      throwIfAborted();
      projectManifest = await patchGenerationRequest(args.projectDir, request.id, {
        status: 'generating',
        error: undefined,
      });
      try {
        const generated = await args.generateMissing(request, { signal: args.signal });
        throwIfAborted();
        const accepted = await serializeAssetMutation(() => acceptGeneratedFileForRequest({
          projectDir: args.projectDir,
          requestId: request.id,
          filePath: generated.filePath,
          status: 'ready',
        }));
        activity.generated += 1;
        if (['object', 'symbol', 'overlay'].includes(request.role)) {
          if (accepted.asset.metadata.hasAlpha && accepted.asset.files.processed !== accepted.asset.files.original) {
            activity.cutoutReady += 1;
          } else {
            activity.cutoutFailed += 1;
          }
        }
        projectManifest = accepted.projectManifest;
      } catch (error) {
        if (args.signal?.aborted) {
          await patchGenerationRequest(args.projectDir, request.id, {
            status: 'pending',
            error: undefined,
          });
          throw error;
        }
        activity.failed += 1;
        projectManifest = await patchGenerationRequest(args.projectDir, request.id, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const finalized = await serializeAssetMutation(() => finalizeAssetResolution(args));
    result = finalized.result;
    library = finalized.library;
    projectManifest = finalized.projectManifest;
  }

  activity.durationMs = Date.now() - startedAt;
  return { ...result, activity, library, projectManifest };
}

export async function loadAssetLibraryState(projectDir?: string | null) {
  const [library, projectManifest] = await Promise.all([
    loadLibraryWithProjectAssets(projectDir),
    loadProjectManifest(projectDir),
  ]);
  const health = await auditAssetLibraryState(library, projectManifest);
  return { library, projectManifest, health };
}

export async function resolveReusableMediaAssetForProject(args: {
  projectDir: string;
  request: MediaAssetRequest;
  sourceCardId?: string;
  minScore?: number;
}) {
  return serializeAssetMutation(async () => {
    const library = await loadLibraryWithProjectAssets(args.projectDir);
    const resolvableLibrary = await normalizeResolvableAssetLibrary(library);
    const candidate = findReusableMediaAssets(args.request, resolvableLibrary)[0];
    if (!candidate || candidate.score < (args.minScore ?? 75)) return null;

    const asset = candidate.asset.sourceType === 'project-local'
      ? candidate.asset
      : markAssetUsedByProject(candidate.asset, args.projectDir);
    if (asset.sourceType !== 'project-local') {
      upsertAsset(library, asset);
      await saveLibrary(library);
    }
    const manifest = addProjectRef(await loadProjectManifest(args.projectDir), asset, {
      type: 'motion-card',
      id: args.sourceCardId,
      slot: args.request.role,
    });
    if (manifest) await saveProjectManifest(manifest);
    return { ...candidate, asset };
  });
}

export async function searchReusableMediaAssetsForProject(args: {
  projectDir: string;
  request: MediaAssetRequest;
}) {
  const library = await loadLibraryWithProjectAssets(args.projectDir);
  return findReusableMediaAssets(
    args.request,
    await normalizeResolvableAssetLibrary(library),
  );
}

const LIBRARY_FILE = 'library.json';
const PROJECT_MANIFEST = path.join('assets', 'manifest.json');
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg', '.opus']);
const PROJECT_SCAN_SKIP_DIRS = new Set([
  '.git',
  '.lingji',
  'node_modules',
  'dist',
  'dist-electron',
  'release',
  'releases',
]);
const PROJECT_SCAN_MAX_DEPTH = 5;
const PROJECT_ASSET_ID_PREFIX = 'project_';

function nowIso(): string {
  return new Date().toISOString();
}

function defaultRootDir(): string {
  return path.join(os.homedir(), 'Movies', '灵机剪影', 'Assets');
}

function defaultSettings(rootDir = defaultRootDir()): AssetLibrarySettings {
  return {
    rootDir,
    defaultImportMode: 'copy',
    defaultProjectReferenceMode: 'reference-global',
  };
}

function classifyAsset(filePath: string): { kind: AssetKind; role: AssetRole; dir: string } | null {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', role: 'object', dir: 'images' };
  if (VIDEO_EXTS.has(ext)) return { kind: 'video', role: 'video', dir: 'videos' };
  if (AUDIO_EXTS.has(ext)) return { kind: 'audio', role: 'audio', dir: 'audio' };
  return null;
}

function sanitizeBaseName(filePath: string): string {
  return path
    .basename(filePath, path.extname(filePath))
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'asset';
}

function parseKeyColor(input?: string | null): ChromaKeyColor {
  const normalized = (input || '#00ff00').trim();
  const match = /^#?([0-9a-f]{6})$/i.exec(normalized);
  if (!match) {
    throw new Error('抠图颜色必须是 #RRGGBB 格式');
  }
  const hex = match[1];
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function colorToHex(color: ChromaKeyColor): string {
  return `#${color.r.toString(16).padStart(2, '0')}${color.g
    .toString(16)
    .padStart(2, '0')}${color.b.toString(16).padStart(2, '0')}`;
}

function isSamePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeProjectRel(projectDir: string, filePath: string): string {
  return path.relative(projectDir, filePath).replace(/\\/g, '/');
}

function projectAssetId(projectDir: string, filePath: string): string {
  const rel = normalizeProjectRel(projectDir, filePath);
  return `${PROJECT_ASSET_ID_PREFIX}${crypto.createHash('sha1').update(rel).digest('hex').slice(0, 16)}`;
}

function projectContentHash(projectDir: string, filePath: string, stat: { mtimeMs: number; size: number }): string {
  const rel = normalizeProjectRel(projectDir, filePath);
  const digest = crypto
    .createHash('sha1')
    .update(`${rel}:${stat.mtimeMs}:${stat.size}`)
    .digest('hex');
  return `project:${digest}`;
}

function cutoutPathForImage(filePath: string): string {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const suffix = base.endsWith('-cutout') ? '-processed' : '-cutout';
  return path.join(path.dirname(filePath), `${base}${suffix}.png`);
}

function isProjectCutoutDerivative(filePath: string, fileSet: Set<string>): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.png') return false;
  const base = path.basename(filePath, ext);
  if (!base.endsWith('-cutout') && !base.endsWith('-processed')) return false;
  const sourceBase = base.replace(/-(cutout|processed)$/u, '');
  for (const sourceExt of IMAGE_EXTS) {
    if (fileSet.has(path.join(path.dirname(filePath), `${sourceBase}${sourceExt}`))) {
      return true;
    }
  }
  return false;
}

function inferProjectAssetRole(filePath: string, projectDir: string, fallback: AssetRole): AssetRole {
  const rel = normalizeProjectRel(projectDir, filePath).toLowerCase();
  if (rel.startsWith('covers/') || rel.includes('/covers/')) return 'background';
  if (rel.includes('poster') || rel.includes('cover')) return 'background';
  if (rel.includes('texture')) return 'texture';
  if (rel.includes('symbol') || rel.includes('icon')) return 'symbol';
  return fallback;
}

function replacementOriginalPath(library: AssetLibraryFile, asset: AssetRecord): string {
  const processedPath = asset.files.processed;
  const candidate = asset.metadata.previousOriginalPath && processedPath
    && isSamePath(asset.files.original, processedPath)
    ? asset.metadata.previousOriginalPath
    : asset.files.original;
  if (!processedPath || !isSamePath(candidate, processedPath)) {
    return path.extname(candidate).toLowerCase() === '.png'
      ? candidate
      : path.join(path.dirname(candidate), `${path.basename(candidate, path.extname(candidate))}-cutout.png`);
  }
  return path.join(library.settings.rootDir, 'originals', 'images', `${asset.id}-cutout.png`);
}

async function backupFileIfExists(
  filePath: string,
  rootDir: string,
  backupSubdir = path.join('originals', 'backups'),
): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  const backupDir = path.join(rootDir, backupSubdir);
  await fs.mkdir(backupDir, { recursive: true });
  const ext = path.extname(filePath) || '.bin';
  const backupPath = path.join(
    backupDir,
    `${path.basename(filePath, ext)}-${Date.now()}${ext}`,
  );
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

function collectOwnedAssetFiles(asset: AssetRecord, rootDir: string): string[] {
  const candidates = [
    asset.files.original,
    asset.files.processed,
    asset.files.thumbnail,
    asset.files.mask,
    asset.metadata.previousOriginalPath,
  ].filter((filePath): filePath is string => Boolean(filePath));
  return Array.from(new Set(candidates.filter((filePath) => isPathInside(rootDir, filePath))));
}

async function trashAssetFiles(filePaths: string[]): Promise<{
  trashedFiles: string[];
  failedFiles: Array<{ path: string; reason: string }>;
}> {
  const trashedFiles: string[] = [];
  const failedFiles: Array<{ path: string; reason: string }> = [];
  for (const filePath of filePaths) {
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    try {
      await shell.trashItem(filePath);
      trashedFiles.push(filePath);
    } catch (error) {
      try {
        await fs.rm(filePath, { force: true });
        trashedFiles.push(filePath);
      } catch (fallbackError) {
        failedFiles.push({
          path: filePath,
          reason: fallbackError instanceof Error
            ? fallbackError.message
            : error instanceof Error
              ? error.message
              : String(fallbackError),
        });
      }
    }
  }
  return { trashedFiles, failedFiles };
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function normalizeLibrary(input: AssetLibraryFile | null, rootDir: string): AssetLibraryFile {
  return {
    version: 2,
    libraryId: input?.libraryId || 'default',
    settings: { ...defaultSettings(rootDir), ...(input?.settings ?? {}) },
    assets: Array.isArray(input?.assets)
      ? input.assets.map((asset) => ({
          ...asset,
          metadata: { ...asset.metadata },
          usage: {
            ...asset.usage,
            usageCount: asset.usage.usageCount ?? asset.usage.projectRefs.length,
            rating: asset.usage.rating ?? null,
            deprecated: asset.usage.deprecated ?? false,
          },
        }))
      : [],
    updatedAt: input?.updatedAt || nowIso(),
  };
}

async function loadLibrary(rootDir = defaultRootDir()): Promise<AssetLibraryFile> {
  await ensureLibraryDirs(rootDir);
  return normalizeLibrary(
    await readJson<AssetLibraryFile>(path.join(rootDir, LIBRARY_FILE)),
    rootDir,
  );
}

async function saveLibrary(library: AssetLibraryFile): Promise<AssetLibraryFile> {
  const next = { ...library, updatedAt: nowIso() };
  await writeJson(path.join(next.settings.rootDir, LIBRARY_FILE), next);
  return next;
}

async function collectProjectMediaFiles(projectDir: string): Promise<string[]> {
  const files: string[] = [];
  async function scanDir(dir: string, depth: number): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.lingji') continue;
      if (PROJECT_SCAN_SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < PROJECT_SCAN_MAX_DEPTH) {
          await scanDir(fullPath, depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (classifyAsset(fullPath)) files.push(fullPath);
    }
  }

  await scanDir(projectDir, 0);
  return files;
}

export async function scanProjectAssetRecords(
  projectDir: string,
  ffprobePath: string | null = null,
): Promise<AssetRecord[]> {
  const mediaFiles = await collectProjectMediaFiles(projectDir);
  const fileSet = new Set(mediaFiles);
  const assets: AssetRecord[] = [];
  for (const filePath of mediaFiles) {
    if (isProjectCutoutDerivative(filePath, fileSet)) continue;
    const classified = classifyAsset(filePath);
    if (!classified) continue;
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;
    const processed = classified.kind === 'image'
      ? await fs.stat(cutoutPathForImage(filePath)).then(() => cutoutPathForImage(filePath)).catch(() => null)
      : null;
    const [dimensions, durationMs] = await Promise.all([
      readAssetDimensions(filePath, classified.kind).catch(() => ({})),
      readDuration(filePath, classified.kind, ffprobePath),
    ]);
    const processedStat = processed ? await fs.stat(processed).catch(() => null) : null;
    const processedDimensions = processed
      ? await readAssetDimensions(processed, 'image').catch(() => ({}))
      : {};
    const rel = normalizeProjectRel(projectDir, filePath);
    const timestamp = new Date(stat.mtimeMs || Date.now()).toISOString();
    const tags = rel
      .split(/[\\/._\-\s]+/g)
      .map((item) => item.trim())
      .filter((item) => item.length > 1 && !/^\d+$/.test(item))
      .slice(0, 8);
    assets.push({
      id: projectAssetId(projectDir, filePath),
      name: sanitizeBaseName(filePath),
      kind: classified.kind,
      role: inferProjectAssetRole(filePath, projectDir, classified.role),
      sourceType: 'project-local',
      sourceUri: rel,
      licenseNote: '',
      createdAt: timestamp,
      updatedAt: processedStat ? new Date(processedStat.mtimeMs).toISOString() : timestamp,
      files: {
        original: filePath,
        processed,
        thumbnail: processed ?? filePath,
        mask: null,
      },
      metadata: {
        ...dimensions,
        ...processedDimensions,
        durationMs,
        hasAlpha: Boolean(processed) || ['.png', '.webp'].includes(path.extname(filePath).toLowerCase()),
        processedAt: processedStat ? new Date(processedStat.mtimeMs).toISOString() : null,
        processedByteSize: processedStat?.size ?? null,
        processedColorKey: processed ? '#00ff00' : null,
        contentHash: projectContentHash(projectDir, filePath, stat),
        byteSize: stat.size,
        mimeHint: classified.kind,
      },
      semantic: {
        ...EMPTY_ASSET_SEMANTIC,
        tags,
        usableAs: classified.kind === 'image' ? ['foreground-object', 'project-local'] : ['project-local'],
      },
      treatment: { ...DEFAULT_ASSET_TREATMENT },
      usage: {
        projectRefs: [projectDir],
        favorite: false,
      },
    });
  }
  return assets;
}

async function appendProjectAssets(
  library: AssetLibraryFile,
  projectDir?: string | null,
  ffprobePath: string | null = null,
): Promise<AssetLibraryFile> {
  if (!projectDir) return library;
  const projectAssets = await scanProjectAssetRecords(projectDir, ffprobePath);
  const registeredPaths = new Set(
    library.assets.flatMap((asset) => [
      asset.sourceUri,
      asset.files.original,
      asset.files.processed ?? undefined,
      asset.files.thumbnail ?? undefined,
    ]).filter((item): item is string => Boolean(item)).map((item) => path.resolve(projectDir, item)),
  );
  const uniqueProjectAssets = projectAssets.filter(
    (asset) => !registeredPaths.has(path.resolve(asset.files.original)),
  );
  return { ...library, assets: [...library.assets, ...uniqueProjectAssets] };
}

async function loadLibraryWithProjectAssets(
  projectDir?: string | null,
  rootDir = defaultRootDir(),
  ffprobePath: string | null = null,
): Promise<AssetLibraryFile> {
  return appendProjectAssets(await loadLibrary(rootDir), projectDir, ffprobePath);
}

async function fileExists(filePath?: string | null): Promise<boolean> {
  if (!filePath) return false;
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function normalizeAssetFilesForResolution(asset: AssetRecord): Promise<AssetRecord | null> {
  const [originalOk, processedOk, thumbnailOk] = await Promise.all([
    fileExists(asset.files.original),
    fileExists(asset.files.processed),
    fileExists(asset.files.thumbnail),
  ]);
  if (!originalOk && !processedOk && !thumbnailOk) return null;
  return {
    ...asset,
    files: {
      ...asset.files,
      processed: processedOk ? asset.files.processed : null,
      thumbnail: thumbnailOk ? asset.files.thumbnail : null,
    },
  };
}

export async function normalizeResolvableAssetLibrary(
  library: AssetLibraryFile,
): Promise<AssetLibraryFile> {
  const assets = await Promise.all(library.assets.map(normalizeAssetFilesForResolution));
  return {
    ...library,
    assets: assets.filter((asset): asset is AssetRecord => Boolean(asset)),
  };
}

export async function auditAssetLibraryState(
  library: AssetLibraryFile,
  projectManifest: ProjectAssetManifest | null,
): Promise<ProjectAssetHealth | null> {
  if (!projectManifest) return null;
  const issues: ProjectAssetHealth['issues'] = [];
  const assetsById = new Map(library.assets.map((asset) => [asset.id, asset]));

  for (const asset of library.assets) {
    if (!(await fileExists(asset.files.original))) {
      issues.push({
        kind: 'missing-original',
        severity: asset.files.processed ? 'warn' : 'error',
        assetId: asset.id,
        filePath: asset.files.original,
        message: `资产「${asset.name}」原始文件不存在`,
      });
    }
    if (asset.files.processed && !(await fileExists(asset.files.processed))) {
      issues.push({
        kind: 'missing-processed',
        severity: 'warn',
        assetId: asset.id,
        filePath: asset.files.processed,
        message: `资产「${asset.name}」处理结果不存在`,
      });
    }
  }

  for (const ref of projectManifest.assetRefs) {
    if (assetsById.has(ref.assetId)) continue;
    issues.push({
      kind: 'missing-project-ref',
      severity: 'error',
      assetId: ref.assetId,
      message: `项目引用的资产 ${ref.assetId} 已不可用`,
    });
  }

  for (const request of projectManifest.generationRequests) {
    if (request.status !== 'accepted') continue;
    if (request.resultAssetId && !assetsById.has(request.resultAssetId)) {
      issues.push({
        kind: 'missing-generation-result',
        severity: 'error',
        assetId: request.resultAssetId,
        requestId: request.id,
        message: `已确认的生成结果「${request.query}」资产记录不可用`,
      });
    }
    if (request.generatedFilePath && !(await fileExists(request.generatedFilePath))) {
      issues.push({
        kind: 'missing-generation-result',
        severity: 'error',
        assetId: request.resultAssetId,
        requestId: request.id,
        filePath: request.generatedFilePath,
        message: `已确认的生成结果「${request.query}」文件不存在`,
      });
    }
  }

  const missingRefs = issues.filter((issue) => issue.kind === 'missing-project-ref').length;
  const missingFiles = issues.filter(
    (issue) =>
      issue.kind === 'missing-original' ||
      issue.kind === 'missing-processed' ||
      (issue.kind === 'missing-generation-result' && Boolean(issue.filePath)),
  ).length;
  const hasError = issues.some((issue) => issue.severity === 'error');
  return {
    ok: !hasError,
    checkedAt: nowIso(),
    missingFiles,
    missingRefs,
    issues,
  };
}

async function findAssetForOperation(
  assetId: string,
  projectDir: string | null | undefined,
  rootDir: string,
): Promise<{
  asset: AssetRecord;
  library: AssetLibraryFile;
  source: 'global' | 'project';
}> {
  const library = await loadLibrary(rootDir);
  const globalAsset = library.assets.find((item) => item.id === assetId);
  if (globalAsset) {
    return { asset: globalAsset, library, source: 'global' };
  }
  if (projectDir) {
    const projectAsset = (await scanProjectAssetRecords(projectDir)).find((item) => item.id === assetId);
    if (projectAsset) {
      return { asset: projectAsset, library, source: 'project' };
    }
  }
  throw new Error('未找到资产');
}

async function ensureLibraryDirs(rootDir: string): Promise<void> {
  await Promise.all([
    fs.mkdir(path.join(rootDir, 'originals', 'images'), { recursive: true }),
    fs.mkdir(path.join(rootDir, 'originals', 'videos'), { recursive: true }),
    fs.mkdir(path.join(rootDir, 'originals', 'audio'), { recursive: true }),
    fs.mkdir(path.join(rootDir, 'processed', 'cutouts'), { recursive: true }),
    fs.mkdir(path.join(rootDir, 'processed', 'thumbnails'), { recursive: true }),
    fs.mkdir(path.join(rootDir, 'generated', 'batches'), { recursive: true }),
  ]);
}

function normalizeProjectManifest(
  input: ProjectAssetManifest | null,
  projectDir: string,
): ProjectAssetManifest {
  return {
    version: 1,
    projectDir,
    assetRefs: Array.isArray(input?.assetRefs) ? input.assetRefs : [],
    generationRequests: Array.isArray(input?.generationRequests) ? input.generationRequests : [],
    updatedAt: input?.updatedAt || nowIso(),
  };
}

async function loadProjectManifest(projectDir?: string | null): Promise<ProjectAssetManifest | null> {
  if (!projectDir) return null;
  return normalizeProjectManifest(
    await readJson<ProjectAssetManifest>(path.join(projectDir, PROJECT_MANIFEST)),
    projectDir,
  );
}

async function saveProjectManifest(manifest: ProjectAssetManifest): Promise<ProjectAssetManifest> {
  const next = { ...manifest, updatedAt: nowIso() };
  await writeJson(path.join(next.projectDir, PROJECT_MANIFEST), next);
  return next;
}

async function hashFile(filePath: string): Promise<{ contentHash: string; byteSize: number }> {
  const [stat, digest] = await Promise.all([
    fs.stat(filePath),
    new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    }),
  ]);
  return { contentHash: `sha256:${digest}`, byteSize: stat.size };
}

function readImageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      const segLen = buf.readUInt16BE(offset + 2);
      if (segLen < 2) return null;
      offset += 2 + segLen;
    }
  }
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8X') {
      return {
        width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
      };
    }
  }
  return null;
}

async function readAssetDimensions(filePath: string, kind: AssetKind): Promise<{
  width?: number | null;
  height?: number | null;
}> {
  if (kind !== 'image') return {};
  const fh = await fs.open(filePath, 'r');
  try {
    const head = Buffer.alloc(131072);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    return readImageSize(head.subarray(0, bytesRead)) ?? {};
  } finally {
    await fh.close();
  }
}

interface MediaProbeResult {
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  audio?: AssetRecord['metadata']['audio'];
  video?: AssetRecord['metadata']['video'];
}

function parseFrameRate(value: unknown): number | null {
  const [numerator, denominator] = String(value ?? '0/1').split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

async function probeMedia(
  filePath: string,
  kind: AssetKind,
  ffprobePath: string | null,
): Promise<MediaProbeResult> {
  if (!ffprobePath || kind === 'image') return {};
  try {
    const { execFile } = await import('node:child_process');
    const json = await new Promise<string>((resolve, reject) => {
      execFile(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath],
        { maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    const parsed = JSON.parse(json) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
    const videoStream = parsed.streams?.find((stream) => stream.codec_type === 'video');
    const audioStream = parsed.streams?.find((stream) => stream.codec_type === 'audio');
    const durationSeconds = Number(parsed.format?.duration ?? videoStream?.duration ?? audioStream?.duration);
    if (kind === 'audio') {
      return { durationMs: Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : null, audio: {} };
    }
    const width = Number(videoStream?.width);
    const height = Number(videoStream?.height);
    return {
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
      durationMs: Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : null,
      video: {
        fps: parseFrameRate(videoStream?.avg_frame_rate),
        aspectRatio: width > 0 && height > 0 ? `${width}:${height}` : null,
        hasAudio: Boolean(audioStream),
      },
    };
  } catch {
    return {};
  }
}

function normalizedMediaHash(
  filePath: string,
  kind: AssetKind,
  ffmpegPath?: string | null,
): Promise<string | null> {
  if (!ffmpegPath || kind === 'image') return Promise.resolve(null);
  const args = kind === 'audio'
    ? ['-v', 'error', '-i', filePath, '-map', 'a:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1']
    : ['-v', 'error', '-i', filePath, '-vf', 'fps=1,scale=9:8,format=gray', '-frames:v', '5', '-f', 'rawvideo', 'pipe:1'];
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    if (kind === 'video') {
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        if (code !== 0) return resolve(null);
        const hashes = computeVideoFrameDHashes(Buffer.concat(chunks));
        resolve(hashes.length > 0 ? `dhash:${hashes.join('-')}` : null);
      });
      return;
    }
    const hash = crypto.createHash('sha256');
    child.stdout.on('data', (chunk) => hash.update(chunk));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? `sha256:${hash.digest('hex')}` : null));
  });
}

async function createVideoContactSheet(args: {
  filePath: string;
  outputPath: string;
  durationMs?: number | null;
  ffmpegPath?: string | null;
}): Promise<string | null> {
  if (!args.ffmpegPath) return null;
  await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
  const intervalSeconds = Math.max(0.2, (args.durationMs ?? 5_000) / 5_000);
  const filter = `fps=1/${intervalSeconds},scale=240:-2,tile=5x1`;
  const code = await new Promise<number>((resolve) => {
    const child = spawn(args.ffmpegPath!, [
      '-y', '-v', 'error', '-i', args.filePath,
      '-vf', filter, '-frames:v', '1', args.outputPath,
    ], { stdio: 'ignore' });
    child.on('error', () => resolve(-1));
    child.on('close', (exitCode) => resolve(exitCode ?? -1));
  });
  if (code === 0 && await fileExists(args.outputPath)) return args.outputPath;
  await fs.rm(args.outputPath, { force: true }).catch(() => undefined);
  return null;
}

async function readPngBufferForChromaKey(filePath: string): Promise<Buffer | null> {
  const source = await fs.readFile(filePath);
  if (
    source.length >= 8 &&
    source[0] === 0x89 &&
    source[1] === 0x50 &&
    source[2] === 0x4e &&
    source[3] === 0x47
  ) {
    return source;
  }
  try {
    const image = nativeImage.createFromBuffer(source);
    if (image.isEmpty()) return null;
    return image.toPNG();
  } catch {
    return null;
  }
}

async function readDuration(
  filePath: string,
  kind: AssetKind,
  ffprobePath: string | null,
): Promise<number | null> {
  if (kind === 'audio') return readAudioDurationMs(filePath, { ffprobePath }).catch(() => null);
  if (kind === 'video') return readVideoDurationMs(filePath, { ffprobePath }).catch(() => null);
  return null;
}

function addProjectRef(
  manifest: ProjectAssetManifest | null,
  asset: AssetRecord,
  usedBy?: ProjectAssetRef['usedBy'][number],
): ProjectAssetManifest | null {
  if (!manifest) return null;
  const existing = manifest.assetRefs.find((ref) => ref.assetId === asset.id);
  if (existing) {
    if (!usedBy) return manifest;
    const hasUsage = existing.usedBy.some(
      (usage) => usage.type === usedBy.type && usage.id === usedBy.id && usage.slot === usedBy.slot,
    );
    if (hasUsage) return manifest;
    return {
      ...manifest,
      assetRefs: manifest.assetRefs.map((ref) =>
        ref.assetId === asset.id ? { ...ref, usedBy: [...ref.usedBy, usedBy] } : ref,
      ),
    };
  }
  const nextRef: ProjectAssetRef = {
    assetId: asset.id,
    scope: asset.sourceType === 'project-local' ? 'project' : 'global',
    globalLibraryId: asset.sourceType === 'project-local' ? undefined : 'default',
    snapshotPath: asset.sourceType === 'project-local' ? asset.sourceUri ?? asset.files.original : null,
    addedAt: nowIso(),
    usedBy: usedBy ? [usedBy] : [],
  };
  return { ...manifest, assetRefs: [...manifest.assetRefs, nextRef] };
}

function upsertGenerationRequests(
  manifest: ProjectAssetManifest,
  requests: AssetGenerationRequest[],
): ProjectAssetManifest {
  if (requests.length === 0) return manifest;
  const existingKeySet = new Set(
    manifest.generationRequests.map((request) =>
      [request.sourceCardId ?? '', request.slot, request.query, request.status].join('\u0001'),
    ),
  );
  const next = [...manifest.generationRequests];
  for (const request of requests) {
    const key = [request.sourceCardId ?? '', request.slot, request.query, request.status].join('\u0001');
    if (existingKeySet.has(key)) continue;
    existingKeySet.add(key);
    next.push(request);
  }
  return { ...manifest, generationRequests: next };
}

function updateGenerationRequest(
  manifest: ProjectAssetManifest,
  requestId: string,
  patch: Partial<AssetGenerationRequest>,
): ProjectAssetManifest {
  return {
    ...manifest,
    generationRequests: manifest.generationRequests.map((request) =>
      request.id === requestId
        ? { ...request, ...patch, updatedAt: nowIso() }
        : request,
    ),
  };
}

function removeAssetFromProjectManifest(
  manifest: ProjectAssetManifest | null,
  assetId: string,
): ProjectAssetManifest | null {
  if (!manifest) return null;
  return {
    ...manifest,
    assetRefs: manifest.assetRefs.filter((ref) => ref.assetId !== assetId),
    generationRequests: manifest.generationRequests.map((request) => {
      if (request.resultAssetId !== assetId) return request;
      const { resultAssetId: _resultAssetId, generatedFilePath: _generatedFilePath, ...rest } = request;
      return {
        ...rest,
        status: request.status === 'accepted' || request.status === 'ready' ? 'pending' : request.status,
        updatedAt: nowIso(),
      };
    }),
  };
}

async function acceptGeneratedFileForRequest(args: {
  projectDir: string;
  requestId: string;
  filePath: string;
  status?: 'ready' | 'accepted';
}): Promise<{
  asset: AssetRecord;
  library: AssetLibraryFile;
  projectManifest: ProjectAssetManifest;
}> {
  const library = await loadLibrary();
  let manifest = await loadProjectManifest(args.projectDir);
  const request = manifest?.generationRequests.find((item) => item.id === args.requestId);
  if (!manifest || !request) {
    throw new Error('未找到待确认资产请求');
  }
  const imported = await importOneAsset(args.filePath, library, null, 'ai-generated', {
    greenScreen: ['object', 'symbol', 'overlay'].includes(request.role),
  });
  if (!imported) {
    throw new Error('生成结果不是支持的图片/视频/音频文件');
  }
  const asset = {
    ...imported,
    role: request.role,
    name: request.query,
    treatment: { ...imported.treatment, profile: request.visualTreatment },
    semantic: {
      ...imported.semantic,
      tags: Array.from(new Set([...imported.semantic.tags, request.query])),
      style: Array.from(new Set([...imported.semantic.style, request.visualTreatment])),
      usableAs: Array.from(new Set([
        ...imported.semantic.usableAs,
        request.role === 'background' || request.role === 'texture'
          ? 'full-frame-background'
          : 'foreground-object',
        request.slot,
      ])),
    },
  };
  upsertAsset(library, markAssetUsedByProject(asset, args.projectDir));
  const savedLibrary = await saveLibrary(library);
  manifest = addProjectRef(manifest, asset, {
    type: 'motion-card',
    id: request.sourceCardId,
    slot: request.slot,
  })!;
  manifest = updateGenerationRequest(manifest, args.requestId, {
    status: args.status ?? 'accepted',
    resultAssetId: asset.id,
    generatedFilePath: asset.files.processed || asset.files.original,
    error: undefined,
  });
  const savedManifest = await saveProjectManifest(manifest);
  return {
    asset,
    library: await appendProjectAssets(savedLibrary, args.projectDir),
    projectManifest: savedManifest,
  };
}

export async function chromaKeyAsset(
  args: AssetChromaKeyRequest,
  rootDir = defaultRootDir(),
): Promise<AssetChromaKeyResult> {
  const { asset, library, source } = await findAssetForOperation(args.assetId, args.projectDir, rootDir);
  if (asset.kind !== 'image') throw new Error('只有图片资产支持抠图');
  const keyInput = await readPngBufferForChromaKey(asset.files.original);
  if (!keyInput) throw new Error('图片无法读取或转码为 PNG');

  const keyColor = parseKeyColor(args.keyColor);
  const colorSuffix = `${keyColor.r.toString(16).padStart(2, '0')}${keyColor.g
    .toString(16)
    .padStart(2, '0')}${keyColor.b.toString(16).padStart(2, '0')}`;
  const cutoutPath = source === 'project'
    ? cutoutPathForImage(asset.files.original)
    : path.join(
      library.settings.rootDir,
      'processed',
      'cutouts',
      `${asset.id}-${colorSuffix}-${Date.now()}.png`,
    );
  const keyed = await chromaKeyPngBuffer(keyInput, cutoutPath, keyColor);
  if (!keyed.ok || !keyed.outputPath) {
    throw new Error(keyed.reason || '抠图失败');
  }
  const outputStat = await fs.stat(keyed.outputPath);

  const nextAsset: AssetRecord = {
    ...asset,
    files: {
      ...asset.files,
      processed: keyed.outputPath,
      thumbnail: keyed.outputPath,
    },
    metadata: {
      ...asset.metadata,
      width: keyed.width ?? asset.metadata.width,
      height: keyed.height ?? asset.metadata.height,
      hasAlpha: true,
      processedAt: nowIso(),
      processedByteSize: outputStat.size,
      processedColorKey: colorToHex(keyColor),
    },
    semantic: {
      ...asset.semantic,
      usableAs: Array.from(new Set([...asset.semantic.usableAs, 'foreground-object'])),
    },
    updatedAt: nowIso(),
  };
  let savedLibrary = library;
  if (source === 'global') {
    upsertAsset(library, nextAsset);
    savedLibrary = await saveLibrary(library);
  }
  return {
    asset: nextAsset,
    library: withAssetOverride(await appendProjectAssets(savedLibrary, args.projectDir), nextAsset),
    outputPath: keyed.outputPath,
    byteSize: outputStat.size,
    width: keyed.width ?? asset.metadata.width ?? 0,
    height: keyed.height ?? asset.metadata.height ?? 0,
  };
}

export async function replaceOriginalWithProcessedAsset(
  assetId: string,
  rootDir = defaultRootDir(),
  projectDir?: string | null,
): Promise<AssetReplaceOriginalResult> {
  const { asset, library, source } = await findAssetForOperation(assetId, projectDir, rootDir);
  if (asset.kind !== 'image') throw new Error('只有图片资产支持替换原图');
  if (!asset.files.processed) throw new Error('当前资产没有可替换的处理结果');
  const outputStat = await fs.stat(asset.files.processed);
  if (!outputStat.isFile()) throw new Error('处理结果文件不存在');
  const nextOriginalPath = source === 'project'
    ? asset.files.original
    : replacementOriginalPath(library, asset);
  let previousOriginalPath: string | null = asset.metadata.previousOriginalPath ?? null;
  if (!isSamePath(nextOriginalPath, asset.files.processed)) {
    previousOriginalPath = await backupFileIfExists(
      nextOriginalPath,
      source === 'project' && projectDir ? projectDir : library.settings.rootDir,
      source === 'project' ? path.join('assets', 'backups') : path.join('originals', 'backups'),
    );
    if (!previousOriginalPath && !isSamePath(nextOriginalPath, asset.files.original)) {
      previousOriginalPath = asset.files.original;
    }
  }
  await fs.mkdir(path.dirname(nextOriginalPath), { recursive: true });
  if (!isSamePath(asset.files.processed, nextOriginalPath)) {
    await fs.copyFile(asset.files.processed, nextOriginalPath);
  }
  const [{ contentHash, byteSize }, dimensions] = await Promise.all([
    hashFile(nextOriginalPath),
    readAssetDimensions(nextOriginalPath, 'image'),
  ]);
  const stampedAt = nowIso();
  const nextAsset: AssetRecord = {
    ...asset,
    files: {
      ...asset.files,
      original: nextOriginalPath,
      thumbnail: nextOriginalPath,
    },
    metadata: {
      ...asset.metadata,
      width: dimensions.width ?? asset.metadata.width,
      height: dimensions.height ?? asset.metadata.height,
      hasAlpha: true,
      contentHash,
      byteSize,
      originalReplacedAt: stampedAt,
      previousOriginalPath,
    },
    updatedAt: stampedAt,
  };
  if (source === 'global') {
    upsertAsset(library, nextAsset);
    return {
      asset: nextAsset,
      library: withAssetOverride(await appendProjectAssets(await saveLibrary(library), projectDir), nextAsset),
    };
  }
  return { asset: nextAsset, library: withAssetOverride(await appendProjectAssets(library, projectDir), nextAsset) };
}

export async function deleteAssetLibraryAsset(
  args: AssetDeleteRequest,
  rootDir = defaultRootDir(),
): Promise<AssetDeleteResult> {
  const { asset, library, source } = await findAssetForOperation(args.assetId, args.projectDir, rootDir);
  const ownedFiles = source === 'project' && args.projectDir
    ? collectOwnedAssetFiles(asset, args.projectDir)
    : collectOwnedAssetFiles(asset, library.settings.rootDir);
  const { trashedFiles, failedFiles } = await trashAssetFiles(ownedFiles);
  const savedLibrary = source === 'global'
    ? await saveLibrary({
      ...library,
      assets: library.assets.filter((item) => item.id !== args.assetId),
    })
    : library;
  const nextManifest = removeAssetFromProjectManifest(
    await loadProjectManifest(args.projectDir),
    args.assetId,
  );
  const returnLibrary = await appendProjectAssets(savedLibrary, args.projectDir);
  return {
    deletedAssetId: args.assetId,
    trashedFiles,
    failedFiles,
    library: {
      ...returnLibrary,
      assets: returnLibrary.assets.filter((item) => item.id !== args.assetId),
    },
    projectManifest: nextManifest ? await saveProjectManifest(nextManifest) : null,
  };
}

export async function sampleAssetColor(
  args: AssetSampleColorRequest,
  rootDir = defaultRootDir(),
): Promise<AssetSampleColorResult> {
  const { asset } = await findAssetForOperation(args.assetId, args.projectDir, rootDir);
  if (asset.kind !== 'image') throw new Error('只有图片资产支持取色');
  const keyInput = await readPngBufferForChromaKey(asset.files.original);
  if (!keyInput) throw new Error('图片无法读取或转码为 PNG');
  const image = decodePng(keyInput);
  const x = Math.min(image.width - 1, Math.max(0, Math.round(clampRatio(args.xRatio) * (image.width - 1))));
  const y = Math.min(image.height - 1, Math.max(0, Math.round(clampRatio(args.yRatio) * (image.height - 1))));
  const offset = (y * image.width + x) * 4;
  const r = image.rgba[offset];
  const g = image.rgba[offset + 1];
  const b = image.rgba[offset + 2];
  return {
    keyColor: colorToHex({ r, g, b }),
    r,
    g,
    b,
    x,
    y,
  };
}

function markAssetUsedByProject(asset: AssetRecord, projectDir?: string | null): AssetRecord {
  if (!projectDir) return asset;
  if (asset.usage.projectRefs.includes(projectDir)) {
    return {
      ...asset,
      usage: { ...asset.usage, lastUsedAt: nowIso() },
      updatedAt: nowIso(),
    };
  }
  return {
    ...asset,
    usage: {
      ...asset.usage,
      lastUsedAt: nowIso(),
      projectRefs: [...asset.usage.projectRefs, projectDir],
      usageCount: (asset.usage.usageCount ?? 0) + 1,
    },
    updatedAt: nowIso(),
  };
}

function upsertAsset(library: AssetLibraryFile, asset: AssetRecord): void {
  const index = library.assets.findIndex((item) => item.id === asset.id);
  if (index >= 0) {
    library.assets[index] = asset;
  } else {
    library.assets.push(asset);
  }
}

function withAssetOverride(library: AssetLibraryFile, asset: AssetRecord): AssetLibraryFile {
  const index = library.assets.findIndex((item) => item.id === asset.id);
  if (index < 0) return { ...library, assets: [...library.assets, asset] };
  return {
    ...library,
    assets: library.assets.map((item) => (item.id === asset.id ? asset : item)),
  };
}

async function importOneAsset(
  sourcePath: string,
  library: AssetLibraryFile,
  ffprobePath: string | null,
  sourceType: AssetRecord['sourceType'] = 'manual-import',
  processing: { greenScreen?: boolean } = {},
  ffmpegPath?: string | null,
): Promise<AssetRecord | null> {
  const classified = classifyAsset(sourcePath);
  if (!classified) return null;
  const duplicate = library.assets.find(
    (asset) => asset.sourceUri === sourcePath || asset.files.original === sourcePath,
  );
  if (duplicate) return duplicate;

  const [sourceFingerprint, sourceNormalizedHash] = await Promise.all([
    hashFile(sourcePath),
    normalizedMediaHash(sourcePath, classified.kind, ffmpegPath),
  ]);
  const contentDuplicate = library.assets.find(
    (asset) => asset.metadata.contentHash === sourceFingerprint.contentHash || (
      sourceNormalizedHash && asset.metadata.normalizedContentHash === sourceNormalizedHash
    ),
  );
  if (contentDuplicate) return contentDuplicate;

  const id = `asset_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const ext = path.extname(sourcePath).toLowerCase();
  const baseName = sanitizeBaseName(sourcePath);
  const relOriginal = path.join('originals', classified.dir, `${id}${ext}`);
  const absOriginal = path.join(library.settings.rootDir, relOriginal);
  await fs.mkdir(path.dirname(absOriginal), { recursive: true });
  await fs.copyFile(sourcePath, absOriginal);

  const [{ contentHash, byteSize }, dimensions, durationMs, probe] = await Promise.all([
    hashFile(absOriginal),
    readAssetDimensions(absOriginal, classified.kind),
    readDuration(absOriginal, classified.kind, ffprobePath),
    probeMedia(absOriginal, classified.kind, ffprobePath),
  ]);
  const loudness = classified.kind === 'audio' && ffmpegPath
    ? await measureAudioLoudness({ ffmpegPath, inputPath: absOriginal }).catch(() => null)
    : null;
  let processed: string | null = classified.kind === 'image' ? absOriginal : null;
  let thumbnail: string | null = processed;
  let hasAlpha = ext === '.png' || ext === '.webp';
  let processedDimensions: { width?: number | null; height?: number | null } = {};
  if (classified.kind === 'image' && sourceType === 'ai-generated' && processing.greenScreen !== false) {
    let cutoutReady = false;
    const cutoutPath = path.join(library.settings.rootDir, 'processed', 'cutouts', `${id}.png`);
    const keyInput = await readPngBufferForChromaKey(absOriginal);
    if (keyInput) {
      const keyed = await keyGreenScreenPngBuffer(keyInput, cutoutPath);
      if (keyed.ok && keyed.outputPath) {
        processed = keyed.outputPath;
        hasAlpha = true;
        cutoutReady = true;
        processedDimensions = { width: keyed.width, height: keyed.height };
      }
    }
    if (!cutoutReady) hasAlpha = false;
  }
  if (classified.kind === 'video') {
    thumbnail = await createVideoContactSheet({
      filePath: absOriginal,
      outputPath: path.join(library.settings.rootDir, 'processed', 'thumbnails', `${id}.jpg`),
      durationMs: probe.durationMs ?? durationMs,
      ffmpegPath,
    });
  }

  const timestamp = nowIso();
  return {
    id,
    name: baseName,
    kind: classified.kind,
    role: classified.role,
    sourceType,
    sourceUri: sourcePath,
    licenseNote: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    files: {
      original: absOriginal,
      processed,
      thumbnail,
      mask: null,
    },
    metadata: {
      ...dimensions,
      ...probe,
      ...processedDimensions,
      durationMs: probe.durationMs ?? durationMs,
      hasAlpha,
      contentHash,
      byteSize,
      mimeHint: classified.kind,
      normalizedContentHash: sourceNormalizedHash ?? undefined,
      ...(probe.video ? {
        video: { ...probe.video, perceptualHash: sourceNormalizedHash },
      } : {}),
      ...(classified.kind === 'audio' ? {
        audio: {
          ...probe.audio,
          integratedLufs: loudness?.integratedLufs ?? null,
          truePeakDbtp: loudness?.truePeakDbtp ?? null,
        },
      } : {}),
    },
    semantic: {
      ...EMPTY_ASSET_SEMANTIC,
      usableAs: classified.kind === 'image' ? ['foreground-object'] : [],
    },
    treatment: { ...DEFAULT_ASSET_TREATMENT },
    usage: {
      projectRefs: [],
      favorite: false,
      usageCount: 0,
      rating: null,
      deprecated: false,
    },
  };
}

export async function importGeneratedMediaAsset(
  request: GeneratedAssetImportRequest,
  ffprobePath: string | null,
  ffmpegPath?: string | null,
): Promise<AssetRecord> {
  return serializeAssetMutation(async () => {
    const library = await loadLibrary();
    const imported = await importOneAsset(
      request.filePath,
      library,
      ffprobePath,
      'ai-generated',
      { greenScreen: request.role === 'greenscreen-video' },
      ffmpegPath,
    );
    if (!imported) throw new Error('生成结果不是支持的音频或视频文件');
    const asset: AssetRecord = {
      ...imported,
      name: request.name.trim() || imported.name,
      role: request.role,
      licenseNote: request.licenseNote ?? imported.licenseNote,
      metadata: {
        ...imported.metadata,
        reuseKey: request.reuseKey,
        provenance: request.provenance,
        quality: { status: 'passed' },
        ...(request.audio ? { audio: { ...imported.metadata.audio, ...request.audio } } : {}),
        ...(request.video ? { video: { ...imported.metadata.video, ...request.video } } : {}),
      },
      semantic: {
        tags: Array.from(new Set([...imported.semantic.tags, ...(request.semantic?.tags ?? [])])),
        topics: Array.from(new Set([...imported.semantic.topics, ...(request.semantic?.topics ?? [])])),
        style: Array.from(new Set([...imported.semantic.style, ...(request.semantic?.style ?? [])])),
        usableAs: Array.from(new Set([
          ...imported.semantic.usableAs,
          ...(request.semantic?.usableAs ?? []),
          request.role,
        ])),
      },
    };
    upsertAsset(library, markAssetUsedByProject(asset, request.projectDir));
    await saveLibrary(library);
    if (request.projectDir) {
      const manifest = addProjectRef(await loadProjectManifest(request.projectDir), asset, {
        type: 'manual',
        slot: request.role,
      });
      if (manifest) await saveProjectManifest(manifest);
    }
    return asset;
  });
}

async function selectAssetFiles(mainWindow: BrowserWindow | null): Promise<string[] | null> {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入到资产中心',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: '素材文件',
        extensions: [
          'jpg',
          'jpeg',
          'png',
          'gif',
          'webp',
          'mp4',
          'mov',
          'webm',
          'm4v',
          'mp3',
          'wav',
          'aac',
          'm4a',
          'flac',
          'ogg',
          'opus',
        ],
      },
    ],
  });
  return result.canceled ? null : result.filePaths;
}

export function applyAssetUpdatePatch(asset: AssetRecord, patch: AssetUpdatePatch): AssetRecord {
  return {
    ...asset,
    ...('name' in patch && patch.name != null ? { name: patch.name } : {}),
    ...('role' in patch && patch.role ? { role: patch.role } : {}),
    ...('licenseNote' in patch ? { licenseNote: patch.licenseNote ?? '' } : {}),
    metadata: {
      ...asset.metadata,
      ...(patch.audio ? { audio: { ...asset.metadata.audio, ...patch.audio } } : {}),
    },
    semantic: { ...asset.semantic, ...(patch.semantic ?? {}) },
    treatment: { ...asset.treatment, ...(patch.treatment ?? {}) },
    usage: {
      ...asset.usage,
      favorite: patch.favorite ?? asset.usage.favorite,
      rating: 'rating' in patch ? patch.rating ?? null : asset.usage.rating,
      deprecated: patch.deprecated ?? asset.usage.deprecated,
    },
    updatedAt: nowIso(),
  };
}

export function registerAssetLibraryIpc(ctx: AssetLibraryIpcContext): void {
  ipcMain.handle('asset-library:get-state', async (_event, projectDir?: string | null) => {
    return loadAssetLibraryState(projectDir);
  });

  ipcMain.handle(
    'asset-library:search-reusable',
    async (_event, args: { projectDir: string; request: MediaAssetRequest }) =>
      searchReusableMediaAssetsForProject(args),
  );

  ipcMain.handle(
    'asset-library:import-files',
    async (_event, request: AssetImportRequest = {}): Promise<AssetImportResult> => {
      const filePaths = request.filePaths?.length
        ? request.filePaths
        : await selectAssetFiles(ctx.getMainWindow());
      return serializeAssetMutation(async () => {
        const library = await loadLibrary();
        let projectManifest = await loadProjectManifest(request.projectDir);
        const imported: AssetRecord[] = [];
        const skipped: AssetImportResult['skipped'] = [];

        if (!filePaths?.length) {
          return { imported, skipped, library, projectManifest };
        }

        const { ffprobePath, ffmpegPath } = ctx.resolveRuntimeBinaries();
        for (const filePath of filePaths) {
          try {
            const asset = await importOneAsset(filePath, library, ffprobePath, 'manual-import', {}, ffmpegPath);
            if (!asset) {
              skipped.push({ path: filePath, reason: '不支持的文件类型' });
              continue;
            }
            const nextAsset = markAssetUsedByProject(asset, request.projectDir);
            upsertAsset(library, nextAsset);
            projectManifest = addProjectRef(projectManifest, nextAsset);
            imported.push(nextAsset);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            skipped.push({ path: filePath, reason });
            ctx.writeAppLog('warn', 'asset-library', `导入资产失败: ${filePath}`, reason);
          }
        }

        const nextLibrary = await saveLibrary(library);
        const nextManifest = projectManifest ? await saveProjectManifest(projectManifest) : null;
        return {
          imported,
          skipped,
          library: await appendProjectAssets(nextLibrary, request.projectDir),
          projectManifest: nextManifest,
        };
      });
    },
  );

  ipcMain.handle(
    'asset-library:update-asset',
    async (_event, assetId: string, patch: AssetUpdatePatch) => {
      return serializeAssetMutation(async () => {
        const library = await loadLibrary();
        const nextAssets = library.assets.map((asset) => {
          if (asset.id !== assetId) return asset;
          return applyAssetUpdatePatch(asset, patch);
        });
        return saveLibrary({ ...library, assets: nextAssets });
      });
    },
  );

  ipcMain.handle(
    'asset-library:delete-asset',
    async (_event, args: AssetDeleteRequest): Promise<AssetDeleteResult> => {
      return serializeAssetMutation(() => deleteAssetLibraryAsset(args));
    },
  );

  ipcMain.handle(
    'asset-library:chroma-key-asset',
    async (_event, args: AssetChromaKeyRequest): Promise<AssetChromaKeyResult> => {
      return serializeAssetMutation(() => chromaKeyAsset(args));
    },
  );

  ipcMain.handle(
    'asset-library:replace-original-with-processed',
    async (
      _event,
      assetId: string,
      projectDir?: string | null,
    ): Promise<AssetReplaceOriginalResult> => {
      return serializeAssetMutation(() =>
        replaceOriginalWithProcessedAsset(assetId, defaultRootDir(), projectDir));
    },
  );

  ipcMain.handle(
    'asset-library:sample-color',
    async (_event, args: AssetSampleColorRequest): Promise<AssetSampleColorResult> => {
      return sampleAssetColor(args);
    },
  );

  ipcMain.handle(
    'asset-library:add-to-project',
    async (_event, projectDir: string, assetId: string): Promise<ProjectAssetManifest | null> => {
      return serializeAssetMutation(async () => {
        const library = await loadLibrary();
        const projectAsset = (await scanProjectAssetRecords(projectDir)).find((item) => item.id === assetId);
        const found = library.assets.find((item) => item.id === assetId) ?? projectAsset;
        const asset = found ? await normalizeAssetFilesForResolution(found) : null;
        if (!asset) throw new Error('素材文件已失效，请重新检索素材库');
        if (asset.sourceType !== 'project-local') {
          upsertAsset(library, markAssetUsedByProject(asset, projectDir));
          await saveLibrary(library);
        }
        const manifest = addProjectRef(await loadProjectManifest(projectDir), asset);
        return manifest ? saveProjectManifest(manifest) : null;
      });
    },
  );

  ipcMain.handle(
    'asset-library:resolve-requests',
    async (
      _event,
      args: {
        projectDir: string;
        requests: StoryboardAssetRequest[];
        sourceCardId?: string;
      },
    ) => {
      return resolveAssetRequestsForProject(args);
    },
  );

  ipcMain.handle(
    'asset-library:accept-generated-file',
    async (
      _event,
      args: { projectDir: string; requestId: string; filePath: string },
    ) => {
      return serializeAssetMutation(() => acceptGeneratedFileForRequest(args));
    },
  );

  ipcMain.handle(
    'asset-library:update-generation-request',
    async (
      _event,
      args: { projectDir: string; requestId: string; patch: Partial<AssetGenerationRequest> },
    ) => {
      return serializeAssetMutation(async () => {
        const manifest = await loadProjectManifest(args.projectDir);
        if (!manifest) return null;
        return saveProjectManifest(updateGenerationRequest(manifest, args.requestId, args.patch));
      });
    },
  );
}
