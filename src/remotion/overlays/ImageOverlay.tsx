import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig } from 'remotion';
import type { OverlayItem } from '../../types';
import { resolveAssetSrc } from '../asset-src';
import { kenBurnsStyle } from '../ken-burns';

export function ImageOverlay({ overlay, zIndex }: { overlay: OverlayItem; zIndex: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // footage 轨的图片素材复用现有 Ken Burns 动效；普通导入图片保持原静止行为。
  const motionStyle = overlay.footageData
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
      <Img
        src={resolveAssetSrc(overlay.assetPath)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', ...motionStyle }}
      />
    </AbsoluteFill>
  );
}
