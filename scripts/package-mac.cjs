const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { packager } = require('@electron/packager');
const {
  RENDER_RUNTIME_ASAR_UNPACK_DIRS,
  RUNTIME_ROOT_PACKAGES,
  buildReleaseManifest,
  listForeignArchPrunePaths,
  shouldStageProjectPath,
} = require('./package-mac-helpers.cjs');
const { stageBundledRemotionBrowser } = require('./remotion-browser-runtime.cjs');

const rootDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

const appName = packageJson.productName || packageJson.name;
const releaseDir = path.join(rootDir, 'release');
const iconPath = path.join(rootDir, 'build', 'icon.icns');
const stageRootDir = path.join(rootDir, '.tmp', 'package-stage');
const remotionBrowserCacheDir = path.join(rootDir, '.tmp', 'remotion-browser-cache');
const buildOutputs = [
  path.join(rootDir, 'dist', 'index.html'),
  path.join(rootDir, 'dist-electron', 'main.js'),
  path.join(rootDir, 'dist-electron', 'preload.js'),
  // 导出复用的 Remotion 预打包产物（npm run bundle:remotion）。
  path.join(rootDir, 'dist-remotion', 'index.html'),
];

const supportedArch = new Set(['arm64', 'x64']);
const arch = process.env.ARCH || process.arch;

function getPackageDirectory(packageName, workingRoot = rootDir) {
  const parts = packageName.split('/');
  return path.join(workingRoot, 'node_modules', ...parts);
}

async function copyDirectory(sourcePath, targetPath) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.cp(sourcePath, targetPath, { recursive: true });
}

async function resetDirectory(directoryPath) {
  await fsp.rm(directoryPath, { recursive: true, force: true });
  await fsp.mkdir(directoryPath, { recursive: true });
}

async function collectRuntimePackageClosure() {
  const packageNames = new Set();
  const pendingPackages = [...RUNTIME_ROOT_PACKAGES];

  while (pendingPackages.length > 0) {
    const packageName = pendingPackages.pop();
    if (!packageName || packageNames.has(packageName)) {
      continue;
    }

    const packageDir = getPackageDirectory(packageName);
    const packageJsonFile = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageJsonFile)) {
      continue;
    }

    packageNames.add(packageName);

    const currentPackageJson = JSON.parse(await fsp.readFile(packageJsonFile, 'utf8'));
    const dependencyNames = new Set([
      ...Object.keys(currentPackageJson.dependencies || {}),
      ...Object.keys(currentPackageJson.optionalDependencies || {}),
    ]);

    for (const peerDependency of Object.keys(currentPackageJson.peerDependencies || {})) {
      if (fs.existsSync(getPackageDirectory(peerDependency))) {
        dependencyNames.add(peerDependency);
      }
    }

    dependencyNames.forEach((dependencyName) => {
      if (!packageNames.has(dependencyName)) {
        pendingPackages.push(dependencyName);
      }
    });
  }

  return [...packageNames].sort((left, right) => left.localeCompare(right));
}

async function stageProjectFiles(stageDir) {
  const entries = await fsp.readdir(rootDir, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => shouldStageProjectPath(entry.name))
      .map((entry) =>
        copyDirectory(path.join(rootDir, entry.name), path.join(stageDir, entry.name)),
      ),
  );
}

async function stageNodeModules(stageDir) {
  const stageNodeModulesDir = path.join(stageDir, 'node_modules');
  await fsp.mkdir(stageNodeModulesDir, { recursive: true });

  const packageNames = await collectRuntimePackageClosure();
  for (const packageName of packageNames) {
    const sourceDir = getPackageDirectory(packageName);
    if (!fs.existsSync(sourceDir)) {
      continue;
    }

    await copyDirectory(sourceDir, getPackageDirectory(packageName, stageDir));
  }
}

async function writeStageManifest(stageDir) {
  const releaseManifest = buildReleaseManifest(packageJson);
  await fsp.writeFile(
    path.join(stageDir, 'package.json'),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
    'utf8',
  );
}

// node-pty 预编译 spawn-helper 经 npm 安装/拷贝后常丢失可执行位（运行时 posix_spawnp failed）。
// 打包后 .app 可能位于只读位置无法运行时 chmod，故在构建期对 stage 内的 spawn-helper 补 +x。
function ensureNodePtySpawnHelperExecutable(stageDir) {
  for (const key of ['darwin-arm64', 'darwin-x64']) {
    const helper = path.join(stageDir, 'node_modules', 'node-pty', 'prebuilds', key, 'spawn-helper');
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
    }
  }
}

// 剔除非目标架构的原生产物（prebuilds/<plat-arch> 与 os/cpu 不符的平台专属包），
// 否则单架构 .app 仍含 x86_64 二进制，macOS 会弹「Intel 组件不兼容」警告。
function pruneForeignArchBinaries(stageDir) {
  const nodeModulesDir = path.join(stageDir, 'node_modules');
  const targets = listForeignArchPrunePaths(nodeModulesDir, 'darwin', arch);
  for (const target of targets) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  if (targets.length > 0) {
    console.log(`已剔除 ${targets.length} 个非 darwin-${arch} 架构原生产物：`);
    targets.forEach((target) => console.log(`- ${path.relative(stageDir, target)}`));
  }
}

async function createStageDirectory(stageDir) {
  await resetDirectory(stageDir);
  await writeStageManifest(stageDir);
  await stageProjectFiles(stageDir);
  await stageNodeModules(stageDir);
  pruneForeignArchBinaries(stageDir);
  ensureNodePtySpawnHelperExecutable(stageDir);
  await stageBundledRemotionBrowser({
    platform: 'darwin',
    arch,
    stageDir,
    cacheRoot: remotionBrowserCacheDir,
  });
}

if (!supportedArch.has(arch)) {
  console.error(`不支持的 macOS 打包架构：${arch}`);
  console.error('请使用 ARCH=arm64 npm run package:mac 或 ARCH=x64 npm run package:mac');
  process.exit(1);
}

const missingOutputs = buildOutputs.filter((filePath) => !fs.existsSync(filePath));

if (missingOutputs.length > 0) {
  console.error('缺少构建产物，无法继续打包。');
  missingOutputs.forEach((filePath) => {
    console.error(`- ${path.relative(rootDir, filePath)}`);
  });
  console.error('请先运行 npm run build，或直接运行 npm run dist:mac');
  process.exit(1);
}

async function main() {
  const stageDir = path.join(stageRootDir, arch);

  console.log(`开始打包 macOS 应用：${appName} (${arch})`);
  console.log(`准备最小发布目录：${path.relative(rootDir, stageDir)}`);

  await createStageDirectory(stageDir);

  // biliup 二进制不再随包内置：改为运行时按需下载到 <userData>/publish/biliup/，
  // 由设置页「发布账号」首次选中 B 站时引导下载（electron/publish/biliup-install.ts）。

  try {
    const appPaths = await packager({
      appBundleId: process.env.APP_BUNDLE_ID || 'com.local.lingjijianying',
      arch,
      dir: stageDir,
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
      ignore: [/^\/\.DS_Store$/, /\/\.DS_Store$/],
      junk: true,
      name: appName,
      out: releaseDir,
      overwrite: true,
      platform: 'darwin',
      prune: false,
      asar: {
        unpackDir: RENDER_RUNTIME_ASAR_UNPACK_DIRS,
      },
    });

    console.log('打包完成，产物如下：');
    appPaths.forEach((appPath) => {
      console.log(`- ${path.relative(rootDir, appPath)}`);
    });
  } finally {
    await fsp.rm(stageDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('macOS 打包失败');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
