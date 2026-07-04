import { AbsoluteFill, Img, OffthreadVideo, Video } from 'remotion';
import type { CSSProperties } from 'react';
import type { OverlayItem } from '../../types';
import { CardHost } from '../card-host';
import { resolveAssetSrc } from '../asset-src';
import { useIsRendering } from '../use-is-rendering';
import { resolveAICardRenderPlan } from '../ai-card-render-plan';

/** 卡片内容不可用（媒体未生成 / 缺编译产物）时的通用降级占位。 */
function CardPlaceholder({ title }: { title?: string }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'grid',
        placeItems: 'center',
        background: '#101827',
        color: '#f6f8fb',
        textAlign: 'center',
        padding: 40,
        gap: 12,
      }}
    >
      <div style={{ fontSize: 28, fontWeight: 700 }}>{title || '卡片'}</div>
      <div style={{ fontSize: 20, opacity: 0.7 }}>卡片内容不可用，请重新生成</div>
    </div>
  );
}

export function AICardOverlay({
  overlay,
  zIndex,
  compiledJs,
  cues,
  projectDir,
}: {
  overlay: OverlayItem;
  zIndex: number;
  compiledJs?: string;
  /** 逐句字幕节拍（相对卡片 frame 0 的起始帧），注入卡片组件控制揭示。 */
  cues?: number[];
  /** 项目目录：预览时供卡片 cardAsset 解析相对图片为 file://。 */
  projectDir?: string;
}) {
  const card = overlay.aiCardData;
  const isRendering = useIsRendering();
  if (!card) return null;

  const fullscreen = card.displayMode === 'fullscreen';
  const wrapper: CSSProperties = fullscreen
    ? { position: 'absolute', inset: 0, zIndex, overflow: 'hidden' }
    : {
        position: 'absolute',
        left: overlay.position.x,
        top: overlay.position.y,
        width: overlay.position.width,
        height: overlay.position.height,
        zIndex,
        overflow: 'hidden',
        borderRadius: 18,
        boxShadow: '0 10px 30px rgba(0,0,0,.45)',
      };

  const plan = resolveAICardRenderPlan(card, compiledJs);

  // 媒体卡（image / video）：直接渲染素材。此前缺少该分支，媒体卡会落到 CardHost
  // 且没有编译产物 → 显示「卡片不可用」。
  if (plan.kind === 'media') {
    const src = resolveAssetSrc(plan.assetPath);
    const mediaStyle: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover' };
    if (plan.mediaType === 'video') {
      const V = isRendering ? OffthreadVideo : Video;
      return (
        <AbsoluteFill style={wrapper}>
          <V src={src} muted style={mediaStyle} />
        </AbsoluteFill>
      );
    }
    return (
      <AbsoluteFill style={wrapper}>
        <Img src={src} style={mediaStyle} />
      </AbsoluteFill>
    );
  }

  // 未编译 motion 卡 / 媒体未生成 → 降级占位，提示用户重新生成。
  if (plan.kind === 'placeholder') {
    return (
      <AbsoluteFill style={wrapper}>
        <CardPlaceholder title={card.title} />
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={wrapper}>
      <CardHost overlayId={overlay.id} compiledJs={compiledJs ?? ''} cues={cues} projectDir={projectDir} />
    </AbsoluteFill>
  );
}
