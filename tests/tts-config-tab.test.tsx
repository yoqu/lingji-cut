import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TTSConfigTab } from '../src/components/settings/TTSConfigTab';
import { ToastProvider } from '../src/ui';

// TTSConfigTab 使用 loadAISettings/saveAISettings（异步），在 SSR 时初始值来自 useState 默认值
vi.mock('../src/store/ai', () => ({
  loadAISettings: () => Promise.resolve(null),
  saveAISettings: vi.fn(),
}));

describe('TTSConfigTab', () => {
  it('renders the multi-provider / voice-clone TTS configuration UI', () => {
    const html = renderToStaticMarkup(
      <ToastProvider><TTSConfigTab /></ToastProvider>,
    );

    // 页面标题
    expect(html).toContain('口播合成配置');

    // 多生成服务区块：服务列表与默认服务选择器
    expect(html).toContain('口播生成服务');
    expect(html).toContain('默认口播生成服务');

    // 音色库区块：音色列表与默认音色选择器
    expect(html).toContain('音色库');
    expect(html).toContain('默认音色');

    // 空状态文案（初始 SSR 无生成服务 / 音色）
    expect(html).toContain('暂无口播生成服务');
    expect(html).toContain('暂无音色');

    // MiMo 智能语气打标开关
    expect(html).toContain('MiMo 智能语气打标');

    // 保存按钮
    expect(html).toContain('保存口播配置');
  });
});
