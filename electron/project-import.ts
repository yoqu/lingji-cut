import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { loadProjectFile, saveProjectSection } from './project-file';
import type { ProjectData } from '../src/lib/project-persistence';
import type { TimelineData, OverlayItem, TTSAsset } from '../src/types';
import type {
  DetectedFile,
  DetectedFileKind,
  ImportProjectScanResult,
  ImportProjectScenario,
  AssetReferenceSummary,
  MissingAssetItem,
  AssetReferenceKind,
  AssetFixReport,
  AssetFixItem,
  ImportProjectArgs,
  ImportProjectResult,
  ImportProjectErrorCode,
} from '../src/lib/project-import-types';

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'release',
  'dist',
  'dist-electron',
  'work',
]);
const MAX_SCAN_DEPTH = 3;
const MAX_MISSING_REPORT = 50;

// ─────────────────────────────────────────────────────────────
// 文件分类与场景识别（Task 2）
// ─────────────────────────────────────────────────────────────

function classifyFile(relativePath: string, basename: string): DetectedFileKind {
  if (relativePath === 'project.json') return 'projectJson';
  if (relativePath === 'script.md') return 'scriptMd';
  if (relativePath === 'original.md') return 'originalMd';
  if (basename.endsWith('.mp3') && basename.startsWith('podcast-audio')) return 'audioMp3';
  if (basename.endsWith('.srt') && basename.startsWith('podcast-subtitles')) return 'subtitleSrt';
  if (relativePath.startsWith('covers/')) return 'coverImage';
  if (relativePath.startsWith('ai-cards/')) return 'aiCard';
  if (relativePath.startsWith('imports/douyin/')) return 'douyinImport';
  if (relativePath.startsWith('configs/prompts/')) return 'promptOverride';
  return 'other';
}

async function collectDetectedFiles(projectDir: string): Promise<DetectedFile[]> {
  const results: DetectedFile[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        await walk(absPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relPath = path.relative(projectDir, absPath).split(path.sep).join('/');
      let stat;
      try {
        stat = await fs.stat(absPath);
      } catch {
        continue;
      }
      results.push({
        relativePath: relPath,
        bytes: stat.size,
        kind: classifyFile(relPath, entry.name),
      });
    }
  }
  await walk(projectDir, 0);
  return results;
}

function classifyScenario(files: DetectedFile[]): ImportProjectScenario {
  const kinds = new Set(files.map((f) => f.kind));
  if (kinds.has('projectJson')) return 'complete';
  if (
    kinds.has('audioMp3') ||
    kinds.has('scriptMd') ||
    kinds.has('originalMd') ||
    kinds.has('subtitleSrt')
  ) {
    return 'mediaOnly';
  }
  return 'unrecognized';
}

// ─────────────────────────────────────────────────────────────
// 路径引用收集（Task 3）
// ─────────────────────────────────────────────────────────────

interface AssetReferenceEntry {
  kind: AssetReferenceKind;
  refId?: string;
  originalPath: string;
}

function collectTimelineAssetReferences(timeline: TimelineData | null): AssetReferenceEntry[] {
  if (!timeline) return [];
  const refs: AssetReferenceEntry[] = [];
  if (timeline.podcast?.audioPath) {
    refs.push({ kind: 'podcastAudio', originalPath: timeline.podcast.audioPath });
  }
  if (timeline.podcast?.srtPath) {
    refs.push({ kind: 'podcastSubtitle', originalPath: timeline.podcast.srtPath });
  }
  for (const overlay of timeline.overlays ?? []) {
    if (
      (overlay.type === 'video' || overlay.type === 'image' || overlay.type === 'audio') &&
      overlay.assetPath
    ) {
      refs.push({
        kind: 'overlayAsset',
        refId: overlay.id,
        originalPath: overlay.assetPath,
      });
    }
  }
  for (const tts of timeline.ttsAssets ?? []) {
    if (tts.filePath) {
      refs.push({
        kind: 'ttsAsset',
        refId: tts.id,
        originalPath: tts.filePath,
      });
    }
  }
  return refs;
}

// ─────────────────────────────────────────────────────────────
// basename 索引与匹配（Task 3）
// ─────────────────────────────────────────────────────────────

function buildBasenameIndex(projectDir: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  function walk(dir: string, depth: number): void {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        walk(absPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const list = index.get(entry.name) ?? [];
      list.push(absPath);
      index.set(entry.name, list);
    }
  }
  walk(projectDir, 0);
  return index;
}

function pickBestMatch(candidates: string[], _originalPath: string): string {
  return candidates.slice().sort((a, b) => {
    const da = a.split(path.sep).length;
    const db = b.split(path.sep).length;
    if (da !== db) return da - db;
    return a.length - b.length;
  })[0];
}

// ─────────────────────────────────────────────────────────────
// 路径修复算法（Task 3）
// ─────────────────────────────────────────────────────────────

export function planAssetNormalization(
  projectDir: string,
  refs: AssetReferenceEntry[],
): AssetReferenceSummary {
  if (refs.length === 0) {
    return {
      totalReferences: 0,
      intactCount: 0,
      fixableCount: 0,
      missingCount: 0,
      missingItems: [],
    };
  }

  let intactCount = 0;
  let fixableCount = 0;
  const missingItems: MissingAssetItem[] = [];
  let basenameIndex: Map<string, string[]> | null = null;

  for (const ref of refs) {
    const originalPath = ref.originalPath;
    let resolved = originalPath;
    if (!path.isAbsolute(resolved)) {
      resolved = path.resolve(projectDir, resolved);
    }
    if (existsSync(resolved)) {
      intactCount += 1;
      continue;
    }
    if (!basenameIndex) basenameIndex = buildBasenameIndex(projectDir);
    const matches = basenameIndex.get(path.basename(originalPath));
    if (matches && matches.length > 0) {
      fixableCount += 1;
    } else {
      missingItems.push({
        refId: ref.refId,
        kind: ref.kind,
        originalPath,
        basename: path.basename(originalPath),
      });
    }
  }

  return {
    totalReferences: refs.length,
    intactCount,
    fixableCount,
    missingCount: missingItems.length,
    missingItems: missingItems.slice(0, MAX_MISSING_REPORT),
  };
}

export interface NormalizeAssetPathsResult {
  data: ProjectData;
  fixReport: AssetFixReport;
  changed: boolean;
}

export function normalizeAssetPaths(
  data: ProjectData,
  projectDir: string,
): NormalizeAssetPathsResult {
  const timeline = data.timeline;
  if (!timeline) {
    return { data, fixReport: { fixed: [], missing: [] }, changed: false };
  }

  const fixed: AssetFixItem[] = [];
  const missing: MissingAssetItem[] = [];
  let basenameIndex: Map<string, string[]> | null = null;
  let changed = false;

  const tryFix = (
    originalPath: string,
    kind: AssetReferenceKind,
    refId?: string,
  ): string => {
    if (!originalPath) return originalPath;
    let resolved = originalPath;
    if (!path.isAbsolute(resolved)) {
      resolved = path.resolve(projectDir, resolved);
    }
    if (existsSync(resolved)) return originalPath;
    if (!basenameIndex) basenameIndex = buildBasenameIndex(projectDir);
    const matches = basenameIndex.get(path.basename(originalPath));
    if (!matches || matches.length === 0) {
      missing.push({
        refId,
        kind,
        originalPath,
        basename: path.basename(originalPath),
      });
      return originalPath;
    }
    const newPath = pickBestMatch(matches, originalPath);
    if (newPath !== originalPath) {
      fixed.push({ kind, refId, originalPath, newPath });
      changed = true;
      return newPath;
    }
    return originalPath;
  };

  const nextPodcast = timeline.podcast
    ? {
        ...timeline.podcast,
        audioPath: timeline.podcast.audioPath
          ? tryFix(timeline.podcast.audioPath, 'podcastAudio')
          : timeline.podcast.audioPath,
        srtPath: timeline.podcast.srtPath
          ? tryFix(timeline.podcast.srtPath, 'podcastSubtitle')
          : timeline.podcast.srtPath,
      }
    : timeline.podcast;

  const nextOverlays: OverlayItem[] = (timeline.overlays ?? []).map((overlay) => {
    if (!overlay.assetPath) return overlay;
    if (overlay.type !== 'video' && overlay.type !== 'image' && overlay.type !== 'audio') {
      return overlay;
    }
    const newPath = tryFix(overlay.assetPath, 'overlayAsset', overlay.id);
    return newPath === overlay.assetPath ? overlay : { ...overlay, assetPath: newPath };
  });

  const nextTTSAssets: TTSAsset[] | undefined = timeline.ttsAssets?.map((tts) => {
    if (!tts.filePath) return tts;
    const newPath = tryFix(tts.filePath, 'ttsAsset', tts.id);
    return newPath === tts.filePath ? tts : { ...tts, filePath: newPath };
  });

  const nextTimeline: TimelineData = {
    ...timeline,
    podcast: nextPodcast,
    overlays: nextOverlays,
    ttsAssets: nextTTSAssets,
  };

  return {
    data: { ...data, timeline: nextTimeline },
    fixReport: {
      fixed,
      missing: missing.slice(0, MAX_MISSING_REPORT),
    },
    changed,
  };
}

// ─────────────────────────────────────────────────────────────
// scanProjectDirectory（Task 2）
// ─────────────────────────────────────────────────────────────

async function readProjectJsonSafely(projectDir: string): Promise<ProjectData | null> {
  try {
    const raw = await fs.readFile(path.join(projectDir, 'project.json'), 'utf-8');
    return JSON.parse(raw) as ProjectData;
  } catch {
    return null;
  }
}

export async function scanProjectDirectory(
  projectDir: string,
): Promise<ImportProjectScanResult> {
  if (!existsSync(projectDir)) {
    throw new Error(`项目目录不存在：${projectDir}`);
  }
  const stat = await fs.stat(projectDir);
  if (!stat.isDirectory()) {
    throw new Error(`路径不是目录：${projectDir}`);
  }

  const detectedFiles = await collectDetectedFiles(projectDir);
  const scenario = classifyScenario(detectedFiles);

  let timeline: TimelineData | null = null;
  let coverCandidateCount = 0;
  if (scenario === 'complete') {
    const data = await readProjectJsonSafely(projectDir);
    timeline = data?.timeline ?? null;
    coverCandidateCount = data?.aiAnalysis?.coverCandidates?.length ?? 0;
  }

  const refs = collectTimelineAssetReferences(timeline);
  const assetReferences = planAssetNormalization(projectDir, refs);

  let blockReason: string | undefined;
  if (scenario === 'unrecognized') {
    blockReason =
      '目录中未找到 project.json 或核心媒资文件（podcast-audio.mp3 / script.md 等）。建议使用「新建工程」。';
  }

  const timelineItemCount = timeline?.overlays?.length ?? 0;

  return {
    projectDir,
    projectName: path.basename(projectDir),
    scenario,
    detectedFiles,
    timelineItemCount,
    coverCandidateCount,
    assetReferences,
    blockReason,
  };
}

// ─────────────────────────────────────────────────────────────
// importProject 编排（Task 4）
// ─────────────────────────────────────────────────────────────

export class ImportProjectError extends Error {
  constructor(
    public code: ImportProjectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImportProjectError';
  }
}

export async function importProject(args: ImportProjectArgs): Promise<ImportProjectResult> {
  const { projectDir, acceptMissingAssets } = args;
  let scan: ImportProjectScanResult;
  try {
    scan = await scanProjectDirectory(projectDir);
  } catch (err) {
    throw new ImportProjectError('scan_failed', (err as Error).message);
  }

  if (scan.scenario === 'unrecognized') {
    throw new ImportProjectError('unrecognized', scan.blockReason ?? '目录无法识别为项目');
  }
  if (scan.assetReferences.missingCount > 0 && !acceptMissingAssets) {
    throw new ImportProjectError(
      'missing_assets',
      `存在 ${scan.assetReferences.missingCount} 个缺失素材，请勾选「允许缺失素材继续导入」`,
    );
  }

  let data: ProjectData;
  try {
    data = await loadProjectFile(projectDir);
  } catch (err) {
    throw new ImportProjectError('load_failed', `读取项目失败：${(err as Error).message}`);
  }

  const { data: fixedData, fixReport, changed } = normalizeAssetPaths(data, projectDir);

  if (changed && fixedData.timeline) {
    try {
      await saveProjectSection(projectDir, 'timeline', fixedData.timeline);
    } catch (err) {
      throw new ImportProjectError(
        'save_failed',
        `保存修复后的时间线失败：${(err as Error).message}`,
      );
    }
  }

  return {
    projectDir,
    projectName: scan.projectName,
    scenario: scan.scenario,
    fixReport,
  };
}
