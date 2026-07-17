import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AIConfigTab } from '../src/components/settings/AIConfigTab';
import { ToastProvider } from '../src/ui';

describe('AIConfigTab', () => {
  it('moves thinking mode switch out of the global section into per-provider dialog', () => {
    const html = renderToStaticMarkup(
      <ToastProvider><AIConfigTab /></ToastProvider>,
    );
    expect(html).toContain('AI 基础配置');
    // 顶层不再出现思考模式开关（已下沉到 ProviderDialog）
    expect(html).not.toContain('开启思考模式');

    const providerSource = readFileSync(
      new URL('../src/components/settings/ProviderListSection.tsx', import.meta.url),
      'utf8',
    );
    expect(providerSource).toContain('开启思考模式');
    expect(providerSource).toContain("'lmstudio'");
  });
});
