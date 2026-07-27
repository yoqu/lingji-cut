import { describe, expect, it } from 'vitest';
import {
  isAICardType,
  isMediaContent,
  isMediaCardType,
  normalizeAICardType,
  buildAICardOverlayData,
  type AICard,
  type MediaCardContent,
} from '../src/types/ai';
import { PROMPT_KINDS, isPromptKind } from '../src/lib/prompts/types';

describe('cards.animation prompt kind', () => {
  it('registers cards.animation as a valid prompt kind', () => {
    expect(PROMPT_KINDS).toContain('cards.animation');
    expect(isPromptKind('cards.animation')).toBe(true);
  });
});

describe('AICardType extension', () => {
  it('仅 motion/image/video 是合法的 AICardType', () => {
    expect(isAICardType('motion')).toBe(true);
    expect(isAICardType('image')).toBe(true);
    expect(isAICardType('video')).toBe(true);
    expect(isAICardType('summary')).toBe(false);
    expect(isAICardType('foo')).toBe(false);
  });

  it('normalizeAICardType 把旧文字分类迁移为 motion', () => {
    for (const legacy of ['summary', 'data', 'insight', 'chapter', 'quote']) {
      expect(normalizeAICardType(legacy)).toBe('motion');
    }
    expect(normalizeAICardType('image')).toBe('image');
    expect(normalizeAICardType('foo')).toBe(null);
  });

  it('isMediaCardType 仅对 image/video 为 true', () => {
    expect(isMediaCardType('image')).toBe(true);
    expect(isMediaCardType('video')).toBe(true);
    expect(isMediaCardType('motion')).toBe(false);
  });

  it('isMediaContent 检测 mediaType + aspectRatio + generationStatus', () => {
    const valid: MediaCardContent = {
      mediaType: 'image',
      assetPath: null,
      aspectRatio: '16:9',
      prompt: 'hello',
      providerId: null,
      model: null,
      generationStatus: 'idle',
    };
    expect(isMediaContent(valid)).toBe(true);
    expect(isMediaContent('plain string')).toBe(false);
    expect(isMediaContent({ mediaType: 'image' })).toBe(false);
  });

  it('buildAICardOverlayData 透传 MediaCardContent 不丢字段', () => {
    const card: AICard = {
      id: 'c1',
      segmentId: 's1',
      type: 'video',
      title: 'demo',
      content: {
        mediaType: 'video',
        assetPath: 'ai-cards/c1/video.mp4',
        posterPath: 'ai-cards/c1/poster.jpg',
        mediaDurationMs: 6000,
        aspectRatio: '16:9',
        prompt: 'a cat',
        providerId: 'vidu-default',
        model: 'vidu-2',
        generationStatus: 'ready',
        generatedAt: 1,
      },
      startMs: 0,
      endMs: 6000,
      displayDurationMs: 6000,
      displayMode: 'fullscreen',
      template: 'video-default',
      enabled: true,
      style: { primaryColor: '#fff', backgroundColor: '#000', fontSize: 48 },
    };
    const overlay = buildAICardOverlayData(card);
    expect(overlay.cardType).toBe('video');
    expect(overlay.content).toEqual(card.content);
  });
});
