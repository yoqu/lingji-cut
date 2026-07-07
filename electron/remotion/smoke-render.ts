import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Remotion from 'remotion';
import { compileCardTsx } from './compile-card-node';
import { createMotionKit, type MotionKitRemotion } from '../../src/remotion/motion-kit';

export interface SmokeRenderResult {
  ok: boolean;
  error?: string;
}

export interface CardValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface MotionCardValidationResult {
  ok: boolean;
  render: SmokeRenderResult;
  issues: CardValidationIssue[];
  framesChecked: number[];
}

const SMOKE_DURATION_IN_FRAMES = 150;

/**
 * 构造一份只覆盖 useCurrentFrame / useVideoConfig 的 Remotion 垫片：
 * 真实 remotion 的这两个 hook 在 Composition 上下文外会抛错，
 * 而我们要在生成期"裸渲染"卡片，因此必须用固定值覆盖。
 * 其余 interpolate / spring / Easing / AbsoluteFill / Sequence 等保持真实实现。
 */
function makeRemotionShim(frame: number): typeof Remotion {
  return {
    ...Remotion,
    useCurrentFrame: () => frame,
    useVideoConfig: () => ({
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: SMOKE_DURATION_IN_FRAMES,
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
): React.ComponentType<Record<string, unknown>> | null {
  if (!compiledJs.trim()) return null;
  const remotionShim = makeRemotionShim(frame);
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
  directText: boolean;
  isMedia: boolean;
  /** 计算样式 color（rgb/rgba 字符串） */
  color: string;
  /** 沿祖先链合成出的有效背景色 [r,g,b]（0-255）；遇渐变/图片或无不透明底时为 null（跳过对比度检查） */
  effectiveBg: [number, number, number] | null;
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

async function inspectRenderedLayout(markups: string[]): Promise<LayoutProbe[] | null> {
  if (!markups.length) return [];
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    try {
      const nodes: LayoutProbe[] = [];
      for (const markup of markups) {
        await page.setContent(
          `<!doctype html><html><head><style>html,body{margin:0;padding:0;width:1920px;height:1080px;overflow:hidden}#root{width:1920px;height:1080px;overflow:hidden}</style></head><body><div id="root">${markup}</div></body></html>`,
          { waitUntil: 'load' },
        );
        nodes.push(
          ...(await page.evaluate(() => Array.from(document.querySelectorAll('#root *')).map((el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el as Element);
            const directText = Array.from(el.childNodes).some((n) => Boolean(n.nodeType === Node.TEXT_NODE && n.textContent?.trim()));
            const text = (el.textContent ?? '').trim();
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
              directText,
              isMedia: ['img', 'video', 'canvas', 'svg'].includes((el as Element).tagName.toLowerCase()),
              color: s.color,
              effectiveBg,
            };
          }))),
        );
      }
      return nodes.filter(
        (n) =>
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
  markups: string[],
  checkRenderedLayout: boolean,
): Promise<CardValidationIssue[]> {
  const issues: CardValidationIssue[] = [];
  const text = markups.map(stripTags).join(' ').trim();
  const textRuns = markups.flatMap(visibleTextRuns);
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
  if (!text && !/<svg|<img|<video|<canvas/i.test(markups.join(' '))) {
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

  const layoutNodes = await inspectRenderedLayout(markups);
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
        message: `元素 ${node.tag}（"${node.text.slice(0, 12)}"）超出画布边界（x=${Math.round(node.x)}, y=${Math.round(node.y)}, w=${Math.round(node.width)}, h=${Math.round(node.height)}），可能被裁切。`,
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
        message: `元素 ${node.tag}（"${node.text.slice(0, 12)}"）侵入底部字幕安全区（y+height=${Math.round(node.y + node.height)} > ${Math.round(1080 * 0.84)}）；内容必须收在 y ≤ H*0.80 内。`,
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
    // 画布级容器（CardStage 根）允许 ≤3% 的镜头出血；超过即内容真装不下。
    const clipsSelf = (v: string) => v === 'hidden' || v === 'clip' || v === 'scroll' || v === 'auto';
    const isCanvasRoot = node.width >= 1912 && node.height >= 1072;
    const overW = isCanvasRoot ? 1920 * 0.03 : 1;
    const overH = isCanvasRoot ? 1080 * 0.03 : 1;
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
          : `文本元素 ${node.tag}（"${node.text.slice(0, 12)}"）被自身 overflow 裁切（scroll ${node.scrollWidth}×${node.scrollHeight} > client ${node.clientWidth}×${node.clientHeight}），文字显示不全。`,
      });
    }
  }
  for (let i = 0; i < layoutNodes.length; i += 1) {
    for (let j = i + 1; j < layoutNodes.length; j += 1) {
      const a = layoutNodes[i];
      const b = layoutNodes[j];
      if (!rectsOverlap(a, b)) continue;
      if (a.text === b.text && a.tag === b.tag) continue;
      const textHeavy = Boolean(a.directText || a.isMedia || b.directText || b.isMedia);
      if (textHeavy && (a.position !== 'static' || b.position !== 'static')) {
        pushCappedIssue({
          severity: 'warning',
          code: 'possible-occlusion',
          message: `检测到 ${a.tag} 与 ${b.tag} 的可视区域重叠，需确认没有文字/媒体遮挡。`,
        });
      }
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
  options: {
    cues?: number[];
    cardAsset?: (rel: string) => string;
    frames?: number[];
    checkRenderedLayout?: boolean;
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

  const frames = options.frames ?? [0, Math.floor(SMOKE_DURATION_IN_FRAMES / 2), SMOKE_DURATION_IN_FRAMES - 1];
  const markups: string[] = [];
  for (const frame of frames) {
    try {
      const Comp = evalCardComponent(compiled.js, frame, options.cardAsset);
      if (!Comp) {
        const render = { ok: false, error: 'Motion Card 未导出可渲染组件' };
        return {
          ok: false,
          render,
          issues: [{ severity: 'error', code: 'missing-export', message: render.error }],
          framesChecked: frames,
        };
      }
      markups.push(renderToStaticMarkup(React.createElement(Comp, { cues: options.cues ?? [] })));
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
  const issues = await inspectLayoutRisks(tsx, markups, options.checkRenderedLayout !== false);
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
export async function assertCardRenders(tsx: string): Promise<void> {
  const result = await validateMotionCardTsx(tsx, { checkRenderedLayout: true });
  if (!result.render.ok) {
    throw new Error(`Motion Card 渲染校验失败：${result.render.error}；请重新生成`);
  }
  const errors = result.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    const detail = errors.map((i) => `[${i.code}] ${i.message}`).join('；');
    throw new Error(`Motion Card 布局校验失败：${detail}；请重新生成`);
  }
}
