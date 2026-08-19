import { describe, expect, it, vi } from 'vitest';
import {
  analyzeSrt,
  anchorSegmentsToTranscript,
  buildCoverPromptRegenerationPrompt,
  buildMotionBiblePrompt,
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
import { getBuiltinPromptTemplate } from '../src/lib/prompts';

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

  it('always appends the effective director rules without requiring a template variable', () => {
    const prompt = buildSegmentPlanningPrompt(undefined, undefined, {
      name: 'production.director',
      user: '自定义规则：章节转场必须克制，声音提示每分钟不超过 3 次。',
    });

    expect(prompt).toContain('【可配置导演制作规则】');
    expect(prompt).toContain('声音提示每分钟不超过 3 次');
  });
});

describe('buildMotionBiblePrompt', () => {
  it('injects the same effective director rules into the whole-film strategy', () => {
    const prompt = buildMotionBiblePrompt(
      {
        segments: [baseSegment, secondSegment],
        summary: '节目总结',
        keywords: ['AI', '播客'],
        globalPrompt: '',
      },
      undefined,
      {
        name: 'production.director',
        user: '自定义规则：每帧只允许一个主视觉焦点。',
      },
    );

    expect(prompt).toContain('【可配置导演制作规则】');
    expect(prompt).toContain('每帧只允许一个主视觉焦点');
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

  it('workTitle 注入 {{title}}；缺省渲染为"无"', () => {
    const withTitle = buildCoverPromptRegenerationPrompt({ workTitle: '爆款标题X' });
    expect(withTitle).toContain('爆款标题X');
    const withoutTitle = buildCoverPromptRegenerationPrompt({});
    expect(withoutTitle).toContain('本期作品标题');
    expect(withoutTitle).toMatch(/本期作品标题[\s\S]{0,80}无/);
  });
});

describe('planTranscriptSegments', () => {
  it('plans segments from the full transcript', async () => {
    const modelCaller = vi.fn<typeof generateStructuredData>().mockResolvedValue({
      segments: [baseSegment, secondSegment],
      title: 'AI视频工作流怎么拆',
      coverPrompts: ['商业分析封面，画面主标题“另一个标题”'],
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
    expect(result.title).toBe('AI视频工作流怎么拆');
    expect(result.coverPrompts).toEqual(['商业分析封面，画面主标题“AI视频工作流怎么拆”']);
    expect(result.summary).toBe('节目总结');
    expect(result.keywords).toEqual(['AI', '播客']);
    expect(modelCaller).toHaveBeenCalledTimes(1);
    expect(modelCaller.mock.calls[0]?.[2]).toBe(fullTranscript);
  });

  it('derives a non-empty work intro when an older planning override omits top-level summary', async () => {
    const modelCaller = vi.fn<typeof generateStructuredData>().mockResolvedValue({
      segments: [baseSegment, secondSegment],
      title: 'AI视频工作流怎么拆',
      coverPrompts: ['商业分析封面，画面主标题“AI视频工作流怎么拆”'],
      keywords: ['AI', '播客'],
    });

    const result = await planTranscriptSegments(baseEntries, settings, {
      generateStructuredData: modelCaller,
    });

    expect(result.summary).toBe(`${baseSegment.summary}；${secondSegment.summary}`);
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

    expect(result.segments).toHaveLength(30);
    expect(result.segments.every((segment) => segment.endMs - segment.startMs <= 10_000)).toBe(
      true,
    );
    expect(result.segments.map((segment) => segment.id)).toEqual(
      Array.from({ length: 30 }, (_, index) => `long-seg-part-${index + 1}`),
    );
    expect(result.segments[0]?.title).toBe('超长主题（1/30）');
    expect(result.segments[0]?.summary).toContain('第 1/30 小节');
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
      .mockResolvedValue({
        tsx: VALID_MOTION_TSX,
        productionReport: {
          status: 'acceptable',
          generatedAt: 123,
          framesChecked: [0, 75, 149],
          lintIssues: [{ severity: 'warning', source: 'lint', code: 'cues-unused', message: '未使用 cues' }],
          layoutIssues: [],
          reviewIssues: [],
          fallbackUsed: false,
          fixRounds: 1,
          reviewRounds: 0,
          renderOk: true,
        },
      });

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
    expect(result.motionCard?.productionReport).toMatchObject({
      status: 'acceptable',
      framesChecked: [0, 75, 149],
      fixRounds: 1,
    });
    expect(motionCaller).toHaveBeenCalledTimes(1);
    // ctx.segmentTranscript = 段内逐字稿；buildCardPrompt 渲染 cards.segment 提示词，提及当前段
    const ctx = motionCaller.mock.calls[0]![0];
    expect(ctx.segmentTranscript).toContain('欢迎收听本期节目');
    expect(ctx.buildCardPrompt(undefined)).toContain('AI 视频生产背景');
  });

  it('routes image-shaped agent composites through the Motion Agent with the frozen composition brief', async () => {
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX });
    const imagePromptCaller = vi.fn().mockResolvedValue('不应调用');
    const compositionInputs = [{
      segmentIndex: 0,
      segmentId: baseSegment.id,
      startMs: baseSegment.startMs,
      durationMs: baseSegment.endMs - baseSegment.startMs,
      usage: 'required' as const,
      trimStartMs: 1_200,
      asset: {
        id: 'approved-image',
        filename: 'approved.png',
        path: '/private/library/approved.png',
        kind: 'image' as const,
        score: 0.98,
      },
    }];

    const result = await generateCardForSegment(
      baseEntries,
      { summary: '节目总结', keywords: ['AI'], globalPrompt: '' },
      { ...baseSegment, visualType: 'image' },
      settings,
      {
        generateMotionCard: motionCaller,
        generateText: imagePromptCaller,
        visualType: 'image',
        renderStrategy: 'agent-composite',
        compositionIntent: {
          narrativeGoal: '用真实产品图证明长期积累',
          focalPriority: '产品图先于数字',
          temporalRelationship: '先全幅素材，再叠加结论',
          mustShow: ['产品图', '世界第91位'],
          avoid: ['固定画中画'],
        },
        compositionInputs,
        cardTemplate: { name: 'test-card', user: '{{compositionContract}}\n{{assetContext}}' },
        animationTemplate: { name: 'test-director', user: '{{compositionContract}}' },
      },
    );

    expect(result.type).toBe('motion');
    expect(result.renderStrategy).toBe('agent-composite');
    expect(imagePromptCaller).not.toHaveBeenCalled();
    const ctx = motionCaller.mock.calls[0]![0];
    expect(ctx.motionCardMode).toBe('agent');
    expect(ctx.compositionInputs).toEqual(compositionInputs);
    expect(ctx.buildDirectorPrompt()).toContain('用真实产品图证明长期积累');
    expect(ctx.buildDirectorPrompt()).toContain('assetId=approved-image');
    const cardPrompt = ctx.buildCardPrompt(undefined, [{
      slot: 'media-1',
      assetId: 'approved-image',
      filePath: '/private/library/approved.png',
      kind: 'image',
      usage: 'required',
      required: true,
      treatment: {
        profile: 'technical-product',
        lighting: 'neutral',
        palette: 'source',
        shadow: 'none',
        perspective: 'source',
      },
      placement: { x: 12, y: 18, width: 60 },
    }]);
    expect(cardPrompt).toContain('BoundMedia');
    expect(cardPrompt).toContain('usage=required');
    expect(cardPrompt).not.toContain('/private/library/approved.png');
    expect(cardPrompt).not.toContain('suggestedPlacement');
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

    expect(planningCaller).toHaveBeenCalledTimes(2);
    expect(planningCaller.mock.calls[0]?.[1]).toContain('segments');
    expect(planningCaller.mock.calls[1]?.[1]).toContain('Motion Bible');
    expect(motionCaller).toHaveBeenCalledTimes(2);
    expect(motionCaller.mock.calls[0]?.[0]?.buildCardPrompt(undefined)).toContain('AI 视频生产背景');
    expect(motionCaller.mock.calls[0]?.[0]?.buildCardPrompt(undefined)).toContain('Motion Bible');
    expect(motionCaller.mock.calls[1]?.[0]?.buildCardPrompt(undefined)).toContain('工作流拆分');
    expect(result.segments).toHaveLength(2);
    expect(result.cards).toHaveLength(2);
    expect(result.cards.map((card) => card.segmentId)).toEqual(['seg-1', 'seg-2']);
    expect(result.cards[0]?.renderMode).toBe('motion-card');
    expect(result.cards[0]?.motionCard?.tsx).toContain('export default');
    expect(result.cards[1]?.motionCard?.tsx).toContain('export default');
    expect(result.coverPrompts).toEqual(['封面提示词']);
    expect(result.motionBible?.carrierPlan).toHaveLength(2);
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

    expect(planningCaller).toHaveBeenCalledTimes(2);
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

    expect(result.segments).toHaveLength(30);
    expect(result.cards).toHaveLength(30);
    expect(result.cards.map((card) => card.segmentId)).toEqual(
      Array.from({ length: 30 }, (_, index) => `long-seg-part-${index + 1}`),
    );
    expect(planningCaller).toHaveBeenCalledTimes(2);
    expect(motionCaller).toHaveBeenCalledTimes(30);
  });

  it('generateWorkTitle 结果注入内部 cover.regeneration 调用的 {{title}}', async () => {
    const structuredCaller = vi
      .fn<typeof generateStructuredData>()
      .mockResolvedValueOnce({
        segments: [baseSegment],
        coverPrompts: ['规划兜底封面'],
        summary: '节目总结',
        keywords: ['AI'],
        globalPrompt: '',
      })
      .mockResolvedValueOnce({
        visualThesis: '统一整片信息动效',
        rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
        carrierPlan: [{ segmentId: 'seg-1', preferredCarrier: 'data-hero', intensity: 2, reason: '核心段' }],
        styleRules: { paletteUse: '沿用 tokens', typographyUse: '数字重' },
        transitionRules: { default: 'crossfade', matchCutCandidates: [] },
      })
      .mockResolvedValueOnce({ coverPrompt: '带标题的封面提示词' });
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX });
    const generateWorkTitle = vi.fn().mockResolvedValue('爆款标题X');
    const onCoverPromptsReady = vi.fn();

    await analyzeSrt(baseEntries, settings, {
      generateStructuredData: structuredCaller,
      generateMotionCard: motionCaller,
      coverTemplate: getBuiltinPromptTemplate('cover.regeneration'),
      onCoverPromptsReady,
      generateWorkTitle,
    });

    expect(generateWorkTitle).toHaveBeenCalledTimes(1);
    expect(generateWorkTitle.mock.calls[0][0].summary).toBe('节目总结');
    // 第三次 structured 调用为 cover.regeneration，其 prompt 参数应含标题
    expect(structuredCaller).toHaveBeenCalledTimes(3);
    expect(structuredCaller.mock.calls[2]?.[1]).toContain('爆款标题X');
    expect(onCoverPromptsReady).toHaveBeenCalledWith([
      '带标题的封面提示词；画面唯一文字标题必须逐字呈现为“爆款标题X”，不得增删、缩写或改写。',
    ]);
  });

  it('generateWorkTitle 抛错时封面调用照常进行（{{title}} 为"无"）', async () => {
    const structuredCaller = vi
      .fn<typeof generateStructuredData>()
      .mockResolvedValueOnce({
        segments: [baseSegment],
        coverPrompts: ['规划兜底封面'],
        summary: '节目总结',
        keywords: ['AI'],
        globalPrompt: '',
      })
      .mockResolvedValueOnce({
        visualThesis: '统一整片信息动效',
        rhythm: { density: 'balanced', heavySegments: [], quietSegments: [] },
        carrierPlan: [{ segmentId: 'seg-1', preferredCarrier: 'data-hero', intensity: 2, reason: '核心段' }],
        styleRules: { paletteUse: '沿用 tokens', typographyUse: '数字重' },
        transitionRules: { default: 'crossfade', matchCutCandidates: [] },
      })
      .mockResolvedValueOnce({ coverPrompt: '无标题封面提示词' });
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX });

    await analyzeSrt(baseEntries, settings, {
      generateStructuredData: structuredCaller,
      generateMotionCard: motionCaller,
      coverTemplate: getBuiltinPromptTemplate('cover.regeneration'),
      onCoverPromptsReady: vi.fn(),
      generateWorkTitle: vi.fn().mockRejectedValue(new Error('LLM 超时')),
    });

    expect(structuredCaller).toHaveBeenCalledTimes(3);
    expect(structuredCaller.mock.calls[2]?.[1]).not.toContain('爆款标题X');
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

  it('programmatically keeps the generated cover title identical to the director title', async () => {
    const modelCaller = vi.fn().mockResolvedValue({
      coverPrompts: ['财经封面，主标题“截短后的标题”，人物居右'],
    });

    const result = await regenerateCoverPrompt(baseEntries, settings, {
      generateStructuredData: modelCaller,
      workTitle: '世界第91位不是突然发生的',
    });

    expect(result).toEqual(['财经封面，主标题“世界第91位不是突然发生的”，人物居右']);
    expect(result[0]).not.toContain('截短后的标题');
  });

  it('replaces a stale unquoted cover title instead of leaving conflicting text', async () => {
    const modelCaller = vi.fn().mockResolvedValue({
      coverPrompts: ['财经封面，主标题：旧标题，人物居右'],
    });

    const result = await regenerateCoverPrompt(baseEntries, settings, {
      generateStructuredData: modelCaller,
      workTitle: '世界第91位不是突然发生的',
    });

    expect(result).toEqual(['财经封面，主标题：“世界第91位不是突然发生的”，人物居右']);
    expect(result[0]).not.toContain('旧标题');
  });

  it('uses cover.regeneration LLM binding without requiring an image provider', async () => {
    const modelCaller = vi.fn().mockResolvedValue({
      coverPrompts: ['绑定后的封面提示词'],
    });
    const boundSettings = {
      llmProviders: [{
        id: 'P',
        name: 'doubao',
        type: 'openai_compatible' as const,
        baseUrl: 'https://example.test/v1',
        apiKey: 'k',
        models: ['turbo', 'code'],
      }],
      defaultProviderId: 'P',
      defaultModel: 'code',
      promptBindings: {
        'cover.regeneration': { providerId: 'P', model: 'turbo' },
      },
    } as AISettings;

    await regenerateCoverPrompt(baseEntries, boundSettings, {
      generateStructuredData: modelCaller,
      projectBindings: null,
    });

    expect(modelCaller.mock.calls[0]?.[3]).toMatchObject({ model: 'turbo' });
    expect(modelCaller.mock.calls[0]?.[4]).toMatchObject({ label: 'cover.regeneration' });
  });

  it('keeps quoted typography attributes intact while replacing the visible title', async () => {
    const modelCaller = vi.fn().mockResolvedValue({
      coverPrompts: [
        '画面主标题“旧标题”，标题字体“思源黑体”，标题颜色“#FFFFFF”，节目标题字号“画面高度10%”',
      ],
    });

    const result = await regenerateCoverPrompt(baseEntries, settings, {
      generateStructuredData: modelCaller,
      workTitle: '世界第91位不是突然发生的',
    });

    expect(result).toEqual([
      '画面主标题“世界第91位不是突然发生的”，标题字体“思源黑体”，标题颜色“#FFFFFF”，节目标题字号“画面高度10%”',
    ]);
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
    const ctx = motionCaller.mock.calls[0]?.[0];
    expect(ctx?.existingTsx).toBeUndefined();
    expect(ctx?.animationDirectionDraft).toBeUndefined();
    expect(ctx?.buildCardPrompt(undefined)).not.toContain('旧标题');
    expect(ctx?.buildCardPrompt(undefined)).not.toContain('旧内容');
    expect(result.id).toBe('card-1');
    expect(result.segmentId).toBe('seg-1');
    // 元信息从既有卡片延续（不再由模型决定）
    expect(result.title).toBe('旧标题');
    expect(result.displayDurationMs).toBe(5_000);
    expect(result.renderMode).toBe('motion-card');
    expect(result.motionCard?.tsx).toContain('export default');
  });

  it('keeps the approved composite strategy in the Motion Agent context', async () => {
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX });
    const compositionIntent = {
      narrativeGoal: '真实画面与观点同时成立',
      focalPriority: '真实画面优先',
      temporalRelationship: '素材先入，结论后落',
      mustShow: ['真实素材'],
      avoid: ['纯文字替代'],
    };
    const compositionInputs = [{
      segmentIndex: 0,
      segmentId: baseSegment.id,
      startMs: 0,
      durationMs: 3_000,
      usage: 'required' as const,
      asset: {
        id: 'approved-video',
        filename: 'approved.mp4',
        path: '/library/approved.mp4',
        kind: 'video' as const,
        score: 0.98,
      },
    }];

    const result = await regenerateAICard(baseEntries, baseCard, baseSegment, settings, {
      generateMotionCard: motionCaller,
      renderStrategy: 'agent-composite',
      compositionIntent,
      compositionInputs,
      fallbackPolicy: 'block',
    });

    expect(motionCaller.mock.calls[0]?.[0]).toMatchObject({
      renderStrategy: 'agent-composite',
      compositionIntent,
      compositionInputs,
      fallbackPolicy: 'block',
      motionCardMode: 'agent',
    });
    expect(result.renderStrategy).toBe('agent-composite');
  });

  it('records previous storyboard and tsx in motion history when regenerating', async () => {
    const storyboard = {
      claim: '旧分镜',
      carrier: 'concept',
      scene: '旧场景',
      focus: { beat: 0, emphasis: 'brighten' },
      beats: [{ cue: null, kind: 'build', adds: '旧标题' }],
    };
    const cardWithMotion: AICard = {
      ...baseCard,
      renderMode: 'motion-card',
      animationDirection: JSON.stringify(storyboard),
      motionCard: {
        tsx: VALID_MOTION_TSX,
        compiledAt: 1,
        prompt: 'old',
        retryCount: 0,
        storyboard: storyboard as never,
      },
    };
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX.replace('摘要卡', '新版卡') });

    const result = await regenerateAICard(baseEntries, cardWithMotion, baseSegment, settings, {
      generateMotionCard: motionCaller,
      animationDirection: JSON.stringify(storyboard),
    });

    expect(result.motionCard?.storyboardHistory).toHaveLength(1);
    expect(result.motionCard?.storyboardHistory?.[0]?.storyboard?.claim).toBe('旧分镜');
    expect(result.motionCard?.storyboardHistory?.[0]?.tsx).toContain('摘要卡');
    expect(result.motionCard?.storyboardHistory?.[0]?.tsxHash).toBeTruthy();
  });

  it('only exposes the previous motion card to agents in explicit refine mode', async () => {
    const storyboard = {
      claim: '旧分镜',
      carrier: 'concept',
      scene: '旧场景',
      focus: { beat: 0, emphasis: 'brighten' },
      beats: [{ cue: null, kind: 'build', adds: '旧标题' }],
    };
    const cardWithMotion: AICard = {
      ...baseCard,
      animationDirection: JSON.stringify(storyboard),
      motionCard: {
        tsx: VALID_MOTION_TSX,
        compiledAt: 1,
        prompt: 'old',
        retryCount: 0,
        storyboard: storyboard as never,
      },
    };
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX });

    await regenerateAICard(baseEntries, cardWithMotion, baseSegment, settings, {
      generateMotionCard: motionCaller,
      refineExistingMotion: true,
    });

    const ctx = motionCaller.mock.calls[0]?.[0];
    expect(ctx?.existingTsx).toBe(VALID_MOTION_TSX);
    expect(ctx?.animationDirectionDraft).toContain('旧分镜');
    expect(ctx?.buildCardPrompt(undefined)).toContain('旧标题');
    expect(ctx?.buildCardPrompt(undefined)).toContain('旧内容');
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
  const segment = { id: 'seg-1', title: '增长拐点', summary: '讲三组数据', startMs: 0, endMs: 8000, transcriptExcerpt: '今年用户翻倍', semanticType: 'data', visualType: 'motion' } as any;
  const entries = [
    { index: 1, startMs: 0, endMs: 2000, text: '今年用户翻倍' },
    { index: 2, startMs: 2000, endMs: 4000, text: '硕士28842人' },
  ] as any;
  it('renders cards.animation prompt and returns trimmed model text', async () => {
    const generateText = vi.fn().mockResolvedValue('  视觉母题：折线\n拍1 ｜ 入场 ｜ ...  ');
    const result = await generateAnimationDirection(entries, { summary: '总结', keywords: ['增长'], globalPrompt: '' }, segment, {} as any, { generateText, stylePresetId: 'nyt-data', projectBindings: undefined });
    expect(result).toBe('视觉母题：折线\n拍1 ｜ 入场 ｜ ...');
    const userMessage = generateText.mock.calls[0][2] as string;
    expect(userMessage).toContain('增长拐点');
    expect(userMessage).toContain('今年用户翻倍');
    expect(userMessage).toContain('trend > data-hero > comparison');
  });

  it('includes the frozen composite inputs and approved fallback in the storyboard prompt', async () => {
    const generateText = vi.fn().mockResolvedValue('{"claim":"长期积累"}');
    await generateAnimationDirection(
      entries,
      { summary: '总结', keywords: ['增长'], globalPrompt: '' },
      segment,
      {} as any,
      {
        generateText,
        renderStrategy: 'agent-composite',
        compositionIntent: {
          narrativeGoal: '真实榜单与五年积累共同完成论证',
          focalPriority: '榜单原图优先',
          temporalRelationship: '先建立事实，再汇聚观点',
          mustShow: ['榜单原图', '长期积累'],
          avoid: ['纯文字替代'],
        },
        compositionInputs: [{
          segmentIndex: 0,
          segmentId: segment.id,
          startMs: 0,
          durationMs: 8_000,
          usage: 'required',
          trimStartMs: 0,
          fileFingerprint: 'stat:100:200',
          asset: {
            id: 'approved-ranking',
            filename: 'ranking.jpg',
            path: '/library/ranking.jpg',
            kind: 'image',
            score: 0.99,
          },
        }],
        fallbackPolicy: 'block',
        projectBindings: undefined,
      },
    );

    const userMessage = generateText.mock.calls[0][2] as string;
    expect(userMessage).toContain('执行策略：Agent 原子合成镜头');
    expect(userMessage).toContain('assetId=approved-ranking');
    expect(userMessage).toContain('失败退路：block');
    expect(userMessage).not.toContain('/library/ranking.jpg');
  });
});

// 旧的 autoAnimationDirection 直连 LLM 路径已移除：导演提示词经 ctx.buildDirectorPrompt 暴露给
// 多 agent provider（重试/修复循环见 tests/motion-agent-run.test.ts），这里只测上下文契约。
describe('generateCardForSegment motion agent context', () => {
  const baseEntries = [{ index: 1, startMs: 0, endMs: 2000, text: '今年用户翻倍' }] as any;
  const segment = { id: 's1', title: 'T', summary: 'S', startMs: 0, endMs: 2000, transcriptExcerpt: '今年用户翻倍', semanticType: 'data', visualType: 'motion' } as any;
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
    expect(ctx.reviewStyleBlock).toContain('禁用清单');
    expect(ctx.reviewContentTypeBlock).toContain('本段内容类型：data');
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
