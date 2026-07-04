/**
 * 视频号平台模块
 * 1:1 港自 social-auto-upload/uploader/tencent_uploader/main.py
 *   cookie_auth          → checkCookie
 *   tencent_cookie_gen   → login  (WeChat QR 扫码，有头)
 *   TencentVideo.upload  → uploadVideo / uploadTencentVideo
 */
import * as fs from 'node:fs/promises';
import type { BrowserContext, Locator, Page } from 'playwright';
import { withContext } from '../engine';
import { LoginExpiredError } from '../errors';
import { qrcodePngPath, runLoginPoll, saveQrcodeFromDataUrl, sleep } from '../platform-shared';
import type { LoginOptions, PlatformModule, UploadVideoOptions } from '../types';

// ─── URLs ─────────────────────────────────────────────────────────────────────

const TENCENT_LOGIN_URL = 'https://channels.weixin.qq.com';
const TENCENT_HOME_URL = 'https://channels.weixin.qq.com/platform';
const TENCENT_UPLOAD_URL = 'https://channels.weixin.qq.com/platform/post/create';
const TENCENT_MANAGE_URL = 'https://channels.weixin.qq.com/platform/post/list';

// ─── Cookie requirements (port of _TENCENT_REQUIRED_COOKIE_NAMES) ─────────────

const REQUIRED_COOKIE_NAMES = new Set(['sessionid', 'wxuin']);
const MIN_COOKIE_COUNT = 6; // _TENCENT_MIN_COOKIE_COUNT in Python source（持久化预热水位线）
const COOKIE_AUTH_MIN_COUNT = 4; // cookie_auth 静态体检阈值（main.py: len(cookie_list) < 4）
/** Parent domains to visit so their cookies are captured in the context before persisting. */
const PARENT_DOMAIN_URLS = ['https://mp.weixin.qq.com', 'https://www.qq.com'] as const;

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * port of format_str_for_short_title
 * 允许汉字 / 字母 / 数字 / 《》"":+?%°，逗号 → 空格，最长 16 / 最短 6（空格补齐）
 */
function formatStrForShortTitle(originTitle: string): string {
  const allowedSpecial = '《》“”:+?%°';
  let result = '';
  for (const char of originTitle) {
    if (/[\p{L}\p{N}]/u.test(char) || allowedSpecial.includes(char)) {
      result += char;
    } else if (char === ',') {
      result += ' ';
    }
  }
  if (result.length > 16) return result.slice(0, 16);
  if (result.length < 6) return result.padEnd(6, ' ');
  return result;
}

// ─── Login helpers ────────────────────────────────────────────────────────────

/**
 * _extract_tencent_qrcode_src
 * 先试 iframe 路径，再试直接页面候选选择器
 */
async function _extractQrcodeSrc(page: Page): Promise<string> {
  // iframe path (page.frameLocator('[src*="login-for-iframe"]'))
  try {
    const iframeLocator = page.frameLocator('[src*="login-for-iframe"]');
    const qrImg = iframeLocator.locator('div#app img.qrcode').first();
    await qrImg.waitFor({ state: 'visible', timeout: 30_000 });
    const src = await qrImg.getAttribute('src');
    if (src && src.startsWith('data:image/')) return src;
  } catch {
    /* fall through */
  }

  const selectors = [
    'div.login-qrcode-wrap img.qrcode',
    'div.qrcode-wrap img.qrcode',
    'img.qrcode',
    'img[src^="data:image/"]',
  ];
  for (const selector of selectors) {
    const img = page.locator(selector).first();
    try {
      if (!(await img.count()) || !(await img.isVisible())) continue;
      const src = await img.getAttribute('src');
      if (src && src.startsWith('data:image/')) return src;
    } catch {
      continue;
    }
  }

  throw new Error('未获取到视频号登录二维码地址');
}

/**
 * _save_tencent_qrcode → simplified: extract src → save as PNG → call onQrcode(pngPath)
 */
async function _tryExtractAndSaveQrcode(
  page: Page,
  storagePath: string,
  onQrcode: (pngPath: string) => void,
): Promise<void> {
  try {
    const src = await _extractQrcodeSrc(page);
    await saveQrcodeFromDataUrl(src, qrcodePngPath(storagePath, 'tencent_qrcode.png'), onQrcode);
  } catch {
    /* silent: caller handles */
  }
}

/**
 * _is_tencent_login_completed
 * 先检查发布页标志（publish_markers），再排除登录标志（login_markers）
 */
async function _isTencentLoginCompleted(page: Page): Promise<boolean> {
  const publishMarkers = [
    page.locator('div:has-text("发表视频")').first(),
    page.locator('button:has-text("发表")').first(),
    page.locator('button:has-text("保存草稿")').first(),
  ];
  for (const marker of publishMarkers) {
    try {
      if ((await marker.count()) && (await marker.isVisible())) return true;
    } catch {
      continue;
    }
  }

  const url = page.url();
  if (!url.startsWith(TENCENT_UPLOAD_URL) && !url.startsWith(TENCENT_MANAGE_URL)) return false;

  const loginMarkers = [
    page.locator('div.login-qrcode-wrap').first(),
    page.locator('div.qrcode-wrap').first(),
    page.locator('img.qrcode').first(),
    page.locator('span:has-text("微信扫码登录 视频号助手")').first(),
  ];
  for (const marker of loginMarkers) {
    try {
      if ((await marker.count()) && (await marker.isVisible())) return false;
    } catch {
      continue;
    }
  }

  return true;
}

/**
 * _is_tencent_qrcode_expired
 */
async function _isTencentQrcodeExpired(page: Page): Promise<boolean> {
  const selectors = [
    'div.mask.show p.refresh-tip:has-text("二维码已过期，点击刷新")',
    'div.mask.show p.refresh-tip:has-text("网络不可用，点击刷新")',
    'p.refresh-tip:has-text("二维码已过期，点击刷新")',
    'p.refresh-tip:has-text("网络不可用，点击刷新")',
  ];
  for (const selector of selectors) {
    const tip = page.locator(selector).first();
    try {
      if ((await tip.count()) && (await tip.isVisible())) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * _refresh_tencent_qrcode
 */
async function _refreshTencentQrcode(page: Page): Promise<void> {
  const visibleRefreshSelectors = [
    'div.login-qrcode-wrap div.mask.show div.refresh-wrap',
    'div.login-qrcode-wrap div.mask.show .refresh-wrap',
  ];
  for (const selector of visibleRefreshSelectors) {
    const refreshWrap = page.locator(selector).first();
    try {
      if (!(await refreshWrap.count()) || !(await refreshWrap.isVisible())) continue;
      await refreshWrap.click();
      return;
    } catch {
      continue;
    }
  }

  const tipSelectors = [
    'div.mask.show p.refresh-tip:has-text("二维码已过期，点击刷新")',
    'div.mask.show p.refresh-tip:has-text("网络不可用，点击刷新")',
    'p.refresh-tip:has-text("二维码已过期，点击刷新")',
    'p.refresh-tip:has-text("网络不可用，点击刷新")',
  ];
  for (const selector of tipSelectors) {
    const tip = page.locator(selector).first();
    try {
      if (!(await tip.count()) || !(await tip.isVisible())) continue;
      const refreshWrap = tip
        .locator('xpath=ancestor::div[contains(@class, "refresh-wrap")]')
        .first();
      if (await refreshWrap.count()) {
        await refreshWrap.click();
      } else {
        await tip.click();
      }
      return;
    } catch {
      continue;
    }
  }

  const fallback = page.locator('div.login-qrcode-wrap div.refresh-wrap').first();
  if (await fallback.count()) {
    await fallback.click();
    return;
  }

  throw new Error('未找到可点击的视频号二维码刷新区域');
}

/**
 * _wait_for_tencent_login — polls for login completion; refreshes expired QR
 */
async function _waitForTencentLogin(
  page: Page,
  storagePath: string,
  onQrcode?: (pngPath: string) => void,
): Promise<{ success: boolean; message: string }> {
  return runLoginPoll({
    isCompleted: () => _isTencentLoginCompleted(page),
    handleExpired: async () => {
      if (await _isTencentQrcodeExpired(page)) {
        await _refreshTencentQrcode(page);
        await sleep(1000);
        if (onQrcode) {
          await _tryExtractAndSaveQrcode(page, storagePath, onQrcode);
        }
      }
    },
    successMessage: '视频号扫码登录成功',
    timeoutMessage: '等待视频号扫码登录超时',
  });
}

// ─── Cookie-check helpers ─────────────────────────────────────────────────────

/**
 * _classify_tencent_auth_page
 * Returns true if the current page is the authenticated upload/manage page.
 */
async function _classifyTencentAuthPage(page: Page): Promise<boolean> {
  if (page.url().includes('login.html')) return false;

  const loginMarkers = [
    page.getByText('扫码登录', { exact: true }).first(),
    page.locator('div.login-qrcode-wrap').first(),
    page.locator('img.qrcode').first(),
    page.getByText('一站式服务，', { exact: true }).first(),
  ];
  for (const marker of loginMarkers) {
    try {
      if ((await marker.count()) && (await marker.isVisible())) return false;
    } catch {
      continue;
    }
  }

  const fileInput = page.locator('input[type="file"]').first();
  if (await fileInput.count()) return true;

  const publishMarkers = [
    page.getByText('发表视频', { exact: true }).first(),
    page.getByRole('button', { name: '发表' }).first(),
    page.getByRole('button', { name: '保存草稿' }).first(),
  ];
  for (const marker of publishMarkers) {
    try {
      if ((await marker.count()) && (await marker.isVisible())) return true;
    } catch {
      continue;
    }
  }

  return false;
}

/**
 * _wait_for_tencent_auth_page — polls up to maxChecks × pollInterval ms
 */
async function _waitForTencentAuthPage(
  page: Page,
  maxChecks = 12,
  pollInterval = 1000,
): Promise<boolean> {
  for (let i = 0; i < maxChecks; i++) {
    if (await _classifyTencentAuthPage(page)) return true;
    await sleep(pollInterval);
  }
  return false;
}

// ─── Storage-state persistence ───────────────────────────────────────────────

/**
 * Port of _wait_for_tencent_cookies_settled.
 * Polls context.cookies() until the required cookie names appear AND the total
 * count reaches minCount, or until the deadline is reached.
 * Never throws — returns whatever cookies exist at deadline (best-effort).
 */
async function _waitForTencentCookiesSettled(
  ctx: BrowserContext,
  options: { minCount?: number; timeout?: number; pollInterval?: number } = {},
): Promise<{ name: string }[]> {
  const { minCount = MIN_COOKIE_COUNT, timeout = 15_000, pollInterval = 500 } = options;
  const deadline = Date.now() + timeout;
  let lastCookies: { name: string }[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      lastCookies = await ctx.cookies();
    } catch {
      lastCookies = [];
    }
    const names = new Set(lastCookies.map((c) => c.name));
    const requiredPresent = [...REQUIRED_COOKIE_NAMES].some((n) => names.has(n));
    if (requiredPresent && lastCookies.length >= minCount) return lastCookies;
    if (Date.now() >= deadline) return lastCookies;
    await sleep(pollInterval);
  }
}

/**
 * Port of _warmup_tencent_parent_domains.
 * Opens each parent-domain URL in a fresh page so the browser writes
 * .qq.com / mp.weixin.qq.com cookies into the current context.
 * Every step is best-effort; failures are silently swallowed.
 */
async function _warmupTencentParentDomains(ctx: BrowserContext): Promise<void> {
  for (const url of PARENT_DOMAIN_URLS) {
    let warmPage: Page | undefined;
    try {
      warmPage = await ctx.newPage();
      await warmPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      try {
        await warmPage.waitForLoadState('networkidle', { timeout: 5_000 });
      } catch {
        /* best-effort */
      }
    } catch {
      /* best-effort */
    } finally {
      if (warmPage) {
        try {
          await warmPage.close();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/**
 * Port of _persist_tencent_storage_state.
 * Unified storage-state flush:
 *   1. Wait for networkidle on the active page (best-effort, 8 s).
 *   2. Optionally visit parent domains to capture cross-domain cookies.
 *   3. Poll cookies until key names present + count ≥ minCount, or settleTimeout.
 *   4. Write storageState to disk.
 * Returns the final cookie count; logs a warning if below threshold but never throws.
 */
async function _persistTencentStorageState(
  ctx: BrowserContext,
  page: Page,
  storageStatePath: string,
  options: { warmupParents?: boolean; settleTimeout?: number; minCount?: number } = {},
): Promise<number> {
  const { warmupParents = true, settleTimeout = 15_000, minCount = MIN_COOKIE_COUNT } = options;

  // 1. Wait for networkidle on the current page (best-effort)
  try {
    await page.waitForLoadState('networkidle', { timeout: 8_000 });
  } catch {
    /* best-effort */
  }

  // 2. Visit parent domains to capture cross-domain cookies
  if (warmupParents) {
    await _warmupTencentParentDomains(ctx);
  }

  // 3. Poll until cookies settle (or timeout)
  const cookies = await _waitForTencentCookiesSettled(ctx, {
    minCount,
    timeout: settleTimeout,
  });

  // 4. Persist to disk
  await ctx.storageState({ path: storageStatePath });

  if (cookies.length < minCount) {
    console.warn(
      `[tencent] 视频号 cookie 落盘时只抓到 ${cookies.length} 条，低于期望阈值 ${minCount}，` +
        '可能登录态不完整，建议下次登录改用有头模式重试',
    );
  }
  return cookies.length;
}

// ─── Upload helpers ───────────────────────────────────────────────────────────

/** 登录态失效时给用户的可操作提示（区别于「页面结构变化」的兜底报错）。 */
const TENCENT_LOGIN_EXPIRED_MESSAGE =
  '视频号登录态已失效（页面被重定向到扫码登录），请在「发布账号」中重新登录该视频号后再发布';

/**
 * 判断当前是否停在扫码登录页。
 * 视频号 session 被服务端吊销后（即使本地 cookie 未到期），访问 /platform 或
 * /post/create 都会 302 到 channels.weixin.qq.com/login.html，并渲染
 * login-for-iframe 扫码子框架。命中任一特征即视为登录态失效。
 */
function _isTencentLoginPage(page: Page): boolean {
  if (page.url().includes('login')) return true;
  for (const frame of page.frames()) {
    try {
      if (frame.url().includes('login-for-iframe') || frame.url().includes('/login')) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * 遍历所有 frame 查找 input[type="file"]。
 * 视频号 create 页通常渲染在主框架，历史版本也出现过子 iframe，故逐 frame 扫描。
 * 找到返回第一个 Locator，否则 null。
 */
async function _findFileInput(page: Page): Promise<Locator | null> {
  for (const frame of page.frames()) {
    try {
      const fi = frame.locator('input[type="file"]');
      if (await fi.count()) return fi.first();
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 遍历所有 frame 点击「发表视频」入口。
 * 新版视频号助手把首页发表按钮渲染在主框架或 post-card 子 iframe；
 * 旧实现只在主框架 page.getByText 找 → 深链重定向落到首页后点不到按钮，
 * 进而找不到上传框。这里逐 frame 尝试以覆盖两种渲染形态。
 */
async function _clickPublishEntry(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      // 子串匹配（对齐上游 social-auto-upload，比 exact 更耐按钮文案/图标包裹）
      const btn = frame.getByText('发表视频').first();
      if (await btn.count()) {
        await btn.click({ timeout: 5_000 });
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * 打开视频号发表页。
 * 关键变化：直接深链 /platform/post/create 现在会被重定向回首页 /platform，
 * 上传表单只在点击首页「发表视频」后才渲染。因此改为：
 *   1. 打开首页 /platform
 *   2. 若表单已就绪则直接复用；否则逐 frame 点击「发表视频」
 *   3. 轮询直到出现 input[type="file"]
 */
async function _openTencentCreatePage(page: Page): Promise<void> {
  await page.goto(TENCENT_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  // 登录态失效会被重定向到扫码登录页：尽早抛出可操作错误，避免空等 120s 后误报「未找到上传框」
  if (_isTencentLoginPage(page)) throw new LoginExpiredError(TENCENT_LOGIN_EXPIRED_MESSAGE);

  // 深链偶尔仍能直接渲染上传框 → 直接复用
  if (await _findFileInput(page)) return;

  // 首页点击「发表视频」唤出 create 编辑器
  const entryDeadline = Date.now() + 60_000;
  while (Date.now() < entryDeadline) {
    if (await _clickPublishEntry(page)) break;
    if (_isTencentLoginPage(page)) throw new LoginExpiredError(TENCENT_LOGIN_EXPIRED_MESSAGE);
    await sleep(1_000);
  }

  // 等待 create 页渲染出文件上传框
  const formDeadline = Date.now() + 60_000;
  while (Date.now() < formDeadline) {
    if (await _findFileInput(page)) return;
    if (_isTencentLoginPage(page)) throw new LoginExpiredError(TENCENT_LOGIN_EXPIRED_MESSAGE);
    await sleep(1_000);
  }
}

/**
 * upload_video_file
 * 优先直接找 input[type="file"]；找不到再兜底点「发表视频」唤出上传控件
 */
async function _uploadVideoFile(page: Page, filePath: string): Promise<void> {
  let fi = await _findFileInput(page);
  if (!fi) {
    // 兜底：仍停在首页/卡片态时再点一次入口
    await _clickPublishEntry(page);
    for (let i = 0; i < 20; i++) {
      fi = await _findFileInput(page);
      if (fi) break;
      await sleep(1000);
    }
  }
  if (!fi) {
    // 区分「登录失效」与「页面结构变化」两类成因，给出对应可操作提示
    if (_isTencentLoginPage(page)) throw new LoginExpiredError(TENCENT_LOGIN_EXPIRED_MESSAGE);
    throw new Error('未找到视频号文件上传框（页面结构可能已变化，或上传表单未渲染）');
  }
  await fi.setInputFiles(filePath);
}

/**
 * fill_title_and_tags
 */
async function _fillTitleAndTags(page: Page, title: string, tags: string[]): Promise<void> {
  await page.locator('div.input-editor').click();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  for (const tag of tags) {
    await page.keyboard.type('#' + tag);
    await page.keyboard.press('Space');
  }
}

/**
 * fill_description
 */
async function _fillDescription(page: Page, desc: string): Promise<void> {
  await page.keyboard.press('Enter');
  await page.keyboard.type(desc);
}

/**
 * apply_collection
 */
async function _applyCollection(page: Page): Promise<void> {
  const collectionElements = page
    .getByText('添加到合集')
    .locator('xpath=following-sibling::div')
    .locator('.option-list-wrap > div');
  if ((await collectionElements.count()) > 1) {
    await page.getByText('添加到合集').locator('xpath=following-sibling::div').click();
    await collectionElements.first().click();
  }
}

/**
 * handle_upload_error — delete and re-upload
 */
async function _handleUploadError(page: Page, filePath: string): Promise<void> {
  await page.locator('div.media-status-content div.tag-inner:has-text("删除")').click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await _uploadVideoFile(page, filePath);
}

/**
 * wait_for_upload_complete
 * Polls until the 发表 button class no longer contains "weui-desktop-btn_disabled"
 */
async function _waitForUploadComplete(page: Page, filePath: string): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const publishButton = page.getByRole('button', { name: '发表' });
      const buttonClass = await publishButton.getAttribute('class');
      if (buttonClass && !buttonClass.includes('weui-desktop-btn_disabled')) {
        break;
      }

      await sleep(2000);

      const uploadFailed = await page.locator('div.status-msg.error').count();
      const deleteButton = await page
        .locator('div.media-status-content div.tag-inner:has-text("删除")')
        .count();
      if (uploadFailed && deleteButton) {
        await _handleUploadError(page, filePath);
      }
    } catch {
      await sleep(2000);
    }
  }
}

/**
 * apply_original_statement (port of TencentBaseUploader.apply_original_statement)
 * 声明原创为可选项；任意路径失败都继续发布
 */
async function _applyOriginalStatement(page: Page): Promise<void> {
  let originalSet = false;

  // ── path 1: modern getByLabel ─────────────────────────────────────────────
  if (await page.getByLabel('视频为原创').count()) {
    await page.getByLabel('视频为原创').check();
    originalSet = true;
  }

  let labelLocator = false;
  try {
    labelLocator = await page
      .locator('label:has-text("我已阅读并同意 《视频号原创声明使用条款》")')
      .isVisible();
  } catch {
    labelLocator = false;
  }

  if (labelLocator) {
    await page.getByLabel('我已阅读并同意 《视频号原创声明使用条款》').check();
    await page.getByRole('button', { name: '声明原创' }).click();
    originalSet = true;
  }

  // ── path 2: declare-original-checkbox dialog ───────────────────────────────
  const declarationEntry = page
    .locator(
      'div.label span:has-text("声明原创"), ' +
        'div:has-text("声明原创"):has(input.ant-checkbox-input), ' +
        'div:has-text("原创声明"):has(input.ant-checkbox-input)',
    )
    .first();
  if (await declarationEntry.count()) {
    const originalCheckbox = page
      .locator('div.declare-original-checkbox input.ant-checkbox-input')
      .first();
    if ((await originalCheckbox.count()) && !(await originalCheckbox.isDisabled())) {
      await originalCheckbox.click();
      await page.waitForTimeout(500);
      const checkedLocator = page.locator(
        'div.declare-original-dialog label.ant-checkbox-wrapper.ant-checkbox-wrapper-checked:visible',
      );
      if (!(await checkedLocator.count())) {
        await page
          .locator('div.declare-original-dialog input.ant-checkbox-input:visible')
          .first()
          .click();
      }
    }

    const originalTypeForm = page
      .locator('div.original-type-form > div.form-label:has-text("原创类型"):visible')
      .first();
    if (await originalTypeForm.count()) {
      // category is not in UploadVideoOptions; default to first visible option
      await page.locator('div.form-content:visible').click();
      const option = page
        .locator('ul.weui-desktop-dropdown__list li.weui-desktop-dropdown__list-ele:visible')
        .first();
      if (await option.count()) {
        await option.click();
      }
      await page.waitForTimeout(1000);
    }

    const declareButton = page.locator('button:has-text("声明原创"):visible');
    if (await declareButton.count()) {
      await declareButton.first().click();
      originalSet = true;
      await page.waitForTimeout(1000);
    }
  }

  // ── path 3: text-based fallback ───────────────────────────────────────────
  if (!originalSet) {
    for (const originalText of ['声明原创', '原创声明', '视频为原创']) {
      try {
        const modernOriginal = page.locator(`text="${originalText}"`).first();
        if ((await modernOriginal.count()) && (await modernOriginal.isVisible())) {
          await modernOriginal.click();
          originalSet = true;
          await page.waitForTimeout(1000);
          break;
        }
      } catch {
        continue;
      }
    }
  }

  // ── content declaration (optional) ────────────────────────────────────────
  const contentDeclaration = page.locator('text="内容声明"').first();
  try {
    if ((await contentDeclaration.count()) && (await contentDeclaration.isVisible())) {
      await contentDeclaration.click();
      for (const optionText of ['无需声明', '不声明', '无']) {
        const option = page.locator(`text="${optionText}"`).first();
        if ((await option.count()) && (await option.isVisible())) {
          await option.click();
          break;
        }
      }
    }
  } catch {
    /* 内容声明设置失败，跳过 */
  }

  // originalSet = false → diagnostic (screenshot / text dump); non-fatal
  if (!originalSet) {
    // no-op in TS port: diagnostic screenshots are dev-time only
  }
}

/**
 * confirm_thumbnail_crop
 */
async function _confirmThumbnailCrop(page: Page): Promise<void> {
  const cropDialog = page
    .locator('div.weui-desktop-dialog')
    .filter({ hasText: '裁剪封面图' })
    .first();
  if (!(await cropDialog.count())) return;
  try {
    await cropDialog.waitFor({ state: 'visible', timeout: 10_000 });
    const cropConfirmButton = cropDialog
      .locator('div.weui-desktop-dialog__ft button.weui-desktop-btn_primary:has-text("确定")')
      .first();
    if (await cropConfirmButton.count()) {
      await cropConfirmButton.waitFor({ state: 'visible', timeout: 5000 });
      await cropConfirmButton.click();
      await page.waitForTimeout(1000);
    }
  } catch {
    /* 封面裁剪确认失败，继续 */
  }
}

/**
 * open_thumbnail_dialog → returns the dialog locator or null
 */
async function _openThumbnailDialog(
  page: Page,
  selectors: string[],
  dialogTitles: string[],
): Promise<any | null> {
  for (const selector of selectors) {
    const coverEntry = page.locator(selector).first();
    try {
      if (!(await coverEntry.count())) continue;
      await coverEntry.waitFor({ state: 'visible', timeout: 3000 });
      await coverEntry.click();
      await page.waitForTimeout(500);
      break;
    } catch {
      continue;
    }
  }

  for (const title of dialogTitles) {
    const coverDialog = page.locator('div.weui-desktop-dialog').filter({ hasText: title }).first();
    if (await coverDialog.count()) return coverDialog;
  }
  return null;
}

/**
 * upload_thumbnail_in_dialog
 */
async function _uploadThumbnailInDialog(
  page: Page,
  coverDialog: any,
  thumbnailPath: string,
): Promise<void> {
  await coverDialog.waitFor({ state: 'visible', timeout: 5000 });
  const fileInput = coverDialog
    .locator('.single-cover-uploader-wrap input[type="file"]')
    .first();
  await fileInput.waitFor({ state: 'attached', timeout: 10_000 });
  await fileInput.setInputFiles(thumbnailPath);
  await page.waitForTimeout(1000);
  await _confirmThumbnailCrop(page);

  const confirmButton = coverDialog
    .locator('div.weui-desktop-dialog__ft button.weui-desktop-btn_primary:has-text("确认")')
    .first();
  await confirmButton.waitFor({ state: 'visible', timeout: 10_000 });
  await confirmButton.click();
}

/**
 * set_thumbnail (port of TencentVideo.set_thumbnail)
 * landscapePath → 4:3 横版；portraitPath → 3:4 竖版（个人主页卡片）
 */
async function _setThumbnail(
  page: Page,
  landscapePath: string | undefined,
  portraitPath: string | undefined,
): Promise<void> {
  if (!landscapePath && !portraitPath) return;

  const landscapeSelectors = [
    'div.horizontal-cover-wrap:has-text("4:3")',
    'div[class*="cover-wrap"]:has-text("4:3"):has-text("动态")',
    'div:has-text("视频号动态"):has-text("4:3")',
    'div:has-text("横版封面"):has-text("4:3")',
  ];
  const portraitSelectors = [
    'div.vertical-cover-wrap:has-text("个人主页卡片"):has-text("3:4")',
    'div.vertical-cover-wrap:has-text("3:4")',
    'div.vertical-cover-wrap:has-text("个人主页卡片")',
  ];

  if (landscapePath) {
    const coverDialog = await _openThumbnailDialog(page, landscapeSelectors, [
      '编辑视频号动态封面',
      '编辑动态封面',
      '编辑封面',
    ]);
    if (coverDialog) {
      try {
        await _uploadThumbnailInDialog(page, coverDialog, landscapePath);
      } catch {
        /* 横版封面设置失败，跳过 */
      }
    }
  }

  if (portraitPath) {
    const coverDialog = await _openThumbnailDialog(page, portraitSelectors, [
      '编辑个人主页卡片',
      '编辑封面',
    ]);
    if (coverDialog) {
      try {
        await _uploadThumbnailInDialog(page, coverDialog, portraitPath);
      } catch {
        /* 竖版封面设置失败，跳过 */
      }
    }
  }
}

/**
 * set_schedule_time_tencent (port of TencentBaseUploader.set_schedule_time_tencent)
 */
async function _setScheduleTimeTencent(page: Page, publishDate: Date): Promise<void> {
  const labelElement = page.locator('label').filter({ hasText: '定时' }).nth(1);
  await labelElement.click();
  await page.locator('input[placeholder="请选择发表时间"]').click();

  const currentMonth = String(publishDate.getMonth() + 1).padStart(2, '0') + '月';
  const pageMonth = await page
    .locator('span.weui-desktop-picker__panel__label:has-text("月")')
    .innerText();
  if (pageMonth !== currentMonth) {
    await page.locator('button.weui-desktop-btn__icon__right').click();
  }

  const elements = await page.locator('table.weui-desktop-picker__table a').all();
  for (const element of elements) {
    const className = await element.evaluate((el: Element) => el.className);
    if (className.includes('weui-desktop-picker__disabled')) continue;
    const text = await element.innerText();
    if (text.trim() === String(publishDate.getDate())) {
      await element.click();
      break;
    }
  }

  await page.locator('input[placeholder="请选择时间"]').click();
  await page.keyboard.press('Control+KeyA');
  await page.keyboard.type(String(publishDate.getHours()).padStart(2, '0'));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  try {
    await page.locator('div.input-editor').click({ timeout: 5000 });
  } catch {
    await page.keyboard.press('Escape');
  }
}

/**
 * set_short_title (port of TencentBaseUploader.set_short_title)
 */
async function _setShortTitle(page: Page, title: string, shortTitle?: string): Promise<void> {
  const shortTitleElement = page
    .getByText('短标题', { exact: true })
    .locator('..')
    .locator('xpath=following-sibling::div')
    .locator('span input[type="text"]');
  if (await shortTitleElement.count()) {
    await shortTitleElement.fill(shortTitle ?? formatStrForShortTitle(title));
  }
}

/**
 * submit_publish (port of TencentBaseUploader.submit_publish)
 */
async function _submitPublish(page: Page): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const publishButton = page.locator('div.form-btns button:has-text("发表")');
      if (await publishButton.count()) {
        await publishButton.click();
      }
      await page.waitForURL(TENCENT_MANAGE_URL, { timeout: 5000 });
      break;
    } catch {
      const currentUrl = page.url();
      if (currentUrl.includes(TENCENT_MANAGE_URL)) break;
      await sleep(500);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Page-level upload steps — exported standalone so it can be tested with a mock Page.
 * uploadVideo() wraps this in withContext().
 *
 * Port of TencentVideo.upload() (page interaction portion).
 */
export async function uploadTencentVideo(page: Page, opts: UploadVideoOptions): Promise<void> {
  // 1. Open upload page（首页 → 发表视频；深链 /post/create 现已不可直达）
  await _openTencentCreatePage(page);

  // 2. Upload video file (search all frames for input[type="file"])
  await _uploadVideoFile(page, opts.filePath);

  // 3. Fill title and tags
  await _fillTitleAndTags(page, opts.title, opts.tags);

  // 4. Fill description
  await _fillDescription(page, opts.desc || opts.title);

  // 5. Apply collection (if available and > 1 options)
  await _applyCollection(page);

  // 6. Wait for upload complete (button enabled)
  await _waitForUploadComplete(page, opts.filePath);

  // 7. Apply original statement
  await _applyOriginalStatement(page);

  // 8. 设置封面：4:3 横版动态封面 + 3:4 竖版个人主页卡片。
  //    优先用 covers 里对应比例图；缺哪个用单图 thumbnail 兜底（与旧行为兼容）。
  const landscapeCover = opts.covers?.['4:3'] ?? opts.thumbnail;
  const portraitCover = opts.covers?.['3:4'] ?? opts.thumbnail;
  if (landscapeCover || portraitCover) {
    await _setThumbnail(page, landscapeCover, portraitCover);
  }

  // 9. Schedule time
  if (opts.scheduleAt) {
    await _setScheduleTimeTencent(page, new Date(opts.scheduleAt));
  }

  // 10. Set short title (derived from opts.title if no dedicated shortTitle field)
  await _setShortTitle(page, opts.title);

  // 11. Submit publish
  await _submitPublish(page);
}

export const tencent: PlatformModule = {
  platform: 'tencent',

  /**
   * login — port of tencent_cookie_gen
   * 有头浏览器，全新 context（无 storageState），等待用户微信扫码
   */
  async login(opts: LoginOptions): Promise<{ success: boolean; message: string }> {
    return withContext({ headless: opts.headless }, async (ctx) => {
      const page = await ctx.newPage();
      try {
        await page.goto(TENCENT_LOGIN_URL);

        if (opts.onQrcode) {
          await _tryExtractAndSaveQrcode(page, opts.storageStatePath, opts.onQrcode);
        }

        const result = await _waitForTencentLogin(
          page,
          opts.storageStatePath,
          opts.onQrcode,
        );

        if (result.success) {
          // Navigate to upload page so the backend issues its full cookie set,
          // then visit parent domains and poll until cookies settle before persisting.
          await page.goto(TENCENT_UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
          await _persistTencentStorageState(ctx, page, opts.storageStatePath, {
            warmupParents: true,
            settleTimeout: 15_000,
          });
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
   * 注：Python 注释：使用 headless: true（与抖音不同）
   * 先做静态体检（cookie 条数 + 关键字段），再走 DOM 校验
   */
  async checkCookie(storageStatePath: string): Promise<boolean> {
    // Static pre-flight (port of Python JSON-read check before browser launch)
    try {
      const content = await fs.readFile(storageStatePath, 'utf-8');
      const state = JSON.parse(content) as { cookies?: { name: string }[] };
      const cookieList = state?.cookies ?? [];
      const cookieNames = new Set(cookieList.map((c) => c.name));
      if (
        cookieList.length < COOKIE_AUTH_MIN_COUNT ||
        ![...REQUIRED_COOKIE_NAMES].some((n) => cookieNames.has(n))
      ) {
        return false;
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      // Other parse errors: fall through to DOM check
    }

    // DOM check (headless: true — Python uses headless=True for tencent cookie_auth)
    return withContext({ storageStatePath, headless: true }, async (ctx) => {
      const page = await ctx.newPage();
      try {
        await page.goto(TENCENT_UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        return await _waitForTencentAuthPage(page);
      } catch {
        return false;
      }
    });
  },

  /**
   * uploadVideo — port of TencentVideo.upload / tencent_upload_video
   * context 由 engine.withContext 管理；上传完成后刷新 storageState
   */
  async uploadVideo(opts: UploadVideoOptions): Promise<void> {
    await withContext(
      { storageStatePath: opts.storageStatePath, headless: opts.headless },
      async (ctx) => {
        const page = await ctx.newPage();
        await uploadTencentVideo(page, opts);
        // 发布后只在 channels 域刷新落盘 cookie。
        // 关键登录态（sessionid/wxuin）来自 channels.weixin.qq.com，停留发布页时即已刷新；
        // 不再访问 www.qq.com / mp.weixin.qq.com 暖场（那只会抓回 .qq.com 埋点 cookie，
        // 对维持登录态无意义，徒增耗时与异常自动化痕迹）。登录路径仍保留暖场以建立完整 cookie 集。
        await _persistTencentStorageState(ctx, page, opts.storageStatePath, {
          warmupParents: false,
          settleTimeout: 10_000,
        });
      },
    );
  },
};
