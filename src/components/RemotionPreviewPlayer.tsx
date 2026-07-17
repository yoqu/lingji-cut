import { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { MainComposition } from '../remotion/MainComposition';
import { buildRenderPlan } from '../remotion/timeline-to-sequences';
import { collectMotionCards } from '../remotion/collect-cards';
import { hydrateAICardAssetPaths } from '../hyperframes/assets';
import { shouldRefreshPreviewForExternalTime, shouldResyncPreviewSeek } from '../lib/playback';
import { getPreviewAudioSources, preloadPreviewAudioSources } from '../remotion/preview-audio-preload';
import type { SrtEntry, TimelineData } from '../types';

export interface RemotionPreviewHandle {
  play: () => void;
  pause: () => void;
  seekToMs: (ms: number) => void;
  isPlaying: () => boolean;
  setVolume: (volume: number) => void;
  mute: () => void;
  unmute: () => void;
}

interface RemotionPreviewPlayerProps {
  timeline: TimelineData;
  srtEntries: SrtEntry[];
  /** 用于把媒体卡（image / video）相对 projectDir 的 assetPath 解析为绝对路径供预览加载。 */
  projectDir?: string | null;
  podcastRevision: number;
  currentTimeMs: number;
  isPlaying: boolean;
  onTimeUpdate: (timeMs: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
}

const RemotionPreviewPlayerInner = forwardRef<RemotionPreviewHandle, RemotionPreviewPlayerProps>(
  function RemotionPreviewPlayer(
    {
      timeline,
      srtEntries,
      projectDir,
      podcastRevision,
      currentTimeMs,
      isPlaying,
      onTimeUpdate,
      onPlay,
      onPause,
      onEnded,
    },
    ref,
  ) {
    const player = useRef<PlayerRef>(null);
    // 媒体卡（image / video）的 assetPath 相对 projectDir 存储；预览没有 bundle public 目录，
    // 需先解析为绝对路径，AICardOverlay 才能用 file:// 加载图片 / 视频。
    const renderTimeline = useMemo(
      () => hydrateAICardAssetPaths(timeline, projectDir ?? null),
      [timeline, projectDir],
    );
    const plan = useMemo(
      () => buildRenderPlan(renderTimeline, srtEntries, renderTimeline.fps ?? 30),
      [renderTimeline, srtEntries],
    );
    const fps = plan.fps;
    const suppressSeek = useRef(false);

    // 预览前把 motion 卡片 TSX 编译为可执行 JS（主进程 esbuild），供 CardHost 求值。
    const [compiledCards, setCompiledCards] = useState<Record<string, string>>({});
    const previewAudioSources = useMemo(
      () => getPreviewAudioSources(plan.audio, podcastRevision),
      [plan.audio, podcastRevision],
    );
    const previewAudioSourcesKey = previewAudioSources.join('\0');
    const inputProps = useMemo(
      () => ({
        timeline: renderTimeline,
        srtEntries,
        compiledCards,
        cardProjectDir: projectDir ?? undefined,
        podcastRevision,
      }),
      [renderTimeline, srtEntries, compiledCards, projectDir, podcastRevision],
    );
    const playerStyle = useMemo(
      () => ({ width: '100%', height: '100%', background: 'var(--color-preview-bg)' }),
      [],
    );
    const cardSources = useMemo(() => collectMotionCards(renderTimeline), [renderTimeline]);
    useEffect(() => {
      let cancelled = false;
      if (cardSources.length === 0) {
        setCompiledCards({});
        return;
      }
      const compile = window.electronAPI?.compileMotionCards;
      if (!compile) return;
      void compile({ cards: cardSources, projectDir }).then((map) => {
        if (cancelled) return;
        const compiledCount = Object.keys(map).length;
        if (compiledCount < cardSources.length) {
          console.warn(
            `[lingji motion-card] 预览编译缺失：${compiledCount}/${cardSources.length}`,
          );
        }
        setCompiledCards(map);
      }).catch((error) => {
        if (!cancelled) {
          console.error('[lingji motion-card] 预览编译失败', error);
          setCompiledCards({});
        }
      });
      return () => {
        cancelled = true;
      };
    }, [cardSources]);

    useEffect(() => preloadPreviewAudioSources(previewAudioSources), [previewAudioSourcesKey]);

    useImperativeHandle(ref, () => ({
      play: () => player.current?.play(),
      pause: () => player.current?.pause(),
      seekToMs: (ms: number) => {
        suppressSeek.current = true;
        player.current?.seekTo(Math.round((Math.max(0, ms) / 1000) * fps));
        window.setTimeout(() => {
          suppressSeek.current = false;
        }, 0);
      },
      isPlaying: () => !!player.current?.isPlaying(),
      setVolume: (volume: number) => player.current?.setVolume(Math.max(0, Math.min(1, volume))),
      mute: () => player.current?.mute(),
      unmute: () => player.current?.unmute(),
    }));

    useEffect(() => {
      const p = player.current;
      if (!p) return;
      const handleFrame = (e: { detail: { frame: number } }) =>
        onTimeUpdate(Math.round((e.detail.frame / fps) * 1000));
      p.addEventListener('frameupdate', handleFrame);
      p.addEventListener('play', onPlay);
      p.addEventListener('pause', onPause);
      p.addEventListener('ended', onEnded);
      return () => {
        p.removeEventListener('frameupdate', handleFrame);
        p.removeEventListener('play', onPlay);
        p.removeEventListener('pause', onPause);
        p.removeEventListener('ended', onEnded);
      };
    }, [fps, onTimeUpdate, onPlay, onPause, onEnded]);

    useEffect(() => {
      const p = player.current;
      if (!p || suppressSeek.current) return;
      const target = Math.round((Math.max(0, currentTimeMs) / 1000) * fps);
      // 播放中不依据「自己回传的、已滞后的」时间 seek 自己，否则渲染卡顿时会被拽回去
      // 重放一小段音频；外部跳转走命令式 seekToMs，不依赖这里。
      if (
        shouldResyncPreviewSeek({
          isPlaying: !!p.isPlaying(),
          playbackIntentPlaying: isPlaying,
          currentFrame: p.getCurrentFrame(),
          targetFrame: target,
          thresholdFrames: Math.ceil(fps * 0.25),
        })
      ) {
        p.seekTo(target);
      }
    }, [currentTimeMs, fps, isPlaying]);

    return (
      <Player
        ref={player}
        component={MainComposition}
        inputProps={inputProps}
        durationInFrames={plan.durationFrames}
        compositionWidth={plan.width}
        compositionHeight={plan.height}
        fps={fps}
        style={playerStyle}
        controls={false}
        acknowledgeRemotionLicense
      />
    );
  },
);

function areRemotionPreviewPlayerPropsEqual(
  previous: RemotionPreviewPlayerProps,
  next: RemotionPreviewPlayerProps,
): boolean {
  if (
    previous.timeline !== next.timeline ||
    previous.srtEntries !== next.srtEntries ||
    previous.projectDir !== next.projectDir ||
    previous.podcastRevision !== next.podcastRevision ||
    previous.onTimeUpdate !== next.onTimeUpdate ||
    previous.onPlay !== next.onPlay ||
    previous.onPause !== next.onPause ||
    previous.onEnded !== next.onEnded
  ) {
    return false;
  }

  return !shouldRefreshPreviewForExternalTime({
    previousIsPlaying: previous.isPlaying,
    nextIsPlaying: next.isPlaying,
    previousTimeMs: previous.currentTimeMs,
    nextTimeMs: next.currentTimeMs,
  });
}

export const RemotionPreviewPlayer = memo(
  RemotionPreviewPlayerInner,
  areRemotionPreviewPlayerPropsEqual,
);
