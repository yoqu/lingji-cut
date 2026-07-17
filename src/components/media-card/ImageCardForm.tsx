import { useEffect, useState } from 'react';
import type {
  AICard,
  AICardDisplayMode,
  ImageAspectRatio,
  MediaCardContent,
} from '../../types/ai';
import { Button, Input, Select, Switch, Textarea } from '../../ui';
import { MediaCardPreview } from './MediaCardPreview';
import styles from './ImageCardForm.module.css';

export interface ImageProviderOption {
  id: string;
  name: string;
  models: string[];
}

export interface ImageCardFormProps {
  card: AICard;
  /** 当前进度，0-100，仅在 generating 时有意义 */
  percent?: number;
  /** 解析好的本地预览 src（绝对 file:// 或 https://），仅 ready 时由父组件提供 */
  previewSrc: string | null;
  originalPreviewSrc?: string | null;
  cutoutPreviewSrc?: string | null;
  /** 可选的 image providers 列表（用于下拉） */
  imageProviders: ImageProviderOption[];
  onGenerate: (updates: Partial<AICard>) => void;
  onCancel: () => void;
  onClose: () => void;
  onSave: (cardId: string, updates: Partial<AICard>) => void;
}

const ASPECT_OPTIONS: ImageAspectRatio[] = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const DISPLAY_MODE_OPTIONS: AICardDisplayMode[] = ['fullscreen', 'pip'];

function getMediaContent(card: AICard): MediaCardContent | null {
  return card.content && typeof card.content === 'object' && 'mediaType' in card.content
    ? (card.content as MediaCardContent)
    : null;
}

function buildFallbackContent(
  aspectRatio: ImageAspectRatio,
  prompt: string,
  providerId: string | null,
  model: string | null,
): MediaCardContent {
  return {
    mediaType: 'image',
    assetPath: null,
    aspectRatio,
    prompt,
    providerId,
    model,
    generationStatus: 'idle',
  };
}

export function ImageCardForm({
  card,
  percent,
  previewSrc,
  originalPreviewSrc,
  cutoutPreviewSrc,
  imageProviders,
  onGenerate,
  onCancel,
  onClose,
  onSave,
}: ImageCardFormProps) {
  const initialContent = getMediaContent(card);

  const [title, setTitle] = useState(card.title);
  const [prompt, setPrompt] = useState(initialContent?.prompt ?? '');
  const [negativePrompt, setNegativePrompt] = useState(initialContent?.negativePrompt ?? '');
  const [aspectRatio, setAspectRatio] = useState<ImageAspectRatio>(
    (initialContent?.aspectRatio as ImageAspectRatio | undefined) ?? '16:9',
  );
  const [displayMode, setDisplayMode] = useState<AICardDisplayMode>(card.displayMode);
  const [displayDurationMs, setDisplayDurationMs] = useState<number>(card.displayDurationMs);
  const [providerId, setProviderId] = useState<string | null>(initialContent?.providerId ?? null);
  const [model, setModel] = useState<string | null>(initialContent?.model ?? null);
  const [backgroundRemoval, setBackgroundRemoval] = useState<'none' | 'green-screen'>(
    initialContent?.backgroundRemoval ?? 'none',
  );
  const [previewVariant, setPreviewVariant] = useState<'original' | 'cutout'>(
    initialContent?.cutoutAssetPath && initialContent.assetPath === initialContent.cutoutAssetPath
      ? 'cutout'
      : 'original',
  );

  // 外部 card 变化时同步本地 state
  useEffect(() => {
    const c = getMediaContent(card);
    setTitle(card.title);
    setDisplayMode(card.displayMode);
    setDisplayDurationMs(card.displayDurationMs);
    if (c) {
      setPrompt(c.prompt ?? '');
      setNegativePrompt(c.negativePrompt ?? '');
      setAspectRatio((c.aspectRatio as ImageAspectRatio) ?? '16:9');
      setProviderId(c.providerId ?? null);
      setModel(c.model ?? null);
      setBackgroundRemoval(c.backgroundRemoval ?? 'none');
      setPreviewVariant(c.cutoutAssetPath && c.assetPath === c.cutoutAssetPath ? 'cutout' : 'original');
    }
  }, [card]);

  const status = initialContent?.generationStatus ?? 'idle';
  const isGenerating = status === 'generating' || status === 'pending';
  const primaryButtonLabel = isGenerating
    ? '停止'
    : status === 'ready'
      ? '重新生成图片'
      : '生成图片';

  const selectedProvider = imageProviders.find((p) => p.id === providerId) ?? null;

  const buildUpdates = (): Partial<AICard> => {
    const base = initialContent ?? buildFallbackContent(aspectRatio, prompt, providerId, model);
    const updatedContent: MediaCardContent = {
      ...base,
      prompt,
      negativePrompt: negativePrompt.trim() ? negativePrompt : undefined,
      aspectRatio,
      providerId,
      model,
      backgroundRemoval,
    };
    return {
      title,
      displayMode,
      displayDurationMs,
      content: updatedContent,
    };
  };

  const handleSave = () => onSave(card.id, buildUpdates());
  const handleGenerate = () => onGenerate(buildUpdates());

  // 给 MediaCardPreview 的 content：优先用真实 content；缺失时用本地表单状态构造一个 idle 占位
  const previewContent: MediaCardContent =
    initialContent ?? buildFallbackContent(aspectRatio, prompt, providerId, model);
  const selectedPreviewSrc = previewVariant === 'cutout'
    ? (cutoutPreviewSrc ?? previewSrc)
    : (originalPreviewSrc ?? previewSrc);

  return (
    <div className={styles.root}>
      <div className={styles.previewSection}>
        <MediaCardPreview content={previewContent} previewSrc={selectedPreviewSrc} percent={percent} />
        {initialContent?.originalAssetPath && initialContent.cutoutAssetPath ? (
          <div className={styles.previewMode} role="group" aria-label="预览版本">
            <Button
              size="sm"
              variant={previewVariant === 'original' ? 'accent' : 'ghost'}
              onClick={() => setPreviewVariant('original')}
            >
              原图
            </Button>
            <Button
              size="sm"
              variant={previewVariant === 'cutout' ? 'accent' : 'ghost'}
              onClick={() => setPreviewVariant('cutout')}
            >
              抠图
            </Button>
          </div>
        ) : null}
      </div>

      <div className={styles.field}>
        <label className={styles.label}>标题</label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>

      <div className={styles.field}>
        <label className={styles.label}>生成描述</label>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder="描述图像内容、风格、镜头语言"
        />
      </div>

      <div className={styles.cutoutSetting}>
        <Switch
          label="移除绿幕背景"
          checked={backgroundRemoval === 'green-screen'}
          disabled={isGenerating}
          onChange={(checked) => setBackgroundRemoval(checked ? 'green-screen' : 'none')}
        />
        {initialContent?.cutoutStatus === 'unavailable' || initialContent?.cutoutStatus === 'failed' ? (
          <p className={styles.cutoutMessage} role="status">
            {initialContent.cutoutMessage ?? '没有得到可用抠图，本次继续使用原图。'}
          </p>
        ) : null}
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>画幅比例</label>
          <Select
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value as ImageAspectRatio)}
            options={ASPECT_OPTIONS.map((v) => ({ value: v, label: v }))}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>显示模式</label>
          <Select
            value={displayMode}
            onChange={(e) => setDisplayMode(e.target.value as AICardDisplayMode)}
            options={DISPLAY_MODE_OPTIONS.map((v) => ({
              value: v,
              label: v === 'fullscreen' ? '全屏' : '画中画',
            }))}
          />
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>显示时长（秒）</label>
        <Input
          type="number"
          min="0.1"
          step="0.1"
          value={String(displayDurationMs / 1_000)}
          onChange={(e) => setDisplayDurationMs((Number(e.target.value) || 0) * 1_000)}
        />
      </div>

      <details className={styles.advanced}>
        <summary className={styles.summary}>高级生成设置</summary>
        <div className={styles.advancedBody}>
          <div className={styles.field}>
            <label className={styles.label}>排除内容（可选）</label>
            <Textarea
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              rows={2}
              placeholder="描述不希望出现在图片中的内容"
            />
          </div>
          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label}>生成服务</label>
              <Select
                value={providerId ?? ''}
                onChange={(e) => {
                  setProviderId(e.target.value || null);
                  setModel(null);
                }}
                options={[
                  { value: '', label: '使用项目默认设置' },
                  ...imageProviders.map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>模型</label>
              <Select
                value={model ?? ''}
                onChange={(e) => setModel(e.target.value || null)}
                disabled={!selectedProvider}
                options={[
                  { value: '', label: '使用服务默认模型' },
                  ...(selectedProvider?.models ?? []).map((m) => ({ value: m, label: m })),
                ]}
              />
            </div>
          </div>
        </div>
      </details>

      <div className={styles.buttonRow}>
        <Button variant="secondary" onClick={onClose}>
          关闭
        </Button>
        <Button variant="secondary" disabled={isGenerating} onClick={handleSave}>
          保存设置
        </Button>
        <Button
          variant={isGenerating ? 'secondary' : 'primary'}
          disabled={!isGenerating && !prompt.trim()}
          onClick={isGenerating ? onCancel : handleGenerate}
        >
          {primaryButtonLabel}
        </Button>
      </div>
    </div>
  );
}
