import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import fs from 'node:fs';

// AICardList 仅用 useState 维护 openMenuCardId。桩成无状态实现，使组件可被当作
// 纯函数直接调用以提取 onClick 闭包；对 SSR 路径同样安全（初值即渲染值）。
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: <S,>(init: S | (() => S)) => [
      typeof init === 'function' ? (init as () => S)() : init,
      () => undefined,
    ],
  };
});

// 桩掉 useAIStore：真实 zustand selector 走 React dispatcher，在 React 外（直接
// 函数式调用组件）会崩。这里用一个支持 selector 调用 + setState/getState 的极简
// store 复刻其外部契约，使 SSR 测试的 setState 仍生效、直接调用也不再依赖 dispatcher。
vi.mock('../src/store/ai', () => {
  let state: Record<string, unknown> = {
    currentProjectDir: null,
    convertCardToMedia: async () => null,
    convertCardToMotion: async () => null,
  };
  const useAIStore = ((selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state) as unknown as {
    (selector?: (s: typeof state) => unknown): unknown;
    getState: () => typeof state;
    setState: (patch: Partial<typeof state>) => void;
  };
  useAIStore.getState = () => state;
  useAIStore.setState = (patch) => {
    state = { ...state, ...patch };
  };
  return { useAIStore };
});
import { AICardList } from '../src/components/AICardList';
import { useAIStore } from '../src/store/ai';
import type { AICard } from '../src/types/ai';

/**
 * 项目测试环境为 vitest node + SSR（无 jsdom / testing-library）。
 * 对 onClick 等回调，通过遍历 React 元素树、按 aria-label 命中可点击元素后
 * 直接调用其 onClick prop 来验证（组件为纯函数式）。
 */
function findElement(
  node: unknown,
  predicate: (el: ReactElement) => boolean,
): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (predicate(node)) return node;
  const props = node.props as { children?: ReactNode };
  return findElement(props.children, predicate);
}

const baseCardStyle = {
  primaryColor: '#fff',
  backgroundColor: '#000',
  fontSize: 48,
} as const;

function makeImageCard(
  generationStatus: 'idle' | 'pending' | 'generating' | 'ready' | 'failed' | 'cancelled' = 'ready',
  overrides?: Partial<AICard>,
): AICard {
  return {
    id: 'img-1',
    segmentId: 's1',
    type: 'image',
    title: '图片卡',
    content: {
      mediaType: 'image',
      assetPath: 'ai-cards/img-1/image.png',
      aspectRatio: '16:9',
      prompt: '一只猫',
      providerId: 'p1',
      model: 'm1',
      generationStatus,
    },
    startMs: 0,
    endMs: 5_000,
    displayDurationMs: 5_000,
    displayMode: 'fullscreen',
    template: 'image-default',
    enabled: true,
    style: baseCardStyle,
    ...overrides,
  };
}

function makeVideoCard(
  generationStatus: 'idle' | 'pending' | 'generating' | 'ready' | 'failed' | 'cancelled' = 'ready',
  overrides?: Partial<AICard>,
): AICard {
  return {
    id: 'vid-1',
    segmentId: 's1',
    type: 'video',
    title: '视频卡',
    content: {
      mediaType: 'video',
      assetPath: 'ai-cards/vid-1/video.mp4',
      posterPath: 'ai-cards/vid-1/poster.jpg',
      aspectRatio: '16:9',
      prompt: '海岸线',
      providerId: 'v1',
      model: 'vidu-2',
      generationStatus,
    },
    startMs: 0,
    endMs: 6_000,
    displayDurationMs: 6_000,
    displayMode: 'fullscreen',
    template: 'video-default',
    enabled: true,
    style: baseCardStyle,
    ...overrides,
  };
}

describe('AICardList', () => {
  afterEach(() => {
    useAIStore.setState({ currentProjectDir: null });
  });

  it('renders design-aligned ai card rows for the left assistant panel', () => {
    const html = renderToStaticMarkup(
      <AICardList
        cards={[
          {
            id: 'card-1',
            type: 'motion',
            title: '本期要点',
            content: '重点内容',
            startMs: 0,
            endMs: 45_000,
            displayDurationMs: 5_000,
            displayMode: 'fullscreen',
            template: 'motion-default',
            enabled: true,
            style: {
              primaryColor: '#6366f1',
              backgroundColor: '#0f172a',
              fontSize: 48,
            },
            motionCard: {
              compiledAt: 1,
              prompt: '',
              retryCount: 0,
              storyboard: {
                claim: '本期要点',
                carrier: 'concept',
                scene: '',
                beats: [{ cue: null, kind: 'build', adds: '' }],
              },
            },
          },
        ]}
        placements={{
          'card-1': {
            trackId: 'visual-1',
            trackLabel: '轨道 1',
          },
        }}
        onToggleEnabled={() => undefined}
        onDeleteCard={() => undefined}
        onEditCard={() => undefined}
      />,
    );

    expect(html).toContain('data-ai-card-list="true"');
    expect(html).toContain('data-ai-card-type="motion"');
    expect(html).toContain('本期要点');
    expect(html).toContain('重点内容');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('概念');
    expect(html).toContain('data-ai-card-copy="true"');
    expect(html).not.toContain('aria-label="删除 本期要点"');
  });

  it('keeps card copy constrained inside the outer container for long content', () => {
    const css = fs.readFileSync(
      new URL('../src/components/AICardList.module.css', import.meta.url),
      'utf-8',
    );

    expect(css).toMatch(/\.card\s*\{[\s\S]*width:\s*100%/);
    expect(css).toMatch(/\.card\s*\{[\s\S]*box-sizing:\s*border-box/);
    expect(css).toMatch(/\.title\s*\{[\s\S]*flex:\s*1/);
    expect(css).toMatch(/\.body\s*\{[\s\S]*min-width:\s*0/);
    expect(css).toMatch(/\.body\s*\{[\s\S]*overflow-wrap:\s*anywhere/);
  });

  it('image 卡显示基于 assetPath 拼出的 file:// 缩略图', () => {
    useAIStore.setState({ currentProjectDir: '/tmp/proj' });
    const html = renderToStaticMarkup(
      <AICardList
        cards={[makeImageCard('ready')]}
        onToggleEnabled={() => undefined}
        onDeleteCard={() => undefined}
        onEditCard={() => undefined}
      />,
    );
    expect(html).toContain('data-ai-card-thumbnail="image"');
    expect(html).toContain('file:///tmp/proj/ai-cards/img-1/image.png');
  });

  it('video 卡显示基于 posterPath 拼出的 file:// 缩略图', () => {
    useAIStore.setState({ currentProjectDir: '/tmp/proj' });
    const html = renderToStaticMarkup(
      <AICardList
        cards={[makeVideoCard('ready')]}
        onToggleEnabled={() => undefined}
        onDeleteCard={() => undefined}
        onEditCard={() => undefined}
      />,
    );
    expect(html).toContain('data-ai-card-thumbnail="video"');
    expect(html).toContain('file:///tmp/proj/ai-cards/vid-1/poster.jpg');
  });

  it('generating 状态显示生成中徽章', () => {
    useAIStore.setState({ currentProjectDir: '/tmp/proj' });
    const html = renderToStaticMarkup(
      <AICardList
        cards={[
          makeImageCard('generating', {
            content: {
              mediaType: 'image',
              assetPath: null,
              aspectRatio: '16:9',
              prompt: '一只猫',
              providerId: 'p1',
              model: 'm1',
              generationStatus: 'generating',
            },
          }),
        ]}
        onToggleEnabled={() => undefined}
        onDeleteCard={() => undefined}
        onEditCard={() => undefined}
      />,
    );
    expect(html).toContain('data-ai-card-status="generating"');
  });

  it('每条卡片渲染「更多操作」按钮（⋯ 菜单触发器）', () => {
    const html = renderToStaticMarkup(
      <AICardList
        cards={[
          {
            id: 'card-1',
            type: 'motion',
            title: '本期要点',
            content: '重点内容',
            startMs: 0,
            endMs: 45_000,
            displayDurationMs: 5_000,
            displayMode: 'fullscreen',
            template: 'motion-default',
            enabled: true,
            style: baseCardStyle,
          },
        ]}
        onToggleEnabled={() => undefined}
        onDeleteCard={() => undefined}
        onEditCard={() => undefined}
      />,
    );
    expect(html).toContain('aria-label="本期要点 更多操作"');
    expect(html).toContain('aria-haspopup="true"');
  });

  it('failed 状态显示失败徽章', () => {
    useAIStore.setState({ currentProjectDir: '/tmp/proj' });
    const html = renderToStaticMarkup(
      <AICardList
        cards={[
          makeImageCard('failed', {
            content: {
              mediaType: 'image',
              assetPath: null,
              aspectRatio: '16:9',
              prompt: '一只猫',
              providerId: 'p1',
              model: 'm1',
              generationStatus: 'failed',
              errorMessage: '炸了',
            },
          }),
        ]}
        onToggleEnabled={() => undefined}
        onDeleteCard={() => undefined}
        onEditCard={() => undefined}
      />,
    );
    expect(html).toContain('data-ai-card-status="failed"');
  });

  it('渲染 pending 与 failed 骨架占位（生成中… / 生成失败）', () => {
    const html = renderToStaticMarkup(
      <AICardList
        cards={[]}
        onToggleEnabled={() => undefined}
        onDeleteCard={() => undefined}
        onEditCard={() => undefined}
        skeletons={[
          { segmentId: 'seg-a', title: '开场白', status: 'pending' },
          { segmentId: 'seg-b', title: '论点二', status: 'failed' },
        ]}
        onRetrySkeleton={() => undefined}
      />,
    );

    expect(html).toContain('data-skeleton-status="pending"');
    expect(html).toContain('data-skeleton-status="failed"');
    expect(html).toContain('开场白');
    expect(html).toContain('论点二');
    expect(html).toContain('生成中…');
    expect(html).toContain('生成失败');
  });

  it('已有同 segmentId 的真实卡片会抑制其骨架', () => {
    const html = renderToStaticMarkup(
      <AICardList
        cards={[makeImageCard('ready', { segmentId: 'seg-a' })]}
        onToggleEnabled={() => undefined}
        onDeleteCard={() => undefined}
        onEditCard={() => undefined}
        skeletons={[
          { segmentId: 'seg-a', title: '应被抑制', status: 'pending' },
          { segmentId: 'seg-c', title: '仍展示', status: 'pending' },
        ]}
      />,
    );

    expect(html).not.toContain('应被抑制');
    expect(html).toContain('仍展示');
  });

  it('failed 骨架点击重试调用 onRetrySkeleton 并带上 segmentId', () => {
    const onRetrySkeleton = vi.fn();
    // 无 jsdom / react-test-renderer：直接函数式调用组件取元素树（useState 被
    // 顶部 vi.mock 桩成无状态实现，useAIStore 为真实 zustand，可在 React 外求值），
    // 再遍历树命中重试按钮并调用其 onClick 闭包。
    const tree = (
      AICardList as unknown as (p: Parameters<typeof AICardList>[0]) => ReactElement
    )({
      cards: [],
      onToggleEnabled: () => undefined,
      onDeleteCard: () => undefined,
      onEditCard: () => undefined,
      skeletons: [{ segmentId: 'seg-x', title: '失败段', status: 'failed' }],
      onRetrySkeleton,
    });

    const retry = findElement(
      tree,
      (el) =>
        typeof (el.props as { 'aria-label'?: string })['aria-label'] === 'string' &&
        (el.props as { 'aria-label'?: string })['aria-label']!.includes('重试生成'),
    );
    expect(retry).not.toBeNull();
    (retry!.props as { onClick: () => void }).onClick();
    expect(onRetrySkeleton).toHaveBeenCalledWith('seg-x');
  });

  it('未提供 onRetrySkeleton 时 failed 骨架不渲染重试按钮', () => {
    const html = renderToStaticMarkup(
      <AICardList
        cards={[]}
        onToggleEnabled={() => undefined}
        onDeleteCard={() => undefined}
        onEditCard={() => undefined}
        skeletons={[{ segmentId: 'seg-x', title: '失败段', status: 'failed' }]}
      />,
    );

    expect(html).toContain('生成失败');
    expect(html).not.toContain('aria-label="重试生成 失败段"');
  });

  it('image 卡渲染启用的「转为动画卡」项', () => {
    const card: AICard = {
      id: 'c1', segmentId: 's1', type: 'image', title: '图卡',
      content: { mediaType: 'image', assetPath: null, aspectRatio: '16:9', prompt: 'p', providerId: null, model: null, generationStatus: 'idle' },
      startMs: 0, endMs: 1000, displayDurationMs: 1000, displayMode: 'fullscreen',
      template: 'image', enabled: true, style: {} as never, renderMode: 'legacy',
    };
    const tree = AICardList({ cards: [card], onToggleEnabled: () => {}, onDeleteCard: () => {}, onEditCard: () => {} }) as ReactElement;
    const item = findElement(tree, (el) => typeof el.props?.children === 'string' && (el.props.children as string).includes('转为动画卡'));
    expect(item).not.toBeNull();
    expect(item!.props.disabled).toBe(false);
  });

  it('motion 卡的「转为动画卡」项被禁用', () => {
    const card: AICard = {
      id: 'c2', segmentId: 's2', type: 'motion', title: '动卡', content: 'x',
      startMs: 0, endMs: 1000, displayDurationMs: 1000, displayMode: 'fullscreen',
      template: 'motion', enabled: true, style: {} as never, renderMode: 'motion-card',
    };
    const tree = AICardList({ cards: [card], onToggleEnabled: () => {}, onDeleteCard: () => {}, onEditCard: () => {} }) as ReactElement;
    const item = findElement(tree, (el) => typeof el.props?.children === 'string' && (el.props.children as string).includes('转为动画卡'));
    expect(item).not.toBeNull();
    expect(item!.props.disabled).toBe(true);
  });

  it('Agent Composite 卡优先显示真实执行策略，不伪装成普通 Motion 载体', () => {
    const card: AICard = {
      id: 'composite-1', segmentId: 'seg-composite', type: 'motion', title: '素材与数据合成', content: '组合内容',
      startMs: 0, endMs: 4_000, displayDurationMs: 4_000, displayMode: 'fullscreen',
      template: 'motion', enabled: true, style: {} as never, renderMode: 'motion-card',
      renderStrategy: 'agent-composite',
      assetBindings: [],
      motionCard: {
        compiledAt: 1,
        prompt: '',
        retryCount: 0,
        storyboard: {
          claim: '组合镜头', carrier: 'concept', scene: '',
          beats: [{ cue: null, kind: 'build', adds: '' }],
        },
      },
    };
    const html = renderToStaticMarkup(
      <AICardList
        cards={[card]}
        onToggleEnabled={() => undefined}
        onDeleteCard={() => undefined}
        onEditCard={() => undefined}
      />,
    );

    expect(html).toContain('data-ai-card-render-strategy="agent-composite"');
    expect(html).toContain('data-ai-card-thumbnail="agent-composite"');
    expect(html).toContain('Agent Composite');
    expect(html).toContain('0 项合成素材');
    expect(html).not.toContain('>概念<');
  });
});
