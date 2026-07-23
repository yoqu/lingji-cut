const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { packager } = require('@electron/packager');
const {
  RENDER_RUNTIME_ASAR_UNPACK_DIRS,
  RUNTIME_ROOT_PACKAGES,
  buildReleaseManifest,
  shouldStageProjectPath,
} = require('./package-mac-helpers.cjs');
const { createWindowsInstaller } = require('./package-windows-installer.cjs');
const { stageBundledRemotionBrowser } = require('./remotion-browser-runtime.cjs');

const rootDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

const appName = packageJson.productName || packageJson.name;
const releaseDir = path.join(rootDir, 'release');
const iconPath = path.join(rootDir, 'build', 'icon.ico');
const pngIconPath = path.join(rootDir, 'build', 'icon.png');
const ffmpegVendorCacheDir = path.join(rootDir, '.tmp', 'ffmpeg-vendor');
const stageRootDir = path.join(rootDir, '.tmp', 'package-stage');
const remotionBrowserCacheDir = path.join(rootDir, '.tmp', 'remotion-browser-cache');
const buildOutputs = [
  path.join(rootDir, 'dist', 'index.html'),
  path.join(rootDir, 'dist-electron', 'main.js'),
  path.join(rootDir, 'dist-electron', 'preload.js'),
  // 导出复用的 Remotion 预打包产物（npm run bundle:remotion）。
  path.join(rootDir, 'dist-remotion', 'index.html'),
];

const supportedArch = new Set(['x64', 'ia32']);
const windowsFfmpegPackages = {
  x64: {
    version: '8.0.1',
    url: 'https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-full_build.zip',
    archiveSha256: '467CDE100A47ED4B03A897988AEB4A296890C1E2B2D2864204657D002BC5FB90',
    ffmpegSha256: '74DB6C184A03DBA2BDFE23E1A1F41CF5A8385BC1DE6A7A1B26DB1DC541ABEF93',
    archiveRoot: 'ffmpeg-8.0.1-full_build',
  },
};

function normalizePackageArch(arch) {
  return supportedArch.has(arch) ? arch : null;
}

function resolvePackageArch({
  requestedArch = process.env.ARCH,
  hostArch = process.arch,
  hostPlatform = process.platform,
} = {}) {
  const arch = requestedArch || (hostPlatform === 'win32' ? hostArch : 'x64');
  return normalizePackageArch(arch);
}

function readPngDimensions(pngBuffer) {
  const pngSignature = '89504e470d0a1a0a';
  if (pngBuffer.length < 24 || pngBuffer.subarray(0, 8).toString('hex') !== pngSignature) {
    throw new Error('Windows icon source must be a PNG file');
  }

  return {
    width: pngBuffer.readUInt32BE(16),
    height: pngBuffer.readUInt32BE(20),
  };
}

function toIcoDimensionByte(value) {
  return value >= 256 ? 0 : value;
}

function createIcoFromPng(pngBuffer) {
  const { width, height } = readPngDimensions(pngBuffer);
  const headerSize = 6;
  const directoryEntrySize = 16;
  const imageOffset = headerSize + directoryEntrySize;
  const icoBuffer = Buffer.alloc(imageOffset + pngBuffer.length);

  icoBuffer.writeUInt16LE(0, 0);
  icoBuffer.writeUInt16LE(1, 2);
  icoBuffer.writeUInt16LE(1, 4);
  icoBuffer.writeUInt8(toIcoDimensionByte(width), 6);
  icoBuffer.writeUInt8(toIcoDimensionByte(height), 7);
  icoBuffer.writeUInt8(0, 8);
  icoBuffer.writeUInt8(0, 9);
  icoBuffer.writeUInt16LE(1, 10);
  icoBuffer.writeUInt16LE(32, 12);
  icoBuffer.writeUInt32LE(pngBuffer.length, 14);
  icoBuffer.writeUInt32LE(imageOffset, 18);
  pngBuffer.copy(icoBuffer, imageOffset);

  return icoBuffer;
}

async function ensureWindowsIcon({
  icoPath = iconPath,
  sourcePngPath = pngIconPath,
  existsSync = fs.existsSync,
  readFile = fsp.readFile,
  writeFile = fsp.writeFile,
  mkdir = fsp.mkdir,
} = {}) {
  if (existsSync(icoPath)) {
    return icoPath;
  }

  if (!existsSync(sourcePngPath)) {
    return undefined;
  }

  const pngBuffer = await readFile(sourcePngPath);
  const icoBuffer = createIcoFromPng(pngBuffer);
  await mkdir(path.dirname(icoPath), { recursive: true });
  await writeFile(icoPath, icoBuffer);
  return icoPath;
}

function getPackageDirectory(packageName, workingRoot = rootDir) {
  const parts = packageName.split('/');
  return path.join(workingRoot, 'node_modules', ...parts);
}

async function copyDirectory(sourcePath, targetPath) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.cp(sourcePath, targetPath, { recursive: true });
}

function isWindowsNpm(command, platform = process.platform) {
  return platform === 'win32' && command === 'npm';
}

function resolveSpawnCommand(command, platform = process.platform) {
  // Windows 上 npm 是 npm.cmd，直接 spawn('npm') 会 ENOENT。
  if (isWindowsNpm(command, platform)) {
    return 'npm.cmd';
  }
  return command;
}

function resolveSpawnOptions(command, options = {}, platform = process.platform) {
  // Node 在 win32 下 spawn .cmd / .bat 需要 shell:true，否则 EINVAL（CVE-2024-27980 修复）。
  const base = { cwd: rootDir, stdio: 'inherit' };
  if (isWindowsNpm(command, platform)) {
    base.shell = true;
  }
  return { ...base, ...options };
}

async function runCommand(command, args, options = {}) {
  const { spawn } = require('node:child_process');
  await new Promise((resolve, reject) => {
    const child = spawn(
      resolveSpawnCommand(command),
      args,
      resolveSpawnOptions(command, options),
    );
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function resetDirectory(directoryPath) {
  await fsp.rm(directoryPath, { recursive: true, force: true });
  await fsp.mkdir(directoryPath, { recursive: true });
}

async function collectRuntimePackageClosure() {
  const packageNames = new Set();
  const missingNames = new Set();
  const pendingPackages = [...RUNTIME_ROOT_PACKAGES];

  while (pendingPackages.length > 0) {
    const packageName = pendingPackages.pop();
    if (!packageName || packageNames.has(packageName)) {
      continue;
    }

    const packageDir = getPackageDirectory(packageName);
    const packageJsonFile = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageJsonFile)) {
      // 平台专属 optional 包（如 @rspack/binding-win32-*）在 mac 上从不安装，
      // 记录下来供 stageWindowsPlatformPackages 从 registry 补装。
      missingNames.add(packageName);
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

  return {
    installed: [...packageNames].sort((left, right) => left.localeCompare(right)),
    missing: [...missingNames].sort((left, right) => left.localeCompare(right)),
  };
}

// Windows ffmpeg 已由 stageWindowsFfmpeg 走 vendor/ffmpeg 通道内置，无需重复补装。
const VENDOR_COVERED_PACKAGE_PREFIXES = ['@ffmpeg-installer/'];

function selectWindowsPlatformPackages(missingNames, lockPackages, arch) {
  return missingNames
    .filter((name) => !VENDOR_COVERED_PACKAGE_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .map((name) => ({ name, entry: lockPackages[`node_modules/${name}`] }))
    .filter(
      ({ entry }) =>
        entry &&
        entry.optional === true &&
        Array.isArray(entry.os) &&
        entry.os.includes('win32') &&
        (!Array.isArray(entry.cpu) || entry.cpu.includes(arch)),
    )
    .map(({ name, entry }) => ({ name, version: entry.version }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function stageWindowsPlatformPackages(stageDir, arch, missingNames) {
  const lockfile = JSON.parse(
    await fsp.readFile(path.join(rootDir, 'package-lock.json'), 'utf8'),
  );
  const packages = selectWindowsPlatformPackages(missingNames, lockfile.packages || {}, arch);
  const cacheDir = path.join(rootDir, '.tmp', 'win-platform-packages');
  await fsp.mkdir(cacheDir, { recursive: true });

  for (const { name, version } of packages) {
    const tarballName = `${name.replace(/^@/, '').replace(/\//g, '-')}-${version}.tgz`;
    const tarballPath = path.join(cacheDir, tarballName);

    if (!fs.existsSync(tarballPath)) {
      console.log(`补装 Windows 平台包：${name}@${version}`);
      await runCommand('npm', ['pack', `${name}@${version}`, '--pack-destination', cacheDir]);
      if (!fs.existsSync(tarballPath)) {
        throw new Error(`Windows 平台包下载失败：${tarballPath}`);
      }
    }

    const extractDir = path.join(cacheDir, 'extract', tarballName.replace(/\.tgz$/, ''));
    await fsp.rm(extractDir, { recursive: true, force: true });
    await fsp.mkdir(extractDir, { recursive: true });
    await runCommand('tar', ['-xzf', tarballPath, '-C', extractDir]);

    const extractedPackageDir = path.join(extractDir, 'package');
    if (!fs.existsSync(path.join(extractedPackageDir, 'package.json'))) {
      throw new Error(`Windows 平台包解压异常：${tarballPath}`);
    }

    await copyDirectory(extractedPackageDir, getPackageDirectory(name, stageDir));
    await fsp.rm(extractDir, { recursive: true, force: true });
  }

  return packages;
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

async function ensureWindowsFfmpegVendorLegacy(arch) {
  const packageInfo = windowsFfmpegPackages[arch];
  if (!packageInfo) {
    throw new Error(`Windows ${arch} 暂无可用 FFmpeg vendor 包`);
  }

  const targetPath = path.join(ffmpegVendorCacheDir, 'win32', arch, 'ffmpeg.exe');
  if (fs.existsSync(targetPath)) {
    return targetPath;
  }

  const extractDir = path.join(ffmpegVendorCacheDir, 'extract', `win32-${arch}`);
  await fsp.rm(extractDir, { recursive: true, force: true });
  await fsp.mkdir(extractDir, { recursive: true });

  const tarballPath = path.join(
    ffmpegVendorCacheDir,
    `ffmpeg-installer-${packageInfo.name.split('/').pop()}-${packageInfo.version}.tgz`,
  );
  await fsp.mkdir(path.dirname(tarballPath), { recursive: true });

  console.log(`准备 Windows FFmpeg：${packageInfo.name}@${packageInfo.version}`);
  await runCommand('npm', [
    'pack',
    `${packageInfo.name}@${packageInfo.version}`,
    '--pack-destination',
    ffmpegVendorCacheDir,
  ]);

  if (!fs.existsSync(tarballPath)) {
    throw new Error(`FFmpeg vendor 包下载失败：${tarballPath}`);
  }

  await runCommand('tar', ['-xzf', tarballPath, '-C', extractDir]);

  const extractedFfmpeg = path.join(extractDir, 'package', 'ffmpeg.exe');
  if (!fs.existsSync(extractedFfmpeg)) {
    throw new Error(`FFmpeg vendor 包缺少 ffmpeg.exe：${packageInfo.tarball}`);
  }

  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.copyFile(extractedFfmpeg, targetPath);
  await fsp.chmod(targetPath, 0o755);
  await fsp.rm(extractDir, { recursive: true, force: true });
  return targetPath;
}

async function stageWindowsFfmpegLegacy(stageDir, arch) {
  const sourcePath = await ensureWindowsFfmpegVendorLegacy(arch);
  const targetPath = path.join(stageDir, 'vendor', 'ffmpeg', 'win32', arch, 'ffmpeg.exe');
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.copyFile(sourcePath, targetPath);
}

async function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex').toUpperCase();
}

async function downloadPinnedFile(url, outputPath) {
  const partialPath = `${outputPath}.part`;
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.rm(partialPath, { force: true });
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`FFmpeg download failed: HTTP ${response.status} ${response.statusText}`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partialPath));
  await fsp.rename(partialPath, outputPath);
}

function buildNvencSmokeArgs() {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=256x256:r=30:d=0.54',
    '-frames:v',
    '16',
    '-c:v',
    'h264_nvenc',
    '-preset',
    'p4',
    '-pix_fmt',
    'yuv420p',
    '-f',
    'null',
    '-',
  ];
}

async function ensureWindowsFfmpegVendor(arch) {
  const packageInfo = windowsFfmpegPackages[arch];
  if (!packageInfo) {
    throw new Error(`Windows ${arch} 暂无可用的现代 FFmpeg 离线运行时`);
  }

  const runtimeDir = path.join(ffmpegVendorCacheDir, 'win32', arch);
  const targetPath = path.join(runtimeDir, 'ffmpeg.exe');
  const licensePath = path.join(runtimeDir, 'LICENSE.txt');
  if (fs.existsSync(targetPath) && fs.existsSync(licensePath)) {
    const binaryHash = await fileSha256(targetPath);
    if (binaryHash === packageInfo.ffmpegSha256) {
      return { ffmpegPath: targetPath, licensePath };
    }
    await fsp.rm(targetPath, { force: true });
  }

  const archivePath = path.join(
    ffmpegVendorCacheDir,
    `ffmpeg-${packageInfo.version}-full_build.zip`,
  );
  if (fs.existsSync(archivePath)) {
    const archiveHash = await fileSha256(archivePath);
    if (archiveHash !== packageInfo.archiveSha256) {
      await fsp.rm(archivePath, { force: true });
    }
  }
  if (!fs.existsSync(archivePath)) {
    console.log(`下载固定版 Windows FFmpeg ${packageInfo.version}（首次约 200MB）...`);
    await downloadPinnedFile(packageInfo.url, archivePath);
  }
  const archiveHash = await fileSha256(archivePath);
  if (archiveHash !== packageInfo.archiveSha256) {
    throw new Error(
      `FFmpeg archive SHA-256 mismatch: expected ${packageInfo.archiveSha256}, got ${archiveHash}`,
    );
  }

  const extractDir = path.join(
    ffmpegVendorCacheDir,
    'extract',
    `win32-${arch}-${packageInfo.version}`,
  );
  await fsp.rm(extractDir, { recursive: true, force: true });
  await fsp.mkdir(extractDir, { recursive: true });
  try {
    await runCommand('tar', ['-xf', archivePath, '-C', extractDir]);
    const extractedRoot = path.join(extractDir, packageInfo.archiveRoot);
    const extractedFfmpeg = path.join(extractedRoot, 'bin', 'ffmpeg.exe');
    const extractedLicense = path.join(extractedRoot, 'LICENSE');
    if (!fs.existsSync(extractedFfmpeg) || !fs.existsSync(extractedLicense)) {
      throw new Error(`FFmpeg archive is missing ffmpeg.exe or LICENSE: ${packageInfo.url}`);
    }
    const binaryHash = await fileSha256(extractedFfmpeg);
    if (binaryHash !== packageInfo.ffmpegSha256) {
      throw new Error(
        `FFmpeg binary SHA-256 mismatch: expected ${packageInfo.ffmpegSha256}, got ${binaryHash}`,
      );
    }
    await fsp.mkdir(runtimeDir, { recursive: true });
    await Promise.all([
      fsp.copyFile(extractedFfmpeg, targetPath),
      fsp.copyFile(extractedLicense, licensePath),
    ]);
    await fsp.chmod(targetPath, 0o755);
    return { ffmpegPath: targetPath, licensePath };
  } finally {
    await fsp.rm(extractDir, { recursive: true, force: true });
  }
}

async function stageWindowsFfmpeg(stageDir, arch) {
  const source = await ensureWindowsFfmpegVendor(arch);
  const vendorDir = path.join(stageDir, 'vendor', 'ffmpeg', 'win32', arch);
  const compositorDir = path.join(
    stageDir,
    'node_modules',
    '@remotion',
    'compositor-win32-x64-msvc',
  );
  if (!fs.existsSync(path.join(compositorDir, 'remotion.exe'))) {
    throw new Error(`Remotion compositor runtime is missing before FFmpeg staging: ${compositorDir}`);
  }
  await Promise.all([
    fsp.mkdir(vendorDir, { recursive: true }),
    fsp.mkdir(compositorDir, { recursive: true }),
  ]);
  await Promise.all([
    fsp.copyFile(source.ffmpegPath, path.join(vendorDir, 'ffmpeg.exe')),
    fsp.copyFile(source.licensePath, path.join(vendorDir, 'LICENSE.txt')),
    fsp.copyFile(source.ffmpegPath, path.join(compositorDir, 'ffmpeg.exe')),
    fsp.copyFile(source.licensePath, path.join(compositorDir, 'FFMPEG-LICENSE.txt')),
  ]);

  const stagedFfmpeg = path.join(compositorDir, 'ffmpeg.exe');
  const stagedHash = await fileSha256(stagedFfmpeg);
  if (stagedHash !== windowsFfmpegPackages[arch].ffmpegSha256) {
    throw new Error(`Staged FFmpeg SHA-256 mismatch: ${stagedHash}`);
  }
  if (process.platform === 'win32') {
    try {
      await runCommand(stagedFfmpeg, buildNvencSmokeArgs(), {
        cwd: compositorDir,
        stdio: 'pipe',
      });
      console.log('Windows FFmpeg NVENC 真实 smoke encode：PASS');
    } catch (error) {
      if (process.env.LINGJI_REQUIRE_NVENC_SMOKE === '1') throw error;
      console.warn(
        'Windows FFmpeg 已包含 NVENC，但当前打包机 smoke 失败；运行时会再次真实探测并自动回退 CPU。',
      );
    }
  }
}

async function stageNodeModules(stageDir, arch) {
  const stageNodeModulesDir = path.join(stageDir, 'node_modules');
  await fsp.mkdir(stageNodeModulesDir, { recursive: true });

  const { installed, missing } = await collectRuntimePackageClosure();
  for (const packageName of installed) {
    const sourceDir = getPackageDirectory(packageName);
    if (!fs.existsSync(sourceDir)) {
      continue;
    }

    await copyDirectory(sourceDir, getPackageDirectory(packageName, stageDir));
  }

  const staged = await stageWindowsPlatformPackages(stageDir, arch, missing);
  if (staged.length > 0) {
    console.log(`已补装 ${staged.length} 个 Windows 平台包：${staged.map((p) => p.name).join(', ')}`);
  }
}

async function patchStagedRemotionAacEncoder(stageDir) {
  const audioCodecPath = path.join(
    stageDir,
    'node_modules',
    '@remotion',
    'renderer',
    'dist',
    'options',
    'audio-codec.js',
  );
  const source = await fsp.readFile(audioCodecPath, 'utf8');
  const bundledEncoder = "return 'libfdk_aac';";
  const nativeEncoder = "return 'aac';";
  const matchCount = source.split(bundledEncoder).length - 1;
  if (matchCount !== 1) {
    throw new Error(
      `Expected exactly one Remotion libfdk_aac mapping in ${audioCodecPath}, found ${matchCount}`,
    );
  }
  await fsp.writeFile(audioCodecPath, source.replace(bundledEncoder, nativeEncoder), 'utf8');
  console.log('Remotion AAC encoder mapping patched for bundled Windows FFmpeg: libfdk_aac -> aac');
}

async function writeStageManifest(stageDir) {
  const releaseManifest = buildReleaseManifest(packageJson);
  await fsp.writeFile(
    path.join(stageDir, 'package.json'),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
    'utf8',
  );
}

async function createStageDirectory(stageDir, arch) {
  await resetDirectory(stageDir);
  await writeStageManifest(stageDir);
  await stageProjectFiles(stageDir);
  await stageNodeModules(stageDir, arch);
  await patchStagedRemotionAacEncoder(stageDir);
  await stageWindowsFfmpeg(stageDir, arch);
  await stageBundledRemotionBrowser({
    platform: 'win32',
    arch,
    stageDir,
    cacheRoot: remotionBrowserCacheDir,
  });
}

function buildWindowsPackagerOptions({
  appName: packagerAppName,
  arch,
  iconPath: packagerIconPath,
  releaseDir: packagerReleaseDir,
  stageDir,
  existsSync = fs.existsSync,
}) {
  return {
    appBundleId: process.env.APP_BUNDLE_ID || 'com.local.lingjijianying',
    arch,
    dir: stageDir,
    icon: existsSync(packagerIconPath) ? packagerIconPath : undefined,
    ignore: [/^\/\.DS_Store$/, /\/\.DS_Store$/],
    junk: true,
    name: packagerAppName,
    out: packagerReleaseDir,
    overwrite: true,
    platform: 'win32',
    prune: false,
    asar: {
      unpackDir: RENDER_RUNTIME_ASAR_UNPACK_DIRS,
    },
  };
}

async function packageWindows() {
  const arch = resolvePackageArch();
  if (!arch) {
    console.error(`不支持的 Windows 打包架构：${process.env.ARCH || process.arch}`);
    console.error('请使用 npm run package:win，或设置 ARCH=x64 / ARCH=ia32');
    process.exit(1);
  }

  const missingOutputs = buildOutputs.filter((filePath) => !fs.existsSync(filePath));
  if (missingOutputs.length > 0) {
    console.error('缺少构建产物，无法继续打包。');
    missingOutputs.forEach((filePath) => {
      console.error(`- ${path.relative(rootDir, filePath)}`);
    });
    console.error('请先运行 npm run build，或直接运行 npm run dist:win');
    process.exit(1);
  }

  const stageDir = path.join(stageRootDir, `win32-${arch}`);

  console.log(`开始打包 Windows 应用：${appName} (${arch})`);
  console.log(`准备最小发布目录：${path.relative(rootDir, stageDir)}`);

  const resolvedIconPath = await ensureWindowsIcon();
  await createStageDirectory(stageDir, arch);

  // biliup 二进制不再随包内置：改为运行时按需下载到 <userData>/publish/biliup/，
  // 由设置页「发布账号」首次选中 B 站时引导下载（electron/publish/biliup-install.ts）。

  try {
    const appPaths = await packager(
      buildWindowsPackagerOptions({
        appName,
        arch,
        iconPath: resolvedIconPath || iconPath,
        releaseDir,
        stageDir,
      }),
    );

    console.log('Windows 打包完成，产物如下：');
    appPaths.forEach((appPath) => {
      console.log(`- ${path.relative(rootDir, appPath)}`);
    });

    // 默认在免安装文件夹基础上生成 NSIS 安装包（安装到 Program Files 短路径，
    // 规避用户自行解压到深目录的 MAX_PATH 问题）。SKIP_WIN_INSTALLER=1 可仅出文件夹。
    if (process.env.SKIP_WIN_INSTALLER === '1') {
      console.log('已跳过安装包生成（SKIP_WIN_INSTALLER=1）。');
    } else {
      console.log('开始生成 Windows 安装包（NSIS）...');
      const installerPath = await createWindowsInstaller({
        appName,
        version: packageJson.version,
        arch,
        appDir: appPaths[0],
        iconPath: resolvedIconPath || iconPath,
        releaseDir,
        tmpDir: path.join(rootDir, '.tmp', `win-installer-${arch}`),
      });
      console.log(`安装包生成完成：- ${path.relative(rootDir, installerPath)}`);
    }
  } finally {
    await fsp.rm(stageDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  packageWindows().catch((error) => {
    console.error('Windows 打包失败');
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  buildNvencSmokeArgs,
  buildWindowsPackagerOptions,
  createStageDirectory,
  createIcoFromPng,
  ensureWindowsIcon,
  ensureWindowsFfmpegVendor,
  normalizePackageArch,
  patchStagedRemotionAacEncoder,
  resolvePackageArch,
  resolveSpawnCommand,
  resolveSpawnOptions,
  selectWindowsPlatformPackages,
  windowsFfmpegPackages,
};
