import { describe, expect, it } from 'vitest';
import { PI_PROVIDER_PRESETS } from '../src/lib/llm/pi-provider-presets';

const EXPECTED_MODELS: Record<string, string[]> = {
  openai: ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-mini'],
  anthropic: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-fable-5'],
  gemini: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro'],
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  minimax: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
  openrouter: [
    'anthropic/claude-sonnet-4.6',
    'anthropic/claude-opus-4.8',
    'openai/gpt-5.5',
    'openai/gpt-5.5-pro',
    'google/gemini-3.1-pro-preview',
    'moonshotai/kimi-k2.7-code',
    'z-ai/glm-5.2',
    'openrouter/auto',
  ],
  xai: ['grok-4.3', 'grok-4.20-0309-reasoning', 'grok-build-0.1', 'grok-code-fast-1'],
  zai: ['glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7'],
  'zai-coding-cn': ['glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7'],
  moonshotai: ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k2-thinking'],
  'moonshotai-cn': ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k2-thinking'],
  kimi: ['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed'],
};

describe('pi provider presets', () => {
  it('tracks current pi built-in provider model ids', () => {
    for (const [id, models] of Object.entries(EXPECTED_MODELS)) {
      expect(PI_PROVIDER_PRESETS.find((preset) => preset.id === id)?.models).toEqual(models);
    }
  });

  it('does not reintroduce removed legacy defaults', () => {
    const allModels = PI_PROVIDER_PRESETS.flatMap((preset) => preset.models);
    expect(allModels).not.toContain('deepseek-chat');
    expect(allModels).not.toContain('deepseek-reasoner');
    expect(allModels).not.toContain('MiniMax-M2');
    expect(allModels).not.toContain('kimi-k2-0905-preview');
    expect(allModels).toContain('gpt-5.5');
  });

  it('uses the official Kimi Coding OpenAI-compatible endpoint', () => {
    expect(PI_PROVIDER_PRESETS.find((preset) => preset.id === 'kimi')?.baseUrl).toBe(
      'https://api.kimi.com/coding/v1',
    );
  });
});
