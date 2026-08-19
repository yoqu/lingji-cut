import { AnimatePresence, m } from 'framer-motion';
import { useState } from 'react';
import { Film, Image as ImageIcon, Layers3, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react';
import { toFileSrc } from '../lib/utils';
import { CARRIER_META } from '../lib/motion-storyboard';
import { useAIStore } from '../store/ai';
import type { AICard, AICardType, MediaCardContent } from '../types/ai';
import { Badge, Checkbox } from '../ui';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/components/dropdown-menu';
import { springs } from '../ui/lib/motion';
import styles from './AICardList.module.css';

export interface AICardPlacement {
  trackId: string;
  trackLabel: string;
}

/** 分段卡片的占位骨架：规划完成后、真实卡片生成前/失败时展示 */
export interface AICardSkeleton {
  segmentId: string;
  title: string;
  status: 'pending' | 'failed';
}

interface AICardListProps {
  cards: AICard[];
  placements?: Record<string, AICardPlacement>;
  onToggleEnabled: (cardId: string) => void;
  onDeleteCard: (cardId: string) => void;
  onEditCard: (cardId: string) => void;
  /** 转换为 image/video 后立即聚焦该卡片到 Inspector；可选 */
  onSelect?: (cardId: string) => void;
  /** 增量分析占位骨架；已有同 segmentId 真实卡片的会被去重过滤 */
  skeletons?: AICardSkeleton[];
  /** 点击失败骨架的重试控件时回调；不传则不渲染重试按钮 */
  onRetrySkeleton?: (segmentId: string) => void;
}

function getPreviewText(content: AICard['content']): string {
  if (content && typeof content === 'object' && 'mediaType' in content) {
    const media = content as MediaCardContent;
    return media.prompt || (media.mediaType === 'image' ? '图片卡（未填提示词）' : '视频卡（未填提示词）');
  }
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return text.length > 74 ? `${text.slice(0, 74)}…` : text;
}

function getMediaContent(card: AICard): MediaCardContent | null {
  return card.content && typeof card.content === 'object' && 'mediaType' in card.content
    ? (card.content as MediaCardContent)
    : null;
}

function buildThumbnailSrc(
  card: AICard,
  currentProjectDir: string | null,
): string | null {
  const media = getMediaContent(card);
  if (!media) return null;
  const value =
    media.mediaType === 'video'
      ? (media.posterPath ?? media.assetPath ?? null)
      : media.assetPath;
  if (!value) return null;
  return resolveThumbnailSrc(value, currentProjectDir);
}

function buildCompositeThumbnailSrc(card: AICard, currentProjectDir: string | null): string | null {
  const binding = card.assetBindings?.find((item) => item.thumbnailFile)
    ?? card.assetBindings?.find((item) => (
      item.kind === 'image' || /\.(?:avif|gif|jpe?g|png|webp)$/iu.test(item.filePath)
    ));
  const value = binding?.thumbnailFile ?? binding?.filePath;
  return value ? resolveThumbnailSrc(value, currentProjectDir) : null;
}

function resolveThumbnailSrc(value: string, currentProjectDir: string | null): string | null {
  if (/^(?:file|https?):\/\//u.test(value)) return value;
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/u.test(value)) return toFileSrc(value);
  if (!currentProjectDir) return null;
  return toFileSrc(`${currentProjectDir.replace(/[\\/]$/u, '')}/${value.replace(/^[\\/]/u, '')}`);
}

const CARD_TYPE_META: Record<AICardType, { label: string; color: string; tone: string }> = {
  motion: { label: '动画', color: '#c084fc', tone: 'purple' },
  image: { label: '图片卡', color: '#32D74B', tone: 'green' },
  video: { label: '视频卡', color: '#FFD60A', tone: 'yellow' },
};

const STRATEGY_META = {
  'agent-composite': { label: 'Agent Composite', color: '#64D2FF', tone: 'blue' },
  'standalone-media': { label: '真实素材', color: '#32D74B', tone: 'green' },
} as const;

export function AICardList({
  cards,
  placements,
  onToggleEnabled,
  onDeleteCard,
  onEditCard,
  onSelect,
  skeletons,
  onRetrySkeleton,
}: AICardListProps) {
  // selector 订阅 currentProjectDir 变更；?? getState() 兼容 SSR
  const currentProjectDir =
    useAIStore((s) => s.currentProjectDir) ?? useAIStore.getState().currentProjectDir;
  const convertCardToMedia = useAIStore((s) => s.convertCardToMedia);
  const convertCardToMotion = useAIStore((s) => s.convertCardToMotion);
  const [openMenuCardId, setOpenMenuCardId] = useState<string | null>(null);
  const [convertingCardId, setConvertingCardId] = useState<string | null>(null);

  // 去重：已有同 segmentId 真实卡片的骨架被过滤掉（防御性，集成方一般不会传重叠的）。
  const cardSegmentIds = new Set(
    cards.map((card) => card.segmentId).filter((id): id is string => Boolean(id)),
  );
  const visibleSkeletons = (skeletons ?? []).filter(
    (skeleton) => !cardSegmentIds.has(skeleton.segmentId),
  );

  const handleConvert = async (
    cardId: string,
    mediaType: 'image' | 'video',
  ): Promise<void> => {
    const next = await convertCardToMedia(cardId, mediaType);
    if (next) {
      onSelect?.(next.id);
    }
  };

  const handleConvertToMotion = async (cardId: string): Promise<void> => {
    setConvertingCardId(cardId);
    try {
      const next = await convertCardToMotion(cardId);
      if (next) {
        onSelect?.(next.id);
      }
    } finally {
      setConvertingCardId(null);
    }
  };

  return (
    <div className={styles.list} data-ai-card-list="true">
      <AnimatePresence mode="popLayout" initial={false}>
        {cards.map((card) => {
          const baseMeta = CARD_TYPE_META[card.type] ?? CARD_TYPE_META.motion;
          const carrier = card.motionCard?.storyboard?.carrier;
          const meta = card.renderStrategy === 'agent-composite'
            ? STRATEGY_META['agent-composite']
            : card.renderStrategy === 'standalone-media'
              ? STRATEGY_META['standalone-media']
              : card.type === 'motion' && carrier && CARRIER_META[carrier]
              ? { ...baseMeta, label: CARRIER_META[carrier].label }
              : baseMeta;
          const isMedia = card.type === 'image' || card.type === 'video';
          const isComposite = card.renderStrategy === 'agent-composite';
          const media = isMedia ? getMediaContent(card) : null;
          const thumbSrc = isMedia
            ? buildThumbnailSrc(card, currentProjectDir)
            : isComposite
              ? buildCompositeThumbnailSrc(card, currentProjectDir)
              : null;
          const status = media?.generationStatus ?? 'idle';
          const isGenerating = status === 'generating' || status === 'pending';
          const productionReport = card.motionCard?.productionReport;
          const isFailed = status === 'failed'
            || productionReport?.status === 'failed'
            || productionReport?.renderOk === false;
          const fallbackUsed = productionReport?.fallbackUsed === true;
          const placement = placements?.[card.id];

          return (
            <m.article
              key={card.id}
              layoutId={`ai-card-${card.id}`}
              className={styles.card}
              data-ai-card-type={card.type}
              data-ai-card-render-strategy={card.renderStrategy ?? 'motion-card'}
              data-enabled={card.enabled}
              onClick={() => onEditCard(card.id)}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 12 }}
              transition={springs.smooth}
            >
              <div className={styles.cardHead}>
                <div
                  className={styles.checkbox}
                  onClick={(event) => event.stopPropagation()}
                >
                  <Checkbox
                    checked={card.enabled}
                    onChange={() => onToggleEnabled(card.id)}
                    aria-label={`切换 ${card.title} 是否上轨`}
                    size="sm"
                  />
                </div>

                {isMedia || isComposite ? (
                  <div
                    className={styles.thumbnail}
                    data-ai-card-thumbnail={isComposite ? 'agent-composite' : card.type}
                  >
                    {thumbSrc ? (
                      <img
                        src={thumbSrc}
                        alt={`${card.title} 缩略图`}
                        className={styles.thumbnailImg}
                        loading="lazy"
                      />
                    ) : (
                      <span className={styles.thumbnailPlaceholder} aria-hidden="true">
                        {isComposite
                          ? <Layers3 size={16} />
                          : card.type === 'image'
                            ? <ImageIcon size={16} />
                            : <Film size={16} />}
                      </span>
                    )}
                    {isGenerating ? (
                      <span
                        className={`${styles.statusBadge} ${styles.badgeGenerating}`}
                        data-ai-card-status="generating"
                        aria-label="生成中"
                      />
                    ) : null}
                    {isFailed ? (
                      <span
                        className={`${styles.statusBadge} ${styles.badgeFailed}`}
                        data-ai-card-status="failed"
                        aria-label="生成失败"
                      />
                    ) : null}
                    {fallbackUsed && !isFailed ? (
                      <span
                        className={`${styles.statusBadge} ${styles.badgeFallback}`}
                        data-ai-card-status="fallback"
                        aria-label="已使用退路"
                      />
                    ) : null}
                  </div>
                ) : null}

                <Badge
                  size="xs"
                  color={meta.color}
                  className={styles.badge}
                  data-tone={meta.tone}
                >
                  {meta.label}
                </Badge>

                <span className={styles.title}>{card.title}</span>

                <div
                  className={styles.cardActions}
                  onClick={(event) => event.stopPropagation()}
                >
                  <DropdownMenu
                    open={openMenuCardId === card.id}
                    onOpenChange={(open) =>
                      setOpenMenuCardId(open ? card.id : null)
                    }
                  >
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className={styles.cardMenuTrigger}
                        aria-label={`${card.title} 更多操作`}
                      >
                        <MoreHorizontal size={14} />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" sideOffset={4}>
                      <DropdownMenuItem
                        disabled={card.type === 'image'}
                        onSelect={() => {
                          void handleConvert(card.id, 'image');
                        }}
                      >
                        转为图片卡
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={card.type === 'video'}
                        onSelect={() => {
                          void handleConvert(card.id, 'video');
                        }}
                      >
                        转为视频卡
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!isMedia || convertingCardId === card.id}
                        onSelect={() => {
                          void handleConvertToMotion(card.id);
                        }}
                      >
                        转为动画卡
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onDeleteCard(card.id)}>
                        <Trash2 size={13} />
                        删除镜头
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              <p className={styles.body} data-ai-card-copy="true">
                {getPreviewText(card.content)}
              </p>
              {isComposite || fallbackUsed || placement ? (
                <div className={styles.cardMeta}>
                  {isComposite ? (
                    <span>{card.assetBindings?.length ?? 0} 项合成素材</span>
                  ) : null}
                  {fallbackUsed ? <span data-tone="warning">已使用制作退路</span> : null}
                  {placement ? <span>{placement.trackLabel}</span> : null}
                </div>
              ) : null}
            </m.article>
          );
        })}

        {visibleSkeletons.map((skeleton) => {
          const isFailed = skeleton.status === 'failed';
          return (
            <m.article
              key={`skeleton-${skeleton.segmentId}`}
              layoutId={`ai-card-skeleton-${skeleton.segmentId}`}
              className={`${styles.card} ${styles.skeleton}`}
              data-ai-card-skeleton="true"
              data-skeleton-status={skeleton.status}
              data-segment-id={skeleton.segmentId}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 12 }}
              transition={springs.smooth}
            >
              <div className={styles.skeletonHead}>
                <span className={styles.skeletonDot} aria-hidden="true" />
                {skeleton.title ? (
                  <span className={styles.skeletonTitle}>{skeleton.title}</span>
                ) : (
                  <span className={styles.skeletonTitle} aria-hidden="true" />
                )}
                {isFailed ? (
                  onRetrySkeleton ? (
                    <button
                      type="button"
                      className={styles.skeletonRetry}
                      onClick={() => onRetrySkeleton(skeleton.segmentId)}
                      aria-label={`重试生成 ${skeleton.title || skeleton.segmentId}`}
                    >
                      <RotateCcw size={12} aria-hidden="true" />
                      重试
                    </button>
                  ) : null
                ) : (
                  <span className={styles.skeletonLabel} aria-live="polite">
                    生成中…
                  </span>
                )}
              </div>

              {isFailed ? (
                <p className={styles.skeletonHint} data-ai-card-skeleton-hint="failed">
                  生成失败
                </p>
              ) : (
                <div className={styles.skeletonBars} aria-hidden="true">
                  <span className={styles.skeletonBar} />
                  <span className={`${styles.skeletonBar} ${styles.skeletonBarShort}`} />
                </div>
              )}
            </m.article>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
