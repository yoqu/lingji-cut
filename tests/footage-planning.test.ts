import { describe, expect, it, vi } from 'vitest';
import { planTranscriptSegments } from '../src/lib/ai-analysis';
import {
  buildFootageLibraryBlock,
  enforceFootageSegmentRules,
  normalizeFootageQuery,
} from '../src/lib/footage-match';
import { buildDefaultAISettings } from '../src/store/ai';
import type { AISegmentAnalysis, AISettings } from '../src/types/ai';
import type { KacutLibraryDigest } from '../src/types/footage';
import type { SrtEntry } from '../src/types';

function srtEntries(count: number, spanMs = 5_000): SrtEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    startMs: i * spanMs,
    endMs: (i + 1) * spanMs,
    text: `第 ${i + 1} 句口播内容`,
  }));
}

function rawSegment(
  index: number,
  spanMs: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `segment-${index + 1}`,
    title: `段落 ${index + 1}`,
    summary: `摘要 ${index + 1}`,
    startMs: index * spanMs,
    endMs: (index + 1) * spanMs,
    semanticType: 'narration',
    complexityLevel: 'medium',
    visualizationScore: 50,
    pacingNeed: 'steady',
    keywords: [],
    entities: [],
    ...extra,
  };
}

function digest(): KacutLibraryDigest {
  return {
    libraryCount: 1,
    itemCount: 120,
    indexedItemCount: 118,
    kindCounts: { video: 80, image: 40 },
    topSceneTags: [
      { tag: '城市夜景', count: 20 },
      { tag: '森林徒步', count: 12 },
    ],
    libraries: [{ id: 'lib-1', name: '默认库', itemCount: 120 }],
  };
}

function kacutSettings(): AISettings {
  return { ...buildDefaultAISettings(), kacut: { enabled: true, baseUrl: 'http://127.0.0.1:8765' } };
}

describe('buildFootageLibraryBlock', () => {
  it('包含素材数量、kind 分布、前 30 个高频场景标签与 footage 规则', () => {
    const manyTags = Array.from({ length: 40 }, (_, i) => ({ tag: `标签${i + 1}`, count: 40 - i }));
    const block = buildFootageLibraryBlock({ ...digest(), topSceneTags: manyTags });
    expect(block).toContain('共 120 条素材');
    expect(block).toContain('视频 80 条');
    expect(block).toContain('图片 40 条');
    expect(block).toContain('标签1');
    expect(block).toContain('标签30');
    expect(block).not.toContain('标签31');
    expect(block).toContain('context / emotion / demonstration / breath');
    expect(block).toContain('不设 footage 的数量、占比、连续段数或首尾禁用规则');
    expect(block).not.toContain('不得连续超过 2 段');
    expect(block).toContain('footageQuery');
    expect(block).toContain('footageFallback');
  });
});

describe('normalizeFootageQuery', () => {
  it('使用素材库常用道路标签并去掉汽车/车辆同义重复', () => {
    expect(normalizeFootageQuery('汽车 车道 行驶 车辆')).toBe('汽车 道路 行驶');
    expect(normalizeFootageQuery('汽车 家用车 SUV 车辆')).toBe('汽车 家用车 SUV');
  });
});

describe('enforceFootageSegmentRules', () => {
  function seg(id: string, visualType: AISegmentAnalysis['visualType'], query?: string): AISegmentAnalysis {
    return {
      id,
      title: id,
      summary: id,
      startMs: 0,
      endMs: 5_000,
      semanticType: 'narration',
      complexityLevel: 'medium',
      visualizationScore: 50,
      pacingNeed: 'steady',
      keywords: [],
      entities: [],
      visualType,
      footageQuery: query,
      footageFallback: visualType === 'footage' ? 'motion' : undefined,
    };
  }

  it('不对连续 footage 或首尾 footage 设置机器配额', () => {
    const input = [
      seg('a', 'footage', '城市'),
      seg('b', 'footage', '夜景'),
      seg('c', 'footage', '街道'),
    ];
    const result = enforceFootageSegmentRules(input, { footageOffered: true });
    expect(result).toBe(input);
    expect(result.map((s) => s.visualType)).toEqual(['footage', 'footage', 'footage']);
  });

  it('footageQuery 缺失的 footage 段回落', () => {
    const input = [seg('a', 'motion'), seg('b', 'footage'), seg('c', 'motion')];
    const result = enforceFootageSegmentRules(input, { footageOffered: true });
    expect(result[1].visualType).toBe('motion');
  });

  it('未向 LLM 提供 footage 选项时，仍出现的 footage 一律回落', () => {
    const input = [seg('a', 'motion'), seg('b', 'footage', '城市'), seg('c', 'motion')];
    const result = enforceFootageSegmentRules(input, { footageOffered: false });
    expect(result.map((s) => s.visualType)).toEqual(['motion', 'motion', 'motion']);
  });

  it('footageFallback=image 的回落目标是 image', () => {
    const input = [seg('a', 'footage'), seg('b', 'motion')];
    input[0].footageFallback = 'image';
    const result = enforceFootageSegmentRules(input, { footageOffered: true });
    expect(result[0].visualType).toBe('image');
  });

  it('图片服务不可用时 footageFallback=image 也回落到 motion', () => {
    const input = [seg('a', 'footage'), seg('b', 'motion')];
    input[0].footageFallback = 'image';
    const result = enforceFootageSegmentRules(input, {
      footageOffered: true,
      imageFallbackAvailable: false,
    });
    expect(result[0].visualType).toBe('motion');
  });

  it('无违规时原样返回（引用不变）', () => {
    const input = [seg('a', 'motion'), seg('b', 'footage', '城市'), seg('c', 'motion')];
    expect(enforceFootageSegmentRules(input, { footageOffered: true })).toBe(input);
  });
});

describe('planTranscriptSegments 的 footage 接入', () => {
  function mockLlm(segments: Array<Record<string, unknown>>) {
    const calls: Array<{ system: string }> = [];
    const generateStructuredData = vi.fn(async (_settings: unknown, system: string) => {
      calls.push({ system });
      return {
        segments,
        coverPrompts: [],
        summary: '节目摘要',
        keywords: ['关键词'],
      };
    });
    return { generateStructuredData, calls };
  }

  it('kacut 启用且 digest 可用：prompt 注入素材库块，footage 段被保留并解析 footageQuery', async () => {
    const entries = srtEntries(3);
    const { generateStructuredData, calls } = mockLlm([
      rawSegment(0, 5_000),
      rawSegment(1, 5_000, { visualType: 'footage', footageQuery: '城市 夜景', footageFallback: 'image' }),
      rawSegment(2, 5_000),
    ]);

    const result = await planTranscriptSegments(entries, kacutSettings(), {
      generateStructuredData: generateStructuredData as never,
      kacutDigestProvider: async () => digest(),
    });

    expect(calls[0].system).toContain('素材库 footage 轨道');
    expect(calls[0].system).toContain('城市夜景');
    const middle = result.segments[1];
    expect(middle.visualType).toBe('footage');
    expect(middle.footageQuery).toBe('城市 夜景');
    expect(middle.footageFallback).toBe('image');
  });

  it('kacut 未启用：prompt 不出现 footage 选项，LLM 误吐的 footage 全部回落', async () => {
    const entries = srtEntries(3);
    const { generateStructuredData, calls } = mockLlm([
      rawSegment(0, 5_000),
      rawSegment(1, 5_000, { visualType: 'footage', footageQuery: '城市 夜景' }),
      rawSegment(2, 5_000),
    ]);

    const result = await planTranscriptSegments(entries, buildDefaultAISettings(), {
      generateStructuredData: generateStructuredData as never,
      kacutDigestProvider: async () => digest(),
    });

    expect(calls[0].system).not.toContain('【素材库 footage 轨道（可选）】');
    expect(result.segments[1].visualType).toBe('motion');
    expect(result.segments[1].footageQuery).toBeUndefined();
  });

  it('digest 获取失败：行为与未启用一致（不出现 footage 选项）', async () => {
    const entries = srtEntries(2);
    const { generateStructuredData, calls } = mockLlm([
      rawSegment(0, 5_000),
      rawSegment(1, 5_000, { visualType: 'footage', footageQuery: '城市' }),
    ]);

    const result = await planTranscriptSegments(entries, kacutSettings(), {
      generateStructuredData: generateStructuredData as never,
      kacutDigestProvider: async () => {
        throw new Error('kacut 连接被拒');
      },
    });

    expect(calls[0].system).not.toContain('【素材库 footage 轨道（可选）】');
    expect(result.segments[1].visualType).toBe('motion');
    expect(result.warnings?.[0]).toContain('灵机素材库连接失败');
  });

  it('素材库可用但 LLM 全选 Motion：规划后处理不按配额强制改写媒介决策', async () => {
    const entries = srtEntries(12);
    const { generateStructuredData } = mockLlm(Array.from({ length: 12 }, (_, index) => rawSegment(
      index,
      5_000,
      index === 5
        ? { title: '汽车工厂', summary: '车辆在生产线上装配', visualType: 'motion' }
        : { visualType: 'motion' },
    )));

    const result = await planTranscriptSegments(entries, kacutSettings(), {
      generateStructuredData: generateStructuredData as never,
      kacutDigestProvider: async () => digest(),
    });

    expect(result.segments.every((segment) => segment.visualType === 'motion')).toBe(true);
  });

  it('连续 3 段 footage：保留导演媒介决策，不按连续段数回落', async () => {
    const entries = srtEntries(5);
    const { generateStructuredData } = mockLlm([
      rawSegment(0, 5_000),
      rawSegment(1, 5_000, { visualType: 'footage', footageQuery: '城市' }),
      rawSegment(2, 5_000, { visualType: 'footage', footageQuery: '夜景' }),
      rawSegment(3, 5_000, { visualType: 'footage', footageQuery: '街道' }),
      rawSegment(4, 5_000),
    ]);

    const result = await planTranscriptSegments(entries, kacutSettings(), {
      generateStructuredData: generateStructuredData as never,
      kacutDigestProvider: async () => digest(),
    });

    // 未声明 visualType 的段保持 undefined（下游按 motion 默认），三个 footage 均保留。
    expect(result.segments.map((s) => s.visualType)).toEqual([
      undefined, 'footage', 'footage', 'footage', undefined,
    ]);
  });

  it('visualType 白名单：非法值回落（不出现 footage 之外的新类型）', async () => {
    const entries = srtEntries(3);
    const { generateStructuredData } = mockLlm([
      rawSegment(0, 5_000),
      rawSegment(1, 5_000, { visualType: 'hologram' }),
      rawSegment(2, 5_000),
    ]);

    const result = await planTranscriptSegments(entries, kacutSettings(), {
      generateStructuredData: generateStructuredData as never,
      kacutDigestProvider: async () => digest(),
    });

    // 非法值 → undefined（下游按 motion 默认处理）
    expect(result.segments[1].visualType).toBeUndefined();
  });
});
