const fs = require('node:fs');
const path = require('node:path');

// dist-remotion：构建期预打包的 Remotion 静态产物，打包态导出复用（运行时无法在 asar 内 bundle）。
const STAGED_PROJECT_ROOTS = new Set([
  'dist',
  'dist-cli',
  'dist-electron',
  'dist-remotion',
  'resources',
  'src',
]);
// dist-cli 必须 asar-unpack：lingji CLI（注入给 agent 的 LINGJI_CLI）由真实 node 进程
// 直接执行，无法读 asar 内文件，须落在 app.asar.unpacked。
// pi（@earendil-works/*）以进程内 SDK 运行；整棵子树需 asar-unpack——其中含
// 原生 .node（@mariozechner/clipboard-*，嵌套与顶层皆有）与按需读取的包内资源，
// 这些无法从 asar 内 require/读取，须落在 app.asar.unpacked。
// playwright（发布视频 4 平台自动化）同理须 asar-unpack，运行时从 app.asar.unpacked 定位。
// Chromium 已改为运行时按需下载到 <userData>/publish/chromium，不再随包，故清单不含 playwright-browsers。
// node-pty（B 站扫码登录用伪终端）含 .node 预编译产物 + spawn-helper，无法从 asar 内加载/exec，
// 须 asar-unpack。（biliup 二进制已改为运行时下载到 userData，不再随包，故从清单移除。）
// dist-remotion 须 asar-unpack：导出时 fs.cp 整目录到可写临时站点，而 Electron 的 asar
// 透明层不支持递归 copy asar 内目录；落到 app.asar.unpacked 后走真实 fs 即正常。
// @rspack（@remotion/bundler 的打包内核）含原生 .node binding，无法从 asar 内 dlopen。
const RENDER_RUNTIME_ASAR_UNPACK_DIRS = '{dist-cli,dist-remotion,vendor/ffmpeg,vendor/remotion-browser,node_modules/@earendil-works,node_modules/@mariozechner,node_modules/@remotion,node_modules/@rspack,node_modules/esbuild,node_modules/@esbuild,node_modules/@puppeteer,node_modules/puppeteer-core,node_modules/sharp,node_modules/onnxruntime-node,node_modules/ffmpeg-static,node_modules/@ffprobe-installer,node_modules/playwright,node_modules/playwright-core,node_modules/node-pty}';

// 仅在 renderer（Vite bundle）中使用、主进程从不 require 的包可在此排除，
// 以减小 .app 体积。漏排不会导致启动崩溃，只会让 app 变大。
const RENDERER_ONLY_PACKAGES = new Set([
  'lucide-react',
  'react-day-picker',
]);

// 额外强制纳入的包（例如 peer/optional deps 未出现在 dependencies 中但主进程确有 require）。
const EXTRA_RUNTIME_PACKAGES = new Set([]);

const rootPackageJsonPath = path.resolve(__dirname, '..', 'package.json');

function readRootDependencies() {
  try {
    const raw = fs.readFileSync(rootPackageJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Object.keys(parsed.dependencies || {});
  } catch {
    return [];
  }
}

function buildRuntimeRootPackages() {
  const names = new Set(EXTRA_RUNTIME_PACKAGES);
  for (const name of readRootDependencies()) {
    if (!RENDERER_ONLY_PACKAGES.has(name)) {
      names.add(name);
    }
  }
  return names;
}

const RUNTIME_ROOT_PACKAGES = buildRuntimeRootPackages();

function normalizeRelativePath(relativePath) {
  return relativePath.split(path.sep).join('/').replace(/^\/+/, '');
}

function getNodeModuleRootPackage(relativePath) {
  const normalizedPath = normalizeRelativePath(relativePath);
  const parts = normalizedPath.split('/').filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  if (parts[0].startsWith('@') && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }

  return parts[0];
}

// npm 的 os/cpu 字段是平台/架构专属包的权威标记。支持否定语法（如 "!win32"）。
// 未声明（空/缺失）视为通配，保留。
function archListMatches(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  if (list.some((item) => typeof item === 'string' && item.startsWith('!'))) {
    return !list.includes(`!${value}`);
  }
  return list.includes(value);
}

function isForeignArchPackage(packageJson, platform, arch) {
  return (
    !archListMatches(packageJson.os, platform) || !archListMatches(packageJson.cpu, arch)
  );
}

// 递归扫描 stage 内 node_modules，收集「非目标架构」的原生产物路径，供打包前剔除：
//   1. prebuilds/<plat-arch> 子目录：仅保留 <platform>-<arch>，删其余（node-pty、pi-tui）。
//   2. 经 os/cpu 判定与目标不符的平台专属包整目录（@mariozechner/clipboard-* 等）。
// 目标架构包（含 cpu 未声明的 universal）一律保留，故对 arm64 包只删死代码，零功能影响。
function listForeignArchPrunePaths(nodeModulesDir, platform, arch) {
  const targets = [];
  const keepPrebuild = `${platform}-${arch}`;

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);

      if (entry.name === 'prebuilds') {
        let subEntries = [];
        try {
          subEntries = fs.readdirSync(full, { withFileTypes: true });
        } catch {
          subEntries = [];
        }
        for (const sub of subEntries) {
          if (sub.isDirectory() && sub.name !== keepPrebuild) {
            targets.push(path.join(full, sub.name));
          }
        }
        continue;
      }

      const pkgPath = path.join(full, 'package.json');
      if (fs.existsSync(pkgPath)) {
        let pkg = null;
        try {
          pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        } catch {
          pkg = null;
        }
        if (pkg && isForeignArchPackage(pkg, platform, arch)) {
          targets.push(full);
          continue;
        }
      }

      walk(full);
    }
  };

  walk(nodeModulesDir);
  return targets;
}

function buildReleaseManifest(packageJson) {
  return {
    name: packageJson.name,
    productName: packageJson.productName,
    version: packageJson.version,
    main: packageJson.main,
  };
}

function shouldStageProjectPath(relativePath) {
  const normalizedPath = normalizeRelativePath(relativePath);

  if (!normalizedPath) {
    return false;
  }

  const [rootName] = normalizedPath.split('/');
  return STAGED_PROJECT_ROOTS.has(rootName);
}

function shouldStageNodeModulePath(relativePath) {
  const normalizedPath = normalizeRelativePath(relativePath);

  if (!normalizedPath) {
    return false;
  }

  if (
    normalizedPath === '.bin' ||
    normalizedPath.startsWith('.bin/') ||
    normalizedPath === '.cache' ||
    normalizedPath.startsWith('.cache/') ||
    normalizedPath === '.package-lock.json'
  ) {
    return false;
  }

  const packageName = getNodeModuleRootPackage(normalizedPath);
  return packageName ? RUNTIME_ROOT_PACKAGES.has(packageName) : false;
}

module.exports = {
  RENDER_RUNTIME_ASAR_UNPACK_DIRS,
  RUNTIME_ROOT_PACKAGES,
  buildReleaseManifest,
  getNodeModuleRootPackage,
  isForeignArchPackage,
  listForeignArchPrunePaths,
  normalizeRelativePath,
  shouldStageNodeModulePath,
  shouldStageProjectPath,
};
