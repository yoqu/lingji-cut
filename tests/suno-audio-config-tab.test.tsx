import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SunoAudioConfigTab, validateSunoAudioConfig } from '../src/components/settings/SunoAudioConfigTab';
import { normalizeSunoAudioSettings } from '../src/lib/audio-gen/settings';
import { ToastProvider } from '../src/ui';

describe('SunoAudioConfigTab', () => {
  it('在系统设置中提供完整的 SunoAPI.org 配置入口', () => {
    const html = renderToStaticMarkup(
      <ToastProvider><SunoAudioConfigTab /></ToastProvider>,
    );
    expect(html).toContain('BGM 与音效');
    expect(html).toContain('SunoAPI.org');
    expect(html).toContain('API Key');
    expect(html).toContain('Callback URL');
    expect(html).toContain('V5（稳定默认）');
    expect(html).toContain('轮询间隔');
    expect(html).toContain('任务超时');
    expect(html).toContain('测试连接并查询积分');
    expect(html).toContain('测试完整生成链路');
  });

  it('启用后要求 API Key 和合法服务地址', () => {
    const base = normalizeSunoAudioSettings({ enabled: true, apiKey: '' });
    expect(validateSunoAudioConfig(base)).toContain('API Key');
    expect(validateSunoAudioConfig({ ...base, apiKey: 'key', baseUrl: 'not-a-url' })).toContain('Base URL');
    const valid = normalizeSunoAudioSettings({ ...base, apiKey: 'key' });
    expect(valid.callbackUrl).toContain('lingji.qushenma.com');
    expect(validateSunoAudioConfig(valid)).toBeNull();
  });

  it('注册独立设置标签且不在 AI 基础配置中重复展示', () => {
    const settings = readFileSync(new URL('../src/pages/Settings.tsx', import.meta.url), 'utf8');
    const aiConfig = readFileSync(new URL('../src/components/settings/AIConfigTab.tsx', import.meta.url), 'utf8');
    const preload = readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');
    expect(settings).toContain("'audio-generation'");
    expect(settings).toContain("label: 'BGM 与音效'");
    expect(settings).toContain('<SunoAudioConfigTab');
    expect(aiConfig).not.toContain('SunoAPI.org');
    expect(preload).toContain("ipcRenderer.invoke('audio-generation:smoke-test')");
  });
});
