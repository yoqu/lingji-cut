import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '@remotion/bundler';

let cachedBundle: { key: string; serveUrl: string } | null = null;

/**
 * 运行时打包 Remotion 合成工程（src/remotion/index.ts），仅用于开发态。
 * 卡片在运行时由 CardHost 通过 inputProps.compiledCards 求值，bundle 结构是静态的，
 * 故仅按 entryPoint 缓存、跨导出复用；每次导出的临时素材不再烘焙进 bundle，
 * 而是由 render-video-headless 在导出时把素材注入临时 serve 目录的 public/。
 * （此前缓存键混入了每次导出新建的临时 publicDir，导致缓存永远 miss、每次导出都重新 webpack。）
 *
 * bundle 时显式传入空 public 目录：不传时 webpack 会把 cwd 下的 public/（renderer 静态资源）
 * 整个复制进产物，既慢又无用。
 *
 * 注意：打包态 entryPoint 落在 app.asar 内，webpack 既无法 chdir 进 asar（ENOTDIR），
 * 也无法穿透 asar 解析模块，故运行时 bundle 仅限开发态；打包态改用构建期预打包产物
 * （dist-remotion，见 scripts/bundle-remotion.cjs 与 render-video-headless 的复用逻辑）。
 */
export async function getRemotionBundle(entryPoint: string): Promise<string> {
  if (cachedBundle && cachedBundle.key === entryPoint) {
    return cachedBundle.serveUrl;
  }
  const emptyPublicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingjijianying-empty-public-'));
  const serveUrl = await bundle({
    entryPoint,
    publicDir: emptyPublicDir,
    webpackOverride: (config) => config,
  });
  cachedBundle = { key: entryPoint, serveUrl };
  return serveUrl;
}
