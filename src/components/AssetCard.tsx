import type { DragEventHandler, KeyboardEvent } from 'react';
import type { AssetItem, AssetType } from '../types';
import { useThumbnail } from '../hooks/useThumbnail';
import { AppIcon, type AppIconName } from './AppIcon';
import { Button } from '../ui';
import styles from './AssetCard.module.css';

interface AssetCardProps {
  asset: AssetItem;
  compact: boolean;
  usageCount: number;
  onDragStart: DragEventHandler<HTMLDivElement>;
  onDragEnd?: DragEventHandler<HTMLDivElement>;
  onRemove: (path: string) => void;
  onClick?: () => void;
  selected?: boolean;
}

/** 每种类型的视觉配置 */
const TYPE_META: Record<
  AssetType,
  { icon: AppIconName; iconColor: string; className: string }
> = {
  video: {
    icon: 'film',
    iconColor: 'color-mix(in srgb, var(--color-selection-blue-hover) 75%, transparent)',
    className: styles.typeVideo,
  },
  image: {
    icon: 'image',
    iconColor: 'color-mix(in srgb, var(--color-success) 75%, transparent)',
    className: styles.typeImage,
  },
  audio: {
    icon: 'music',
    iconColor: 'color-mix(in srgb, var(--color-brand-warm) 75%, transparent)',
    className: styles.typeAudio,
  },
  srt: {
    icon: 'file-text',
    iconColor: 'color-mix(in srgb, #B48CFF 75%, transparent)',
    className: styles.typeSrt,
  },
  text: {
    icon: 'type',
    iconColor: 'color-mix(in srgb, #10b981 75%, transparent)',
    className: styles.typeText,
  },
};

/** Ghost 导入卡片 — 放在网格末尾 */
export function AssetImportCard({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      className={[styles.root, styles.ghost].join(' ')}
      onClick={onClick}
      aria-label="导入素材"
    >
      <AppIcon name="plus" size={24} color="var(--color-text-muted)" />
      <span className={styles.ghostLabel}>导入</span>
    </Button>
  );
}

/** Ghost 添加文字卡片 — 文字 tab 下使用，与导入卡片同规格 */
export function AddTextCard({ onClick }: { onClick?: () => void }) {
  return (
    <Button
      variant="ghost"
      className={[styles.root, styles.ghost].join(' ')}
      onClick={onClick}
      aria-label="添加文字"
    >
      <AppIcon name="type" size={24} color="var(--color-text-muted)" />
      <span className={styles.ghostLabel}>添加文字</span>
    </Button>
  );
}

export function AssetCard({
  asset,
  compact,
  usageCount: _usageCount,
  onDragStart,
  onDragEnd,
  onRemove,
  onClick,
  selected = false,
}: AssetCardProps) {
  const meta = TYPE_META[asset.type];
  const isDraggable =
    !asset.locked &&
    (asset.type === 'image' ||
      asset.type === 'video' ||
      asset.type === 'text' ||
      asset.type === 'audio');
  const thumbnail = useThumbnail(asset.path, asset.type);
  const canRemove = !asset.locked;
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onClick) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onClick();
  };

  return (
    <div
      draggable={isDraggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-pressed={onClick ? selected : undefined}
      className={[
        styles.root,
        compact ? styles.compact : styles.regular,
        isDraggable ? styles.draggable : '',
        onClick ? styles.clickable : '',
        selected ? styles.selected : '',
        thumbnail ? styles.hasThumbnail : meta.className,
      ].filter(Boolean).join(' ')}
    >
      {canRemove ? (
        <Button
          variant="ghost"
          size="icon"
          className={styles.removeButton}
          aria-label={`移除素材 ${asset.name}`}
          title="移除素材"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            event.preventDefault();
            onRemove(asset.path);
          }}
        >
          <AppIcon name="x" size={10} />
        </Button>
      ) : null}

      {/* 顶部预览区 */}
      <div className={styles.iconArea}>
        {thumbnail ? (
          <>
            <img src={thumbnail} alt={asset.name} className={styles.thumbnail} draggable={false} />
            {asset.type === 'video' && (
              <div className={styles.playBadge}>
                <AppIcon name="play" size={10} color="white" />
              </div>
            )}
          </>
        ) : (
          <AppIcon name={meta.icon} size={28} color={meta.iconColor} />
        )}
      </div>

      {/* 底部文件名 */}
      <div className={styles.nameArea}>
        <span className={styles.name} title={asset.name}>
          {asset.name}
        </span>
      </div>
    </div>
  );
}
