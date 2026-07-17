import { describe, expect, it } from 'vitest';
import { buildMotionProductionPlan } from '../src/lib/production-plan';
import { rebalanceProductionSoundPlan } from '../src/lib/production-audio-plan';

describe('buildMotionProductionPlan', () => {
  it('一张 AICard 对应一个 VisualShot 并建立可执行的声音与运动计划', () => {
    const plan = buildMotionProductionPlan({
      segments: [
        { id: 'topic-part-1', title: '主题 1', summary: '第一镜', startMs: 0, endMs: 6_000 },
        { id: 'topic-part-2', title: '主题 2', summary: '第二镜', startMs: 6_000, endMs: 12_000 },
      ],
      cards: [
        {
          id: 'card-1', segmentId: 'topic-part-1', type: 'quote', title: '第一镜', content: '',
          startMs: 0, endMs: 6_000, displayDurationMs: 6_000, displayMode: 'fullscreen',
          template: 'default', enabled: true, style: { primaryColor: '#fff', backgroundColor: '#111', fontSize: 42 },
        },
        {
          id: 'card-2', segmentId: 'topic-part-2', type: 'motion', title: '第二镜', content: '',
          startMs: 6_000, endMs: 12_000, displayDurationMs: 6_000, displayMode: 'fullscreen',
          template: 'default', enabled: true, style: { primaryColor: '#fff', backgroundColor: '#111', fontSize: 42 },
        },
      ],
      coverPrompts: [],
      summary: '专业知识播客',
      keywords: ['知识', '播客'],
    }, 12_000);

    expect(plan.version).toBe(2);
    expect(plan.shots.map((shot) => shot.id)).toEqual(['card-1', 'card-2']);
    expect(plan.sequences).toHaveLength(1);
    expect(plan.audioPlan.bgm[0]).toMatchObject({ role: 'bgm', required: true, startMs: 0 });
    expect(plan.audioPlan.bgm[0].query).toContain('leave the 1-4 kHz speech range clear');
    expect(plan.audioPlan.bgm[0].query).toContain('energy curve');
    expect(plan.audioPlan.bgm[0].reuseKey).toMatch(/^audio:bgm:/u);
    expect(plan.audioPlan.sfx).toHaveLength(1);
    expect(plan.audioPlan.sfx[0].query).toContain('no voice');
    expect(plan.shots[0].audioCueIds).toEqual([plan.audioPlan.sfx[0].id]);
    expect(plan.shots[0].beats.map((beat) => beat.role)).toEqual([
      'anticipation', 'reveal', 'emphasis', 'hold', 'resolve',
    ]);
    expect(plan.shots[0].transitionOut).toMatchObject({ durationMs: 300 });
    expect(plan.shots[1].transitionIn).toMatchObject({ durationMs: 300 });
  });

  it('长播客只为真实章节和稀疏重点分配声音预算', () => {
    const durationMs = 346_104;
    const chapterIndexes = new Set([4, 5, 13, 19, 24, 30]);
    const segments = Array.from({ length: 42 }, (_, index) => ({
      id: `seg-${index + 1}`,
      title: `语义段落 ${index + 1}`,
      summary: `内容 ${index + 1}`,
      startMs: index * 8_200,
      endMs: Math.min(durationMs, (index + 1) * 8_200),
      ...(chapterIndexes.has(index) ? { pacingNeed: 'transition' as const } : {}),
    }));
    const cards = segments.map((segment, index) => ({
      id: `card-${index + 1}`,
      segmentId: segment.id,
      type: index % 2 === 0 ? 'data' as const : 'motion' as const,
      title: segment.title,
      content: '',
      startMs: segment.startMs,
      endMs: segment.endMs,
      displayDurationMs: segment.endMs - segment.startMs,
      displayMode: 'fullscreen' as const,
      template: 'default',
      enabled: true,
      style: { primaryColor: '#fff', backgroundColor: '#111', fontSize: 42 },
    }));

    const plan = buildMotionProductionPlan({
      segments, cards, coverPrompts: [], summary: '长播客', keywords: ['测试'],
    }, durationMs);

    const accentCues = [...plan.audioPlan.stingers, ...plan.audioPlan.sfx];
    expect(plan.sequences).toHaveLength(42);
    expect(plan.audioPlan.stingers).toHaveLength(5);
    expect(accentCues.length).toBeLessThanOrEqual(17);
    expect(plan.audioPlan.stingers.every((cue) => cue.durationMs === 3_000 && cue.volumeDb === -14)).toBe(true);
    expect(plan.audioPlan.sfx.every((cue) => cue.durationMs === 1_200 && cue.volumeDb === -12)).toBe(true);
    for (let index = 1; index < plan.audioPlan.stingers.length; index += 1) {
      expect(plan.audioPlan.stingers[index].startMs - plan.audioPlan.stingers[index - 1].startMs).toBeGreaterThanOrEqual(30_000);
    }
    for (let index = 1; index < plan.audioPlan.sfx.length; index += 1) {
      expect(plan.audioPlan.sfx[index].startMs - plan.audioPlan.sfx[index - 1].startMs).toBeGreaterThanOrEqual(15_000);
    }
    for (const sfx of plan.audioPlan.sfx) {
      expect(plan.audioPlan.stingers.every((cue) => Math.abs(cue.startMs - sfx.startMs) >= 6_000)).toBe(true);
    }

    const densePlan = {
      ...plan,
      audioPlan: {
        ...plan.audioPlan,
        stingers: plan.sequences.slice(1).map((sequence, index) => ({
          id: `legacy-stinger-${index + 1}`,
          role: 'stinger' as const,
          query: sequence.title,
          startMs: sequence.startMs,
          durationMs: 4_000,
          required: false,
          reuseKey: `legacy:${index}`,
        })),
      },
    };
    const rebalanced = rebalanceProductionSoundPlan(densePlan);
    expect(rebalanced.audioPlan.stingers).toHaveLength(5);
    expect(rebalanced.audioPlan.stingers.length + rebalanced.audioPlan.sfx.length).toBeLessThanOrEqual(17);
    const materialized = {
      ...densePlan,
      audioPlan: {
        ...densePlan.audioPlan,
        stingers: densePlan.audioPlan.stingers.map((cue, index) => (
          index === 0 ? { ...cue, assetId: 'existing-asset' } : cue
        )),
      },
    };
    expect(rebalanceProductionSoundPlan(materialized)).toBe(materialized);
  });
});
