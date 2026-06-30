import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Remotion from 'remotion';
import { compileCardTsx } from './compile-card-node';

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
  const requireShim = (id: string): unknown => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return JsxRuntime;
    if (id === 'remotion') return remotionShim;
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
  directText: boolean;
  isMedia: boolean;
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
              directText,
              isMedia: ['img', 'video', 'canvas', 'svg'].includes((el as Element).tagName.toLowerCase()),
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
  if (textRuns.length >= 3 && !hasTextAlignment) {
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
    const outLeft = node.x < -2;
    const outTop = node.y < -2;
    const outRight = node.x + node.width > 1922;
    const outBottom = node.y + node.height > 1082;
    if (outLeft || outTop || outRight || outBottom) {
      pushCappedIssue({
        severity: node.isMedia || node.directText ? 'error' : 'warning',
        code: 'layout-overflow',
        message: `元素 ${node.tag} 超出画布边界，可能被裁切或遮挡。`,
      });
    }
    if ((node.text.length >= 18 || node.directText) && (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1)) {
      pushCappedIssue({
        severity: 'error',
        code: 'text-clipped',
        message: `文本元素 ${node.tag} 存在滚动尺寸大于可视尺寸的情况，可能发生截断或遮挡。`,
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
 * 生成期断言卡片可渲染；不可渲染时抛出带"请重新生成"后缀的错误，
 * 由 LLM 重试循环捕获并把错误作为提示反馈给模型。
 */
export async function assertCardRenders(tsx: string): Promise<void> {
  const result = await smokeRenderCardTsx(tsx);
  if (!result.ok) {
    throw new Error(`Motion Card 渲染校验失败：${result.error}；请重新生成`);
  }
}
