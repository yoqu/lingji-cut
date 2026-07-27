import { describe, expect, it, vi } from 'vitest';
import { generateSingleCardFromSubtitles } from '../src/lib/ai-analysis';
import type { MotionCardAgentProvider } from '../src/lib/ai-analysis';
import type { SrtEntry } from '../src/types';
import type { AISettings } from '../src/types/ai';

const settings: AISettings = {
  llmBaseUrl: 'https://api.openai.com/v1',
  llmApiKey: 'sk-test',
  llmModel: 'gpt-4o-mini',
} as AISettings;

const entries: SrtEntry[] = [
  { index: 1, startMs: 0, endMs: 1_500, text: '第一条字幕。' },
  { index: 2, startMs: 1_500, endMs: 3_000, text: '第二条字幕，比较重要。' },
];

const VALID_MOTION_TSX = `import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
export default function MotionCard() {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ opacity }}>摘要卡</AbsoluteFill>;
}`;

describe('generateSingleCardFromSubtitles', () => {
  it('returns a single compiled motion-card and forces timing from draft', async () => {
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX });

    const card = await generateSingleCardFromSubtitles(
      entries,
      {
        text: '手动选段文本',
        startMs: 500,
        endMs: 3_000,
        displayDurationMs: 2_500,
        type: 'motion',
        preferredCarrier: 'data-hero',
        promptHint: '突出核心数字',
      },
      settings,
      { generateMotionCard: motionCaller },
    );

    expect(card.renderMode).toBe('motion-card');
    expect(card.startMs).toBe(500);
    expect(card.endMs).toBe(3_000);
    expect(card.displayDurationMs).toBe(2_500);
    expect(card.motionCard?.tsx).toContain('export default');
    expect(card.motionCard?.tsx).toContain('useCurrentFrame');
    expect(motionCaller).toHaveBeenCalledTimes(1);
    const cardPrompt = motionCaller.mock.calls[0]?.[0]?.buildCardPrompt(undefined) ?? '';
    expect(cardPrompt).toContain('突出核心数字');
    expect(cardPrompt).toContain('motion-card');
    expect(cardPrompt).toContain('data-hero');
  });

  it('rejects empty text draft', async () => {
    await expect(
      generateSingleCardFromSubtitles(
        entries,
        {
          text: '   ',
          startMs: 0,
          endMs: 1_000,
          displayDurationMs: 1_000,
          type: 'motion',
        },
        settings,
        { generateMotionCard: vi.fn() },
      ),
    ).rejects.toThrow('字幕内容为空');
  });

  it('rejects invalid time range', async () => {
    await expect(
      generateSingleCardFromSubtitles(
        entries,
        {
          text: 'ok',
          startMs: 1_000,
          endMs: 1_000,
          displayDurationMs: 2_000,
          type: 'motion',
        },
        settings,
        { generateMotionCard: vi.fn() },
      ),
    ).rejects.toThrow('时间范围无效');
  });

  it('throws a "请重新生成" error when motion tsx has no default export', async () => {
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: 'const Card = 42;' });

    await expect(
      generateSingleCardFromSubtitles(
        entries,
        {
          text: '有效文本',
          startMs: 0,
          endMs: 2_000,
          displayDurationMs: 2_000,
          type: 'motion',
        },
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
      generateSingleCardFromSubtitles(
        entries,
        {
          text: 'AI 创作测试：国产存储周期正在被价格、产能与先进封装同时重写。',
          startMs: 0,
          endMs: 3_000,
          displayDurationMs: 3_000,
          type: 'motion',
        },
        settings,
        { generateMotionCard: motionCaller },
      ),
    ).rejects.toThrow(/motionCard/);
  });

  it('rejects when no motion agent provider is injected', async () => {
    await expect(
      generateSingleCardFromSubtitles(
        entries,
        {
          text: '有效文本',
          startMs: 0,
          endMs: 2_000,
          displayDurationMs: 2_000,
          type: 'motion',
        },
        settings,
        {},
      ),
    ).rejects.toThrow(/generateMotionCard/);
  });

  it('rejects invalid card type', async () => {
    await expect(
      generateSingleCardFromSubtitles(
        entries,
        {
          text: 'ok',
          startMs: 0,
          endMs: 1_000,
          displayDurationMs: 1_000,
          // @ts-expect-error intentional invalid
          type: 'nonsense',
        },
        settings,
        { generateMotionCard: vi.fn() },
      ),
    ).rejects.toThrow('卡片类型无效');
  });
});
