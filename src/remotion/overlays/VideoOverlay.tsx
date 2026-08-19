import { AbsoluteFill, OffthreadVideo, useCurrentFrame, useVideoConfig, Video } from 'remotion';
import type { OverlayItem } from '../../types';
import { resolveAssetSrc } from '../asset-src';
import { useIsRendering } from '../use-is-rendering';
import { kenBurnsStyle } from '../ken-burns';

export function VideoOverlay({ overlay, zIndex }: { overlay: OverlayItem; zIndex: number }) {
  const isRendering = useIsRendering();
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const V = isRendering ? OffthreadVideo : Video;
  // 源视频裁剪起点（footage 轨的片段级匹配锚点；普通视频 overlay 缺省 0，行为不变）。
  const startFrom = Math.max(0, Math.round(((overlay.trimStartMs ?? 0) / 1000) * fps));
  const cameraStyle = overlay.footageData?.cameraMove
    ? kenBurnsStyle(
        frame,
        Math.max(1, Math.round((overlay.durationMs / 1000) * fps)),
        overlay.id,
        overlay.footageData.cameraMove,
      )
    : undefined;
  return (
    <AbsoluteFill
      style={{
        left: overlay.position.x,
        top: overlay.position.y,
        width: overlay.position.width,
        height: overlay.position.height,
        zIndex,
        overflow: 'hidden',
      }}
    >
      <V
        src={resolveAssetSrc(overlay.assetPath)}
        muted
        startFrom={startFrom}
        style={{ width: '100%', height: '100%', objectFit: 'cover', ...cameraStyle }}
      />
    </AbsoluteFill>
  );
}
