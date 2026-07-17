import { describe, expect, it } from 'vitest';
import type { AICard, AISegmentAnalysis } from '../src/types/ai';
import {
  buildDeterministicMotionBible,
  buildMotionBibleDirectiveBlock,
  checkMotionBibleConsistency,
  parseMotionBible,
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
