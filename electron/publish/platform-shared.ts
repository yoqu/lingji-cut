/**
 * Playwright 平台模块（douyin / tencent / xiaohongshu / kuaishou）公共工具。
 * 只承载与平台 DOM 无关的通用逻辑；平台专属选择器与页面流程留在各自模块。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Page } from 'playwright';
import { withContext } from './engine';
import type { UploadVideoOptions } from './types';

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * port of publish_date.strftime("%Y-%m-%d %H:%M[:%S]")
 * 默认输出到分钟（抖音 / 小红书）；withSeconds 输出到秒（快手）。
 */
export function formatScheduleDate(
  date: Date,
  options: { withSeconds?: boolean } = {},
): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const base =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return options.withSeconds ? `${base}:${pad(date.getSeconds())}` : base;
}

/** 登录二维码 PNG 统一落在 storageState 同目录下。 */
export function qrcodePngPath(storageStatePath: string, fileName: string): string {
  return path.join(path.dirname(storageStatePath), fileName);
}

/**
 * data-URL 二维码 → PNG 落盘 → onQrcode 回调。
 * 非 base64 data-URL 时不落盘，返回 false（由调用方决定兜底策略）。
 */
export async function saveQrcodeFromDataUrl(
  src: string,
  pngPath: string,
  onQrcode?: (pngPath: string) => void,
): Promise<boolean> {
  const match = src.match(/^data:image\/[^;]+;base64,(.+)$/s);
  if (!match) return false;
  await fs.mkdir(path.dirname(pngPath), { recursive: true });
  await fs.writeFile(pngPath, Buffer.from(match[1], 'base64'));
  onQrcode?.(pngPath);
  return true;
}

export interface LoginPollConfig {
  /** 每轮先检查是否登录完成；true 则以 successMessage 立即成功返回。 */
  isCompleted: () => Promise<boolean>;
  /** 每轮完成检查后调用：平台自查二维码是否过期并刷新 / 重存二维码。 */
  handleExpired?: () => Promise<void>;
  pollIntervalMs?: number;
  maxChecks?: number;
  successMessage: string;
  timeoutMessage: string;
}

/**
 * 扫码登录轮询循环（port of *_cookie_gen 的 poll_interval=3 / max_checks=100 循环）。
 * 登录成功后的 storageState 持久化由调用方在返回 success 后自行处理。
 */
export async function runLoginPoll(
  config: LoginPollConfig,
): Promise<{ success: boolean; message: string }> {
  const { pollIntervalMs = 3000, maxChecks = 100 } = config;
  for (let i = 0; i < maxChecks; i++) {
    if (await config.isCompleted()) {
      return { success: true, message: config.successMessage };
    }
    if (config.handleExpired) {
      await config.handleExpired();
    }
    await sleep(pollIntervalMs);
  }
  return { success: false, message: config.timeoutMessage };
}

/**
 * uploadVideo 通用包装：withContext → newPage → 页面级上传步骤 → 刷新 storageState。
 * port of: await context.storage_state(path=self.account_file)
 */
export async function runUploadWithContext(
  opts: UploadVideoOptions,
  uploadPage: (page: Page) => Promise<void>,
): Promise<void> {
  await withContext(
    { storageStatePath: opts.storageStatePath, headless: opts.headless },
    async (ctx) => {
      const page = await ctx.newPage();
      await uploadPage(page);
      await ctx.storageState({ path: opts.storageStatePath });
    },
  );
}
