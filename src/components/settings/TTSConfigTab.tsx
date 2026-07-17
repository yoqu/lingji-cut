import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadAISettings, saveAISettings } from '../../store/ai';
import { Divider, Field, SaveButton, Select, SettingsPageHeader, Switch, useToast } from '../../ui';
import type { SelectOption } from '../../ui';
import type { AISettings, TTSProvider, TTSVoicePreset } from '../../types/ai';
import { normalizeTTSSettings } from '../../lib/tts-settings';
import { hasUnsavedAIConfigChanges } from './ai-config-utils';
import { TTSProviderListSection } from './TTSProviderListSection';
import { TTSVoiceListSection } from './TTSVoiceListSection';
import { useSettingsTabGuard } from './useSettingsTabGuard';
import styles from './SettingsCommon.module.css';

interface TTSConfigTabProps {
  onRegisterLeaveGuard?: (guard: (() => Promise<boolean>) | null) => void;
  confirmLeave?: (title: string) => Promise<boolean>;
}

function createSnapshot(input: {
  providers: TTSProvider[];
  defaultProviderId: string | null;
  voices: TTSVoicePreset[];
  defaultVoiceId: string | null;
  ttsMimoAutoAnnotate: boolean;
}): string {
  return JSON.stringify(input);
}

function buildFallbackSettings(): AISettings {
  return {
    llmProviders: [],
    defaultProviderId: null,
    defaultModel: null,
    minimaxApiKey: '',
    minimaxVoiceId: 'male-qn-qingse',
    minimaxSpeed: 1,
    minimaxVol: 1,
    minimaxPitch: 0,
    minimaxEmotion: '',
    minimaxModel: 'speech-2.8-hd',
    ttsProviders: [],
    defaultTtsProviderId: null,
    defaultTtsVoiceId: null,
    ttsVoices: [],
    imageProviders: [],
    defaultImageProviderId: null,
    defaultImageModel: null,
    videoProviders: [],
    defaultVideoProviderId: null,
    defaultVideoModel: null,
    promptBindings: {},
  };
}

export function TTSConfigTab({ onRegisterLeaveGuard, confirmLeave }: TTSConfigTabProps) {
  const { showToast } = useToast();
  const [providers, setProviders] = useState<TTSProvider[]>([]);
  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(null);
  const [voices, setVoices] = useState<TTSVoicePreset[]>([]);
  const [defaultVoiceId, setDefaultVoiceId] = useState<string | null>(null);
  const [ttsMimoAutoAnnotate, setTtsMimoAutoAnnotate] = useState<boolean>(true);
  const [saved, setSaved] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [lastSavedSnapshot, setLastSavedSnapshot] = useState('');
  const saveFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void loadAISettings().then((settings) => {
      const normalized = normalizeTTSSettings(settings ?? buildFallbackSettings());
      const annotate = settings?.ttsMimoAutoAnnotate ?? true;
      setProviders(normalized.ttsProviders);
      setDefaultProviderId(normalized.defaultTtsProviderId);
      setVoices(normalized.ttsVoices);
      setDefaultVoiceId(normalized.defaultTtsVoiceId);
      setTtsMimoAutoAnnotate(annotate);
      setLastSavedSnapshot(
        createSnapshot({
          providers: normalized.ttsProviders,
          defaultProviderId: normalized.defaultTtsProviderId,
          voices: normalized.ttsVoices,
          defaultVoiceId: normalized.defaultTtsVoiceId,
          ttsMimoAutoAnnotate: annotate,
        }),
      );
      setHasLoaded(true);
    });
  }, []);

  useEffect(
    () => () => {
      if (saveFeedbackTimerRef.current) {
        clearTimeout(saveFeedbackTimerRef.current);
      }
    },
    [],
  );

  const currentSnapshot = useMemo(
    () =>
      createSnapshot({
        providers,
        defaultProviderId,
        voices,
        defaultVoiceId,
        ttsMimoAutoAnnotate,
      }),
    [providers, defaultProviderId, voices, defaultVoiceId, ttsMimoAutoAnnotate],
  );

  const hasUnsavedChanges =
    hasLoaded && hasUnsavedAIConfigChanges(lastSavedSnapshot, currentSnapshot);

  useEffect(() => {
    if (hasUnsavedChanges && saved) {
      setSaved(false);
    }
  }, [hasUnsavedChanges, saved]);

  const defaultProviderOptions = useMemo<SelectOption[]>(
    () => [
      { value: '', label: '未选择' },
      ...providers.map((provider) => ({ value: provider.id, label: provider.name })),
    ],
    [providers],
  );

  const defaultVoiceOptions = useMemo<SelectOption[]>(
    () => [
      { value: '', label: '未选择' },
      ...voices.map((voice) => ({ value: voice.id, label: voice.name })),
    ],
    [voices],
  );

  const handleProvidersChange = useCallback(
    (nextProviders: TTSProvider[], nextDefaultId: string | null) => {
      setProviders(nextProviders);
      setDefaultProviderId(nextDefaultId);
      setVoices((currentVoices) =>
        currentVoices.filter((voice) =>
          nextProviders.some((provider) => provider.id === voice.providerId),
        ),
      );
      setDefaultVoiceId((currentDefaultVoiceId) => {
        if (
          currentDefaultVoiceId &&
          voices.some(
            (voice) =>
              voice.id === currentDefaultVoiceId &&
              nextProviders.some((provider) => provider.id === voice.providerId),
          )
        ) {
          return currentDefaultVoiceId;
        }
        return null;
      });
    },
    [voices],
  );

  const handleVoicesChange = useCallback(
    (nextVoices: TTSVoicePreset[], nextDefaultVoiceId: string | null) => {
      setVoices(nextVoices);
      setDefaultVoiceId(nextDefaultVoiceId);
    },
    [],
  );

  const handleSave = useCallback(async () => {
    try {
      const current = await loadAISettings();
      const normalized = normalizeTTSSettings({
        ...(current ?? buildFallbackSettings()),
        ttsProviders: providers,
        defaultTtsProviderId: defaultProviderId,
        ttsVoices: voices,
        defaultTtsVoiceId: defaultVoiceId,
      });
      const defaultProvider = normalized.ttsProviders.find(
        (provider) => provider.id === normalized.defaultTtsProviderId,
      );
      const defaultVoice = normalized.ttsVoices.find(
        (voice) => voice.id === normalized.defaultTtsVoiceId,
      );
      await saveAISettings({
        ...normalized,
        ttsMimoAutoAnnotate,
        minimaxApiKey:
          defaultProvider?.type === 'minimax'
            ? defaultProvider.apiKey
            : normalized.minimaxApiKey,
        minimaxModel:
          defaultProvider?.type === 'minimax'
            ? defaultVoice?.model ?? defaultProvider.models[0] ?? normalized.minimaxModel
            : normalized.minimaxModel,
        minimaxVoiceId:
          defaultProvider?.type === 'minimax'
            ? defaultVoice?.voiceId ?? normalized.minimaxVoiceId
            : normalized.minimaxVoiceId,
        minimaxSpeed:
          defaultProvider?.type === 'minimax'
            ? defaultVoice?.params.speed ?? normalized.minimaxSpeed
            : normalized.minimaxSpeed,
        minimaxVol:
          defaultProvider?.type === 'minimax'
            ? defaultVoice?.params.vol ?? normalized.minimaxVol
            : normalized.minimaxVol,
        minimaxPitch:
          defaultProvider?.type === 'minimax'
            ? defaultVoice?.params.pitch ?? normalized.minimaxPitch
            : normalized.minimaxPitch,
        minimaxEmotion:
          defaultProvider?.type === 'minimax'
            ? defaultVoice?.params.emotion ?? normalized.minimaxEmotion
            : normalized.minimaxEmotion,
      });
      setProviders(normalized.ttsProviders);
      setDefaultProviderId(normalized.defaultTtsProviderId);
      setVoices(normalized.ttsVoices);
      setDefaultVoiceId(normalized.defaultTtsVoiceId);
      setLastSavedSnapshot(
        createSnapshot({
          providers: normalized.ttsProviders,
          defaultProviderId: normalized.defaultTtsProviderId,
          voices: normalized.ttsVoices,
          defaultVoiceId: normalized.defaultTtsVoiceId,
          ttsMimoAutoAnnotate,
        }),
      );
      setSaved(true);
      if (saveFeedbackTimerRef.current) {
        clearTimeout(saveFeedbackTimerRef.current);
      }
      saveFeedbackTimerRef.current = setTimeout(() => setSaved(false), 2000);
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : '请稍后重试。', {
        title: '保存语音配置失败',
        type: 'error',
        duration: 5000,
      });
      return false;
    }
  }, [defaultProviderId, defaultVoiceId, providers, showToast, ttsMimoAutoAnnotate, voices]);

  useSettingsTabGuard({
    title: '口播配置',
    hasUnsavedChanges,
    onSave: handleSave,
    onRegisterLeaveGuard,
    confirmLeave,
  });

  return (
    <>
      <SettingsPageHeader
        title="口播合成配置"
        description="配置多个口播生成服务，并保存系统音色或本地参考音频克隆音色"
      />

      <div className={styles.formStack}>
        <Field label="口播生成服务">
          <TTSProviderListSection
            providers={providers}
            defaultProviderId={defaultProviderId}
            onChange={handleProvidersChange}
          />
        </Field>

        <Field label="默认口播生成服务">
          <Select
            value={defaultProviderId ?? ''}
            options={defaultProviderOptions}
            onChange={(event) => setDefaultProviderId(event.target.value || null)}
          />
        </Field>

        <Divider label="音色库" />

        <Field label="音色">
          <TTSVoiceListSection
            providers={providers}
            voices={voices}
            defaultVoiceId={defaultVoiceId}
            onChange={handleVoicesChange}
          />
        </Field>

        <Field label="默认音色">
          <Select
            value={defaultVoiceId ?? ''}
            options={defaultVoiceOptions}
            onChange={(event) => setDefaultVoiceId(event.target.value || null)}
          />
        </Field>

        <Divider label="MiMo 智能语气打标" />

        <Field
          label="MiMo 智能语气打标"
          hint="开启后，MiMo TTS 合成前会自动对文本添加语气标注（annotation），以提升朗读自然度；关闭则直接合成原始文本。"
        >
          <Switch
            checked={ttsMimoAutoAnnotate}
            onChange={(checked) => setTtsMimoAutoAnnotate(checked)}
            label={ttsMimoAutoAnnotate ? '已开启' : '已关闭'}
          />
        </Field>
      </div>

      <SaveButton
        onClick={() => {
          void handleSave();
        }}
        saved={saved}
        disabled={!hasLoaded || !hasUnsavedChanges}
        defaultLabel="保存口播配置"
        className={styles.saveButton}
      />
    </>
  );
}
