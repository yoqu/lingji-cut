import { useEffect, useMemo, useState } from 'react';
import { getAICardOverlayPosition } from '../lib/ai-card-layout';
import { getProjectDir } from '../store/timeline';
import { listStylePresets } from '../lib/card-style-presets';
import { toFileSrc } from '../lib/utils';
import { getVideoProvider } from '../lib/video-gen/registry';
import { loadAISettings, useAIStore } from '../store/ai';
import type { AICard, AICardType, MediaCardContent, VideoProvider } from '../types/ai';
import { Alert, Button, Input, NumberField, PillGroup, type PillGroupItem, Textarea } from '../ui';
import { AppIcon } from './AppIcon';
import {
  ImageCardForm,
  type ImageProviderOption,
} from './media-card/ImageCardForm';
import {
  VideoCardForm,
  type VideoProviderOption,
} from './media-card/VideoCardForm';
import styles from './AICardInspector.module.css';

interface AICardInspectorProps {
  card: AICard | null;
  errorMessage?: string | null;
  isRegenerating?: boolean;
  previewWidth?: number;
  previewHeight?: number;
  showCancel?: boolean;
  onCancel?: () => void;
  onDelete?: () => void;
  onRegenerate: (updates: Partial<AICard>) => Promise<AICard | null>;
  onGenerateAnimationDirection?: (card: AICard) => Promise<string>;
  onSave: (cardId: string, updates: Partial<AICard>) => void;
}

const CARD_TYPES: Array<PillGroupItem<AICardType>> = [
  { value: 'summary', label: '摘要' },
  { value: 'data', label: '数据' },
  { value: 'insight', label: '观点' },
  { value: 'chapter', label: '章节' },
  { value: 'quote', label: '金句' },
];

// PillGroup 需要受控的非空值，用哨兵值表示「跟随项目 / 全局」（实际持久化为 undefined）。
const STYLE_INHERIT = '__inherit__';
const STYLE_PRESET_ITEMS: Array<PillGroupItem<string>> = [
  { value: STYLE_INHERIT, label: '跟随项目 / 全局' },
  ...listStylePresets().map((p) => ({ value: p.id, label: p.name })),
];

const DISPLAY_MODES: Array<PillGroupItem<'fullscreen' | 'pip'>> = [
  { value: 'fullscreen' as const, label: '全屏' },
  { value: 'pip' as const, label: '画中画' },
];

export function AICardInspector({
  card,
  errorMessage = null,
  isRegenerating = false,
  previewWidth = 1_920,
  previewHeight = 1_080,
  showCancel = false,
  onCancel,
  onDelete,
  onRegenerate,
  onGenerateAnimationDirection,
  onSave,
}: AICardInspectorProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [cardPrompt, setCardPrompt] = useState('');
  const [animationDirection, setAnimationDirection] = useState('');
  const [isGeneratingDirection, setIsGeneratingDirection] = useState(false);
  const [isSculpting, setIsSculpting] = useState(false);
  const [type, setType] = useState<AICardType>('summary');
  const [stylePresetId, setStylePresetId] = useState<string | undefined>(undefined);
  const [displayMode, setDisplayMode] = useState<'fullscreen' | 'pip'>('fullscreen');
  const [displayDurationMs, setDisplayDurationMs] = useState(5_000);

  useEffect(() => {
    if (!card) {
      return;
    }

    setTitle(card.title);
    setContent(
      typeof card.content === 'string' ? card.content : JSON.stringify(card.content, null, 2),
    );
    setCardPrompt(card.cardPrompt ?? '');
    setAnimationDirection(card.animationDirection ?? '');
    setType(card.type);
    setStylePresetId(card.stylePresetId);
    setDisplayMode(card.displayMode);
    setDisplayDurationMs(card.displayDurationMs);
  }, [card]);

  if (!card) {
    return null;
  }

  if (card.type === 'image') {
    return (
      <ImageCardFormHost
        card={card}
        onClose={onCancel ?? (() => undefined)}
        onSave={onSave}
      />
    );
  }

  if (card.type === 'video') {
    return (
      <VideoCardFormHost
        card={card}
        onClose={onCancel ?? (() => undefined)}
        onSave={onSave}
      />
    );
  }

  const parsedContent =
    type === 'data'
      ? (() => {
          try {
            return JSON.parse(content);
          } catch {
            return card.content;
          }
        })()
      : content;

  const draftUpdates: Partial<AICard> = {
    title,
    content: parsedContent,
    type,
    stylePresetId,
    displayMode,
    displayDurationMs,
    cardPrompt: cardPrompt.trim() || undefined,
    animationDirection: animationDirection.trim() || undefined,
    template: `${type}-default`,
  };

  const motion = card.motionCard;
  const hasCompiledMotion = Boolean(motion?.tsx?.trim());
  const previewCardPosition = getAICardOverlayPosition(displayMode, previewWidth, previewHeight);
  const previewFrameStyle =
    displayMode === 'fullscreen'
      ? undefined
      : {
          left: `${(previewCardPosition.x / Math.max(1, previewWidth)) * 100}%`,
          top: `${(previewCardPosition.y / Math.max(1, previewHeight)) * 100}%`,
          width: `${(previewCardPosition.width / Math.max(1, previewWidth)) * 100}%`,
        };

  const handleRegenerateClick = async () => {
    await onRegenerate(draftUpdates);
  };

  const handleSculptClick = async () => {
    const projectPath = getProjectDir();
    if (!card || !projectPath) return;
    setIsSculpting(true);
    try {
      // fire-and-forget：任务进度经 pipeline 桥出现在底部任务条，完成后
      // pipeline:project-updated 自动刷新卡片；这里只等任务受理。
      await window.electronAPI.sculptCard({ projectPath, cardId: card.id });
    } finally {
      setIsSculpting(false);
    }
  };

  const handleGenerateDirection = async () => {
    if (!card || !onGenerateAnimationDirection) return;
    setIsGeneratingDirection(true);
    try {
      const text = await onGenerateAnimationDirection(card);
      setAnimationDirection(text);
    } finally {
      setIsGeneratingDirection(false);
    }
  };

  return (
    <div className={styles.root}>
      {errorMessage ? <Alert variant="error" description={errorMessage} /> : null}

      <div className={styles.section} data-ai-card-section="text-content">
        <span className={styles.sectionTitle}>文字内容</span>

        <PillGroup
          items={CARD_TYPES}
          value={type}
          onChange={setType}
          size="sm"
          className={styles.pillRow}
          itemClassName={styles.pillItem}
        />

        <label className={styles.fieldStack}>
          <span className={styles.fieldLabel}>卡片风格</span>
          <PillGroup
            items={STYLE_PRESET_ITEMS}
            value={stylePresetId ?? STYLE_INHERIT}
            onChange={(value) => setStylePresetId(value === STYLE_INHERIT ? undefined : value)}
            size="sm"
            className={styles.pillRow}
            itemClassName={styles.pillItem}
          />
        </label>

        <label className={styles.fieldStack}>
          <span className={styles.fieldLabel}>标题</span>
          <Input
            size="sm"
            value={title}
            className={styles.textInput}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label className={styles.fieldStack}>
          <span className={styles.fieldLabel}>内容</span>
          <Textarea
            size="sm"
            value={content}
            rows={5}
            resize="none"
            className={styles.textArea}
            onChange={(event) => setContent(event.target.value)}
          />
        </label>

        <label className={styles.fieldStack}>
          <span className={styles.fieldLabel}>追加提示词</span>
          <Textarea
            size="sm"
            value={cardPrompt}
            rows={3}
            resize="none"
            className={styles.promptArea}
            placeholder="输入额外的生成指导…"
            onChange={(event) => setCardPrompt(event.target.value)}
          />
        </label>

        <label className={styles.fieldStack}>
          <span className={styles.fieldLabel}>分镜（storyboard）</span>
          <Textarea
            size="sm"
            value={animationDirection}
            rows={6}
            resize="none"
            className={styles.promptArea}
            placeholder="AI 会自动设计 JSON 分镜；也可点下方按钮单独生成后再出卡…"
            onChange={(event) => setAnimationDirection(event.target.value)}
          />
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<AppIcon name="sparkles" size={12} />}
            disabled={isGeneratingDirection}
            onClick={() => {
              void handleGenerateDirection();
            }}
          >
            {isGeneratingDirection ? '生成中...' : '✨ 生成分镜'}
          </Button>
        </label>
      </div>

      <div className={styles.section} data-ai-card-section="display-settings">
        <span className={styles.sectionTitle}>展示设置</span>

        <PillGroup
          items={DISPLAY_MODES}
          value={displayMode}
          onChange={setDisplayMode}
          size="sm"
          fullWidth
          className={styles.pillRow}
          itemClassName={styles.pillItem}
        />

        <div className={styles.inlineFieldRow}>
          <span className={styles.fieldLabel}>时长</span>
          <span className={styles.inlineSpacer} />
          <NumberField
            value={displayDurationMs / 1_000}
            min={1}
            step={0.5}
            unit="秒"
            className={styles.durationField}
            onChange={(value) => setDisplayDurationMs(value * 1_000)}
          />
        </div>
      </div>

      <div className={styles.section} data-ai-card-section="preview">
        <span className={styles.sectionTitle}>Motion 卡片状态</span>

        <div className={styles.previewFrameShell} data-ai-card-preview-frame="true">
          <div
            className={styles.previewStage}
            style={{ aspectRatio: `${Math.max(1, previewWidth)} / ${Math.max(1, previewHeight)}` }}
          >
            <div className={styles.previewCanvas} />
            <div
              className={[
                styles.previewFrame,
                displayMode === 'fullscreen'
                  ? styles.previewFrameFullscreen
                  : styles.previewFramePip,
              ].join(' ')}
              style={previewFrameStyle}
            >
              <div className={styles.previewPlaceholder}>
                <AppIcon name="eye" size={20} className={styles.previewIcon} />
                <span className={styles.previewHint}>
                  {hasCompiledMotion ? 'Motion 卡片已就绪' : '尚未生成 Remotion 动画'}
                </span>
                <span className={styles.previewBadge}>
                  {displayMode === 'fullscreen' ? '全屏模式' : '画中画模式'}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className={styles.actions}>
          {showCancel && onCancel ? (
            <Button variant="secondary" size="sm" className={styles.actionBtn} onClick={onCancel}>
              取消
            </Button>
          ) : null}

          <Button
            variant="secondary"
            size="sm"
            className={styles.actionBtn}
            leftIcon={
              <AppIcon
                name="refresh-cw"
                size={12}
                className={isRegenerating ? styles.spin : undefined}
              />
            }
            onClick={() => {
              void handleRegenerateClick();
            }}
            disabled={isRegenerating}
          >
            {isRegenerating ? '重生成中...' : '重新生成'}
          </Button>

          {hasCompiledMotion ? (
            <Button
              variant="secondary"
              size="sm"
              className={styles.actionBtn}
              leftIcon={<AppIcon name="sparkles" size={12} />}
              title="多 agent 精雕现有动画（导演诊断→雕刻→审查，分钟级），进度见底部任务条"
              onClick={() => {
                void handleSculptClick();
              }}
              disabled={isSculpting || isRegenerating}
            >
              {isSculpting ? '提交中...' : '精雕动画'}
            </Button>
          ) : null}

          <Button
            variant="primary"
            size="sm"
            className={styles.actionBtn}
            leftIcon={<AppIcon name="save" size={12} />}
            onClick={() => {
              onSave(card.id, draftUpdates);
            }}
          >
            保存
          </Button>
        </div>
      </div>

      <div className={styles.section} data-ai-card-section="danger">
        <span className={styles.dangerTitle}>危险操作</span>
        <Button
          variant="destructive"
          size="sm"
          fullWidth
          leftIcon={<AppIcon name="trash-2" size={13} />}
          onClick={() => onDelete?.()}
        >
          删除此卡片
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 私有派发宿主：image / video 媒体卡 Inspector
// ---------------------------------------------------------------------------

function getMediaContent(card: AICard): MediaCardContent | null {
  return card.content && typeof card.content === 'object' && 'mediaType' in card.content
    ? (card.content as MediaCardContent)
    : null;
}

function buildPreviewSrc(
  card: AICard,
  currentProjectDir: string | null,
  pathKey: 'assetPath' | 'posterPath',
): string | null {
  const media = getMediaContent(card);
  if (!media) return null;
  const value =
    pathKey === 'assetPath'
      ? media.assetPath
      : (media.posterPath ?? media.assetPath ?? null);
  if (!value) return null;
  // 已是绝对 URL
  if (value.startsWith('file://') || value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }
  if (!currentProjectDir) return null;
  const abs = `${currentProjectDir.replace(/\/$/, '')}/${value.replace(/^\//, '')}`;
  return toFileSrc(abs);
}

interface MediaCardFormHostProps {
  card: AICard;
  onClose: () => void;
  onSave: (cardId: string, updates: Partial<AICard>) => void;
}

function ImageCardFormHost({ card, onClose, onSave }: MediaCardFormHostProps) {
  const currentProjectDir = useAIStore((s) => s.currentProjectDir);
  const taskEntry = useAIStore((s) => s.cardMediaTasks[card.id]);
  const regenerateCardMedia = useAIStore((s) => s.regenerateCardMedia);
  const cancelCardMediaGeneration = useAIStore((s) => s.cancelCardMediaGeneration);

  const [imageProviders, setImageProviders] = useState<ImageProviderOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await loadAISettings();
        if (cancelled || !settings) return;
        const opts: ImageProviderOption[] = (settings.imageProviders ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          models: p.models ?? [],
        }));
        setImageProviders(opts);
      } catch {
        // 忽略：保持空数组
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const previewSrc = useMemo(
    () => buildPreviewSrc(card, currentProjectDir, 'assetPath'),
    [card, currentProjectDir],
  );

  return (
    <ImageCardForm
      card={card}
      percent={taskEntry?.percent}
      previewSrc={previewSrc}
      imageProviders={imageProviders}
      onGenerate={() => {
        void regenerateCardMedia(card.id);
      }}
      onCancel={() => {
        void cancelCardMediaGeneration(card.id);
      }}
      onClose={onClose}
      onSave={onSave}
    />
  );
}

function getDurationOptionsForProvider(provider: VideoProvider): number[] {
  // 优先：provider.extras.durationOptions（用户在 Settings 里覆写）
  const fromExtras = (provider.extras as Record<string, unknown> | undefined)?.durationOptions;
  if (Array.isArray(fromExtras) && fromExtras.every((v) => typeof v === 'number' && v > 0)) {
    return fromExtras as number[];
  }
  // 次选：从 video-gen 注册表取 capabilities.durationOptions
  try {
    const p = getVideoProvider(provider.type);
    return p.capabilities.durationOptions;
  } catch {
    return [4, 6, 8];
  }
}

function VideoCardFormHost({ card, onClose, onSave }: MediaCardFormHostProps) {
  const currentProjectDir = useAIStore((s) => s.currentProjectDir);
  const taskEntry = useAIStore((s) => s.cardMediaTasks[card.id]);
  const regenerateCardMedia = useAIStore((s) => s.regenerateCardMedia);
  const cancelCardMediaGeneration = useAIStore((s) => s.cancelCardMediaGeneration);

  const [videoProviders, setVideoProviders] = useState<VideoProviderOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await loadAISettings();
        if (cancelled || !settings) return;
        const opts: VideoProviderOption[] = (settings.videoProviders ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          models: p.models ?? [],
          durationOptions: getDurationOptionsForProvider(p),
        }));
        setVideoProviders(opts);
      } catch {
        // 忽略：保持空数组
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const initialDuration = useMemo(() => {
    const media = getMediaContent(card);
    const fromExtras = media?.extraParams?.durationSeconds;
    if (typeof fromExtras === 'number' && fromExtras > 0) return fromExtras;
    if (typeof media?.mediaDurationMs === 'number' && media.mediaDurationMs > 0) {
      return Math.round(media.mediaDurationMs / 1000);
    }
    return 6;
  }, [card]);

  const [durationSeconds, setDurationSeconds] = useState<number>(initialDuration);

  // card 切换或外部 duration 变化时同步
  useEffect(() => {
    setDurationSeconds(initialDuration);
  }, [initialDuration]);

  const previewSrc = useMemo(() => {
    // video 卡 ready 时优先视频本体；其次 poster 兜底（form 内部 video 标签）
    return buildPreviewSrc(card, currentProjectDir, 'assetPath');
  }, [card, currentProjectDir]);

  return (
    <VideoCardForm
      card={card}
      percent={taskEntry?.percent}
      previewSrc={previewSrc}
      videoProviders={videoProviders}
      durationSeconds={durationSeconds}
      onDurationSecondsChange={setDurationSeconds}
      onGenerate={() => {
        void regenerateCardMedia(card.id, { extraParams: { durationSeconds } });
      }}
      onCancel={() => {
        void cancelCardMediaGeneration(card.id);
      }}
      onClose={onClose}
      onSave={onSave}
    />
  );
}
