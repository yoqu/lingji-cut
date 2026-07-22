import { describe, expect, it } from 'vitest';
import { validateStoryboard, type MotionStoryboard } from '../src/lib/motion-storyboard';

const BEATS: MotionStoryboard['beats'] = [
  { cue: null, kind: 'build', adds: '标题入场' },
  { cue: 1, kind: 'accent', adds: '核心内容落地' },
];

const CTX = { cueCount: 4, transcript: '新易盛环比增长43%，天孚通信增长40%，中际旭创增长38%。' };

function sb(partial: Partial<MotionStoryboard>): MotionStoryboard {
  return {
    claim: '新易盛中报预增',
    carrier: 'list-build',
    scene: '终态',
    focus: { beat: 1, emphasis: 'slam' },
    beats: BEATS,
    ...partial,
  };
}

function errorsOf(storyboard: MotionStoryboard, transcript = CTX.transcript): string[] {
  return validateStoryboard(storyboard, { cueCount: CTX.cueCount, transcript }).errors;
}

describe('validateStoryboardData（per-carrier data 机器校验）', () => {
  it('合法 data 通过：data-hero / table / list-build', () => {
    expect(errorsOf(sb({ carrier: 'data-hero', data: { value: 43, unit: '%', label: '环比增速' } }))).toEqual([]);
    expect(
      errorsOf(sb({ carrier: 'table', data: { columns: ['公司', '增速'], rows: [['新易盛', '43%'], ['天孚通信', '40%']] } })),
    ).toEqual([]);
    expect(errorsOf(sb({ carrier: 'list-build', data: { items: ['需求爆发', '订单饱满'] } }))).toEqual([]);
  });

  it('无 data 时照常通过（回落提取，兼容旧模板）', () => {
    expect(errorsOf(sb({ carrier: 'data-hero' }))).toEqual([]);
  });

  it('非法 variant 报错', () => {
    const errors = errorsOf(sb({ carrier: 'list-build', data: { items: ['a'], variant: 'grid' as never } }));
    expect(errors.some((e) => e.includes('variant'))).toBe(true);
  });

  it('条数上限：list-build 普通 4 条、变体 5 条、table 5 行', () => {
    expect(
      errorsOf(sb({ carrier: 'list-build', data: { items: ['a', 'b', 'c', 'd', 'e'] } })).some((e) => e.includes('1~4')),
    ).toBe(true);
    expect(
      errorsOf(sb({ carrier: 'list-build', data: { items: ['a', 'b', 'c', 'd', 'e'], variant: 'rank' } })),
    ).toEqual([]);
    expect(
      errorsOf(
        sb({
          carrier: 'table',
          data: { columns: ['公司'], rows: [['a'], ['b'], ['c'], ['d'], ['e'], ['f']] },
        }),
      ).some((e) => e.includes('1~5 行')),
    ).toBe(true);
  });

  it('上屏文本长度：条目 >14 字、标题 >10 字被打回', () => {
    const errors = errorsOf(
      sb({ carrier: 'list-build', data: { items: ['这是一条远远超过十四字上限的上屏文案内容'] } }),
    );
    expect(errors.some((e) => e.includes('超过上限 14'))).toBe(true);
    const titleErrors = errorsOf(
      sb({ carrier: 'concept', data: { variant: 'section', title: '这个章节标题实在太长了' } }),
    );
    expect(titleErrors.some((e) => e.includes('超过上限 10'))).toBe(true);
  });

  it('data 数字防编造：value / points 必须在逐字稿中', () => {
    const heroErrors = errorsOf(sb({ carrier: 'data-hero', data: { value: 99, unit: '%', label: '环比增速' } }));
    expect(heroErrors.some((e) => e.includes('99') && e.includes('逐字稿'))).toBe(true);

    const trendErrors = errorsOf(sb({ carrier: 'trend', data: { points: [43, 40, 77] } }));
    expect(trendErrors.some((e) => e.includes('77'))).toBe(true);
    expect(errorsOf(sb({ carrier: 'trend', data: { points: [43, 40, 38] } }))).toEqual([]);
  });

  it('matrix 的 x/y 是布局坐标，不参与数字防编造', () => {
    const errors = errorsOf(
      sb({
        carrier: 'matrix',
        data: { items: [{ label: '优先做', x: 78, y: 72 }, { label: '暂缓', x: 28, y: 36 }] },
      }),
    );
    expect(errors).toEqual([]);
  });

  it('scale-impact 缺 max 报错；stat-grid 条数校验', () => {
    expect(
      errorsOf(sb({ carrier: 'data-hero', data: { value: 43, variant: 'scale-impact' } })).some((e) => e.includes('max')),
    ).toBe(true);
    expect(
      errorsOf(sb({ carrier: 'data-hero', data: { variant: 'stat-grid', items: [{ value: '43%', label: '增速' }] } })).some(
        (e) => e.includes('2~4'),
      ),
    ).toBe(true);
  });

  it('network links 引用越界报错', () => {
    const errors = errorsOf(sb({ carrier: 'network', data: { nodes: ['平台', '创作者'], links: [[0, 5]] } }));
    expect(errors.some((e) => e.includes('links[0]'))).toBe(true);
  });
});
