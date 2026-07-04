import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPT_YAML } from '../src/lib/prompts/defaults';
import { getStyleFacetBlock, getMotionTokensBlock, getMotionStyleNotes } from '../src/lib/card-style';
import { listStylePresets } from '../src/lib/card-style-presets';
import {
  buildSegmentCardPrompt,
  buildCoverPromptRegenerationPrompt,
} from '../src/lib/ai-analysis';
import type { AISegment } from '../src/types/ai';

const PRESET_IDS = [
  'editorial-eink',
  'swiss-grid',
  'nyt-data',
  'cyber-glitch',
  'film-leak',
  'hand-sketch',
  'soft-apple',
  'dark-graph',
  'xhs-pastel',
  'mono-bold',
];

describe('提示词风格占位符', () => {
  it('cards.segment 含 tokens 占位符（motion 散文已结构化）', () => {
    expect(DEFAULT_PROMPT_YAML['cards.segment']).toContain('{{presetMotionTokens}}');
    expect(DEFAULT_PROMPT_YAML['cards.segment']).toContain('{{presetStyleNotes}}');
  });
  it('cover.regeneration / card.image 仍用 styleSystemBlock 散文块', () => {
    expect(DEFAULT_PROMPT_YAML['cover.regeneration']).toContain('{{styleSystemBlock}}');
    expect(DEFAULT_PROMPT_YAML['card.image']).toContain('{{styleSystemBlock}}');
  });
});

describe('全部预设的 motionTokens 结构合法', () => {
  const AMBIENTS = ['none', 'grid', 'orbs', 'hairline', 'grain'];
  const CAMERAS = ['push', 'pull', 'pan', 'still'];
  const SURFACES = ['none', 'glass', 'panel'];
  const EASINGS = ['crisp', 'calm', 'bouncy'];
  const EMPHASES = ['settle', 'brighten', 'underline', 'none'];

  it('10 个预设全部定义 motionTokens，palette/fonts 完整', () => {
    const presets = listStylePresets();
    expect(presets).toHaveLength(10);
    for (const p of presets) {
      expect(p.motionTokens, p.id).toBeDefined();
      const t = p.motionTokens!;
      for (const key of ['bg', 'ink', 'muted', 'accent'] as const) {
        expect(t.palette[key], `${p.id}.palette.${key}`).toBeTruthy();
      }
      expect(t.fonts.display, p.id).toBeTruthy();
      expect(t.fonts.body, p.id).toBeTruthy();
      expect(t.fonts.mono, p.id).toBeTruthy();
    }
  });

  it('枚举字段取值合法', () => {
    for (const p of listStylePresets()) {
      const t = p.motionTokens!;
      if (t.ambient) expect(AMBIENTS, `${p.id}.ambient`).toContain(t.ambient.kind);
      if (t.camera) expect(CAMERAS, `${p.id}.camera`).toContain(t.camera.mode);
      if (t.surface) expect(SURFACES, `${p.id}.surface`).toContain(t.surface.kind);
      if (t.persona?.easing) expect(EASINGS, `${p.id}.easing`).toContain(t.persona.easing);
      if (t.persona?.emphasis) expect(EMPHASES, `${p.id}.emphasis`).toContain(t.persona.emphasis);
      if (t.camera?.range) {
        const [a, b] = t.camera.range;
        // 有界摄影机 ±2%（容差吸收浮点误差）：由 tokens 数据约束
        expect(Math.abs(1 - a), `${p.id}.camera.range`).toBeLessThanOrEqual(0.0201);
        expect(Math.abs(b - 1), `${p.id}.camera.range`).toBeLessThanOrEqual(0.0201);
      }
      if (t.ambient?.opacity) {
        expect(t.ambient.opacity[1], `${p.id}.ambient.opacity`).toBeLessThanOrEqual(0.3);
      }
    }
  });

  it('facets 不再携带 motion 散文', () => {
    for (const p of listStylePresets()) {
      expect(p.facets.motion, p.id).toBeUndefined();
    }
  });
});

describe('tokens 注入函数', () => {
  it('getMotionTokensBlock 返回可解析 JSON 且含 palette', () => {
    for (const id of PRESET_IDS) {
      const block = getMotionTokensBlock(id);
      const parsed = JSON.parse(block) as { palette?: { accent?: string } };
      expect(parsed.palette?.accent, id).toBeTruthy();
    }
  });

  it('未知预设回退默认 editorial-eink tokens', () => {
    expect(getMotionTokensBlock('no-such-preset')).toBe(getMotionTokensBlock('editorial-eink'));
  });

  it('getStyleFacetBlock 的 motion 请求兼容返回 tokens JSON（旧自定义模板）', () => {
    expect(getStyleFacetBlock('editorial-eink', 'motion')).toContain('"accent"');
  });

  it('getMotionStyleNotes 有预设专属提示时带前缀，无则空', () => {
    const withNotes = getMotionStyleNotes('dark-graph');
    expect(withNotes).toContain('风格专属提示');
  });

  it('cover facet 保持散文不受影响', () => {
    expect(getStyleFacetBlock('editorial-eink', 'cover')).toContain('缩略图');
    expect(getStyleFacetBlock('dark-graph', 'cover')).toContain('图谱');
  });
});

describe('build 函数注入', () => {
  const segment: AISegment = {
    id: 'seg-1',
    title: '示例段落',
    summary: '示例段落摘要',
    startMs: 0,
    endMs: 3_000,
    transcriptExcerpt: '示例逐字稿',
  };

  it('cards.segment 注入 kit API 摘要与默认 tokens', () => {
    const prompt = buildSegmentCardPrompt({
      programContext: '节目摘要：测试',
      segment,
    });
    expect(prompt).toContain('useBeats');
    expect(prompt).toContain('CardStage');
    expect(prompt).toContain('"accent": "#0A84FF"');
  });

  it('cards.segment 按 stylePresetId 注入对应 tokens', () => {
    const prompt = buildSegmentCardPrompt({
      programContext: '节目摘要：测试',
      segment,
      stylePresetId: 'dark-graph',
    });
    expect(prompt).toContain('#7C5CFF');
    expect(prompt).toContain('风格专属提示');
  });

  it('cover.regeneration 默认注入 editorial-eink cover 散文块', () => {
    const prompt = buildCoverPromptRegenerationPrompt({});
    expect(prompt).toContain('缩略图');
  });
});
