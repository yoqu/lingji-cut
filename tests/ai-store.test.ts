import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAISettings, saveAISettings, useAIStore } from '../src/store/ai';

function stubElectronSettings(aiSettings: Record<string, unknown>) {
  const loadGlobalSettings = vi.fn().mockResolvedValue(JSON.stringify({ aiSettings }));
  const saveGlobalSettings = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('window', { electronAPI: { loadGlobalSettings, saveGlobalSettings } });
  return { loadGlobalSettings, saveGlobalSettings };
}

describe('AI settings store helpers', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
    useAIStore.getState().resetWorkflow();
  });

  it('defaults enableThinking to true when loading settings without the field', async () => {
    stubElectronSettings({
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'sk-test',
      llmModel: 'gpt-4o',
    });

    const loaded = await loadAISettings();
    expect(loaded).toMatchObject({
      enableThinking: true,
      minimaxApiKey: '',
      minimaxVoiceId: 'male-qn-qingse',
      minimaxSpeed: 1.0,
      imageProviders: [],
      defaultImageProviderId: null,
    });
  });

  it('keeps explicitly configured enableThinking and minimax settings', async () => {
    stubElectronSettings({
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'sk-test',
      llmModel: 'gpt-4o',
      enableThinking: false,
      minimaxApiKey: 'mm-key',
      minimaxVoiceId: 'female-yujie',
      minimaxSpeed: 1.25,
    });

    await expect(loadAISettings()).resolves.toMatchObject({
      enableThinking: false,
      minimaxApiKey: 'mm-key',
      minimaxVoiceId: 'female-yujie',
      minimaxSpeed: 1.25,
    });
  });

  it('merges aiSettings into existing global settings instead of overwriting other sections', async () => {
    const loadGlobalSettings = vi.fn().mockResolvedValue(
      JSON.stringify({
        selectedRole: 'deep-insight-podcast',
      }),
    );
    const saveGlobalSettings = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal('window', {
      electronAPI: {
        loadGlobalSettings,
        saveGlobalSettings,
      },
    });

    await saveAISettings({
      llmProviders: [],
      defaultProviderId: null,
      defaultModel: null,
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'sk-test',
      llmModel: 'gpt-4o',
      minimaxApiKey: '',
      minimaxVoiceId: 'male-qn-qingse',
      minimaxSpeed: 1.0,
    });

    expect(loadGlobalSettings).toHaveBeenCalledTimes(1);
    expect(saveGlobalSettings).toHaveBeenCalledTimes(1);

    const savedPayload = JSON.parse(saveGlobalSettings.mock.calls[0][0] as string);
    expect(savedPayload.selectedRole).toBe('deep-insight-podcast');
    expect(savedPayload.aiSettings.llmApiKey).toBe('sk-test');
  });

  it('supports workflow updates and reset', () => {
    useAIStore.getState().setWorkflow({
      step: 'tts_generating',
      progress: 42,
      stepLabel: '正在生成语音…',
      canCancel: true,
    });

    expect(useAIStore.getState().workflow).toMatchObject({
      step: 'tts_generating',
      progress: 42,
      stepLabel: '正在生成语音…',
      canCancel: true,
      error: null,
    });

    useAIStore.getState().resetWorkflow();

    expect(useAIStore.getState().workflow).toEqual({
      step: 'idle',
      progress: 0,
      stepLabel: '',
      error: null,
      canCancel: false,
      failedStep: null,
    });
  });

  it('clearing analysis error does not cancel an in-flight analyze state', () => {
    useAIStore.getState().setAnalyzing(true);
    useAIStore.getState().setAnalysisError(null);

    expect(useAIStore.getState().isAnalyzing).toBe(true);
    expect(useAIStore.getState().analysisError).toBeNull();
  });
});
