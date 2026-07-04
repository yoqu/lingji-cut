import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

/**
 * Node 环境探测助手：确保打包后的 .app 能在 PATH 上找到用户的 node/npx
 * （nvm/fnm/volta/Homebrew 安装均可），供 preflight 与 lingji CLI 子进程使用。
 */
export class BinaryManager {
  private userNpmPrefix: string;

  constructor() {
    this.userNpmPrefix = path.join(getHomeDir(), '.lingji', 'npm-global');
  }

  /**
   * 在应用启动时调用，确保 nvm/fnm/volta 管理的 node 在 PATH 中。
   * 同时将用户本地 npm prefix 的 bin 目录、常见系统级 node 目录加入 PATH。
   */
  ensureNodeInPath(): void {
    // Homebrew / 系统级 node 兜底：macOS 打包后的 .app 默认 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin
    for (const sysBin of ['/opt/homebrew/bin', '/usr/local/bin']) {
      if (existsSync(sysBin)) {
        this.prependToPathIfMissing(sysBin);
      }
    }

    // 如果 node 已在 PATH 中，跳过 nvm/fnm/volta 检测
    const nodePath = this.whichSync('node');
    if (!nodePath) {
      const binDir = this.findNodeBinDir();
      if (binDir) {
        this.prependToPathIfMissing(binDir);
      }
    }

    // 确保用户本地 npm prefix bin 目录在 PATH 中
    for (const userBinDir of this.getUserPrefixBinDirs()) {
      this.prependToPathIfMissing(userBinDir);
    }
  }

  /** 移除 npm_* 环境变量，避免 npm run dev 时继承的 npm 内部配置干扰子进程 */
  private getCleanEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith('npm_')) {
        env[key] = value;
      }
    }
    return env;
  }

  async findNpxPath(): Promise<string | null> {
    return this.findBinaryPath('npx');
  }

  async findNodePath(): Promise<string | null> {
    return this.findBinaryPath('node');
  }

  async getNodeVersion(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('node', ['--version'], {
        timeout: 10_000,
        env: this.getCleanEnv(),
      });
      return stdout.trim();
    } catch {
      return null;
    }
  }

  async findBinaryPath(name: string): Promise<string | null> {
    return this.whichSync(name);
  }

  // ── 内部方法 ──────────────────────────────────────────────────────────

  private whichSync(name: string): string | null {
    const pathValue = this.getCleanEnv().PATH ?? this.getCleanEnv().Path ?? '';
    const dirs = pathValue.split(path.delimiter).filter(Boolean);
    return this.findExistingExecutable(dirs, name);
  }

  private findExistingExecutable(dirs: string[], name: string): string | null {
    for (const dir of dirs) {
      for (const executableName of getExecutableNames(name)) {
        const candidate = path.join(dir, executableName);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  }

  /** 首选的 node bin 目录：nvm default → nvm 最新 → fnm 最新 → volta */
  private findNodeBinDir(): string | null {
    for (const binDir of this.collectNodeVersionBinDirs()) {
      if (existsSync(path.join(binDir, 'node'))) return binDir;
    }
    return null;
  }

  /**
   * 枚举所有 nvm/fnm/volta 版本 bin 目录。
   * 顺序：nvm default（若存在）→ nvm 其余版本（新→旧）→ fnm（新→旧）→ volta。
   */
  private collectNodeVersionBinDirs(): string[] {
    const dirs: string[] = [];
    const home = getHomeDir();

    // nvm
    const nvmDir = process.env.NVM_DIR ?? path.join(home, '.nvm');
    const nvmVersionsDir = path.join(nvmDir, 'versions', 'node');
    if (existsSync(nvmVersionsDir)) {
      const entries = safeReaddir(nvmVersionsDir).sort().reverse();
      let defaultEntry: string | null = null;

      const defaultAlias = path.join(nvmDir, 'alias', 'default');
      if (existsSync(defaultAlias)) {
        try {
          const alias = readFileSync(defaultAlias, 'utf-8').trim();
          defaultEntry =
            entries.find((entry) => {
              const stripped = entry.replace(/^v/, '');
              return stripped.startsWith(alias) || entry.startsWith(alias);
            }) ?? null;
        } catch {
          // ignore
        }
      }

      if (defaultEntry) {
        dirs.push(path.join(nvmVersionsDir, defaultEntry, 'bin'));
      }
      for (const entry of entries) {
        if (entry === defaultEntry) continue;
        dirs.push(path.join(nvmVersionsDir, entry, 'bin'));
      }
    }

    // nvm-windows
    const nvmWindowsSymlink = process.env.NVM_SYMLINK;
    if (nvmWindowsSymlink && existsSync(nvmWindowsSymlink)) {
      dirs.push(nvmWindowsSymlink);
    }

    const nvmWindowsDir = process.env.NVM_HOME;
    if (nvmWindowsDir && existsSync(nvmWindowsDir)) {
      for (const entry of safeReaddir(nvmWindowsDir).sort().reverse()) {
        dirs.push(path.join(nvmWindowsDir, entry));
      }
    }

    // fnm
    const fnmDir = process.env.FNM_DIR ?? path.join(home, '.local', 'share', 'fnm');
    const fnmVersions = path.join(fnmDir, 'node-versions');
    if (existsSync(fnmVersions)) {
      for (const entry of safeReaddir(fnmVersions).sort().reverse()) {
        dirs.push(path.join(fnmVersions, entry, 'installation', 'bin'));
        dirs.push(path.join(fnmVersions, entry, 'installation'));
      }
    }

    // volta
    const voltaHome = process.env.VOLTA_HOME ?? path.join(home, '.volta');
    const voltaBin = path.join(voltaHome, 'bin');
    if (existsSync(path.join(voltaBin, 'node'))) {
      dirs.push(voltaBin);
    }

    return dirs;
  }

  private prependToPathIfMissing(dir: string): void {
    const current = process.env.PATH ?? '';
    if (current.split(path.delimiter).includes(dir)) return;
    process.env.PATH = current ? `${dir}${path.delimiter}${current}` : dir;
  }

  private getUserPrefixBinDirs(): string[] {
    if (process.platform === 'win32') {
      return [this.userNpmPrefix, path.join(this.userNpmPrefix, 'bin')];
    }

    return [path.join(this.userNpmPrefix, 'bin')];
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function getExecutableNames(name: string): string[] {
  if (process.platform !== 'win32' || path.extname(name)) {
    return [name];
  }

  return [name, `${name}.cmd`, `${name}.exe`, `${name}.bat`];
}
