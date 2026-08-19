import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import * as Remotion from 'remotion';
import { staticFile } from 'remotion';
import { Component, useMemo, type CSSProperties, type ReactNode } from 'react';
import { toFileSrc } from '../lib/utils';
import { useIsRendering } from './use-is-rendering';
import {
  makeCardAssetResolver,
  resolveAgentMediaAssets,
  type AgentMediaAsset,
} from './card-asset';
import { resolveAssetSrc } from './asset-src';
import { createMotionKit, type MotionKitRemotion } from './motion-kit';
import type { CardAssetBinding } from '../types/assets';
import type { TimingPlan } from '../types/motion';

type CardAssetResolver = (rel: string) => string;

/** motion-kit 绑定宿主真实 remotion 实例；模块级单例，所有卡片共享。 */
const motionKit = createMotionKit(Remotion as unknown as MotionKitRemotion);

export interface BoundMediaProps {
  slot?: string;
  assetId?: string;
  className?: string;
  style?: CSSProperties;
  fit?: CSSProperties['objectFit'];
  objectPosition?: CSSProperties['objectPosition'];
  muted?: boolean;
  volume?: number;
  loop?: boolean;
  playbackRate?: number;
  /** 覆盖绑定的源媒体裁剪起点。 */
  trimStartMs?: number;
  /** 覆盖绑定记录的源媒体总时长。 */
  durationMs?: number;
}

function msToMediaFrame(ms: number | undefined, fps: number): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(0, Math.round((ms / 1000) * fps));
}

function BoundMediaRenderer({
  assets,
  isRendering,
  fps,
  slot,
  assetId,
  className,
  style,
  fit = 'cover',
  objectPosition,
  muted = true,
  volume,
  loop,
  playbackRate,
  trimStartMs,
  durationMs,
}: BoundMediaProps & {
  assets: AgentMediaAsset[];
  isRendering: boolean;
  fps: number;
}) {
  const asset = assets.find((candidate) =>
    assetId ? candidate.assetId === assetId : candidate.slot === slot,
  );
  if (!asset) return null;

  const mediaStyle: CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: fit,
    objectPosition,
    ...style,
  };
  const diagnostics = {
    'data-agent-media-slot': asset.slot,
    'data-agent-media-asset-id': asset.assetId,
    'data-agent-media-required': asset.required ? 'true' : 'false',
    'data-agent-media-locked': asset.lockedByUser ? 'true' : 'false',
  };

  if (asset.kind === 'image') {
    return (
      <Remotion.Img
        src={asset.src}
        className={className}
        style={mediaStyle}
        {...diagnostics}
      />
    );
  }

  const V = isRendering ? Remotion.OffthreadVideo : Remotion.Video;
  const effectiveTrimStartMs = trimStartMs ?? asset.trimStartMs;
  const effectiveDurationMs = durationMs ?? asset.durationMs;
  const trimBefore = msToMediaFrame(effectiveTrimStartMs, fps);
  const trimAfter = typeof effectiveDurationMs === 'number' && effectiveDurationMs > effectiveTrimStartMs
    ? msToMediaFrame(effectiveDurationMs, fps)
    : undefined;
  return (
    <V
      src={asset.src}
      className={className}
      style={mediaStyle}
      muted={muted}
      volume={volume}
      loop={loop}
      playbackRate={playbackRate}
      trimBefore={trimBefore}
      trimAfter={trimAfter}
      {...diagnostics}
    />
  );
}

/**
 * 评估主进程 esbuild 编译出的卡片 CJS 模块，返回其 default 导出的组件。
 * react / react/jsx-runtime / remotion 通过 require 垫片注入宿主实例，
 * 使卡片与宿主共享同一 Remotion 渲染上下文（useCurrentFrame 等可用）。
 * cardAsset 作为全局注入，供卡片解析项目内图片（见 card-asset.ts）。
 * Agent 合成素材不进入源码，而是由 CardHost 通过 mediaAssets / BoundMedia props 注入。
 *
 * 安全说明：这里对 AI 生成代码使用 Function 求值，需要渲染面允许 'unsafe-eval'。
 * 预览运行在应用渲染进程；导出运行在 Remotion 自带的无头 Chrome，二者均为本地可信环境。
 */
function evalCardComponent(
  compiledJs: string,
  cardAsset: CardAssetResolver,
): React.ComponentType<Record<string, unknown>> | null {
  if (!compiledJs.trim()) return null;
  const requireShim = (id: string): unknown => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return JsxRuntime;
    if (id === 'remotion') return Remotion;
    if (id === '@lingji/motion-kit') return motionKit;
    throw new Error(`Motion Card 不允许引用模块：${id}`);
  };
  const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function('require', 'module', 'exports', 'cardAsset', compiledJs);
  factory(requireShim, moduleObj, moduleObj.exports, cardAsset);
  const exported = moduleObj.exports as { default?: unknown };
  return (exported.default as React.ComponentType<Record<string, unknown>>) ?? null;
}

class CardErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error('[lingji motion-card] 渲染失败', error);
  }
  render() {
    if (this.state.failed) {
      return (
        <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', background: '#101827', color: '#f6f8fb', fontSize: 20 }}>
          卡片渲染失败
        </div>
      );
    }
    return this.props.children;
  }
}

export function CardHost({
  overlayId,
  compiledJs,
  cues,
  timingPlan,
  projectDir,
  transparentStage = false,
  mediaBindings,
}: {
  overlayId: string;
  compiledJs: string;
  /** 逐句字幕节拍（相对卡片 frame 0 的起始帧）；作为 cues prop 注入卡片组件。 */
  cues?: number[];
  /** SRT/分镜推导出的专业节奏计划；作为 timingPlan prop 注入卡片组件。 */
  timingPlan?: TimingPlan;
  /** 项目目录（预览时用于把卡片相对图片解析为 file://；导出时忽略，走 staticFile）。 */
  projectDir?: string;
  /** 外部背景/纹理资产位于卡片下层时，让 motion-kit 的舞台背景透出。 */
  transparentStage?: boolean;
  /** Agent 原子合成素材；仅组合镜头传入，普通卡继续使用旧版外部资产层。 */
  mediaBindings?: CardAssetBinding[];
}) {
  const isRendering = useIsRendering();
  const { fps } = Remotion.useVideoConfig();
  const cardAsset = useMemo(
    () => makeCardAssetResolver({ isRendering, projectDir, staticFile, toFileSrc }),
    [isRendering, projectDir],
  );
  const mediaAssets = useMemo(
    () => resolveAgentMediaAssets(mediaBindings, resolveAssetSrc),
    [mediaBindings],
  );
  const BoundMedia = useMemo<React.ComponentType<BoundMediaProps>>(() => {
    const Component = (props: BoundMediaProps) => (
      <BoundMediaRenderer
        {...props}
        assets={mediaAssets}
        isRendering={isRendering}
        fps={fps}
      />
    );
    Component.displayName = 'BoundMedia';
    return Component;
  }, [fps, isRendering, mediaAssets]);
  const Comp = useMemo(() => {
    try {
      return evalCardComponent(compiledJs, cardAsset);
    } catch (error) {
      console.error('[lingji motion-card] 编译产物求值失败', overlayId, error);
      return null;
    }
  }, [compiledJs, overlayId, cardAsset]);

  if (!Comp) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', background: '#101827', color: '#f6f8fb', fontSize: 20 }}>
        卡片不可用
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 1,
        ...(transparentStage
          ? ({ '--lingji-card-stage-bg': 'transparent' } as React.CSSProperties)
          : {}),
      }}
    >
      <CardErrorBoundary>
        <Comp
          cues={cues ?? []}
          timingPlan={timingPlan}
          mediaAssets={mediaAssets}
          BoundMedia={BoundMedia}
        />
      </CardErrorBoundary>
    </div>
  );
}
