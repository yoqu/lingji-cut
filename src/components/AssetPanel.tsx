import { useCallback, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { m } from 'framer-motion';
import type { AssetItem, AssetType } from '../types';
import { useTimelineStore } from '../store/timeline';
import { readAudioDurationMs } from '../lib/utils';
import { springs } from '../ui/lib/motion';
import type { PillGroupItem } from '../ui';
import {
  Button,
  ConfirmDialog,
  ContextMenu,
  PillGroup,
  SearchInput,
} from '../ui';
import { AppIcon } from './AppIcon';
import { AddTextCard, AssetCard, AssetImportCard } from './AssetCard';
import type { SourcePreviewAsset } from './SourceAssetPreviewPlayer';
import styles from './AssetPanel.module.css';

const EXTENSION_TO_ASSET_TYPE: Record<string, Extract<AssetType, 'video' | 'image' | 'audio' | 'srt'>> = {
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  m4v: 'video',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
  mp3: 'audio',
  wav: 'audio',
  aac: 'audio',
  m4a: 'audio',
  flac: 'audio',
  ogg: 'audio',
  opus: 'audio',
  srt: 'srt',
};

function resolveDroppedAssetType(fileName: string): Extract<AssetType, 'video' | 'image' | 'audio' | 'srt'> | null {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TO_ASSET_TYPE[ext] ?? null;
}

function resolveDroppedFilePath(file: File): string {
  const legacyPath = (file as File & { path?: string }).path;
  if (legacyPath) {
    return legacyPath;
  }
  try {
    return window.electronAPI?.getPathForFile(file) ?? '';
  } catch {
    return '';
  }
}

type AssetFilterKey = 'all' | AssetType;

const FILTER_OPTIONS: Array<PillGroupItem<AssetFilterKey>> = [
  { value: 'all', label: '全部' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'text', label: '文字' },
];

function matchesAssetFilter(asset: AssetItem, filter: AssetFilterKey, keyword: string): boolean {
  const normalizedKeyword = keyword.trim().toLowerCase();

  if (filter !== 'all' && asset.type !== filter) {
    return false;
  }

  if (!normalizedKeyword) {
    return true;
  }

  return asset.name.toLowerCase().includes(normalizedKeyword);
}

function getPathFileName(path: string): string {
  if (!path) {
    return '';
  }
  const normalizedPath = path.replace(/\\/g, '/');
  return normalizedPath.split('/').pop() ?? '';
}

function PodcastResourceSection({
  compact,
  expanded,
  onToggleExpanded,
  audioPath,
  srtPath,
  onReplaceAudio,
  onReplaceSrt,
  onRegenerateFromScript,
  regenerateFromScriptDisabled,
}: {
  compact: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  audioPath: string;
  srtPath: string;
  onReplaceAudio?: () => Promise<void>;
  onReplaceSrt?: () => Promise<void>;
  onRegenerateFromScript?: () => void;
  regenerateFromScriptDisabled?: boolean;
}) {
  const audioName = getPathFileName(audioPath);
  const srtName = getPathFileName(srtPath);

  return (
    <section className={styles.podcastSection} aria-label="口播资源">
      <Button.Ghost
        size="sm"
        className={styles.podcastSectionToggle}
        aria-expanded={expanded}
        onClick={onToggleExpanded}
      >
        <span className={styles.podcastSectionTitle}>
          <AppIcon
            name={expanded ? 'chevron-down' : 'chevron-right'}
            size={12}
            className={styles.podcastSectionChevron}
          />
          <span>口播资源</span>
        </span>
        {compact ? (
          <span className={styles.podcastSectionSummary}>
            {audioName || srtName ? '已配置' : '未设置'}
          </span>
        ) : null}
      </Button.Ghost>
      {expanded ? (
        <div className={styles.podcastSectionBody}>
          <div className={styles.podcastRow}>
            {/* Hero ② 共享元素目标:从 setup 页"导入音频" quickItem icon morph 而来 */}
            <m.span
              layoutId="setup-editor-audio"
              className={styles.podcastRowIcon}
              transition={springs.layout}
            >
              <AppIcon name="music" size={13} />
            </m.span>
            <span
              className={[
                styles.podcastRowName,
                audioName ? '' : styles.podcastRowNameEmpty,
              ].join(' ')}
              title={audioName || '未设置音频'}
            >
              {audioName || '未设置音频'}
            </span>
            <Button
              variant="secondary"
              size="sm"
              className={styles.podcastRowAction}
              onClick={() => void onReplaceAudio?.()}
            >
              {audioName ? '替换音频' : '+ 添加'}
            </Button>
          </div>
          <div className={styles.podcastRow}>
            <span className={styles.podcastRowIcon}>
              <AppIcon name="file-text" size={13} />
            </span>
            <span
              className={[
                styles.podcastRowName,
                srtName ? '' : styles.podcastRowNameEmpty,
              ].join(' ')}
              title={srtName || '未设置字幕'}
            >
              {srtName || '未设置字幕'}
            </span>
            <Button
              variant="secondary"
              size="sm"
              className={styles.podcastRowAction}
              onClick={() => void onReplaceSrt?.()}
            >
              {srtName ? '替换字幕' : '+ 添加'}
            </Button>
          </div>
          {onRegenerateFromScript ? (
            <Button
              variant="secondary"
              size="sm"
              fullWidth
              leftIcon={<AppIcon name="sparkles" size={12} />}
              className={styles.podcastRegenerateButton}
              onClick={onRegenerateFromScript}
              disabled={regenerateFromScriptDisabled}
              title="读取当前文稿（script.md），重新生成口播音频与字幕"
            >
              从文稿重新生成
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function AssetPanel({
  compact,
  railHeight,
  onAddAsset,
  onOpenSubtitleInspector,
  onAddTextOverlay,
  onPreviewAsset,
  selectedPreviewAssetPath,
  onUseAsPodcastAudio,
  onUseAsPodcastSrt,
  onReplaceAudio,
  onReplaceSrt,
  onRegeneratePodcastFromScript,
  regeneratePodcastFromScriptDisabled,
}: {
  compact: boolean;
  railHeight?: number;
  onAddAsset?: () => Promise<void>;
  onOpenSubtitleInspector?: () => void;
  onAddTextOverlay?: () => void;
  onPreviewAsset?: (asset: SourcePreviewAsset) => void;
  selectedPreviewAssetPath?: string | null;
  onUseAsPodcastAudio?: (path: string, durationMs: number) => Promise<void>;
  onUseAsPodcastSrt?: (path: string) => Promise<void>;
  onReplaceAudio?: () => Promise<void>;
  onReplaceSrt?: () => Promise<void>;
  onRegeneratePodcastFromScript?: () => void;
  regeneratePodcastFromScriptDisabled?: boolean;
}) {
  const { addAsset, assets, removeAsset, setGlobalBackground, timeline } = useTimelineStore();
  const [keyword, setKeyword] = useState('');
  const [activeFilter, setActiveFilter] = useState<AssetFilterKey>('all');
  const [pendingRemovalPath, setPendingRemovalPath] = useState<string | null>(null);
  const [podcastExpanded, setPodcastExpanded] = useState(!compact);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const dragDepthRef = useRef(0);
  const draggingAssetPathRef = useRef<string | null>(null);

  const handleAddAsset = useCallback(async () => {
    if (onAddAsset) {
      await onAddAsset();
      return;
    }

    const asset = await window.electronAPI.addAsset();
    if (!asset) {
      return;
    }

    addAsset(asset.path, asset.type, asset.durationMs);
  }, [addAsset, onAddAsset]);

  const handleDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types ?? []).includes('Files')) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDropTarget(true);
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types ?? []).includes('Files')) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types ?? []).includes('Files')) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDropTarget(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLElement>) => {
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = 0;
      setIsDropTarget(false);

      for (const file of files) {
        const assetType = resolveDroppedAssetType(file.name);
        if (!assetType) {
          continue;
        }
        const filePath = resolveDroppedFilePath(file);
        if (!filePath) {
          continue;
        }

        let durationMs = assetType === 'image' ? 5000 : 10000;
        if (assetType === 'video' || assetType === 'audio') {
          try {
            const decoded = await readAudioDurationMs(filePath);
            if (decoded > 0) {
              durationMs = decoded;
            }
          } catch (error) {
            console.warn('读取拖入媒体时长失败，使用默认时长:', error);
          }
        }

        addAsset(filePath, assetType, durationMs);
      }
    },
    [addAsset],
  );

  const getAssetUsageCount = useCallback(
    (path: string) => timeline.overlays.filter((overlay) => overlay.assetPath === path).length,
    [timeline.overlays],
  );

  const handleRemoveAsset = useCallback(
    (path: string) => {
      const usageCount = getAssetUsageCount(path);
      if (usageCount > 0) {
        setPendingRemovalPath(path);
        return;
      }

      removeAsset(path);
    },
    [getAssetUsageCount, removeAsset],
  );

  const visibleAssets = assets.filter((asset) =>
    matchesAssetFilter(asset, activeFilter, compact ? '' : keyword),
  );
  const pendingRemovalUsageCount = pendingRemovalPath ? getAssetUsageCount(pendingRemovalPath) : 0;

  return (
    <aside
      className={[
        styles.root,
        compact ? styles.compact : styles.regular,
        isDropTarget ? styles.dropTarget : '',
      ].filter(Boolean).join(' ')}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(event) => void handleDrop(event)}
    >
      <PodcastResourceSection
        compact={compact}
        expanded={podcastExpanded}
        onToggleExpanded={() => setPodcastExpanded((current) => !current)}
        audioPath={timeline.podcast?.audioPath ?? ''}
        srtPath={timeline.podcast?.srtPath ?? ''}
        onReplaceAudio={onReplaceAudio}
        onReplaceSrt={onReplaceSrt}
        onRegenerateFromScript={onRegeneratePodcastFromScript}
        regenerateFromScriptDisabled={regeneratePodcastFromScriptDisabled}
      />

      {/* 搜索栏 — compact 时通过 CSS 隐藏 */}
      {!compact && (
        <div className={styles.searchWrap}>
          <SearchInput
            size="sm"
            value={keyword}
            placeholder="搜索素材…"
            aria-label="搜索素材"
            wrapperClassName={styles.searchInputWrap}
            className={styles.searchInput}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
      )}

      {/* 筛选 pill — compact 时隐藏 */}
      {!compact && (
        <div className={styles.filterRow}>
          <PillGroup
            items={FILTER_OPTIONS}
            value={activeFilter}
            onChange={setActiveFilter}
            size="sm"
            wrap={false}
            className={styles.filterGroup}
            itemClassName={styles.filterPill}
          />
        </div>
      )}

      {/* compact 模式下的计数摘要 */}
      {compact && (
        <div className={styles.compactSummary}>素材库 · {visibleAssets.length} 项</div>
      )}

      {/* 素材网格 / 文字添加按钮 */}
      <div
        className={[
          styles.content,
          compact ? styles.contentCompact : '',
        ].filter(Boolean).join(' ')}
      >
        {activeFilter === 'text' ? (
          /* 文字 tab — 只显示一个与导入卡片同规格的添加按钮 */
          <div className={compact ? styles.gridCompact : styles.grid}>
            <AddTextCard onClick={onAddTextOverlay} />
          </div>
        ) : (
          <div className={compact ? styles.gridCompact : styles.grid}>
            {visibleAssets.map((asset) => {
              const actionLabel =
                asset.type === 'audio'
                  ? '设为音频轨'
                  : asset.type === 'srt'
                    ? '设为字幕轨'
                    : null;
              const handleAssetAction =
                asset.type === 'audio'
                  ? () => void onUseAsPodcastAudio?.(asset.path, asset.durationMs)
                  : asset.type === 'srt'
                    ? () => void onUseAsPodcastSrt?.(asset.path)
                    : undefined;
              const cardNode = (
                <div
                  data-asset-context-menu={asset.type === 'image' ? 'image-background' : undefined}
                >
                  <AssetCard
                    asset={asset}
                    compact={compact}
                    usageCount={getAssetUsageCount(asset.path)}
                    onRemove={handleRemoveAsset}
                    selected={selectedPreviewAssetPath === asset.path}
                    onClick={
                      asset.type === 'image' || asset.type === 'video'
                        ? () => {
                            if (draggingAssetPathRef.current === asset.path) {
                              return;
                            }
                            onPreviewAsset?.(asset);
                          }
                        : asset.type === 'srt'
                          ? onOpenSubtitleInspector
                          : undefined
                    }
                    onDragStart={(event) => {
                      if (asset.locked) {
                        event.preventDefault();
                        return;
                      }
                      if (
                        asset.type !== 'image' &&
                        asset.type !== 'video' &&
                        asset.type !== 'text' &&
                        asset.type !== 'audio'
                      ) {
                        event.preventDefault();
                        return;
                      }
                      draggingAssetPathRef.current = asset.path;
                      event.dataTransfer.effectAllowed = 'copy';
                      event.dataTransfer.setData('application/json', JSON.stringify(asset));
                    }}
                    onDragEnd={() => {
                      window.setTimeout(() => {
                        if (draggingAssetPathRef.current === asset.path) {
                          draggingAssetPathRef.current = null;
                        }
                      }, 0);
                    }}
                  />
                </div>
              );

              const hasContextMenu = asset.type === 'image' || !asset.locked;

              return (
                <div key={asset.path} className={styles.assetSlot}>
                  {hasContextMenu ? (
                    <ContextMenu>
                      <ContextMenu.Trigger asChild>{cardNode}</ContextMenu.Trigger>
                      <ContextMenu.Content>
                        {asset.type === 'image' ? (
                          <ContextMenu.Item onSelect={() => setGlobalBackground(asset.path)}>
                            设为整期背景
                          </ContextMenu.Item>
                        ) : null}
                        {!asset.locked ? (
                          <>
                            {asset.type === 'image' ? <ContextMenu.Separator /> : null}
                            <ContextMenu.Item
                              destructive
                              onSelect={() => handleRemoveAsset(asset.path)}
                            >
                              移除素材
                            </ContextMenu.Item>
                          </>
                        ) : null}
                      </ContextMenu.Content>
                    </ContextMenu>
                  ) : (
                    cardNode
                  )}
                  {actionLabel && handleAssetAction ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className={styles.assetAction}
                      onClick={handleAssetAction}
                    >
                      {actionLabel}
                    </Button>
                  ) : null}
                </div>
              );
            })}

            {/* 导入 ghost 卡片 — 始终显示在末尾 */}
            <AssetImportCard onClick={() => void handleAddAsset()} />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(pendingRemovalPath)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRemovalPath(null);
          }
        }}
        title="删除素材"
        description={
          pendingRemovalPath
            ? pendingRemovalUsageCount > 0
              ? `该素材已在底部轨道中使用 ${pendingRemovalUsageCount} 次，删除后会同步移除所有相关轨道块。确认继续吗？`
              : '确认移除该素材吗？'
            : undefined
        }
        confirmText="确认删除"
        cancelText="取消"
        confirmVariant="destructive"
        onConfirm={() => {
          if (pendingRemovalPath) {
            removeAsset(pendingRemovalPath);
          }
          setPendingRemovalPath(null);
        }}
      />
    </aside>
  );
}
