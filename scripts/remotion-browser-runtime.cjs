const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const extractZip = require('extract-zip');

const rendererRoot = path.dirname(require.resolve('@remotion/renderer/package.json'));
const {
  TESTED_VERSION,
  getChromeDownloadUrl,
} = require(path.join(rendererRoot, 'dist', 'browser', 'get-chrome-download-url.js'));

function resolveRemotionBrowserTarget(platform, arch) {
  if (platform === 'win32' && arch === 'x64') {
    return {
      chromePlatform: 'win64',
      folder: 'chrome-headless-shell-win64',
      executable: path.join('chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
    };
  }
  if (platform === 'darwin' && arch === 'x64') {
    return {
      chromePlatform: 'mac-x64',
      folder: 'chrome-headless-shell-mac-x64',
      executable: path.join('chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
    };
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      chromePlatform: 'mac-arm64',
      folder: 'chrome-headless-shell-mac-arm64',
      executable: path.join('chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
    };
  }
  throw new Error(`不支持离线 Remotion 浏览器：${platform}-${arch}`);
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`下载 Remotion 浏览器失败：HTTP ${response.status} ${url}`);
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
}

async function prepareBrowserCache({ target, cacheDir, executablePath }) {
  if (fs.existsSync(executablePath)) return;

  const archivePath = `${cacheDir}.zip`;
  const tempExtractDir = `${cacheDir}.extract-${process.pid}-${Date.now()}`;
  const url = getChromeDownloadUrl({
    platform: target.chromePlatform,
    version: TESTED_VERSION,
    chromeMode: 'headless-shell',
  });

  await fsp.rm(tempExtractDir, { recursive: true, force: true });
  await fsp.mkdir(tempExtractDir, { recursive: true });
  try {
    console.log(`下载离线 Remotion 浏览器 ${TESTED_VERSION} (${target.chromePlatform})`);
    await downloadFile(url, archivePath);
    await extractZip(archivePath, { dir: tempExtractDir });
    const extractedExecutable = path.join(tempExtractDir, target.executable);
    if (!fs.existsSync(extractedExecutable)) {
      throw new Error(`浏览器压缩包缺少可执行文件：${target.executable}`);
    }
    await fsp.rm(cacheDir, { recursive: true, force: true });
    await fsp.rename(tempExtractDir, cacheDir);
  } finally {
    await fsp.rm(archivePath, { force: true });
    await fsp.rm(tempExtractDir, { recursive: true, force: true });
  }
}

async function stageBundledRemotionBrowser({
  platform,
  arch,
  stageDir,
  cacheRoot,
  prepareCache = prepareBrowserCache,
}) {
  const target = resolveRemotionBrowserTarget(platform, arch);
  const cacheDir = path.join(cacheRoot, TESTED_VERSION, target.chromePlatform);
  const cachedExecutable = path.join(cacheDir, target.executable);
  await prepareCache({ target, cacheDir, executablePath: cachedExecutable });
  if (!fs.existsSync(cachedExecutable)) {
    throw new Error(`离线 Remotion 浏览器准备失败：${cachedExecutable}`);
  }

  const sourceFolder = path.join(cacheDir, target.folder);
  const destinationRoot = path.join(stageDir, 'vendor', 'remotion-browser');
  const destinationFolder = path.join(destinationRoot, target.folder);
  await fsp.mkdir(destinationRoot, { recursive: true });
  await fsp.rm(destinationFolder, { recursive: true, force: true });
  await fsp.cp(sourceFolder, destinationFolder, { recursive: true });

  const stagedExecutable = path.join(stageDir, 'vendor', 'remotion-browser', target.executable);
  if (platform === 'darwin') await fsp.chmod(stagedExecutable, 0o755);
  return stagedExecutable;
}

module.exports = {
  TESTED_VERSION,
  resolveRemotionBrowserTarget,
  stageBundledRemotionBrowser,
};
