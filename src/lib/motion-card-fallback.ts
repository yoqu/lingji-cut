/**
 * motion-card-fallback —— 分镜的确定性兜底渲染（不经 LLM）。
 *
 * 分镜（storyboard）是机器校验过的结构化数据：cue 合法、数字忠于逐字稿。
 * 当雕刻师多轮修复 + 降级重写仍产不出合法组件时（弱模型常见），由本模块直接把
 * 分镜编译成一张纯 motion-kit 原语组合的简版卡——布局 / 安全区 / 节拍锚定由
 * kit 构造保证，永不越界、永可渲染，把"整段失败留空"兜成"保底出卡"。
 */
import type { MotionStoryboard, StoryboardBeat } from './motion-storyboard';

/** 清洗上屏文本：去引号装饰、取首个子句、截断到卡片友好长度。 */
export function cleanScreenText(text: string, maxLen = 16): string {
  const cleaned = (text ?? '')
    .replace(/[「」『』“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const clause = cleaned.split(/[、，,；;。]/)[0] || cleaned;
  const base = clause.length >= 4 ? clause : cleaned;
  return base.slice(0, maxLen);
}

/** 从一拍文本中提取首个可展示数字（≥2 位或带小数）与其后紧跟的中文单位。 */
export function extractHeroNumber(text: string): { value: number; unit: string } | null {
  const m = (text ?? '').replace(/[,，]/g, '').match(/(\d{2,}(?:\.\d+)?|\d\.\d+)\s*([一-龥%]{0,2})/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: m[2] ?? '' };
}

const q = (text: string): string => JSON.stringify(text);

/**
 * 把分镜编译为保底 TSX：Kicker（论点）+（可选）StatHero（焦点数字）+ ListBuild（其余拍要点），
 * 全部锚到各拍 cue。产物只 import @lingji/motion-kit，帧纯函数，天然通过 lint 与安全区校验。
 * opts.assetsResolved === false（素材物化失败）时 asset-aside / asset-led 同样退回载体默认布局，与满血编译一致。
 */
export function buildFallbackCardTsx(
  sb: MotionStoryboard,
  presetTokensJson: string,
  opts?: { assetsResolved?: boolean },
): string {
  const beats: StoryboardBeat[] = Array.isArray(sb.beats) && sb.beats.length > 0
    ? sb.beats
    : [{ cue: null, kind: 'build', adds: sb.claim }];

  const anchors = beats.map((b, i) => (i === 0 ? null : b.cue ?? null));
  const anchorsLiteral = `[${anchors.map((a) => (a == null ? 'null' : String(a))).join(', ')}]`;

  // 焦点数字：优先 focus 拍，其次任意拍。
  const focusIdx = sb.focus && Number.isInteger(sb.focus.beat) && sb.focus.beat >= 0 && sb.focus.beat < beats.length
    ? sb.focus.beat
    : -1;
  let heroBeatIdx = -1;
  let hero: { value: number; unit: string } | null = null;
  const tryHero = (idx: number) => {
    if (hero || idx < 0 || idx >= beats.length) return;
    const found = extractHeroNumber(beats[idx].adds ?? '');
    if (found) {
      hero = found;
      heroBeatIdx = idx;
    }
  };
  tryHero(focusIdx);
  beats.forEach((_, i) => tryHero(i));
  const resolvedHero = hero as { value: number; unit: string } | null;

  const heroLabel = heroBeatIdx >= 0
    ? cleanScreenText((beats[heroBeatIdx].adds ?? '').replace(/[\d,，.%]+/g, ''), 10)
    : '';

  // 其余拍只用于没有专用载体/焦点数字时的单一 ListBuild，绝不与第二个主原语叠加。
  const listEntries = beats
    .map((b, i) => ({ text: cleanScreenText(b.adds ?? ''), i }))
    .filter((e) => e.i !== 0 && e.i !== heroBeatIdx && e.text.length > 0)
    .slice(0, 3);

  const items = beats.map((b) => cleanScreenText(b.adds ?? '', 12)).filter(Boolean).slice(0, 4);
  const mainBlock = (() => {
    if (sb.carrier === 'data-hero' && resolvedHero) {
      return `          <StatHero value={${resolvedHero.value}} unit=${q(resolvedHero.unit)} label=${q(heroLabel)} beat={beats[${heroBeatIdx}]} />`;
    }
    if (sb.carrier === 'comparison' && items.length >= 2) {
      return `          <CompareRow left={{ label: ${q(items[0])}, value: ${q(items[0])} }} right={{ label: ${q(items[1])}, value: ${q(items[1])} }} beat={beats[1] ?? beats[0]} />`;
    }
    if (sb.carrier === 'process') {
      return `          <ProcessFlow steps={[${items.slice(0, 4).map(q).join(', ')}]} beat={beats[1] ?? beats[0]} />`;
    }
    if (sb.carrier === 'quote') {
      const quote = cleanScreenText(beats[focusIdx]?.adds ?? sb.claim, 22);
      return `          <QuoteBlock text=${q(quote)} beat={beats[${Math.max(0, focusIdx)}] ?? beats[0]} />`;
    }
    if (sb.carrier === 'timeline') {
      return `          <TimelineRail items={[${items.map(q).join(', ')}]} beat={beats[1] ?? beats[0]} />`;
    }
    if (sb.carrier === 'matrix') {
      return `          <MatrixQuadrant items={[${items.map((text, i) => `{ label: ${q(text)}, x: ${25 + (i % 3) * 25}, y: ${35 + (i % 2) * 32}, focus: ${i === Math.max(0, focusIdx)} }`).join(', ')}]} beat={beats[1] ?? beats[0]} />`;
    }
    if (sb.carrier === 'funnel') {
      return `          <FunnelStack steps={[${items.map((text, i) => `{ label: ${q(text)}, value: ${q(i === 0 && resolvedHero ? `${resolvedHero.value}${resolvedHero.unit}` : '')} }`).join(', ')}]} beat={beats[1] ?? beats[0]} />`;
    }
    if (sb.carrier === 'network') {
      return `          <NetworkMap nodes={[${items.map(q).join(', ')}]} links={[[0,1],[1,2],[0,3]]} beat={beats[1] ?? beats[0]} />`;
    }
    if (sb.carrier === 'before-after') {
      return `          <BeforeAfter before=${q(items[0] ?? '之前')} after=${q(items[1] ?? items[items.length - 1] ?? '之后')} beat={beats[1] ?? beats[0]} mode="wipe" />`;
    }
    if (sb.carrier === 'stacked-composition') {
      return `          <StackedComposition items={[${items.map((text, i) => `{ label: ${q(text)}, value: ${Math.max(10, 50 - i * 8)} }`).join(', ')}]} beat={beats[1] ?? beats[0]} />`;
    }
    const safeList = listEntries.length > 0
      ? listEntries
      : [{ text: cleanScreenText(beats[focusIdx]?.adds ?? sb.claim), i: Math.max(0, focusIdx) }];
    return `          <ListBuild items={[${safeList.map((entry) => q(entry.text)).join(', ')}]} beats={[${safeList.map((entry) => `beats[${entry.i}]`).join(', ')}]} />`;
  })();

  const layout = (sb.layout && !((sb.layout === 'asset-aside' || sb.layout === 'asset-led') && opts?.assetsResolved === false))
    ? sb.layout
    : (sb.carrier === 'comparison' || sb.carrier === 'before-after'
      ? 'split-compare'
      : sb.carrier === 'data-hero'
        ? 'title-hero'
        : sb.carrier === 'list-build' || sb.carrier === 'process'
          ? 'list-with-kicker'
          : 'chart-with-kicker');
  const headerSlot = layout === 'single-focus'
    ? ''
    : `        <MotionSlot name="header" role="support">
          <Kicker text=${q(cleanScreenText(sb.claim, 14))} beat={beats[0]} />
        </MotionSlot>\n`;

  return `import { CardStage, SafeLayout, MotionSlot, useBeats, Kicker, StatHero, CompareRow, ListBuild, ProcessFlow, QuoteBlock, TimelineRail, MatrixQuadrant, FunnelStack, NetworkMap, BeforeAfter, StackedComposition } from '@lingji/motion-kit';

const TOKENS = ${presetTokensJson};

export default function Card({ cues = [] }) {
  const beats = useBeats(cues, ${anchorsLiteral});
  return (
    <CardStage tokens={TOKENS}>
      <SafeLayout variant=${q(layout)}>
${headerSlot}        <MotionSlot name="main" role="focus">
${mainBlock}
        </MotionSlot>
      </SafeLayout>
    </CardStage>
  );
}
`;
}
