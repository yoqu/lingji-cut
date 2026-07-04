import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VideoProviderListSection } from '../src/components/settings/VideoProviderListSection';
import type { VideoProvider } from '../src/types/ai';

describe('VideoProviderListSection', () => {
  it('空列表渲染添加入口', () => {
    const html = renderToStaticMarkup(
      <VideoProviderListSection
        videoProviders={[]}
        defaultVideoProviderId={null}
        onChange={() => {}}
      />,
    );
    expect(html).toMatch(/视频 Provider/);
    expect(html).toMatch(/添加/);
  });

  it('已配置 Vidu provider 时显示 name、type、模型与默认徽标', () => {
    const provider: VideoProvider = {
      id: 'v1',
      name: 'My Vidu',
      type: 'vidu',
      baseUrl: 'https://api.vidu.com',
      apiKey: 'k',
      models: ['vidu-2.0'],
    };
    const html = renderToStaticMarkup(
      <VideoProviderListSection
        videoProviders={[provider]}
        defaultVideoProviderId="v1"
        onChange={() => {}}
      />,
    );
    expect(html).toContain('My Vidu');
    expect(html).toContain('Vidu');
    expect(html).toContain('vidu-2.0');
    expect(html).toContain('默认');
    expect(html).toContain('https://api.vidu.com');
  });
});
