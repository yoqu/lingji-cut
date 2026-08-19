/**
 * B站平台模块
 *
 * 使用内置 biliup 二进制完成登录（扫码）、Cookie 校验、视频上传。
 * 完全不依赖 Playwright / engine — 仅 biliup-runtime。
 *
 * 参考源：social-auto-upload/sau_cli.py
 *   login_bilibili_account   → login
 *   check_bilibili_account   → checkCookie
 *   upload_bilibili_video    → uploadVideo / buildBiliupUploadArgs
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBiliup } from '../biliup-runtime';
import { loginBiliupViaPty } from '../biliup-login';
import type { LoginOptions, PlatformModule, UploadVideoOptions } from '../types';

// ─── Pure argv builder (unit-tested) ─────────────────────────────────────────

/**
 * biliup 不传 --line 时会探测并常选 bldsa（upos-cs-upcdnbldsa）。
 * 该线路 *.bilivideo.com 证书已于 2026-07-11 过期，macOS 报 errSecCertificateExpired (-67818)。
 * bda2 是国内常用线路，证书有效（至 2027-01-01）。
 */
export const BILIUP_DEFAULT_LINE = 'bda2';
export const BILIUP_FALLBACK_LINES = ['tx', 'bda'] as const;

/**
 * 构建 biliup upload 命令参数，与 sau_cli.py upload_bilibili_video 保持一致。
 *
 * 源码顺序：
 *   -u <account_file> upload <video_file>
 *   --title <title>
 *   --desc <description>
 *   --tid <tid>
 *   --line <line>
 *   [--tag <tag1,tag2>]
 *   [--dtime <unix_seconds>]
 */
export function buildBiliupUploadArgs(
  accountFile: string,
  opts: UploadVideoOptions,
  line: string = BILIUP_DEFAULT_LINE,
): string[] {
  const args: string[] = [
    '-u', accountFile,
    'upload', opts.filePath,
    '--title', opts.title,
    '--desc', opts.desc,
    '--tid', String(opts.tid),
    '--line', line,
  ];

  // 封面：B站主封面为横版，优先 16:9，回退 4:3，再回退单图兜底。
  const cover = opts.covers?.['16:9'] ?? opts.covers?.['4:3'] ?? opts.thumbnail;
  if (cover) {
    args.push('--cover', cover);
  }

  if (opts.tags && opts.tags.length > 0) {
    args.push('--tag', opts.tags.join(','));
  }

  if (opts.scheduleAt) {
    args.push('--dtime', String(Math.floor(opts.scheduleAt / 1000)));
  }

  return args;
}

export function isBiliupUploadLineRetryable(output: string): boolean {
  const text = output.toLowerCase();
  return (
    text.includes('certificate') ||
    text.includes('invalid peer') ||
    text.includes('client error (connect)') ||
    text.includes('error sending request') ||
    text.includes('request failed after')
  );
}

export function formatBiliupUploadError(output: string, triedLines: string[]): string {
  const trimmed = output.trim();
  if (/certificate is expired|invalid peer certificate|errseccertificateexpired|-67818/i.test(trimmed)) {
    return `B站上传线路证书无效（已尝试 ${triedLines.join('/')}）。请稍后重试或检查网络代理。`;
  }
  return trimmed || 'B站上传失败';
}

// ─── Platform module ──────────────────────────────────────────────────────────

export const bilibili: PlatformModule = {
  platform: 'bilibili',

  /**
   * checkCookie — port of check_bilibili_account
   * biliup renew 返回 0 表示 cookie 有效。
   */
  async checkCookie(storageStatePath: string): Promise<boolean> {
    const { code } = await runBiliup(['-u', storageStatePath, 'renew']);
    return code === 0;
  },

  /**
   * login — port of login_bilibili_account
   *
   * biliup 1.x 的 login 是交互式 TUI，无 TTY 直接报 `not a terminal`；
   * 这里通过伪终端(node-pty)驱动菜单选「扫码登录」，biliup 把 qrcode.png 写到
   * 临时目录，轮询出现后经 opts.onQrcode 通知 UI（详见 biliup-login.ts）。
   */
  async login(opts: LoginOptions): Promise<{ success: boolean; message: string }> {
    // 用临时目录让 biliup 把 qrcode.png 写到可控位置
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingji-bili-'));
    try {
      return await loginBiliupViaPty({
        storageStatePath: opts.storageStatePath,
        cwd: tmpDir,
        onQrcode: opts.onQrcode,
      });
    } finally {
      // 异步清理临时目录（不阻塞返回；qrcode 已被扫描，UI 已经处理完毕）
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },

  /**
   * uploadVideo — port of upload_bilibili_video
   * tid 必填；缺失时直接抛错，调用方看到明确提示。
   */
  async uploadVideo(opts: UploadVideoOptions): Promise<void> {
    if (opts.tid == null) {
      throw new Error('B站上传必须指定分区 id (tid)，请在发布面板中填写');
    }
    const lines = [BILIUP_DEFAULT_LINE, ...BILIUP_FALLBACK_LINES];
    const tried: string[] = [];
    let lastOutput = '';
    for (const line of lines) {
      tried.push(line);
      const { code, stdout, stderr } = await runBiliup(
        buildBiliupUploadArgs(opts.storageStatePath, opts, line),
      );
      if (code === 0) return;
      lastOutput = (stderr || stdout || '').trim();
      if (!isBiliupUploadLineRetryable(lastOutput)) break;
    }
    throw new Error(formatBiliupUploadError(lastOutput, tried));
  },
};
