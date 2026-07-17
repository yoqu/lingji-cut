/**
 * 快手平台模块
 * 1:1 港自 social-auto-upload/uploader/ks_uploader/main.py
 *   cookie_auth      → checkCookie
 *   get_ks_cookie    → login  (快手 APP 扫码，有头)
 *   KSVideo.upload   → uploadVideo / uploadKuaishouVideo
 */
import { existsSync } from 'node:fs';
import type { Locator, Page, Response } from 'playwright';
import { withContext } from '../engine';
import { LoginExpiredError } from '../errors';
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

// Glob pattern for page.waitForURL (port of KUAISHOU_UPLOAD_URL_PATTERN)
const KUAISHOU_UPLOAD_URL_PATTERN = '**/article/publish/video**';
const KUAISHOU_MANAGE_PATH = '/article/manage/video';
const KUAISHOU_AUTHOR_DECLARATION = '个人观点，仅供参考';
const KUAISHOU_MAX_TAGS = 3;
const KUAISHOU_HASHTAG_PATTERN = /#([^#\s，,。！？!?：:；;、]+)/g;
const KUAISHOU_SUBMIT_PATH = /^\/rest\/cp\/works\/v[23]\/video\/pc\/submit$/;
const KUAISHOU_SUBMIT_TIMEOUT_MS = 15_000;
const KUAISHOU_MESSAGE_SELECTOR =
  '.ant-message-notice-content, .ant-notification-notice-message, [role="alert"]';

// ─── Cookie-invalidity selector ───────────────────────────────────────────────
// port of KUAISHOU_COOKIE_INVALID_SELECTOR = "div.names div.container div.name:text('机构服务')"
// 保持 :text() 精确匹配（Node Playwright 支持）；:has-text() 子串匹配会误报 cookie 失效

const KUAISHOU_COOKIE_INVALID_SELECTOR =
  "div.names div.container div.name:text('机构服务')";

/** 登录态失效时给用户的可操作提示（区别于「页面结构变化」的兜底报错）。 */
const KUAISHOU_LOGIN_EXPIRED_MESSAGE =
  '快手登录态已失效（上传页渲染为未登录介绍页），请在「发布账号」中重新登录该快手账号后再发布';

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
 * 关闭 react-joyride 新手引导遮罩（幂等，可在任意时点重复调用）。
 * 遮罩在上传开始后 ~2s 才挂载且 pointer-events:auto 拦截整页点击；
 * 先点 Skip 正常结束引导，再兜底直接摘除遮罩节点（引导纯装饰，不影响页面功能）。
 */
async function _closeGuideOverlay(page: Page): Promise<void> {
  try {
    const skip = page.locator('div[id^="react-joyride-step"] [data-action="skip"]').first();
    if (await skip.count()) await skip.click({ force: true, timeout: 2000 });
  } catch {
    /* fall through to hard removal */
  }
  try {
    await page.evaluate(() => {
      document.querySelector('#react-joyride-portal')?.remove();
      document.querySelectorAll('[id^="react-joyride-step"]').forEach((el) => el.remove());
    });
  } catch {
    /* best-effort */
  }
}

/** 收集当前页面可见的弹窗/提示文案，超时报错时还原现场，便于远程诊断。 */
async function _describeVisibleBlockers(page: Page): Promise<string> {
  try {
    const texts = await page.evaluate(() => {
      const els = [
        ...document.querySelectorAll(
          '[role="dialog"], [role="alertdialog"], .ant-modal, .cp-dialog-wrapper, [class*="toast"], [id^="react-joyride-step"]',
        ),
      ] as HTMLElement[];
      const visible = els
        .filter((el) => el.offsetWidth || el.offsetHeight)
        .map((el) => el.innerText.trim().replace(/\s+/g, ' ').slice(0, 80))
        .filter(Boolean);
      return [...new Set(visible)].slice(0, 3).join(' / ');
    });
    return typeof texts === 'string' ? texts : '';
  } catch {
    return '';
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
 * 硬摘除残留的封面弹窗。实机验证（2026-07-14）：该弹窗不响应 Escape，点 X 也无效；
 * 一旦打开且未走「确认」闭环就永远挂着，`ant-modal-wrap` 拦截后续所有页面点击
 * （作者声明/发布按钮全部被 intercepts pointer events 卡死）。只能从 DOM 摘除。
 */
async function _removeKsCoverModal(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      document.querySelectorAll('.ant-modal-wrap, .ant-modal-mask').forEach((el) => el.remove());
      document.querySelectorAll('.ant-scrolling-effect').forEach((el) => {
        el.classList.remove('ant-scrolling-effect');
        (el as HTMLElement).style.removeProperty('overflow');
        (el as HTMLElement).style.removeProperty('width');
      });
    });
  } catch {
    /* best-effort */
  }
}

/**
 * set_thumbnail
 * port of KSVideo.set_thumbnail
 * 实机验证过的闭环：封面设置入口 → 弹窗「上传封面」tab → 弹窗内 file input →
 * 页脚「确认」→ 弹窗关闭（toast「封面应用成功」）。
 */
async function _setKsThumbnail(page: Page, thumbnailPath: string): Promise<void> {
  // .first()：页面存在多个含「封面设置」的 span（嵌套/tooltip）时避免 strict mode 抛错
  const coverLabel = page.locator('span').filter({ hasText: '封面设置' }).first();
  await coverLabel.waitFor({ state: 'visible', timeout: 30_000 });
  // joyride 引导遮罩可能在上传期间挂载并拦截整页点击，点封面入口前先清一次
  await _closeGuideOverlay(page);
  await coverLabel.locator('xpath=../following-sibling::div[1]').locator('div').nth(0).click();

  const modal = page.locator('div[role="document"].ant-modal');
  await modal.waitFor({ state: 'visible', timeout: 30_000 });

  const uploadCoverTab = modal.getByText('上传封面', { exact: true });
  await uploadCoverTab.waitFor({ state: 'visible', timeout: 10_000 });
  await uploadCoverTab.click();

  const fileInput = modal.locator('input[type="file"]').first();
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

/** 快手新版发布表单要求选择作者声明；已有选择时保留用户原值。 */
async function _setKsAuthorDeclaration(page: Page): Promise<void> {
  const label = page.getByText('作者声明', { exact: true }).first();
  if (!(await label.count())) return;

  const select = label.locator('xpath=..').locator('.ant-select').first();
  await select.waitFor({ state: 'visible', timeout: 10_000 });
  if ((await select.locator('.ant-select-selection-item').count()) > 0) return;

  await _closeGuideOverlay(page);
  await select.click({ timeout: 10_000 });
  const option = page.getByText(KUAISHOU_AUTHOR_DECLARATION, { exact: true }).first();
  if (!(await option.count())) {
    throw new Error(`快手作者声明设置失败：未找到“${KUAISHOU_AUTHOR_DECLARATION}”选项`);
  }
  await option.click({ timeout: 10_000 });
  await select.locator('.ant-select-selection-item').waitFor({ state: 'visible', timeout: 10_000 });
}

function _normalizeKuaishouTag(rawTag: string): string {
  return rawTag.replace(/^#+/, '').trim().split(/[\s，,。！？!?：:；;、#]/, 1)[0] ?? '';
}

export function buildKuaishouCaptionPlan(
  description: string,
  tags: string[],
): { description: string; tagsToAppend: string[] } {
  const seen = new Set<string>();
  const normalizedDescription = description
    .replace(KUAISHOU_HASHTAG_PATTERN, (_token, rawTag: string) => {
      const tag = _normalizeKuaishouTag(rawTag);
      const key = tag.toLocaleLowerCase();
      if (!tag || seen.has(key) || seen.size >= KUAISHOU_MAX_TAGS) return '';
      seen.add(key);
      return `#${tag}`;
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  const tagsToAppend: string[] = [];
  for (const rawTag of tags) {
    if (seen.size >= KUAISHOU_MAX_TAGS) break;
    const tag = _normalizeKuaishouTag(rawTag);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tagsToAppend.push(tag);
  }
  return { description: normalizedDescription, tagsToAppend };
}

async function _fillKsDescription(page: Page, editor: Locator, description: string): Promise<void> {
  try {
    await editor.click({ timeout: 5_000 });
  } catch {
    await _closeGuideOverlay(page);
    await editor.click({ timeout: 10_000 });
  }
  try {
    await editor.fill(description, { timeout: 10_000 });
    return;
  } catch {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+KeyA' : 'Control+KeyA');
    await page.keyboard.press('Delete');
    await page.keyboard.type(description);
  }
}

/** query 参数会随快手路由版本变化，成功确认只依赖可信 origin 与管理页 path。 */
function _isKuaishouManageUrl(url: URL): boolean {
  const pathname = url.pathname.replace(/\/+$/, '');
  return url.origin === 'https://cp.kuaishou.com' && pathname === KUAISHOU_MANAGE_PATH;
}

function _isKuaishouSubmitResponse(response: Response): boolean {
  const url = new URL(response.url());
  return (
    url.origin === 'https://cp.kuaishou.com' &&
    KUAISHOU_SUBMIT_PATH.test(url.pathname) &&
    response.request().method() === 'POST'
  );
}

interface KuaishouSubmitDiagnostic {
  endpoint: string;
  httpStatus: number;
  result?: unknown;
  originResult?: unknown;
  message: string;
}

class KuaishouPublishRejectedError extends Error {}

function _safeDiagnosticValue(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').slice(0, 120);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return 'unknown';
}

async function _readKuaishouSubmitDiagnostic(
  response: Response,
): Promise<KuaishouSubmitDiagnostic> {
  let payload: Record<string, unknown> = {};
  try {
    const json = await response.json();
    if (json && typeof json === 'object') payload = json as Record<string, unknown>;
  } catch {
    /* non-JSON response: fall back to HTTP status */
  }
  return {
    endpoint: new URL(response.url()).pathname,
    httpStatus: response.status(),
    result: payload.result,
    originResult: payload.originResult,
    message: typeof payload.message === 'string' ? payload.message : '',
  };
}

function _isKuaishouSubmitSuccess(diagnostic: KuaishouSubmitDiagnostic): boolean {
  return diagnostic.result === 1 || diagnostic.result === '1';
}

async function _waitForKuaishouPageMessage(page: Page): Promise<string> {
  const message = page.locator(KUAISHOU_MESSAGE_SELECTOR).first();
  try {
    await message.waitFor({ state: 'visible', timeout: 6000 });
    return _safeDiagnosticValue(await message.textContent());
  } catch {
    return '';
  }
}

function _formatKuaishouSubmitFailure(
  diagnostic: KuaishouSubmitDiagnostic,
  currentUrl: string,
  pageMessage: string,
): string {
  const reason = _safeDiagnosticValue(
    diagnostic.message ||
      pageMessage ||
      `HTTP ${diagnostic.httpStatus} 返回了无法识别的发布结果`,
  );
  return (
    `快手发布失败：${reason}。诊断: endpoint=${diagnostic.endpoint}; ` +
    `http=${diagnostic.httpStatus}; result=${_safeDiagnosticValue(diagnostic.result)}; ` +
    `originResult=${_safeDiagnosticValue(diagnostic.originResult)}; currentUrl=${currentUrl}` +
    (pageMessage && pageMessage !== reason ? `; pageMessage=${pageMessage}` : '')
  );
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
  try {
    await uploadButton.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (err) {
    // 快手登录态失效时 URL 不变，但页面渲染成未登录介绍页（含「机构服务」标记），
    // 上传按钮永不出现。区分「登录失效」与「页面结构变化」，前者给可操作提示。
    if (await _isKsCookieInvalid(page)) throw new LoginExpiredError(KUAISHOU_LOGIN_EXPIRED_MESSAGE);
    throw err;
  }

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
  //    新版页面描述区是 #work-description-edit（contenteditable）；旧版结构回退到 label 兄弟节点
  const descEditor = (await page.locator('#work-description-edit').count())
    ? page.locator('#work-description-edit')
    : page.getByText('描述').locator('xpath=following-sibling::div');
  const captionPlan = buildKuaishouCaptionPlan(opts.desc || opts.title, opts.tags ?? []);
  await _fillKsDescription(page, descEditor, captionPlan.description);
  if (captionPlan.tagsToAppend.length > 0) await page.keyboard.press('Enter');
  for (const tag of captionPlan.tagsToAppend) {
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

  // 7. Set thumbnail if provided（快手单封面，优先 3:4 竖图）
  //    先校验封面文件存在再碰 UI：路径失效（如封面被删/移动）时 setInputFiles 抛错
  //    会把关不掉的封面弹窗留在页面上，卡死后续所有步骤。
  //    失败重试一轮（先硬摘残留弹窗 + 清遮罩）；仍失败则跳过封面继续发布，
  //    但必须经 onProgress 外发原因，不允许静默吞掉。
  const thumbnail = opts.covers?.['3:4'] ?? opts.thumbnail;
  if (thumbnail && !existsSync(thumbnail)) {
    opts.onProgress?.(80, `快手封面文件不存在（已跳过封面继续发布）：${thumbnail}`);
  } else if (thumbnail) {
    let coverError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await _setKsThumbnail(page, thumbnail);
        coverError = '';
        break;
      } catch (err) {
        coverError = err instanceof Error ? err.message.split('\n')[0] : String(err);
        await _removeKsCoverModal(page);
        await _closeGuideOverlay(page);
        await sleep(1000);
      }
    }
    if (coverError) {
      // 最后一轮失败后可能仍有残留弹窗，发布前必须摘干净
      await _removeKsCoverModal(page);
      opts.onProgress?.(80, `快手封面设置失败（已跳过封面继续发布）：${coverError}`);
    }
  }

  // 8. Set required author declaration without overwriting an existing choice
  await _setKsAuthorDeclaration(page);

  // 9. Set schedule time if provided
  if (opts.scheduleAt) {
    await _setKsScheduleTime(page, new Date(opts.scheduleAt));
  }

  // 10. Publish: click 发布 → optional confirm 确认发布 → wait for manage URL
  //    有界重试：页面异常（遮罩拦截/结构变化/跳转失败）时抛可读错误，而非无限挂起
  const publishDeadline = Date.now() + 120_000;
  let lastError = '';
  let lastPageMessage = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (_isKuaishouManageUrl(new URL(page.url()))) break;

      // 引导遮罩可能中途再弹出并拦截点击，每轮先清一次
      await _closeGuideOverlay(page);

      const submitResponsePromise = page
        .waitForResponse(_isKuaishouSubmitResponse, { timeout: KUAISHOU_SUBMIT_TIMEOUT_MS })
        .catch(() => null);
      const pageMessagePromise = _waitForKuaishouPageMessage(page);
      const publishButton = page.getByText('发布', { exact: true });
      if ((await publishButton.count()) > 0) {
        // 显式短超时：单轮点击被拦时快速进入下一轮（下一轮会再清遮罩）
        await publishButton.click({ timeout: 10_000 });
      }

      await sleep(1000);

      const confirmButton = page.getByText('确认发布');
      if ((await confirmButton.count()) > 0) {
        await confirmButton.click({ timeout: 5_000 });
      }

      try {
        await page.waitForURL(_isKuaishouManageUrl, { timeout: 5000, waitUntil: 'commit' });
        break;
      } catch (navigationError) {
        const submitResponse = await submitResponsePromise;
        lastPageMessage = (await pageMessagePromise) || lastPageMessage;
        if (!submitResponse) {
          if (/发布成功/.test(lastPageMessage)) break;
          if (lastPageMessage) {
            throw new KuaishouPublishRejectedError(
              `快手发布失败：${lastPageMessage}。诊断: submitResponse=not-observed; currentUrl=${page.url()}`,
            );
          }
          throw navigationError;
        }

        const diagnostic = await _readKuaishouSubmitDiagnostic(submitResponse);
        if (_isKuaishouSubmitSuccess(diagnostic)) break;
        throw new KuaishouPublishRejectedError(
          _formatKuaishouSubmitFailure(diagnostic, page.url(), lastPageMessage),
        );
      }
    } catch (err) {
      if (err instanceof KuaishouPublishRejectedError) throw err;
      lastError = err instanceof Error ? err.message.split('\n').slice(0, 4).join(' | ') : String(err);
      if (Date.now() > publishDeadline) {
        const blockers = await _describeVisibleBlockers(page);
        throw new Error(
          `快手发布确认超时：点击发布后未跳转到作品管理页。当前页面: ${page.url()}；最后一轮异常: ${lastError}` +
            (lastPageMessage ? `；页面提示: ${lastPageMessage}` : '') +
            (blockers ? `；页面可见弹窗/提示: ${blockers}` : ''),
        );
      }
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
