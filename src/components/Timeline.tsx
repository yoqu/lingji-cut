import type { CSSProperties, DragEvent, MouseEvent, ReactNode, MouseEvent as ReactMouseEvent } from 'react';
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { m, useMotionValue, useSpring } from 'framer-motion';
import { ConfirmDialog, ContextMenu } from '../ui';
import type { TrackDragZone } from '../lib/overlay-drag';
import {
  getTimelineContextMenuItems,
  type TimelineContextMenuActionKey,
} from '../lib/timeline-context-menu';
import {
  getAudioOverlayTracks,
  getRenderableVisualTracks,
  getVisualTracks,
} from '../lib/timeline-tracks';
import { filterValidSubtitleHighlights } from '../lib/subtitle-highlights';
import { formatTimecode, getEffectiveTimelineDurationMs } from '../lib/utils';
import {
  clampTimelineZoom,
  getBaseTimelineWidth,
  getCenteredPlayheadScrollLeft,
  getContinuousTimelineZoom,
  getTimelineContentWidthPx,
  getTimelineVisualEndMs,
  getTimelineWheelZoomMode,
  getWheelTimelineZoom,
} from '../lib/timeline-view';
import { canPlaceAt } from '../lib/timeline-placement';
import { computeSnap, type SnapTarget } from '../lib/timeline-snap';
import {
  startAutoScroll,
  type AutoScrollScheduler,
} from '../lib/timeline-autoscroll';
import type { OverlayItem, TimelineTrack } from '../types';
import { createDefaultAudioOverlayData } from '../types';
import { readAudioDurationMs } from '../lib/utils';
import { getTextTemplateById } from '../lib/text-templates';
import { useTimelineStore } from '../store/timeline';
import { useAIStore } from '../store/ai';
import { v4 as uuid } from 'uuid';
import { AppIcon } from './AppIcon';
import { OverlayBlock } from './OverlayBlock';
import { TimelineAudioWaveform } from './TimelineAudioWaveform';
import { TimelineSubtitleBlocks } from './TimelineSubtitleBlocks';
import { SubtitleCardDialog } from './SubtitleCardDialog';
import { TimelineToolbar } from './timeline/TimelineToolbar';
import { TrackDropZone } from './timeline/TrackDropZone';
import { SnapGuides } from './timeline/SnapGuides';
import styles from './Timeline.module.css';
import type { ManualCardKind } from '../lib/manual-card-types';

interface TimelineProps {
  currentTimeMs: number;
  isPlaying?: boolean;
  onSeek: (ms: number) => void;
  /** 播放头拖动开始（mousedown）。用于「拖动时暂停、松手续播」。 */
  onSeekStart?: () => void;
  /** 播放头拖动结束（mouseup）。 */
  onSeekEnd?: () => void;
  compact: boolean;
  onOpenAICardInspector?: (cardId: string) => void;
  onOpenOverlayInspector?: (overlayId: string) => void;
  onOpenSubtitleInspector?: () => void;
}

interface PendingTrackDeletion {
  trackId: string;
  trackLabel: string;
  overlayCount: number;
}

interface OverlayDragState {
  overlayId: string;
  collision: boolean;
  snapTargets: SnapTarget[];
  /** UI 屏幕顺序的 gap 索引(0 = 屏幕最顶, N = 屏幕最底);null 表示落在普通轨道上 */
  dropGapIndex: number | null;
  candidateStartMs: number;
  candidateTrackId: string;
  /** 基于 DOM 实测的 Y 方向像素偏移,仅用于拖拽预览的 translateY */
  previewDeltaY: number;
}

interface AssetLike {
  path: string;
  type: 'video' | 'image' | 'text' | 'audio';
  durationMs: number;
  overlayRole?: 'default-background';
}

type TimelineContextTarget =
  | {
      kind: 'track';
      trackId: string;
      startMs: number;
    }
  | {
      kind: 'overlay';
      overlayId: string;
      trackId: string;
      startMs: number;
    };

export function Timeline({
  currentTimeMs,
  isPlaying = false,
  onSeek,
  onSeekStart,
  onSeekEnd,
  compact,
  onOpenAICardInspector,
  onOpenOverlayInspector,
  onOpenSubtitleInspector,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const pendingScrollLeftRef = useRef<number | null>(null);
  const trackLaneRefs = useRef<Record<string, HTMLDivElement | null>>({});
  /** 每条 visual 轨道的整行 DOM(含 sidebar),用于 drag preview Y 偏移测量 */
  const trackRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  /** 每个 visual gap 槽位的 DOM,gapRefs.current[i] 对应屏幕顺序第 i 个 gap */
  const gapRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [hoverTrackId, setHoverTrackId] = useState<string | null>(null);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [contextTarget, setContextTarget] = useState<TimelineContextTarget | null>(null);
  const [subtitleCardDialogOpen, setSubtitleCardDialogOpen] = useState(false);
  const [subtitleCardDialogInitial, setSubtitleCardDialogInitial] = useState<{
    text: string;
    startMs: number;
    endMs: number;
    kind?: ManualCardKind;
  } | null>(null);
  const [pendingTrackDeletion, setPendingTrackDeletion] = useState<PendingTrackDeletion | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [dragState, setDragState] = useState<OverlayDragState | null>(null);
  const dragStateRef = useRef<OverlayDragState | null>(null);
  const autoScrollRef = useRef<AutoScrollScheduler | null>(null);
  useEffect(() => {
    dragStateRef.current = dragState;
  }, [dragState]);
  const {
    addOverlay,
    addTrack,
    copyOverlay,
    cutOverlay,
    overlayClipboard,
    pasteOverlay,
    removeOverlay,
    removeTrack,
    setGlobalBackground,
    srtEntries,
    timeline,
  } = useTimelineStore();
  // 考虑动画 / 媒体 overlay 末端，没素材时也保证尺子能容纳已经添加的卡片
  const durationMs = useMemo(() => getEffectiveTimelineDurationMs(timeline), [timeline]);
  // 内容末端（不含尾部留白）：用于 pxPerMs 推导与 seek clamp
  const visualEndMs = useMemo(
    () => Math.max(1, getTimelineVisualEndMs(timeline), durationMs),
    [timeline, durationMs],
  );
  const outerPadding = compact ? 8 : 10;
  const sidebarWidth = compact ? 48 : 56;
  const toolbarHeight = compact ? 36 : 40;
  const rulerHeight = 24;
  const audioTrackHeight = compact ? 26 : 30;
  const subtitleTrackHeight = compact ? 52 : 60;
  const overlayTrackHeight = compact ? 30 : 34;
  // 轨道内容区宽度（含尾部一屏留白）。替代旧的 trackWidth。
  const contentWidth = useMemo(
    () =>
      getTimelineContentWidthPx(timeline, zoomLevel, Math.max(480, viewportWidth || 960)),
    [timeline, viewportWidth, zoomLevel],
  );
  // pxPerMs 基于"有效内容末端"反推，保持 1 秒在屏幕上的像素密度恒定；
  // 留白区由 contentWidth 本身提供，不改变秒的视觉密度。
  const pxPerMs = useMemo(() => {
    const clampedZoom = clampTimelineZoom(zoomLevel);
    const basePx = getBaseTimelineWidth(visualEndMs) * clampedZoom;
    return basePx / visualEndMs;
  }, [visualEndMs, zoomLevel]);
  const trackColumns = `${sidebarWidth}px ${contentWidth}px`;
  const visualTracks = useMemo(() => getVisualTracks(timeline.tracks), [timeline.tracks]);
  const audioOverlayTracks = useMemo(
    () => getAudioOverlayTracks(timeline.tracks),
    [timeline.tracks],
  );
  // 轨道数变动时裁剪 gapRefs 数组,避免保留已卸载的 DOM 引用
  useEffect(() => {
    const expected = visualTracks.length + 1;
    if (gapRefs.current.length > expected) {
      gapRefs.current.length = expected;
    }
  }, [visualTracks.length]);
  const renderableTracks = useMemo(
    () => getRenderableVisualTracks(timeline.tracks),
    [timeline.tracks],
  );
  // canvas 外层总宽度（含左侧 sidebar），用于最外层 DOM 布局
  const canvasWidth = sidebarWidth + contentWidth;
  // 目标:一个 major tick 大致占 90px,按 pxPerMs 反推合适的时间粒度
  const majorTickInterval = useMemo(() => {
    const TARGET_PX = 90;
    const CANDIDATES = [
      10, 20, 50, 100, 200, 500,
      1_000, 2_000, 5_000,
      10_000, 15_000, 30_000,
      60_000, 120_000, 300_000, 600_000,
    ];
    if (pxPerMs <= 0) return 5_000;
    for (const step of CANDIDATES) {
      if (step * pxPerMs >= TARGET_PX) return step;
    }
    return CANDIDATES[CANDIDATES.length - 1];
  }, [pxPerMs]);
  // 每个 major 下面 5 个 minor(不带标签)
  const minorTickInterval = useMemo(
    () => Math.max(1, majorTickInterval / 5),
    [majorTickInterval],
  );
  // ruler 覆盖整条内容区（含尾部留白），按 pxPerMs 反推最大刻度 ms
  const totalRulerMs = useMemo(
    () => (pxPerMs > 0 ? Math.floor(contentWidth / pxPerMs) : visualEndMs),
    [contentWidth, pxPerMs, visualEndMs],
  );
  const ticks = useMemo(() => {
    const list: Array<{ ms: number; isMajor: boolean }> = [];
    const step = minorTickInterval;
    if (step <= 0) return list;
    // 为避免浮点累积误差，用整数索引驱动
    const maxIndex = Math.floor(totalRulerMs / step);
    for (let i = 0; i <= maxIndex; i += 1) {
      const ms = Math.round(i * step);
      const isMajor = i % 5 === 0;
      list.push({ ms, isMajor });
    }
    const last = list[list.length - 1];
    if (!last || last.ms !== totalRulerMs) {
      list.push({ ms: totalRulerMs, isMajor: true });
    }
    return list;
  }, [totalRulerMs, minorTickInterval]);
  const overlaysByTrack = useMemo(() => {
    const groups = new Map<string, typeof timeline.overlays>();

    for (const track of renderableTracks) {
      groups.set(track.id, []);
    }
    for (const track of audioOverlayTracks) {
      groups.set(track.id, []);
    }

    for (const overlay of timeline.overlays) {
      const group = groups.get(overlay.trackId);
      if (group) {
        group.push(overlay);
      }
    }

    return groups;
  }, [renderableTracks, audioOverlayTracks, timeline.overlays]);
  const validSubtitleHighlights = useMemo(
    () => filterValidSubtitleHighlights(srtEntries, timeline.subtitleHighlights ?? []),
    [srtEntries, timeline.subtitleHighlights],
  );
  const storedSubtitleHighlightCount = timeline.subtitleHighlights?.length ?? 0;
  const expiredSubtitleHighlightCount = Math.max(
    0,
    storedSubtitleHighlightCount - validSubtitleHighlights.length,
  );
  const subtitleHighlightHint = useMemo(() => {
    if (!timeline.podcast.srtPath) {
      return '';
    }

    if (expiredSubtitleHighlightCount > 0) {
      return validSubtitleHighlights.length > 0 ? '部分高亮已过期' : '高亮已过期';
    }

    if (validSubtitleHighlights.length > 0) {
      return '';
    }

    return storedSubtitleHighlightCount > 0 ? '高亮已过期' : '未生成高亮';
  }, [
    expiredSubtitleHighlightCount,
    storedSubtitleHighlightCount,
    timeline.podcast.srtPath,
    validSubtitleHighlights.length,
  ]);
  const subtitleHighlightSummary = useMemo(() => {
    if (!timeline.podcast.srtPath) {
      return '等待导入字幕';
    }

    if (storedSubtitleHighlightCount === 0) {
      return '尚未生成关键词高亮';
    }

    if (expiredSubtitleHighlightCount > 0) {
      return validSubtitleHighlights.length > 0
        ? `${validSubtitleHighlights.length} 处有效 · ${expiredSubtitleHighlightCount} 处过期`
        : '当前高亮结果已全部失效';
    }

    return `${validSubtitleHighlights.length} 处关键词高亮已就绪`;
  }, [
    expiredSubtitleHighlightCount,
    storedSubtitleHighlightCount,
    timeline.podcast.srtPath,
    validSubtitleHighlights.length,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let rafId = 0;
    const updateWidth = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const next = container.clientWidth - outerPadding * 2 - sidebarWidth;
        // 仅在宽度实际变化时更新，避免 ResizeObserver → state → layout 振荡
        setViewportWidth((prev) => (prev === next ? prev : next));
      });
    };

    updateWidth();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth);
      return () => {
        cancelAnimationFrame(rafId);
        window.removeEventListener('resize', updateWidth);
      };
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [outerPadding, sidebarWidth]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || pendingScrollLeftRef.current === null) {
      return;
    }

    container.scrollLeft = pendingScrollLeftRef.current;
    pendingScrollLeftRef.current = null;
  }, [contentWidth]);

  const gridBackground = useMemo(() => {
    const major = Math.max(40, majorTickInterval * pxPerMs);
    const minor = Math.max(8, minorTickInterval * pxPerMs);

    return {
      backgroundImage: [
        `repeating-linear-gradient(to right, color-mix(in srgb, var(--color-border-strong) 48%, transparent) 0 1px, transparent 1px ${major}px)`,
        `repeating-linear-gradient(to right, color-mix(in srgb, var(--color-border-subtle) 62%, transparent) 0 1px, transparent 1px ${minor}px)`,
      ].join(','),
      backgroundColor: 'var(--color-recessed-bg)',
    } satisfies CSSProperties;
  }, [majorTickInterval, minorTickInterval, pxPerMs]);

  const resolveTimelineOffset = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();

    if (!rect) {
      return null;
    }

    const offsetX =
      clientX -
      rect.left +
      (containerRef.current?.scrollLeft || 0) -
      outerPadding -
      sidebarWidth;

    return offsetX;
  };

  const resolveContextMenuStartMs = useCallback(
    (clientX: number) => {
      const offsetX = resolveTimelineOffset(clientX);
      if (offsetX === null) {
        return 0;
      }

      return Math.max(0, Math.min(visualEndMs, Math.round(offsetX / pxPerMs)));
    },
    [visualEndMs, pxPerMs],
  );

  const canPasteOverlay = Boolean(overlayClipboard);

  const handleOverlayContextMenu = useCallback(
    (overlayId: string, trackId: string, clientX: number) => {
      setSelectedOverlayId(overlayId);
      setContextTarget({
        kind: 'overlay',
        overlayId,
        trackId,
        startMs: resolveContextMenuStartMs(clientX),
      });
    },
    [resolveContextMenuStartMs],
  );

  const handleTrackContextMenu = useCallback(
    (trackId: string, clientX: number) => {
      setSelectedOverlayId(null);
      setContextTarget({
        kind: 'track',
        trackId,
        startMs: resolveContextMenuStartMs(clientX),
      });
    },
    [resolveContextMenuStartMs],
  );

  const handleContextMenuAction = useCallback(
    (
      action: TimelineContextMenuActionKey,
      options: {
        overlayId?: string;
        trackId: string;
        startMs: number;
      },
    ) => {
      if (action === 'copy') {
        if (options.overlayId) {
          copyOverlay(options.overlayId);
        }
        return;
      }

      if (action === 'cut') {
        if (!options.overlayId) {
          return;
        }
        if (cutOverlay(options.overlayId) && selectedOverlayId === options.overlayId) {
          setSelectedOverlayId(null);
        }
        return;
      }

      if (action === 'paste') {
        const pastedOverlayId = pasteOverlay({
          trackId: options.trackId,
          startMs: options.startMs,
        });

        if (pastedOverlayId) {
          setSelectedOverlayId(pastedOverlayId);
        }
        return;
      }

      if (action === 'insert-image-card' || action === 'insert-video-card') {
        const aiStore = useAIStore.getState();
        const segmentId = `manual:${uuid()}`;
        const create =
          action === 'insert-image-card'
            ? aiStore.createImageCard(segmentId, {
                aspectRatio: '16:9',
                displayMode: 'fullscreen',
              })
            : aiStore.createVideoCard(segmentId, {
                aspectRatio: '16:9',
                displayMode: 'fullscreen',
              });
        void create.then((card) => {
          onOpenAICardInspector?.(card.id);
        });
        return;
      }

      if (action === 'convert-to-motion') {
        if (!options.overlayId) {
          return;
        }
        const overlay = useTimelineStore
          .getState()
          .timeline.overlays.find((o) => o.id === options.overlayId);
        const sourceCardId = overlay?.aiCardData?.sourceCardId;
        if (overlay?.overlayType === 'ai-card' && sourceCardId) {
          void useAIStore.getState().convertCardToMotion(sourceCardId);
        }
        return;
      }

      if (!options.overlayId) {
        return;
      }

      removeOverlay(options.overlayId);
      if (selectedOverlayId === options.overlayId) {
        setSelectedOverlayId(null);
      }
    },
    [copyOverlay, cutOverlay, pasteOverlay, removeOverlay, selectedOverlayId, onOpenAICardInspector],
  );

  const renderContextMenuItems = useCallback(
    (
      items: ReturnType<typeof getTimelineContextMenuItems>,
      options: {
        overlayId?: string;
        trackId: string;
        startMs: number;
      },
    ) =>
      items.map((item) => (
        <Fragment key={item.key}>
          {item.separatorBefore ? <ContextMenu.Separator /> : null}
          <ContextMenu.Item
            disabled={item.disabled}
            destructive={item.destructive}
            onSelect={() => handleContextMenuAction(item.key, options)}
          >
            <div className={styles.contextMenuItem}>
              <AppIcon name={item.icon} size={14} className={styles.contextMenuIcon} />
              <span className={styles.contextMenuLabel}>{item.label}</span>
              <ContextMenu.Shortcut>{item.shortcut}</ContextMenu.Shortcut>
            </div>
          </ContextMenu.Item>
        </Fragment>
      )),
    [handleContextMenuAction],
  );

  const handleSeekClick = (event: MouseEvent<HTMLDivElement>) => {
    // 点击轨道空白区域时取消选中
    const target = event.target as HTMLElement;
    if (!target.closest(`.${styles.overlayRow} [data-overlay-block]`)) {
      setSelectedOverlayId(null);
    }

    const offsetX = resolveTimelineOffset(event.clientX);

    if (offsetX === null || offsetX < 0) {
      return;
    }

    onSeek(Math.max(0, Math.min(visualEndMs, Math.round(offsetX / pxPerMs))));
  };

  const handleRulerMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rulerEl = rulerRef.current;
    if (!rulerEl) return;

    // 阻止冒泡到 scrollArea 的 onClick，避免 handleSeekClick 重复 seek
    event.stopPropagation();
    event.preventDefault();

    const rect = rulerEl.getBoundingClientRect();

    const seekTo = (clientX: number, allowSnap: boolean) => {
      // rulerMain 位于可滚动内容内部，rect.left 已随滚动变化，
      // 因此 clientX - rect.left 已是内容局部坐标，无需再加 scrollLeft
      const localX = clientX - rect.left;
      const rawMs = Math.max(0, localX / pxPerMs);
      const snapped = allowSnap && snapEnabled
        ? computeSnap({
            candidateMs: rawMs,
            playheadMs: rawMs,
            overlays: timeline.overlays,
            pxPerMs,
            thresholdPx: 8,
            enabled: true,
          }).snappedMs
        : rawMs;
      const clamped = Math.max(0, Math.min(visualEndMs, Math.round(snapped)));
      onSeek(clamped);
    };

    onSeekStart?.();
    seekTo(event.clientX, !event.altKey);

    const onMove = (ev: globalThis.MouseEvent) => {
      seekTo(ev.clientX, !ev.altKey);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      onSeekEnd?.();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleRulerClick = (event: MouseEvent<HTMLDivElement>) => {
    // mousedown 已处理 seek，click 事件只负责阻止冒泡到 scrollArea
    event.stopPropagation();
  };

  // 缩放（工具栏按钮 / 百分比 / 适应 / 1:1，以及 Cmd/Ctrl+滚轮、触摸板 pinch）
  // 统一让播放头竖条保持水平居中：内容以竖条为中心两侧等比例展开 / 收缩，
  // 竖条始终钉在可视区正中（靠近时间线起点时受 scrollLeft≥0 限制而无法再左移）。
  const handleZoomChange = useCallback(
    (nextZoomRaw: number) => {
      const nextZoom = clampTimelineZoom(nextZoomRaw);
      const container = containerRef.current;
      const clampedPrev = clampTimelineZoom(zoomLevel);
      if (container && nextZoom !== clampedPrev && clampedPrev > 0) {
        const visibleTrackWidth = Math.max(
          1,
          container.clientWidth - sidebarWidth - outerPadding * 2,
        );
        // 缩放后播放头在内容坐标中的新偏移（pxPerMs 与 zoom 成正比）
        const nextPlayheadPx = currentTimeMs * pxPerMs * (nextZoom / clampedPrev);
        pendingScrollLeftRef.current = getCenteredPlayheadScrollLeft(
          nextPlayheadPx,
          visibleTrackWidth,
        );
      }
      setZoomLevel(nextZoom);
    },
    [zoomLevel, sidebarWidth, outerPadding, currentTimeMs, pxPerMs],
  );

  const handleWheelZoom = useCallback(
    (event: WheelEvent) => {
      const zoomMode = getTimelineWheelZoomMode(event);
      if (!zoomMode) {
        return;
      }
      if (!containerRef.current) {
        return;
      }

      event.preventDefault();

      const nextZoom =
        zoomMode === 'pinch'
          ? getContinuousTimelineZoom(zoomLevel, event.deltaY, event.deltaMode)
          : getWheelTimelineZoom(zoomLevel, event.deltaY);
      if (nextZoom === zoomLevel) {
        return;
      }

      handleZoomChange(nextZoom);
    },
    [zoomLevel, handleZoomChange],
  );

  // 定位按钮：把视窗平滑滚动到播放头水平居中位置。
  const focusPlayhead = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const visibleTrackWidth = Math.max(
      1,
      container.clientWidth - sidebarWidth - outerPadding * 2,
    );
    const left = getCenteredPlayheadScrollLeft(
      currentTimeMs * pxPerMs,
      visibleTrackWidth,
    );
    container.scrollTo({ left, behavior: 'smooth' });
  }, [sidebarWidth, outerPadding, currentTimeMs, pxPerMs]);

  // 通过 ref 保持最新版本的 handler，避免 native listener 中的 stale closure
  const handleWheelZoomRef = useRef(handleWheelZoom);
  useEffect(() => {
    handleWheelZoomRef.current = handleWheelZoom;
  });

  // 使用 non-passive 原生监听器，确保 event.preventDefault() 生效，
  // 防止浏览器 page-level zoom 干扰触摸板 pinch 缩放
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handler = (event: WheelEvent) => handleWheelZoomRef.current(event);
    container.addEventListener('wheel', handler, { passive: false });
    return () => container.removeEventListener('wheel', handler);
  }, []);

  // 键盘快捷键：S 分割、⌘Z 撤销、⌘⇧Z / ⌘Y 重做
  const splitCtxRef = useRef({ currentTimeMs, selectedOverlayId });
  useEffect(() => {
    splitCtxRef.current = { currentTimeMs, selectedOverlayId };
  }, [currentTimeMs, selectedOverlayId]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return true;
      }
      if (target.isContentEditable) {
        return true;
      }
      return false;
    };

    const handler = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return;
      }

      const mod = event.metaKey || event.ctrlKey;

      if (mod && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault();
        if (event.shiftKey) {
          useTimelineStore.getState().redo();
        } else {
          useTimelineStore.getState().undo();
        }
        return;
      }

      if (mod && (event.key === 'y' || event.key === 'Y')) {
        event.preventDefault();
        useTimelineStore.getState().redo();
        return;
      }

      if (!mod && !event.altKey && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        const { currentTimeMs: nowMs, selectedOverlayId: selId } = splitCtxRef.current;
        useTimelineStore
          .getState()
          .splitOverlayClipsAt(nowMs, selId ? [selId] : undefined);
        return;
      }

      if (!mod && (event.key === 'Delete' || event.key === 'Backspace')) {
        const { selectedOverlayId: selId } = splitCtxRef.current;
        if (!selId) return;
        const state = useTimelineStore.getState();
        const target = state.timeline.overlays.find((o) => o.id === selId);
        if (!target || target.overlayRole === 'default-background') return;
        event.preventDefault();
        state.removeOverlay(selId);
        setSelectedOverlayId(null);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const placeAssetOnTrack = (trackId: string, asset: AssetLike, clientX: number) => {
    if (asset.overlayRole === 'default-background') {
      setGlobalBackground(asset.path);
      return;
    }

    const offsetX = resolveTimelineOffset(clientX);
    if (offsetX === null) {
      return;
    }

    const startMs = Math.max(0, Math.round(offsetX / pxPerMs));

    // 文字模板处理
    if (asset.type === 'text') {
      const template = getTextTemplateById(asset.path);
      if (!template) return;
      addOverlay({
        type: 'text',
        assetPath: '',
        trackId,
        startMs,
        durationMs: asset.durationMs,
        position: {
          x: (timeline.width - 800) / 2,
          y: (timeline.height - 200) / 2,
          width: 800,
          height: 200,
        },
        textData: { ...template.textData },
      });
      return;
    }

    // 音频素材：落到音频 overlay 轨（若目标非 audio kind，则回落到已有音频轨或由 store 新建）
    if (asset.type === 'audio') {
      const targetTrack = timeline.tracks.find((t) => t.id === trackId);
      const resolvedTrackId =
        targetTrack && targetTrack.kind === 'audio' && targetTrack.id !== 'audio'
          ? trackId
          : audioOverlayTracks[0]?.id ?? 'audio-overlay-1';

      const insertOverlay = (durationMs: number) => {
        addOverlay({
          type: 'audio',
          assetPath: asset.path,
          trackId: resolvedTrackId,
          startMs,
          durationMs,
          position: { x: 0, y: 0, width: 0, height: 0 },
          audioData: createDefaultAudioOverlayData(durationMs),
        });
      };

      // 异步读取真实时长，失败则使用 asset.durationMs 兜底
      void readAudioDurationMs(asset.path)
        .then((decoded) => {
          const finalDuration = decoded > 0 ? decoded : asset.durationMs;
          insertOverlay(finalDuration);
        })
        .catch((error) => {
          console.warn('读取拖入音频时长失败，使用素材库缓存值:', error);
          insertOverlay(asset.durationMs);
        });
      return;
    }

    addOverlay({
      type: asset.type,
      assetPath: asset.path,
      trackId,
      startMs,
      durationMs: asset.durationMs,
      position: {
        x: 0,
        y: 0,
        width: timeline.width,
        height: timeline.height,
      },
    });
  };

  const handleTrackDrop =
    (trackId: string) =>
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setHoverTrackId(null);
      const raw = event.dataTransfer.getData('application/json');

      if (!raw) {
        return;
      }

      placeAssetOnTrack(trackId, JSON.parse(raw) as AssetLike, event.clientX);
    };

  const getTrackDragZones = (): TrackDragZone[] => {
    return visualTracks.flatMap((track) => {
      const trackLane = trackLaneRefs.current[track.id];
      if (!trackLane) {
        return [];
      }

      const rect = trackLane.getBoundingClientRect();
      return [
        {
          trackId: track.id,
          top: rect.top,
          bottom: rect.bottom,
        },
      ];
    });
  };

  // ── Gap hit test ──
  // 用 track row 的 DOM rect 判断鼠标 Y 是否靠近某条轨道交界处(±4px)。
  // 返回屏幕顺序的 gap 索引(0=最顶, N=最底),未命中返回 null。
  const GAP_HIT_RADIUS_PX = 4;
  const resolveGapIndex = (clientY: number): number | null => {
    if (visualTracks.length === 0) return null;

    const rects: DOMRect[] = [];
    for (const track of visualTracks) {
      const el = trackRowRefs.current[track.id];
      if (!el) return null;
      rects.push(el.getBoundingClientRect());
    }

    // gap 0:第一条轨道之前(屏幕最顶)
    if (Math.abs(clientY - rects[0].top) <= GAP_HIT_RADIUS_PX) {
      return 0;
    }
    // gap i (1..N-1):相邻轨道交界
    for (let i = 1; i < rects.length; i += 1) {
      const boundary = (rects[i - 1].bottom + rects[i].top) / 2;
      if (Math.abs(clientY - boundary) <= GAP_HIT_RADIUS_PX) {
        return i;
      }
    }
    // gap N:最后一条轨道之后(屏幕最底)
    if (Math.abs(clientY - rects[rects.length - 1].bottom) <= GAP_HIT_RADIUS_PX) {
      return rects.length;
    }
    return null;
  };

  /**
   * 将 UI 层屏幕顺序的 gapIndex 转换为 store 层 asc-order 的 gapIndex。
   * UI gap 0(屏幕最顶)= store gap N;UI gap N(屏幕最底)= store gap 0。
   */
  const uiGapToStoreGap = (uiGapIndex: number, visualCount: number): number =>
    visualCount - uiGapIndex;

  // ── Drag 相关 refs(必须在使用处之前声明) ──
  const currentTimeRef = useRef(currentTimeMs);
  useEffect(() => {
    currentTimeRef.current = currentTimeMs;
  }, [currentTimeMs]);
  const onOverlaySelectRef = useRef<((overlay: OverlayItem) => void) | null>(null);
  useEffect(() => {
    onOverlaySelectRef.current = (overlay: OverlayItem) => {
      setSelectedOverlayId(overlay.id);
      const sourceCardId = overlay.aiCardData?.sourceCardId;
      if (overlay.overlayType === 'ai-card' && sourceCardId) {
        onOpenAICardInspector?.(sourceCardId);
        return;
      }
      onOpenOverlayInspector?.(overlay.id);
    };
  }, [onOpenAICardInspector, onOpenOverlayInspector]);

  // 拖拽结束若组件卸载,兜底清理 autoscroll
  useEffect(() => {
    return () => {
      autoScrollRef.current?.stop();
      autoScrollRef.current = null;
    };
  }, []);

  // ── Trim snap 注入(Task 13 要求) ──
  const computeSnapForTrim = useCallback(
    (candidateMs: number, overlayId: string): number => {
      if (!snapEnabled) return candidateMs;
      const snap = computeSnap({
        candidateMs,
        playheadMs: currentTimeMs,
        overlays: timeline.overlays,
        excludeOverlayId: overlayId,
        pxPerMs,
        thresholdPx: 8,
        enabled: true,
      });
      return snap.snappedMs;
    },
    [snapEnabled, currentTimeMs, timeline.overlays, pxPerMs],
  );

  // ── Overlay 拖拽生命周期(Task 13 核心) ──
  // OverlayBlock 在 move-drag 入口调用本 handler；返回 true 表示 Timeline 接管整个生命周期。
  const handleBeginOverlayDrag = useCallback(
    (overlay: OverlayItem, startEvent: ReactMouseEvent<HTMLDivElement>): boolean => {
      if (overlay.overlayRole === 'default-background') return false;

      const blockEl = startEvent.currentTarget as HTMLElement | null;
      if (!blockEl) return false;
      const blockRect = blockEl.getBoundingClientRect();
      // grabOffsetMs: 鼠标相对 clip 左边缘在时间轴上的距离(ms)
      const grabOffsetMs = Math.max(0, (startEvent.clientX - blockRect.left) / pxPerMs);

      startEvent.preventDefault();

      // 立即标记选中态,让视觉反馈在 mousedown 就生效,而不是等到 mouseup
      setSelectedOverlayId(overlay.id);

      // 启动 autoscroll
      const scrollContainer = containerRef.current;
      if (scrollContainer) {
        autoScrollRef.current = startAutoScroll({ container: scrollContainer });
        autoScrollRef.current.update({ x: startEvent.clientX, y: startEvent.clientY });
      }

      const initialState: OverlayDragState = {
        overlayId: overlay.id,
        collision: false,
        snapTargets: [],
        dropGapIndex: null,
        candidateStartMs: overlay.startMs,
        candidateTrackId: overlay.trackId,
        previewDeltaY: 0,
      };
      dragStateRef.current = initialState;
      setDragState(initialState);

      let didMove = false;
      const startClientX = startEvent.clientX;
      const startClientY = startEvent.clientY;

      const handleMove = (moveEvent: globalThis.MouseEvent) => {
        if (
          !didMove
          && (Math.abs(moveEvent.clientX - startClientX) > 3
            || Math.abs(moveEvent.clientY - startClientY) > 3)
        ) {
          didMove = true;
        }

        autoScrollRef.current?.update({ x: moveEvent.clientX, y: moveEvent.clientY });

        // 1. 计算候选起始时间(基于鼠标位置,考虑 grab offset 和滚动)
        const container = containerRef.current;
        const containerRect = container?.getBoundingClientRect();
        const scrollLeft = container?.scrollLeft ?? 0;
        const localX = containerRect
          ? moveEvent.clientX - containerRect.left + scrollLeft - outerPadding - sidebarWidth
          : 0;
        let candidateStartMs = Math.max(0, Math.round(localX / pxPerMs - grabOffsetMs));
        // 尾部留白后不再硬限制最大位置;碰撞检测仍会阻止与其它 clip 重叠

        // 2. 解析轨道 / gap
        const dropGapIndex = resolveGapIndex(moveEvent.clientY);
        const trackZones = getTrackDragZones();
        let candidateTrackId = overlay.trackId;
        if (dropGapIndex === null) {
          const matched = trackZones.find(
            (tz) => moveEvent.clientY >= tz.top && moveEvent.clientY <= tz.bottom,
          );
          candidateTrackId = matched?.trackId ?? overlay.trackId;
        }

        // 3. Snap(落 gap 时跳过；按住 Alt 临时关闭)
        let snapTargets: SnapTarget[] = [];
        if (dropGapIndex === null) {
          const snapEnabledNow = snapEnabled && !moveEvent.altKey;
          const snap = computeSnap({
            candidateMs: candidateStartMs,
            playheadMs: currentTimeRef.current,
            overlays: useTimelineStore.getState().timeline.overlays,
            excludeOverlayId: overlay.id,
            pxPerMs,
            thresholdPx: 8,
            enabled: snapEnabledNow,
          });
          candidateStartMs = snap.snappedMs;
          snapTargets = snap.targets;
        }

        // 4. Collision(落 gap 时跳过；落新轨道天然无撞)
        let collision = false;
        if (dropGapIndex === null) {
          const placement = canPlaceAt({
            trackId: candidateTrackId,
            startMs: candidateStartMs,
            durationMs: overlay.durationMs,
            excludeOverlayId: overlay.id,
            overlays: useTimelineStore.getState().timeline.overlays,
          });
          collision = !placement.ok;
        }

        // 5. Drag preview deltaY:直接使用鼠标 clientY 相对起点的偏移,
        //    让 clip 在拖拽过程中平滑跟随鼠标垂直移动;最终落位仍由 candidateTrackId / dropGapIndex 决定
        const previewDeltaY = moveEvent.clientY - startClientY;

        const nextState: OverlayDragState = {
          overlayId: overlay.id,
          collision,
          snapTargets,
          dropGapIndex,
          candidateStartMs,
          candidateTrackId,
          previewDeltaY,
        };
        dragStateRef.current = nextState;
        setDragState(nextState);
      };

      const handleUp = () => {
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleUp);
        autoScrollRef.current?.stop();
        autoScrollRef.current = null;

        const finalState = dragStateRef.current;
        const sourceTrackId = overlay.trackId;
        let committedToTrackId: string | null = null;

        if (finalState && didMove) {
          if (finalState.dropGapIndex !== null) {
            const visualCount = useTimelineStore
              .getState()
              .timeline.tracks.filter((t) => t.kind === 'visual').length;
            const storeGapIndex = uiGapToStoreGap(
              finalState.dropGapIndex,
              visualCount,
            );
            const newTrackId = useTimelineStore
              .getState()
              .createTrackAt({ kind: 'gap', gapIndex: storeGapIndex });
            useTimelineStore.getState().updateOverlay(overlay.id, {
              trackId: newTrackId,
              startMs: finalState.candidateStartMs,
            });
            committedToTrackId = newTrackId;
          } else if (!finalState.collision) {
            useTimelineStore.getState().updateOverlay(overlay.id, {
              trackId: finalState.candidateTrackId,
              startMs: finalState.candidateStartMs,
            });
            committedToTrackId = finalState.candidateTrackId;
          }
          // collision 分支：什么都不做,store 也会拒绝
        } else if (!didMove) {
          // 没有移动 → 视为点击选中
          onOverlaySelectRef.current?.(overlay);
        }

        // 跨轨道移动后,若源轨道变空且非 locked、非仅剩的 visual → 自动清理
        if (committedToTrackId && committedToTrackId !== sourceTrackId) {
          const state = useTimelineStore.getState();
          const sourceTrack = state.timeline.tracks.find((t) => t.id === sourceTrackId);
          const remainingOnSource = state.timeline.overlays.some(
            (o) => o.trackId === sourceTrackId,
          );
          const visualTracksLeft = state.timeline.tracks.filter((t) => t.kind === 'visual');
          if (
            sourceTrack
            && sourceTrack.kind === 'visual'
            && !sourceTrack.locked
            && !remainingOnSource
            && visualTracksLeft.length > 1
          ) {
            state.removeTrack(sourceTrackId);
          }
        }

        dragStateRef.current = null;
        setDragState(null);
      };

      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleUp);

      return true;
    },
    // 故意省略:
    // - currentTimeMs(通过 currentTimeRef.current 读取最新值)
    // - timeline.overlays(通过 useTimelineStore.getState() 读取最新值)
    // 这避免在拖拽期间因相关 state 变化导致 handler 重建。
    [outerPadding, pxPerMs, sidebarWidth, snapEnabled, visualTracks],
  );

  const renderTrackControls = (options: {
    track: TimelineTrack;
    tone: string;
    name: string;
    actions?: ReactNode;
  }) => {
    const isLocked = Boolean(options.track.locked);
    return (
      <div className={styles.trackControls}>
        <div className={styles.trackControlsBody} />
        {options.actions ?? null}
        <button
          type="button"
          className={joinClassNames(
            styles.trackLockButton,
            isLocked ? styles.trackLockButtonLocked : '',
          )}
          onClick={(event) => {
            event.stopPropagation();
            useTimelineStore.getState().toggleTrackLocked(options.track.id);
          }}
          aria-label={isLocked ? `解锁${options.track.label}` : `锁定${options.track.label}`}
          aria-pressed={isLocked}
          title={isLocked ? '解锁轨道' : '锁定轨道'}
        >
          <AppIcon name={isLocked ? 'lock' : 'lock-open'} size={12} />
        </button>
      </div>
    );
  };

  const renderLaneBase = (
    track: TimelineTrack,
    trackHeight: number,
    children: ReactNode,
    laneClassName?: string,
    extraStyle?: CSSProperties,
  ) => (
    <div
      key={track.id}
      className={styles.laneRow}
      data-locked={track.locked ? 'true' : 'false'}
      style={{ gridTemplateColumns: trackColumns, minHeight: trackHeight }}
    >
      {children}
      <div
        className={joinClassNames(styles.laneMain, laneClassName)}
        style={{
          height: trackHeight,
          ...gridBackground,
          ...extraStyle,
        }}
      />
    </div>
  );

  return (
    <div
      className={styles.root}
      data-agent-zone="timeline"
      style={{
        gridTemplateRows: `${toolbarHeight}px minmax(0, 1fr)`,
      }}
    >
      <TimelineToolbar
        zoomLevel={zoomLevel}
        onZoomChange={handleZoomChange}
        onFocusPlayhead={focusPlayhead}
        timelineDurationMs={getTimelineVisualEndMs(timeline)}
        viewportWidth={viewportWidth}
        snapEnabled={snapEnabled}
        onToggleSnap={() => setSnapEnabled((v) => !v)}
        onAddTrack={() => addTrack()}
        onSplit={() =>
          useTimelineStore
            .getState()
            .splitOverlayClipsAt(
              currentTimeMs,
              selectedOverlayId ? [selectedOverlayId] : undefined,
            )
        }
      />

      <div
        ref={containerRef}
        onClick={handleSeekClick}
        className={styles.scrollArea}
      >
        <div
          className={styles.canvas}
          style={{
            width: canvasWidth + outerPadding * 2,
            padding: outerPadding,
          }}
        >
          <div
            className={styles.content}
            style={{
              width: canvasWidth,
              ['--timeline-sidebar-width' as string]: `${sidebarWidth}px`,
            }}
          >
            <div
              className={styles.rulerRow}
              style={{ gridTemplateColumns: trackColumns, height: rulerHeight }}
            >
              <div className={styles.rulerSide}>轨道</div>

              <div
                ref={rulerRef}
                className={styles.rulerMain}
                style={{ height: rulerHeight, cursor: 'ew-resize' }}
                onMouseDown={handleRulerMouseDown}
                onClick={handleRulerClick}
              >
                {ticks.map((tick) => (
                  <div
                    key={tick.ms}
                    className={joinClassNames(
                      styles.tick,
                      tick.isMajor ? '' : styles.tickMinor,
                    )}
                    style={{ left: tick.ms * pxPerMs }}
                  >
                    <div className={styles.tickMarker} />
                    {tick.isMajor ? (
                      <div className={styles.tickLabel}>
                        {formatTimecode(tick.ms, majorTickInterval)}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>

            {renderLaneBase(
              timeline.tracks[0],
              audioTrackHeight,
              renderTrackControls({
                track: timeline.tracks[0],
                tone: 'var(--color-track-audio)',
                name: '轨道 1',
              }),
              styles.lockedLane,
              {
                overflow: 'hidden',
              },
            )}
            {(() => {
              // 主口播波形只能覆盖音频真实时长；若按 visualEndMs / durationMs
              // 铺开，overlay 追加到末尾后波形会被拉伸到整个延长段，造成
              // "音频继续播放"的视觉误导。
              const podcastDurationMs = Math.max(0, timeline.podcast.durationMs ?? 0);
              const podcastWidth = Math.max(0, Math.round(podcastDurationMs * pxPerMs));
              return (
                <div
                  className={styles.lockedLaneOverlay}
                  style={{
                    marginTop: -audioTrackHeight,
                    marginLeft: sidebarWidth,
                    width: podcastWidth,
                    height: audioTrackHeight,
                  }}
                >
                  <TimelineAudioWaveform
                    audioPath={timeline.podcast.audioPath}
                    durationMs={podcastDurationMs}
                    trackWidth={podcastWidth}
                    trackHeight={audioTrackHeight}
                    deferLoading={isPlaying}
                  />
                </div>
              );
            })()}

            {renderLaneBase(
              timeline.tracks[1],
              subtitleTrackHeight,
              renderTrackControls({
                track: timeline.tracks[1],
                tone: 'var(--color-track-subtitle)',
                name: '轨道 1',
              }),
              styles.lockedLane,
            )}
            <div
              className={styles.lockedLaneOverlay}
              style={{
                marginTop: -subtitleTrackHeight,
                marginLeft: sidebarWidth,
                width: contentWidth,
                height: subtitleTrackHeight,
              }}
            >
              <TimelineSubtitleBlocks
                entries={srtEntries}
                durationMs={durationMs}
                pxPerMs={pxPerMs}
                trackHeight={subtitleTrackHeight}
                highlightHint={subtitleHighlightHint}
                onClickBlock={onOpenSubtitleInspector}
                onRequestGenerateCard={(payload) => {
                  setSubtitleCardDialogInitial({
                    text: payload.text,
                    startMs: payload.startMs,
                    endMs: payload.endMs,
                    kind: payload.kind,
                  });
                  setSubtitleCardDialogOpen(true);
                }}
              />
            </div>

            <div className={styles.visualTracksGroup}>
            <TrackDropZone
              gapIndex={0}
              active={Boolean(dragState)}
              highlighted={dragState?.dropGapIndex === 0}
              ref={(el) => {
                gapRefs.current[0] = el;
              }}
            />
            {visualTracks.map((track, index) => {
              const overlays = overlaysByTrack.get(track.id) ?? [];
              const isHover = hoverTrackId === track.id;
              const isTopLayer = index === 0;
              const trackMenuItems = getTimelineContextMenuItems({
                target: 'track',
                canPaste: canPasteOverlay,
              });
              const trackMenuStartMs =
                contextTarget?.kind === 'track' && contextTarget.trackId === track.id
                  ? contextTarget.startMs
                  : 0;

              return (
                <Fragment key={track.id}>
                <div
                  ref={(node) => {
                    trackRowRefs.current[track.id] = node;
                  }}
                  className={styles.overlayRow}
                  data-locked={track.locked ? 'true' : 'false'}
                  style={{
                    gridTemplateColumns: trackColumns,
                    minHeight: overlayTrackHeight,
                  }}
                >
                  {renderTrackControls({
                    track,
                    tone: isTopLayer
                      ? 'var(--color-track-primary)'
                      : 'var(--color-track-secondary)',
                    name: `轨道 ${visualTracks.length - index}`,
                    actions: (
                      <button
                        className={styles.trackDeleteButton}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (overlays.length > 0) {
                            setPendingTrackDeletion({
                              trackId: track.id,
                              trackLabel: track.label,
                              overlayCount: overlays.length,
                            });
                            return;
                          }
                          removeTrack(track.id);
                        }}
                        aria-label={`删除${track.label}`}
                        title="删除轨道"
                      >
                        <AppIcon name="trash-2" size={12} />
                      </button>
                    ),
                  })}
                  <ContextMenu>
                    <ContextMenu.Trigger asChild>
                      <div
                        ref={(node) => {
                          trackLaneRefs.current[track.id] = node;
                        }}
                        onContextMenu={(event) => {
                          handleTrackContextMenu(track.id, event.clientX);
                        }}
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = 'copy';
                          if (hoverTrackId !== track.id) {
                            setHoverTrackId(track.id);
                          }
                        }}
                        onDragLeave={() => {
                          if (hoverTrackId === track.id) {
                            setHoverTrackId(null);
                          }
                        }}
                        onDrop={handleTrackDrop(track.id)}
                        className={joinClassNames(
                          styles.trackDropLane,
                          isHover ? styles.trackDropLaneHover : '',
                        )}
                        style={{
                          height: overlayTrackHeight,
                          ...gridBackground,
                        }}
                      >
                        {overlays.map((overlay) => {
                          const activeDragForOverlay =
                            dragState && dragState.overlayId === overlay.id
                              ? dragState
                              : null;
                          const overlayBlock = (
                            <OverlayBlock
                              overlay={overlay}
                              pxPerMs={pxPerMs}
                              trackHeight={overlayTrackHeight}
                              selected={selectedOverlayId === overlay.id}
                              trackLocked={Boolean(track.locked)}
                              collisionState={
                                activeDragForOverlay && activeDragForOverlay.collision
                                  ? 'invalid'
                                  : 'none'
                              }
                              dragPreviewStartMs={
                                activeDragForOverlay
                                  ? activeDragForOverlay.candidateStartMs
                                  : undefined
                              }
                              dragPreviewDeltaY={
                                activeDragForOverlay
                                  ? activeDragForOverlay.previewDeltaY
                                  : undefined
                              }
                              isDragging={Boolean(activeDragForOverlay)}
                              computeSnapForTrim={computeSnapForTrim}
                              onBeginOverlayDrag={handleBeginOverlayDrag}
                              getTrackDragZones={getTrackDragZones}
                              onTrackHoverChange={setHoverTrackId}
                              onContextMenu={(event) => {
                                handleOverlayContextMenu(overlay.id, overlay.trackId, event.clientX);
                              }}
                              onSelect={() => {
                                setSelectedOverlayId(overlay.id);
                                const sourceCardId = overlay.aiCardData?.sourceCardId;
                                if (overlay.overlayType === 'ai-card' && sourceCardId) {
                                  onOpenAICardInspector?.(sourceCardId);
                                  return;
                                }
                                // 所有视觉 overlay（文字/图片/视频）统一打开 Inspector
                                onOpenOverlayInspector?.(overlay.id);
                              }}
                            />
                          );

                          if (overlay.overlayRole === 'default-background') {
                            return (
                              <Fragment key={overlay.id}>
                                {overlayBlock}
                              </Fragment>
                            );
                          }

                          const overlayCardType = overlay.aiCardData?.cardType;
                          const overlayMenuItems = getTimelineContextMenuItems({
                            target: 'overlay',
                            canPaste: canPasteOverlay,
                            convertibleToMotion:
                              overlay.overlayType === 'ai-card' &&
                              (overlayCardType === 'image' || overlayCardType === 'video'),
                          });
                          const overlayMenuStartMs =
                            contextTarget?.kind === 'overlay' &&
                            contextTarget.overlayId === overlay.id
                              ? contextTarget.startMs
                              : overlay.startMs;

                          return (
                            <ContextMenu key={overlay.id}>
                              <ContextMenu.Trigger asChild>{overlayBlock}</ContextMenu.Trigger>
                              <ContextMenu.Content glass>
                                {renderContextMenuItems(overlayMenuItems, {
                                  overlayId: overlay.id,
                                  trackId: overlay.trackId,
                                  startMs: overlayMenuStartMs,
                                })}
                              </ContextMenu.Content>
                            </ContextMenu>
                          );
                        })}

                        {overlays.length === 0 ? (
                          <div
                            className={[
                              styles.emptyHint,
                              isHover ? styles.emptyHintHover : '',
                            ].filter(Boolean).join(' ')}
                          >
                            拖入图片或视频到 {track.label}
                          </div>
                        ) : null}
                      </div>
                    </ContextMenu.Trigger>
                    <ContextMenu.Content glass>
                      {renderContextMenuItems(trackMenuItems, {
                        trackId: track.id,
                        startMs: trackMenuStartMs,
                      })}
                    </ContextMenu.Content>
                  </ContextMenu>
                </div>
                <TrackDropZone
                  gapIndex={index + 1}
                  active={Boolean(dragState)}
                  highlighted={dragState?.dropGapIndex === index + 1}
                  ref={(el) => {
                    gapRefs.current[index + 1] = el;
                  }}
                />
                </Fragment>
              );
            })}
            </div>

            {audioOverlayTracks.map((track) => {
              const overlays = overlaysByTrack.get(track.id) ?? [];
              const isHover = hoverTrackId === track.id;
              return (
                <div
                  key={track.id}
                  ref={(node) => {
                    trackRowRefs.current[track.id] = node;
                  }}
                  className={styles.overlayRow}
                  data-locked={track.locked ? 'true' : 'false'}
                  style={{
                    gridTemplateColumns: trackColumns,
                    minHeight: overlayTrackHeight,
                  }}
                >
                  {renderTrackControls({
                    track,
                    tone: 'var(--color-track-audio)',
                    name: track.label,
                    actions: (
                      <button
                        className={styles.trackDeleteButton}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (overlays.length > 0) {
                            setPendingTrackDeletion({
                              trackId: track.id,
                              trackLabel: track.label,
                              overlayCount: overlays.length,
                            });
                            return;
                          }
                          removeTrack(track.id);
                        }}
                        aria-label={`删除${track.label}`}
                        title="删除音轨"
                      >
                        <AppIcon name="trash-2" size={12} />
                      </button>
                    ),
                  })}
                  <div
                    ref={(node) => {
                      trackLaneRefs.current[track.id] = node;
                    }}
                    onContextMenu={(event) => {
                      handleTrackContextMenu(track.id, event.clientX);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'copy';
                      if (hoverTrackId !== track.id) {
                        setHoverTrackId(track.id);
                      }
                    }}
                    onDragLeave={() => {
                      if (hoverTrackId === track.id) {
                        setHoverTrackId(null);
                      }
                    }}
                    onDrop={handleTrackDrop(track.id)}
                    className={joinClassNames(
                      styles.trackDropLane,
                      isHover ? styles.trackDropLaneHover : '',
                    )}
                    style={{
                      height: overlayTrackHeight,
                      ...gridBackground,
                    }}
                  >
                    {overlays.map((overlay) => {
                      const activeDragForOverlay =
                        dragState && dragState.overlayId === overlay.id ? dragState : null;
                      return (
                        <OverlayBlock
                          key={overlay.id}
                          overlay={overlay}
                          pxPerMs={pxPerMs}
                          trackHeight={overlayTrackHeight}
                          selected={selectedOverlayId === overlay.id}
                          trackLocked={Boolean(track.locked)}
                          collisionState={
                            activeDragForOverlay && activeDragForOverlay.collision
                              ? 'invalid'
                              : 'none'
                          }
                          dragPreviewStartMs={
                            activeDragForOverlay
                              ? activeDragForOverlay.candidateStartMs
                              : undefined
                          }
                          dragPreviewDeltaY={
                            activeDragForOverlay
                              ? activeDragForOverlay.previewDeltaY
                              : undefined
                          }
                          isDragging={Boolean(activeDragForOverlay)}
                          computeSnapForTrim={computeSnapForTrim}
                          onTrackHoverChange={setHoverTrackId}
                          deferWaveformLoading={isPlaying}
                          onContextMenu={(event) => {
                            handleOverlayContextMenu(overlay.id, overlay.trackId, event.clientX);
                          }}
                          onSelect={() => {
                            setSelectedOverlayId(overlay.id);
                            onOpenOverlayInspector?.(overlay.id);
                          }}
                        />
                      );
                    })}

                    {overlays.length === 0 ? (
                      <div
                        className={[
                          styles.emptyHint,
                          isHover ? styles.emptyHintHover : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        拖入音频到 {track.label}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}

            <SnapGuides
              targets={dragState?.snapTargets ?? []}
              pxPerMs={pxPerMs}
              sidebarWidth={sidebarWidth}
              height={Math.max(
                overlayTrackHeight * (Math.max(visualTracks.length, 1) + audioOverlayTracks.length)
                  + audioTrackHeight
                  + subtitleTrackHeight
                  + rulerHeight,
                240,
              )}
              top={0}
            />

            <TimelinePlayhead
              currentTimeMs={currentTimeMs}
              pxPerMs={pxPerMs}
              sidebarWidth={sidebarWidth}
            />
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={Boolean(pendingTrackDeletion)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingTrackDeletion(null);
          }
        }}
        title="删除轨道"
        description={
          pendingTrackDeletion
            ? `此轨道包含 ${pendingTrackDeletion.overlayCount} 个素材，删除后将一并移除。`
            : undefined
        }
        confirmText={`删除${pendingTrackDeletion?.trackLabel ?? '轨道'}`}
        cancelText="取消"
        confirmVariant="destructive"
        onConfirm={() => {
          if (!pendingTrackDeletion) {
            return;
          }
          removeTrack(pendingTrackDeletion.trackId);
          setPendingTrackDeletion(null);
        }}
      />
      <SubtitleCardDialog
        open={subtitleCardDialogOpen}
        onOpenChange={setSubtitleCardDialogOpen}
        initial={subtitleCardDialogInitial}
        onGenerated={(cardId) => {
          if (cardId) {
            onOpenAICardInspector?.(cardId);
          }
        }}
      />
    </div>
  );
}

function joinClassNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

/**
 * TimelinePlayhead — MotionValue 驱动的播放头
 *
 * 设计要点:
 * - 使用 `useMotionValue` + `useSpring(stiffness: 800, damping: 60)` 组合,几乎 critically damped,
 *   seek 跳转有细微缓动,playback 实时跟随(延迟 < 一帧)。
 * - DOM 通过 `transform: translateX`(GPU 合成层)而非 `left`(CPU layout),消除 playhead 自身的
 *   layout/paint 成本。
 * - 通过 `useEffect` 将父 prop 同步到 motion value,父组件 re-render 不再触发 playhead 节点的
 *   style diff(m.div 直接把 transform 写到样式,跳过 React 虚拟 DOM 对该节点 style 的比对)。
 * - `memo` 包裹,父组件 re-render 若 prop 浅比较相等(sidebarWidth / pxPerMs 稳定)则整个子组件
 *   不 re-render;仅 currentTimeMs 变动时进来更新 motion value(不触发 DOM 层面的 React diff)。
 */
const TimelinePlayhead = memo(function TimelinePlayhead({
  currentTimeMs,
  pxPerMs,
  sidebarWidth,
}: {
  currentTimeMs: number;
  pxPerMs: number;
  sidebarWidth: number;
}) {
  const targetX = sidebarWidth + currentTimeMs * pxPerMs;
  const rawX = useMotionValue(targetX);
  const smoothX = useSpring(rawX, { stiffness: 800, damping: 60, mass: 1 });

  useEffect(() => {
    rawX.set(targetX);
  }, [targetX, rawX]);

  return (
    <m.div
      className={styles.playhead}
      style={{
        left: 0,
        x: smoothX,
        willChange: 'transform',
      }}
    >
      <div className={styles.playheadHandle} />
    </m.div>
  );
});
