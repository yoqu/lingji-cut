// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublishHub } from '../src/pages/PublishHub';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/store/ai', () => {
  const state = { setGlobalBinding: async () => undefined };
  return {
    loadAISettings: async () => null,
    useAIStore: (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
  };
});

vi.mock('../src/store/task-progress', () => ({
  useTaskProgressStore: Object.assign(() => ({}), {
    getState: () => ({
      startTask: () => undefined,
      updateTask: () => undefined,
      completeTask: () => undefined,
      failTask: () => undefined,
    }),
  }),
}));

describe('PublishHub 列表', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    (window as unknown as { publishAPI: unknown }).publishAPI = {
      listHubJobs: vi.fn(async () => [
        {
          workDir: '/tmp/demo-ep',
          title: '高阶智驾还能不能卖',
          thumbnail: '',
          updatedAt: Date.now(),
          lastPublishedAt: Date.now(),
          publishedPlatforms: { douyin: Date.now() },
        },
      ]),
      addHubJob: vi.fn(),
      removeHubJob: vi.fn(async () => []),
      loadHubJob: vi.fn(),
      saveHubJob: vi.fn(),
      startIngest: vi.fn(),
      cancelIngest: vi.fn(),
      onIngestProgress: () => () => undefined,
      onIngestEvent: () => () => undefined,
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      selectProjectDirectory: vi.fn(),
      openPath: vi.fn(),
      regenerateCoverPrompt: vi.fn(),
      generatePublishMetadata: vi.fn(),
      recommendBilibiliPartition: vi.fn(),
      generateCoverImages: vi.fn(),
      scanCoverImages: vi.fn(async () => []),
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('空态引导打开工作目录', async () => {
    (window as unknown as { publishAPI: { listHubJobs: () => Promise<unknown[]> } }).publishAPI.listHubJobs = vi.fn(async () => []);
    await act(async () => {
      root.render(<PublishHub onBack={() => undefined} />);
    });
    await flush();
    expect(container.textContent).toContain('发布中心');
    expect(container.textContent).toContain('打开工作目录');
    expect(container.querySelector('[data-testid="publish-hub-empty"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="ingest-model-selector"]')).toBeTruthy();
    expect(container.textContent).not.toContain('视频主题');
  });

  it('渲染已登记的工作目录', async () => {
    await act(async () => {
      root.render(<PublishHub onBack={() => undefined} />);
    });
    await flush();
    expect(container.textContent).toContain('高阶智驾还能不能卖');
    expect(container.textContent).toContain('抖音');
    expect(container.querySelector('[data-testid="publish-hub-list"]')).toBeTruthy();
  });
});
