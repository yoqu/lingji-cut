import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FileEntry } from '../src/lib/electron-api';

function createStorageMock() {
  const storage = new Map<string, string>();

  return {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
  };
}

describe('script shell components', () => {
  const nestedEntries: FileEntry[] = [
    {
      name: 'drafts',
      type: 'directory',
      children: [
        { name: 'chapter-1.md', type: 'file' },
        { name: 'chapter-2.md', type: 'file' },
      ],
    },
    { name: 'original.md', type: 'file' },
  ];

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('../src/store/script');
    vi.stubGlobal('localStorage', createStorageMock());
  });

  it('renders the file tree empty state before a project is selected', async () => {
    const { ScriptFileTreePanel } = await import('../src/components/script/ScriptFileTreePanel');

    const html = renderToStaticMarkup(
      <ScriptFileTreePanel
        projectDir={null}
        fileEntries={[]}
        openedFile={null}
        fileDirtyMap={{}}
        fileConflictMap={{}}
        onSelectProjectDir={() => undefined}
        onOpenFile={() => undefined}
      />,
    );

    expect(html).toContain('工作文件');
    expect(html).toContain('选择工作目录');
  });

  it('renders collapsed directory rows without showing their children', async () => {
    const { DirectoryTree } = await import('../src/components/directory-tree/DirectoryTree');

    const html = renderToStaticMarkup(
      <DirectoryTree
        fileEntries={nestedEntries}
        projectDir={null}
        expandedDirectories={{ drafts: false }}
        openedFile={null}
        onToggleDirectory={() => undefined}
        onOpenFile={() => undefined}
      />,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('drafts');
    expect(html).not.toContain('chapter-1.md');
  });

  it('renders expanded directory rows and keeps nested children on a single tree branch', async () => {
    const { reconcileExpandedDirectories } = await import(
      '../src/components/directory-tree/directory-tree-helpers'
    );
    const { DirectoryTree } = await import('../src/components/directory-tree/DirectoryTree');

    expect(reconcileExpandedDirectories(nestedEntries, {})).toEqual({ drafts: false });
    expect(reconcileExpandedDirectories(nestedEntries, { drafts: true })).toEqual({
      drafts: true,
    });

    const html = renderToStaticMarkup(
      <DirectoryTree
        fileEntries={nestedEntries}
        projectDir={null}
        expandedDirectories={{ drafts: true }}
        openedFile="drafts/chapter-1.md"
        onToggleDirectory={() => undefined}
        onOpenFile={() => undefined}
      />,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('chapter-1.md');
    expect(html).toContain('drafts/chapter-1.md');
  });

  it('reveals preview file ancestors when asked to locate a nested douyin import entry', async () => {
    const { revealPathInExpandedDirectories } = await import(
      '../src/components/directory-tree/directory-tree-helpers'
    );

    expect(
      revealPathInExpandedDirectories(
        {
          imports: false,
          'imports/douyin': false,
          'imports/douyin/123': false,
          drafts: false,
        },
        'imports/douyin/123/preview.json',
      ),
    ).toEqual({
      imports: true,
      'imports/douyin': true,
      'imports/douyin/123': true,
      drafts: false,
    });
  });

  it('renders tabs for available files and keeps the active file visible', async () => {
    const { FileTabs } = await import('../src/components/script/FileTabs');

    const html = renderToStaticMarkup(
      <FileTabs
        tabs={['original.md', 'script.md']}
        openedFile="script.md"
        fileDirtyMap={{ 'original.md': true }}
        fileConflictMap={{ 'script.md': true }}
        onOpenFile={() => undefined}
      />,
    );

    expect(html).toContain('original.md');
    expect(html).toContain('script.md');
    expect(html).toContain('⚠');
  });

  it('avoids conditional hook execution inside VersionDropdown', () => {
    const source = readFileSync(
      new URL('../src/components/script/VersionDropdown.tsx', import.meta.url),
      'utf8',
    );

    const firstUseEffectIndex = source.indexOf('useEffect(() => {');
    const openedFileGuardIndex = source.indexOf("if (openedFile !== 'script.md') return null;");

    expect(firstUseEffectIndex).toBeGreaterThan(-1);
    expect(openedFileGuardIndex).toBe(-1);
  });

  it('prefers the generate-script branch from the derived workbench stage instead of currentStep', () => {
    const source = readFileSync(
      new URL('../src/components/script/QuickActionBar.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('selectEffectiveWorkbenchStage');
    expect(source).not.toContain('const currentStep = useScriptStore((s) => s.currentStep);');
    expect(source).toContain("workbenchStage === 'original_ready'");
  });

  it('keeps action availability separate from the displayed stage label', () => {
    const source = readFileSync(
      new URL('../src/components/script/QuickActionBar.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('const canGenerateScript =');
    expect(source).toContain('const canReviewScript =');
    expect(source).toContain('const canRegenerateScript =');
    expect(source).toContain('const stageHint = (() => {');
    expect(source).toContain("effectiveWorkbenchStage === 'review_clean'");
    expect(source).toContain("'重新审查'");
    expect(source).toContain("'审查口播稿'");
    expect(source).toContain("cancelTask(activeAITask.id, '用户停止')");
    expect(source).toContain('s.tasks.get(activeStreamId)');
  });

  it('derives original availability from readiness instead of raw workspace flags', () => {
    const source = readFileSync(
      new URL('../src/components/script/QuickActionBar.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('selectScriptFileReadiness');
    expect(source).toContain("const hasOriginal = originalReadiness !== 'missing';");
    expect(source).toContain("const hasScript = scriptReadiness !== 'missing';");
    expect(source).not.toContain('const hasOriginal = workspaceFiles.hasOriginalFile;');
    expect(source).not.toContain('const hasScript = workspaceFiles.hasScriptFile;');
  });

  it('gates review actions by ready script content instead of file-tree flags alone', () => {
    const source = readFileSync(
      new URL('../src/components/script/QuickActionBar.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain("const canReviewScript = scriptReadiness === 'ready' && Boolean(reviewScriptCb);");
    expect(source).toContain("const canRegenerateScript = scriptReadiness === 'ready' && Boolean(regenerateScript);");
    expect(source).toContain("const canCopyScript = scriptReadiness === 'ready' && Boolean(scriptText.trim());");
  });
});
