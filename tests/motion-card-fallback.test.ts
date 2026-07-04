import { describe, expect, it } from 'vitest';
import { buildFallbackCardTsx } from '../src/lib/motion-card-fallback';
import { lintMotionCardTsx } from '../src/lib/motion-card-lint';
import { validateMotionCardTsx } from '../electron/remotion/smoke-render';
import type { MotionStoryboard } from '../src/lib/motion-storyboard';

const TOKENS_JSON = JSON.stringify({
  palette: { bg: '#0E0E10', ink: '#ECE7DA', muted: '#8A8478', accent: '#0A84FF' },
  fonts: { display: 'Georgia, serif', body: 'sans-serif', mono: 'monospace' },
});

const SB: MotionStoryboard = {
  claim: '硕士报名人数远超博士',
  carrier: 'comparison',
  scene: '双栏对比',
  focus: { beat: 1, emphasis: 'countup-settle' },
  beats: [
    { cue: null, kind: 'build', adds: '标题「考研报名」', motion: '入场' },
    { cue: 1, kind: 'build', adds: '左栏数字「28,842人」、对应满长对比条', motion: '计数' },
    { cue: 2, kind: 'build', adds: '右栏数字对比条', motion: '生长' },
    { cue: 4, kind: 'build', adds: '底部结论：就业压力致拥挤', motion: '淡入' },
  ],
};

describe('buildFallbackCardTsx（分镜确定性兜底渲染）', () => {
  it('产出通过 lint 且可真实编译渲染的组件', async () => {
    const tsx = buildFallbackCardTsx(SB, TOKENS_JSON);
    expect(lintMotionCardTsx(tsx).ok).toBe(true);
    const result = await validateMotionCardTsx(tsx, { cues: [0, 96, 228, 354, 480], checkRenderedLayout: false });
    expect(result.render.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('焦点数字提取为 StatHero（千分位归一化），其余拍进 ListBuild 并锚到各自 beat', () => {
    const tsx = buildFallbackCardTsx(SB, TOKENS_JSON);
    expect(tsx).toContain('StatHero value={28842}');
    expect(tsx).toContain('unit="人"');
    expect(tsx).toContain('useBeats(cues, [null, 1, 2, 4])');
    expect(tsx).toContain('beats[3]');
    // 上屏文字已清洗（去引号装饰、取子句）且不含口播整句
    expect(tsx).not.toContain('「');
  });

  it('6 拍长文本分镜：hero + 列表限额后通过完整布局探针（含字幕安全区）', async () => {
    const long: MotionStoryboard = {
      claim: '欧洲高温下美的空调销量暴涨引发行业震动',
      carrier: 'comparison',
      scene: '对比',
      focus: { beat: 2, emphasis: 'slam' },
      beats: [
        { cue: null, kind: 'build', adds: '标题：欧洲空调市场' },
        { cue: 0, kind: 'build', adds: '欧洲高温 40 度持续两周，空调需求爆发式增长' },
        { cue: 1, kind: 'build', adds: '美的出货量 120万台，同比翻倍增长创新高' },
        { cue: 2, kind: 'accent', adds: '格力出口下滑' },
        { cue: 3, kind: 'build', adds: '中国品牌份额从12%涨到41%' },
        { cue: 4, kind: 'build', adds: '就业压力与渠道竞争白热化' },
      ],
    };
    const tsx = buildFallbackCardTsx(long, TOKENS_JSON);
    // 有 hero 时列表限 2 条（垂直预算），保证不溢入字幕安全区
    expect((tsx.match(/beats\[\d+\]/g) ?? []).length).toBeLessThanOrEqual(4);
    const result = await validateMotionCardTsx(tsx, { cues: [0, 96, 200, 300, 420], checkRenderedLayout: true });
    expect(result.render.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
  }, 120_000);

  it('无数字分镜退化为 Kicker + 列表，空 cues 仍可渲染', async () => {
    const noNumber: MotionStoryboard = {
      claim: '会造产品不等于会卖产品',
      carrier: 'concept',
      scene: '观点卡',
      beats: [
        { cue: null, kind: 'build', adds: '核心观点' },
        { cue: 1, kind: 'build', adds: '渠道能力决定出海上限' },
      ],
    };
    const tsx = buildFallbackCardTsx(noNumber, TOKENS_JSON);
    expect(tsx).not.toContain('<StatHero');
    expect(tsx).toContain('<ListBuild');
    const result = await validateMotionCardTsx(tsx, { cues: [], checkRenderedLayout: false });
    expect(result.render.ok).toBe(true);
  });
});
