import { describe, expect, it } from 'vitest';
import type { AISettings, LLMProvider, ImageProvider, PromptBindingMap } from '../src/types/ai';
import {
  resolveLlmBinding,
  resolvePromptBinding,
  PromptBindingError,
} from '../src/lib/llm/binding-resolver';

const llmA: LLMProvider = { id: 'A', name: 'A', type: 'openai_compatible', baseUrl: 'a', apiKey: 'k', models: ['m1', 'm2'] };
const llmB: LLMProvider = { id: 'B', name: 'B', type: 'openai_compatible', baseUrl: 'b', apiKey: 'k', models: ['n1'] };
const imgA: ImageProvider = { id: 'IA', name: 'jimeng', type: 'jimeng', baseUrl: 'u', apiKey: 'k', models: ['jimeng-5.0'] };

function settings(): AISettings {
  return {
    llmProviders: [llmA, llmB],
    defaultProviderId: 'A',
    defaultModel: 'm1',
    llmBaseUrl: '',
    llmApiKey: '',
    llmModel: '',
    minimaxApiKey: '',
    minimaxVoiceId: '',
    minimaxSpeed: 1,
    imageProviders: [imgA],
    defaultImageProviderId: 'IA',
    defaultImageModel: 'jimeng-5.0',
    promptBindings: {},
  };
}

describe('resolvePromptBinding', () => {
  it('全部未绑定：回退到 default provider/model', () => {
    const r = resolvePromptBinding('planning.segment', settings(), null);
    expect(r.provider.id).toBe('A');
    expect(r.model).toBe('m1');
  });

  it('未绑定时优先用 Provider 自己的 defaultModel（高于全局 defaultModel）', () => {
    const s = settings();
    s.defaultProviderId = 'B';
    // 全局 defaultModel 'm1' 不在 B 的模型列表里；应回退到 B.defaultModel='n1'
    s.llmProviders = [llmA, { ...llmB, defaultModel: 'n1' }];
    const r = resolvePromptBinding('planning.segment', s, null);
    expect(r.provider.id).toBe('B');
    expect(r.model).toBe('n1');
  });

  it('提示词级绑定的 model 覆盖 Provider.defaultModel', () => {
    const s = settings();
    s.llmProviders = [{ ...llmA, defaultModel: 'm1' }, llmB];
    s.promptBindings['planning.segment'] = { providerId: 'A', model: 'm2' };
    const r = resolvePromptBinding('planning.segment', s, null);
    expect(r.model).toBe('m2');
  });

  it('全局 binding 命中', () => {
    const s = settings();
    s.promptBindings['planning.segment'] = { providerId: 'B', model: 'n1' };
    const r = resolvePromptBinding('planning.segment', s, null);
    expect(r.provider.id).toBe('B');
    expect(r.model).toBe('n1');
  });

  it('project binding 覆盖 global binding', () => {
    const s = settings();
    s.promptBindings['planning.segment'] = { providerId: 'A', model: 'm2' };
    const project: PromptBindingMap = { 'planning.segment': { providerId: 'B', model: 'n1' } };
    const r = resolvePromptBinding('planning.segment', s, project);
    expect(r.provider.id).toBe('B');
    expect(r.model).toBe('n1');
  });

  it('binding.providerId 为 null 视为继承（走 global / default）', () => {
    const s = settings();
    s.promptBindings['planning.segment'] = { providerId: 'B', model: 'n1' };
    const project: PromptBindingMap = { 'planning.segment': { providerId: null, model: null } };
    const r = resolvePromptBinding('planning.segment', s, project);
    expect(r.provider.id).toBe('B'); // 落到 global
  });

  it('cover.regeneration 同时解析 LLM + image 段', () => {
    const s = settings();
    const r = resolvePromptBinding('cover.regeneration', s, null);
    expect(r.provider.id).toBe('A');
    expect(r.imageProvider?.id).toBe('IA');
    expect(r.imageModel).toBe('jimeng-5.0');
  });

  it('resolveLlmBinding 只解析文本模型，不要求 ImageProvider', () => {
    const s = settings();
    s.defaultImageProviderId = null;
    s.defaultImageModel = null;
    s.imageProviders = [];
    s.promptBindings['cover.regeneration'] = { providerId: 'B', model: 'n1' };
    const r = resolveLlmBinding('cover.regeneration', s, null);
    expect(r.provider.id).toBe('B');
    expect(r.model).toBe('n1');
    expect(() => resolvePromptBinding('cover.regeneration', s, null)).toThrowError(PromptBindingError);
  });

  it('provider 已删除：抛 PromptBindingError(PROVIDER_MISSING)', () => {
    const s = settings();
    s.promptBindings['planning.segment'] = { providerId: 'GHOST', model: 'x' };
    expect(() => resolvePromptBinding('planning.segment', s, null))
      .toThrowError(PromptBindingError);
  });

  it('model 不在 provider.models 中：抛 PromptBindingError(MODEL_NOT_IN_PROVIDER)', () => {
    const s = settings();
    s.promptBindings['planning.segment'] = { providerId: 'A', model: 'no-such' };
    try {
      resolvePromptBinding('planning.segment', s, null);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PromptBindingError);
      expect((e as PromptBindingError).code).toBe('MODEL_NOT_IN_PROVIDER');
    }
  });

  it('default provider 未配置且无 binding：抛 PROVIDER_MISSING', () => {
    const s = settings();
    s.defaultProviderId = null;
    s.defaultModel = null;
    expect(() => resolvePromptBinding('planning.segment', s, null))
      .toThrowError(PromptBindingError);
  });
});
