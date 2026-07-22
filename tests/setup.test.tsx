import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Setup } from '../src/pages/Setup';

describe('Setup', () => {
  it('renders hero banner and quick actions on welcome page', () => {
    const html = renderToStaticMarkup(
      <Setup
        projectName=""
        recentProjects={[]}
        onOpenRecentProject={async () => undefined}
        onImportScript={async () => undefined}
        onOpenSettings={() => undefined}
        onMediaImport={async () => undefined}
        onImportProject={() => undefined}
        onOpenFreePublish={() => undefined}
      />,
    );

    expect(html).toContain('开始创作');
    expect(html).toContain('导入文稿');
    expect(html).toContain('导入媒体');
    expect(html).toContain('导入项目');
    expect(html).not.toContain('所有文件均在本地处理');
  });

  it('renders project name label when project is active', () => {
    const html = renderToStaticMarkup(
      <Setup
        projectName="my-project"
        recentProjects={[]}
        onOpenRecentProject={async () => undefined}
        onImportScript={async () => undefined}
        onOpenSettings={() => undefined}
        onMediaImport={async () => undefined}
        onImportProject={() => undefined}
        onOpenFreePublish={() => undefined}
      />,
    );

    expect(html).toContain('my-project');
    expect(html).toContain('lucide-folder-open');
  });

  it('renders recent projects in projects section', () => {
    const html = renderToStaticMarkup(
      <Setup
        projectName=""
        recentProjects={[
          {
            path: '/tmp/demo-project',
            name: 'demo-project',
            lastOpenedAt: new Date('2026-04-06T20:30:00+08:00').getTime(),
          },
        ]}
        onOpenRecentProject={async () => undefined}
        onImportScript={async () => undefined}
        onOpenSettings={() => undefined}
        onMediaImport={async () => undefined}
        onImportProject={() => undefined}
        onOpenFreePublish={() => undefined}
      />,
    );

    expect(html).toContain('本地草稿');
    expect(html).toContain('demo-project');
  });
});
