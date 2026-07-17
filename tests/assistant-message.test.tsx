// @vitest-environment jsdom
//
// AssistantMessage 测试：block 分发 + agent 头 + 权限卡。
// 结构断言用 SSR（renderToStaticMarkup），交互用 jsdom + createRoot + act。
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantMessage } from '../src/components/agent/AssistantMessage';
import type { ConversationTurn, PendingPermission } from '../src/types/conversation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 补 ui 库（如 Badge）在渲染时引用的 window.matchMedia 接口（jsdom 默认不实现）。
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function makeTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: 1,
    conversationId: 1,
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    blocks: [
      { type: 'text', text: '这是一段**回复**正文' },
      { type: 'thinking', text: '我先思考一下这个问题' },
      {
        type: 'tool_call',
        toolCallId: 'tc-1',
        title: 'read_text_file',
        kind: 'read',
        status: 'completed',
        rawInput: '{"path":"a.md"}',
      },
      { type: 'error', message: '工具执行失败：超时' },
    ],
    ...overrides,
  };
}

function makePending(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    requestId: 'req-99',
    toolCall: { title: 'write_text_file', rawInput: { path: 'b.md' } },
    options: [
      { optionId: 'opt-allow', name: '允许一次', kind: 'allow_once' },
      { optionId: 'opt-reject', name: '拒绝', kind: 'reject_once' },
    ],
    ...overrides,
  };
}

describe('AssistantMessage block 分发', () => {
  it('renders text / thinking / tool_call / error blocks', () => {
    const html = renderToStaticMarkup(<AssistantMessage turn={makeTurn()} />);
    // TextBlock（markdown 渲染出的正文片段）
    expect(html).toContain('回复');
    // ThinkingBlock（折叠头标签 + 字数）
    expect(html).toContain('思考过程');
    // ToolCallBlock（中文化后的工具标签；rawTitle 不再渲染）
    expect(html).toContain('读取文件');
    // ErrorBlock（错误文案）
    expect(html).toContain('工具执行失败：超时');
  });

  it('renders grouped file_changed blocks with a diff preview', () => {
    // FileChangedBlock 默认折叠，diff 详情需要点击展开后才可见；这里只断头部摘要。
    const html = renderToStaticMarkup(
      <AssistantMessage
        turn={makeTurn({
          blocks: [
            {
              type: 'file_changed',
              path: 'src/index.js',
              before: 'const a = 1;\nconst b = 2;',
              after: 'const a = 1;\nconst b = 3;',
            },
            {
              type: 'file_changed',
              path: 'src/other.js',
              before: 'old',
              after: 'new',
            },
          ],
        })}
      />,
    );
    expect(html).toContain('编辑了 2 个文件');
    // 头部 +N / -M 通过 RollingNumber 渲染，aria-label 暴露了真实数字。
    // index.js 改 1 行 + other.js 整段替换（new 增 1）= +2；两个 before 各 1 行 = -2。
    expect(html).toContain('aria-label="+2"');
    expect(html).toContain('aria-label="-2"');
  });

  it('点击 file_changed 头按钮后先展示文件行，点击文件行才展示 diff 详情', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <AssistantMessage
          turn={makeTurn({
            blocks: [
              {
                type: 'file_changed',
                path: 'src/index.js',
                before: 'const a = 1;\nconst b = 2;',
                after: 'const a = 1;\nconst b = 3;',
              },
            ],
          })}
        />,
      );
    });

    // 默认折叠：diff 体不可见。
    expect(container.textContent).not.toContain('const b = 3;');

    const header = Array.from(container.querySelectorAll('button')).find((el) =>
      el.textContent?.includes('编辑了 1 个文件'),
    )!;
    expect(header).toBeTruthy();
    act(() => {
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('index.js');
    expect(container.textContent).not.toContain('const b = 2;');
    expect(container.textContent).not.toContain('const b = 3;');

    const fileRow = Array.from(container.querySelectorAll('button')).find((el) =>
      el.textContent?.includes('src/index.js'),
    )!;
    expect(fileRow).toBeTruthy();
    act(() => {
      fileRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('const b = 2;');
    expect(container.textContent).toContain('const b = 3;');

    act(() => root.unmount());
    container.remove();
  });

  it('promotes consecutive edit/write/delete tool calls into a file change block', () => {
    const html = renderToStaticMarkup(
      <AssistantMessage
        turn={makeTurn({
          blocks: [
            {
              type: 'tool_call',
              toolCallId: 'edit-1',
              title: 'edit',
              kind: 'edit',
              status: 'completed',
              rawInput: '{"path":"src/a.ts","oldString":"old","newString":"new"}',
              rawOutput: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new',
            },
            {
              type: 'tool_call',
              toolCallId: 'write-1',
              title: 'write',
              kind: 'edit',
              status: 'completed',
              rawInput: '{"path":"src/b.ts","content":"hello\\nworld"}',
              rawOutput: 'Wrote src/b.ts',
            },
            {
              type: 'tool_call',
              toolCallId: 'delete-1',
              title: 'delete',
              kind: 'edit',
              status: 'completed',
              rawInput: '{"path":"src/c.ts"}',
              rawOutput: 'Deleted src/c.ts',
            },
          ],
        })}
      />,
    );

    expect(html).toContain('变更了 3 个文件');
    // 头部摘要 +N / -M 数字可见（RollingNumber aria-label）。
    expect(html).toMatch(/aria-label="\+\d+"/);
    expect(html).toMatch(/aria-label="-\d+"/);
    expect(html).not.toContain('工具调用');
  });

  it('updates the visible added-line count while a write tool input is streaming', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderWrite = (content: string) => {
      root.render(
        <AssistantMessage
          isLastAssistant
          isStreaming
          turn={makeTurn({
            blocks: [{
              type: 'tool_call',
              toolCallId: 'write-live',
              title: 'write',
              kind: 'edit',
              status: 'pending',
              rawInput: JSON.stringify({ path: 'notes.md', content }),
            }],
          })}
        />,
      );
    };

    act(() => renderWrite('first'));
    expect(container.querySelector('[aria-label="+1"]')).toBeTruthy();

    act(() => renderWrite('first\n\nthird'));
    expect(container.querySelector('[aria-label="+3"]')).toBeTruthy();
    expect(container.textContent).toContain('新增了 1 个文件');

    act(() => root.unmount());
    container.remove();
  });

  it('updates the visible removed-line count while an edit tool input is streaming', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderEdit = (newText: string) => {
      root.render(
        <AssistantMessage
          isLastAssistant
          isStreaming
          turn={makeTurn({
            blocks: [{
              type: 'tool_call',
              toolCallId: 'edit-live',
              title: 'edit',
              kind: 'edit',
              status: 'pending',
              rawInput: JSON.stringify({
                path: 'notes.md',
                edits: [{ oldText: 'first\nsecond', newText }],
              }),
            }],
          })}
        />,
      );
    };

    act(() => renderEdit('first\nsecond\nthird'));
    expect(
      Array.from(container.querySelectorAll('[aria-label]')).map((node) => node.getAttribute('aria-label')),
    ).toContain('+1');

    act(() => renderEdit(''));
    expect(container.querySelector('[aria-label="-2"]')).toBeTruthy();

    act(() => root.unmount());
    container.remove();
  });

  it('groups consecutive command tool calls even when their titles differ', () => {
    const html = renderToStaticMarkup(
      <AssistantMessage
        turn={makeTurn({
          blocks: [
            {
              type: 'tool_call',
              toolCallId: 'cmd-1',
              title: 'bash',
              kind: 'execute',
              status: 'completed',
              rawInput: '{"command":"git diff --stat"}',
              rawOutput: '1 file changed',
            },
            {
              type: 'tool_call',
              toolCallId: 'cmd-2',
              title: 'exec_command',
              kind: 'execute',
              status: 'completed',
              rawInput: '{"cmd":"npm test -- --run tests/assistant-message.test.tsx"}',
              rawOutput: 'passed',
            },
          ],
        })}
      />,
    );

    expect(html).toContain('已运行 2 条命令');
  });

  it('renders a single command tool call with the same two-level command layout', () => {
    const html = renderToStaticMarkup(
      <AssistantMessage
        turn={makeTurn({
          blocks: [
            {
              type: 'tool_call',
              toolCallId: 'cmd-1',
              title: 'bash',
              kind: 'execute',
              status: 'completed',
              rawInput: '{"command":"git status --short"}',
              rawOutput: 'M src/App.tsx',
            },
          ],
        })}
      />,
    );

    expect(html).toContain('已运行 1 条命令');
    expect(html).not.toContain('git status --short');
    expect(html).not.toContain('$ git status --short');
    expect(html).not.toContain('M src/App.tsx');
  });

  it('promotes apply_patch style tool calls into a file change block', () => {
    const html = renderToStaticMarkup(
      <AssistantMessage
        turn={makeTurn({
          blocks: [
            {
              type: 'tool_call',
              toolCallId: 'patch-1',
              title: 'apply_patch',
              kind: 'edit',
              status: 'completed',
              rawInput: '*** Begin Patch\n*** Update File: src/patched.ts\n@@\n-old\n+new\n*** End Patch',
              rawOutput: 'Success. Updated the following files:\nM src/patched.ts',
            },
          ],
        })}
      />,
    );

    expect(html).toContain('编辑了 1 个文件');
    // 默认折叠：patched.ts / old / new 这些 diff 细节不再出现在折叠态里。
    expect(html).not.toContain('patched.ts');
    expect(html).not.toContain('old');
    expect(html).not.toContain('new');
  });
});

describe('AssistantMessage 无 agent 身份头', () => {
  it('does not render an agent icon/name header before the body', () => {
    const html = renderToStaticMarkup(
      <AssistantMessage turn={makeTurn({ agentId: 'pi' })} />,
    );
    // agent 框架名（pi）已由 AI 面板右上角呈现，正文开头不再重复。
    expect(html).not.toContain('aria-label="Pi"');
  });
});

describe('AssistantMessage 复制按钮 + 文本可选中', () => {
  it('renders a 复制回复 button and allows text selection on content', () => {
    const html = renderToStaticMarkup(<AssistantMessage turn={makeTurn()} />);
    // 复制按钮（aria-label = 复制回复）
    expect(html).toContain('aria-label="复制回复"');
    // 显式允许鼠标拖拽选中文本（user-select: text）
    expect(html).toMatch(/user-select:\s*text/i);
  });

  it('does not render copy button when there is no text block', () => {
    const turn = makeTurn({
      blocks: [{ type: 'thinking', text: '只有思考没有正文' }],
    });
    const html = renderToStaticMarkup(<AssistantMessage turn={turn} />);
    expect(html).not.toContain('aria-label="复制回复"');
  });

  it('hides copy button while the latest message is still streaming', () => {
    const html = renderToStaticMarkup(
      <AssistantMessage turn={makeTurn()} isLastAssistant isStreaming />,
    );
    // 生成完成前（流式中的最新一条）不展示复制按钮。
    expect(html).not.toContain('aria-label="复制回复"');
  });

  it('copies the joined text blocks to clipboard on click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const turn = makeTurn({
      blocks: [
        { type: 'text', text: '第一段' },
        { type: 'thinking', text: '思考不计入复制' },
        { type: 'text', text: '第二段' },
      ],
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<AssistantMessage turn={turn} />);
    });

    const copyButton = Array.from(container.querySelectorAll('button')).find(
      (el) => el.getAttribute('aria-label') === '复制回复',
    )!;
    expect(copyButton).toBeTruthy();
    act(() => {
      copyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(writeText).toHaveBeenCalledWith('第一段\n\n第二段');

    act(() => root.unmount());
    container.remove();
  });
});

describe('AssistantMessage 权限卡', () => {
  it('renders permission options when pendingPermission is provided', () => {
    const html = renderToStaticMarkup(
      <AssistantMessage turn={makeTurn()} pendingPermission={makePending()} />,
    );
    expect(html).toContain('需要你授权工具调用');
    expect(html).toContain('write_text_file');
    expect(html).toContain('允许一次');
    expect(html).toContain('拒绝');
  });

  it('does not render permission card when pendingPermission is null', () => {
    const html = renderToStaticMarkup(
      <AssistantMessage turn={makeTurn()} pendingPermission={null} />,
    );
    expect(html).not.toContain('需要你授权工具调用');
  });

  it('calls onRespondPermission with requestId + optionId on click', () => {
    const onRespond = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <AssistantMessage
          turn={makeTurn()}
          pendingPermission={makePending()}
          onRespondPermission={onRespond}
        />,
      );
    });

    const allowButton = Array.from(container.querySelectorAll('button')).find((el) =>
      el.textContent?.includes('允许一次'),
    )!;
    expect(allowButton).toBeTruthy();
    act(() => {
      allowButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onRespond).toHaveBeenCalledWith('req-99', 'opt-allow');

    act(() => root.unmount());
    container.remove();
  });
});
