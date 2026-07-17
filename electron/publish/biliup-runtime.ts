/**
 * biliup 运行时：定位内置二进制 + spawn 执行。
 *
 * 平台 key 格式与 Python 参考实现保持一致：
 *   darwin/arm64  → macos-aarch64
 *   darwin/x64    → macos-x86_64
 *   win32/x64     → windows-x86_64
 *   linux/x64     → linux-x86_64
 *   linux/arm64   → linux-aarch64
 *
 * 注意：接受 Node.js process.platform / process.arch 的标识符，
 * 输出与 Python _build_platform_key() 一致的资产键。
 */

import { join } from 'path';
import { spawn } from 'child_process';
import { registerPublishCancelHandler } from './cancel';

// ---------------------------------------------------------------------------
// 内部归一化辅助
// ---------------------------------------------------------------------------

function normalizeSystem(platform: string): string {
  const p = platform.trim().toLowerCase();
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  // 'linux', 'windows'（来自 Python 端 direct pass-through）等保持原值
  return p;
}

function normalizeMachine(arch: string): string {
  const a = arch.trim().toLowerCase();
  const aliases: Record<string, string> = {
    amd64: 'x86_64',
    x64: 'x86_64',
    arm64: 'aarch64',
  };
  return aliases[a] ?? a;
}

// ---------------------------------------------------------------------------
// 公开纯函数（import-safe，不触碰 fs / spawn）
// ---------------------------------------------------------------------------

/**
 * 构建 biliup 平台资产键，例如 `macos-aarch64`。
 * @param platform Node.js process.platform 值（默认取运行时值）
 * @param arch     Node.js process.arch 值（默认取运行时值）
 */
export function buildPlatformKey(platform?: string, arch?: string): string {
  const p = platform ?? process.platform;
  const a = arch ?? process.arch;
  return `${normalizeSystem(p)}-${normalizeMachine(a)}`;
}

/**
 * 返回 biliup 可执行文件名。Windows 为 `biliup.exe`，其余为 `biliup`。
 * @param platform Node.js process.platform 值（默认取运行时值）
 */
export function biliupBinaryName(platform?: string): string {
  const p = platform ?? process.platform;
  return normalizeSystem(p) === 'windows' ? 'biliup.exe' : 'biliup';
}

// ---------------------------------------------------------------------------
// 路径解析（resourcesRoot 可注入，方便测试）
// ---------------------------------------------------------------------------

// 运行时注入的安装根目录。biliup 改为按需下载到用户可写目录后，
// main.ts 启动时通过 configureBiliupRoot() 注入 `<userData>/publish`，
// 三端（dev / 正式包）统一从该目录解析二进制。未注入时回退旧逻辑。
let installRootOverride: string | null = null;

/**
 * 注入 biliup 安装根目录（destRoot）。由主进程在 app ready 后调用一次。
 * 注入后 resolveBiliupPath() 默认从此目录解析；传入空值可清除（便于测试）。
 */
export function configureBiliupRoot(root: string | null): void {
  installRootOverride = root && root.trim() ? root : null;
}

function defaultResourcesRoot(): string {
  // 运行时按需下载方案：优先用注入的用户安装目录。
  if (installRootOverride) {
    return installRootOverride;
  }
  // 兼容旧路径：Electron 生产环境 process.resourcesPath 由 Electron 注入，
  // biliup 曾随包经 asar.unpackDir 解包到 app.asar.unpacked/biliup/。
  const rp = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (typeof rp === 'string' && rp) {
    return join(rp, 'app.asar.unpacked');
  }
  // 开发 / 测试回退：__dirname 指向 dist-electron/publish/，向上两级到项目根
  return join(__dirname, '..', '..', 'resources');
}

/**
 * 解析打包内置的 biliup 二进制路径。
 * 路径格式：`<resourcesRoot>/biliup/<platform-key>/<binary-name>`
 *
 * 不会在模块加载时抛出，也不要求二进制文件存在。
 * @param resourcesRoot 可选覆盖根目录，方便测试注入
 */
export function resolveBiliupPath(resourcesRoot?: string): string {
  const root = resourcesRoot ?? defaultResourcesRoot();
  return join(root, 'biliup', buildPlatformKey(), biliupBinaryName());
}

// ---------------------------------------------------------------------------
// spawn 封装
// ---------------------------------------------------------------------------

export interface RunBiliupResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 执行 biliup 命令。
 *
 * - `interactive: true`：继承 stdio（登录流程），resolve 时 stdout/stderr 为空字符串。
 * - `interactive: false`（默认）：捕获 stdout/stderr，以 UTF-8 解码后返回。
 * - `cwd`：可选工作目录；biliup login 会把 qrcode.png 写到 cwd，借此控制落盘位置。
 *
 * 始终 resolve（永不 reject），调用方通过 `code` 分支处理错误。
 */
export function runBiliup(
  args: string[],
  opts?: { interactive?: boolean; resourcesRoot?: string; cwd?: string },
): Promise<RunBiliupResult> {
  return new Promise((resolve) => {
    const binaryPath = resolveBiliupPath(opts?.resourcesRoot);

    if (opts?.interactive) {
      const child = spawn(binaryPath, args, { stdio: 'inherit', cwd: opts?.cwd });
      child.on('error', (err) => {
        resolve({ code: 1, stdout: '', stderr: err.message });
      });
      child.on('close', (code) => {
        resolve({ code: code ?? 1, stdout: '', stderr: '' });
      });
    } else {
      const child = spawn(binaryPath, args, { cwd: opts?.cwd });
      // 用户取消发布时杀掉上传子进程（B 站走 biliup，不经 Playwright）
      const unregisterCancel = registerPublishCancelHandler(() => {
        child.kill();
      });
      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      child.on('error', (err) => {
        // binary not found or spawn failed — still resolve
        unregisterCancel();
        resolve({ code: 1, stdout, stderr: stderr + err.message });
      });
      child.on('close', (code) => {
        unregisterCancel();
        resolve({ code: code ?? 1, stdout, stderr });
      });
    }
  });
}
