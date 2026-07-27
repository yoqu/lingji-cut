/**
 * motion-card-lint —— Motion Card TSX 的静态确定性校验（机械质检第一道，毫秒级）。
 *
 * 凡是代码能检查的规则不进提示词、不指望模型自觉：禁 API、非法 import、
 * 组件完整性、内容层循环风险在此拦截。error 回喂雕刻修复；warn 只记录不阻断。
 */

import { MOTION_KIT_EXPORT_NAMES } from '../remotion/motion-kit';

export interface MotionLintIssue {
  severity: 'error' | 'warn';
  code: string;
  message: string;
}

export interface MotionLintResult {
  ok: boolean;
  issues: MotionLintIssue[];
}

export interface MotionLintOptions {
  requireSafeLayout?: boolean;
}

const ALLOWED_IMPORTS = new Set(['remotion', 'react', 'react/jsx-runtime', '@lingji/motion-kit']);

/** 非确定性 / 副作用 API：全部 error（动画必须是 frame 的纯函数）。 */
const BANNED_PATTERNS: Array<{ re: RegExp; code: string; label: string }> = [
  { re: /\bMath\.random\s*\(/, code: 'banned-random', label: 'Math.random()' },
  { re: /\bnew\s+Date\b/, code: 'banned-date', label: 'new Date()' },
  { re: /\bDate\.now\s*\(/, code: 'banned-date', label: 'Date.now()' },
  { re: /\bperformance\.now\s*\(/, code: 'banned-time', label: 'performance.now()' },
  { re: /\bfetch\s*\(/, code: 'banned-network', label: 'fetch()' },
  { re: /\bXMLHttpRequest\b/, code: 'banned-network', label: 'XMLHttpRequest' },
  { re: /\bWebSocket\b/, code: 'banned-network', label: 'WebSocket' },
  { re: /\bsetTimeout\s*\(/, code: 'banned-timer', label: 'setTimeout()' },
  { re: /\bsetInterval\s*\(/, code: 'banned-timer', label: 'setInterval()' },
  { re: /\brequestAnimationFrame\s*\(/, code: 'banned-raf', label: 'requestAnimationFrame()' },
  { re: /\bdocument\s*\./, code: 'banned-dom', label: 'document.*' },
  { re: /\bwindow\s*\./, code: 'banned-dom', label: 'window.*' },
  { re: /\blocalStorage\b/, code: 'banned-dom', label: 'localStorage' },
  { re: /\bimport\s*\(/, code: 'banned-dynamic-import', label: 'dynamic import()' },
];

const UNFINISHED_RE = /\/\/\s*(TODO|FIXME)|build out the rest|继续完善|（省略|\(省略|…\s*$/m;

function collectImports(tsx: string): string[] {
  const specs: string[] = [];
  const importRe = /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g;
  for (const m of tsx.matchAll(importRe)) {
    const spec = m[1] ?? m[2];
    if (spec) specs.push(spec);
  }
  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of tsx.matchAll(requireRe)) specs.push(m[1]);
  return specs;
}

export function lintMotionCardTsx(
  tsx: string,
  options: MotionLintOptions = {},
): MotionLintResult {
  const issues: MotionLintIssue[] = [];
  const source = tsx ?? '';

  if (!source.trim()) {
    return { ok: false, issues: [{ severity: 'error', code: 'empty-source', message: 'motionCard.tsx 为空。' }] };
  }
  if (!/export\s+default\b/.test(source)) {
    issues.push({
      severity: 'error',
      code: 'missing-default-export',
      message: '缺少 export default 的组件导出。',
    });
  }
  if (UNFINISHED_RE.test(source)) {
    issues.push({
      severity: 'error',
      code: 'unfinished-source',
      message: '源码包含 TODO / 省略类占位内容，组件不完整。',
    });
  }

  if (options.requireSafeLayout) {
    if (!/<SafeLayout\b/.test(source) || !/<MotionSlot\b/.test(source)) {
      issues.push({
        severity: 'error',
        code: 'safe-layout-required',
        message: '自动模式必须使用 SafeLayout + MotionSlot 组织槽位，不能直接在 CardStage 中自由堆叠。',
      });
    }
    if (/position\s*:\s*['"]absolute['"]/.test(source)) {
      issues.push({
        severity: 'error',
        code: 'auto-absolute-layout',
        message: '自动模式禁止在卡片源码中使用 absolute 自由定位；请把语义内容放入 MotionSlot，并使用一个 motion-kit 主原语。',
      });
    }
    const mainPrimitives = [
      'StatHero', 'BarChart', 'TrendLine', 'CompareRow', 'ListBuild', 'ProcessFlow',
      'QuoteBlock', 'TimelineRail', 'MatrixQuadrant', 'FunnelStack', 'NetworkMap',
      'BeforeAfter', 'StackedComposition', 'RingCounter', 'HorizontalBars', 'RankList',
      'ChecklistPop', 'CauseChain', 'ConceptCard', 'CitationCard', 'KeyPointMarker',
      'MythFactSwap', 'ColumnChart', 'DonutChart', 'MetricPulse', 'ScaleImpact',
      'StatGrid', 'DataTable', 'SectionTitle',
    ];
    const primitiveCount = mainPrimitives.reduce(
      (count, name) => count + (source.match(new RegExp(`<${name}\\b`, 'g'))?.length ?? 0),
      0,
    );
    if (primitiveCount > 1) {
      issues.push({
        severity: 'error',
        code: 'too-many-main-primitives',
        message: `自动模式检测到 ${primitiveCount} 个主原语；每张卡只能保留 1 个主原语，标题用 Kicker 放入 header 槽位。`,
      });
    }
  }

  // 指示标注是"讲解者的手"，指多了等于没指：整卡最多 2 个，且必须包住真正的焦点。
  const annotateCount = source.match(/<Annotate\b/g)?.length ?? 0;
  if (annotateCount > 2) {
    issues.push({
      severity: 'error',
      code: 'too-many-annotations',
      message: `检测到 ${annotateCount} 个 Annotate 标注；整卡最多 2 个，只标真正的焦点，其余删掉。`,
    });
  }

  // 运镜必须与 SafeLayout 的 variant 同源，否则 target 槽位定位偏到别处。
  const stageLayout = source.match(/<CardStage[^>]*\blayout=["']([a-z-]+)["']/)?.[1];
  const safeVariant = source.match(/<SafeLayout[^>]*\bvariant=["']([a-z-]+)["']/)?.[1];
  if (stageLayout && safeVariant && stageLayout !== safeVariant) {
    issues.push({
      severity: 'error',
      code: 'camera-layout-mismatch',
      message: `CardStage layout="${stageLayout}" 与 SafeLayout variant="${safeVariant}" 不一致，运镜会推到错误位置。`,
    });
  }
  if (/\bshots=\{/.test(source) && !stageLayout) {
    issues.push({
      severity: 'warn',
      code: 'camera-missing-layout',
      message: '声明了 shots 但 CardStage 未给 layout，target 槽位将按 single-focus 定位。',
    });
  }
  const shotCount = source.match(/move\s*:\s*['"](?:push-in|pull-out|pan-left|pan-right|focus)['"]/g)?.length ?? 0;
  if (shotCount > 2) {
    issues.push({
      severity: 'error',
      code: 'too-many-camera-shots',
      message: `检测到 ${shotCount} 次运镜；整卡最多 2 次，多了会晕。`,
    });
  }

  for (const spec of collectImports(source)) {
    if (!ALLOWED_IMPORTS.has(spec)) {
      issues.push({
        severity: 'error',
        code: 'forbidden-import',
        message: `不允许引用模块 "${spec}"；只能引用 remotion / react / @lingji/motion-kit。`,
      });
    }
  }

  // kit 幻觉 API：named import 必须存在于 kit 导出清单，否则运行时 "xxx is not a function"。
  // 在编译前拦住并列出全部合法名，弱模型一次就能改对。
  const kitImport = source.match(/import\s*\{([^}]*)\}\s*from\s*['"]@lingji\/motion-kit['"]/);
  if (kitImport) {
    const kitNames = new Set<string>(MOTION_KIT_EXPORT_NAMES);
    const unknown = kitImport[1]
      .split(',')
      .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
      .filter((n) => n && !kitNames.has(n));
    if (unknown.length > 0) {
      issues.push({
        severity: 'error',
        code: 'unknown-kit-export',
        message: `@lingji/motion-kit 没有导出 [${unknown.join(', ')}]；可用导出仅限：${MOTION_KIT_EXPORT_NAMES.join(', ')}。`,
      });
    }
  }

  // CardStage prop 契约：样式只认 tokens。模型常幻觉 bg= / palette= 等独立 prop，
  // React 静默忽略后 normalizeMotionTokens(undefined) 回落深色默认调色板 → 整卡黑底，
  // 且冒烟渲染照常通过（黑卡也能渲染），必须在此拦截。
  for (const m of source.matchAll(/<CardStage\b/g)) {
    // 扫到标签真实结尾：忽略 {...} 表达式内部的 '>'（如箭头函数）。
    let brace = 0;
    let tag = '';
    for (let i = (m.index ?? 0) + m[0].length; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') brace += 1;
      else if (ch === '}') brace -= 1;
      else if (ch === '>' && brace === 0) break;
      tag += ch;
    }
    if (!/\btokens\s*=/.test(tag)) {
      issues.push({
        severity: 'error',
        code: 'cardstage-missing-tokens',
        message:
          'CardStage 只接受 tokens 一个样式 prop（bg / palette / ambient / camera 等独立 prop 会被忽略并回落深色默认底）；把调色与氛围合入 tokens：<CardStage tokens={{ palette: {...}, ambient: {...}, camera: {...} }}>。',
      });
      break; // 同病只报一次，避免多处 CardStage 刷屏
    }
  }

  for (const { re, code, label } of BANNED_PATTERNS) {
    if (re.test(source)) {
      issues.push({
        severity: 'error',
        code,
        message: `禁止使用 ${label}：动画必须是 useCurrentFrame() 的纯函数，逐帧确定可复现。`,
      });
    }
  }

  // interpolate 必须双侧 clamp：漏 extrapolateLeft 时揭示帧之前的左侧外推会随缓动
  // 多项式爆炸（负高度 / 巨值），漏 extrapolateRight 则揭示后继续漂移。逐调用平衡括号扫描。
  let interpolateIdx = 0;
  for (let pos = source.indexOf('interpolate('); pos >= 0; pos = source.indexOf('interpolate(', pos + 1)) {
    interpolateIdx += 1;
    let depth = 0;
    let end = -1;
    for (let i = pos + 'interpolate'.length; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const call = end > 0 ? source.slice(pos, end + 1) : source.slice(pos);
    // 颜色字符串进插值范围：remotion 的 interpolate 只支持数字，运行期直接抛
    // "Cannot interpolate #xxx"；颜色过渡必须用 interpolateColors。
    if (/\[\s*['"]#/.test(call)) {
      issues.push({
        severity: 'error',
        code: 'interpolate-color-range',
        message: `第 ${interpolateIdx} 个 interpolate 调用把颜色字符串放进了插值范围：interpolate 只支持数字，颜色过渡用 remotion 的 interpolateColors(frame, inputRange, ['#a','#b'])。`,
      });
    }
    // 展开（spread）预置 clamp 常量的写法（{...CLAMP}）无法静态确认，放行由冒烟渲染兜底。
    if (/\.\.\./.test(call)) continue;
    const hasLeft = call.includes('extrapolateLeft');
    const hasRight = call.includes('extrapolateRight');
    if (!hasLeft || !hasRight) {
      issues.push({
        severity: 'error',
        code: 'unclamped-interpolate',
        message: `第 ${interpolateIdx} 个 interpolate 调用缺 ${!hasLeft ? "extrapolateLeft: 'clamp'" : ''}${!hasLeft && !hasRight ? ' 与 ' : ''}${!hasRight ? "extrapolateRight: 'clamp'" : ''}：区间外的帧会外推出负值 / 巨值（配 Easing.back 等缓动会爆炸），必须双侧 clamp。`,
      });
    }
  }

  // 内容层循环风险：Math.sin(frame / T) 的 T < 60 属于高频振荡（装饰层低频缓动豁免 T ≥ 60）。
  for (const m of source.matchAll(/Math\.sin\s*\(\s*frame\s*\/\s*(\d+(?:\.\d+)?)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t) && t < 60) {
      issues.push({
        severity: 'error',
        code: 'high-frequency-loop',
        message: `Math.sin(frame / ${m[1]}) 周期过短（T < 60），内容会持续振荡；循环动效仅限装饰层且 T ≥ 60。`,
      });
    }
  }

  // cues 未使用：卡片拿到逐句节拍却完全没消费，动画必然与口播脱节。
  const strippedProps = source.replace(/function\s+\w*\s*\(\s*\{\s*[^}]*\}\s*\)/, '');
  const usesCues = /\bcues\b/.test(strippedProps);
  const usesBeats = /\buseBeats\s*\(/.test(source);
  const usesTimingPlan = /\buseTimingPlan\s*\(/.test(source);
  if (!usesCues && !usesBeats && !usesTimingPlan) {
    issues.push({
      severity: 'warn',
      code: 'cues-unused',
      message: '组件未使用 cues / useBeats / useTimingPlan，内容揭示无法跟随口播节拍。',
    });
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/** 把 lint 结果格式化为回喂雕刻的修复指令文本。 */
export function formatLintIssues(issues: MotionLintIssue[]): string {
  return issues
    .map((i, idx) => `${idx + 1}. [${i.severity}] (${i.code}) ${i.message}`)
    .join('\n');
}
