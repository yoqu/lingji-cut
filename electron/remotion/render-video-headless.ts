// Electron UI 与 headless CLI 共用的 Remotion 导出入口。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { app } from 'electron';
import type { ExportConfig } from '../../src/lib/export-settings';
import { buildExportRenderConfig } from '../../src/lib/export-settings';
import type { SrtEntry, TimelineData } from '../../src/types';
import { parseSrt } from '../../src/lib/srt-parser';
import { compileCards, type CompiledCard } from './compile-card-node';
import { getRemotionBundle } from './bundle';
import {
  renderRemotionVideo,
  selectRemotionComposition,
} from './render';
import { collectMotionCards } from '../../src/remotion/collect-cards';
import {
  hydrateTimelineCards,
  motionCardTsxPath,
} from '../../src/lib/motion-card-externalize';
import { prepareTimelineForHyperframes, type HyperframesAssetDescriptor } from '../../src/hyperframes/assets';
import {
  collectMotionCardAssets,
  externalizeMotionCardDataUris,
  rewriteMotionCardAssetReferences,
} from './motion-card-assets';
import type { ProjectData } from '../../src/lib/project-persistence';
import {
  collectProductionFingerprintPaths,
  evaluateProductionQuality,
  type ProductionQualityFingerprintAudit,
} from '../../src/lib/production-quality';
import { mutateProjectProduction } from '../project-file';
import { readLocalFileFingerprint } from '../footage/file-fingerprint';
import { resolveFfmpegPath } from '../runtime-binaries';
import { masterVideoAudio } from '../audio-mastering';
import { resolveBundledRemotionBrowserExecutable } from './browser-runtime';
import { startRemotionLocalServer } from './local-server';
import {
  renderChunkedVideo,
  resolveChunkExecutionConfig,
  resolveFramesPerChunk,
} from './chunk-renderer';
import {
  probeFfmpegEncoder,
  probeMediaFile,
  type FfmpegEncoderProbe,
  type MediaProbeResult,
} from './gpu-runtime';

// 以下三个辅助函数由 electron/main.ts 原样迁入（仅 render-video 使用）。

async function materializeRenderAssets(
  publicDir: string,
  assets: HyperframesAssetDescriptor[],
): Promise<void> {
  await Promise.all(
    assets.map(async (asset) => {
      const targetPath = path.join(publicDir, asset.publicPath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });

      try {
        await fs.link(asset.sourcePath, targetPath);
      } catch {
        await fs.copyFile(asset.sourcePath, targetPath);
      }
    }),
  );
}

export function resolveRenderProjectDir(projectDir: string): string {
  const normalized = typeof projectDir === 'string' ? projectDir.trim() : '';
  if (!normalized) {
    throw new Error('导出缺少项目目录，无法校验当前制作状态');
  }
  if (!path.isAbsolute(normalized)) {
    throw new Error('导出项目目录必须是绝对路径，无法校验当前制作状态');
  }
  return path.normalize(normalized);
}

function normalizeTimelineForComparison(timeline: TimelineData): TimelineData {
  const normalized = JSON.parse(JSON.stringify(timeline)) as TimelineData;
  for (const overlay of normalized.overlays) {
    const motionCard = overlay.aiCardData?.motionCard;
    if (
      overlay.aiCardData?.renderMode === 'motion-card'
      && motionCard?.tsx?.trim()
      && !motionCard.tsxPath
    ) {
      motionCard.tsxPath = motionCardTsxPath(overlay.id);
    }
  }
  return normalized;
}

function assertRequestedTimelineCurrent(
  requested: TimelineData,
  persisted: TimelineData,
): void {
  if (!isDeepStrictEqual(
    normalizeTimelineForComparison(requested),
    normalizeTimelineForComparison(persisted),
  )) {
    throw new Error('导出时间线与项目当前时间线不一致，请等待保存完成后重试');
  }
}

async function auditProductionFingerprints(
  project: ProjectData,
  projectDir: string,
): Promise<ProductionQualityFingerprintAudit> {
  const entries = await Promise.all(
    collectProductionFingerprintPaths(project).map(async (persistedPath) => {
      const resolvedPath = path.isAbsolute(persistedPath)
        ? persistedPath
        : path.resolve(projectDir, persistedPath);
      const fingerprint = await readLocalFileFingerprint(resolvedPath);
      return [persistedPath, fingerprint] as const;
    }),
  );
  return { currentByPath: new Map(entries) };
}

function qualityExportSnapshotHash(project: ProjectData): string {
  const production = project.production;
  const execution = project.production?.execution;
  const executionInput = execution
    ? { ...execution, qualityReport: undefined }
    : null;
  const payload = {
    timeline: project.timeline,
    analysisResult: project.aiAnalysis.analysisResult,
    stylePresetId: project.stylePresetId,
    approvedPlan: production?.approvedPlan ?? null,
    workflow: production?.workflow ?? null,
    outputs: production?.outputs ?? null,
    pendingImpact: production?.pendingImpact ?? null,
    footage: production?.footage ?? null,
    execution: executionInput,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function assertQualityExportSnapshot(
  project: ProjectData,
  expectedHash: string,
): void {
  if (qualityExportSnapshotHash(project) !== expectedHash) {
    throw new Error('质量导出期间项目画面或制作输入已更新，请基于最新版本重新导出');
  }
}

async function assertQualityExportSnapshotCurrent(
  projectDir: string,
  expectedHash: string,
): Promise<void> {
  const current = JSON.parse(
    await fs.readFile(path.join(projectDir, 'project.json'), 'utf-8'),
  ) as ProjectData;
  assertQualityExportSnapshot(current, expectedHash);
}

export async function createRenderPublicDir(
  timeline: TimelineData,
  projectDir: string,
): Promise<{
  timeline: TimelineData;
  publicDir: string;
}> {
  const resolvedProjectDir = resolveRenderProjectDir(projectDir);
  const { timeline: renderTimeline, assets } = prepareTimelineForHyperframes(
    timeline,
    resolvedProjectDir,
  );
  const motionCardAssets = await collectMotionCardAssets(timeline, resolvedProjectDir);
  const assetSources = [...new Map(
    [...assets, ...motionCardAssets].map((asset) => [asset.publicPath, asset]),
  ).values()];
  const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingjijianying-public-'));
  await materializeRenderAssets(publicDir, assetSources);

  return {
    timeline: renderTimeline,
    publicDir,
  };
}

/** 递归复制目录，优先硬链接（同卷零拷贝，比整量 copy 快一个量级），失败回退 copyFile。 */
async function copyDirPreferHardlinks(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const from = path.join(src, entry.name);
      const to = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await copyDirPreferHardlinks(from, to);
        return;
      }
      try {
        await fs.link(from, to);
      } catch {
        await fs.copyFile(from, to);
      }
    }),
  );
}

/**
 * 把只读的 Remotion 站点产物（dev 缓存 bundle / 打包态 dist-remotion）与本次导出
 * materialize 的素材合成一个可写临时 serve 目录：站点在前、素材注入 public/
 * （staticFile 解析根），返回目录作为 Remotion serveUrl。调用方负责清理返回目录。
 *
 * 站点产物跨导出复用（dev bundle 按 entry 缓存、打包态 dist-remotion 构建期生成），
 * 每次导出只付出硬链接级的组装成本。
 *
 * 打包态注意：dist-remotion 经 asar-unpack 落在 app.asar.unpacked（真实目录），
 * 必须用真实路径——Electron 的 asar 透明层不支持对目录做递归 copy，走 app.asar
 * 虚拟路径会 ENOENT。
 */
async function prepareServeDir(siteDir: string, publicDir: string): Promise<string> {
  const serveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingjijianying-serve-'));
  await copyDirPreferHardlinks(siteDir, serveDir);
  await copyDirPreferHardlinks(publicDir, path.join(serveDir, 'public'));
  return serveDir;
}

/**
 * 打包态 compositor 二进制包名（@remotion/compositor-<platform>-<arch>）。
 * 仅覆盖打包目标 macOS / Windows；其它平台返回 null，回退 Remotion 默认解析。
 */
function compositorPackageName(): string | null {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64'
      ? '@remotion/compositor-darwin-arm64'
      : '@remotion/compositor-darwin-x64';
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return '@remotion/compositor-win32-x64-msvc';
  }
  return null;
}

/**
 * 打包态把 Remotion 二进制目录指向 app.asar.unpacked 真实路径，绕过 asar 的 chmod ENOTDIR。
 * dev 态返回 undefined，沿用 Remotion 默认（真实 node_modules 内的 compositor 包）。
 */
function resolveRemotionBinariesDirectory(): string | undefined {
  const pkg = compositorPackageName();
  if (!pkg) return undefined;
  if (!app.isPackaged) {
    try {
      return path.dirname(require.resolve(`${pkg}/package.json`));
    } catch {
      return undefined;
    }
  }
  return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', ...pkg.split('/'));
}

function remotionBinaryPath(
  binariesDirectory: string | undefined,
  binary: 'ffmpeg' | 'ffprobe',
): string | null {
  if (!binariesDirectory) return null;
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return path.join(binariesDirectory, `${binary}${suffix}`);
}

function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [numerator, denominator = '1'] = value.split('/');
  const ratio = Number(numerator) / Number(denominator);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

function assertFinalMedia(
  probe: MediaProbeResult,
  expected: {
    width: number;
    height: number;
    fps: number;
    totalFrames: number;
  },
): void {
  if (!probe.ok) throw new Error(probe.error ?? 'ffprobe failed for final video');
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
  if (video?.codec_name !== 'h264') {
    throw new Error(`Final video codec must be h264, got ${video?.codec_name ?? 'missing'}`);
  }
  if (audio?.codec_name !== 'aac') {
    throw new Error(`Final audio codec must be aac, got ${audio?.codec_name ?? 'missing'}`);
  }
  if (video.width !== expected.width || video.height !== expected.height) {
    throw new Error(
      `Final dimensions must be ${expected.width}x${expected.height}, got ${video.width}x${video.height}`,
    );
  }
  const actualFps = parseFrameRate(video.avg_frame_rate ?? video.r_frame_rate);
  if (actualFps === null || Math.abs(actualFps - expected.fps) > 0.01) {
    throw new Error(`Final frame rate must be ${expected.fps}, got ${actualFps ?? 'unknown'}`);
  }
  const reportedFrames = Number(video.nb_frames);
  if (Number.isFinite(reportedFrames) && reportedFrames !== expected.totalFrames) {
    throw new Error(`Final frame count must be ${expected.totalFrames}, got ${reportedFrames}`);
  }
  const expectedDuration = expected.totalFrames / expected.fps;
  if (
    probe.durationSeconds !== null &&
    Math.abs(probe.durationSeconds - expectedDuration) > Math.max(0.2, 2 / expected.fps)
  ) {
    throw new Error(
      `Final duration must be about ${expectedDuration.toFixed(3)}s, got ${probe.durationSeconds.toFixed(3)}s`,
    );
  }
}

async function atomicallyReplaceOutput(tempPath: string, outputPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  // tempPath 与 outputPath 位于同一目录；rename 会在同一文件系统内原子替换目标，
  // 不先移走旧文件，避免进程在两次操作之间退出后正式路径消失。
  await fs.rename(tempPath, outputPath);
}

/**
 * 准备 Remotion 浏览器下载缓存目录，并返回 chdir 进入的工作目录。
 *
 * 背景：Remotion 内部 `getDownloadsCacheDir()` 会从 `process.cwd()` 向上查找
 * 第一个含 `package.json` 的目录，命中后用 `<dir>/node_modules/.remotion`；
 * 找不到（DMG 启动时 cwd 多为 `/`）则 fallback 到 `path.resolve(cwd, ".remotion")`
 * = `/.remotion`，随后 `mkdir` 因根目录不可写而抛 `ENOENT: no such file or
 * directory, mkdir '/.remotion'`（macOS 上 mkdir 在 `/` 下被禁，会以 ENOENT 报错）。
 *
 * dev 态 cwd 是工程根、有 package.json，所以没问题；打包态必须显式给一个可写根。
 *
 * 方案：在 `<userData>/remotion-cache` 下写一份最小 `package.json`，让 Remotion
 * 把缓存落到 `<userData>/remotion-cache/node_modules/.remotion`，整路径都可写。
 * 调用方在 finally 里 restore 原 cwd，避免长尾影响其他主进程逻辑。
 */
async function prepareRemotionCwd(): Promise<{ cwd: string } | null> {
  if (!app.isPackaged) return null;
  const cacheRoot = path.join(app.getPath('userData'), 'remotion-cache');
  await fs.mkdir(cacheRoot, { recursive: true });
  const pkgPath = path.join(cacheRoot, 'package.json');
  try {
    await fs.access(pkgPath);
  } catch {
    await fs.writeFile(
      pkgPath,
      JSON.stringify({ name: 'lingjijianying-remotion-cache', private: true, version: '0.0.0' }, null, 2),
    );
  }
  // node_modules 目录也提前创建，Remotion 内部会直接拼 node_modules/.remotion/...，
  // 父目录不存在的话首次 mkdir 仍会 ENOENT（其内部用的不是 recursive）。
  await fs.mkdir(path.join(cacheRoot, 'node_modules'), { recursive: true });
  return { cwd: cacheRoot };
}

const MAX_AUTOMATIC_EXPORT_CONCURRENCY = 4;

/**
 * Remotion 会为每个并发槽创建独立页面，并把完整 inputProps 注入每个页面。
 * 大型项目在高核心数机器上按 `cpuCount - 2` 启动二十多个页面时，Chrome 会在
 * 页面导航阶段重置部分连接，最终报 `Visited ... but got no response`。
 * 默认并发限制为 4；显式环境变量仍用于受控性能诊断。
 */
export function resolveExportConcurrency(cpuCount: number, envValue?: string): number {
  const explicit = Number(envValue);
  if (Number.isInteger(explicit) && explicit >= 1) return explicit;

  const normalizedCpuCount = Number.isFinite(cpuCount) ? Math.floor(cpuCount) : 1;
  return Math.min(
    MAX_AUTOMATIC_EXPORT_CONCURRENCY,
    Math.max(1, normalizedCpuCount - 2),
  );
}

export interface RenderVideoArgs {
  projectDir: string;
  timeline: string;
  outputPath: string;
  exportConfig: ExportConfig;
  // Renderer 侧 store 中切分后的字幕；若未提供则回退到磁盘原始 SRT。
  // 磁盘 .srt 文件始终保持 MiniMax 原始输出（不写回），所以若只靠主进程重解析
  // 就会忽略用户的字幕重切分结果，与预览播放器不一致。
  srtEntries?: SrtEntry[];
}

export async function renderVideoHeadless(
  args: RenderVideoArgs,
  opts: {
    onProgress?: (fraction: number) => void;
    onMotionCardCompileErrors?: (errors: CompiledCard[], total: number) => void;
    /**
     * 可选 telemetry 钩子，签名与 main.ts 的 makeMainTelemetry 产物兼容。
     * 缺省 no-op。发出 4 个 stage：export.assets / export.compile-cards / export.bundle / export.render。
     */
    telemetry?: { emit: (kind: string, extra?: Record<string, unknown>) => void };
  } = {},
): Promise<{ outputPath: string }> {
  const onProgress = opts.onProgress ?? (() => {});
  const tel = opts.telemetry ?? { emit: () => undefined };
  const requestedOutputPath = path.resolve(args.outputPath);

  const isDev = !app.isPackaged;
  const renderLogPrefix = '[render-video]';
  const renderStartedAt = Date.now();
  const timestamp = () => `${((Date.now() - renderStartedAt) / 1000).toFixed(2)}s`;

  const requestedTimeline = JSON.parse(args.timeline) as TimelineData;
  const qualityProjectDir = resolveRenderProjectDir(args.projectDir);
  const projectPath = path.join(qualityProjectDir, 'project.json');
  const qualityProject = JSON.parse(await fs.readFile(projectPath, 'utf-8')) as ProjectData;
  if (!qualityProject.timeline) {
    throw new Error('项目当前没有可导出的时间线');
  }
  const timelineData = await hydrateTimelineCards(qualityProject.timeline, {
    readFile: async (relativePath) => {
      try {
        return await fs.readFile(path.join(qualityProjectDir, relativePath), 'utf-8');
      } catch {
        return null;
      }
    },
  });
  assertRequestedTimelineCurrent(requestedTimeline, timelineData);
  const qualitySnapshotHash = qualityExportSnapshotHash(qualityProject);
  // Encoding quality changes speed/bitrate only. Every deliverable must pass the same production gate.
  const fingerprintAudit = await auditProductionFingerprints(qualityProject, qualityProjectDir);
  const report = evaluateProductionQuality(qualityProject, timelineData, undefined, fingerprintAudit);
  if (qualityProject.production?.execution) {
    qualityProject.production = await mutateProjectProduction(qualityProjectDir, {
      kind: 'set-execution',
      execution: { ...qualityProject.production.execution, qualityReport: report },
      expectedDirectorRevision: qualityProject.production.approvedPlan?.revision,
    }, (current) => assertQualityExportSnapshot(current, qualitySnapshotHash));
  }
  if (!report.exportAllowed) {
    throw new Error(`导出被制作门禁阻止：${report.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.message)
      .join('；')}`);
  }
  const srtEntries =
    args.srtEntries && args.srtEntries.length > 0
      ? args.srtEntries
      : timelineData.podcast.srtPath
        ? parseSrt(await fs.readFile(timelineData.podcast.srtPath, 'utf-8'))
        : [];

  // 字幕「跟随视觉主题」与制作门禁复用同一份项目快照。
  const projectStylePresetId = qualityProject.stylePresetId;

  const cpuCount = os.cpus().length;
  // 帧渲染是 Chromium 截图主导的 CPU 任务；cpu-2 给系统留一点喘息，避免输入卡顿。
  // LINGJI_EXPORT_CONCURRENCY（正整数）供性能对比实验覆盖默认值。
  const explicitConcurrency = resolveExportConcurrency(
    cpuCount,
    process.env.LINGJI_EXPORT_CONCURRENCY,
  );

  // 把 UI 档位（resolution + quality）展开成完整的渲染配置：
  // - x264Preset / videoBitrate / audioBitrate 直接落到 renderMedia；
  // - 三档统一走 videoBitrate + hardwareAcceleration:'if-possible'，能 GPU 编码就 GPU，
  //   不能则自动回退软编（Remotion crf.js:50 校验：videoBitrate 与 crf 互斥）。
  const renderConfig = buildExportRenderConfig({
    timelineWidth: timelineData.width,
    timelineHeight: timelineData.height,
    resolution: args.exportConfig.resolution,
    quality: args.exportConfig.quality,
  });
  // 用 scale 而不是覆盖 composition 尺寸：React 树仍按 timeline.width/height 渲染，
  // 所有 px 字号/padding/位置完全等同预览；renderMedia 拍照时按 scale 像素化输出。
  // 这样字幕字号在 720p / 540p / 480p 上视觉占比与预览一致，不会变大变小。
  const exportScale = Math.max(0.05, Math.min(1, renderConfig.renderWidth / timelineData.width));

  if (isDev) {
    console.log(`${renderLogPrefix} 开始导出`, {
      outputPath: args.outputPath,
      resolution: args.exportConfig.resolution,
      quality: args.exportConfig.quality,
      timelineSize: `${timelineData.width}x${timelineData.height}`,
      exportSize: `${renderConfig.renderWidth}x${renderConfig.renderHeight}`,
      scale: exportScale,
      x264Preset: renderConfig.x264Preset,
      videoBitrate: renderConfig.videoBitrate,
      audioBitrate: renderConfig.audioBitrate,
      jpegQuality: renderConfig.jpegQuality,
      hardwareAcceleration: 'if-possible',
      cpuCount,
      explicitConcurrency,
      platform: process.platform,
      arch: process.arch,
    });
  }

  // ── stage: export.assets ──────────────────────────────────────────
  const assetsStart = Date.now();
  tel.emit('stage.start', {
    stage: 'export.assets',
    resolution: args.exportConfig.resolution,
    quality: args.exportConfig.quality,
    renderWidth: renderConfig.renderWidth,
    renderHeight: renderConfig.renderHeight,
    scale: exportScale,
  });
  const projectPrepStart = assetsStart;
  // materialize 资源到临时 publicDir，并把 timeline 内绝对素材路径改写为 assets/... 相对路径。
  const { timeline: renderTimeline, publicDir } = await createRenderPublicDir(
    timelineData,
    qualityProjectDir,
  );
  // dev / 打包态统一组装出的可写临时 serve 目录，导出后在 finally 清理。
  let tempServeDir: string | undefined;
  let temporaryOutputPath: string | undefined;
  let localServeServer: Awaited<ReturnType<typeof startRemotionLocalServer>> | undefined;
  // 打包态需要把 cwd 切到可写目录，让 Remotion 的浏览器缓存落点不是 `/.remotion`。
  // 在 finally 中恢复，避免影响后续主进程逻辑（譬如其它 IPC 的相对路径解析）。
  const originalCwd = process.cwd();
  const remotionCwd = await prepareRemotionCwd();
  // 防御性 hydrate：若上游传来的是磁盘态（只有 tsxPath 没有内存 tsx），读回源码，保证 collectMotionCards 能拿到卡片。
  const hydratedTimeline = await hydrateTimelineCards(renderTimeline, {
    readFile: async (rel) => {
      try {
        return await fs.readFile(path.join(qualityProjectDir, rel), 'utf-8');
      } catch {
        return null;
      }
    },
  });
  // 把卡片内联的大体积 base64 图片外置成 publicDir 下的真实文件，避免 60MB+ 的
  // inputProps 经 structuredClone 撑爆无头 Chrome（DataCloneError / 进程被 kill）。
  // 收集阶段同步攒 bytes，循环后统一落盘。卡片里替换为 cardAsset('card-assets/...')，
  // 由 CardHost 在导出环境解析为 staticFile。
  const externalizedCardAssets = new Map<string, Buffer>();
  for (const overlay of hydratedTimeline.overlays) {
    const motionCard = overlay.aiCardData?.motionCard;
    if (motionCard?.tsx) {
      const externalized = externalizeMotionCardDataUris(motionCard.tsx, {
        write: (bytes, ext) => {
          const hash = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 16);
          const rel = `card-assets/${hash}.${ext}`;
          if (!externalizedCardAssets.has(rel)) externalizedCardAssets.set(rel, bytes);
          return rel;
        },
      });
      motionCard.tsx = rewriteMotionCardAssetReferences(externalized);
    }
  }
  await Promise.all(
    [...externalizedCardAssets.entries()].map(async ([rel, bytes]) => {
      const target = path.join(publicDir, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    }),
  );
  if (isDev && externalizedCardAssets.size > 0) {
    console.log(
      `${renderLogPrefix} 外置卡片内联图片 ${externalizedCardAssets.size} 个 → ${publicDir}/card-assets`,
    );
  }
  tel.emit('stage.end', {
    stage: 'export.assets',
    durationMs: Date.now() - assetsStart,
    ok: true,
    externalizedCardAssets: externalizedCardAssets.size,
  });

  try {
    // ── stage: export.compile-cards ─────────────────────────────────
    const compileStart = Date.now();
    // 编译 motion 卡片 TSX → CJS，随 inputProps 传入 Remotion，由 CardHost 在无头 Chrome 内求值。
    const cardSources = collectMotionCards(hydratedTimeline);
    tel.emit('stage.start', { stage: 'export.compile-cards', total: cardSources.length });
    const compiledCards = await compileCards(cardSources, {
      onCompileErrors: opts.onMotionCardCompileErrors,
    });
    tel.emit('stage.end', {
      stage: 'export.compile-cards',
      durationMs: Date.now() - compileStart,
      ok: true,
      total: cardSources.length,
      compiled: Object.keys(compiledCards).length,
    });
    if (isDev) {
      console.log(
        `${renderLogPrefix} 资源准备完成 耗时=${(
          (Date.now() - projectPrepStart) / 1000
        ).toFixed(2)}s cards=${cardSources.length} @${timestamp()}`,
      );
    }

    // ── stage: export.bundle ────────────────────────────────────────
    const bundleStart = Date.now();
    tel.emit('stage.start', { stage: 'export.bundle' });
    let serveUrl: string;
    try {
      if (isDev) {
        // 开发态：源码在真实磁盘，运行时 bundle src/remotion（按 entry 缓存，首次导出后复用）。
        const remotionEntry = path.join(app.getAppPath(), 'src', 'remotion', 'index.ts');
        const bundleDir = await getRemotionBundle(remotionEntry);
        tempServeDir = await prepareServeDir(bundleDir, publicDir);
      } else {
        // 打包态：复用构建期预打包产物，避开 app.asar 内运行时 webpack。
        tempServeDir = await prepareServeDir(
          path.join(process.resourcesPath, 'app.asar.unpacked', 'dist-remotion'),
          publicDir,
        );
      }
      localServeServer = await startRemotionLocalServer(tempServeDir);
      serveUrl = localServeServer.serveUrl;
      const probeStartedAt = Date.now();
      try {
        const probe = await localServeServer.probe();
        tel.emit('render.server.probe', {
          ok: probe.status === 200,
          durationMs: Date.now() - probeStartedAt,
          ...probe,
        });
        if (probe.status !== 200) {
          throw new Error(`Remotion local-server probe returned HTTP ${probe.status}`);
        }
      } catch (error) {
        tel.emit('render.server.probe', {
          ok: false,
          durationMs: Date.now() - probeStartedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      tel.emit('stage.end', {
        stage: 'export.bundle',
        durationMs: Date.now() - bundleStart,
        ok: true,
        serveUrl,
      });
    } catch (err) {
      tel.emit('stage.end', {
        stage: 'export.bundle',
        durationMs: Date.now() - bundleStart,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // ── stage: export.render ────────────────────────────────────────
    const renderStart = Date.now();
    onProgress(0.01);
    // 关键：进入 Remotion 渲染前切到可写 cwd，让浏览器缓存解析到
    // `<userData>/remotion-cache/node_modules/.remotion` 而不是根目录下的 `/.remotion`。
    // selectComposition / renderMedia 内部触发 ensureBrowser → getDownloadsCacheDir，
    // 该函数只看 process.cwd() 向上找 package.json，没有任何环境变量可覆盖（核对
    // @remotion/renderer 4.x 源码：get-download-destination.ts）。
    if (remotionCwd) {
      try {
        process.chdir(remotionCwd.cwd);
      } catch (err) {
        if (isDev) {
          console.warn(`${renderLogPrefix} chdir 失败，继续走默认逻辑`, err);
        }
      }
    }
    // 每 15s 采样一次 rendered/encoded 帧数：encoded 持续贴近 rendered 说明编码不是瓶颈，
    // 差距持续拉大说明编码端拖后腿，据此决定调优截帧还是编码。
    const binariesDirectory = resolveRemotionBinariesDirectory();
    const ffmpegPath = remotionBinaryPath(binariesDirectory, 'ffmpeg');
    const ffprobePath = remotionBinaryPath(binariesDirectory, 'ffprobe');
    const browserExecutable = resolveBundledRemotionBrowserExecutable({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      platform: process.platform,
      arch: process.arch,
    });
    let encoderProbe: FfmpegEncoderProbe;
    if (ffmpegPath) {
      try {
        encoderProbe = await probeFfmpegEncoder(ffmpegPath);
      } catch (error) {
        encoderProbe = {
          ffmpegVersion: 'unknown',
          candidate: null,
          advertised: false,
          smokeOk: false,
          encoder: 'libx264',
          remotionHardwareAcceleration: 'disable',
          usesFfmpegOverride: false,
          fallbackReason: error instanceof Error ? error.message : String(error),
        };
      }
    } else {
      encoderProbe = {
        ffmpegVersion: 'unknown',
        candidate: null,
        advertised: false,
        smokeOk: false,
        encoder: 'libx264',
        remotionHardwareAcceleration: 'disable',
        usesFfmpegOverride: false,
        fallbackReason: 'Remotion binaries directory is unavailable',
      };
    }
    tel.emit('export.encoder.probe', { ...encoderProbe });
    const execution = resolveChunkExecutionConfig(
      cpuCount,
      process.env.LINGJI_EXPORT_CHUNK_WORKERS,
      process.env.LINGJI_EXPORT_CONCURRENCY,
    );
    tel.emit('stage.start', {
      stage: 'export.render',
      chunkWorkers: execution.workers,
      concurrency: execution.concurrency,
      totalPages: execution.totalPages,
      encoder: encoderProbe.encoder,
      requestedGl: process.platform === 'win32' ? 'angle' : 'default',
    });
    const resolvedOutputPath = requestedOutputPath;
    await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    temporaryOutputPath = path.join(
      path.dirname(resolvedOutputPath),
      `.${path.basename(resolvedOutputPath)}.lingji-${crypto.randomUUID()}.tmp.mp4`,
    );
    try {
      if (!ffprobePath) throw new Error('Remotion ffprobe binary is unavailable');
      const composition = await selectRemotionComposition({
        serveUrl,
        input: {
          timeline: { ...renderTimeline, overlays: [], subtitleHighlights: [] },
          srtEntries: [],
          compiledCards: {},
          themePresetId: projectStylePresetId,
        },
        binariesDirectory,
        browserExecutable,
        platform: process.platform,
        useAngle: process.platform === 'win32',
      });
      const framesPerChunk = resolveFramesPerChunk(
        composition.fps,
        process.env.LINGJI_EXPORT_CHUNK_SECONDS,
      );
      let renderResult;
      try {
        renderResult = await renderChunkedVideo({
          composition,
          serveUrl,
          outputPath: temporaryOutputPath,
          input: { timeline: renderTimeline, srtEntries, compiledCards, themePresetId: projectStylePresetId },
          framesPerChunk,
          workers: execution.workers,
          concurrency: execution.concurrency,
          scale: exportScale,
          x264Preset: renderConfig.x264Preset,
          quality: args.exportConfig.quality,
          videoBitrate: renderConfig.videoBitrate,
          audioBitrate: renderConfig.audioBitrate,
          jpegQuality: renderConfig.jpegQuality,
          encoder: encoderProbe.encoder,
          ffprobePath,
          binariesDirectory,
          browserExecutable,
          platform: process.platform,
          emit: tel.emit,
          onProgress,
        });
      } catch (chunkError) {
        tel.emit('export.chunk.fallback', {
          reason: chunkError instanceof Error ? chunkError.message : String(chunkError),
          fallback: 'single-render',
        });
        await fs.rm(temporaryOutputPath, { force: true });
        const legacyResult = await renderRemotionVideo({
          serveUrl,
          outputPath: temporaryOutputPath,
          timeline: renderTimeline,
          srtEntries,
          compiledCards,
          themePresetId: projectStylePresetId,
          scale: exportScale,
          jpegQuality: renderConfig.jpegQuality,
          x264Preset: renderConfig.x264Preset,
          videoBitrate: renderConfig.videoBitrate,
          audioBitrate: renderConfig.audioBitrate,
          concurrency: explicitConcurrency,
          hardwareAcceleration: 'disable',
          binariesDirectory,
          browserExecutable,
          onDiagnostic: (event) => tel.emit('render.browser', event),
          onProgress: ({ ratio }) => onProgress(Math.max(0, Math.min(0.99, ratio))),
        });
        renderResult = {
          ...legacyResult,
          chunks: 1,
          renderedChunks: 1,
        };
      }
      const finalProbe = await probeMediaFile(ffprobePath, temporaryOutputPath);
      assertFinalMedia(finalProbe, {
        width: renderConfig.renderWidth,
        height: renderConfig.renderHeight,
        fps: renderResult.fps,
        totalFrames: renderResult.totalFrames,
      });
      const renderDurationMs = Date.now() - renderStart;
      tel.emit('stage.end', {
        stage: 'export.render',
        durationMs: renderDurationMs,
        ok: true,
        totalFrames: renderResult.totalFrames,
        fps: renderResult.fps,
        chunks: renderResult.chunks,
        renderedChunks: renderResult.renderedChunks,
        renderFps:
          Math.round((renderResult.totalFrames / Math.max(1, renderDurationMs)) * 1000 * 10) / 10,
      });
    } catch (err) {
      await fs.rm(temporaryOutputPath, { force: true });
      tel.emit('stage.end', {
        stage: 'export.render',
        durationMs: Date.now() - renderStart,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    if (args.exportConfig.quality === 'quality' && qualityProject.production?.execution) {
      const qualityExecution = qualityProject.production.execution;
      const masteringStart = Date.now();
      tel.emit('stage.start', { stage: 'export.mastering' });
      try {
        await assertQualityExportSnapshotCurrent(qualityProjectDir, qualitySnapshotHash);
      } catch (error) {
        tel.emit('stage.end', {
          stage: 'export.mastering',
          durationMs: Date.now() - masteringStart,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        await fs.rm(temporaryOutputPath, { force: true });
        throw error;
      }
      let measurement: Awaited<ReturnType<typeof masterVideoAudio>>;
      try {
        const ffmpegPath = resolveFfmpegPath({
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath,
          cwd: process.cwd(),
          moduleDir: __dirname,
        });
        if (!ffmpegPath) throw new Error('未找到 ffmpeg，无法执行质量母带');
        const mastering = qualityExecution.audioPlan.mastering;
        measurement = await masterVideoAudio({
          ffmpegPath,
          inputPath: temporaryOutputPath,
          targetLufs: mastering.targetLufs,
          maxTruePeakDbtp: mastering.maxTruePeakDbtp,
          audioBitrate: renderConfig.audioBitrate,
        });
      } catch (error) {
        const fingerprintAudit = await auditProductionFingerprints(qualityProject, qualityProjectDir);
        const report = evaluateProductionQuality(
          qualityProject,
          timelineData,
          undefined,
          fingerprintAudit,
        );
        report.exportAllowed = false;
        report.degraded = true;
        report.issues.push({
          severity: 'error',
          source: 'audio',
          code: 'mastering-failed',
          message: error instanceof Error ? error.message : String(error),
        });
        qualityProject.production = await mutateProjectProduction(qualityProjectDir, {
          kind: 'set-execution',
          execution: { ...qualityExecution, qualityReport: report },
          expectedDirectorRevision: qualityProject.production.approvedPlan?.revision,
        }, (current) => assertQualityExportSnapshot(current, qualitySnapshotHash));
        tel.emit('stage.end', {
          stage: 'export.mastering',
          durationMs: Date.now() - masteringStart,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        await fs.rm(temporaryOutputPath, { force: true });
        throw new Error(`质量导出响度母带失败：${error instanceof Error ? error.message : String(error)}`);
      }

      const fingerprintAudit = await auditProductionFingerprints(qualityProject, qualityProjectDir);
      const report = evaluateProductionQuality(
        qualityProject,
        timelineData,
        measurement,
        fingerprintAudit,
      );
      qualityProject.production = await mutateProjectProduction(qualityProjectDir, {
        kind: 'set-execution',
        execution: { ...qualityExecution, qualityReport: report },
        expectedDirectorRevision: qualityProject.production.approvedPlan?.revision,
      }, (current) => assertQualityExportSnapshot(current, qualitySnapshotHash));
      if (!report.exportAllowed) {
        const error = report.issues
          .filter((issue) => issue.severity === 'error')
          .map((issue) => issue.message)
          .join('；');
        tel.emit('stage.end', {
          stage: 'export.mastering',
          durationMs: Date.now() - masteringStart,
          ok: false,
          error,
        });
        await fs.rm(temporaryOutputPath, { force: true });
        throw new Error(`质量导出被制作门禁阻止：${error}`);
      }
      tel.emit('stage.end', {
        stage: 'export.mastering',
        durationMs: Date.now() - masteringStart,
        ok: true,
        integratedLufs: measurement.integratedLufs,
        truePeakDbtp: measurement.truePeakDbtp,
      });
    }

    await assertQualityExportSnapshotCurrent(qualityProjectDir, qualitySnapshotHash);

    try {
      await atomicallyReplaceOutput(temporaryOutputPath, resolvedOutputPath);
    } catch (error) {
      await fs.rm(temporaryOutputPath, { force: true });
      throw error;
    }
    onProgress(1);

    if (isDev) {
      console.log(
        `${renderLogPrefix} remotion render 完成 总耗时=${((Date.now() - renderStart) / 1000).toFixed(2)}s`,
      );
    }

    return { outputPath: requestedOutputPath };
  } catch (err) {
    if (isDev) {
      console.error(`${renderLogPrefix} 导出失败 @${timestamp()}`, err);
    }
    throw err;
  } finally {
    // 恢复原 cwd，再做磁盘清理（rm 路径都是绝对的，不依赖 cwd）。
    if (remotionCwd) {
      try {
        process.chdir(originalCwd);
      } catch {
        /* ignore */
      }
    }
    await fs.rm(publicDir, { recursive: true, force: true });
    if (localServeServer) {
      tel.emit('render.server.summary', { ...localServeServer.getDiagnostics() });
      try {
        await localServeServer.close();
      } catch {
        /* ignore cleanup failure */
      }
    }
    if (tempServeDir) {
      await fs.rm(tempServeDir, { recursive: true, force: true });
    }
    if (temporaryOutputPath) {
      await fs.rm(temporaryOutputPath, { force: true });
    }
  }
}
