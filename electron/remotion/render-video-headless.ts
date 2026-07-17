// 由 electron/main.ts 的 render-video IPC 处理体抽取；无行为变更。
// 唯一改动：三处 `mainWindow?.webContents.send('render-progress', X)` 替换为 `onProgress(X)`。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';
import type { ExportConfig } from '../../src/lib/export-settings';
import { buildExportRenderConfig } from '../../src/lib/export-settings';
import type { SrtEntry, TimelineData } from '../../src/types';
import { parseSrt } from '../../src/lib/srt-parser';
import { compileCards, type CompiledCard } from './compile-card-node';
import { getRemotionBundle } from './bundle';
import { renderRemotionVideo } from './render';
import { collectMotionCards } from '../../src/remotion/collect-cards';
import { hydrateTimelineCards } from '../../src/lib/motion-card-externalize';
import { prepareTimelineForHyperframes, type HyperframesAssetDescriptor } from '../../src/hyperframes/assets';
import {
  collectMotionCardAssets,
  externalizeMotionCardDataUris,
  rewriteMotionCardAssetReferences,
} from './motion-card-assets';
import type { ProjectData } from '../../src/lib/project-persistence';
import { evaluateProductionQuality } from '../../src/lib/production-quality';
import { mutateProjectProduction } from '../project-file';
import { resolveFfmpegPath } from '../runtime-binaries';
import { masterVideoAudio } from '../audio-mastering';

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

/**
 * 从 timeline 反推项目目录：podcast-audio.mp3 / podcast-subtitles.srt 都
 * 位于 projectDir 根，用 audioPath 的 dirname 即得（项目硬约定）。
 * 用于把 ai-card MediaCardContent 的相对路径解析为绝对，再做 public 映射。
 */
function inferProjectDirFromTimeline(timeline: TimelineData): string | null {
  const audio = timeline.podcast?.audioPath;
  if (audio && path.isAbsolute(audio)) return path.dirname(audio);
  const srt = timeline.podcast?.srtPath;
  if (srt && path.isAbsolute(srt)) return path.dirname(srt);
  return null;
}

export async function createRenderPublicDir(
  timeline: TimelineData,
): Promise<{ timeline: TimelineData; publicDir: string }> {
  const projectDir = inferProjectDirFromTimeline(timeline);
  const { timeline: renderTimeline, assets } = prepareTimelineForHyperframes(
    timeline,
    projectDir,
  );
  const motionCardAssets = await collectMotionCardAssets(timeline, projectDir);
  const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingjijianying-public-'));
  await materializeRenderAssets(publicDir, [...assets, ...motionCardAssets]);

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
  if (!app.isPackaged) return undefined;
  const pkg = compositorPackageName();
  if (!pkg) return undefined;
  return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', ...pkg.split('/'));
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

export interface RenderVideoArgs {
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

  const isDev = !app.isPackaged;
  const renderLogPrefix = '[render-video]';
  const renderStartedAt = Date.now();
  const timestamp = () => `${((Date.now() - renderStartedAt) / 1000).toFixed(2)}s`;

  const timelineData = JSON.parse(args.timeline) as TimelineData;
  const qualityProjectDir = inferProjectDirFromTimeline(timelineData);
  let qualityProject: ProjectData | null = null;
  if (args.exportConfig.quality === 'quality' && qualityProjectDir) {
    const projectPath = path.join(qualityProjectDir, 'project.json');
    const project = JSON.parse(await fs.readFile(projectPath, 'utf-8')) as ProjectData;
    qualityProject = project;
    if (project.production) {
      const report = evaluateProductionQuality(project, timelineData);
      const execution = project.production.execution
        ? { ...project.production.execution, qualityReport: report }
        : null;
      project.production = await mutateProjectProduction(qualityProjectDir, {
        kind: 'set-execution',
        execution,
        expectedDirectorRevision: project.production.approvedPlan?.revision,
      });
      if (!report.exportAllowed) {
        throw new Error(`质量导出被制作门禁阻止：${report.issues
          .filter((issue) => issue.severity === 'error')
          .map((issue) => issue.message)
          .join('；')}`);
      }
    }
  }
  const srtEntries =
    args.srtEntries && args.srtEntries.length > 0
      ? args.srtEntries
      : timelineData.podcast.srtPath
        ? parseSrt(await fs.readFile(timelineData.podcast.srtPath, 'utf-8'))
        : [];

  const cpuCount = os.cpus().length;
  // 帧渲染是 Chromium 截图主导的 CPU 任务；cpu-2 给系统留一点喘息，避免输入卡顿。
  // LINGJI_EXPORT_CONCURRENCY（正整数）供性能对比实验覆盖默认值。
  const envConcurrency = Number(process.env.LINGJI_EXPORT_CONCURRENCY);
  const explicitConcurrency =
    Number.isInteger(envConcurrency) && envConcurrency >= 1
      ? envConcurrency
      : Math.max(1, cpuCount - 2);

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
  const { timeline: renderTimeline, publicDir } = await createRenderPublicDir(timelineData);
  // dev / 打包态统一组装出的可写临时 serve 目录，导出后在 finally 清理。
  let tempServeDir: string | undefined;
  // 打包态需要把 cwd 切到可写目录，让 Remotion 的浏览器缓存落点不是 `/.remotion`。
  // 在 finally 中恢复，避免影响后续主进程逻辑（譬如其它 IPC 的相对路径解析）。
  const originalCwd = process.cwd();
  const remotionCwd = await prepareRemotionCwd();
  // 防御性 hydrate：若上游传来的是磁盘态（只有 tsxPath 没有内存 tsx），读回源码，保证 collectMotionCards 能拿到卡片。
  const projectDir = inferProjectDirFromTimeline(timelineData);
  const hydratedTimeline = await hydrateTimelineCards(renderTimeline, {
    readFile: async (rel) => {
      if (!projectDir) return null;
      try {
        return await fs.readFile(path.join(projectDir, rel), 'utf-8');
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
      serveUrl = tempServeDir;
      tel.emit('stage.end', {
        stage: 'export.bundle',
        durationMs: Date.now() - bundleStart,
        ok: true,
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
    tel.emit('stage.start', {
      stage: 'export.render',
      concurrency: explicitConcurrency,
      hardwareAcceleration: 'if-possible',
    });
    onProgress(0.05);
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
    let lastSampleAt = renderStart;
    try {
      const { totalFrames, fps } = await renderRemotionVideo({
        serveUrl,
        outputPath: args.outputPath,
        timeline: renderTimeline,
        srtEntries,
        compiledCards,
        scale: exportScale,
        jpegQuality: renderConfig.jpegQuality,
        x264Preset: renderConfig.x264Preset,
        videoBitrate: renderConfig.videoBitrate,
        audioBitrate: renderConfig.audioBitrate,
        concurrency: explicitConcurrency,
        hardwareAcceleration: 'if-possible',
        binariesDirectory: resolveRemotionBinariesDirectory(),
        onProgress: ({ ratio, renderedFrames, encodedFrames }) => {
          onProgress(Math.max(0.05, Math.min(0.98, ratio)));
          const now = Date.now();
          if (now - lastSampleAt >= 15_000) {
            lastSampleAt = now;
            tel.emit('render.progress', {
              stage: 'export.render',
              elapsedMs: now - renderStart,
              renderedFrames,
              encodedFrames,
            });
          }
        },
      });
      onProgress(1);
      const renderDurationMs = Date.now() - renderStart;
      tel.emit('stage.end', {
        stage: 'export.render',
        durationMs: renderDurationMs,
        ok: true,
        totalFrames,
        fps,
        renderFps: Math.round((totalFrames / Math.max(1, renderDurationMs)) * 1000 * 10) / 10,
      });
    } catch (err) {
      tel.emit('stage.end', {
        stage: 'export.render',
        durationMs: Date.now() - renderStart,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    if (args.exportConfig.quality === 'quality' && qualityProject?.production?.execution && qualityProjectDir) {
      const qualityExecution = qualityProject.production.execution;
      const masteringStart = Date.now();
      tel.emit('stage.start', { stage: 'export.mastering' });
      try {
        const ffmpegPath = resolveFfmpegPath({
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath,
          cwd: process.cwd(),
          moduleDir: __dirname,
        });
        if (!ffmpegPath) throw new Error('未找到 ffmpeg，无法执行质量母带');
        const mastering = qualityExecution.audioPlan.mastering;
        const measurement = await masterVideoAudio({
          ffmpegPath,
          inputPath: args.outputPath,
          targetLufs: mastering.targetLufs,
          maxTruePeakDbtp: mastering.maxTruePeakDbtp,
          audioBitrate: renderConfig.audioBitrate,
        });
        const report = evaluateProductionQuality(qualityProject, timelineData, measurement);
        qualityProject.production = await mutateProjectProduction(qualityProjectDir, {
          kind: 'set-execution',
          execution: { ...qualityExecution, qualityReport: report },
          expectedDirectorRevision: qualityProject.production.approvedPlan?.revision,
        });
        if (!report.exportAllowed) {
          throw new Error(report.issues
            .filter((issue) => issue.severity === 'error')
            .map((issue) => issue.message)
            .join('；'));
        }
        tel.emit('stage.end', {
          stage: 'export.mastering',
          durationMs: Date.now() - masteringStart,
          ok: true,
          integratedLufs: measurement.integratedLufs,
          truePeakDbtp: measurement.truePeakDbtp,
        });
      } catch (error) {
        const report = evaluateProductionQuality(qualityProject, timelineData);
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
        });
        tel.emit('stage.end', {
          stage: 'export.mastering',
          durationMs: Date.now() - masteringStart,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error(`质量导出响度母带失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (isDev) {
      console.log(
        `${renderLogPrefix} remotion render 完成 总耗时=${((Date.now() - renderStart) / 1000).toFixed(2)}s`,
      );
    }

    return { outputPath: args.outputPath };
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
    if (tempServeDir) {
      await fs.rm(tempServeDir, { recursive: true, force: true });
    }
  }
}
