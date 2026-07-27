import { describe, expect, it } from 'vitest';
import {
  HYBRID_AGENT_MAX_PER_RUN,
  HYBRID_AGENT_SCORE_THRESHOLD,
  buildHybridSelectionFromPlan,
  evaluateHybridSegment,
  resolveMotionCardPath,
  selectHybridAgentSegments,
  type HybridSegmentSignals,
} from '../electron/pipeline/motion-hybrid';

const seg = (id: string, signals: Partial<HybridSegmentSignals> = {}): HybridSegmentSignals => ({
  id,
  ...signals,
});

describe('evaluateHybridSegment：单段规则（无上限概念）', () => {
  it('visualizationScore 达到阈值即判 agent', () => {
    const hit = evaluateHybridSegment({ visualizationScore: HYBRID_AGENT_SCORE_THRESHOLD });
    expect(hit.agent).toBe(true);
    expect(hit.reasons.join()).toContain('visualizationScore');
    const miss = evaluateHybridSegment({ visualizationScore: HYBRID_AGENT_SCORE_THRESHOLD - 1 });
    expect(miss.agent).toBe(false);
  });

  it('semanticType 为 data / quote 判 agent，其余类型不命中', () => {
    expect(evaluateHybridSegment({ semanticType: 'data' }).agent).toBe(true);
    expect(evaluateHybridSegment({ semanticType: 'quote' }).agent).toBe(true);
    expect(evaluateHybridSegment({ semanticType: 'narration' }).agent).toBe(false);
    expect(evaluateHybridSegment({ semanticType: 'explanation' }).agent).toBe(false);
    expect(evaluateHybridSegment({ semanticType: 'chapter-transition' }).agent).toBe(false);
  });

  it('bible intensity=3 判 agent，1/2 不命中', () => {
    expect(evaluateHybridSegment({ motionBibleIntensity: 3 }).agent).toBe(true);
    expect(evaluateHybridSegment({ motionBibleIntensity: 2 }).agent).toBe(false);
    expect(evaluateHybridSegment({ motionBibleIntensity: 1 }).agent).toBe(false);
  });

  it('多条规则同时命中时原因全部记录', () => {
    const hit = evaluateHybridSegment({
      visualizationScore: 90,
      semanticType: 'data',
      motionBibleIntensity: 3,
    });
    expect(hit.agent).toBe(true);
    expect(hit.reasons).toHaveLength(3);
  });

  it('段信号全部缺失时回落 template 并注明缺信号', () => {
    const decision = evaluateHybridSegment({});
    expect(decision.agent).toBe(false);
    expect(decision.reasons.join()).toContain('缺段信号');
  });

  it('非法分数（NaN / 非数字）视为缺信号，不命中阈值', () => {
    expect(evaluateHybridSegment({ visualizationScore: Number.NaN }).agent).toBe(false);
    const decision = evaluateHybridSegment({ visualizationScore: 50 });
    expect(decision.agent).toBe(false);
    expect(decision.reasons.join()).toContain('未命中精雕规则');
  });
});

describe('selectHybridAgentSegments：每期上限截断', () => {
  it('比例上限：12 段 5 个候选，只放行 ceil(12/3)=4 个，其余回落 template', () => {
    const segments = [
      seg('a', { visualizationScore: 95 }),
      seg('b', { visualizationScore: 90 }),
      seg('c', { visualizationScore: 85 }),
      seg('d', { visualizationScore: 80 }),
      seg('e', { visualizationScore: 75 }),
      ...Array.from({ length: 7 }, (_, i) => seg(`n${i}`, { visualizationScore: 40 })),
    ];
    const decisions = selectHybridAgentSegments(segments);
    const agents = [...decisions.entries()].filter(([, d]) => d.agent).map(([id]) => id);
    expect(agents).toEqual(['a', 'b', 'c', 'd']);
    const capped = decisions.get('e');
    expect(capped?.agent).toBe(false);
    expect(capped?.reasons.join()).toContain('上限');
  });

  it('绝对上限：30 段 10 个候选，最多放行 HYBRID_AGENT_MAX_PER_RUN 个', () => {
    const segments = Array.from({ length: 30 }, (_, i) =>
      seg(`s${i}`, { visualizationScore: i < 10 ? 100 - i : 30 }),
    );
    const decisions = selectHybridAgentSegments(segments);
    const agents = [...decisions.values()].filter((d) => d.agent);
    expect(agents).toHaveLength(HYBRID_AGENT_MAX_PER_RUN);
  });

  it('小期保底：2 段 2 个候选时上限为 1，只放行分数更高的', () => {
    const decisions = selectHybridAgentSegments([
      seg('low', { visualizationScore: 76 }),
      seg('high', { visualizationScore: 99 }),
    ]);
    expect(decisions.get('high')?.agent).toBe(true);
    expect(decisions.get('low')?.agent).toBe(false);
    expect(decisions.get('low')?.reasons.join()).toContain('回落 template');
  });

  it('截断优先级：同分按 bible intensity 降序，再同按原顺序', () => {
    // 5 段 → 上限 ceil(5/3)=2；b、c 同分 90，c 的 intensity=3 优先；b 与原顺序靠前的 d 比较……
    const decisions = selectHybridAgentSegments([
      seg('a', { visualizationScore: 91 }),
      seg('b', { visualizationScore: 90, motionBibleIntensity: 1 }),
      seg('c', { visualizationScore: 90, motionBibleIntensity: 3 }),
      seg('d', { visualizationScore: 80 }),
      seg('e', { visualizationScore: 10 }),
    ]);
    expect(decisions.get('a')?.agent).toBe(true);
    expect(decisions.get('c')?.agent).toBe(true);
    expect(decisions.get('b')?.agent).toBe(false);
    expect(decisions.get('d')?.agent).toBe(false);
  });

  it('缺分数的候选在截断排序中垫底', () => {
    // 3 段 → 上限 1；data 段缺分，高分段胜出
    const decisions = selectHybridAgentSegments([
      seg('data', { semanticType: 'data' }),
      seg('scored', { visualizationScore: 80 }),
      seg('plain', { visualizationScore: 20 }),
    ]);
    expect(decisions.get('scored')?.agent).toBe(true);
    expect(decisions.get('data')?.agent).toBe(false);
  });

  it('缺字段段不占用候选名额', () => {
    const decisions = selectHybridAgentSegments([
      seg('x', {}),
      seg('y', { visualizationScore: 80 }),
    ]);
    expect(decisions.get('x')?.agent).toBe(false);
    expect(decisions.get('x')?.reasons.join()).toContain('缺段信号');
    expect(decisions.get('y')?.agent).toBe(true);
  });

  it('支持显式 maxAgent 覆盖默认上限', () => {
    const segments = Array.from({ length: 4 }, (_, i) => seg(`s${i}`, { visualizationScore: 90 }));
    const decisions = selectHybridAgentSegments(segments, { maxAgent: 1 });
    expect([...decisions.values()].filter((d) => d.agent)).toHaveLength(1);
  });
});

describe('buildHybridSelectionFromPlan：从导演方案构建预选表（三处批量入口共用）', () => {
  it('只覆盖启用的 motion 段：disabled 与 image 段不进预选表', () => {
    const decisions = buildHybridSelectionFromPlan({
      segments: [
        { id: 'on', enabled: true, visualType: 'motion', visualizationScore: 90 },
        { id: 'off', enabled: false, visualType: 'motion', visualizationScore: 95 },
        { id: 'img', enabled: true, visualType: 'image', visualizationScore: 100 },
      ],
    });
    expect(decisions.has('on')).toBe(true);
    expect(decisions.get('on')?.agent).toBe(true);
    expect(decisions.has('off')).toBe(false);
    expect(decisions.has('img')).toBe(false);
  });

  it('visualType 缺省按 motion 处理；enabled 缺省按启用处理', () => {
    const decisions = buildHybridSelectionFromPlan({
      segments: [{ id: 'plain', visualizationScore: 88 }],
    });
    expect(decisions.get('plain')?.agent).toBe(true);
  });

  it('从 motionBible.carrierPlan 按 segmentId 接上 intensity 信号', () => {
    const decisions = buildHybridSelectionFromPlan({
      segments: [{ id: 's1', enabled: true, visualizationScore: 30 }],
      motionBible: { carrierPlan: [{ segmentId: 's1', intensity: 3 }] },
    });
    expect(decisions.get('s1')?.agent).toBe(true);
    expect(decisions.get('s1')?.reasons.join()).toContain('intensity');
  });

  it('motionBible 缺失时仍可仅凭段信号判定', () => {
    const decisions = buildHybridSelectionFromPlan({
      segments: [{ id: 'q', enabled: true, semanticType: 'quote' }],
      motionBible: null,
    });
    expect(decisions.get('q')?.agent).toBe(true);
  });

  it('每期上限在 plan 层生效：候选超限按分数截断', () => {
    // 6 个启用 motion 段全部高分 → 上限 ceil(6/3)=2，放行分数最高的两个
    const decisions = buildHybridSelectionFromPlan({
      segments: Array.from({ length: 6 }, (_, i) => ({
        id: `s${i}`,
        enabled: true,
        visualizationScore: 90 - i,
      })),
    });
    const agents = [...decisions.entries()].filter(([, d]) => d.agent).map(([id]) => id);
    expect(agents).toEqual(['s0', 's1']);
    expect(decisions.get('s2')?.reasons.join()).toContain('上限');
  });
});

describe('resolveMotionCardPath：编排器出卡路径决议', () => {
  it('existingTsx（精雕）强制 agent，忽略任何模式设置', () => {
    expect(resolveMotionCardPath({ motionCardMode: 'template', existingTsx: 'x' }).path).toBe('agent');
    expect(resolveMotionCardPath({ motionCardMode: 'hybrid', existingTsx: 'x' }).path).toBe('agent');
  });

  it('缺省模式 = template；显式 template / agent 直译', () => {
    expect(resolveMotionCardPath({}).path).toBe('template');
    expect(resolveMotionCardPath({ motionCardMode: 'template' }).path).toBe('template');
    expect(resolveMotionCardPath({ motionCardMode: 'agent' }).path).toBe('agent');
  });

  it('hybrid：批量预选决议优先于单卡规则', () => {
    const decision = resolveMotionCardPath({
      motionCardMode: 'hybrid',
      visualizationScore: 99,
      hybridDecision: { agent: false, reasons: ['超出每期 agent 上限 2，回落 template'] },
    });
    expect(decision.path).toBe('template');
    expect(decision.reasons.join()).toContain('上限');
    const admitted = resolveMotionCardPath({
      motionCardMode: 'hybrid',
      hybridDecision: { agent: true, reasons: ['visualizationScore 90 ≥ 75'] },
    });
    expect(admitted.path).toBe('agent');
  });

  it('hybrid：无预选决议时按单卡规则兜底（重生成 / 手动选段场景）', () => {
    expect(
      resolveMotionCardPath({ motionCardMode: 'hybrid', visualizationScore: 88 }).path,
    ).toBe('agent');
    expect(resolveMotionCardPath({ motionCardMode: 'hybrid', semanticType: 'quote' }).path).toBe(
      'agent',
    );
    expect(resolveMotionCardPath({ motionCardMode: 'hybrid', motionBibleIntensity: 3 }).path).toBe(
      'agent',
    );
  });

  it('hybrid：段信号缺失或未命中规则时回落 template', () => {
    const noSignal = resolveMotionCardPath({ motionCardMode: 'hybrid' });
    expect(noSignal.path).toBe('template');
    expect(noSignal.reasons.join()).toContain('缺段信号');
    expect(
      resolveMotionCardPath({ motionCardMode: 'hybrid', visualizationScore: 50, semanticType: 'narration' }).path,
    ).toBe('template');
  });
});
