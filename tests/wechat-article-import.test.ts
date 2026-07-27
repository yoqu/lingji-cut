import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  extractWechatArticleContent,
  extractWechatArticleMeta,
  inferWechatImageExtension,
  listWechatImageUrls,
  materializeWechatArticle,
  parseWechatArticleUrl,
  wechatArticleIdFromUrl,
  wechatContentToMarkdown,
} from '../electron/article-import/wechat-article';

describe('parseWechatArticleUrl / wechatArticleIdFromUrl', () => {
  it('接受 mp.weixin.qq.com 链接并提取短链 articleId', () => {
    const url = parseWechatArticleUrl('https://mp.weixin.qq.com/s/UNplmlFgH67RlL5UpH0HMg?foo=1');
    expect(wechatArticleIdFromUrl(url)).toBe('UNplmlFgH67RlL5UpH0HMg');
  });

  it('拒绝非公众号域名与非法链接', () => {
    expect(() => parseWechatArticleUrl('https://example.com/s/abc')).toThrow('mp.weixin.qq.com');
    expect(() => parseWechatArticleUrl('not-a-url')).toThrow('链接格式无效');
  });

  it('长链回退到 sn 参数', () => {
    const url = parseWechatArticleUrl(
      'https://mp.weixin.qq.com/s?__biz=MzA=&mid=1&idx=1&sn=abc123def',
    );
    expect(wechatArticleIdFromUrl(url)).toBe('abc123def');
  });
});

describe('extractWechatArticleMeta', () => {
  const html = `
    <meta property="og:title" content="测试标题 &amp; 副标题" />
    <meta property="og:description" content="摘要" />
    <meta property="og:image" content="https://mmbiz.qpic.cn/cover/0?wx_fmt=jpeg" />
    <script>var nickname = htmlDecode("测试公众号");var author = "作者名";createTime = '2026-07-25 08:30';</script>
  `;

  it('提取标题、公众号、作者、时间、摘要与封面', () => {
    const meta = extractWechatArticleMeta(html, 'https://mp.weixin.qq.com/s/x');
    expect(meta.title).toBe('测试标题 & 副标题');
    expect(meta.account).toBe('测试公众号');
    expect(meta.author).toBe('作者名');
    expect(meta.publishTime).toBe('2026-07-25 08:30');
    expect(meta.digest).toBe('摘要');
    expect(meta.coverUrl).toBe('https://mmbiz.qpic.cn/cover/0?wx_fmt=jpeg');
  });

  it('缺失字段回退默认标题', () => {
    const meta = extractWechatArticleMeta('<html></html>', 'https://mp.weixin.qq.com/s/x');
    expect(meta.title).toBe('未命名公众号文章');
    expect(meta.account).toBeUndefined();
  });
});

describe('extractWechatArticleContent', () => {
  it('按 div 深度平衡截取 js_content 正文', () => {
    const html =
      '<div id="js_content" style="visibility:hidden;"><div class="a"><p>内层</p></div><p>外层</p></div><div>after</div>';
    expect(extractWechatArticleContent(html)).toBe(
      '<div class="a"><p>内层</p></div><p>外层</p>',
    );
  });

  it('缺失 js_content 抛出可读错误', () => {
    expect(() => extractWechatArticleContent('<html></html>')).toThrow('未找到文章正文');
  });
});

describe('wechatContentToMarkdown', () => {
  it('section/span 结构转段落，br 断段', () => {
    const html =
      '<section><span leaf="">第一段，</span></section><section><span leaf="">继续第一段。</span></section>' +
      '<section><span leaf=""><br /></span></section><section><span leaf="">第二段。</span></section>';
    expect(wechatContentToMarkdown(html)).toBe('第一段，\n\n继续第一段。\n\n第二段。');
  });

  it('保留加粗、链接、标题与图片（data-src 优先）', () => {
    const html =
      '<h2><span>小标题</span></h2>' +
      '<p><strong>重点</strong>正文 <a href="https://example.com">参考</a></p>' +
      '<img data-src="https://mmbiz.qpic.cn/a/640?wx_fmt=png&amp;from=appmsg" alt="图" src="data:image/gif;base64,x" />';
    const md = wechatContentToMarkdown(html);
    expect(md).toContain('## 小标题');
    expect(md).toContain('**重点**正文 [参考](https://example.com)');
    expect(md).toContain('![图](https://mmbiz.qpic.cn/a/640?wx_fmt=png&from=appmsg)');
  });

  it('跳过 script/style/小程序卡片，列表转 Markdown 列表', () => {
    const html =
      '<script>evil()</script><style>.a{}</style>' +
      '<mp-common-profile class="card"><span>公众号名片</span></mp-common-profile>' +
      '<ul><li>甲</li><li>乙</li></ul><ol><li>一</li><li>二</li></ol>';
    const md = wechatContentToMarkdown(html);
    expect(md).not.toContain('evil');
    expect(md).not.toContain('公众号名片');
    expect(md).toContain('- 甲\n\n- 乙');
    expect(md).toContain('1. 一\n\n2. 二');
  });
});

describe('图片工具', () => {
  it('listWechatImageUrls 只收集微信图床且去重', () => {
    const md = [
      '![a](https://mmbiz.qpic.cn/x/640?wx_fmt=png)',
      '![b](https://example.com/y.png)',
      '![c](https://mmbiz.qpic.cn/x/640?wx_fmt=png)',
    ].join('\n\n');
    expect(listWechatImageUrls(md)).toEqual(['https://mmbiz.qpic.cn/x/640?wx_fmt=png']);
  });

  it('inferWechatImageExtension 依次尝试 wx_fmt 与路径段', () => {
    expect(inferWechatImageExtension('https://mmbiz.qpic.cn/x/640?wx_fmt=jpeg')).toBe('jpg');
    expect(inferWechatImageExtension('https://mmbiz.qpic.cn/sz_mmbiz_gif/x/640')).toBe('gif');
    expect(inferWechatImageExtension('https://mmbiz.qpic.cn/unknown/640')).toBe('jpg');
  });
});

describe('materializeWechatArticle', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function makeTmpProject(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'wechat-import-'));
  }

  it('下载图片、改写相对路径并落盘 article.md 与 source.json', async () => {
    const projectDir = await makeTmpProject();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
      ),
    );

    const markdown =
      '# 标题\n\n正文\n\n![图](https://mmbiz.qpic.cn/a/640?wx_fmt=png)\n\n结尾\n';
    const result = await materializeWechatArticle({
      projectDir,
      articleId: 'abc',
      meta: { title: '标题', sourceUrl: 'https://mp.weixin.qq.com/s/abc' },
      markdown,
    });

    expect(result.imageCount).toBe(1);
    expect(result.failedImageCount).toBe(0);
    expect(result.markdown).toContain('![图](imports/wechat/abc/images/001.png)');
    const saved = await fs.readFile(path.join(projectDir, 'imports/wechat/abc/article.md'), 'utf8');
    expect(saved).toBe(result.markdown);
    const image = await fs.readFile(path.join(projectDir, 'imports/wechat/abc/images/001.png'));
    expect(image.equals(PNG)).toBe(true);
    const source = JSON.parse(
      await fs.readFile(path.join(projectDir, 'imports/wechat/abc/source.json'), 'utf8'),
    );
    expect(source.sourceType).toBe('wechat_article');
    expect(source.title).toBe('标题');
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('单张图片失败不阻断导入，保留远程链接并计入 failedImageCount', async () => {
    const projectDir = await makeTmpProject();
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        if (call === 1) return new Response('nope', { status: 404 });
        return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      }),
    );

    const markdown =
      '![坏](https://mmbiz.qpic.cn/bad/640?wx_fmt=png)\n\n![好](https://mmbiz.qpic.cn/good/640?wx_fmt=jpeg)\n';
    const result = await materializeWechatArticle({
      projectDir,
      articleId: 'abc',
      meta: { title: 't', sourceUrl: 'https://mp.weixin.qq.com/s/abc' },
      markdown,
    });

    expect(result.failedImageCount).toBe(1);
    expect(result.markdown).toContain('https://mmbiz.qpic.cn/bad/640?wx_fmt=png');
    expect(result.markdown).toContain('imports/wechat/abc/images/002.jpg');
    await fs.rm(projectDir, { recursive: true, force: true });
  });
});
