import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import type { AssetItem } from '../types';
import { toFileSrc } from '../lib/utils';
import styles from './SourceAssetPreviewPlayer.module.css';

export type SourcePreviewAsset = Pick<AssetItem, 'path' | 'name' | 'type' | 'durationMs'>;

export interface SourceAssetPreviewHandle {
  play: () => void;
  pause: () => void;
  seekToMs: (ms: number) => void;
  isPlaying: () => boolean;
  setVolume: (volume: number) => void;
  mute: () => void;
  unmute: () => void;
}

interface SourceAssetPreviewPlayerProps {
  asset: SourcePreviewAsset;
  onTimeUpdate: (timeMs: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
}

export const SourceAssetPreviewPlayer = forwardRef<
  SourceAssetPreviewHandle,
  SourceAssetPreviewPlayerProps
>(function SourceAssetPreviewPlayer(
  { asset, onTimeUpdate, onPlay, onPause, onEnded },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const assetSrc = toFileSrc(asset.path);
  const isVideo = asset.type === 'video';

  const getVideo = useCallback(() => videoRef.current, []);

  useImperativeHandle(ref, () => ({
    play: () => {
      const video = getVideo();
      if (!video) return;
      void video.play();
    },
    pause: () => {
      getVideo()?.pause();
    },
    seekToMs: (ms: number) => {
      const video = getVideo();
      if (!video) return;
      video.currentTime = Math.max(0, ms) / 1000;
    },
    isPlaying: () => {
      const video = getVideo();
      return !!video && !video.paused && !video.ended;
    },
    setVolume: (volume: number) => {
      const video = getVideo();
      if (!video) return;
      video.volume = Math.max(0, Math.min(1, volume));
    },
    mute: () => {
      const video = getVideo();
      if (!video) return;
      video.muted = true;
    },
    unmute: () => {
      const video = getVideo();
      if (!video) return;
      video.muted = false;
    },
  }), [getVideo]);

  useEffect(() => {
    if (!isVideo) {
      onTimeUpdate(0);
      onPause();
    }
  }, [isVideo, onPause, onTimeUpdate]);

  if (!isVideo) {
    return (
      <div className={styles.root}>
        <img
          src={assetSrc}
          alt={asset.name}
          className={styles.image}
          draggable={false}
        />
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      key={asset.path}
      src={assetSrc}
      className={styles.video}
      playsInline
      preload="metadata"
      onLoadedMetadata={(event) => onTimeUpdate(event.currentTarget.currentTime * 1000)}
      onTimeUpdate={(event) => onTimeUpdate(event.currentTarget.currentTime * 1000)}
      onPlay={onPlay}
      onPause={onPause}
      onEnded={onEnded}
    />
  );
});
