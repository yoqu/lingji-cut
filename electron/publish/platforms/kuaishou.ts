/**
 * 快手平台模块
 * 1:1 港自 social-auto-upload/uploader/ks_uploader/main.py
 *   cookie_auth      → checkCookie
 *   get_ks_cookie    → login  (快手 APP 扫码，有头)
 *   KSVideo.upload   → uploadVideo / uploadKuaishouVideo
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

// ─── URLs ─────────────────────────────────────────────────────────────────────

const KUAISHOU_UPLOAD_URL = 'https://cp.kuaishou.com/article/publish/video';
const KUAISHOU_LOGIN_URL =
  'https://passport.kuaishou.com/pc/account/login/?sid=kuaishou.web.cp.api&callback=https%3A%2F%2Fcp.kuaishou.com%2Frest%2Finfra%2Fsts%3FfollowUrl%3Dhttps%253A%252F%252Fcp.kuaishou.com%252Farticle%252Fpublish%252Fvideo%26setRootDomain%3Dtrue';

// Glob patterns for page.waitForURL (port of KUAISHOU_UPLOAD_URL_PATTERN / KUAISHOU_MANAGE_URL_PATTERN)
const KUAISHOU_UPLOAD_URL_PATTERN = '**/article/publish/video**';
const KUAISHOU_MANAGE_URL_PATTERN = '**/article/manage/video?status=2&from=publish**';

// ─── Cookie-invalidity selector ───────────────────────────────────────────────
// port of KUAISHOU_COOKIE_INVALID_SELECTOR = "div.names div.container div.name:text('机构服务')"
// 保持 :text() 精确匹配（Node Playwright 支持）；:has-text() 子串匹配会误报 cookie 失效

const KUAISHOU_COOKIE_INVALID_SELECTOR =
  "div.names div.container div.name:text('机构服务')";

// ─── Cookie-validity helpers ──────────────────────────────────────────────────

/**
 * _is_ks_cookie_invalid
 * port of _is_ks_cookie_invalid(page, timeout=5000)
 * waitForSelector resolves → selector visible → cookie invalid (True)
 * waitForSelector throws (timeout) → selector absent → cookie valid (False)
 */
async function _isKsCookieInvalid(page: Page, timeout = 5000): Promise<boolean> {
  try {
    await page.waitForSelector(KUAISHOU_COOKIE_INVALID_SELECTOR, { timeout });
    return true;
  } catch {
    return false;
  }
}

// ─── QR-code helpers (login) ──────────────────────────────────────────────────

/**
 * _extract_ks_qrcode_src
 * port of _extract_ks_qrcode_src(page)
 * Waits for main#login-form; if qrcode img is absent/invisible, clicks platform-switch first.
 */
async function _extractKsQrcodeSrc(page: Page): Promise<string> {
  const loginForm = page.locator('main#login-form').first();
  await loginForm.waitFor({ state: 'visible', timeout: 30_000 });

  const qrcodeImg = loginForm.locator('div.qr-login img[alt="qrcode"]').first();
  let needSwitch: boolean;
  try {
    needSwitch = !(await qrcodeImg.count()) || !(await qrcodeImg.isVisible());
  } catch {
    needSwitch = true;
  }
  if (needSwitch) {
    const platformSwitch = loginForm.locator('div.platform-switch').first();
    await platformSwitch.waitFor({ state: 'visible', timeout: 10_000 });
    await platformSwitch.click();
    await sleep(1000);
  }

  await qrcodeImg.waitFor({ state: 'visible', timeout: 15_000 });
  const qrcodeSrc = await qrcodeImg.getAttribute('src');
  if (!qrcodeSrc) throw new Error('未获取到快手登录二维码地址');
  return qrcodeSrc;
}

/**
 * _is_ks_qrcode_expired
 * port of _is_ks_qrcode_expired(page)
 */
async function _isKsQrcodeExpired(page: Page): Promise<boolean> {
  const expiredBox = page.locator('div.qrcode-status.qrcode-status-timeout').first();
  try {
    if (!(await expiredBox.count())) return false;
    return await expiredBox.isVisible();
  } catch {
    return false;
  }
}

/**
 * _is_ks_login_page_gone
 * port of _is_ks_login_page_gone(page)
 * Returns true if main#login-form is absent or invisible (login completed / redirected).
 */
async function _isKsLoginPageGone(page: Page): Promise<boolean> {
  try {
    const loginForm = page.locator('main#login-form').first();
    if (!(await loginForm.count())) return true;
    return !(await loginForm.isVisible());
  } catch {
    return true;
  }
}

/**
 * Simplified port of _save_ks_qrcode.
 * Extracts QR src, saves as PNG, calls onQrcode(pngPath).
 */
async function _saveKsQrcode(
  page: Page,
  storagePath: string,
  onQrcode?: (pngPath: string) => void,
): Promise<void> {
  try {
    const src = await _extractKsQrcodeSrc(page);
    await saveQrcodeFromDataUrl(src, qrcodePngPath(storagePath, 'ks_login_qrcode.png'), onQrcode);
  } catch {
    /* silent: best-effort */
  }
}

// ─── Upload helpers ───────────────────────────────────────────────────────────

/**
 * close_guide_overlay
 * port of KSBaseUploader.close_guide_overlay
 * Closes the Joyride tutorial overlay if present.
 */
async function _closeGuideOverlay(page: Page): Promise<void> {
  const joyrideTooltip = page.locator('div[id^="react-joyride-step"] div[role="alertdialog"]');
  try {
    if ((await joyrideTooltip.count()) > 0 && (await joyrideTooltip.first().isVisible())) {
      const closeButton = page
        .locator('div[role="alertdialog"]')
        .locator('[aria-label="Skip"], [data-action="skip"], button[title="Skip"]');
      await closeButton.click({ force: true });
      await joyrideTooltip.waitFor({ state: 'hidden', timeout: 5000 });
    }
  } catch {
    /* guide overlay absent or already dismissed */
  }
}

/**
 * handle_upload_error
 * port of KSVideo.handle_upload_error
 */
async function _handleUploadError(page: Page, filePath: string): Promise<void> {
  await page.locator('div.progress-div [class^="upload-btn-input"]').setInputFiles(filePath);
}

/**
 * set_thumbnail
 * port of KSVideo.set_thumbnail
 */
async function _setKsThumbnail(page: Page, thumbnailPath: string): Promise<void> {
  const coverLabel = page.locator('span').filter({ hasText: '封面设置' });
  await coverLabel.waitFor({ state: 'visible', timeout: 30_000 });
  await coverLabel.locator('xpath=../following-sibling::div[1]').locator('div').nth(0).click();

  const modal = page.locator('div[role="document"].ant-modal');
  await modal.waitFor({ state: 'visible', timeout: 30_000 });

  const uploadCoverTab = modal.getByText('上传封面', { exact: true });
  await uploadCoverTab.waitFor({ state: 'visible', timeout: 10_000 });
  await uploadCoverTab.click();

  const fileInput = modal.locator('input[type="file"]');
  await fileInput.waitFor({ state: 'attached', timeout: 30_000 });
  await fileInput.setInputFiles(thumbnailPath);
  await sleep(1000);

  const confirmButton = modal.getByRole('button', { name: '确认', exact: true });
  await confirmButton.waitFor({ state: 'visible', timeout: 10_000 });
  await confirmButton.click();

  await modal.waitFor({ state: 'hidden', timeout: 30_000 });
}

/**
 * set_schedule_time
 * port of KSBaseUploader.set_schedule_time
 * Uses Ant Design DatePicker React native-setter trick to set the scheduled publish time.
 */
async function _setKsScheduleTime(page: Page, publishDate: Date): Promise<void> {
  const publishDateStr = formatScheduleDate(publishDate, { withSeconds: true });

  // 1. Switch to "定时发布" radio (text match is more stable than position)
  await page.locator('label.ant-radio-wrapper').filter({ hasText: '定时发布' }).click();
  await sleep(2000);

  // 2. Open the picker
  await page.locator('input[placeholder="选择日期时间"]').click();
  await sleep(1000);

  // 3. Set value via React native setter + bubbling event
  const jsCode = `
    (newValue) => {
      const input = document.querySelector('input[placeholder="选择日期时间"]');
      if (!input) return false;
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;
      nativeSetter.call(input, newValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
  `;
  await page.evaluate(jsCode, publishDateStr);
  await sleep(1000);

  // 4. Press Enter to confirm
  await page.keyboard.press('Enter');
  await sleep(2000);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Page-level upload steps — exported standalone so it can be tested with a mock Page.
 * uploadVideo() wraps this in withContext().
 *
 * Port of KSVideo.upload() (page interaction portion).
 */
export async function uploadKuaishouVideo(page: Page, opts: UploadVideoOptions): Promise<void> {
  // 1. Navigate to upload page
  await page.goto(KUAISHOU_UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForURL(KUAISHOU_UPLOAD_URL_PATTERN, { timeout: 120_000 });

  // 2. Click upload button → file chooser → set video file
  //    port of: async with page.expect_file_chooser() as fc_info: / file_chooser.set_files(...)
  const uploadButton = page.locator("button[class^='_upload-btn']");
  await uploadButton.waitFor({ state: 'visible', timeout: 10_000 });

  const fileChooserPromise = page.waitForEvent('filechooser');
  await uploadButton.click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(opts.filePath);

  await sleep(2000);

  // 3. Dismiss "我知道了" tutorial button if present
  const knowButton = page.locator('button[type="button"] span:text("我知道了")').first();
  try {
    if ((await knowButton.count()) && (await knowButton.isVisible())) {
      await knowButton.click();
    }
  } catch {
    /* not present */
  }

  // 4. Close Joyride guide overlay if present
  await _closeGuideOverlay(page);

  // 5. Fill description and tags (port of fill-desc + tags loop)
  await page.getByText('描述').locator('xpath=following-sibling::div').click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Control+KeyA');
  await page.keyboard.press('Delete');
  await page.keyboard.type(opts.desc || opts.title);
  await page.keyboard.press('Enter');

  const tags = (opts.tags ?? []).slice(0, 3);
  for (const tag of tags) {
    await page.keyboard.type(`#${tag} `);
    await sleep(2000);
  }

  // 6. Wait for upload to complete (port of while retry_count < max_retries loop)
  //    Polls page.locator("text=上传中").count() == 0; max 60 retries × 2s
  const MAX_RETRIES = 60;
  let retryCount = 0;
  while (retryCount < MAX_RETRIES) {
    try {
      const uploadingCount = await page.locator('text=上传中').count();
      if (uploadingCount === 0) break;

      if (await page.locator('text=上传失败').count()) {
        await _handleUploadError(page, opts.filePath);
      }

      await sleep(2000);
    } catch {
      await sleep(2000);
    }
    retryCount++;
  }

  // 7. Set thumbnail if provided
  if (opts.thumbnail) {
    try {
      await _setKsThumbnail(page, opts.thumbnail);
    } catch {
      /* thumbnail setting failed, continue to publish */
    }
  }

  // 8. Set schedule time if provided
  if (opts.scheduleAt) {
    await _setKsScheduleTime(page, new Date(opts.scheduleAt));
  }

  // 9. Publish: click 发布 → optional confirm 确认发布 → wait for manage URL
  //    port of the publish while True loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const publishButton = page.getByText('发布', { exact: true });
      if ((await publishButton.count()) > 0) {
        await publishButton.click();
      }

      await sleep(1000);

      const confirmButton = page.getByText('确认发布');
      if ((await confirmButton.count()) > 0) {
        await confirmButton.click();
      }

      await page.waitForURL(KUAISHOU_MANAGE_URL_PATTERN, { timeout: 5000 });
      break;
    } catch {
      await sleep(1000);
    }
  }
}

export const kuaishou: PlatformModule = {
  platform: 'kuaishou',

  /**
   * login — port of get_ks_cookie
   * 有头浏览器，全新 context（无 storageState），等待用户快手 APP 扫码
   */
  async login(opts: LoginOptions): Promise<{ success: boolean; message: string }> {
    return withContext({ headless: opts.headless }, async (ctx) => {
      const page = await ctx.newPage();
      try {
        await page.goto(KUAISHOU_LOGIN_URL);

        await _saveKsQrcode(page, opts.storageStatePath, opts.onQrcode);

        const result = await runLoginPoll({
          // port of: if page.url.startswith(KUAISHOU_UPLOAD_URL) or await _is_ks_login_page_gone(page):
          isCompleted: async () =>
            page.url().startsWith(KUAISHOU_UPLOAD_URL) || (await _isKsLoginPageGone(page)),
          handleExpired: async () => {
            if (await _isKsQrcodeExpired(page)) {
              // port of: refresh_button = page.locator("p.qrcode-refresh").first
              const refreshButton = page.locator('p.qrcode-refresh').first();
              if (await refreshButton.count()) {
                await refreshButton.click();
                await sleep(1000);
              }
              await _saveKsQrcode(page, opts.storageStatePath, opts.onQrcode);
            }
          },
          successMessage: '快手扫码登录成功',
          timeoutMessage: '等待快手扫码登录超时',
        });

        if (result.success) {
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
   * 无头浏览器，访问上传页，若出现"机构服务"选择器则判定 cookie 失效
   */
  async checkCookie(storageStatePath: string): Promise<boolean> {
    return withContext({ storageStatePath, headless: true }, async (ctx) => {
      const page = await ctx.newPage();
      try {
        await page.goto(KUAISHOU_UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const invalid = await _isKsCookieInvalid(page);
        return !invalid;
      } catch {
        return false;
      }
    });
  },

  /**
   * uploadVideo — port of KSVideo.upload / KSVideo.main
   * context 由 engine.withContext 管理；上传成功后更新 storageState
   */
  async uploadVideo(opts: UploadVideoOptions): Promise<void> {
    await runUploadWithContext(opts, (page) => uploadKuaishouVideo(page, opts));
  },
};
