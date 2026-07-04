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
function cleanScreenText(text: string, maxLen = 16): string {
  const cleaned = (text ?? '')
    .replace(/[「」『』“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const clause = cleaned.split(/[、，,；;。]/)[0] || cleaned;
  const base = clause.length >= 4 ? clause : cleaned;
  return base.slice(0, maxLen);
}

/** 从一拍文本中提取首个可展示数字（≥2 位或带小数）与其后紧跟的中文单位。 */
function extractHeroNumber(text: string): { value: number; unit: string } | null {
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
 */
export function buildFallbackCardTsx(sb: MotionStoryboard, presetTokensJson: string): string {
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

  const heroLabel = heroBeatIdx >= 0
    ? cleanScreenText((beats[heroBeatIdx].adds ?? '').replace(/[\d,，.%]+/g, ''), 10)
    : '';

  // 其余拍进列表，与各自 beat 对齐。垂直预算（安全盒 ≈ H*0.72）：
  // 有 StatHero（≈0.42H）时最多 2 条；无 hero 时最多 3 条——确定性模板必须确定性放得下。
  const listEntries = beats
    .map((b, i) => ({ text: cleanScreenText(b.adds ?? ''), i }))
    .filter((e) => e.i !== 0 && e.i !== heroBeatIdx && e.text.length > 0)
    .slice(0, hero ? 2 : 3);

  const listBlock = listEntries.length > 0
    ? `        <ListBuild items={[${listEntries.map((e) => q(e.text)).join(', ')}]} beats={[${listEntries
        .map((e) => `beats[${e.i}]`)
        .join(', ')}]} />`
    : '';
  const heroBlock = hero
    ? `        <StatHero value={${(hero as { value: number }).value}} unit=${q((hero as { unit: string }).unit)} label=${q(heroLabel)} beat={beats[${heroBeatIdx}]} />`
    : '';

  return `import { CardStage, useBeats, Kicker, StatHero, ListBuild } from '@lingji/motion-kit';

const TOKENS = ${presetTokensJson};

export default function Card({ cues = [] }) {
  const beats = useBeats(cues, ${anchorsLiteral});
  return (
    <CardStage tokens={TOKENS}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 40, maxHeight: '100%' }}>
        <Kicker text=${q(cleanScreenText(sb.claim, 14))} beat={beats[0]} />
${[heroBlock, listBlock].filter(Boolean).join('\n')}
      </div>
    </CardStage>
  );
}
`;
}
