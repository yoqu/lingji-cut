// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KacutConnectSection } from '../src/components/settings/KacutConnectSection';
import { MotionProvider } from '../src/ui/lib/motion';
import type { KacutSettings } from '../src/types/ai';
import type { KacutLibraryDigest } from '../src/types/footage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const DIGEST: KacutLibraryDigest = {
  libraryCount: 3,
  itemCount: 1234,
  indexedItemCount: 1234,
  kindCounts: { video: 800, image: 400 },
  topSceneTags: [],
  libraries: [],
};

function stubElectronAPI(overrides: Record<string, unknown> = {}) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    kacutHealth: vi.fn(async () => true),
    kacutLibraryDigest: vi.fn(async () => DIGEST),
    ...overrides,
  };
}

function kacut(patch: Partial<KacutSettings> = {}): KacutSettings {
  return { enabled: false, baseUrl: 'http://127.0.0.1:8765/mcp', ...patch };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(ui: React.ReactElement) {
  act(() => root.render(<MotionProvider>{ui}</MotionProvider>));
}

describe('KacutConnectSection', () => {
  it('开启开关时先通过健康检查，再原子保存地址与 enabled', async () => {
    stubElectronAPI();
    const onSave = vi.fn(async () => undefined);
    render(<KacutConnectSection kacut={kacut()} onSave={onSave} />);

    const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.checked).toBe(false);
    const urlInput = container.querySelector<HTMLInputElement>('input[aria-label="灵机素材服务地址"]')!;
    expect(urlInput.value).toBe('http://127.0.0.1:8765/mcp');

    await act(async () => toggle.click());
    expect(onSave).toHaveBeenCalledWith({ enabled: true, baseUrl: 'http://127.0.0.1:8765/mcp' });
    expect(window.electronAPI.kacutHealth).toHaveBeenCalledWith('http://127.0.0.1:8765/mcp');
  });

  it('baseUrl 失焦时按 trim 后的值保存，未编辑失焦不保存', async () => {
    stubElectronAPI();
    const onSave = vi.fn(async () => undefined);
    render(<KacutConnectSection kacut={kacut()} onSave={onSave} />);
    const urlInput = container.querySelector<HTMLInputElement>('input[aria-label="灵机素材服务地址"]')!;

    // 未编辑直接失焦：值与已存配置一致，不触发保存
    await act(async () => {
      urlInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onSave).not.toHaveBeenCalled();

    await act(async () => {
      setInputValue(urlInput, '  http://127.0.0.1:9999  ');
      urlInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onSave).toHaveBeenCalledWith({ enabled: false, baseUrl: 'http://127.0.0.1:9999/mcp' });
  });

  it('粘贴标准 mcpServers JSON 时提取并保存带 token 的 endpoint', async () => {
    const tokenEndpoint = 'http://127.0.0.1:8765/mcp?token=test-access-token';
    const config = JSON.stringify({
      mcpServers: { 'lingji-material': { url: tokenEndpoint } },
    });
    const health = vi.fn(async () => true);
    stubElectronAPI({ kacutHealth: health });
    const onSave = vi.fn(async () => undefined);
    render(<KacutConnectSection kacut={kacut()} onSave={onSave} />);
    const urlInput = container.querySelector<HTMLInputElement>('input[aria-label="灵机素材服务地址"]')!;
    const testButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('测试连接'))!;

    await act(async () => setInputValue(urlInput, config));
    await act(async () => testButton.click());

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ enabled: true, baseUrl: tokenEndpoint });
    expect(health).toHaveBeenCalledWith(tokenEndpoint);
    expect(container.querySelector('[data-testid="kacut-status"]')?.textContent).toContain('已连接并启用');
  });

  it('测试连接成功：自动启用素材联动并显示素材库摘要', async () => {
    stubElectronAPI();
    const onSave = vi.fn(async () => undefined);
    render(<KacutConnectSection kacut={kacut()} onSave={onSave} />);
    const testButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('测试连接'))!;

    await act(async () => testButton.click());

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ enabled: true, baseUrl: 'http://127.0.0.1:8765/mcp' });
    const status = container.querySelector('[data-testid="kacut-status"]')!;
    expect(status.textContent).toContain('已连接并启用');
    expect(status.textContent).toContain('3 个库');
    expect(status.textContent).toContain('条素材');
    expect(status.textContent).toContain('视频 800');
    expect(status.textContent).toContain('图片 400');
  });

  it('点击测试连接不会先触发一个 enabled=false 的失焦保存', async () => {
    stubElectronAPI();
    const onSave = vi.fn(async () => undefined);
    render(<KacutConnectSection kacut={kacut()} onSave={onSave} />);
    const urlInput = container.querySelector<HTMLInputElement>('input[aria-label="灵机素材服务地址"]')!;
    const testButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('测试连接'))!;

    await act(async () => {
      setInputValue(urlInput, 'http://127.0.0.1:9999');
      urlInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: testButton }));
      testButton.click();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ enabled: true, baseUrl: 'http://127.0.0.1:9999/mcp' });
  });

  it('配置保存失败时不能显示已连接并启用', async () => {
    stubElectronAPI();
    const onSave = vi.fn(async () => { throw new Error('保存失败'); });
    render(<KacutConnectSection kacut={kacut()} onSave={onSave} />);
    const testButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('测试连接'))!;

    await act(async () => testButton.click());

    const status = container.querySelector('[data-testid="kacut-status"]')!;
    expect(status.textContent).toContain('未连接');
    expect(status.textContent).not.toContain('已连接并启用');
  });

  it('测试连接失败：显示未连接与灵机素材 App 引导文案', async () => {
    stubElectronAPI({ kacutHealth: vi.fn(async () => false) });
    const onSave = vi.fn(async () => undefined);
    render(<KacutConnectSection kacut={kacut({ enabled: true })} onSave={onSave} />);
    const testButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('测试连接'))!;

    await act(async () => testButton.click());

    const status = container.querySelector('[data-testid="kacut-status"]')!;
    expect(status.textContent).toContain('未连接');
    expect(status.textContent).toContain('灵机素材 App');
    expect(status.textContent).toContain('访问 Token');
    expect(onSave).not.toHaveBeenCalled();
  });
});
