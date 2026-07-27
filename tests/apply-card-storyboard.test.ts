import { describe, expect, it } from 'vitest';
import { applyStoryboardToCard, canRecompileFromStoryboard } from '../src/lib/apply-card-storyboard';
import type { MotionStoryboard } from '../src/lib/motion-storyboard';
import type { AICard } from '../src/types/ai';

const storyboard: MotionStoryboard = {
  claim: '核心论点',
  carrier: 'concept',
  scene: '居中概念卡',
  focus: { beat: 0, emphasis: 'brighten' },
  beats: [
    { cue: null, kind: 'build', adds: '概念入场' },
    { cue: 0, kind: 'accent', adds: '释义强调' },
  ],
  data: { term: '概念', definition: '一句释义' },
};

function makeCard(overrides: Partial<AICard> = {}): AICard {
  return {
    id: 'card-1',
    segmentId: 'seg-1',
    type: 'motion',
    title: '卡片',
    content: '',
    startMs: 0,
    endMs: 5_000,
    displayDurationMs: 5_000,
    displayMode: 'fullscreen',
    template: 'motion-default',
    enabled: true,
    style: { primaryColor: '#fff', backgroundColor: '#111', fontSize: 48 },
    renderMode: 'motion-card',
    ...overrides,
  };
}

describe('canRecompileFromStoryboard', () => {
  it('无动画产物或模板编译产物可重编译', () => {
    expect(canRecompileFromStoryboard(makeCard())).toBe(true);
    expect(
      canRecompileFromStoryboard(
        makeCard({
          motionCard: {
            tsx: 'export default function C(){return null}',
            compiledAt: 1,
            prompt: '',
            retryCount: 0,
            productionReport: { compiled: true } as never,
          },
        }),
      ),
    ).toBe(true);
  });

  it('精雕产物（无 compiled 标记）不可重编译', () => {
    expect(
      canRecompileFromStoryboard(
        makeCard({
          motionCard: {
            tsx: 'export default function C(){return null}',
            compiledAt: 1,
            prompt: '',
            retryCount: 0,
          },
        }),
      ),
    ).toBe(false);
  });
});

describe('applyStoryboardToCard', () => {
  it('模板卡：确定性重编译出新 TSX 并标记 compiled', () => {
    const result = applyStoryboardToCard(makeCard(), storyboard);
    expect(result.mode).toBe('recompiled');
    expect(result.updates.motionCard?.tsx).toContain('export default');
    expect(result.updates.motionCard?.storyboard).toEqual(storyboard);
    expect(result.updates.motionCard?.productionReport?.compiled).toBe(true);
    expect(result.updates.animationDirection).toContain('"carrier": "concept"');
  });

  it('精雕卡：只落盘分镜草案，不覆盖精修 TSX', () => {
    const sculptedTsx = 'export default function Sculpted(){return null}';
    const result = applyStoryboardToCard(
      makeCard({
        motionCard: { tsx: sculptedTsx, compiledAt: 1, prompt: '', retryCount: 0 },
      }),
      storyboard,
    );
    expect(result.mode).toBe('needs-sculpt');
    expect(result.updates.motionCard?.tsx).toBe(sculptedTsx);
    expect(result.updates.motionCard?.storyboard).toEqual(storyboard);
  });
});
