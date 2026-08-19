// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AISettings, LLMProvider } from '../src/types/ai';
import { IngestModelSelector } from '../src/components/publish/IngestModelSelector';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const llmA: LLMProvider = {
  id: 'A',
  name: '服务A',
  type: 'openai_compatible',
  baseUrl: 'https://a.example/v1',
  apiKey: 'k',
  models: ['fast', 'slow'],
};

const settingsFixture = (bindings: AISettings['promptBindings'] = {}): AISettings => ({
  llmProviders: [llmA],
  defaultProviderId: 'A',
  defaultModel: 'fast',
  promptBindings: bindings,
} as AISettings);

const mocks = vi.hoisted(() => ({
  loadAISettings: vi.fn(async (): Promise<AISettings | null> => null),
  setGlobalBinding: vi.fn(async () => undefined),
}));

vi.mock('../src/store/ai', () => ({
  loadAISettings: mocks.loadAISettings,
  useAIStore: (selector?: (s: { setGlobalBinding: typeof mocks.setGlobalBinding }) => unknown) => {
    const state = { setGlobalBinding: mocks.setGlobalBinding };
    return selector ? selector(state) : state;
  },
}));

describe('IngestModelSelector', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.loadAISettings.mockReset();
    mocks.loadAISettings.mockResolvedValue(settingsFixture());
    mocks.setGlobalBinding.mockReset();
    mocks.setGlobalBinding.mockResolvedValue(undefined);
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

  it('未绑定时显示全局默认模型', async () => {
    await act(async () => {
      root.render(<IngestModelSelector />);
    });
    await flush();
    expect(container.textContent).toContain('默认 · 服务A / fast');
  });

  it('已绑定 publish.metadata 时显示识别模型', async () => {
    mocks.loadAISettings.mockResolvedValue(settingsFixture({
      'publish.metadata': { providerId: 'A', model: 'slow' },
    }));
    await act(async () => {
      root.render(<IngestModelSelector />);
    });
    await flush();
    expect(container.textContent).toContain('识别 · 服务A / slow');
  });
});
