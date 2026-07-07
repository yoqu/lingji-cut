import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { fitPreviewStage } from '../lib/preview';
import { formatTime } from '../lib/utils';
import { useTimelineStore } from '../store/timeline';
import { useAIStore } from '../store/ai';
import { Button, Card, Tooltip, TooltipContent, TooltipTrigger } from '../ui';
import { AppIcon } from './AppIcon';
import { CanvasInteractionLayer } from './CanvasInteractionLayer';
import { RemotionPreviewPlayer, type RemotionPreviewHandle } from './RemotionPreviewPlayer';
import {
  SourceAssetPreviewPlayer,
  type SourcePreviewAsset,
} from './SourceAssetPreviewPlayer';
import type { OverlayPosition } from '../types';
import styles from './PreviewPanel.module.css';

interface PreviewPanelProps {
  playerRef: RefObject<RemotionPreviewHandle | null>;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onSeek?: (ms: number) => void;
  /** 进度条拖动开始（pointerdown）。用于「拖动时暂停、松手续播」。 */
  onSeekStart?: () => void;
  /** 进度条拖动结束（pointerup）。 */
  onSeekEnd?: () => void;
  onExport: () => void;
  currentTimeMs: number;
  durationMs: number;
  compact: boolean;
  selectedOverlayId?: string | null;
  sourcePreviewAsset?: SourcePreviewAsset | null;
  onCloseSourcePreview?: () => void;
  onSelectOverlay?: (overlayId: string | null) => void;
  onUpdateOverlayPosition?: (overlayId: string, position: OverlayPosition) => void;
  onPreviewTimeUpdate: (timeMs: number) => void;
  onPreviewPlay: () => void;
  onPreviewPause: () => void;
  onPreviewEnded: () => void;
}

function PreviewPanelComponent({
  playerRef,
  isPlaying,
  onTogglePlay,
  onSeek,
  onSeekStart,
  onSeekEnd,
  currentTimeMs,
  durationMs,
  compact,
  selectedOverlayId,
  sourcePreviewAsset,
  onCloseSourcePreview,
  onSelectOverlay,
  onUpdateOverlayPosition,
  onPreviewTimeUpdate,
  onPreviewPlay,
  onPreviewPause,
  onPreviewEnded,
}: PreviewPanelProps) {
  const { timeline, srtEntries } = useTimelineStore();
  const projectDir = useAIStore((s) => s.currentProjectDir);
  const fps = timeline.fps || 30;
  const cardRef = useRef<HTMLDivElement>(null);
  const previewAreaRef = useRef<HTMLDivElement | null>(null);
  const stageFrameRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState(() => ({
    width: timeline.width,
    height: timeline.height,
  }));
  // 注意：不要把 stage rect 缓存到 state。
  // stageRect 在初次挂载时可能还没完成布局（或被父级 max-width 约束成 0），
  // 此时缓存的值会导致 screenToCanvas 除以 0，拖动时出现 NaN/Infinity，
  // 最终被 clamp 到画布四个角。改为在真正拖动时从 ref 现读，避免任何时序问题。
  const getStageRect = useCallback(() => {
    const el = stageFrameRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }, []);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [progressHover, setProgressHover] = useState<{ timeMs: number; x: number } | null>(null);
  const [sourceTimeMs, setSourceTimeMs] = useState(0);
  const [sourceIsPlaying, setSourceIsPlaying] = useState(false);
  const progressTrackRef = useRef<HTMLDivElement>(null);
  const isSeekingRef = useRef(false);
  const volumeTrackRef = useRef<HTMLDivElement>(null);
  const isAdjustingVolumeRef = useRef(false);

  useEffect(() => {
    const handleChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  // 同步音量到 Player（onMount 时 playerRef 可能还未就绪，用 requestAnimationFrame 兜底）
  useEffect(() => {
    const apply = () => {
      const player = playerRef.current;
      if (!player) return;
      player.setVolume(volume);
      if (muted) {
        player.mute();
      } else {
        player.unmute();
      }
    };
    apply();
    const raf = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(raf);
  }, [playerRef, volume, muted]);

  useEffect(() => {
    setSourceTimeMs(0);
    setSourceIsPlaying(false);
  }, [sourcePreviewAsset?.path]);

  const handleToggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      // 从完全静音恢复时给一个最小可听值，避免用户误以为没反应
      if (!next && volume === 0) {
        setVolume(0.5);
      }
      return next;
    });
  }, [volume]);

  const handleVolumeChange = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(1, next));
    setVolume(clamped);
    if (clamped > 0 && muted) {
      setMuted(false);
    }
  }, [muted]);

  const computeSeekMsFromEvent = useCallback(
    (clientX: number) => {
      const track = progressTrackRef.current;
      const activeDurationMs = sourcePreviewAsset
        ? sourcePreviewAsset.type === 'video'
          ? sourcePreviewAsset.durationMs
          : 0
        : durationMs;
      if (!track || activeDurationMs <= 0) return null;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return ratio * activeDurationMs;
    },
    [durationMs, sourcePreviewAsset],
  );

  const updateProgressHoverFromEvent = useCallback(
    (clientX: number) => {
      const track = progressTrackRef.current;
      const activeDurationMs = sourcePreviewAsset
        ? sourcePreviewAsset.type === 'video'
          ? sourcePreviewAsset.durationMs
          : 0
        : durationMs;
      if (!track || activeDurationMs <= 0) {
        setProgressHover(null);
        return;
      }
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) {
        setProgressHover(null);
        return;
      }
      const offsetX = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const ratio = offsetX / rect.width;
      setProgressHover({ timeMs: ratio * activeDurationMs, x: offsetX });
    },
    [durationMs, sourcePreviewAsset],
  );

  const handleActiveSeek = useCallback(
    (targetMs: number) => {
      if (sourcePreviewAsset) {
        playerRef.current?.seekToMs(targetMs);
        setSourceTimeMs(targetMs);
        return;
      }

      onSeek?.(targetMs);
    },
    [onSeek, playerRef, sourcePreviewAsset],
  );

  const handleProgressPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const activeDurationMs = sourcePreviewAsset
        ? sourcePreviewAsset.type === 'video'
          ? sourcePreviewAsset.durationMs
          : 0
        : durationMs;
      if (activeDurationMs <= 0) return;
      event.preventDefault();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      isSeekingRef.current = true;
      if (!sourcePreviewAsset) {
        onSeekStart?.();
      }

      const seekFrom = computeSeekMsFromEvent(event.clientX);
      if (seekFrom !== null) handleActiveSeek(seekFrom);
      updateProgressHoverFromEvent(event.clientX);
    },
    [
      computeSeekMsFromEvent,
      durationMs,
      handleActiveSeek,
      onSeekStart,
      sourcePreviewAsset,
      updateProgressHoverFromEvent,
    ],
  );

  const handleProgressPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      updateProgressHoverFromEvent(event.clientX);
      if (!isSeekingRef.current) return;
      const next = computeSeekMsFromEvent(event.clientX);
      if (next !== null) handleActiveSeek(next);
    },
    [computeSeekMsFromEvent, handleActiveSeek, updateProgressHoverFromEvent],
  );

  const handleProgressPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isSeekingRef.current) return;
      isSeekingRef.current = false;
      const target = event.currentTarget;
      if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
      }
      if (!sourcePreviewAsset) {
        onSeekEnd?.();
      }
    },
    [onSeekEnd, sourcePreviewAsset],
  );

  const handleProgressPointerEnter = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      updateProgressHoverFromEvent(event.clientX);
    },
    [updateProgressHoverFromEvent],
  );

  const handleProgressPointerLeave = useCallback(() => {
    // 拖动中不清除，拖动结束 Pointer Capture 释放后浏览器会再发一次 leave
    if (isSeekingRef.current) return;
    setProgressHover(null);
  }, []);

  const computeVolumeFromEvent = useCallback((clientY: number) => {
    const track = volumeTrackRef.current;
    if (!track) return null;
    const rect = track.getBoundingClientRect();
    if (rect.height <= 0) return null;
    // 轨道顶部 = 音量最大，底部 = 0
    return 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  }, []);

  const handleVolumePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      isAdjustingVolumeRef.current = true;
      const next = computeVolumeFromEvent(event.clientY);
      if (next !== null) handleVolumeChange(next);
    },
    [computeVolumeFromEvent, handleVolumeChange],
  );

  const handleVolumePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isAdjustingVolumeRef.current) return;
      const next = computeVolumeFromEvent(event.clientY);
      if (next !== null) handleVolumeChange(next);
    },
    [computeVolumeFromEvent, handleVolumeChange],
  );

  const handleVolumePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isAdjustingVolumeRef.current) return;
      isAdjustingVolumeRef.current = false;
      const target = event.currentTarget;
      if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const activeTimeMs = sourcePreviewAsset ? sourceTimeMs : currentTimeMs;
  const activeDurationMs = sourcePreviewAsset
    ? sourcePreviewAsset.type === 'video'
      ? sourcePreviewAsset.durationMs
      : 0
    : durationMs;
  const activeIsPlaying = sourcePreviewAsset ? sourceIsPlaying : isPlaying;
  const canPlayActivePreview = !sourcePreviewAsset || sourcePreviewAsset.type === 'video';
  const progressPercent = activeDurationMs > 0
    ? Math.max(0, Math.min(100, (activeTimeMs / activeDurationMs) * 100))
    : 0;
  const volumePercent = (muted ? 0 : volume) * 100;
  const volumeIconName = muted || volume === 0
    ? 'volume-x'
    : volume < 0.5
      ? 'volume-1'
      : 'volume-2';

  const handleToggleFullscreen = useCallback(() => {
    const el = cardRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }, []);

  const stageFrameStyle = sourcePreviewAsset
    ? { width: '100%', height: '100%' }
    : {
        width: Math.max(0, stageSize.width),
        height: Math.max(0, stageSize.height),
      };

  useEffect(() => {
    const container = previewAreaRef.current;
    if (!container) {
      return;
    }

    const updateStageSize = () => {
      const nextStageSize = fitPreviewStage(
        container.clientWidth,
        container.clientHeight,
        timeline.width,
        timeline.height,
      );
      setStageSize(nextStageSize);
    };

    updateStageSize();

    const observer = new ResizeObserver(() => {
      updateStageSize();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [timeline.height, timeline.width]);

  return (
    <Card ref={cardRef} className={styles.root}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerTitleGroup}>
          <span className={styles.headerTitle}>
            {sourcePreviewAsset ? '素材预览' : '预览'}
          </span>
          {sourcePreviewAsset ? (
            <span className={styles.sourceTitle} title={sourcePreviewAsset.name}>
              {sourcePreviewAsset.name}
            </span>
          ) : null}
        </div>
        {sourcePreviewAsset ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={styles.closeSourceButton}
                aria-label="关闭素材预览"
                onClick={onCloseSourcePreview}
              >
                <AppIcon name="x" size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">关闭素材预览</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={styles.resolutionPill}
                aria-label={`分辨率 ${timeline.width}×${timeline.height}，帧率 ${fps}`}
              >
                <AppIcon name="monitor" size={12} />
                <span>{timeline.width}×{timeline.height}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {`分辨率: ${timeline.width}×${timeline.height} · ${fps}fps`}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Stage 区域 */}
      <div
        ref={previewAreaRef}
        className={styles.stageArea}
        style={{ padding: compact ? 10 : 14 }}
      >
        <div
          ref={stageFrameRef}
          className={styles.stageFrame}
          style={stageFrameStyle}
        >
          {sourcePreviewAsset ? (
            <SourceAssetPreviewPlayer
              key={sourcePreviewAsset.path}
              ref={playerRef}
              asset={sourcePreviewAsset}
              onTimeUpdate={setSourceTimeMs}
              onPlay={() => setSourceIsPlaying(true)}
              onPause={() => setSourceIsPlaying(false)}
              onEnded={() => {
                setSourceIsPlaying(false);
                setSourceTimeMs(sourcePreviewAsset.durationMs);
              }}
            />
          ) : (
            <RemotionPreviewPlayer
              key={timeline.podcast.audioPath || 'empty'}
              ref={playerRef}
              timeline={timeline}
              srtEntries={srtEntries}
              projectDir={projectDir}
              currentTimeMs={currentTimeMs}
              isPlaying={isPlaying}
              onTimeUpdate={onPreviewTimeUpdate}
              onPlay={onPreviewPlay}
              onPause={onPreviewPause}
              onEnded={onPreviewEnded}
            />
          )}
          {!sourcePreviewAsset && onSelectOverlay && (
            <CanvasInteractionLayer
              overlays={timeline.overlays}
              selectedOverlayId={selectedOverlayId ?? null}
              currentTimeMs={currentTimeMs}
              canvasWidth={timeline.width}
              canvasHeight={timeline.height}
              getStageRect={getStageRect}
              onSelect={onSelectOverlay}
              onUpdatePosition={onUpdateOverlayPosition ?? (() => {})}
            />
          )}
        </div>
      </div>

      {/* Footer 播放控件 */}
      <div className={styles.footer}>
        {/* 进度条 */}
        <div
          ref={progressTrackRef}
          className={styles.progressTrack}
          role="slider"
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, Math.round(activeDurationMs))}
          aria-valuenow={Math.round(activeTimeMs)}
          onPointerDown={handleProgressPointerDown}
          onPointerMove={handleProgressPointerMove}
          onPointerUp={handleProgressPointerUp}
          onPointerCancel={handleProgressPointerUp}
          onPointerEnter={handleProgressPointerEnter}
          onPointerLeave={handleProgressPointerLeave}
        >
          <div className={styles.progressFilled} style={{ width: `${progressPercent}%` }} />
          <div className={styles.progressThumb} style={{ left: `${progressPercent}%` }} />
          {progressHover && activeDurationMs > 0 ? (
            <div
              className={styles.progressHoverTooltip}
              style={{ left: `${progressHover.x}px` }}
              aria-hidden="true"
            >
              {formatTime(progressHover.timeMs)}
            </div>
          ) : null}
        </div>

        <div className={styles.footerRow}>
          {/* 左段 — 音量 + 时间 */}
          <div className={styles.footerLeft}>
            <div className={styles.volumePopoverWrap}>
              <Button
                variant="ghost"
                size="icon"
                className={styles.volumeButton}
                aria-label={muted ? '取消静音' : '静音'}
                onClick={handleToggleMute}
              >
                <AppIcon name={volumeIconName} size={14} className={styles.volumeIcon} />
              </Button>
              <div
                className={styles.volumePopover}
                role="group"
                aria-label="音量控制"
              >
                <div className={styles.volumePopoverCard}>
                  <span className={styles.volumePopoverValue}>
                    {Math.round(volumePercent)}
                  </span>
                  <div
                    ref={volumeTrackRef}
                    className={styles.volumeSlider}
                    role="slider"
                    aria-label="音量"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(volumePercent)}
                    onPointerDown={handleVolumePointerDown}
                    onPointerMove={handleVolumePointerMove}
                    onPointerUp={handleVolumePointerUp}
                    onPointerCancel={handleVolumePointerUp}
                  >
                    <div className={styles.volumeSliderTrack} />
                    <div
                      className={styles.volumeSliderFilled}
                      style={{ height: `${volumePercent}%` }}
                    />
                    <div
                      className={styles.volumeSliderThumb}
                      style={{ bottom: `${volumePercent}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
            <span className={styles.timeCurrentLabel}>{formatTime(activeTimeMs)}</span>
            <span className={styles.timeSeparator}>/</span>
            <span className={styles.timeTotalLabel}>{formatTime(activeDurationMs)}</span>
          </div>

        {/* 中段 — 播放控件 */}
        <div className={styles.footerCenter}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className={styles.skipButton} aria-label="上一段">
                <AppIcon name="skip-back" size={18} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">上一段</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={styles.playButton}
                onClick={onTogglePlay}
                aria-label={activeIsPlaying ? '暂停' : '播放'}
                disabled={!canPlayActivePreview}
              >
                {activeIsPlaying
                  ? <AppIcon name="pause" size={18} className={styles.playIcon} />
                  : <AppIcon name="play" size={18} className={styles.playIcon} />
                }
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{activeIsPlaying ? '暂停' : '播放'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className={styles.skipButton} aria-label="下一段">
                <AppIcon name="skip-forward" size={18} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">下一段</TooltipContent>
          </Tooltip>
        </div>

        {/* 右段 — 辅助控件 */}
        <div className={styles.footerRight}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className={styles.speedButton} aria-label="播放速度">
                1×
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">播放速度</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={styles.auxButton}
                aria-label={isFullscreen ? '退出全屏' : '全屏'}
                onClick={handleToggleFullscreen}
              >
                {isFullscreen
                  ? <AppIcon name="minimize-2" size={14} />
                  : <AppIcon name="maximize-2" size={14} />
                }
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{isFullscreen ? '退出全屏' : '全屏'}</TooltipContent>
          </Tooltip>
        </div>
        </div>
      </div>
    </Card>
  );
}

export const PreviewPanel = memo(PreviewPanelComponent);
