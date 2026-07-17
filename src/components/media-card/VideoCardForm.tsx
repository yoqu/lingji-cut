import { useEffect, useState } from 'react';
import type {
  AICard,
  AICardDisplayMode,
  ImageAspectRatio,
  MediaCardContent,
  VideoAspectRatio,
} from '../../types/ai';
import { Button, Checkbox, ConfirmDialog, Input, Select, Textarea } from '../../ui';
import { MediaCardPreview } from './MediaCardPreview';
import { useVideoGenConfirm } from './useVideoGenConfirm';
import styles from './VideoCardForm.module.css';

export interface VideoProviderOption {
  id: string;
  name: string;
  models: string[];
  /** 该 provider 支持的视频时长档位（秒） */
  durationOptions: number[];
}

export interface VideoCardFormProps {
  card: AICard;
  /** 当前进度，0-100，仅在 generating 时有意义 */
  percent?: number;
  /** 解析好的本地预览 src（绝对 file:// 或 https://），仅 ready 时由父组件提供 */
  previewSrc: string | null;
  /** 视频 providers 列表（含 durationOptions） */
  videoProviders: VideoProviderOption[];
  /** 受控：当前选中的时长档位（秒） */
  durationSeconds: number;
  onDurationSecondsChange: (seconds: number) => void;
  onGenerate: (updates: Partial<AICard>) => void;
  onCancel: () => void;
  onClose: () => void;
  onSave: (cardId: string, updates: Partial<AICard>) => void;
}

const ASPECT_OPTIONS: VideoAspectRatio[] = ['16:9', '9:16', '1:1'];
const DISPLAY_MODE_OPTIONS: AICardDisplayMode[] = ['fullscreen', 'pip'];
const DEFAULT_DURATION_OPTIONS = [4, 6, 8];

function getMediaContent(card: AICard): MediaCardContent | null {
  return card.content && typeof card.content === 'object' && 'mediaType' in card.content
    ? (card.content as MediaCardContent)
    : null;
}

function buildFallbackContent(
  aspectRatio: VideoAspectRatio,
  prompt: string,
  providerId: string | null,
  model: string | null,
): MediaCardContent {
  return {
    mediaType: 'video',
    assetPath: null,
    posterPath: null,
    aspectRatio: aspectRatio as ImageAspectRatio,
    prompt,
    providerId,
    model,
    generationStatus: 'idle',
  };
}

export function VideoCardForm({
  card,
  percent,
  previewSrc,
  videoProviders,
  durationSeconds,
  onDurationSecondsChange,
  onGenerate,
  onCancel,
  onClose,
  onSave,
}: VideoCardFormProps) {
  const initialContent = getMediaContent(card);

  const [title, setTitle] = useState(card.title);
  const [prompt, setPrompt] = useState(initialContent?.prompt ?? '');
  const [negativePrompt, setNegativePrompt] = useState(initialContent?.negativePrompt ?? '');
  const [aspectRatio, setAspectRatio] = useState<VideoAspectRatio>(
    (initialContent?.aspectRatio as VideoAspectRatio | undefined) ?? '16:9',
  );
  const [displayMode, setDisplayMode] = useState<AICardDisplayMode>(card.displayMode);
  const [providerId, setProviderId] = useState<string | null>(initialContent?.providerId ?? null);
  const [model, setModel] = useState<string | null>(initialContent?.model ?? null);

  const confirmation = useVideoGenConfirm();

  // 外部 card 变化时同步本地 state
  useEffect(() => {
    const c = getMediaContent(card);
    setTitle(card.title);
    setDisplayMode(card.displayMode);
    if (c) {
      setPrompt(c.prompt ?? '');
      setNegativePrompt(c.negativePrompt ?? '');
      setAspectRatio((c.aspectRatio as VideoAspectRatio) ?? '16:9');
      setProviderId(c.providerId ?? null);
      setModel(c.model ?? null);
    }
  }, [card]);

  const status = initialContent?.generationStatus ?? 'idle';
  const isGenerating = status === 'generating' || status === 'pending';
  const primaryButtonLabel = isGenerating
    ? '停止'
    : status === 'ready'
      ? '重新生成视频'
      : '生成视频';

  const selectedProvider = videoProviders.find((p) => p.id === providerId) ?? null;
  const durationProvider = selectedProvider ?? videoProviders[0] ?? null;
  const durationOptions = durationProvider?.durationOptions ?? DEFAULT_DURATION_OPTIONS;

  const buildUpdates = (): Partial<AICard> => {
    const base = initialContent ?? buildFallbackContent(aspectRatio, prompt, providerId, model);
    const updatedContent: MediaCardContent = {
      ...base,
      prompt,
      negativePrompt: negativePrompt.trim() ? negativePrompt : undefined,
      aspectRatio: aspectRatio as ImageAspectRatio,
      providerId,
      model,
      extraParams: { ...base.extraParams, durationSeconds },
    };
    return {
      title,
      displayMode,
      displayDurationMs: durationSeconds * 1_000,
      content: updatedContent,
    };
  };

  const handlePrimary = async () => {
    if (isGenerating) {
      onCancel();
      return;
    }
    const ok = await confirmation.requestConfirmation();
    if (ok) onGenerate(buildUpdates());
  };

  const handleSave = () => onSave(card.id, buildUpdates());

  const previewContent: MediaCardContent =
    initialContent ?? buildFallbackContent(aspectRatio, prompt, providerId, model);

  return (
    <div className={styles.root}>
      <div className={styles.previewSection}>
        <MediaCardPreview content={previewContent} previewSrc={previewSrc} percent={percent} />
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
          placeholder="描述主体、动作、镜头运动、转场"
        />
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>画幅比例</label>
          <Select
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value as VideoAspectRatio)}
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
        <label className={styles.label}>生成时长</label>
        <Select
          value={String(durationSeconds)}
          onChange={(e) => onDurationSecondsChange(Number(e.target.value))}
          options={durationOptions.map((s) => ({ value: String(s), label: `${s} 秒` }))}
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
              placeholder="描述不希望出现在视频中的内容"
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
                  ...videoProviders.map((p) => ({ value: p.id, label: p.name })),
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
          onClick={handlePrimary}
        >
          {primaryButtonLabel}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmation.open}
        onOpenChange={confirmation.onOpenChange}
        title="开始生成视频？"
        description={(
          <>
            <span className={styles.confirmCopy}>
              视频生成通常需要数分钟，并可能按次计费。开始后可在任务栏查看进度或停止。
            </span>
            <Checkbox
              className={styles.confirmRemember}
              size="sm"
              label="下次不再提示"
              checked={confirmation.rememberChoice}
              onChange={confirmation.setRememberChoice}
            />
          </>
        )}
        confirmText="开始生成"
        cancelText="返回调整"
        onConfirm={confirmation.confirm}
        onCancel={confirmation.cancel}
      />
    </div>
  );
}
