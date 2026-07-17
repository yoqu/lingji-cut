// tests/media-card-preview.test.tsx
//
// 注意：项目测试环境为 vitest node + 静态 SSR（renderToStaticMarkup），
// 未引入 @testing-library/react / jsdom。此文件遵循项目惯例，使用 SSR
// 做结构断言：基于 HTML 字符串匹配文本/标签，不依赖 DOM API。
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MediaCardPreview } from '../src/components/media-card/MediaCardPreview';
import type { MediaCardContent } from '../src/types/ai';

function baseContent(
  status: MediaCardContent['generationStatus'],
  mediaType: 'image' | 'video' = 'image',
): MediaCardContent {
  return {
    mediaType,
    assetPath: status === 'ready' ? 'x.png' : null,
    aspectRatio: '16:9',
    prompt: '',
    providerId: 'p',
    model: 'm',
    generationStatus: status,
  };
}

describe('MediaCardPreview', () => {
  it('idle 显示占位 + 提示生成', () => {
    const html = renderToStaticMarkup(
      <MediaCardPreview content={baseContent('idle')} previewSrc={null} />,
    );
    expect(html).toContain('尚未生成图片');
    expect(html).toContain('填写生成描述后');
  });

  it('generating 显示 spinner 与百分比', () => {
    const html = renderToStaticMarkup(
      <MediaCardPreview content={baseContent('generating')} previewSrc={null} percent={42} />,
    );
    expect(html.includes('42%')).toBe(true);
    expect(html).toContain('正在生成图片');
  });

  it('ready (image) 渲染 <img>', () => {
    const html = renderToStaticMarkup(
      <MediaCardPreview content={baseContent('ready')} previewSrc="file:///fake.png" />,
    );
    expect(/<img[\s>]/.test(html)).toBe(true);
    expect(html.includes('file:///fake.png')).toBe(true);
  });

  it('ready (video) 渲染 <video> 且 muted', () => {
    const html = renderToStaticMarkup(
      <MediaCardPreview content={baseContent('ready', 'video')} previewSrc="file:///fake.mp4" />,
    );
    expect(/<video[\s>]/.test(html)).toBe(true);
    // React SSR 在 muted 为 true 时会在 video 标签上输出 muted 属性
    expect(/<video[^>]*\smuted(\s|=|>)/.test(html)).toBe(true);
  });

  it('failed 显示错误信息', () => {
    const html = renderToStaticMarkup(
      <MediaCardPreview
        content={{ ...baseContent('failed'), errorMessage: '配额用尽' }}
        previewSrc={null}
      />,
    );
    expect(html.includes('配额用尽')).toBe(true);
    expect(html).toContain('检查生成描述、服务与模型设置');
  });

  it('cancelled 显示已取消提示', () => {
    const html = renderToStaticMarkup(
      <MediaCardPreview content={baseContent('cancelled')} previewSrc={null} />,
    );
    expect(/取消|重新生成/.test(html)).toBe(true);
  });

  it('ready 但结果文件不可用时给出可行动提示', () => {
    const html = renderToStaticMarkup(
      <MediaCardPreview content={baseContent('ready')} previewSrc={null} />,
    );
    expect(html).toContain('无法显示生成结果');
    expect(html).toContain('请重新生成图片');
  });
});
