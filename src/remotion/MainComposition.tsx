import { AbsoluteFill, Sequence } from 'remotion';
import { memo, useEffect, useMemo } from 'react';
import type { SrtEntry, TimelineData } from '../types';
import { buildRenderPlan } from './timeline-to-sequences';
import { getStylePresetById } from '../lib/card-style';
import { VideoOverlay } from './overlays/VideoOverlay';
import { ImageOverlay } from './overlays/ImageOverlay';
import { TextOverlay } from './overlays/TextOverlay';
import { AudioOverlay } from './overlays/AudioOverlay';
import { SubtitleLayer } from './overlays/SubtitleLayer';
import { AICardOverlay } from './overlays/AICardOverlay';

// 用 type 而非 interface：Remotion 的 Composition 要求 props 可赋值给
// Record<string, unknown>，interface 缺少隐式索引签名会导致类型不匹配。
export type MainCompositionProps = {
  timeline: TimelineData;
  srtEntries: SrtEntry[];
  /** overlayId → 编译后的卡片 CJS 模块字符串（主进程 esbuild 产出）。 */
  compiledCards?: Record<string, string>;
  /** 项目目录：预览时供卡片 cardAsset 把相对图片解析为 file://（导出走 staticFile，可省）。 */
  cardProjectDir?: string;
  /** 预览专用：同名口播文件被覆盖时刷新媒体 URL；导出不传。 */
  podcastRevision?: number;
  /** 项目级视觉主题预设 id（project.json 的 stylePresetId）；字幕 followTheme 时派生字体与 accent。 */
  themePresetId?: string;
};

export const MainComposition = memo(function MainComposition({
  timeline,
  srtEntries,
  compiledCards,
  cardProjectDir,
  podcastRevision,
  themePresetId,
}: MainCompositionProps) {
  useEffect(() => {
    // One compact marker per render page lets the main process prove whether ANGLE reached
    // the real adapter. Browser debug noise is aggregated per chunk and never written per frame.
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      if (!gl) {
        console.info('[lingji-gpu] WebGL unavailable');
        return;
      }
      const extension = gl.getExtension('WEBGL_debug_renderer_info') as
        | { UNMASKED_RENDERER_WEBGL: number }
        | null;
      const renderer = extension
        ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);
      console.info(`[lingji-gpu] ${String(renderer)}`);
    } catch (error) {
      console.info(`[lingji-gpu] probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const plan = useMemo(
    () => buildRenderPlan(timeline, srtEntries, timeline.fps ?? 30),
    [timeline, srtEntries],
  );
  const subtitleHighlights = timeline.subtitleHighlights ?? [];
  // 字幕主题：未设置项目预设时回落内置默认风格（与 AI 卡片同一兜底路径）。
  const subtitleTheme = useMemo(() => getStylePresetById(themePresetId), [themePresetId]);
  const audioSequences = useMemo(
    () =>
      plan.audio.map((a) => (
        <Sequence
          key={`${a.id}:${a.id === 'podcast-audio' ? podcastRevision ?? 0 : 0}`}
          from={a.startFrame}
          durationInFrames={a.durationFrames}
        >
          <AudioOverlay
            clip={a}
            fps={plan.fps}
            mediaRevision={a.id === 'podcast-audio' ? podcastRevision : undefined}
          />
        </Sequence>
      )),
    [plan.audio, plan.fps, podcastRevision],
  );
  const visualSequences = useMemo(
    () =>
      plan.visual.map((c) => (
        <Sequence key={c.id} from={c.startFrame} durationInFrames={c.durationFrames}>
          {c.kind === 'ai-card' ? (
            <AICardOverlay
              overlay={c.overlay}
              zIndex={c.zIndex}
              compiledJs={compiledCards?.[c.overlay.id]}
              cues={c.cues}
              timingPlan={c.timingPlan}
              transitionIn={c.transitionIn}
              transitionOut={c.transitionOut}
              durationFrames={c.durationFrames}
              projectDir={cardProjectDir}
            />
          ) : c.kind === 'text' ? (
            <TextOverlay overlay={c.overlay} zIndex={c.zIndex} durationFrames={c.durationFrames} />
          ) : c.kind === 'video' ? (
            <VideoOverlay overlay={c.overlay} zIndex={c.zIndex} />
          ) : (
            <ImageOverlay overlay={c.overlay} zIndex={c.zIndex} />
          )}
        </Sequence>
      )),
    [compiledCards, plan.visual, cardProjectDir],
  );
  const subtitleSequences = useMemo(
    () =>
      plan.subtitles.map((s) => (
        <Sequence key={`sub-${s.index}`} from={s.startFrame} durationInFrames={s.durationFrames}>
          <SubtitleLayer cue={s} style={timeline.subtitle} highlights={subtitleHighlights} theme={subtitleTheme} />
        </Sequence>
      )),
    [plan.subtitles, subtitleHighlights, timeline.subtitle, subtitleTheme],
  );

  return (
    <AbsoluteFill style={{ backgroundColor: '#04060a' }}>
      {audioSequences}
      {visualSequences}
      {subtitleSequences}
    </AbsoluteFill>
  );
});
