import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROMPT_YAML,
  PROMPT_KINDS,
  PROMPT_KIND_META,
  getBuiltinPromptTemplate,
  parsePromptYaml,
  renderTemplate,
  renderUserPromptWithLock,
  serializePromptYaml,
} from '../src/lib/prompts';

describe('renderTemplate', () => {
  it('replaces {{var}} placeholders', () => {
    expect(renderTemplate('hello {{name}}', { name: 'world' })).toBe('hello world');
  });

  it('replaces missing vars with empty string', () => {
    expect(renderTemplate('a={{a}}, b={{b}}', { a: 'x' })).toBe('a=x, b=');
  });

  it('handles whitespace inside braces', () => {
    expect(renderTemplate('x={{ x }}', { x: '1' })).toBe('x=1');
  });

  it('coerces non-string values', () => {
    expect(renderTemplate('count={{n}}', { n: 42 })).toBe('count=42');
  });

  it('leaves no placeholders when value contains other braces', () => {
    expect(renderTemplate('{{a}}', { a: '{{b}}' })).toBe('{{b}}');
  });
});

describe('parsePromptYaml', () => {
  it('parses a minimal valid YAML', () => {
    const { template } = parsePromptYaml(
      'name: x\nuser: |-\n  hi {{name}}\n',
      'planning.segment',
    );
    expect(template.name).toBe('x');
    expect(template.user).toBe('hi {{name}}');
  });

  it('throws when user field is missing or empty', () => {
    expect(() => parsePromptYaml('name: x\nuser: ""\n', 'planning.segment')).toThrow();
  });

  it('throws on invalid YAML', () => {
    expect(() => parsePromptYaml('::: not yaml', 'planning.segment')).toThrow();
  });
});

describe('serializePromptYaml round-trip', () => {
  it('serializes and re-parses to equivalent template', () => {
    const original = parsePromptYaml(DEFAULT_PROMPT_YAML['planning.segment'], 'planning.segment').template;
    const yamlText = serializePromptYaml(original);
    const reparsed = parsePromptYaml(yamlText, 'planning.segment').template;
    expect(reparsed.name).toBe(original.name);
    expect(reparsed.user).toBe(original.user);
  });
});

describe('PROMPT_KINDS and metadata', () => {
  it('every kind has metadata and a default YAML', () => {
    for (const kind of PROMPT_KINDS) {
      expect(PROMPT_KIND_META[kind]).toBeDefined();
      expect(DEFAULT_PROMPT_YAML[kind]).toBeTruthy();
    }
  });

  it('every default YAML parses cleanly', () => {
    for (const kind of PROMPT_KINDS) {
      const tpl = getBuiltinPromptTemplate(kind);
      expect(tpl.user).toBeTruthy();
    }
  });

  it('exposes director rules as an editable non-model prompt', () => {
    expect(PROMPT_KINDS).toContain('production.director');
    expect(PROMPT_KIND_META['production.director'].label).toBe('导演制作规则');
    expect(PROMPT_KIND_META['production.director'].supportsBinding).toBe(false);
    expect(getBuiltinPromptTemplate('production.director').user).toContain('每分钟 2-4 次');
  });
});

describe('cards.animation default template（JSON 分镜）', () => {
  it('has a builtin template mentioning 分镜 and segmentCues', () => {
    const tpl = getBuiltinPromptTemplate('cards.animation');
    expect(tpl.user).toContain('{{segmentCues}}');
    expect(tpl.user).toContain('分镜');
    expect(tpl.user).toContain('data-hero');
  });
  it('cards.segment template exposes storyboard / kit / tokens injection points', () => {
    const seg = getBuiltinPromptTemplate('cards.segment');
    expect(seg.user).toContain('{{animationDirection}}');
    expect(seg.user).toContain('{{motionKitApi}}');
    expect(seg.user).toContain('{{presetMotionTokens}}');
  });
});

describe('renderUserPromptWithLock', () => {
  it('appends lockedContract.content to user-tail when declared', () => {
    const tpl = getBuiltinPromptTemplate('script.review');
    const rendered = renderUserPromptWithLock('script.review', tpl, {
      scriptText: '这是一段测试稿件。',
    });
    expect(rendered).toContain('这是一段测试稿件。');
    expect(rendered).toContain('【系统契约 · 不可修改】');
    expect(rendered).toContain('annotations');
    expect(rendered).toContain('severity');
  });

  it('locked content is kind-specific', () => {
    const planning = renderUserPromptWithLock(
      'planning.segment',
      getBuiltinPromptTemplate('planning.segment'),
      { globalPromptLine: '' },
    );
    expect(planning).toContain('segments');
    expect(planning).toContain('semanticType');
    expect(planning).not.toContain('webCard');

    const cards = renderUserPromptWithLock(
      'cards.segment',
      getBuiltinPromptTemplate('cards.segment'),
      {
        segmentId: 's1',
        segmentTitle: '标题',
        segmentSummary: '摘要',
        segmentCues: '  [0] +0.0s 第一句',
        cardPrompt: '无',
        animationDirection: '{"claim":"x"}',
        motionKitApi: 'kit api 摘要',
        presetMotionTokens: '{ "palette": {} }',
        presetStyleNotes: '',
        currentCardSection: '当前卡片线索：无',
        programContext: '节目级浓缩上下文',
      },
    );
    // 卡片生成链路：file-first 写 motionCard.tsx + 仅允许三个模块 + 帧纯函数
    expect(cards).toContain('motionCard.tsx');
    expect(cards).toContain('export default function Card');
    expect(cards).toContain('useCurrentFrame');
    expect(cards).toContain('@lingji/motion-kit');
    expect(cards).not.toContain('webCard');
  });
});

describe('cards.segment v19 / cards.animation v5 契约', () => {
  it('cards.segment 是 kit 组合契约：技术契约 + 状态演进 + 分镜注入', () => {
    const cards = DEFAULT_PROMPT_YAML['cards.segment'];
    expect(cards).toContain('CardStage');
    expect(cards).toContain('useBeats');
    expect(cards).toContain('状态演进');
    expect(cards).toContain('MotionSlot.lifecycle');
    expect(cards).toContain('emphasis={分镜 focus.emphasis}');
    expect(cards).toContain('process / timeline 的逐项建立必须传 beats 数组');
    expect(cards).toContain('storyboard');
    // 机器可查的规则已迁出提示词（lint / kit / 布局探针承担）
    expect(cards).not.toContain('动效词汇表');
    expect(cards).not.toContain('编排三律');
  });

  it('cards.animation 是可由 Motion Kit 兑现的 JSON 分镜契约', () => {
    const anim = DEFAULT_PROMPT_YAML['cards.animation'];
    expect(anim).toContain('claim');
    expect(anim).toContain('data-hero');
    expect(anim).toContain('adds');
    expect(anim).toContain('changes');
    expect(anim).toContain('状态演进');
    expect(anim).toContain('lifecycle 只操作 elements 中的整体语义区块');
    expect(anim).toContain('不要要求内部子项换位');
    expect(anim).toContain('{{segmentCues}}');
  });

  it('cards.animation 锁定契约要求严格 JSON 输出', () => {
    const rendered = renderUserPromptWithLock(
      'cards.animation',
      getBuiltinPromptTemplate('cards.animation'),
      { segmentCues: '  [0] +0.0s 第一句' },
    );
    expect(rendered).toContain('【系统契约 · 不可修改】');
    expect(rendered).toContain('"beats"');
    expect(rendered).toContain('单调不减');
  });
});
