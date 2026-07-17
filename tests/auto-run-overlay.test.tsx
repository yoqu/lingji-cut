// tests/auto-run-overlay.test.tsx
//
// 注意：项目测试环境为 vitest node + 静态 SSR（renderToStaticMarkup），
// 未引入 @testing-library/react / jsdom。此文件遵循项目惯例，使用 SSR
// 做结构断言；对受控组件的 onClick 等回调，通过直接调用 React 元素树
// 上的 props 函数进行验证（组件本身是纯函数式的、无内部状态）。
import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutoRunOverlay, type AutoRunOverlayProps } from '../src/components/AutoRunOverlay';

function makeBaseProps(overrides: Partial<AutoRunOverlayProps> = {}): AutoRunOverlayProps {
  return {
    step: 'tts_generating',
    stepLabel: '合成语音',
    progress: 42,
    error: null,
    onCancel: vi.fn(),
    onJumpToScriptWorkbench: vi.fn(),
    onJumpToDirector: vi.fn(),
    onJumpToEditor: vi.fn(),
    ...overrides,
  };
}

/**
 * 把任意子节点（含字符串、数字、数组、片段）拍平成字符串数组，
 * 便于按文本内容匹配 React 元素。
 */
function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return collectText(props?.children);
  }
  return '';
}

/**
 * 沿元素树查找首个 children 文本包含给定子串的可点击元素（带 onClick 的元素）。
 */
function findClickableByText(node: unknown, text: string): ReactElement | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findClickableByText(child, text);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as Record<string, unknown> | null;
  if (props && typeof props.onClick === 'function') {
    const flat = collectText(props.children as ReactNode);
    if (flat.includes(text)) return node;
  }
  if (props && 'children' in props) {
    return findClickableByText(props.children, text);
  }
  return null;
}

describe('AutoRunOverlay', () => {
  it('renders current step label and progress percent in HTML', () => {
    const html = renderToStaticMarkup(
      <AutoRunOverlay {...makeBaseProps({ stepLabel: '合成语音中', progress: 42.6 })} />,
    );
    expect(html).toContain('正在自动剪辑');
    expect(html).toContain('合成语音中');
    // 整体进度百分比四舍五入展示
    expect(html).toContain('43%');
    // 步骤指示器容器存在
    expect(html).toContain('aria-label="step indicators"');
  });

  it('clicking cancel button triggers onCancel callback', () => {
    const onCancel = vi.fn();
    const tree = AutoRunOverlay(makeBaseProps({ onCancel }));
    const cancel = findClickableByText(tree, '停止');
    expect(cancel).not.toBeNull();
    const onClick = (cancel!.props as { onClick: () => void }).onClick;
    onClick();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('error on script_generating shows message and 查看脚本工作台 button', () => {
    const onJumpToScriptWorkbench = vi.fn();
    const props = makeBaseProps({
      step: 'error',
      error: { message: '生成口播稿失败', failedStep: 'script_generating' },
      onJumpToScriptWorkbench,
    });
    const html = renderToStaticMarkup(<AutoRunOverlay {...props} />);
    expect(html).toContain('生成口播稿失败');
    expect(html).toContain('查看脚本工作台');
    // 出错态不应出现取消按钮
    const tree = AutoRunOverlay(props);
    expect(findClickableByText(tree, '停止')).toBeNull();
    const jump = findClickableByText(tree, '查看脚本工作台');
    expect(jump).not.toBeNull();
    const onClick = (jump!.props as { onClick: () => void }).onClick;
    onClick();
    expect(onJumpToScriptWorkbench).toHaveBeenCalledTimes(1);
  });

  it('error on cover_generating routes to the director workbench', () => {
    const onJumpToDirector = vi.fn();
    const props = makeBaseProps({
      step: 'error',
      error: { message: '封面生成失败', failedStep: 'cover_generating' },
      onJumpToDirector,
    });
    const html = renderToStaticMarkup(<AutoRunOverlay {...props} />);
    expect(html).toContain('封面生成失败');
    expect(html).toContain('进入导演台处理');
    expect(html).not.toContain('查看脚本工作台');

    const tree = AutoRunOverlay(props);
    const jump = findClickableByText(tree, '进入导演台处理');
    expect(jump).not.toBeNull();
    const onClick = (jump!.props as { onClick: () => void }).onClick;
    onClick();
    expect(onJumpToDirector).toHaveBeenCalledTimes(1);
  });

  it('fills first 3 segments at tts_done', () => {
    const html = renderToStaticMarkup(
      <AutoRunOverlay {...makeBaseProps({ step: 'tts_done', stepLabel: '', progress: 33 })} />,
    );
    // tts_done 应归一化为 tts_generating，前 2 段完成，第 3 段进行中。
    expect((html.match(/data-status="completed"/g) ?? []).length).toBe(2);
    expect((html.match(/data-status="active"/g) ?? []).length).toBe(1);
  });

  it('fills all 6 segments at done', () => {
    const html = renderToStaticMarkup(
      <AutoRunOverlay {...makeBaseProps({ step: 'done', stepLabel: '', progress: 100 })} />,
    );
    expect((html.match(/data-status="completed"/g) ?? []).length).toBe(6);
  });

  it('导演模式在 Animatic 后显示进入编辑器确认', () => {
    const onJumpToEditor = vi.fn();
    const props = makeBaseProps({
      step: 'animatic_review',
      stepLabel: 'Animatic 已生成',
      progress: 100,
      onJumpToEditor,
    });
    const html = renderToStaticMarkup(<AutoRunOverlay {...props} />);
    expect(html).toContain('Animatic 等待确认');
    expect(html).toContain('进入编辑器确认');
    expect((html.match(/data-status="completed"/g) ?? []).length).toBe(6);
    const button = findClickableByText(AutoRunOverlay(props), '进入编辑器确认');
    expect(button).not.toBeNull();
    (button!.props as { onClick: () => void }).onClick();
    expect(onJumpToEditor).toHaveBeenCalledTimes(1);
  });

  it('导演方案检查点显示进入导演台按钮', () => {
    const onJumpToDirector = vi.fn();
    const props = makeBaseProps({
      step: 'director_review',
      stepLabel: '导演方案已就绪',
      progress: 50,
      onJumpToDirector,
    });
    const html = renderToStaticMarkup(<AutoRunOverlay {...props} />);
    expect(html).toContain('导演方案等待批准');
    const button = findClickableByText(AutoRunOverlay(props), '进入导演台');
    expect(button).not.toBeNull();
    (button!.props as { onClick: () => void }).onClick();
    expect(onJumpToDirector).toHaveBeenCalledOnce();
  });
});

/**
 * AutoRunController 源码契约校验
 *
 * 说明：完整渲染 AutoRunController 需要 mock 多个 store / IPC（pendingAutoParams、
 * pendingMediaImport、videoImportProgress、useAIVideoWorkflow.start、loadScriptFile 等），
 * 投入产出比低，端到端行为放在 Task 14 手动 E2E 回归覆盖。
 * 这里只做源码契约 smoke：确认胶水的关键调用都连上了。
 */
describe('AutoRunController wiring (source contract)', () => {
  // 使用 readFileSync 的同步读以避免顶层 await，与 auto-workflow.test.ts 风格一致
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  const source = fs.readFileSync(
    new URL('../src/components/AutoRunController.tsx', import.meta.url),
    'utf8',
  );

  it('imports AutoRunOverlay, useAIVideoWorkflow, both stores and getProjectDir', () => {
    expect(source).toContain("from './AutoRunOverlay'");
    expect(source).toContain("from '../hooks/useAIVideoWorkflow'");
    expect(source).toContain("from '../store/ai'");
    expect(source).toContain("from '../store/script'");
    expect(source).toContain("from '../store/timeline'");
    expect(source).toMatch(/getProjectDir\b/);
  });

  it('reads pendingAutoParams + pendingMediaImport and exposes setPage prop', () => {
    expect(source).toMatch(/pendingAutoParams/);
    expect(source).toMatch(/pendingMediaImport/);
    expect(source).toMatch(/setPage:\s*\(next:\s*AppPage\)\s*=>\s*void/);
  });

  it('uses startedRef guard so workflow.start fires only once', () => {
    expect(source).toMatch(/startedRef\s*=\s*useRef\(false\)/);
    expect(source).toContain('startedRef.current = true');
    // 至少一处显式重置（取消 / 跳页时）
    expect(source).toContain('startedRef.current = false');
  });

  it('text branch reads original.md and starts workflow with autoMode/autoParams', () => {
    expect(source).toContain("loadScriptFile(projectDir, 'original.md')");
    expect(source).toMatch(/autoMode:\s*true/);
    expect(source).toMatch(/autoParams:\s*pendingAutoParams/);
    expect(source).toMatch(/startFromStep:\s*'script_generating'/);
  });

  it('media branch waits for mediaImportStatus === "done" before starting', () => {
    expect(source).toContain("source === 'media'");
    expect(source).toContain("mediaImportStatus === 'done'");
  });

  it('navigates to editor on done and to script-workbench on cancel', () => {
    expect(source).toContain("workflow.step === 'done'");
    expect(source).toContain("setPage('editor')");
    expect(source).toContain("workflow.error === '任务已取消'");
    expect(source).toContain("setPage('script-workbench')");
  });

  it('passes failedStep ?? "arranging" fallback to overlay error prop', () => {
    expect(source).toMatch(/failedStep:\s*workflow\.failedStep\s*\?\?\s*'arranging'/);
  });

  // 回归:抖音导入卡"准备中"问题。AutoRunController 订阅了 onDouyinImportProgress
  // 但只推 task-progress store,不同步 script store 的 videoImportProgress —— 导致
  // 第三个 effect 的 douyinImportStatus === 'done' 信号永远收不到,workflow 不起跑;
  // 下载结束后 completeTask 让 douyinTask.status != 'active',overlay 回落到
  // STEP_LABELS['idle']='准备中' 并卡死。本测试确保同步调用存在。
  it('syncs every douyin progress snapshot into script store videoImportProgress', () => {
    expect(source).toMatch(
      /onDouyinImportProgress\([\s\S]*?setVideoImportProgress\(snapshot\)/,
    );
  });

  // 回归:离开 auto-run 的每条路径都要清 videoImportProgress,避免下次进入
  // 时残留 status='done' 让第三个 effect 立即起跑 workflow。
  it('clears videoImportProgress on done / cancel / jump paths', () => {
    const occurrences = source.match(/clearVideoImportState\(\)/g) ?? [];
    // done 分支 + 取消分支 + handleCancel + onJumpToScriptWorkbench + onJumpToEditor
    expect(occurrences.length).toBeGreaterThanOrEqual(4);
  });
});
