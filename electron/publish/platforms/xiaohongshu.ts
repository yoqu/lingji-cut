/**
 * 小红书平台模块
 * 1:1 港自 social-auto-upload/uploader/xiaohongshu_uploader/main.py
 *   cookie_auth              → checkCookie
 *   xiaohongshu_cookie_gen   → login  (二维码扫码，有头/无头可选)
 *   XiaoHongShuVideo.upload  → uploadVideo / uploadXiaohongshuVideo
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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

// ─── URLs ─────────────────────────────────────────────────────────────────────

const XHS_LOGIN_URL = 'https://creator.xiaohongshu.com/login';
const XHS_PUBLISH_VIDEO_URL =
  'https://creator.xiaohongshu.com/publish/publish?from=homepage&target=video';
const XHS_PUBLISH_SUCCESS_URL_PATTERN = '**/publish/success?**';

// ─── Selectors ────────────────────────────────────────────────────────────────

const XHS_LOGIN_BOX_SELECTOR = "div[class*='login-box']";
const XHS_LOGIN_SWITCH_SELECTOR = 'img.css-wemwzq';

// ─── Upload constants ─────────────────────────────────────────────────────────

const UPLOAD_SUCCESS_KEYWORDS = [
  '上传成功',
  '分辨率',
  '重新上传',
  '编辑封面',
  '已上传',
  '已选择',
  '100%',
] as const;

const XHS_MAX_TAGS = 10; // 小红书标签上限（main.py: max_tags = 10）

// ─── Login helpers ────────────────────────────────────────────────────────────

/**
 * _open_xhs_qrcode_panel
 * 确保登录框显示的是「扫一扫」面板；如果当前显示的是账密面板则先点切换图标。
 */
async function _openXhsQrcodePanel(page: Page): Promise<void> {
  const loginBox = page.locator(XHS_LOGIN_BOX_SELECTOR).first();
  await loginBox.waitFor({ state: 'visible', timeout: 30_000 });

  const scanText = loginBox.locator("div:has-text('扫一扫')").first();
  if (await scanText.count()) return;

  const switchImg = loginBox.locator(XHS_LOGIN_SWITCH_SELECTOR).first();
  await switchImg.waitFor({ state: 'visible', timeout: 10_000 });
  await switchImg.click();
  await loginBox.locator("div:has-text('扫一扫')").first().waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * _find_xhs_qrcode_locator
 * 在「APP扫一扫登录」区域找到二维码图片元素。
 */
async function _findXhsQrcodeLocator(page: Page) {
  await _openXhsQrcodePanel(page);

  // port of: page.locator('.login-box-container').get_by_text("APP扫一扫登录").filter(visible=True).locator("xpath=..//following-sibling::div//img").nth(0)
  const qrcodeImg = page
    .locator('.login-box-container')
    .getByText('APP扫一扫登录')
    .filter({ visible: true })
    .locator('xpath=..//following-sibling::div//img')
    .nth(0);

  if (await qrcodeImg.count()) return qrcodeImg;
  throw new Error('未在扫一扫登录区域找到小红书二维码图片');
}

/**
 * _extract_xhs_qrcode_src
 */
async function _extractXhsQrcodeSrc(page: Page): Promise<string> {
  const qrcodeImg = await _findXhsQrcodeLocator(page);
  await qrcodeImg.waitFor({ state: 'visible', timeout: 30_000 });
  const src = await qrcodeImg.getAttribute('src');
  if (!src) throw new Error('未获取到小红书登录二维码地址');
  return src;
}

/**
 * _save_xhs_qrcode — extract QR src → write PNG → call onQrcode(pngPath)
 */
async function _saveXhsQrcode(
  page: Page,
  storagePath: string,
  onQrcode?: (pngPath: string) => void,
): Promise<void> {
  try {
    const src = await _extractXhsQrcodeSrc(page);
    const pngPath = qrcodePngPath(storagePath, 'xhs_login_qrcode.png');

    if (src.startsWith('data:image/')) {
      await saveQrcodeFromDataUrl(src, pngPath, onQrcode);
    } else {
      // non-data-url: screenshot the locator element
      const qrcodeImg = await _findXhsQrcodeLocator(page);
      await fs.mkdir(path.dirname(pngPath), { recursive: true });
      await qrcodeImg.screenshot({ path: pngPath });
      onQrcode?.(pngPath);
    }
  } catch {
    /* best-effort: failures are non-fatal */
  }
}

/**
 * _is_xhs_login_completed — port of _is_xhs_login_completed
 */
async function _isXhsLoginCompleted(page: Page): Promise<boolean> {
  if (page.url().startsWith(XHS_LOGIN_URL)) return false;

  const loginBox = page.locator(XHS_LOGIN_BOX_SELECTOR).first();
  if (!(await loginBox.count())) return true;

  try {
    return !(await loginBox.isVisible());
  } catch {
    return true;
  }
}

// ─── Upload helpers ───────────────────────────────────────────────────────────

/**
 * _fill_title — port of XiaoHongShuBaseUploader.fill_title
 * 小红书标题限 20 字
 */
async function _fillTitle(page: Page, title: string): Promise<void> {
  const titleContainer = page.locator('input[placeholder*="填写标题"]').first();
  await titleContainer.fill(title.slice(0, 20));
}

/**
 * _fill_desc — port of XiaoHongShuBaseUploader.fill_desc
 */
async function _fillDesc(page: Page, desc: string): Promise<void> {
  if (!desc) return;

  const descLocator = page.locator('p[data-placeholder*="输入正文描述"]').first();
  await descLocator.click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Control+KeyA');
  await page.keyboard.press('Delete');
  await page.keyboard.type(desc);
  await page.keyboard.press('Enter');
}

/**
 * _fill_tags — port of XiaoHongShuBaseUploader.fill_tags
 * 上限 10 个话题；每个话题依赖联想下拉，等不到就退格跳过。
 */
async function _fillTags(page: Page, desc: string, tags: string[]): Promise<void> {
  if (!tags.length) return;

  const cappedTags = tags.slice(0, XHS_MAX_TAGS);

  // 如果没有 desc，需要先点一下正文描述区，确保键盘聚焦在编辑器内
  if (!desc) {
    const descArea = page.locator('p[data-placeholder*="输入正文描述"]').first();
    await descArea.click();
  }

  for (const tag of cappedTags) {
    try {
      await page.keyboard.type('#' + tag, { delay: 30 });
      await page
        .locator('#creator-editor-topic-container')
        .waitFor({ state: 'visible', timeout: 6000 });
      const firstItem = page.locator('#creator-editor-topic-container .item').first();
      await firstItem.waitFor({ state: 'visible', timeout: 4000 });
      await firstItem.click();
    } catch {
      // 话题候选未出现，退格清除已键入文本并继续下一个话题
      const typedText = '#' + tag;
      for (let i = 0; i < typedText.length; i++) {
        await page.keyboard.press('Backspace');
      }
    }
  }
}

/**
 * _fill_meta — sequence: title → desc → tags
 */
async function _fillMeta(
  page: Page,
  title: string,
  desc: string,
  tags: string[],
): Promise<void> {
  await _fillTitle(page, title);
  await _fillDesc(page, desc);
  await _fillTags(page, desc, tags);
}

/**
 * _set_thumbnail — port of XiaoHongShuVideo.set_thumbnail
 */
async function _setXhsThumbnail(page: Page, thumbnailPath: string): Promise<void> {
  if (!thumbnailPath) return;

  const coverPluginTitle = page.locator('div.cover-plugin-title').filter({ hasText: '设置封面' });
  const coverUploadDialog = coverPluginTitle
    .locator("xpath=ancestor::div[contains(@class, 'cover-plugin-preview')]")
    .locator('div.cover > div.default:visible');
  await coverUploadDialog.waitFor({ state: 'visible', timeout: 30_000 });
  await coverUploadDialog.click({ force: true });

  const modal = page.locator('div.d-modal.cover-modal');
  await modal.waitFor({ state: 'visible', timeout: 30_000 });

  const fileInput = modal.locator('input[type="file"][accept*="image"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 10_000 });
  await fileInput.setInputFiles(thumbnailPath);
  await page.waitForTimeout(2000);

  const confirmButton = modal.locator('button.mojito-button').filter({ hasText: '确定' }).first();
  await confirmButton.waitFor({ state: 'visible', timeout: 10_000 });
  await confirmButton.click();

  await modal.waitFor({ state: 'hidden', timeout: 30_000 });
}

/**
 * _check_original_declaration — port of XiaoHongShuBaseUploader.check_original_declaration
 * 可选原创声明，任何路径失败都跳过。
 */
async function _checkOriginalDeclaration(page: Page): Promise<void> {
  try {
    const originalCheckbox = page
      .locator(
        'div.original-declaration checkbox, ' +
          'div.original-declaration input[type="checkbox"], ' +
          'label:has-text("原创") input[type="checkbox"]',
      )
      .first();
    if ((await originalCheckbox.count()) && !(await originalCheckbox.isChecked())) {
      await originalCheckbox.check();
      return;
    }

    const originalText = page
      .locator(
        'div:has-text("原创声明"), span:has-text("原创声明"), ' +
          'div:has-text("原创"), label:has-text("原创")',
      )
      .first();
    if (await originalText.count()) {
      await originalText.click();
    }
  } catch {
    /* 勾选原创声明时出错，跳过 */
  }
}

/**
 * _set_schedule_time_xiaohongshu — port of XiaoHongShuBaseUploader.set_schedule_time_xiaohongshu
 */
async function _setScheduleTimeXiaohongshu(page: Page, publishDate: Date): Promise<void> {
  await page
    .locator('.custom-switch-card')
    .filter({ hasText: '定时发布' })
    .locator('.d-switch')
    .click();
  await sleep(1000);

  const dateStr = formatScheduleDate(publishDate); // "YYYY-MM-DD HH:MM"
  await page.locator('.d-datepicker-input-filter input.d-text').fill(dateStr);
  await sleep(1000);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Page-level upload steps — exported standalone so it can be unit-tested with a mock Page.
 * uploadVideo() wraps this in withContext().
 *
 * Port of XiaoHongShuVideo.upload_video_content() (page interaction portion).
 */
export async function uploadXiaohongshuVideo(
  page: Page,
  opts: UploadVideoOptions,
): Promise<void> {
  // 1. Navigate to video publish page
  await page.goto(XHS_PUBLISH_VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForURL(XHS_PUBLISH_VIDEO_URL, { timeout: 120_000 });

  // 2. Set video file on upload input
  //    port of: page.locator("div[class^='upload-content'] input[class='upload-input']").set_input_files(self.file_path)
  await page
    .locator("div[class^='upload-content'] input[class='upload-input']")
    .setInputFiles(opts.filePath);

  // 3. Wait for upload to complete
  //    port of the while-True loop that checks preview-new text or title input visibility
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const uploadInputLocator = page.locator('input.upload-input').first();
      await uploadInputLocator.waitFor({ state: 'attached', timeout: 3000 });

      const previewNew = uploadInputLocator
        .locator('xpath=following-sibling::div[contains(@class, "preview-new")]')
        .first();

      if (await previewNew.count()) {
        const allText = await previewNew.innerText();
        let uploadSuccess = UPLOAD_SUCCESS_KEYWORDS.some((k) => allText.includes(k));

        if (!uploadSuccess) {
          // port of: stage_elements = await preview_new.query_selector_all('div.stage')
          const stageElements = await previewNew.locator('div.stage').all();
          for (const stage of stageElements) {
            const textContent = await stage.innerText();
            if (textContent.includes('上传成功') || textContent.includes('分辨率')) {
              uploadSuccess = true;
              break;
            }
          }
        }

        if (uploadSuccess) break;
      } else {
        // else: check if title input has appeared (signals upload done / editing state)
        const titleContainer = page.locator('input[placeholder*="填写标题"]').first();
        if ((await titleContainer.count()) > 0 && (await titleContainer.isVisible())) break;
      }
    } catch {
      /* continue polling */
    }
    await sleep(2000);
  }

  // 4. Fill title, desc, tags
  await _fillMeta(page, opts.title, opts.desc || '', opts.tags);

  // 5. Set thumbnail (if provided)
  if (opts.thumbnail) {
    await _setXhsThumbnail(page, opts.thumbnail);
  }

  // 6. Declare original (optional, best-effort)
  await _checkOriginalDeclaration(page);

  // 7. Set schedule time (if provided)
  if (opts.scheduleAt) {
    await _setScheduleTimeXiaohongshu(page, new Date(opts.scheduleAt));
  }

  // 8. Publish loop
  //    port of the while-True that clicks 发布 / 定时发布 and waits for success URL
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (opts.scheduleAt) {
        await page.locator('button:has-text("定时发布")').click();
      } else {
        await page.locator('button:has-text("发布")').click();
      }
      await page.waitForURL(XHS_PUBLISH_SUCCESS_URL_PATTERN, { timeout: 3000 });
      break;
    } catch {
      await sleep(500);
    }
  }
}

export const xiaohongshu: PlatformModule = {
  platform: 'xiaohongshu',

  /**
   * login — port of xiaohongshu_cookie_gen
   * 有头浏览器（默认），全新 context（无 storageState），等待用户扫码
   */
  async login(opts: LoginOptions): Promise<{ success: boolean; message: string }> {
    return withContext({ headless: opts.headless }, async (ctx) => {
      const page = await ctx.newPage();
      try {
        await page.goto(XHS_LOGIN_URL);

        // Show QR code immediately before entering the wait loop
        await _saveXhsQrcode(page, opts.storageStatePath, opts.onQrcode);

        const result = await runLoginPoll({
          isCompleted: () => _isXhsLoginCompleted(page),
          successMessage: '小红书扫码登录成功',
          timeoutMessage: '等待小红书扫码登录超时',
        });

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
   * Python 注释：headless=True（与 xiaohongshu 一致）
   * 先检查文件是否存在，再走 DOM 校验
   */
  async checkCookie(storageStatePath: string): Promise<boolean> {
    // Static pre-flight: file must exist (port of: if not os.path.exists(account_file): return False)
    try {
      await fs.access(storageStatePath);
    } catch {
      return false;
    }

    // DOM check (headless: true — Python cookie_auth uses headless=True)
    return withContext({ storageStatePath, headless: true }, async (ctx) => {
      const page = await ctx.newPage();
      try {
        await page.goto(XHS_PUBLISH_VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        // port of: await page.wait_for_timeout(3000)
        await page.waitForTimeout(3000);

        // port of: if page.url.startswith(XHS_LOGIN_URL): return False
        if (page.url().startsWith(XHS_LOGIN_URL)) return false;

        // port of: login_box visible check
        const loginBox = page.locator(XHS_LOGIN_BOX_SELECTOR).first();
        if (await loginBox.count()) {
          try {
            if (await loginBox.isVisible()) return false;
          } catch {
            return false;
          }
        }

        return true;
      } catch {
        return false;
      }
    });
  },

  /**
   * uploadVideo — port of XiaoHongShuVideo.upload / xiaohongshu_upload_video
   * context 由 engine.withContext 管理；上传完成后刷新 storageState
   */
  async uploadVideo(opts: UploadVideoOptions): Promise<void> {
    await runUploadWithContext(opts, (page) => uploadXiaohongshuVideo(page, opts));
  },
};
