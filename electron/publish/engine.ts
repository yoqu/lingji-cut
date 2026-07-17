import type { BrowserContext } from 'playwright';
import { join } from 'node:path';
import { applyStealth } from './stealth';
import { getChromiumStatus } from './chromium-install';
import { registerPublishCancelHandler } from './cancel';

interface ContextOpts {
  storageStatePath?: string;
  headless: boolean;
}

/**
 * 在打包 Electron 环境下，将 PLAYWRIGHT_BROWSERS_PATH 指向 userData/publish/chromium（运行时下载）。
 * - 仅在真实 launch 路径调用（测试注入 playwrightModule 时整个函数不会被调用）。
 * - 开发模式（app.isPackaged === false）不设置，使用开发机已安装的浏览器。
 * - 纯 Node/Vitest 环境：process.resourcesPath 未定义，提前 return，无副作用。
 */
async function ensurePlaywrightBrowsersPath(): Promise<void> {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return; // 非 Electron 环境（Vitest/pure Node），跳过
  try {
    const { app } = await import('electron');
    if (!app.isPackaged) return; // 开发模式，playwright 用系统已安装浏览器
    // Chromium 改为运行时下载到 userData/publish/chromium（见 chromium-install.ts getChromiumRoot）
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(app.getPath('userData'), 'publish', 'chromium');
  } catch {
    // 非 Electron 运行时（理论上不会到这里），忽略
  }
}

// playwrightModule 仅供测试注入；生产用 dynamic import('playwright')
export async function withContext<T>(
  opts: ContextOpts,
  run: (ctx: BrowserContext) => Promise<T>,
  playwrightModule?: any,
): Promise<T> {
  if (!playwrightModule) {
    await ensurePlaywrightBrowsersPath();
    if (!getChromiumStatus().installed) {
      throw new Error('CHROMIUM_NOT_INSTALLED');
    }
  }
  const pw = playwrightModule ?? (await import('playwright'));
  const browser = await pw.chromium.launch({ headless: opts.headless });
  // 用户取消发布时关闭浏览器，让 in-flight 自动化立即报错退出（close 幂等）
  const unregisterCancel = registerPublishCancelHandler(() => browser.close());
  try {
    const context = await browser.newContext(
      opts.storageStatePath ? { storageState: opts.storageStatePath } : {},
    );
    await applyStealth(context);
    try {
      return await run(context);
    } finally {
      await context.close();
    }
  } finally {
    unregisterCancel();
    await browser.close();
  }
}
