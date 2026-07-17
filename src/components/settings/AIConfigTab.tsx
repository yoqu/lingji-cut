import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadAISettings, saveAISettings } from '../../store/ai';
import { Field, Divider, Select, SaveButton, SettingsPageHeader, Textarea, useToast } from '../../ui';
import type { SelectOption } from '../../ui';
import type { ImageProvider, LLMProvider, VideoProvider } from '../../types/ai';
import { ProviderListSection } from './ProviderListSection';
import { ImageProviderListSection } from './ImageProviderListSection';
import { VideoProviderListSection } from './VideoProviderListSection';
import {
  createAIConfigSnapshot,
  hasUnsavedAIConfigChanges,
  normalizeProviderDrafts,
  normalizeProviderSelection,
} from './ai-config-utils';
import { useSettingsTabGuard } from './useSettingsTabGuard';
import styles from './SettingsCommon.module.css';

interface AIConfigTabProps {
  onRegisterLeaveGuard?: (guard: (() => Promise<boolean>) | null) => void;
  confirmLeave?: (title: string) => Promise<boolean>;
}

export function AIConfigTab({ onRegisterLeaveGuard, confirmLeave }: AIConfigTabProps) {
  const { showToast } = useToast();
  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(null);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  // 新：图像 Provider
  const [imageProviders, setImageProviders] = useState<ImageProvider[]>([]);
  const [defaultImageProviderId, setDefaultImageProviderId] = useState<string | null>(null);
  const [defaultImageModel, setDefaultImageModel] = useState<string | null>(null);
  const [globalCoverImagePrompt, setGlobalCoverImagePrompt] = useState('');
  // 新：视频 Provider
  const [videoProviders, setVideoProviders] = useState<VideoProvider[]>([]);
  const [defaultVideoProviderId, setDefaultVideoProviderId] = useState<string | null>(null);
  const [defaultVideoModel, setDefaultVideoModel] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [lastSavedSnapshot, setLastSavedSnapshot] = useState('');
  const saveFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void loadAISettings().then((settings) => {
      const nextProviders = settings?.llmProviders ?? [];
      const nextImageProviders = settings?.imageProviders ?? [];
      const nextDefaultImageProviderId = settings?.defaultImageProviderId ?? null;
      const nextDefaultImageModel = settings?.defaultImageModel ?? null;
      const nextGlobalCoverImagePrompt = settings?.globalCoverImagePrompt ?? '';
      const nextVideoProviders = settings?.videoProviders ?? [];
      const nextDefaultVideoProviderId = settings?.defaultVideoProviderId ?? null;
      const nextDefaultVideoModel = settings?.defaultVideoModel ?? null;
      const selection = normalizeProviderSelection(
        nextProviders,
        settings?.defaultProviderId ?? null,
        settings?.defaultModel ?? null,
      );

      setProviders(nextProviders);
      setDefaultProviderId(selection.defaultProviderId);
      setDefaultModel(selection.defaultModel);
      setImageProviders(nextImageProviders);
      setDefaultImageProviderId(nextDefaultImageProviderId);
      setDefaultImageModel(nextDefaultImageModel);
      setGlobalCoverImagePrompt(nextGlobalCoverImagePrompt);
      setVideoProviders(nextVideoProviders);
      setDefaultVideoProviderId(nextDefaultVideoProviderId);
      setDefaultVideoModel(nextDefaultVideoModel);
      setLastSavedSnapshot(
        createAIConfigSnapshot({
          providers: nextProviders,
          defaultProviderId: selection.defaultProviderId,
          defaultModel: selection.defaultModel,
          imageProviders: nextImageProviders,
          defaultImageProviderId: nextDefaultImageProviderId,
          defaultImageModel: nextDefaultImageModel,
          globalCoverImagePrompt: nextGlobalCoverImagePrompt,
          videoProviders: nextVideoProviders,
          defaultVideoProviderId: nextDefaultVideoProviderId,
          defaultVideoModel: nextDefaultVideoModel,
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
      createAIConfigSnapshot({
        providers,
        defaultProviderId,
        defaultModel,
        imageProviders,
        defaultImageProviderId,
        defaultImageModel,
        globalCoverImagePrompt,
        videoProviders,
        defaultVideoProviderId,
        defaultVideoModel,
      }),
    [
      providers,
      defaultProviderId,
      defaultModel,
      imageProviders,
      defaultImageProviderId,
      defaultImageModel,
      globalCoverImagePrompt,
      videoProviders,
      defaultVideoProviderId,
      defaultVideoModel,
    ],
  );

  const hasUnsavedChanges =
    hasLoaded && hasUnsavedAIConfigChanges(lastSavedSnapshot, currentSnapshot);

  useEffect(() => {
    if (hasUnsavedChanges && saved) {
      setSaved(false);
    }
  }, [hasUnsavedChanges, saved]);

  const handleSave = useCallback(async () => {
    const normalizedProviders = normalizeProviderDrafts(providers);
    const selection = normalizeProviderSelection(
      normalizedProviders,
      defaultProviderId,
      defaultModel,
    );
    const snapshot = createAIConfigSnapshot({
      providers: normalizedProviders,
      defaultProviderId: selection.defaultProviderId,
      defaultModel: selection.defaultModel,
      imageProviders,
      defaultImageProviderId,
      defaultImageModel,
      globalCoverImagePrompt,
      videoProviders,
      defaultVideoProviderId,
      defaultVideoModel,
    });

    try {
      const current = await loadAISettings();
      await saveAISettings({
        ...(current ?? {
          minimaxApiKey: '',
          minimaxVoiceId: 'male-qn-qingse',
          minimaxSpeed: 1.0,
          ttsProviders: [],
          defaultTtsProviderId: null,
          defaultTtsVoiceId: null,
          ttsVoices: [],
          imageProviders: [],
          defaultImageProviderId: null,
          defaultImageModel: null,
          globalCoverImagePrompt: '',
          videoProviders: [],
          defaultVideoProviderId: null,
          defaultVideoModel: null,
          promptBindings: {},
        }),
        llmProviders: normalizedProviders,
        defaultProviderId: selection.defaultProviderId,
        defaultModel: selection.defaultModel,
        imageProviders,
        defaultImageProviderId,
        defaultImageModel,
        globalCoverImagePrompt: globalCoverImagePrompt.trim(),
        videoProviders,
        defaultVideoProviderId,
        defaultVideoModel,
      });

      setProviders(normalizedProviders);
      setDefaultProviderId(selection.defaultProviderId);
      setDefaultModel(selection.defaultModel);
      setLastSavedSnapshot(snapshot);
      setSaved(true);
      if (saveFeedbackTimerRef.current) {
        clearTimeout(saveFeedbackTimerRef.current);
      }
      saveFeedbackTimerRef.current = setTimeout(() => setSaved(false), 2000);
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : '请稍后重试。', {
        title: '保存 AI 配置失败',
        type: 'error',
        duration: 5000,
      });
      return false;
    }
  }, [
    providers,
    defaultProviderId,
    defaultModel,
    imageProviders,
    defaultImageProviderId,
    defaultImageModel,
    globalCoverImagePrompt,
    videoProviders,
    defaultVideoProviderId,
    defaultVideoModel,
    showToast,
  ]);

  useSettingsTabGuard({
    title: 'AI 基础配置',
    hasUnsavedChanges,
    onSave: handleSave,
    onRegisterLeaveGuard,
    confirmLeave,
  });

  const currentDefaultImageProvider = useMemo(
    () => imageProviders.find((p) => p.id === defaultImageProviderId) ?? null,
    [imageProviders, defaultImageProviderId],
  );

  const imageProviderOptions = useMemo<SelectOption[]>(
    () => [
      { value: '', label: '未选择' },
      ...imageProviders.map((p) => ({ value: p.id, label: p.name || '未命名生成服务' })),
    ],
    [imageProviders],
  );

  const imageModelOptions = useMemo<SelectOption[]>(
    () => [
      { value: '', label: '未选择' },
      ...(currentDefaultImageProvider?.models ?? []).map((m) => ({ value: m, label: m })),
    ],
    [currentDefaultImageProvider],
  );

  const handleImageProvidersChange = useCallback(
    (nextProviders: ImageProvider[], nextDefaultId: string | null) => {
      setImageProviders(nextProviders);
      setDefaultImageProviderId(nextDefaultId);
      // 当默认 Provider 变化或当前模型不在新 Provider 中时，自动选首个模型（没有则置空）
      const nextProvider = nextProviders.find((p) => p.id === nextDefaultId) ?? null;
      setDefaultImageModel((prev) => {
        if (!nextProvider) return null;
        if (prev && nextProvider.models.includes(prev)) return prev;
        return nextProvider.models[0] ?? null;
      });
    },
    [],
  );

  const handleDefaultImageProviderChange = useCallback(
    (nextId: string | null) => {
      setDefaultImageProviderId(nextId);
      const nextProvider = imageProviders.find((p) => p.id === nextId) ?? null;
      setDefaultImageModel(nextProvider?.models[0] ?? null);
    },
    [imageProviders],
  );

  // ─── Video Provider 派生与回调 ──────────────────────────────────────────
  const currentDefaultVideoProvider = useMemo(
    () => videoProviders.find((p) => p.id === defaultVideoProviderId) ?? null,
    [videoProviders, defaultVideoProviderId],
  );

  const videoProviderOptions = useMemo<SelectOption[]>(
    () => [
      { value: '', label: '未选择' },
      ...videoProviders.map((p) => ({ value: p.id, label: p.name || '未命名生成服务' })),
    ],
    [videoProviders],
  );

  const videoModelOptions = useMemo<SelectOption[]>(
    () => [
      { value: '', label: '未选择' },
      ...(currentDefaultVideoProvider?.models ?? []).map((m) => ({ value: m, label: m })),
    ],
    [currentDefaultVideoProvider],
  );

  const handleVideoProvidersChange = useCallback(
    (nextProviders: VideoProvider[], nextDefaultId: string | null) => {
      setVideoProviders(nextProviders);
      setDefaultVideoProviderId(nextDefaultId);
      const nextProvider = nextProviders.find((p) => p.id === nextDefaultId) ?? null;
      setDefaultVideoModel((prev) => {
        if (!nextProvider) return null;
        if (prev && nextProvider.models.includes(prev)) return prev;
        return nextProvider.models[0] ?? null;
      });
    },
    [],
  );

  const handleDefaultVideoProviderChange = useCallback(
    (nextId: string | null) => {
      setDefaultVideoProviderId(nextId);
      const nextProvider = videoProviders.find((p) => p.id === nextId) ?? null;
      setDefaultVideoModel(nextProvider?.models[0] ?? null);
    },
    [videoProviders],
  );

  return (
    <>
      <SettingsPageHeader
        title="AI 基础配置"
        description="配置文本、封面图像与视频生成服务"
      />

      <div className={styles.formStack}>
        {/* Provider 列表 */}
        <Field label="文本生成服务">
          <ProviderListSection
            providers={providers}
            defaultProviderId={defaultProviderId}
            onChange={(p, id) => {
              const selection = normalizeProviderSelection(p, id, defaultModel);
              setProviders(p);
              setDefaultProviderId(selection.defaultProviderId);
              setDefaultModel(selection.defaultModel);
            }}
          />
        </Field>

        <Divider label="封面图像生成" />

        <Field label="图片生成服务">
          <ImageProviderListSection
            imageProviders={imageProviders}
            defaultImageProviderId={defaultImageProviderId}
            onChange={handleImageProvidersChange}
          />
        </Field>

        <Field label="默认图片生成服务">
          <Select
            value={defaultImageProviderId ?? ''}
            options={imageProviderOptions}
            onChange={(e) => handleDefaultImageProviderChange(e.target.value || null)}
          />
        </Field>

        <Field label="默认模型">
          <Select
            value={defaultImageModel ?? ''}
            options={imageModelOptions}
            onChange={(e) => setDefaultImageModel(e.target.value || null)}
            disabled={!currentDefaultImageProvider}
          />
        </Field>

        <Field
          label="全局封面图提示词"
          hint="生成封面时将与基于内容生成的提示词拼接后发送给图片生成服务，可用于固定品牌、画质、风格、构图偏好等。"
        >
          <Textarea
            value={globalCoverImagePrompt}
            onChange={(e) => setGlobalCoverImagePrompt(e.target.value)}
            placeholder="例如：写实摄影风格，电影级布光，8K 高清，细腻纹理，禁止水印与 logo"
            rows={4}
            resize="vertical"
          />
        </Field>

        <Divider label="视频生成" />

        <Field label="视频生成服务">
          <VideoProviderListSection
            videoProviders={videoProviders}
            defaultVideoProviderId={defaultVideoProviderId}
            onChange={handleVideoProvidersChange}
          />
        </Field>

        <Field label="默认视频生成服务">
          <Select
            value={defaultVideoProviderId ?? ''}
            options={videoProviderOptions}
            onChange={(e) => handleDefaultVideoProviderChange(e.target.value || null)}
          />
        </Field>

        <Field label="默认模型">
          <Select
            value={defaultVideoModel ?? ''}
            options={videoModelOptions}
            onChange={(e) => setDefaultVideoModel(e.target.value || null)}
            disabled={!currentDefaultVideoProvider}
          />
        </Field>

      </div>

      <SaveButton
        onClick={() => {
          void handleSave();
        }}
        saved={saved}
        disabled={!hasLoaded || !hasUnsavedChanges}
        defaultLabel="保存配置"
        className={styles.saveButton}
      />
    </>
  );
}
