import { describe, expect, it } from 'vitest';
import type { AICard, AISegment, AISegmentAnalysis, AISegmentSemanticType } from '../src/types/ai';
import type { MotionSegmentDirective } from '../src/types/motion';
import {
  buildDeterministicMotionBible,
  buildMotionBibleDirectiveBlock,
  checkMotionBibleConsistency,
  downgradeWeakCarrierPlan,
  parseMotionBible,
  rebalanceCarrierPlan,
  validateMotionBible,
} from '../src/lib/motion-bible';

const segments: AISegmentAnalysis[] = [
  {
    id: 'seg-1',
    title: '增长数字',
    summary: '用户增长到 28842 人',
    startMs: 0,
    endMs: 30_000,
    semanticType: 'data',
    complexityLevel: 'medium',
    visualizationScore: 80,
    pacingNeed: 'accent',
    keywords: ['增长'],
    entities: [],
    visualType: 'motion',
  },
  {
    id: 'seg-2',
    title: '原因解释',
    summary: '解释增长原因',
    startMs: 30_000,
    endMs: 70_000,
    semanticType: 'explanation',
    complexityLevel: 'high',
    visualizationScore: 70,
    pacingNeed: 'steady',
    keywords: ['原因'],
    entities: [],
    visualType: 'motion',
  },
];

describe('motion bible', () => {
  it('builds a deterministic fallback bible for every segment', () => {
    const bible = buildDeterministicMotionBible({
      summary: '节目总结',
      keywords: ['AI'],
      segments,
      warning: '模型失败',
    });
    expect(bible.fallbackUsed).toBe(true);
    expect(bible.carrierPlan.map((item) => item.segmentId)).toEqual(['seg-1', 'seg-2']);
    expect(bible.warnings?.[0]?.code).toBe('motion-bible-fallback');
  });

  it('normalizes valid model output and removes invalid segment ids', () => {
    const bible = parseMotionBible(
      {
        visualThesis: '统一证据链',
        rhythm: {
          density: 'dense',
          heavySegments: ['seg-2', 'ghost'],
          quietSegments: ['seg-1', 'ghost'],
        },
        carrierPlan: [
          { segmentId: 'seg-1', preferredCarrier: 'data-hero', intensity: 3, reason: '核心数字' },
          { segmentId: 'ghost', preferredCarrier: 'quote', intensity: 2, reason: 'invalid' },
        ],
        styleRules: { paletteUse: '少量蓝色强调', typographyUse: '数字重' },
        transitionRules: { default: 'push', matchCutCandidates: [] },
      },
      segments,
    );
    expect(bible?.rhythm.heavySegments).toEqual(['seg-2']);
    expect(bible?.rhythm.quietSegments).toEqual(['seg-1']);
    expect(bible?.carrierPlan).toHaveLength(2);
    expect(validateMotionBible(bible!, segments)).toEqual([]);
  });

  it('accepts match-cut as a transition default', () => {
    const bible = parseMotionBible(
      {
        transitionRules: {
          default: 'match-cut',
          matchCutCandidates: [{ fromSegmentId: 'seg-1', toSegmentId: 'seg-2', motif: '同一数字轴' }],
        },
      },
      segments,
    );
    expect(bible?.transitionRules.default).toBe('match-cut');
    expect(bible?.transitionRules.matchCutCandidates[0]?.motif).toBe('同一数字轴');
  });

  it('renders a compact directive block for prompts', () => {
    const bible = buildDeterministicMotionBible({ segments });
    const block = buildMotionBibleDirectiveBlock(bible, 'seg-1');
    expect(block).toContain('Motion Bible');
    expect(block).toContain('本段 directive');
    expect(block).toContain('seg-1');
  });

  it('reports carrier and intensity fatigue as warnings', () => {
    const bible = buildDeterministicMotionBible({ segments });
    const cards = ['a', 'b', 'c'].map((id, index) => ({
      id,
      segmentId: index === 0 ? 'seg-1' : 'seg-2',
      animationDirection: '{"carrier":"data-hero","beats":[{"cue":null,"kind":"build","adds":"x"}]}',
    })) as AICard[];
    const warnings = checkMotionBibleConsistency(cards, {
      ...bible,
      carrierPlan: [
        { segmentId: 'seg-1', preferredCarrier: 'data-hero', intensity: 3, reason: '重点' },
        { segmentId: 'seg-2', preferredCarrier: 'data-hero', intensity: 3, reason: '重点' },
      ],
    });
    expect(warnings.some((issue) => issue.code === 'carrier-fatigue')).toBe(true);
    expect(warnings.some((issue) => issue.code === 'intensity-fatigue')).toBe(true);
  });
});


const rebalanceSeg = (
  id: string,
  semanticType: AISegmentSemanticType,
  visualType: 'motion' | 'image' = 'motion',
): AISegment & { visualType: 'motion' | 'image' } => ({
  id,
  title: id,
  summary: id,
  startMs: 0,
  endMs: 5_000,
  semanticType,
  visualType,
});

const allConceptPlan = (ids: string[]): MotionSegmentDirective[] =>
  ids.map((id) => ({ segmentId: id, preferredCarrier: 'concept', intensity: 2, reason: '测试' }));

describe('rebalanceCarrierPlan', () => {
  // 10 段全 concept：4 data + 2 chapter-transition + 4 explanation（seg-6 在 seg-7 前）
  const fixtureIds = ['seg-1', 'seg-2', 'seg-3', 'seg-4', 'seg-5', 'seg-6', 'seg-7', 'seg-8', 'seg-9', 'seg-10'];
  const fixtureSegments = [
    rebalanceSeg('seg-1', 'data'),
    rebalanceSeg('seg-2', 'data'),
    rebalanceSeg('seg-3', 'data'),
    rebalanceSeg('seg-4', 'data'),
    rebalanceSeg('seg-5', 'chapter-transition'),
    rebalanceSeg('seg-6', 'explanation'),
    rebalanceSeg('seg-7', 'chapter-transition'),
    rebalanceSeg('seg-8', 'explanation'),
    rebalanceSeg('seg-9', 'explanation'),
    rebalanceSeg('seg-10', 'explanation'),
  ];

  it('concept 超占比时触发，把超出部分压回上限（floor(10*0.35)=3）', () => {
    const { carrierPlan, rebalanced } = rebalanceCarrierPlan(allConceptPlan(fixtureIds), fixtureSegments);
    expect(rebalanced).toBe(7);
    expect(carrierPlan.filter((item) => item.preferredCarrier === 'concept')).toHaveLength(3);
  });

  it('适配度最低的段优先改派：data（清单无 concept）先于 explanation（concept 为首选）', () => {
    const { carrierPlan } = rebalanceCarrierPlan(allConceptPlan(fixtureIds), fixtureSegments);
    const byId = new Map(carrierPlan.map((item) => [item.segmentId, item]));
    // data 段全部改派到 data 推荐清单载体
    expect(byId.get('seg-1')?.preferredCarrier).toBe('data-hero');
    expect(byId.get('seg-2')?.preferredCarrier).toBe('table');
    expect(byId.get('seg-3')?.preferredCarrier).toBe('comparison');
    expect(byId.get('seg-4')?.preferredCarrier).toBe('data-hero');
    // chapter-transition 改派到 quote，时间线靠前的 explanation seg-6 也被改派
    expect(byId.get('seg-5')?.preferredCarrier).toBe('quote');
    expect(byId.get('seg-6')?.preferredCarrier).toBe('process');
    expect(byId.get('seg-7')?.preferredCarrier).toBe('quote');
    // 剩余的 explanation 段保留 concept（concept 是其首选载体，适配度最高）
    expect(byId.get('seg-8')?.preferredCarrier).toBe('concept');
    expect(byId.get('seg-9')?.preferredCarrier).toBe('concept');
    expect(byId.get('seg-10')?.preferredCarrier).toBe('concept');
    // 改派痕迹写进 reason
    expect(byId.get('seg-1')?.reason).toContain('系统再平衡：concept→data-hero');
  });

  it('改派目标避开近邻已用载体，不制造同类连续 2 次', () => {
    const { carrierPlan } = rebalanceCarrierPlan(allConceptPlan(fixtureIds), fixtureSegments);
    const byId = new Map(carrierPlan.map((item) => [item.segmentId, item.preferredCarrier]));
    const ordered = fixtureIds.map((id) => byId.get(id));
    fixtureIds.forEach((_, index) => {
      if (ordered[index] === 'concept') return; // 只校验被改派的段
      if (index > 0) expect(ordered[index]).not.toBe(ordered[index - 1]);
      if (index < fixtureIds.length - 1) expect(ordered[index]).not.toBe(ordered[index + 1]);
    });
  });

  it('image 段不参与：不计入占比、不被改派', () => {
    const ids = ['m-1', 'i-1', 'm-2', 'i-2', 'm-3', 'm-4'];
    const segs = [
      rebalanceSeg('m-1', 'data'),
      rebalanceSeg('i-1', 'explanation', 'image'),
      rebalanceSeg('m-2', 'data'),
      rebalanceSeg('i-2', 'explanation', 'image'),
      rebalanceSeg('m-3', 'data'),
      rebalanceSeg('m-4', 'data'),
    ];
    const { carrierPlan, rebalanced } = rebalanceCarrierPlan(allConceptPlan(ids), segs);
    // 只计 4 个 motion 段：上限 floor(4*0.35)=1，超出 3 段被改派
    expect(rebalanced).toBe(3);
    const byId = new Map(carrierPlan.map((item) => [item.segmentId, item.preferredCarrier]));
    expect(byId.get('i-1')).toBe('concept');
    expect(byId.get('i-2')).toBe('concept');
    expect(byId.get('m-1')).toBe('data-hero');
    expect(byId.get('m-2')).toBe('table');
    expect(byId.get('m-3')).toBe('comparison');
    expect(byId.get('m-4')).toBe('concept');
  });

  it('concept 未超占比时恒等（返回原数组引用，rebalanced=0）', () => {
    const ids = ['seg-1', 'seg-2', 'seg-3', 'seg-4', 'seg-5', 'seg-6'];
    const segs = ids.map((id) => rebalanceSeg(id, 'explanation'));
    const plan: MotionSegmentDirective[] = ids.map((id, index) => ({
      segmentId: id,
      preferredCarrier: index < 2 ? 'concept' : 'process',
      intensity: 2,
      reason: '测试',
    }));
    const { carrierPlan, rebalanced } = rebalanceCarrierPlan(plan, segs);
    expect(rebalanced).toBe(0);
    expect(carrierPlan).toBe(plan);
  });

  it('parseMotionBible 归一化时自动再平衡并记录计数', () => {
    const bible = parseMotionBible(
      { carrierPlan: allConceptPlan(fixtureIds) },
      fixtureSegments,
    );
    expect(bible?.carrierRebalanceCount).toBe(7);
    // rebalance 压回 3 个 full concept 后，弱卡降级把 2 个 chapter-transition 翻为 concept+anchor
    expect(bible?.carrierPlan.filter((item) => item.preferredCarrier === 'concept')).toHaveLength(5);
    expect(bible?.carrierDowngradeCount).toBe(2);
    const anchorIds = bible?.carrierPlan.filter((item) => item.preferredVariant === 'anchor').map((item) => item.segmentId);
    expect(anchorIds).toEqual(['seg-5', 'seg-7']);
  });
});

describe('pickCarrier 回退收紧', () => {
  it('零散数字（年份）不再误判 data-hero；数据语义或 data 类型仍判 data-hero', () => {
    const bible = buildDeterministicMotionBible({
      segments: [
        { id: 'seg-a', title: '增长数字', summary: '用户增长到 28842 人', startMs: 0, endMs: 5_000, semanticType: 'narration' },
        { id: 'seg-b', title: '创业故事', summary: '2024 年，他辞掉工作开始创业', startMs: 5_000, endMs: 10_000, semanticType: 'narration' },
        { id: 'seg-c', title: '关键年份', summary: '公司成立于 2024 年', startMs: 10_000, endMs: 15_000, semanticType: 'data' },
      ],
    });
    const byId = new Map(bible.carrierPlan.map((item) => [item.segmentId, item.preferredCarrier]));
    expect(byId.get('seg-a')).toBe('data-hero'); // 数字 + 增长语义
    expect(byId.get('seg-b')).not.toBe('data-hero'); // 只有年份，无数据语义
    expect(byId.get('seg-c')).toBe('data-hero'); // semanticType=data + 数字
  });
});

describe('downgradeWeakCarrierPlan（弱卡降级：卡密度节奏）', () => {
  const weakSeg = (
    id: string,
    semanticType: AISegmentSemanticType,
    opts: { score?: number; visualType?: 'motion' | 'image' } = {},
  ): AISegment & { visualType?: 'motion' | 'image'; visualizationScore?: number } => ({
    id,
    title: id,
    summary: id,
    startMs: 0,
    endMs: 5_000,
    semanticType,
    ...(opts.score != null ? { visualizationScore: opts.score } : {}),
    ...(opts.visualType ? { visualType: opts.visualType } : {}),
  });
  const planOf = (entries: Array<[string, string]>): MotionSegmentDirective[] =>
    entries.map(([segmentId, preferredCarrier]) => ({ segmentId, preferredCarrier, intensity: 2, reason: '测试' }));

  it('chapter-transition 段改派 concept+anchor（当前是纯文字载体即可，含 quote）', () => {
    const segments = [weakSeg('seg-a', 'chapter-transition'), weakSeg('seg-b', 'chapter-transition')];
    const { carrierPlan, downgraded } = downgradeWeakCarrierPlan(
      planOf([['seg-a', 'process'], ['seg-b', 'quote']]),
      segments,
    );
    expect(downgraded).toBe(2);
    for (const item of carrierPlan) {
      expect(item.preferredCarrier).toBe('concept');
      expect(item.preferredVariant).toBe('anchor');
      expect(item.reason).toContain('弱卡降级');
    }
  });

  it('visualizationScore<40 的 narration / explanation 段降级；=40 与高分不动', () => {
    const segments = [
      weakSeg('n-low', 'narration', { score: 30 }),
      weakSeg('n-edge', 'narration', { score: 40 }),
      weakSeg('e-low', 'explanation', { score: 39 }),
      weakSeg('e-high', 'explanation', { score: 75 }),
    ];
    const { carrierPlan, downgraded } = downgradeWeakCarrierPlan(
      planOf([['n-low', 'list-build'], ['n-edge', 'list-build'], ['e-low', 'concept'], ['e-high', 'process']]),
      segments,
    );
    expect(downgraded).toBe(2);
    const byId = new Map(carrierPlan.map((item) => [item.segmentId, item]));
    expect(byId.get('n-low')?.preferredVariant).toBe('anchor');
    expect(byId.get('e-low')?.preferredVariant).toBe('anchor');
    expect(byId.get('n-edge')?.preferredVariant).toBeUndefined();
    expect(byId.get('n-edge')?.preferredCarrier).toBe('list-build');
    expect(byId.get('e-high')?.preferredCarrier).toBe('process');
  });

  it('图形/数据载体不动（提供增量信息）；image 段不动；data / quote 语义不按分数降级', () => {
    const segments = [
      weakSeg('g-1', 'narration', { score: 10 }),
      weakSeg('g-2', 'chapter-transition'),
      weakSeg('img', 'chapter-transition', { visualType: 'image' }),
      weakSeg('q', 'quote', { score: 5 }),
      weakSeg('d', 'data', { score: 5 }),
    ];
    const { carrierPlan, downgraded } = downgradeWeakCarrierPlan(
      planOf([['g-1', 'data-hero'], ['g-2', 'table'], ['img', 'concept'], ['q', 'concept'], ['d', 'concept']]),
      segments,
    );
    expect(downgraded).toBe(0);
    expect(carrierPlan.every((item) => item.preferredVariant === undefined)).toBe(true);
  });

  it('缺 visualizationScore 的段不按分数降级（只认 chapter-transition）', () => {
    const segments = [weakSeg('n-1', 'narration'), weakSeg('e-1', 'explanation')];
    const { downgraded } = downgradeWeakCarrierPlan(planOf([['n-1', 'list-build'], ['e-1', 'concept']]), segments);
    expect(downgraded).toBe(0);
  });

  it('已是 concept+anchor 的段不重复降级；恒等路径返回原数组引用', () => {
    const anchored: MotionSegmentDirective[] = [
      { segmentId: 'seg-a', preferredCarrier: 'concept', preferredVariant: 'anchor', intensity: 2, reason: '已降级' },
    ];
    const segments = [weakSeg('seg-a', 'chapter-transition')];
    const again = downgradeWeakCarrierPlan(anchored, segments);
    expect(again.downgraded).toBe(0);
    expect(again.carrierPlan).toBe(anchored);

    const graphic = planOf([['seg-b', 'trend']]);
    const identity = downgradeWeakCarrierPlan(graphic, [weakSeg('seg-b', 'data', { score: 90 })]);
    expect(identity.downgraded).toBe(0);
    expect(identity.carrierPlan).toBe(graphic);
  });

  it('与 rebalance 的叠加顺序：normalizeMotionBible 内 rebalance 先跑，chapter-transition 最终落到 anchor', () => {
    const bible = parseMotionBible(
      { carrierPlan: allConceptPlan(['seg-5', 'seg-6', 'seg-7']) },
      [rebalanceSeg('seg-5', 'chapter-transition'), rebalanceSeg('seg-6', 'explanation'), rebalanceSeg('seg-7', 'chapter-transition')],
    );
    const byId = new Map(bible!.carrierPlan.map((item) => [item.segmentId, item]));
    // 3 段全 concept 未超占比（floor(3*0.35)=1，超 2 段被 rebalance 改派）——
    // 但无论 rebalance 把它们派去哪，chapter-transition 最终都被降级 pass 翻为 anchor。
    expect(byId.get('seg-5')?.preferredVariant).toBe('anchor');
    expect(byId.get('seg-7')?.preferredVariant).toBe('anchor');
    expect(byId.get('seg-6')?.preferredVariant).toBeUndefined();
    expect(bible?.carrierDowngradeCount).toBe(2);
    // directive block 向导演 LLM 透出 anchor 变体（carrier=concept(anchor)）
    expect(buildMotionBibleDirectiveBlock(bible!, 'seg-5')).toContain('carrier=concept(anchor)');
    expect(buildMotionBibleDirectiveBlock(bible!, 'seg-6')).not.toContain('(anchor)');
  });
});
