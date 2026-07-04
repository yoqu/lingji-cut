// @vitest-environment jsdom
//
// 分镜（storyboard）编辑区交互测试。
//
// 说明：tests/ai-card-inspector.test.tsx 的 image/video 用例依赖
// renderToStaticMarkup + Select portal，在 jsdom 环境会触发
// "Portals are not currently supported by the server renderer"。
// 因此这里把需要 jsdom 的交互用例独立成文件，避免影响原 SSR 用例。
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AICardInspector } from '../src/components/AICardInspector';
import type { AICard } from '../src/types/ai';

// 让 React 在 jsdom 下识别 act() 边界。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseCardStyle = {
  primaryColor: '#6366f1',
  backgroundColor: '#0f172a',
  fontSize: 48,
} as const;

describe('AICardInspector · 分镜', () => {
  it('渲染分镜编辑区并支持单独生成回填', async () => {
    const motionCard: AICard = {
      id: 'card-direction',
      segmentId: 'segment-1',
      type: 'summary',
      title: 'Motion 卡片',
      content: '人工智能正在改变我们的创作方式。',
      startMs: 0,
      endMs: 45_000,
      displayDurationMs: 5_000,
      displayMode: 'fullscreen',
      template: 'summary-default',
      enabled: true,
      style: baseCardStyle,
    };

    const generated = '{"claim":"AI 改变创作","carrier":"quote","beats":[]}';
    const onGenerateAnimationDirection = vi.fn().mockResolvedValue(generated);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <AICardInspector
          card={motionCard}
          onRegenerate={async () => null}
          onSave={() => undefined}
          onDelete={() => undefined}
          onGenerateAnimationDirection={onGenerateAnimationDirection}
        />,
      );
    });

    expect(container.textContent ?? '').toContain('分镜');

    const button = Array.from(container.querySelectorAll('button')).find((el) =>
      (el.textContent ?? '').includes('生成分镜'),
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // 等待 onGenerateAnimationDirection 的 Promise 解析后的 setState。
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onGenerateAnimationDirection).toHaveBeenCalledTimes(1);

    const textarea = Array.from(container.querySelectorAll('textarea')).find(
      (el) => el.value === generated,
    );
    expect(textarea).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
