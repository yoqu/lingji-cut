import { ipcMain, app } from 'electron';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { AccountStore } from './accounts';
import { getPlatform } from './platforms';
import { parseAccountId } from './account-id';
import { runPublishJob } from './runner';
import { abortActivePublish } from './cancel';
import { getBiliupStatus, downloadBiliup } from './biliup-install';
import { getChromiumStatus, downloadChromium } from './chromium-install';
import { registerDownloadIpc } from './download-ipc';
import type { PublishJob, PublishPlatform, PublishSettings } from './types';

let store: AccountStore | null = null;
export function getPublishStore(): AccountStore {
  if (!store) store = new AccountStore(join(app.getPath('userData'), 'publish'));
  return store;
}

// ─── Cancel flag (module-level, simple single-job semantics) ──────────────────
let cancelled = false;

export function registerPublishIpc(): void {
  ipcMain.handle('publish:list-accounts', () => getPublishStore().list());
  ipcMain.handle('publish:delete-account', (_e, id: string) => {
    getPublishStore().remove(id);
  });
  ipcMain.handle(
    'publish:login',
    async (e, platform: PublishPlatform, accountName: string, headless?: boolean) => {
      const s = getPublishStore();
      const sp = s.storageStatePath(platform, accountName);
      const res = await getPlatform(platform).login({
        storageStatePath: sp,
        headless: headless ?? s.getSettings().headlessLogin,
        onQrcode: (png) => e.sender.send('publish:qrcode', { platform, accountName, png }),
      });
      if (res.success) s.upsert({ platform, accountName, status: 'valid' });
      return res;
    },
  );
  ipcMain.handle('publish:get-settings', () => getPublishStore().getSettings());
  ipcMain.handle('publish:set-settings', (_e, patch: Partial<PublishSettings>) =>
    getPublishStore().setSettings(patch),
  );
  ipcMain.handle('publish:check', async (_e, id: string) => {
    const s = getPublishStore();
    const { platform } = parseAccountId(id);
    const acc = s.list().find((a) => a.id === id);
    if (!acc) return false;
    const ok = await getPlatform(platform).checkCookie(acc.storageStatePath);
    s.setStatus(id, ok ? 'valid' : 'expired', Date.now());
    return ok;
  });

  // ─── publish:run ────────────────────────────────────────────────────────────
  ipcMain.handle('publish:run', async (e, job: PublishJob, headless = true) => {
    cancelled = false;
    await runPublishJob(
      job,
      getPublishStore(),
      (payload) => e.sender.send('publish:progress', payload),
      () => cancelled,
      headless,
    );
  });

  // ─── publish:cancel ─────────────────────────────────────────────────────────
  // flag 阻止后续账号开始；abortActivePublish 中断 in-flight 上传（关浏览器/杀子进程）
  ipcMain.handle('publish:cancel', async () => {
    cancelled = true;
    await abortActivePublish();
  });

  // ─── 自由发布（无项目）状态：userData/publish/standalone/{state.json,covers/} ──
  // 草稿/主题/历史的 schema 由渲染层拥有，主进程只做透明 JSON 读写（原子写）。
  const standaloneRoot = () => join(app.getPath('userData'), 'publish', 'standalone');
  ipcMain.handle('publish:standalone-load', async () => {
    const root = standaloneRoot();
    const coversDir = join(root, 'covers');
    await mkdir(coversDir, { recursive: true });
    let state: unknown = null;
    try {
      state = JSON.parse(await readFile(join(root, 'state.json'), 'utf-8'));
    } catch {
      state = null;
    }
    return { root, coversDir, state };
  });
  ipcMain.handle('publish:standalone-save', async (_e, state: unknown) => {
    const root = standaloneRoot();
    await mkdir(root, { recursive: true });
    const file = join(root, 'state.json');
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    await rename(tmp, file);
  });

  // ─── 依赖运行时按需下载（统一工厂：status + download + progress + cancel） ──────
  // biliup：B 站上传组件。chromium：抖音/视频号/小红书/快手自动化所需浏览器组件。
  registerDownloadIpc({
    name: 'biliup',
    getStatus: getBiliupStatus,
    download: downloadBiliup,
  });
  registerDownloadIpc({
    name: 'chromium',
    getStatus: getChromiumStatus,
    download: downloadChromium,
  });
}
