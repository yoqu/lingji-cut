import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectList } from '../src/components/ProjectList';

describe('ProjectList', () => {
  it('renders local cover image paths as file URLs', () => {
    const html = renderToStaticMarkup(
      <ProjectList
        projects={[
          {
            path: '/tmp/demo-project',
            name: 'demo-project',
            lastOpenedAt: new Date('2026-04-10T20:00:00+08:00').getTime(),
            coverImageUrl: '/Users/demo/covers/cover 1.png',
          },
        ]}
        onOpenProject={() => undefined}
      />,
    );

    expect(html).toContain('file:///Users/demo/covers/cover%201.png');
  });

  it('renders stage badge with published platforms tooltip', () => {
    const html = renderToStaticMarkup(
      <ProjectList
        projects={[
          {
            path: '/tmp/demo-project',
            name: 'demo-project',
            lastOpenedAt: Date.now(),
            stage: 'published',
            publishedPlatforms: ['douyin', 'bilibili'],
          },
        ]}
        onOpenProject={() => undefined}
      />,
    );

    expect(html).toContain('已发布');
    expect(html).toContain('已发布：抖音、B站');
  });
});
