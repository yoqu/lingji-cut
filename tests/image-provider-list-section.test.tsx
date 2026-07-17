import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImageProviderListSection } from '../src/components/settings/ImageProviderListSection';
import type { ImageProvider } from '../src/types/ai';

describe('ImageProviderListSection', () => {
  it('空列表渲染添加入口', () => {
    const html = renderToStaticMarkup(
      <ImageProviderListSection
        imageProviders={[]}
        defaultImageProviderId={null}
        onChange={() => {}}
      />,
    );
    expect(html).toMatch(/图片生成服务/);
    expect(html).toMatch(/添加/);
  });

  it('已配置 provider 时显示 name、type、模型、默认徽标与测试按钮', () => {
    const provider: ImageProvider = {
      id: 'i1',
      name: 'My Jimeng',
      type: 'jimeng',
      baseUrl: 'https://jimeng.jianying.com',
      apiKey: 'k',
      models: ['jimeng-5.0'],
    };
    const html = renderToStaticMarkup(
      <ImageProviderListSection
        imageProviders={[provider]}
        defaultImageProviderId="i1"
        onChange={() => {}}
      />,
    );
    expect(html).toContain('My Jimeng');
    expect(html).toContain('即梦');
    expect(html).toContain('jimeng-5.0');
    expect(html).toContain('默认');
    expect(html).toContain('https://jimeng.jianying.com');
    expect(html).toContain('测试');
  });
});
