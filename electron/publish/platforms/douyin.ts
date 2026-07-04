/**
 * 抖音平台模块
 * 1:1 港自 social-auto-upload/uploader/douyin_uploader/main.py
 *   cookie_auth       → checkCookie
 *   douyin_cookie_gen → login  (QR 扫码，有头)
 *   DouYinVideo.upload → uploadVideo / uploadDouyinVideo
 */
import type { Page } from 'playwright';
import { withContext } from '../engine';
import {
  formatScheduleDate,
  qrcodePngPath,
  runLoginPoll,
  runUploadWithContext,
  saveQrcodeFromDataUrl,
  sleep,
} from '../platform-shared';
import type { LoginOptions, PlatformModule, UploadVideoOptions } from '../types';

// ─── URLs ────────────────────────────────────────────────────────────────────

const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload';
const HOME_URL = 'https://creator.douyin.com/';
/** version_1 publish page */
const PUBLISH_V1_URL =
  'https://creator.douyin.com/creator-micro/content/publish?enter_from=publish_page';
/** version_2 publish page */
const PUBLISH_V2_URL =
  'https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page';
const MANAGE_URL_GLOB = 'https://creator.douyin.com/creator-micro/content/manage**';

// ─── DouYinBaseUploader helpers ───────────────────────────────────────────────

/**
 * fill_title_and_description
 * 2026-06 DOM: 标题=input[placeholder*=填写作品标题]，描述=div.zone-container[contenteditable]
 */
async function _fillTitleAndDesc(
  page: Page,
  title: string,
  desc: string,
  tags: string[],
): Promise<void> {
  const titleInput = page.locator('input[placeholder*="填写作品标题"]').first();
  await titleInput.waitFor({ state: 'visible', timeout: 120_000 });
  await titleInput.fill(title.slice(0, 30));

  const descEditor = page.locator('div.zone-container[contenteditable="true"]').first();
  await descEditor.waitFor({ state: 'visible', timeout: 120_000 });
  await descEditor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');

  for (const tag of tags) {
    await page.keyboard.type(` #${tag}`);
    await page.keyboard.press('Space');
  }
  // 收起话题下拉，避免浮层拦截后续点击
  await page.keyboard.press('Escape');
}

/**
 * set_schedule_time_douyin
 */
async function _setScheduleTime(page: Page, publishDate: Date): Promise<void> {
  const labelElement = page.locator("[class^='radio']:has-text('定时发布')");
  await labelElement.click();
  await sleep(1000);

  const publishDateHour = formatScheduleDate(publishDate);

  await sleep(1000);
  await page.locator('.semi-input[placeholder="日期和时间"]').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(publishDateHour);
  await page.keyboard.press('Enter');
  await sleep(1000);
}

/**
 * set_self_declaration
 * 抖音「自主声明」为发布必选项，定位不到或异常均跳过不中断发布
 */
async function _setSelfDeclaration(
  page: Page,
  declaration = '内容为个人观点或见解',
): Promise<void> {
  try {
    const entry = page.getByText('请选择自主声明').first();
    await entry.waitFor({ state: 'visible', timeout: 6000 });
    await entry.click();

    const dialog = page
      .locator('.semi-modal-content')
      .filter({ hasText: '对作品内容添加声明' })
      .first();
    await dialog.waitFor({ state: 'visible', timeout: 6000 });

    // Semi 的文字是 .semi-radio-addon（pointer-events:none），要点可交互的 .semi-radio 外层
    const option = dialog.locator('.semi-radio').filter({ hasText: declaration }).first();
    if (await option.count()) {
      await option.click({ timeout: 6000 });
    } else {
      await dialog.getByText(declaration, { exact: true }).first().click({ timeout: 6000, force: true });
    }
    await dialog.getByRole('button', { name: '确定' }).click({ timeout: 6000 });
    await dialog.waitFor({ state: 'hidden', timeout: 6000 });
  } catch {
    // 自主声明设置失败，跳过继续发布
  }
}

/**
 * 在已打开的封面弹窗内，切到指定 tab 并上传一张封面图。
 * tabText: '设置竖封面'（3:4）/ '设置横封面'（16:9）。
 * 单张失败不抛出，避免影响另一比例与后续发布。
 */
async function _setDouyinCoverTab(
  coverLocator: ReturnType<Page['locator']>,
  tabText: string,
  imagePath: string,
): Promise<void> {
  try {
    // 切到目标封面 tab（已激活或 tab 不存在时忽略）
    try {
      await coverLocator.getByText(tabText, { exact: true }).first().click({ timeout: 3000 });
      await sleep(800);
    } catch {
      /* 已在该 tab 或 tab 不存在 */
    }
    // version_2 封面弹窗：input.semi-upload-hidden-input 的 nth(1) 为真正封面上传输入
    // （nth(0) 为 AI 参考图）。切 tab 后该输入会绑定当前 tab 的封面槽。
    const coverUpload = coverLocator.locator('input.semi-upload-hidden-input').nth(1);
    await coverUpload.setInputFiles(imagePath);
    await sleep(3000);
  } catch {
    /* 该比例封面设置失败，跳过 */
  }
}

/**
 * set_thumbnail (DouYinVideo.set_thumbnail)
 * portrait → 竖封面（3:4），landscape → 横封面（4:3）。两者可只传其一。
 * 弹窗内有「设置竖封面」「设置横封面」两个 tab，切到对应 tab 后上传到同一隐藏 input。
 */
async function _setThumbnail(page: Page, portrait?: string, landscape?: string): Promise<void> {
  if (!portrait && !landscape) return;

  // 先清掉 shepherd 新手引导浮层，否则拦截"选择封面"点击
  await page.evaluate(
    "() => document.querySelectorAll('.shepherd-element,.shepherd-modal-overlay-container').forEach(e=>e.remove())",
  );
  await page.getByText('选择封面', { exact: true }).first().click({ force: true });

  const coverLocatorStr = 'div.dy-creator-content-modal';
  const coverLocator = page.locator(coverLocatorStr).first();
  await page.waitForSelector(coverLocatorStr, { timeout: 20_000 });
  await sleep(1500);

  // 先竖封面（主），再横封面；横封面 tab 文案以站点为准，失败不影响竖封面
  if (portrait) await _setDouyinCoverTab(coverLocator, '设置竖封面', portrait);
  if (landscape) await _setDouyinCoverTab(coverLocator, '设置横封面', landscape);

  // 点"完成"应用封面（exact 避免误中"完成编辑"）
  await coverLocator.getByRole('button', { name: '完成', exact: true }).first().click();
  await coverLocator.waitFor({ state: 'detached', timeout: 20_000 });
}

/**
 * handle_upload_error — 重新上传
 */
async function _handleUploadError(page: Page, filePath: string): Promise<void> {
  await page.locator('div.progress-div [class^="upload-btn-input"]').setInputFiles(filePath);
}

/**
 * handle_auto_video_cover — 发布前如必须设置封面则自动选推荐封面
 */
async function _handleAutoVideoCover(page: Page): Promise<boolean> {
  if (await page.getByText('请设置封面后再发布').first().isVisible()) {
    const recommendCover = page.locator('[class^="recommendCover-"]').first();
    if (await recommendCover.count()) {
      try {
        await recommendCover.click();
        await sleep(1000);
        const confirmText = '是否确认应用此封面？';
        if (await page.getByText(confirmText).first().isVisible()) {
          await page.getByRole('button', { name: '确定' }).click();
          await sleep(1000);
        }
        return true;
      } catch {
        /* 推荐封面选择失败 */
      }
    }
  }
  return false;
}

// ─── Login helpers ────────────────────────────────────────────────────────────

/**
 * _is_douyin_login_completed
 * 登录后跳转到 creator-micro 下任意页；登录页是 creator.douyin.com/ 根路径
 */
async function _isLoginCompleted(page: Page): Promise<boolean> {
  if (!page.url().includes('creator.douyin.com/creator-micro')) return false;

  const loginMarkers = [
    page.getByText('扫码登录', { exact: true }).first(),
    page.getByText('手机号登录', { exact: true }).first(),
    page.getByText('二维码失效', { exact: true }).first(),
    page.getByRole('img', { name: '二维码' }).first(),
  ];

  for (const marker of loginMarkers) {
    if (!(await marker.count())) continue;
    try {
      if (await marker.isVisible()) return false;
    } catch {
      continue;
    }
  }
  return true;
}

/**
 * _extract_douyin_qrcode_src — 提取登录页二维码图片 src（data-URL）
 */
async function _extractQrcodeSrc(page: Page): Promise<string> {
  const scanLoginTab = page.getByText('扫码登录', { exact: true }).first();
  await scanLoginTab.waitFor({ timeout: 30_000 });

  let qrcodeImg = scanLoginTab
    .locator('..')
    .locator('xpath=following-sibling::div[1]')
    .locator('img[aria-label="二维码"]')
    .first();

  if (!(await qrcodeImg.count())) {
    qrcodeImg = page.getByRole('img', { name: '二维码' }).first();
  }

  await qrcodeImg.waitFor({ state: 'visible', timeout: 30_000 });
  const src = await qrcodeImg.getAttribute('src');
  if (!src) throw new Error('未获取到抖音登录二维码地址');
  return src;
}

/**
 * _save_douyin_qrcode — 尝试将二维码保存为 PNG 并触发回调；失败不致命
 */
async function _tryExtractAndSaveQrcode(
  page: Page,
  storagePath: string,
  onQrcode: (pngPath: string) => void,
): Promise<void> {
  try {
    const src = await _extractQrcodeSrc(page);
    await saveQrcodeFromDataUrl(src, qrcodePngPath(storagePath, 'douyin_qrcode.png'), onQrcode);
  } catch {
    // 没定位到二维码元素——请直接在弹出的浏览器里扫码，继续等登录跳转
  }
}

/**
 * _wait_for_douyin_login — 轮询登录完成；处理二维码失效并刷新
 */
async function _waitForLogin(
  page: Page,
  storagePath: string,
  onQrcode?: (pngPath: string) => void,
): Promise<{ success: boolean; message: string }> {
  return runLoginPoll({
    isCompleted: () => _isLoginCompleted(page),
    // 二维码失效 → 点击刷新
    handleExpired: async () => {
      const expiredBox = page.getByText('二维码失效', { exact: true }).locator('..').first();
      if ((await expiredBox.count()) && (await expiredBox.isVisible())) {
        await expiredBox.click();
        await sleep(1000);
        if (onQrcode) {
          await _tryExtractAndSaveQrcode(page, storagePath, onQrcode);
        }
      }
    },
    successMessage: '抖音扫码登录成功',
    timeoutMessage: '等待抖音扫码登录超时',
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Page-level upload steps — exported standalone so it can be tested with a mock Page.
 * uploadVideo() wraps this in withContext().
 *
 * Port of DouYinVideo.upload() (page interaction portion).
 */
export async function uploadDouyinVideo(page: Page, opts: UploadVideoOptions): Promise<void> {
  await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForURL(UPLOAD_URL, { timeout: 90_000 });

  // wait_for_url 完成时上传页可能尚未渲染出文件 input（实测偶发），先等它挂载再 set_input_files
  await page.waitForSelector("div[class^='container'] input", { state: 'attached', timeout: 60_000 });
  await page.locator("div[class^='container'] input").setInputFiles(opts.filePath);

  // 等待进入 version_1 或 version_2 发布页面
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await page.waitForURL(PUBLISH_V1_URL, { timeout: 3000 });
      break;
    } catch {
      try {
        await page.waitForURL(PUBLISH_V2_URL, { timeout: 3000 });
        break;
      } catch {
        await sleep(500);
      }
    }
  }

  await sleep(1000);
  await _fillTitleAndDesc(page, opts.title, opts.desc || opts.title, opts.tags);

  // 等待上传完成（出现"重新上传"表示视频已上传完毕）
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const n = await page.locator('[class^="long-card"] div:has-text("重新上传")').count();
      if (n > 0) break;
      await sleep(2000);
      if (await page.locator('div.progress-div > div:has-text("上传失败")').count()) {
        await _handleUploadError(page, opts.filePath);
      }
    } catch {
      await sleep(2000);
    }
  }

  // 封面：3:4 竖封面 + 4:3 横封面（实测抖音封面弹窗「设置横封面」为 4:3，非 16:9）。
  // 缺哪个跳过；旧单图走 thumbnail 兜底竖封面。
  const portraitCover = opts.covers?.['3:4'] ?? opts.thumbnail;
  const landscapeCover = opts.covers?.['4:3'];
  if (portraitCover || landscapeCover) {
    await _setThumbnail(page, portraitCover, landscapeCover);
  }

  // 自主声明（抖音必填项，失败自动跳过）
  await _setSelfDeclaration(page);

  // 第三方版权声明开关
  const thirdPartElement = '[class^="info"] > [class^="first-part"] div div.semi-switch';
  if (await page.locator(thirdPartElement).count()) {
    const cls = await page.locator(thirdPartElement).evaluate((el: Element) => el.className);
    if (!cls.includes('semi-switch-checked')) {
      await page.locator(thirdPartElement).locator('input.semi-switch-native-control').click();
    }
  }

  // 定时发布
  if (opts.scheduleAt) {
    await _setScheduleTime(page, new Date(opts.scheduleAt));
  }

  // 发布循环：移除浮层 → 点击发布按钮 → 等待跳转 manage 页
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await page.evaluate(
        '() => { document.querySelectorAll(\'.shepherd-element, .shepherd-modal-overlay-container, [class*="mention-wrapper"]\').forEach(e => e.remove()); }',
      );
      const publishButton = page.getByRole('button', { name: '发布', exact: true });
      if (await publishButton.count()) {
        await publishButton.click({ force: true });
      }
      await page.waitForURL(MANAGE_URL_GLOB, { timeout: 3000 });
      break;
    } catch {
      await _handleAutoVideoCover(page);
      await sleep(500);
    }
  }
}

export const douyin: PlatformModule = {
  platform: 'douyin',

  /**
   * login — port of douyin_cookie_gen
   * 有头浏览器，全新 context（无 storageState），等待用户扫码
   */
  async login(opts: LoginOptions): Promise<{ success: boolean; message: string }> {
    return withContext({ headless: opts.headless }, async (ctx) => {
      const page = await ctx.newPage();
      try {
        await page.goto(HOME_URL);

        if (opts.onQrcode) {
          await _tryExtractAndSaveQrcode(page, opts.storageStatePath, opts.onQrcode);
        }

        const result = await _waitForLogin(page, opts.storageStatePath, opts.onQrcode);

        if (result.success) {
          await sleep(2000);
          await ctx.storageState({ path: opts.storageStatePath });
        }

        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, message };
      }
    });
  },

  /**
   * checkCookie — port of cookie_auth
   * 注：Python 注释：抖音无头会撞反爬墙，校验必须有头（headless: false）
   */
  async checkCookie(storageStatePath: string): Promise<boolean> {
    return withContext({ storageStatePath, headless: false }, async (ctx) => {
      const page = await ctx.newPage();
      await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      try {
        await page.waitForURL(UPLOAD_URL, { timeout: 5000 });
      } catch {
        return false;
      }

      if (
        (await page.getByText('手机号登录').count()) ||
        (await page.getByText('扫码登录').count())
      ) {
        return false;
      }

      return true;
    });
  },

  /**
   * uploadVideo — port of DouYinVideo.upload / douyin_upload_video
   * context 由 engine.withContext 管理；上传完成后刷新 storageState
   */
  async uploadVideo(opts: UploadVideoOptions): Promise<void> {
    await runUploadWithContext(opts, (page) => uploadDouyinVideo(page, opts));
  },
};
