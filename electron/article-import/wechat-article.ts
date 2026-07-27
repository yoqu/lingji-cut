import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  WechatArticleFetchResult,
  WechatArticleMaterializeRequest,
  WechatArticleMaterializeResult,
  WechatArticleMeta,
} from '../../src/lib/article-import-types';

const FETCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PAGE_TIMEOUT_MS = 30_000;
const IMAGE_TIMEOUT_MS = 60_000;
const WX_IMAGE_HOSTS = new Set(['mmbiz.qpic.cn', 'mmbiz.qlogo.cn', 'res.wx.qq.com']);
const WX_EXT_BY_FMT: Record<string, string> = {
  jpeg: 'jpg',
  jpg: 'jpg',
  png: 'png',
  gif: 'gif',
  webp: 'webp',
  bmp: 'bmp',
};

export function parseWechatArticleUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error('链接格式无效，请粘贴完整的公众号文章链接');
  }
  if (url.hostname !== 'mp.weixin.qq.com') {
    throw new Error('仅支持 mp.weixin.qq.com 公众号文章链接');
  }
  return url;
}

export function wechatArticleIdFromUrl(url: URL): string {
  const shareMatch = url.pathname.match(/^\/s\/([\w-]+)/);
  if (shareMatch) return shareMatch[1];
  const sn = url.searchParams.get('sn');
  if (sn) return sn.replace(/[^\w-]/g, '');
  return `article-${Date.now()}`;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': FETCH_UA, Referer: 'https://mp.weixin.qq.com/' },
      redirect: 'follow',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

function matchFirst(html: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m?.[1]) return decodeEntities(m[1]).trim();
  }
  return undefined;
}

export function extractWechatArticleMeta(html: string, sourceUrl: string): WechatArticleMeta {
  return {
    title:
      matchFirst(html, [
        /<meta\s+property="og:title"\s+content="([^"]*)"/,
        /var msg_title = '([^']*)'/,
      ]) ?? '未命名公众号文章',
    account: matchFirst(html, [
      /var nickname = htmlDecode\("([^"]*)"\)/,
      /<meta\s+property="og:article:author"\s+content="([^"]*)"/,
    ]),
    author: matchFirst(html, [/var author = "([^"]*)"/]),
    publishTime: matchFirst(html, [/createTime = '([^']*)'/]),
    digest: matchFirst(html, [/<meta\s+property="og:description"\s+content="([^"]*)"/]),
    coverUrl: matchFirst(html, [/<meta\s+property="og:image"\s+content="([^"]*)"/]),
    sourceUrl,
  };
}

export function extractWechatArticleContent(html: string): string {
  const anchor = html.indexOf('id="js_content"');
  if (anchor < 0) {
    throw new Error('未找到文章正文，文章可能已删除、违规或需要在微信内打开');
  }
  const bodyStart = html.indexOf('>', anchor) + 1;
  let depth = 1;
  let end = -1;
  const divTag = /<(\/?)div[\s>]/g;
  divTag.lastIndex = bodyStart;
  let m: RegExpExecArray | null;
  while ((m = divTag.exec(html)) !== null) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) {
      end = m.index;
      break;
    }
  }
  if (end < 0) {
    throw new Error('文章正文结构解析失败');
  }
  return html.slice(bodyStart, end);
}

const BLOCK_TAGS = new Set(['section', 'p', 'div', 'blockquote', 'figure', 'figcaption', 'table', 'tr']);
const SKIP_TAGS = new Set([
  'script', 'style', 'svg', 'iframe', 'audio', 'video',
  'mp-common-profile', 'mp-miniprogram', 'mpvoice', 'mpvideo', 'qqmusic',
]);
const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'source']);

function readAttr(tagText: string, name: string): string | null {
  const m =
    tagText.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i')) ??
    tagText.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'));
  return m ? decodeEntities(m[1]) : null;
}

/** 公众号正文 HTML → Markdown。正文图片以远程 URL 形式保留，落地阶段再本地化。 */
export function wechatContentToMarkdown(contentHtml: string): string {
  const tokens = contentHtml.split(/(<[^>]+>)/);
  const blocks: string[] = [];
  let buf = '';
  let heading = 0;
  let quoteDepth = 0;
  let skipDepth = 0;
  let skipTag: string | null = null;
  let linkHref: string | null = null;
  let linkText = '';
  const listStack: { ordered: boolean; index: number }[] = [];

  const flush = (): void => {
    let text = buf.replace(/[ \t ]+/g, ' ').trim();
    buf = '';
    if (!text) return;
    if (heading) text = `${'#'.repeat(Math.min(heading, 6))} ${text}`;
    if (quoteDepth) text = `> ${text}`;
    blocks.push(text);
  };

  for (const token of tokens) {
    if (!token) continue;
    if (token[0] !== '<') {
      if (skipDepth > 0) continue;
      const text = decodeEntities(token);
      if (linkHref !== null) linkText += text;
      else buf += text;
      continue;
    }
    const nameMatch = token.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/);
    if (!nameMatch) continue;
    const tag = nameMatch[1].toLowerCase();
    const isClose = token[1] === '/';
    const isVoid = VOID_TAGS.has(tag) || /\/>$/.test(token);

    if (skipDepth > 0) {
      if (tag === skipTag) {
        if (isClose) skipDepth -= 1;
        else if (!isVoid) skipDepth += 1;
        if (skipDepth === 0) skipTag = null;
      }
      continue;
    }
    if (SKIP_TAGS.has(tag)) {
      if (!isClose && !isVoid) {
        skipDepth = 1;
        skipTag = tag;
      }
      continue;
    }

    switch (tag) {
      case 'br':
        flush();
        break;
      case 'hr':
        flush();
        blocks.push('---');
        break;
      case 'img': {
        const src = readAttr(token, 'data-src') ?? readAttr(token, 'src');
        if (src && /^https?:\/\//.test(src)) {
          flush();
          blocks.push(`![${readAttr(token, 'alt') ?? ''}](${src})`);
        }
        break;
      }
      case 'strong':
      case 'b':
        buf += '**';
        break;
      case 'em':
      case 'i':
        buf += '*';
        break;
      case 'a':
        if (isClose) {
          const text = linkText.trim();
          if (linkHref && text && linkHref !== text) buf += `[${text}](${linkHref})`;
          else buf += text || (linkHref ?? '');
          linkHref = null;
          linkText = '';
        } else {
          const href = readAttr(token, 'href');
          linkHref = href && /^https?:\/\//.test(href) ? href : '';
          linkText = '';
        }
        break;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        flush();
        heading = isClose ? 0 : Number(tag[1]);
        break;
      case 'blockquote':
        flush();
        quoteDepth = Math.max(0, quoteDepth + (isClose ? -1 : 1));
        break;
      case 'ul':
      case 'ol':
        flush();
        if (isClose) listStack.pop();
        else listStack.push({ ordered: tag === 'ol', index: 0 });
        break;
      case 'li':
        flush();
        if (!isClose) {
          const frame = listStack[listStack.length - 1];
          if (frame) {
            frame.index += 1;
            buf += frame.ordered ? `${frame.index}. ` : '- ';
          } else {
            buf += '- ';
          }
        }
        break;
      default:
        if (BLOCK_TAGS.has(tag)) flush();
        break;
    }
  }
  flush();
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;

export function listWechatImageUrls(markdown: string): string[] {
  const urls: string[] = [];
  for (const m of markdown.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    try {
      if (WX_IMAGE_HOSTS.has(new URL(m[1]).hostname) && !urls.includes(m[1])) {
        urls.push(m[1]);
      }
    } catch {
      // 非法 URL 跳过
    }
  }
  return urls;
}

export function inferWechatImageExtension(imageUrl: string): string {
  try {
    const url = new URL(imageUrl);
    const fmt = url.searchParams.get('wx_fmt')?.toLowerCase();
    if (fmt && WX_EXT_BY_FMT[fmt]) return WX_EXT_BY_FMT[fmt];
    const pathFmt = url.pathname.match(/mmbiz_([a-z]+)\//)?.[1];
    if (pathFmt && WX_EXT_BY_FMT[pathFmt]) return WX_EXT_BY_FMT[pathFmt];
  } catch {
    // fall through
  }
  return 'jpg';
}

async function downloadImage(imageUrl: string, targetPath: string): Promise<void> {
  const response = await fetchWithTimeout(imageUrl, IMAGE_TIMEOUT_MS);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if ((response.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error('返回了 HTML 而非图片');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error('图片内容为空');
  await fs.writeFile(targetPath, buffer);
}

export async function fetchWechatArticle(articleUrl: string): Promise<WechatArticleFetchResult> {
  const url = parseWechatArticleUrl(articleUrl);
  const response = await fetchWithTimeout(url.toString(), PAGE_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`文章页面请求失败（HTTP ${response.status}）`);
  }
  const html = await response.text();
  if (html.includes('访问过于频繁') || html.includes('环境异常')) {
    throw new Error('微信风控拦截了本次访问，请稍后重试');
  }
  if (html.includes('该内容已被发布者删除')) {
    throw new Error('文章已被发布者删除');
  }
  if (html.includes('此内容因违规无法查看')) {
    throw new Error('文章因违规无法查看');
  }

  const meta = extractWechatArticleMeta(html, articleUrl);
  const body = wechatContentToMarkdown(extractWechatArticleContent(html));
  if (!body) {
    throw new Error('文章正文为空，可能是纯图片或视频内容');
  }

  const byline = [meta.account, meta.author, meta.publishTime].filter(Boolean).join(' · ');
  const markdown = [
    `# ${meta.title}`,
    '',
    ...(byline ? [`> ${byline}`, ''] : []),
    `> 原文：${meta.sourceUrl}`,
    '',
    body,
    '',
  ].join('\n');

  return {
    articleId: wechatArticleIdFromUrl(url),
    meta,
    markdown,
    imageCount: listWechatImageUrls(markdown).length,
  };
}

export interface MaterializeWechatArticleOptions extends WechatArticleMaterializeRequest {
  onProgress?: (progress: number, stepLabel: string) => void;
}

/** 下载 Markdown 中引用的微信图片到项目目录并改写链接，落盘 article.md 与 source.json。 */
export async function materializeWechatArticle(
  options: MaterializeWechatArticleOptions,
): Promise<WechatArticleMaterializeResult> {
  const { projectDir, articleId, meta, onProgress } = options;
  if (!projectDir || !articleId) {
    throw new Error('projectDir 与 articleId 不能为空');
  }
  const importDir = path.join(projectDir, 'imports', 'wechat', articleId);
  const imagesDir = path.join(importDir, 'images');
  const articlePath = path.join(importDir, 'article.md');
  await fs.mkdir(imagesDir, { recursive: true });

  const imageUrls = listWechatImageUrls(options.markdown);
  let markdown = options.markdown;
  let failedImageCount = 0;
  for (let i = 0; i < imageUrls.length; i += 1) {
    const imageUrl = imageUrls[i];
    onProgress?.(
      Math.round(((i + 1) / imageUrls.length) * 90),
      `正在下载图片 ${i + 1}/${imageUrls.length}`,
    );
    const fileName = `${String(i + 1).padStart(3, '0')}.${inferWechatImageExtension(imageUrl)}`;
    try {
      await downloadImage(imageUrl, path.join(imagesDir, fileName));
      markdown = markdown
        .split(imageUrl)
        .join(`imports/wechat/${articleId}/images/${fileName}`);
    } catch (error) {
      failedImageCount += 1;
      console.warn('[wechat-article] image download failed:', imageUrl, error);
    }
  }

  onProgress?.(95, '正在写入文稿');
  await fs.writeFile(articlePath, markdown, 'utf8');
  await fs.writeFile(
    path.join(importDir, 'source.json'),
    JSON.stringify(
      {
        sourceType: 'wechat_article',
        articleId,
        importedAt: new Date().toISOString(),
        ...meta,
        imageCount: imageUrls.length,
        failedImageCount,
      },
      null,
      2,
    ),
    'utf8',
  );

  return {
    articleId,
    importDir,
    articlePath,
    markdown,
    imageCount: imageUrls.length,
    failedImageCount,
  };
}
