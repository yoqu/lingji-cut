// tests/script-workbench.test.tsx
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OverlayProvider } from '../src/ui';
import { ScriptWorkbench } from '../src/pages/ScriptWorkbench';
import { useScriptStore } from '../src/store/script';

// localStorage 在 node 测试环境中不存在，提供一个简单 mock
const localStorageMock = (() => {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
  };
})();

vi.stubGlobal('localStorage', localStorageMock);

describe('ScriptWorkbench', () => {
  beforeEach(() => {
    useScriptStore.getState().reset();
  });

  afterEach(() => {
    useScriptStore.getState().reset();
  });

  it('renders the file-tree empty guide before the workspace is initialized', () => {
    useScriptStore.setState({ originalText: '', projectDir: null });

    const html = renderToStaticMarkup(
      <OverlayProvider>
        <ScriptWorkbench onBack={() => undefined} />
      </OverlayProvider>,
    );

    expect(html).toContain('选择工作目录');
    expect(html).toContain('导入文本文件');
    expect(html).toContain('导入媒体');
  });

  it('renders the review workspace when original text is available', () => {
    useScriptStore.setState({
      projectDir: '/tmp/script-project',
      openedFile: 'original.md',
      originalText: '# 测试报告\n\n正文内容。',
      workspaceFiles: {
        hasOriginalFile: true,
        hasScriptFile: false,
      },
    });

    // CM6 uses imperative DOM — renderToStaticMarkup produces the container div
    // but not the editor content. Verify no crash.
    const html = renderToStaticMarkup(
      <OverlayProvider>
        <ScriptWorkbench onBack={() => undefined} />
      </OverlayProvider>,
    );

    // OperationBar 摘要行应显示原稿字数统计
    expect(html).toContain('原稿');
    expect(html).toContain('original.md');
  });

  it('defaults the file tree to manuscript resources', () => {
    expect(useScriptStore.getState().fileTreeView).toBe('resources');

    useScriptStore.setState({ fileTreeView: 'all' });
    useScriptStore.getState().reset();

    expect(useScriptStore.getState().fileTreeView).toBe('resources');
  });

  it('keeps activeStream in the ScriptWorkbench store destructuring', () => {
    const source = readFileSync(
      new URL('../src/pages/ScriptWorkbench.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toMatch(
      /const\s*\{[\s\S]*\bsetActiveStream,\s*[\s\S]*\bactiveStream,\s*[\s\S]*\}\s*=\s*useScriptStore\(\);/,
    );
  });

  it('does not render the redundant top progress bar in the workbench shell', () => {
    const source = readFileSync(
      new URL('../src/pages/ScriptWorkbench.tsx', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('AgentProgressBar');
  });

  it('renders a collapsible thinking block in the editor-side view when reasoning content is available', () => {
    const source = readFileSync(
      new URL('../src/pages/ScriptWorkbench.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('ThinkingBlock');
    expect(source).toMatch(/onReasoningChunk/);
  });

  it('declares navigation callback support for jumping into the editor after TTS', () => {
    const source = readFileSync(
      new URL('../src/pages/ScriptWorkbench.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('onNavigateToEditor');
  });

  it('mounts the AutoRunLauncher as the unified AI 一键剪辑 entry', () => {
    const source = readFileSync(
      new URL('../src/pages/ScriptWorkbench.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('AutoRunLauncher');
    expect(source).toContain('useAIVideoWorkflow');
    // 老的"生成视频"按钮和 handleGenerateVideo 已移除
    expect(source).not.toContain('生成视频');
    expect(source).not.toContain('handleGenerateVideo');
  });

  it('declares a quick import detail action beside the AI video workflow entry', () => {
    const source = readFileSync(
      new URL('../src/pages/ScriptWorkbench.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('查看导入详情');
    expect(source).toContain('hasImportDetailAction');
    expect(source).toContain('handleOpenImportPreview');
  });

  it('no longer renders inline workflow overlay (progress now lives on the auto-run page)', () => {
    const source = readFileSync(
      new URL('../src/pages/ScriptWorkbench.tsx', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('workflowOverlay');
    expect(source).not.toContain('断点重试');
  });

  it('wires a douyin import dialog into the workbench shell', () => {
    const source = readFileSync(
      new URL('../src/pages/ScriptWorkbench.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('DouyinImportDialog');
    expect(source).toContain('handleImportMediaSource');
  });

  it('routes standard video preview json files into a custom preview pane', () => {
    const source = readFileSync(
      new URL('../src/pages/ScriptWorkbench.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('VideoImportPreviewPane');
    expect(source).toContain('isVideoImportPreviewFile');
    expect(source).toContain('activeFileIsVideoPreview');
  });

  it('marks script workspace files after a script is generated', () => {
    const source = readFileSync(
      new URL('../src/pages/ScriptWorkbench.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain("setWorkspaceFiles({ hasOriginalFile: true, hasScriptFile: true })");
  });

  it('binds streaming output to the generation target instead of the visible file', () => {
    const source = readFileSync(
      new URL('../src/pages/ScriptWorkbench.tsx', import.meta.url),
      'utf8',
    );
    const editorSource = readFileSync(
      new URL('../src/ui/components/script-editor.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('generationSessionRef');
    expect(source).toContain('latestState.openedFile !== session.filePath');
    expect(source).toContain('latestState.setScriptText(session.receivedText)');
    expect(source).toContain(
      'editorAgent.streamingActive && activeStream.filePath === activeFile',
    );
    expect(source).toContain('const isBoundStreamTarget =');
    expect(source).toContain('documentId={activeFile}');
    expect(source).toContain('state.setEditorAgent({ virtualCursorPos: null })');
    expect(editorSource).toMatch(
      /clearVirtualCursor\.of\(null\)[\s\S]{0,160}\}, \[documentId\]\)/,
    );
    expect(source).not.toContain('流式输出期间不允许切换离开 script.md');
  });

  it('keeps both initial generation and regeneration cancellable', () => {
    const source = readFileSync(
      new URL('../src/pages/ScriptWorkbench.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toMatch(
      /operationType: 'rewrite',[\s\S]{0,120}canInterrupt: true/,
    );
    expect(source).toMatch(
      /const stopGenerationSession = \(\) => \{[\s\S]*stopAgentOperation\(\{ resetStream: false \}\)/,
    );
    expect(source).toContain('abortController.signal.throwIfAborted()');
    expect(source).toContain('streamId: reviewTaskId');
  });

  it('rehydrates the existing script project state when the workbench mounts with a projectDir', () => {
    const source = readFileSync(
      new URL('../src/pages/ScriptWorkbench.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('await hydrateRef.current(dir);');
    expect(source).not.toContain('await refreshFileTree(dir);\n        return;');
  });
});
