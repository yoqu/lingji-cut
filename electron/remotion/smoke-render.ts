import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Remotion from 'remotion';
import { compileCardTsx } from './compile-card-node';
import { createMotionKit, MOTION_CAMERA_MAX_SCALE, type MotionKitRemotion } from '../../src/remotion/motion-kit';
import type { CardAssetBinding } from '../../src/types/assets';
import type {
  MotionCardMechanicalValidation,
  MotionCardValidationInput,
  TimingPlan,
} from '../../src/types/motion';
import {
  isMotionAssetUnderlay,
  motionAssetSignature,
  motionAssetStyle,
} from '../../src/lib/motion-asset-layer';

export interface SmokeRenderResult {
  ok: boolean;
  error?: string;
}

export interface CardValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  frame?: number;
  element?: string;
}

export interface MotionCardValidationResult {
  ok: boolean;
  render: SmokeRenderResult;
  issues: CardValidationIssue[];
  framesChecked: number[];
}

export class MotionCardValidationError extends Error {
  constructor(
    message: string,
    public readonly validation: MotionCardMechanicalValidation,
  ) {
    super(message);
    this.name = 'MotionCardValidationError';
  }
}

export interface MotionCardKeyframeMarkup {
  frame: number;
  markup: string;
}

export interface MotionCardContactSheetResult {
  frames: number[];
  png: Buffer;
  cached: boolean;
  cachePath?: string;
}

export interface MotionCardContactSheetOptions {
  frames: number[];
  cues?: number[];
  cardAsset?: (rel: string) => string;
  cacheDir?: string;
  cacheKey?: string;
  thumbWidth?: number;
  columns?: number;
  assetBindings?: CardAssetBinding[];
  timingPlan?: TimingPlan;
  durationInFrames?: number;
}

const SMOKE_DURATION_IN_FRAMES = 150;

export function motionCardContactSheetCacheKey(input: {
  tsx: string;
  frames: number[];
  storyboard?: string;
  assetSignature?: string;
  version?: string;
}): string {
  const hash = crypto.createHash('sha256');
  hash.update(input.version ?? 'v1');
  hash.update('\0');
  hash.update(input.tsx);
  hash.update('\0');
  hash.update(input.frames.join(','));
  hash.update('\0');
  hash.update(input.storyboard ?? '');
  hash.update('\0');
  hash.update(input.assetSignature ?? '');
  return hash.digest('hex').slice(0, 24);
}

/**
 * 构造一份只覆盖 useCurrentFrame / useVideoConfig 的 Remotion 垫片：
 * 真实 remotion 的这两个 hook 在 Composition 上下文外会抛错，
 * 而我们要在生成期"裸渲染"卡片，因此必须用固定值覆盖。
 * 其余 interpolate / spring / Easing / AbsoluteFill / Sequence 等保持真实实现。
 */
function makeRemotionShim(frame: number, durationInFrames = SMOKE_DURATION_IN_FRAMES): typeof Remotion {
  return {
    ...Remotion,
    useCurrentFrame: () => frame,
    useVideoConfig: () => ({
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames,
      id: 'smoke',
      defaultProps: {},
      props: {},
    }),
  } as unknown as typeof Remotion;
}

/**
 * 求值主进程 esbuild 编译出的卡片 CJS 模块，返回其 default 导出的组件。
 * 与 src/remotion/card-host.tsx 的 evalCardComponent 对齐：react / react/jsx-runtime 注入宿主实例，
 * remotion 注入带固定 frame/config 的垫片，使 useCurrentFrame 等可在 Composition 上下文外正常工作。
 */
function evalCardComponent(
  compiledJs: string,
  frame: number,
  cardAsset: (rel: string) => string = (rel) => rel,
  durationInFrames = SMOKE_DURATION_IN_FRAMES,
): React.ComponentType<Record<string, unknown>> | null {
  if (!compiledJs.trim()) return null;
  const remotionShim = makeRemotionShim(frame, durationInFrames);
  // motion-kit 绑定当前帧的 remotion 垫片，使 kit 内部 useCurrentFrame/useVideoConfig 在裸渲染下可用。
  const motionKit = createMotionKit(remotionShim as unknown as MotionKitRemotion);
  const requireShim = (id: string): unknown => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return JsxRuntime;
    if (id === 'remotion') return remotionShim;
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

function normalizeFrames(frames: number[]): number[] {
  return Array.from(
    new Set(
      frames
        .map((frame) => Math.max(0, Math.round(frame)))
        .filter((frame) => Number.isFinite(frame)),
    ),
  ).sort((a, b) => a - b);
}

export async function renderMotionCardKeyframeMarkups(
  tsx: string,
  options: Pick<
    MotionCardContactSheetOptions,
    'frames' | 'cues' | 'cardAsset' | 'timingPlan' | 'durationInFrames'
  >,
): Promise<MotionCardKeyframeMarkup[]> {
  const compiled = await compileCardTsx('contact-sheet', tsx);
  if (compiled.error || !compiled.js) {
    throw new Error(compiled.error ?? 'Motion Card 编译产物为空');
  }

  const frames = normalizeFrames(options.frames);
  const durationInFrames = Math.max(1, Math.round(options.durationInFrames ?? SMOKE_DURATION_IN_FRAMES));
  const markups: MotionCardKeyframeMarkup[] = [];
  for (const frame of frames) {
    const Comp = evalCardComponent(compiled.js, frame, options.cardAsset, durationInFrames);
    if (!Comp) {
      throw new Error('Motion Card 未导出可渲染组件');
    }
    markups.push({
      frame,
      markup: renderToStaticMarkup(React.createElement(Comp, {
        cues: options.cues ?? [],
        timingPlan: options.timingPlan,
      })),
    });
  }
  return markups;
}

function contactSheetHtml(
  markups: MotionCardKeyframeMarkup[],
  options: {
    thumbWidth: number;
    columns: number;
    assetBindings?: CardAssetBinding[];
    timingPlan?: TimingPlan;
    durationInFrames: number;
  },
): string {
  const { thumbWidth, columns } = options;
  const scale = thumbWidth / 1920;
  const thumbHeight = Math.round(1080 * scale);
  const gap = 16;
  const rows = Math.max(1, Math.ceil(markups.length / columns));
  const width = columns * thumbWidth + (columns + 1) * gap;
  const height = rows * (thumbHeight + 28) + (rows + 1) * gap;
  const assetMarkup = (frame: number, underlay: boolean) => (options.assetBindings ?? [])
    .filter((binding) => isMotionAssetUnderlay(binding) === underlay)
    .map((binding) => renderToStaticMarkup(React.createElement('img', {
      key: `${binding.slot}:${binding.assetId}`,
      src: binding.filePath,
      alt: '',
      style: motionAssetStyle(binding, frame, {
        width: 1920,
        height: 1080,
        durationInFrames: options.durationInFrames,
        timingPlan: options.timingPlan,
      }),
    })))
    .join('');
  const hasUnderlay = options.assetBindings?.some(isMotionAssetUnderlay) === true;
  const cells = markups
    .map(
      ({ frame, markup }) => `
        <section class="cell">
          <div class="shot">
            <div class="stage"${hasUnderlay ? ' style="--lingji-card-stage-bg:transparent"' : ''}>
              ${assetMarkup(frame, true)}
              <div class="card">${markup}</div>
              ${assetMarkup(frame, false)}
            </div>
          </div>
          <div class="label">frame ${frame}</div>
        </section>`,
    )
    .join('');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; padding: 0; width: ${width}px; min-height: ${height}px; background: #111318; }
    body { box-sizing: border-box; padding: ${gap}px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #d8dce7; }
    .grid { display: grid; grid-template-columns: repeat(${columns}, ${thumbWidth}px); gap: ${gap}px; }
    .cell { width: ${thumbWidth}px; }
    .shot { width: ${thumbWidth}px; height: ${thumbHeight}px; overflow: hidden; background: #05070a; border: 1px solid rgba(255,255,255,0.14); box-sizing: border-box; }
    .stage { position: relative; width: 1920px; height: 1080px; transform: scale(${scale}); transform-origin: top left; overflow: hidden; }
    .card { position: absolute; inset: 0; z-index: 1; }
    .label { height: 20px; padding-top: 6px; font-size: 12px; line-height: 1; color: rgba(216,220,231,0.72); }
  </style>
</head>
<body><main class="grid">${cells}</main></body>
</html>`;
}

export async function renderMotionCardContactSheet(
  tsx: string,
  options: MotionCardContactSheetOptions,
): Promise<MotionCardContactSheetResult> {
  const frames = normalizeFrames(options.frames);
  const cacheKey = options.cacheKey ?? motionCardContactSheetCacheKey({
    tsx,
    frames,
    assetSignature: motionAssetSignature(options.assetBindings ?? []),
  });
  const cachePath = options.cacheDir ? path.join(options.cacheDir, `${cacheKey}.png`) : undefined;
  if (cachePath) {
    try {
      return { frames, png: await fs.readFile(cachePath), cached: true, cachePath };
    } catch {
      // cache miss
    }
  }

  const markups = await renderMotionCardKeyframeMarkups(tsx, { ...options, frames });
  const thumbWidth = options.thumbWidth ?? 360;
  const columns = Math.max(1, options.columns ?? Math.min(3, Math.max(1, markups.length)));
  const html = contactSheetHtml(markups, {
    thumbWidth,
    columns,
    assetBindings: options.assetBindings,
    timingPlan: options.timingPlan,
    durationInFrames: options.durationInFrames ?? SMOKE_DURATION_IN_FRAMES,
  });
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const rows = Math.max(1, Math.ceil(markups.length / columns));
    const scale = thumbWidth / 1920;
    const thumbHeight = Math.round(1080 * scale);
    const gap = 16;
    const viewport = {
      width: columns * thumbWidth + (columns + 1) * gap,
      height: rows * (thumbHeight + 28) + (rows + 1) * gap,
    };
    const page = await browser.newPage({ viewport });
    try {
      await page.setContent(html, { waitUntil: 'load' });
      const png = await page.screenshot({ type: 'png', fullPage: true });
      if (cachePath) {
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, png);
      }
      return { frames, png, cached: false, cachePath };
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

function stripTags(markup: string): string {
  return markup
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function visibleTextRuns(markup: string): string[] {
  return stripTags(markup)
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function countPattern(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

interface LayoutProbe {
  frame: number;
  nodeIndex: number;
  parentIndex: number | null;
  tag: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  position: string;
  display: string;
  textAlign: string;
  whiteSpace: string;
  overflowWrap: string;
  wordBreak: string;
  overflowX: string;
  overflowY: string;
  opacity: number;
  visibility: string;
  zIndex: string;
  directText: boolean;
  isMedia: boolean;
  /** 计算样式 color（rgb/rgba 字符串） */
  color: string;
  /** 沿祖先链合成出的有效背景色 [r,g,b]（0-255）；遇渐变/图片或无不透明底时为 null（跳过对比度检查） */
  effectiveBg: [number, number, number] | null;
  /** 元素 data-role 属性（如 CardStage 内容盒标记 "cardstage-content"），无则 undefined */
  role?: string;
  motionId?: string;
  motionLayer?: string;
  motionDepth?: string;
  allowOverlap?: boolean;
}

/** 解析 computed style 的 rgb()/rgba() 颜色为 [r,g,b,a]。 */
function parseRgb(color: string): [number, number, number, number] | null {
  const m = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*(\d+(?:\.\d+)?)\s*)?\)$/.exec(color.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

function srgbLuminance([r, g, b]: [number, number, number]): number {
  const ch = (v: number) => {
    const n = v / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** 文字与其有效背景的 WCAG 对比度；颜色不可解析 / 背景不确定 / 文字透明时返回 null（不判）。 */
function textContrastRatio(node: LayoutProbe): number | null {
  if (!node.effectiveBg) return null;
  const fg = parseRgb(node.color);
  if (!fg) return null;
  const [r, g, b, a] = fg;
  if (a < 0.1) return null; // 全透明文字视为有意隐藏（入场动画走 opacity，不走 color alpha）
  const bg = node.effectiveBg;
  const composited: [number, number, number] = [
    r * a + bg[0] * (1 - a),
    g * a + bg[1] * (1 - a),
    b * a + bg[2] * (1 - a),
  ];
  const lf = srgbLuminance(composited);
  const lb = srgbLuminance(bg);
  return (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
}

function rectsOverlap(a: LayoutProbe, b: LayoutProbe): boolean {
  return a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y;
}

function validationAssetMarkup(
  frame: number,
  bindings: CardAssetBinding[],
  underlay: boolean,
  timingPlan: TimingPlan | undefined,
  durationInFrames: number,
): string {
  return bindings
    .filter((binding) => isMotionAssetUnderlay(binding) === underlay)
    .map((binding) => {
      const style = motionAssetStyle(binding, frame, {
        width: 1920,
        height: 1080,
        durationInFrames,
        timingPlan,
      });
      if (style.height == null) {
        const sourceWidth = binding.metadata?.width ?? 0;
        const sourceHeight = binding.metadata?.height ?? 0;
        const width = typeof style.width === 'number' ? style.width : binding.placement.width;
        style.height = sourceWidth > 0 && sourceHeight > 0
          ? width * (sourceHeight / sourceWidth)
          : width * 0.75;
      }
      return renderToStaticMarkup(React.createElement('img', {
        src: binding.filePath,
        alt: '',
        'data-motion-id': `asset:${binding.slot}`,
        'data-motion-layer': underlay ? 'asset-underlay' : 'asset-foreground',
        'data-motion-depth': binding.placement.depth ?? 'midground',
        style,
      }));
    })
    .join('');
}

async function inspectRenderedLayout(
  markups: MotionCardKeyframeMarkup[],
  options: {
    assetBindings?: CardAssetBinding[];
    timingPlan?: TimingPlan;
    durationInFrames: number;
  },
): Promise<LayoutProbe[] | null> {
  if (!markups.length) return [];
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    try {
      const nodes: LayoutProbe[] = [];
      for (const { frame, markup } of markups) {
        const underlay = validationAssetMarkup(
          frame,
          options.assetBindings ?? [],
          true,
          options.timingPlan,
          options.durationInFrames,
        );
        const foreground = validationAssetMarkup(
          frame,
          options.assetBindings ?? [],
          false,
          options.timingPlan,
          options.durationInFrames,
        );
        await page.setContent(
          `<!doctype html><html><head><style>html,body{margin:0;padding:0;width:1920px;height:1080px;overflow:hidden}#root,.stage{position:relative;width:1920px;height:1080px;overflow:hidden}.card{position:absolute;inset:0;z-index:1}</style></head><body><div id="root"><div class="stage">${underlay}<div class="card">${markup}</div>${foreground}</div></div></body></html>`,
          { waitUntil: 'load' },
        );
        nodes.push(
          ...(await page.evaluate((currentFrame) => {
            const elements = Array.from(document.querySelectorAll('#root *'));
            return elements.map((el, nodeIndex) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el as Element);
            const directText = Array.from(el.childNodes).some((n) => Boolean(n.nodeType === Node.TEXT_NODE && n.textContent?.trim()));
            const text = (el.textContent ?? '').trim();
            let effectiveOpacity = 1;
            let opacityNode: Element | null = el as Element;
            while (opacityNode && opacityNode.id !== 'root') {
              effectiveOpacity *= Number.parseFloat(getComputedStyle(opacityNode).opacity || '1');
              opacityNode = opacityNode.parentElement;
            }
            // 有效背景：从自身沿祖先链合成 background-color（rgba 按 alpha 叠加），
            // 直到不透明底；途中遇渐变/图片背景或到根仍无不透明底 → null（对比度不判）。
            const effectiveBg = ((): [number, number, number] | null => {
              const parse = (c: string): [number, number, number, number] | null => {
                const m = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*(\d+(?:\.\d+)?)\s*)?\)$/.exec(c.trim());
                return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null;
              };
              const layers: Array<[number, number, number, number]> = [];
              let node: Element | null = el as Element;
              let opaque = false;
              while (node && node.id !== 'root') {
                const cs = getComputedStyle(node);
                if (cs.backgroundImage !== 'none') return null;
                const c = parse(cs.backgroundColor);
                if (!c) return null;
                if (c[3] > 0) layers.push(c);
                if (c[3] >= 1) {
                  opaque = true;
                  break;
                }
                node = node.parentElement;
              }
              if (!opaque) return null;
              let [br, bgc, bb] = layers.pop() as [number, number, number, number];
              while (layers.length > 0) {
                const [r2, g2, b2, a2] = layers.pop() as [number, number, number, number];
                br = r2 * a2 + br * (1 - a2);
                bgc = g2 * a2 + bgc * (1 - a2);
                bb = b2 * a2 + bb * (1 - a2);
              }
              return [br, bgc, bb];
            })();
            return {
              frame: currentFrame,
              nodeIndex,
              parentIndex: el.parentElement ? elements.indexOf(el.parentElement) : -1,
              tag: (el as Element).tagName.toLowerCase(),
              text,
              x: r.x, y: r.y, width: r.width, height: r.height,
              scrollWidth: (el as HTMLElement).scrollWidth,
              scrollHeight: (el as HTMLElement).scrollHeight,
              clientWidth: (el as HTMLElement).clientWidth,
              clientHeight: (el as HTMLElement).clientHeight,
              position: s.position,
              display: s.display,
              textAlign: s.textAlign,
              whiteSpace: s.whiteSpace,
              overflowWrap: s.overflowWrap,
              wordBreak: s.wordBreak,
              overflowX: s.overflowX,
              overflowY: s.overflowY,
              opacity: effectiveOpacity,
              visibility: s.visibility,
              zIndex: s.zIndex,
              directText,
              isMedia: ['img', 'video', 'canvas', 'svg'].includes((el as Element).tagName.toLowerCase()),
              color: s.color,
              effectiveBg,
              role: (el as HTMLElement).dataset.role || undefined,
              motionId: (el as HTMLElement).dataset.motionId || undefined,
              motionLayer: (el as HTMLElement).dataset.motionLayer || undefined,
              motionDepth: (el as HTMLElement).dataset.motionDepth || undefined,
              allowOverlap: (el as HTMLElement).dataset.motionAllowOverlap === 'true',
            };
          });
          }, frame)).map((node) => ({
            ...node,
            parentIndex: node.parentIndex >= 0 ? node.parentIndex : null,
          })) as LayoutProbe[],
        );
      }
      return nodes.filter(
        (n) =>
          n.opacity > 0.03 &&
          n.visibility !== 'hidden' &&
          ((n.width > 0 && n.height > 0 && n.display !== 'none' && n.position !== 'fixed') ||
            n.isMedia ||
            n.directText),
      );
    } finally {
      await page?.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  } catch {
    return null;
  }
}

async function inspectLayoutRisks(
  tsx: string,
  markups: MotionCardKeyframeMarkup[],
  checkRenderedLayout: boolean,
  options: {
    assetBindings?: CardAssetBinding[];
    timingPlan?: TimingPlan;
    durationInFrames: number;
  },
): Promise<CardValidationIssue[]> {
  const issues: CardValidationIssue[] = [];
  const markupSources = markups.map((item) => item.markup);
  const text = markupSources.map(stripTags).join(' ').trim();
  const textRuns = markupSources.flatMap(visibleTextRuns);
  const longestRun = textRuns.reduce((max, run) => Math.max(max, run.length), 0);
  const absoluteCount = countPattern(tsx, /position\s*:\s*['"]absolute['"]/g);
  const hasTextAlignment =
    /textAlign\s*:|text-align:|alignItems\s*:|align-items:|justifyContent\s*:|justify-content:/.test(
      tsx,
    );
  const hasWrapping =
    /lineHeight\s*:|line-height:|whiteSpace\s*:|white-space:|overflowWrap\s*:|overflow-wrap:|wordBreak\s*:|word-break:/.test(
      tsx,
    );

  if (/return\s+null\b|=>\s*null\b/.test(tsx)) {
    issues.push({
      severity: 'error',
      code: 'returns-null',
      message: '源码包含 return null，可能导致卡片黑屏。',
    });
  }
  if (/TODO|build out the rest|继续完善|省略/.test(tsx)) {
    issues.push({
      severity: 'error',
      code: 'unfinished-source',
      message: '源码包含 TODO/省略类占位内容，请补全后再写入卡片。',
    });
  }
  if (!text && !/<svg|<img|<video|<canvas/i.test(markupSources.join(' '))) {
    issues.push({
      severity: 'warning',
      code: 'no-visible-content',
      message: '渲染结果未发现可见文字或媒体/图形元素，可能是空卡片。',
    });
  }
  if (longestRun >= 28 && !hasWrapping) {
    issues.push({
      severity: 'warning',
      code: 'long-text-no-wrap',
      message: `检测到较长文本片段（约 ${longestRun} 字）但未发现换行/行高/断词控制，存在溢出或遮挡风险。`,
    });
  }
  if (absoluteCount >= 8) {
    issues.push({
      severity: 'warning',
      code: 'many-absolute-elements',
      message: `检测到 ${absoluteCount} 个 absolute 定位元素，文字或图形存在互相遮挡风险。`,
    });
  }
  // kit 卡的对齐与缓动工艺在 @lingji/motion-kit 内部实现，卡片源码看不到这些关键词，
  // 源码级启发式（对齐缺失 / 缓动单调）只对非 kit 卡生效。
  const usesMotionKit = tsx.includes('@lingji/motion-kit');
  if (textRuns.length >= 3 && !hasTextAlignment && !usesMotionKit) {
    issues.push({
      severity: 'warning',
      code: 'missing-alignment-style',
      message: '存在多段文本但未发现 textAlign/alignItems/justifyContent 等对齐约束，可能出现对齐不稳定。',
    });
  }
  if (/(left|top|right|bottom)\s*:\s*-\d/.test(tsx)) {
    issues.push({
      severity: 'warning',
      code: 'negative-position',
      message: '检测到负向 left/top/right/bottom 定位，元素可能跑出卡片画布。',
    });
  }
  if (/fontSize\s*:\s*(?:['"])?(?:[9-9]\d|[1-9]\d{2,})/.test(tsx) && longestRun >= 14) {
    issues.push({
      severity: 'warning',
      code: 'large-font-long-text',
      message: '检测到大字号与较长文本组合，需确认移动端/导出画面里不会遮挡或溢出。',
    });
  }
  const easingVariety = new Set(Array.from(tsx.matchAll(/Easing\.(?:in|out|inOut)?\(?[A-Za-z]*/g), (m) => m[0])).size;
  if (easingVariety < 2 && !/\bspring\s*\(/.test(tsx) && !usesMotionKit) {
    issues.push({
      severity: 'warning',
      code: 'monotone-easing',
      message: '整卡缓动种类不足 2 种且未使用 spring，动效可能单调（运动多样性不足）。',
    });
  }
  if (!checkRenderedLayout) return issues;

  const layoutNodes = await inspectRenderedLayout(markups, options);
  if (layoutNodes === null) {
    issues.push({
      severity: 'warning',
      code: 'layout-probe-unavailable',
      message: 'Playwright 布局探针不可用，已跳过真实盒模型的文字裁切/越界/遮挡检查。',
    });
    return issues;
  }
  const issueCounts = new Map<string, number>();
  const pushCappedIssue = (issue: CardValidationIssue, limit = 3) => {
    const count = issueCounts.get(issue.code) ?? 0;
    if (count < limit) issues.push(issue);
    issueCounts.set(issue.code, count + 1);
  };
  for (const node of layoutNodes) {
    // 容差 24px：吸收有界虚拟摄影机（scale ≤1.02，边缘位移 ≤~19px）造成的设计内出血。
    const outLeft = node.x < -24;
    const outTop = node.y < -24;
    const outRight = node.x + node.width > 1920 + 24;
    const outBottom = node.y + node.height > 1080 + 24;
    if (outLeft || outTop || outRight || outBottom) {
      pushCappedIssue({
        severity: node.isMedia || node.directText ? 'error' : 'warning',
        code: 'layout-overflow',
        message: `frame ${node.frame} 的元素 ${node.tag}（"${node.text.slice(0, 12)}"）超出画布边界（x=${Math.round(node.x)}, y=${Math.round(node.y)}, w=${Math.round(node.width)}, h=${Math.round(node.height)}），可能被裁切。`,
        frame: node.frame,
        element: node.motionId,
      });
    }
    // 底部 20% 为口播字幕安全区；文字/媒体元素起始于画面下部且延伸入安全区（留 4% 容差）按 error。
    // 全高容器（文字实际渲染在顶部）不误报：仅当元素顶边已落在下部 62% 之后才判定。
    if (
      (node.directText || node.isMedia) &&
      node.height > 0 &&
      node.y > 1080 * 0.62 &&
      node.y + node.height > 1080 * 0.84
    ) {
      pushCappedIssue({
        severity: 'error',
        code: 'subtitle-zone-violation',
        message: `frame ${node.frame} 的元素 ${node.tag}（"${node.text.slice(0, 12)}"）侵入底部字幕安全区（y+height=${Math.round(node.y + node.height)} > ${Math.round(1080 * 0.84)}）；内容必须收在 y ≤ H*0.80 内。`,
        frame: node.frame,
        element: node.motionId,
      });
    }
    // 文字与有效背景对比度：字色 ≈ 底色（撞色）判 error 回喂重修；偏低只警示。
    // error 阈值取 1.8 而非 WCAG 3：浅色预设的 muted 标签对比度合法地落在 2~3 之间。
    if (node.directText && node.text.length >= 2) {
      const ratio = textContrastRatio(node);
      if (ratio != null && ratio < 3) {
        pushCappedIssue({
          severity: ratio < 1.8 ? 'error' : 'warning',
          code: ratio < 1.8 ? 'text-bg-contrast' : 'text-bg-low-contrast',
          message: `文本元素 ${node.tag}（"${node.text.slice(0, 12)}"）字色 ${node.color} 与其所在背景对比度仅 ${ratio.toFixed(2)}:1${ratio < 1.8 ? '，文字与底色几乎同色不可读；换用 tokens 的 ink（深/浅底相应回落），不要把 accent 同时当块底色和字色' : '，偏低，请确认可读性'}。`,
        });
      }
    }
    // 真裁切 = 元素自身 overflow 会剪内容（hidden/clip/scroll/auto）且滚动尺寸超出可视尺寸。
    // overflow: visible 的大字（如 lineHeight ≤1 的 hero 数字）scrollHeight 天然超出，但内容完整渲染，不算截断。
    // 画布级容器（CardStage 根）允许运镜出血：推近本来就会把内容推出画布边缘，
    // 容差直接绑定 kit 的运镜上限（同一真源），内容"真装不下"由 content-box-overflow 精确判定。
    const clipsSelf = (v: string) => v === 'hidden' || v === 'clip' || v === 'scroll' || v === 'auto';
    const isCanvasRoot = node.width >= 1912 && node.height >= 1072;
    const bleed = MOTION_CAMERA_MAX_SCALE - 1;
    const overW = isCanvasRoot ? 1920 * bleed : 1;
    const overH = isCanvasRoot ? 1080 * bleed : 1;
    if (
      (node.text.length >= 18 || node.directText) &&
      ((clipsSelf(node.overflowX) && node.scrollWidth > node.clientWidth + overW) ||
        (clipsSelf(node.overflowY) && node.scrollHeight > node.clientHeight + overH))
    ) {
      pushCappedIssue({
        severity: 'error',
        code: 'text-clipped',
        message: isCanvasRoot
            ? `内容总尺寸（${node.scrollWidth}×${node.scrollHeight}）明显超出画布 1920×1080，放不下的部分会被裁掉——必须删减文字/缩小元素，而不是硬塞。`
          : `frame ${node.frame} 的文本元素 ${node.tag}（"${node.text.slice(0, 12)}"）被自身 overflow 裁切（scroll ${node.scrollWidth}×${node.scrollHeight} > client ${node.clientWidth}×${node.clientHeight}），文字显示不全。`,
        frame: node.frame,
        element: node.motionId,
      });
    }
    // 内容盒累计高度溢出：CardStage 内容区（data-role="cardstage-content"）是 flex column 无 overflow，
    // 子内容超过 0.72H 时 scrollHeight > clientHeight（布局尺寸，不受镜头 scale 影响），
    // 居中对称溢出会被外层 overflow:hidden 裁切，视觉上即"元素全挤叠在一起"。
    if (
      node.role === 'cardstage-content' &&
      node.clientHeight > 0 &&
      node.scrollHeight > node.clientHeight + 1
    ) {
      pushCappedIssue({
        severity: 'error',
        code: 'content-box-overflow',
        message: `frame ${node.frame} 的内容区元素累计高度 ${Math.round(node.scrollHeight)}px 超过可用 ${Math.round(node.clientHeight)}px（0.72H），会被居中裁切--必须删减元素/缩短文案/减少列表项，而不是堆叠。`,
        frame: node.frame,
        element: node.motionId,
      });
    }
  }
  const byFrame = new Map<number, Map<number, LayoutProbe>>();
  for (const node of layoutNodes) {
    const frameNodes = byFrame.get(node.frame) ?? new Map<number, LayoutProbe>();
    frameNodes.set(node.nodeIndex, node);
    byFrame.set(node.frame, frameNodes);
  }
  const isAncestor = (candidate: LayoutProbe, node: LayoutProbe): boolean => {
    if (candidate.frame !== node.frame) return false;
    const frameNodes = byFrame.get(node.frame);
    let parentIndex = node.parentIndex;
    while (parentIndex != null) {
      if (parentIndex === candidate.nodeIndex) return true;
      parentIndex = frameNodes?.get(parentIndex)?.parentIndex ?? null;
    }
    return false;
  };
  const overlapRatio = (a: LayoutProbe, b: LayoutProbe): number => {
    const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    const smallerArea = Math.max(1, Math.min(a.width * a.height, b.width * b.height));
    return (width * height) / smallerArea;
  };
  const collisionLabel = (node: LayoutProbe): string =>
    node.motionId ?? `${node.tag}${node.text ? `「${node.text.slice(0, 12)}」` : ''}`;
  const ignoredLayer = (node: LayoutProbe): boolean =>
    node.allowOverlap || node.motionLayer === 'decorative' || node.motionLayer === 'asset-underlay';
  interface OverlapHit {
    frame: number;
    ratio: number;
    certain: boolean;
    labelA: string;
    labelB: string;
  }
  // 先按元素对聚合全部采样帧的命中，再统一判定——单帧碰撞不能直接定级（见下方持续性规则）。
  const overlapHits = new Map<string, OverlapHit[]>();
  for (let i = 0; i < layoutNodes.length; i += 1) {
    for (let j = i + 1; j < layoutNodes.length; j += 1) {
      const a = layoutNodes[i];
      const b = layoutNodes[j];
      if (a.frame !== b.frame) continue;
      if (isAncestor(a, b) || isAncestor(b, a)) continue;
      if (ignoredLayer(a) || ignoredLayer(b)) continue;
      if (!rectsOverlap(a, b)) continue;
      if (a.text === b.text && a.tag === b.tag) continue;
      const ratio = overlapRatio(a, b);
      if (ratio < 0.08) continue;
      const textText = a.directText && b.directText;
      const foregroundAsset =
        (a.motionLayer === 'asset-foreground' && b.directText)
        || (b.motionLayer === 'asset-foreground' && a.directText);
      const semanticBlocks = a.motionLayer === 'semantic' && b.motionLayer === 'semantic';
      const certainOcclusion = textText || foregroundAsset || semanticBlocks;
      if (!certainOcclusion && !(a.directText || b.directText || a.isMedia || b.isMedia)) continue;
      const labelA = collisionLabel(a);
      const labelB = collisionLabel(b);
      const pairKey = labelA <= labelB ? `${labelA}↔${labelB}` : `${labelB}↔${labelA}`;
      const hits = overlapHits.get(pairKey) ?? [];
      hits.push({ frame: a.frame, ratio, certain: certainOcclusion, labelA, labelB });
      overlapHits.set(pairKey, hits);
    }
  }
  // 落定帧 = 采样集合的最后一帧（selectMotionCardProbeFrames / 默认帧集都保证含末帧）。
  const settledFrame = layoutNodes.reduce((max, node) => Math.max(max, node.frame), 0);
  for (const hits of overlapHits.values()) {
    const worst = hits.reduce((max, hit) => (hit.ratio > max.ratio ? hit : max));
    const hitFrames = new Set(hits.map((hit) => hit.frame));
    // 持续遮挡才算布局问题：同一对元素在 ≥2 个采样帧重叠，或在落定帧仍重叠。
    // 只命中单个采样帧且落定帧无重叠 = 入场滑入 / emphasis 落定弹簧的瞬时交叠
    // （如 slam 的 translateY(-14px) scale(1.12) 只存在 land 后十余帧，静态槽位并无重叠），
    // 降级 warning，不再回退卡。
    const persistent = hitFrames.size >= 2 || hitFrames.has(settledFrame);
    const pairText = `${worst.labelA} 与 ${worst.labelB}`;
    const element = `${worst.labelA} ↔ ${worst.labelB}`;
    if (worst.certain && persistent) {
      pushCappedIssue({
        severity: 'error',
        code: 'semantic-occlusion',
        message: `frame ${worst.frame} 检测到 ${pairText} 重叠 ${(worst.ratio * 100).toFixed(1)}%，已形成语义内容遮挡，必须调整槽位、删减内容或让旧元素退出。`,
        frame: worst.frame,
        element,
      }, 5);
    } else if (worst.certain) {
      pushCappedIssue({
        severity: 'warning',
        code: 'semantic-occlusion',
        message: `frame ${worst.frame} 检测到 ${pairText} 重叠 ${(worst.ratio * 100).toFixed(1)}%，仅命中单个采样帧且落定帧无重叠，判定为动画瞬态交叠（emphasis 弹簧 / 入场滑入），不按遮挡阻断；若成片可见持续穿帮再调整槽位。`,
        frame: worst.frame,
        element,
      }, 5);
    } else {
      pushCappedIssue({
        severity: 'warning',
        code: 'possible-occlusion',
        message: `frame ${worst.frame} 检测到 ${pairText} 重叠 ${(worst.ratio * 100).toFixed(1)}%，需确认是否为有意叠加。`,
        frame: worst.frame,
        element,
      }, 5);
    }
  }
  return issues;
}

/**
 * 生成期"冒烟渲染"：编译并实际渲染一次卡片组件（帧 0 与末帧）。
 * 捕获"能编译但渲染即崩"的运行时错误（如引用未声明变量、render 内抛错），
 * 让上层把这类卡片当作生成失败并触发重试，避免坏卡片落库。
 */
export async function smokeRenderCardTsx(tsx: string): Promise<SmokeRenderResult> {
  const validation = await validateMotionCardTsx(tsx, { checkRenderedLayout: false });
  return { ok: validation.render.ok, error: validation.render.error };
}

export async function validateMotionCardTsx(
  tsx: string,
  options: MotionCardValidationInput & {
    cardAsset?: (rel: string) => string;
  } = {},
): Promise<MotionCardValidationResult> {
  const compiled = await compileCardTsx('smoke', tsx);
  if (compiled.error || !compiled.js) {
    const render = { ok: false, error: compiled.error ?? 'Motion Card 编译产物为空' };
    return {
      ok: false,
      render,
      issues: [{ severity: 'error', code: 'compile-failed', message: render.error }],
      framesChecked: [],
    };
  }

  const durationInFrames = Math.max(1, Math.round(options.durationInFrames ?? SMOKE_DURATION_IN_FRAMES));
  const frames = normalizeFrames(
    (options.frames ?? [0, Math.floor(durationInFrames / 2), durationInFrames - 1])
      .map((frame) => Math.min(durationInFrames - 1, frame)),
  );
  const markups: MotionCardKeyframeMarkup[] = [];
  for (const frame of frames) {
    try {
      const Comp = evalCardComponent(compiled.js, frame, options.cardAsset, durationInFrames);
      if (!Comp) {
        const render = { ok: false, error: 'Motion Card 未导出可渲染组件' };
        return {
          ok: false,
          render,
          issues: [{ severity: 'error', code: 'missing-export', message: render.error }],
          framesChecked: frames,
        };
      }
      markups.push({
        frame,
        markup: renderToStaticMarkup(React.createElement(Comp, {
          cues: options.cues ?? [],
          timingPlan: options.timingPlan,
        })),
      });
    } catch (error) {
      const render = { ok: false, error: error instanceof Error ? error.message : String(error) };
      return {
        ok: false,
        render,
        issues: [{ severity: 'error', code: 'render-failed', message: render.error }],
        framesChecked: frames,
      };
    }
  }
  const issues = await inspectLayoutRisks(
    tsx,
    markups,
    options.checkRenderedLayout !== false,
    {
      assetBindings: options.assetBindings,
      timingPlan: options.timingPlan,
      durationInFrames,
    },
  );
  const render = { ok: true };
  const ok = !issues.some((i) => i.severity === 'error');
  return {
    ok,
    render,
    issues,
    framesChecked: frames,
  };
}

/**
 * 生成期断言卡片可渲染；不可渲染或存在 error 级布局问题（文字截断 / 越界 /
 * 字幕安全区侵入）时抛出带"请重新生成"后缀的错误，由编排器修复循环捕获回喂。
 */
export async function assertCardRenders(
  tsx: string,
  options: MotionCardValidationInput = {},
): Promise<MotionCardMechanicalValidation> {
  const result = await validateMotionCardTsx(tsx, { ...options, checkRenderedLayout: true });
  const validation: MotionCardMechanicalValidation = {
    ok: result.ok,
    renderOk: result.render.ok,
    issues: result.issues,
    framesChecked: result.framesChecked,
  };
  if (!result.render.ok) {
    throw new MotionCardValidationError(
      `Motion Card 渲染校验失败：${result.render.error}；请重新生成`,
      validation,
    );
  }
  const errors = result.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    const detail = errors.map((i) => `[${i.code}] ${i.message}`).join('；');
    throw new MotionCardValidationError(
      `Motion Card 布局校验失败：${detail}；请重新生成`,
      validation,
    );
  }
  return validation;
}
