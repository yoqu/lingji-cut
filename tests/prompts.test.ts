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

  it('exposes the Pi show director as an independently bindable prompt', () => {
    expect(PROMPT_KINDS).toContain('production.director');
    expect(PROMPT_KIND_META['production.director'].label).toBe('导演制作规则');
    expect(PROMPT_KIND_META['production.director'].supportsBinding).toBe(true);
    expect(getBuiltinPromptTemplate('production.director').user).toContain('每分钟 2-4 次');
  });

  it('lets reviewed real B-roll serve non-evidence roles without media quotas', () => {
    const director = getBuiltinPromptTemplate('production.director').user;
    const planning = getBuiltinPromptTemplate('planning.segment').user;

    expect(director).toContain('evidence 画面必须能核验');
    expect(director).toContain('context、emotion、demonstration 与 breath');
    expect(director).toContain('素材检索分只用于候选排序');
    expect(director).toContain('人工或导演 Agent 明确选择的低分素材可以执行');
    expect(director).toContain('不给 footage、image 或 agent-composite 设置数量、占比、连续段数与首尾禁用配额');
    expect(planning).not.toContain('整期 image 段数不得超过总段数的 1/3');
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
  it('anchor 关键词锚点收紧为系统标记 / 章节路标专用（防导演滥用）', () => {
    const anim = DEFAULT_PROMPT_YAML['cards.animation'];
    // anchor 条款：仅 bible directive 标记或纯章节路标可用，限量 0~2 张
    expect(anim).toContain('carrier=concept(anchor)');
    expect(anim).toContain('0~2 张');
    expect(anim).toContain('不得以锚点逃避');
    // 增量铁律：复述打回的正确做法是增量 / 图形素材载体优先，锚点不再列为通用逃生出口
    expect(anim).toContain('优先提炼增量（数据 / 结构 / 出处），或改走图形 / 素材载体');
    expect(anim).toContain('关键词锚点仅当该段是章节路标或系统已标弱卡时可用');
  });
});

describe('motion.bible default template（carrier 多样性软配额）', () => {
  it('约束 concept 总量、数据段载体与整期 carrier 种类数', () => {
    const tpl = getBuiltinPromptTemplate('motion.bible');
    expect(tpl.user).toContain('carrier 多样性');
    expect(tpl.user).toContain('30%');
    expect(tpl.user).toContain('semanticType=data');
    expect(tpl.user).toContain('min(6');
    expect(tpl.user).toContain('stacked-composition');
  });

  it('先规划最终媒介、构图、运镜和素材检索，不再是 motion-only', () => {
    const rendered = renderUserPromptWithLock(
      'motion.bible',
      getBuiltinPromptTemplate('motion.bible'),
      { globalPrompt: '无', programSummary: '总结', keywords: '关键词', segments: '[]' },
    );
    expect(rendered).toContain('最终镜头方案');
    expect(rendered).toContain('visualType');
    expect(rendered).toContain('composition');
    expect(rendered).toContain('cameraMove');
    expect(rendered).toContain('mediaQuery');
    expect(rendered).toContain('renderStrategy');
    expect(rendered).toContain('agent-composite');
    expect(rendered).toContain('compositionIntent');
    expect(rendered).toContain('禁止写坐标、CSS、画中画、分屏');
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
    expect(planning).toContain('title: 8-14 个汉字的作品标题');
    expect(planning).toContain('summary: 1-2 句、约 30-80 字的作品简介');
    expect(planning).toContain('画面标题必须逐字等于顶层 title');
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

  it('locks cover regeneration to the exact director title without shortening', () => {
    const cover = renderUserPromptWithLock(
      'cover.regeneration',
      getBuiltinPromptTemplate('cover.regeneration'),
      {
        title: '世界第91位不是突然发生的',
        globalPrompt: '无',
        currentPrompt: '无',
        styleSystemBlock: '',
      },
    );

    expect(cover).toContain('世界第91位不是突然发生的');
    expect(cover).toContain('禁止截取、缩写、改写或另造');
    expect(cover).toContain('画面主标题必须逐字等于作品标题');
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
    expect(anim).toContain('听中文，看阿拉伯数字');
    expect(anim).toContain('“124.3%”');
    expect(anim).toContain('不得为了缩短而换算、四舍五入');
  });

  it('cards.animation 锁定契约要求严格 JSON 输出', () => {
    const rendered = renderUserPromptWithLock(
      'cards.animation',
      getBuiltinPromptTemplate('cards.animation'),
      { segmentCues: '  [0] +0.0s 第一句' },
    );
    expect(rendered).toContain('【系统契约 · 不可修改】');
    expect(rendered).toContain('"beats"');
    expect(rendered).toContain('"assets"');
    expect(rendered).toContain('visualTreatment');
    expect(rendered).toContain('单调不减');
  });
});
