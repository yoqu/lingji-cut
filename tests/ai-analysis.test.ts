import { describe, expect, it, vi } from 'vitest';
import {
  analyzeSrt,
  anchorSegmentsToTranscript,
  buildCoverPromptRegenerationPrompt,
  buildSegmentCardPrompt,
  buildSegmentPlanningPrompt,
  buildPlainTranscriptRange,
  buildSrtText,
  generateAnimationDirection,
  generateCardForSegment,
  planTranscriptSegments,
  regenerateAICard,
  regenerateCoverPrompt,
} from '../src/lib/ai-analysis';
import type { MotionCardAgentProvider } from '../src/lib/ai-analysis';
import type { SrtEntry } from '../src/types';
import type { AICard, AISegment, AISegmentAnalysis, AISettings } from '../src/types/ai';
import { generateStructuredData } from '../src/lib/llm';

const makeSrtEntry = (index: number, startMs: number, endMs: number, text: string): SrtEntry => ({
  index,
  startMs,
  endMs,
  text,
});

const settings: AISettings = {
  llmBaseUrl: 'https://api.openai.com/v1',
  llmApiKey: 'sk-test',
  llmModel: 'gpt-4o-mini',
};

const baseEntries = [
  makeSrtEntry(1, 0, 3_000, '欢迎收听本期节目，我们先聊 AI 视频生产的背景。'),
  makeSrtEntry(2, 3_000, 7_000, '接下来进入第二部分，重点分析工作流拆分与卡片生成方式。'),
];

const fullTranscript = buildSrtText(baseEntries);

const baseSegment: AISegment = {
  id: 'seg-1',
  title: 'AI 视频生产背景',
  summary: '概括节目开场对 AI 视频生产现状的说明',
  startMs: 0,
  endMs: 3_000,
  transcriptExcerpt: '欢迎收听本期节目，我们先聊 AI 视频生产的背景。',
};

const secondSegment: AISegment = {
  id: 'seg-2',
  title: '工作流拆分',
  summary: '分析为什么要先做 segment planning，再逐段生成卡片',
  startMs: 3_000,
  endMs: 7_000,
  transcriptExcerpt: '接下来进入第二部分，重点分析工作流拆分与卡片生成方式。',
};

const baseCard: AICard = {
  id: 'card-1',
  segmentId: 'seg-1',
  type: 'summary',
  title: '旧标题',
  content: '旧内容',
  startMs: 0,
  endMs: 3_000,
  displayDurationMs: 5_000,
  displayMode: 'fullscreen',
  template: 'summary-default',
  enabled: true,
  style: {
    primaryColor: '#79c4ff',
    backgroundColor: '#151922',
    fontSize: 48,
  },
  cardPrompt: '做成更像商业海报',
};

/** 一段可被 Remotion 渲染的 Motion Card TSX（default export 函数组件） */
const VALID_MOTION_TSX = `import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
export default function MotionCard() {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ opacity }}>摘要卡</AbsoluteFill>;
}`;

const makeLongEntries = () =>
  Array.from({ length: 18 }, (_, index) =>
    makeSrtEntry(
      index + 1,
      index * 10_000,
      (index + 1) * 10_000,
      `第 ${index + 1} 条长字幕内容`,
    ),
  );

const longSegment = {
  id: 'long-seg',
  title: '超长主题',
  summary: '一个被模型误判成单段的超长主题',
  startMs: 0,
  endMs: 180_000,
  transcriptExcerpt: '超长主题原始摘录',
  semanticType: 'explanation',
  complexityLevel: 'medium',
  visualizationScore: 80,
  pacingNeed: 'steady',
  keywords: ['长视频', '分段'],
  entities: ['Motion Card'],
  visualType: 'motion',
};

describe('buildSrtText', () => {
  it('formats subtitle entries into readable timestamped lines', () => {
    const text = buildSrtText(baseEntries);

    expect(text).toContain('[00:00.000 --> 00:03.000]');
    expect(text).toContain('欢迎收听本期节目');
    expect(text).toContain('[00:03.000 --> 00:07.000]');
    expect(text).toContain('重点分析工作流拆分与卡片生成方式');
  });
});

describe('buildPlainTranscriptRange', () => {
  it('returns only the verbatim text of entries overlapping the exact range, without timecodes', () => {
    const text = buildPlainTranscriptRange(baseEntries, 0, 3_000);

    expect(text).toBe('欢迎收听本期节目，我们先聊 AI 视频生产的背景。');
    expect(text).not.toContain('-->');
    expect(text).not.toContain('[00:');
  });

  it('joins multiple overlapping entries with newlines in time order', () => {
    const text = buildPlainTranscriptRange(baseEntries, 0, 7_000);

    expect(text).toBe(
      '欢迎收听本期节目，我们先聊 AI 视频生产的背景。\n接下来进入第二部分，重点分析工作流拆分与卡片生成方式。',
    );
  });

  it('does not include neighbour entries outside the range (no padding)', () => {
    const text = buildPlainTranscriptRange(baseEntries, 0, 3_000);

    expect(text).not.toContain('第二部分');
  });

  it('returns an empty string when no subtitle overlaps the range', () => {
    expect(buildPlainTranscriptRange(baseEntries, 8_000, 9_000)).toBe('');
  });
});

describe('buildSegmentPlanningPrompt', () => {
  it('asks the model to plan segments instead of generating cards directly', () => {
    const prompt = buildSegmentPlanningPrompt('整体偏商业分析风');

    expect(prompt).toContain('segments');
    expect(prompt).toContain('coverPrompts');
    expect(prompt).toContain('整体偏商业分析风');
    expect(prompt).not.toContain('webCard');
    expect(prompt).not.toContain('srcDoc');
  });
});

describe('buildSegmentCardPrompt', () => {
  it('requires Remotion TSX output and exposes the frame-driven contract', () => {
    const programContext = '节目摘要：节目总结\n节目关键词：AI、工作流\n当前段标题：AI 视频生产背景';
    const prompt = buildSegmentCardPrompt({
      programContext,
      segment: baseSegment,
      globalPrompt: '整体偏商业分析风',
      cardPrompt: '这一张做成粒子聚合',
      currentCard: baseCard,
      programSummary: '节目总结',
      keywords: ['AI', '工作流'],
    });

    expect(prompt).toContain(programContext);
    expect(prompt).not.toContain(fullTranscript);
    expect(prompt).toContain('AI 视频生产背景');
    expect(prompt).toContain('概括节目开场对 AI 视频生产现状的说明');
    expect(prompt).toContain('整体偏商业分析风');
    expect(prompt).toContain('这一张做成粒子聚合');
    // TSX-only 契约：要求 tsx 代码块 + export default + 帧驱动，且不再要求严格 JSON
    expect(prompt).toContain('tsx');
    expect(prompt).toContain('export default');
    expect(prompt).toContain('useCurrentFrame');
    expect(prompt).toContain('Remotion');
    expect(prompt).not.toContain('严格 JSON');
    // 旧引擎痕迹不得残留
    expect(prompt).not.toContain('gsap.timeline');
    expect(prompt).not.toContain('window.__lingjiMotionTimelines');
    // Web Card 痕迹不得残留
    expect(prompt).not.toContain('webCard.srcDoc');
    expect(prompt).not.toContain('web-card');
  });
});

describe('buildCoverPromptRegenerationPrompt', () => {
  it('requests a single simplified Chinese cover prompt', () => {
    const prompt = buildCoverPromptRegenerationPrompt({
      globalPrompt: '整体偏财经媒体封面',
      currentPrompt: '旧提示词',
    });

    expect(prompt).toContain('1 条可直接喂给 AI 生图');
    expect(prompt).toContain('必须使用简体中文');
    expect(prompt).toContain('旧提示词');
    expect(prompt).toContain('整体偏财经媒体封面');
  });
});

describe('planTranscriptSegments', () => {
  it('plans segments from the full transcript', async () => {
    const modelCaller = vi.fn<typeof generateStructuredData>().mockResolvedValue({
      segments: [baseSegment, secondSegment],
      coverPrompts: ['封面提示词'],
      summary: '节目总结',
      keywords: ['AI', '播客'],
      globalPrompt: '整体偏商业分析风',
    });

    const result = await planTranscriptSegments(baseEntries, settings, {
      generateStructuredData: modelCaller,
      globalPrompt: '整体偏商业分析风',
    });

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.id).toBe('seg-1');
    expect(result.coverPrompts).toEqual(['封面提示词']);
    expect(result.summary).toBe('节目总结');
    expect(result.keywords).toEqual(['AI', '播客']);
    expect(modelCaller).toHaveBeenCalledTimes(1);
    expect(modelCaller.mock.calls[0]?.[2]).toBe(fullTranscript);
  });

  it('splits overlong planned segments by subtitle boundaries', async () => {
    const longEntries = makeLongEntries();
    const modelCaller = vi.fn<typeof generateStructuredData>().mockResolvedValue({
      segments: [longSegment],
      coverPrompts: ['封面提示词'],
      summary: '节目总结',
      keywords: ['AI', '播客'],
    });

    const result = await planTranscriptSegments(longEntries, settings, {
      generateStructuredData: modelCaller,
    });

    expect(result.segments).toHaveLength(5);
    expect(result.segments.every((segment) => segment.endMs - segment.startMs <= 60_000)).toBe(
      true,
    );
    expect(result.segments.map((segment) => segment.id)).toEqual([
      'long-seg-part-1',
      'long-seg-part-2',
      'long-seg-part-3',
      'long-seg-part-4',
      'long-seg-part-5',
    ]);
    expect(result.segments[0]?.title).toBe('超长主题（1/5）');
    expect(result.segments[0]?.summary).toContain('第 1/5 小节');
    expect(result.segments[0]?.transcriptExcerpt).toContain('第 1 条长字幕内容');
    expect(result.segments[0]?.transcriptExcerpt).not.toContain('第 8 条长字幕内容');
    expect(result.segments[0]?.keywords).toEqual(['长视频', '分段']);
    expect(result.segments[0]?.visualType).toBe('motion');
  });
});

describe('generateCardForSegment', () => {
  it('builds a motion-card from the agent TSX source, synthesizing metadata from the segment', async () => {
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX });

    const result = await generateCardForSegment(
      baseEntries,
      {
        segments: [baseSegment],
        coverPrompts: ['封面提示词'],
        summary: '节目总结',
        keywords: ['AI'],
        globalPrompt: '整体偏商业分析风',
      },
      baseSegment,
      settings,
      {
        generateMotionCard: motionCaller,
        globalPrompt: '整体偏商业分析风',
        cardPrompt: '做成粒子聚合',
      },
    );

    expect(result.segmentId).toBe('seg-1');
    // 元信息从 segment 合成（title 取 segment.title），不再来自模型
    expect(result.title).toBe('AI 视频生产背景');
    expect(result.startMs).toBe(0);
    expect(result.endMs).toBe(3_000);
    expect(result.renderMode).toBe('motion-card');
    expect(result.cardPrompt).toBe('做成粒子聚合');
    expect(result.motionCard?.tsx).toContain('export default');
    expect(result.motionCard?.tsx).toContain('useCurrentFrame');
    expect(motionCaller).toHaveBeenCalledTimes(1);
    // ctx.segmentTranscript = 段内逐字稿；buildCardPrompt 渲染 cards.segment 提示词，提及当前段
    const ctx = motionCaller.mock.calls[0]![0];
    expect(ctx.segmentTranscript).toContain('欢迎收听本期节目');
    expect(ctx.buildCardPrompt(undefined)).toContain('AI 视频生产背景');
  });

  it('defaults a new card duration to the full segment span so the timeline has no blank gaps', async () => {
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX });

    const wideSegment: AISegment = {
      ...baseSegment,
      id: 'seg-wide',
      startMs: 0,
      endMs: 45_000,
    };

    const result = await generateCardForSegment(
      baseEntries,
      { segments: [wideSegment], coverPrompts: [], summary: '', keywords: [] },
      wideSegment,
      settings,
      { generateMotionCard: motionCaller },
    );

    // 新卡片（无 currentCard）应铺满所在 segment（45s），而不是固定 5s 默认值
    expect(result.displayDurationMs).toBe(45_000);
  });

  it('preserves the existing card type/title/timing on regeneration', async () => {
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX });

    const result = await generateCardForSegment(
      baseEntries,
      { segments: [baseSegment], coverPrompts: [], summary: '', keywords: [] },
      baseSegment,
      settings,
      { generateMotionCard: motionCaller, currentCard: baseCard },
    );

    expect(result.id).toBe('card-1');
    expect(result.title).toBe('旧标题');
    expect(result.displayDurationMs).toBe(5_000);
  });

  it('fills content with the verbatim segment subtitle text', async () => {
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX });

    const result = await generateCardForSegment(
      baseEntries,
      { segments: [baseSegment], coverPrompts: [], summary: '', keywords: [] },
      baseSegment,
      settings,
      { generateMotionCard: motionCaller },
    );

    expect(result.content).toBe('欢迎收听本期节目，我们先聊 AI 视频生产的背景。');
  });

  it('falls back to the segment summary for content when the range has no subtitle text', async () => {
    const offRangeSegment: AISegment = {
      ...baseSegment,
      id: 'seg-off',
      summary: '段落摘要兜底',
      startMs: 8_000,
      endMs: 9_000,
    };
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX });

    const result = await generateCardForSegment(
      baseEntries,
      { segments: [offRangeSegment], coverPrompts: [], summary: '', keywords: [] },
      offRangeSegment,
      settings,
      { generateMotionCard: motionCaller },
    );

    expect(result.content).toBe('段落摘要兜底');
  });

  it('throws a regenerate-hinted error when the TSX has no default export', async () => {
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: 'const Card = 42;' });

    await expect(
      generateCardForSegment(
        baseEntries,
        { segments: [baseSegment], coverPrompts: [], summary: '', keywords: [] },
        baseSegment,
        settings,
        { generateMotionCard: motionCaller },
      ),
    ).rejects.toThrow(/请重新生成/);
  });

  it('propagates the provider error when the agent returns no usable component', async () => {
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockRejectedValue(new Error('LLM 未返回 motionCard.tsx；请重新生成'));

    await expect(
      generateCardForSegment(
        baseEntries,
        { segments: [baseSegment], coverPrompts: [], summary: '', keywords: [] },
        baseSegment,
        settings,
        { generateMotionCard: motionCaller },
      ),
    ).rejects.toThrow(/motionCard/);
  });

  it('rejects motion segments when no agent provider is injected', async () => {
    await expect(
      generateCardForSegment(
        baseEntries,
        { segments: [baseSegment], coverPrompts: [], summary: '', keywords: [] },
        baseSegment,
        settings,
        {},
      ),
    ).rejects.toThrow(/generateMotionCard/);
  });
});

describe('analyzeSrt', () => {
  it('uses one planning call plus one motion-source call per segment', async () => {
    const planningCaller = vi.fn<typeof generateStructuredData>().mockResolvedValue({
      segments: [baseSegment, secondSegment],
      coverPrompts: ['封面提示词'],
      summary: '节目总结',
      keywords: ['AI', '播客'],
      globalPrompt: '整体偏商业分析风',
    });
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX });

    const result = await analyzeSrt(baseEntries, settings, {
      generateStructuredData: planningCaller,
      generateMotionCard: motionCaller,
      globalPrompt: '整体偏商业分析风',
    });

    expect(planningCaller).toHaveBeenCalledTimes(1);
    expect(planningCaller.mock.calls[0]?.[1]).toContain('segments');
    expect(motionCaller).toHaveBeenCalledTimes(2);
    expect(motionCaller.mock.calls[0]?.[0]?.buildCardPrompt(undefined)).toContain('AI 视频生产背景');
    expect(motionCaller.mock.calls[1]?.[0]?.buildCardPrompt(undefined)).toContain('工作流拆分');
    expect(result.segments).toHaveLength(2);
    expect(result.cards).toHaveLength(2);
    expect(result.cards.map((card) => card.segmentId)).toEqual(['seg-1', 'seg-2']);
    expect(result.cards[0]?.renderMode).toBe('motion-card');
    expect(result.cards[0]?.motionCard?.tsx).toContain('export default');
    expect(result.cards[1]?.motionCard?.tsx).toContain('export default');
    expect(result.coverPrompts).toEqual(['封面提示词']);
  });

  it('continues with other segments when one card generation fails and returns cardErrors', async () => {
    const planningCaller = vi.fn<typeof generateStructuredData>().mockResolvedValue({
      segments: [baseSegment, secondSegment],
      coverPrompts: ['封面提示词'],
      summary: '节目总结',
      keywords: ['AI', '播客'],
      globalPrompt: '整体偏商业分析风',
    });
    const motionCaller = vi.fn<MotionCardAgentProvider>();
    motionCaller.mockImplementation(async (ctx) => {
      if (ctx.segmentId === 'seg-1') {
        throw new Error('LLM Motion 源码请求 空闲超时');
      }
      return { tsx: VALID_MOTION_TSX };
    });

    const result = await analyzeSrt(baseEntries, settings, {
      generateStructuredData: planningCaller,
      generateMotionCard: motionCaller,
      globalPrompt: '整体偏商业分析风',
    });

    expect(planningCaller).toHaveBeenCalledTimes(1);
    expect(motionCaller).toHaveBeenCalledTimes(2);
    expect(result.cards.map((card) => card.segmentId)).toEqual(['seg-2']);
    expect(result.cardErrors).toBeDefined();
    expect(result.cardErrors).toHaveLength(1);
    expect(result.cardErrors?.[0]?.segmentId).toBe('seg-1');
    expect(result.cardErrors?.[0]?.message).toContain('空闲超时');
    expect(result.segments).toHaveLength(2);
  });

  it('invokes onCardGenerated once per successfully generated card with (card, index) matching the final result', async () => {
    const planningCaller = vi.fn<typeof generateStructuredData>().mockResolvedValue({
      segments: [baseSegment, secondSegment],
      coverPrompts: ['封面提示词'],
      summary: '节目总结',
      keywords: ['AI', '播客'],
      globalPrompt: '整体偏商业分析风',
    });
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX });
    const generated: { card: AICard; index: number }[] = [];

    const result = await analyzeSrt(baseEntries, settings, {
      generateStructuredData: planningCaller,
      generateMotionCard: motionCaller,
      globalPrompt: '整体偏商业分析风',
      onCardGenerated: (card, index) => {
        generated.push({ card, index });
      },
    });

    // 恰好每张成功卡片回调一次
    expect(generated).toHaveLength(2);
    // index 为 planning 顺序下标；两段都成功 → 0 与 1
    expect(generated.map((g) => g.index).sort()).toEqual([0, 1]);
    // 回吐的卡片对象应与最终 result.cards 中对应槽位是同一引用
    const bySegment = new Map(generated.map((g) => [g.card.segmentId, g.card]));
    expect(bySegment.get('seg-1')).toBe(result.cards.find((c) => c.segmentId === 'seg-1'));
    expect(bySegment.get('seg-2')).toBe(result.cards.find((c) => c.segmentId === 'seg-2'));
  });

  it('does not invoke onCardGenerated for failed cards (only successful ones)', async () => {
    const planningCaller = vi.fn<typeof generateStructuredData>().mockResolvedValue({
      segments: [baseSegment, secondSegment],
      coverPrompts: ['封面提示词'],
      summary: '节目总结',
      keywords: ['AI', '播客'],
      globalPrompt: '整体偏商业分析风',
    });
    const motionCaller = vi.fn<MotionCardAgentProvider>();
    motionCaller.mockImplementation(async (ctx) => {
      if (ctx.segmentId === 'seg-1') {
        throw new Error('LLM Motion 源码请求 空闲超时');
      }
      return { tsx: VALID_MOTION_TSX };
    });
    const generated: { card: AICard; index: number }[] = [];

    const result = await analyzeSrt(baseEntries, settings, {
      generateStructuredData: planningCaller,
      generateMotionCard: motionCaller,
      globalPrompt: '整体偏商业分析风',
      onCardGenerated: (card, index) => {
        generated.push({ card, index });
      },
    });

    // seg-1 失败、seg-2 成功 → 仅回调一次，且只针对成功段
    expect(generated).toHaveLength(1);
    expect(generated[0]?.card.segmentId).toBe('seg-2');
    expect(generated[0]?.card).toBe(result.cards.find((c) => c.segmentId === 'seg-2'));
    expect(result.cardErrors).toHaveLength(1);
  });

  it('generates one card per split segment when planning returns an overlong segment', async () => {
    const longEntries = makeLongEntries();
    const planningCaller = vi.fn<typeof generateStructuredData>().mockResolvedValue({
      segments: [longSegment],
      coverPrompts: ['封面提示词'],
      summary: '节目总结',
      keywords: ['AI', '播客'],
    });
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX });

    const result = await analyzeSrt(longEntries, settings, {
      generateStructuredData: planningCaller,
      generateMotionCard: motionCaller,
    });

    expect(result.segments).toHaveLength(5);
    expect(result.cards).toHaveLength(5);
    expect(result.cards.map((card) => card.segmentId)).toEqual([
      'long-seg-part-1',
      'long-seg-part-2',
      'long-seg-part-3',
      'long-seg-part-4',
      'long-seg-part-5',
    ]);
    expect(planningCaller).toHaveBeenCalledTimes(1);
    expect(motionCaller).toHaveBeenCalledTimes(5);
  });
});

describe('regenerateCoverPrompt', () => {
  it('regenerates exactly one cover prompt and trims extra prompts', async () => {
    const modelCaller = vi.fn().mockResolvedValue({
      coverPrompts: ['新的封面提示词', '不应保留的第二条'],
    });

    const result = await regenerateCoverPrompt(baseEntries, settings, {
      generateStructuredData: modelCaller,
      globalPrompt: '整体偏商业媒体封面',
      currentPrompt: '旧提示词',
    });

    expect(result).toEqual(['新的封面提示词']);
    expect(modelCaller).toHaveBeenCalledTimes(1);
    expect(modelCaller.mock.calls[0]?.[1]).toContain('必须使用简体中文');
    expect(modelCaller.mock.calls[0]?.[1]).toContain('旧提示词');
  });
});

describe('regenerateAICard', () => {
  it('regenerates a single motion-card and preserves original card id/title/timing', async () => {
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX });

    const result = await regenerateAICard(
      baseEntries,
      baseCard,
      baseSegment,
      settings,
      {
        generateMotionCard: motionCaller,
        globalPrompt: '整体偏商业分析风',
      },
    );

    expect(motionCaller).toHaveBeenCalledTimes(1);
    // 精雕/重生成：现有源码通过 ctx.existingTsx 交给导演诊断（baseCard 无 motionCard → undefined）
    expect(motionCaller.mock.calls[0]?.[0]?.existingTsx).toBe(baseCard.motionCard?.tsx);
    expect(result.id).toBe('card-1');
    expect(result.segmentId).toBe('seg-1');
    // 元信息从既有卡片延续（不再由模型决定）
    expect(result.title).toBe('旧标题');
    expect(result.displayDurationMs).toBe(5_000);
    expect(result.renderMode).toBe('motion-card');
    expect(result.motionCard?.tsx).toContain('export default');
  });

  it('fails fast when segment is missing', async () => {
    await expect(
      regenerateAICard(
        baseEntries,
        baseCard,
        null as unknown as AISegment,
        settings,
        {
          generateMotionCard: vi.fn(),
        },
      ),
    ).rejects.toThrow('缺少卡片对应的段落信息');
  });
});

describe('anchorSegmentsToTranscript', () => {
  const entries: SrtEntry[] = [
    { index: 1, startMs: 0, endMs: 5_000, text: '大家好，今天聊比亚迪的底层逻辑。' },
    { index: 2, startMs: 5_000, endMs: 10_000, text: '第二个话题，是成本控制力。' },
    { index: 3, startMs: 10_000, endMs: 15_000, text: '最后总结一下，谢谢大家。' },
  ];
  const seg = (over: Partial<AISegmentAnalysis>): AISegmentAnalysis => ({
    id: 'x',
    title: 't',
    summary: 's',
    startMs: 0,
    endMs: 1,
    semanticType: 'explanation',
    complexityLevel: 'medium',
    visualizationScore: 50,
    pacingNeed: 'steady',
    keywords: [],
    entities: [],
    visualType: 'motion',
    ...over,
  });

  it('用 transcriptExcerpt 把漂移的 startMs 重锚定到 SRT 真实时间，并按下一段定 endMs', () => {
    const out = anchorSegmentsToTranscript(
      [
        seg({ id: 'a', startMs: 0, endMs: 9_999, transcriptExcerpt: '大家好今天聊比亚迪' }),
        seg({ id: 'b', startMs: 99_999, endMs: 199_999, transcriptExcerpt: '第二个话题是成本控制力' }),
        seg({ id: 'c', startMs: 999_999, endMs: 1_999_999, transcriptExcerpt: '最后总结一下谢谢大家' }),
      ],
      entries,
    );
    expect(out.map((s) => [s.id, s.startMs, s.endMs])).toEqual([
      ['a', 0, 5_000],
      ['b', 5_000, 10_000],
      ['c', 10_000, 15_000],
    ]);
  });

  it('丢弃超出字幕末尾的溢出段落', () => {
    const out = anchorSegmentsToTranscript(
      [
        seg({ id: 'a', startMs: 0, transcriptExcerpt: '大家好今天聊比亚迪' }),
        seg({ id: 'overflow', startMs: 5_000_000, endMs: 6_000_000, transcriptExcerpt: '完全不存在的内容片段' }),
      ],
      entries,
    );
    expect(out.map((s) => s.id)).toEqual(['a']);
    expect(out[0]!.endMs).toBe(15_000);
  });

  it('单调匹配避免错配到更早的重复短语', () => {
    const dup: SrtEntry[] = [
      { index: 1, startMs: 0, endMs: 5_000, text: '关键指标很重要。' },
      { index: 2, startMs: 5_000, endMs: 10_000, text: '我们先讲别的内容。' },
      { index: 3, startMs: 10_000, endMs: 15_000, text: '关键指标再次出现这里。' },
    ];
    const out = anchorSegmentsToTranscript(
      [
        seg({ id: 'first', startMs: 0, transcriptExcerpt: '关键指标很重要' }),
        seg({ id: 'mid', startMs: 5_000, transcriptExcerpt: '我们先讲别的内容' }),
        seg({ id: 'later', startMs: 10_000, transcriptExcerpt: '关键指标再次出现这里' }),
      ],
      dup,
    );
    // later 段虽含"关键指标"，但单调游标保证它锚到第 3 条（10_000）而非第 1 条
    expect(out.find((s) => s.id === 'later')!.startMs).toBe(10_000);
  });
});

describe('generateAnimationDirection', () => {
  const segment = { id: 'seg-1', title: '增长拐点', summary: '讲三组数据', startMs: 0, endMs: 8000, transcriptExcerpt: '今年用户翻倍', visualType: 'motion' } as any;
  const entries = [
    { index: 1, startMs: 0, endMs: 2000, text: '今年用户翻倍' },
    { index: 2, startMs: 2000, endMs: 4000, text: '硕士28842人' },
  ] as any;
  it('renders cards.animation prompt and returns trimmed model text', async () => {
    const generateText = vi.fn().mockResolvedValue('  视觉母题：折线\n拍1 ｜ 入场 ｜ ...  ');
    const result = await generateAnimationDirection(entries, { summary: '总结', keywords: ['增长'], globalPrompt: '' }, segment, {} as any, { generateText, projectBindings: undefined });
    expect(result).toBe('视觉母题：折线\n拍1 ｜ 入场 ｜ ...');
    const userMessage = generateText.mock.calls[0][2] as string;
    expect(userMessage).toContain('增长拐点');
    expect(userMessage).toContain('今年用户翻倍');
  });
});

// 旧的 autoAnimationDirection 直连 LLM 路径已移除：导演提示词经 ctx.buildDirectorPrompt 暴露给
// 多 agent provider（重试/修复循环见 tests/motion-agent-run.test.ts），这里只测上下文契约。
describe('generateCardForSegment motion agent context', () => {
  const baseEntries = [{ index: 1, startMs: 0, endMs: 2000, text: '今年用户翻倍' }] as any;
  const segment = { id: 's1', title: 'T', summary: 'S', startMs: 0, endMs: 2000, transcriptExcerpt: '今年用户翻倍', visualType: 'motion' } as any;
  const planning = { summary: 'S', keywords: [], globalPrompt: '' };
  const MINIMAL_TSX = 'export default function Card(){return null}';

  it('exposes prompt builders and writes the provider-returned animationDirection to the card', async () => {
    const generateMotionCard = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: MINIMAL_TSX, animationDirection: '拍1｜入场｜数字翻牌' });

    const card = await generateCardForSegment(baseEntries, planning, segment, settings, {
      generateMotionCard,
      visualType: 'motion',
      projectBindings: undefined,
    });

    const ctx = generateMotionCard.mock.calls[0]![0];
    // 导演任务书（cards.animation v5）要求设计 JSON 分镜
    expect(ctx.buildDirectorPrompt()).toContain('分镜');
    expect(ctx.buildDirectorPrompt()).toContain('data-hero');
    // 导演产出的分镜注入 cards.segment 的 {{animationDirection}}
    expect(ctx.buildCardPrompt('{"claim":"测试分镜"}')).toContain('测试分镜');
    // cue 越界校验所需的句数与运行时 cues 一致
    expect(ctx.cueCount).toBeGreaterThan(0);
    expect(ctx.animationDirectionDraft).toBeUndefined();
    expect(card.animationDirection).toBe('拍1｜入场｜数字翻牌');
  });

  it('passes the caller animationDirection as draft and falls back to it when the provider returns none', async () => {
    const generateMotionCard = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: MINIMAL_TSX });

    const card = await generateCardForSegment(baseEntries, planning, segment, settings, {
      generateMotionCard,
      visualType: 'motion',
      animationDirection: ' 拍1｜草案 ',
      projectBindings: undefined,
    });

    expect(generateMotionCard.mock.calls[0]?.[0]?.animationDirectionDraft).toBe('拍1｜草案');
    expect(card.animationDirection).toBe('拍1｜草案');
  });

  it('hands validateMotionSource through as ctx.validate (provider decides when to call it)', async () => {
    const validateMotionSource = vi.fn();
    const generateMotionCard = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: MINIMAL_TSX });

    await generateCardForSegment(baseEntries, planning, segment, settings, {
      generateMotionCard,
      validateMotionSource,
      visualType: 'motion',
      projectBindings: undefined,
    });

    expect(generateMotionCard.mock.calls[0]?.[0]?.validate).toBe(validateMotionSource);
    expect(validateMotionSource).not.toHaveBeenCalled();
  });
});

describe('buildCoverPromptRegenerationPrompt', () => {
  it('workTitle 注入 {{title}}；缺省渲染为"无"', () => {
    const withTitle = buildCoverPromptRegenerationPrompt({ workTitle: '爆款标题X' });
    expect(withTitle).toContain('爆款标题X');
    const withoutTitle = buildCoverPromptRegenerationPrompt({});
    expect(withoutTitle).toContain('本期作品标题');
    expect(withoutTitle).toMatch(/本期作品标题[\s\S]{0,80}无/);
  });
});
