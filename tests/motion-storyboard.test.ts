import { describe, expect, it } from 'vitest';
import {
  parseStoryboard,
  storyboardParseHint,
  validateStoryboard,
  formatStoryboardIssues,
  STORYBOARD_CARRIERS,
  type MotionStoryboard,
} from '../src/lib/motion-storyboard';

const VALID: MotionStoryboard = {
  claim: '硕士报名人数远超博士',
  carrier: 'data-hero',
  scene: '一个大数字与配重条',
  focus: { beat: 1, emphasis: 'countup-settle' },
  beats: [
    { cue: null, kind: 'build', adds: '标题：考研报名', motion: '软落' },
    { cue: 1, kind: 'build', adds: '数字 28842 人', changes: '标题保持', motion: '计数到 28842' },
  ],
};

const CTX = { cueCount: 4, transcript: '今年硕士报名28,842人，博士2403人。' };

const BUDGETED: MotionStoryboard = {
  ...VALID,
  layout: 'title-hero',
  elements: [
    { id: 'title', role: 'support', slot: 'header', content: '考研报名', heightRatio: 0.12 },
    { id: 'hero', role: 'focus', slot: 'main', content: '28842人', heightRatio: 0.42 },
  ],
  capacity: { maxVisible: 2, maxHeightRatio: 0.62 },
  beats: [
    { ...VALID.beats[0], lifecycle: { enter: ['title'] } },
    { ...VALID.beats[1], lifecycle: { enter: ['hero'], collapse: ['title'] } },
  ],
};

describe('parseStoryboard', () => {
  it('解析裸 JSON', () => {
    expect(parseStoryboard(JSON.stringify(VALID))?.carrier).toBe('data-hero');
  });

  it('解析带前后缀 / 代码围栏的 JSON', () => {
    const wrapped = `好的，分镜如下：\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`\n完毕。`;
    expect(parseStoryboard(wrapped)?.beats).toHaveLength(2);
  });

  it('嵌套花括号与字符串内花括号不干扰平衡匹配', () => {
    const tricky = `{"claim":"a{b}c","carrier":"quote","scene":"s","beats":[{"cue":null,"kind":"build","adds":"x"}]} 尾巴{`;
    expect(parseStoryboard(tricky)?.claim).toBe('a{b}c');
  });

  it('尾随逗号可修复解析', () => {
    const withTrailing = JSON.stringify(VALID, null, 2).replace('"beats": [', '"beats": [').replace(/}\n\s*\]\n}/, '},\n  ]\n}');
    expect(withTrailing).toMatch(/},\s*\]/);
    const parsed = parseStoryboard(withTrailing);
    expect(parsed?.claim).toBe(VALID.claim);
  });

  it('回复先出现小示例对象时，取含 beats 的分镜对象', () => {
    const text = `按你的示例 {"cue": 2, "kind": "build"} 我给出分镜：\n${JSON.stringify(VALID)}`;
    const parsed = parseStoryboard(text);
    expect(parsed?.beats).toHaveLength(2);
    expect(parsed?.claim).toBe(VALID.claim);
  });

  it('首个对象 JSON 语法非法时继续尝试后续对象', () => {
    const text = `{bad json,}\n${JSON.stringify(VALID)}`;
    const parsed = parseStoryboard(text);
    expect(parsed?.claim).toBe(VALID.claim);
  });

  it('无 JSON 时返回 null', () => {
    expect(parseStoryboard('没有任何结构化内容')).toBeNull();
  });

  it('字段别名归一化：content/element/action 收敛为 adds/motion', () => {
    const aliased = JSON.stringify({
      claim: 'x',
      carrier: 'data-hero',
      scene: 's',
      beats: [
        { cue: null, kind: 'build', content: '标题', action: '软落' },
        { cue: 1, kind: 'build', element: '数字 28842', update: '标题保持' },
      ],
    });
    const sb = parseStoryboard(aliased)!;
    expect(sb.beats[0].adds).toBe('标题');
    expect(sb.beats[0].motion).toBe('软落');
    expect(sb.beats[1].adds).toBe('数字 28842');
    expect(sb.beats[1].changes).toBe('标题保持');
    expect(validateStoryboard(sb, CTX).ok).toBe(true);
  });

  it('旧分镜缺少 role 时按焦点与首尾拍补默认节奏角色', () => {
    const parsed = parseStoryboard(JSON.stringify(VALID))!;
    expect(parsed.beats.map((beat) => beat.role)).toEqual(['anticipation', 'emphasis']);
  });
});

describe('storyboardParseHint', () => {
  it('无 JSON：提示只输出 JSON 对象', () => {
    expect(storyboardParseHint('我不会输出 JSON')).toContain('不含');
  });
  it('JSON 未闭合：提示疑似截断', () => {
    const truncated = JSON.stringify(VALID).slice(0, 80);
    expect(storyboardParseHint(truncated)).toContain('截断');
  });
  it('语法非法：提示严格 JSON', () => {
    expect(storyboardParseHint(`{'claim': 'x', beats: []}`)).toContain('JSON');
  });
});

describe('validateStoryboard', () => {
  it('合法分镜通过（含千分位数字归一化匹配）', () => {
    const v = validateStoryboard(VALID, CTX);
    expect(v.ok).toBe(true);
    expect(v.errors).toHaveLength(0);
  });

  it('合法分镜可携带资产规划请求', () => {
    const v = validateStoryboard({
      ...VALID,
      assets: [
        {
          slot: 'archive_prop',
          query: '旧档案袋',
          role: 'object',
          importance: 'primary',
          reusePolicy: 'generate-if-missing',
          visualTreatment: 'editorial-realist-cutout',
          placementHint: '左下角前景物件',
        },
      ],
    }, CTX);

    expect(v.ok).toBe(true);
    expect(v.errors).toHaveLength(0);
  });

  it('非法资产规划字段会报错', () => {
    const v = validateStoryboard({
      ...VALID,
      assets: [
        {
          slot: '',
          query: '',
          role: 'person' as never,
          importance: 'hero' as never,
          reusePolicy: 'auto' as never,
          visualTreatment: 'editorial-realist-cutout',
        },
      ],
    }, CTX);

    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain('缺少 slot');
    expect(v.errors.join()).toContain('缺少 query');
    expect(v.errors.join()).toContain('role');
    expect(v.errors.join()).toContain('importance');
    expect(v.errors.join()).toContain('reusePolicy');
  });

  it('null 分镜直接失败', () => {
    expect(validateStoryboard(null, CTX).ok).toBe(false);
  });

  it('carrier 非法枚举报错', () => {
    const bad = { ...VALID, carrier: 'realistic-drawing' as MotionStoryboard['carrier'] };
    const v = validateStoryboard(bad, CTX);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain('carrier');
  });

  it('接受专业信息载体 carrier', () => {
    for (const carrier of ['timeline', 'matrix', 'funnel', 'network', 'before-after', 'stacked-composition'] as const) {
      const v = validateStoryboard({ ...VALID, carrier }, CTX);
      expect(v.ok).toBe(true);
    }
  });

  it('table 是合法 carrier（数据表载体）', () => {
    const v = validateStoryboard({ ...VALID, carrier: 'table' }, CTX);
    expect(v.ok).toBe(true);
    expect(STORYBOARD_CARRIERS).toContain('table');
  });

  it('非法 role 只警告，便于旧分镜或模型小错降级', () => {
    const bad = {
      ...VALID,
      beats: [{ ...VALID.beats[0], role: 'boom' as never }, VALID.beats[1]],
    };
    const v = validateStoryboard(bad, CTX);
    expect(v.ok).toBe(true);
    expect(v.warnings.join()).toContain('role');
  });

  it('cue 越界 / 乱序报错', () => {
    const outOfRange = { ...VALID, beats: [VALID.beats[0], { ...VALID.beats[1], cue: 9 }] };
    expect(validateStoryboard(outOfRange, CTX).errors.join()).toContain('越界');

    const disordered = {
      ...VALID,
      beats: [
        { cue: 2, kind: 'build', adds: 'a' },
        { cue: 0, kind: 'build', adds: 'b' },
      ],
    } as MotionStoryboard;
    expect(validateStoryboard(disordered, CTX).errors.join()).toContain('单调不减');
  });

  it('非首拍 cue 为 null 报错', () => {
    const bad = {
      ...VALID,
      beats: [VALID.beats[0], { cue: null, kind: 'build', adds: 'x' }],
    } as MotionStoryboard;
    expect(validateStoryboard(bad, CTX).ok).toBe(false);
  });

  it('beats 超过 6 拍报错（信息密度上限）', () => {
    const beats = Array.from({ length: 7 }, (_, i) => ({ cue: i === 0 ? null : 1, kind: 'build' as const, adds: `e${i}` }));
    expect(validateStoryboard({ ...VALID, beats }, CTX).errors.join()).toContain('上限 6');
  });

  it('编造数字（逐字稿中不存在）报错，单位数字不误伤', () => {
    const fabricated = {
      ...VALID,
      beats: [VALID.beats[0], { cue: 1, kind: 'build' as const, adds: '数字 99999 与 3 个要点' }],
    };
    const v = validateStoryboard(fabricated, CTX);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain('99999');
    expect(v.errors.join()).not.toContain('[3]');
  });

  it('focus 越界报错；无 focus 仅警告', () => {
    expect(validateStoryboard({ ...VALID, focus: { beat: 9 } }, CTX).ok).toBe(false);
    const noFocus = validateStoryboard({ ...VALID, focus: undefined }, CTX);
    expect(noFocus.ok).toBe(true);
    expect(noFocus.warnings.join()).toContain('focus');
  });

  it('cueCount=0（无字幕）时跳过越界检查', () => {
    const v = validateStoryboard(VALID, { cueCount: 0, transcript: '28842' });
    expect(v.ok).toBe(true);
  });

  it('formatStoryboardIssues 输出编号列表', () => {
    const v = validateStoryboard(null, CTX);
    expect(formatStoryboardIssues(v)).toMatch(/^1\. /);
  });

  it('严格生成模式要求 layout/elements/capacity/lifecycle', () => {
    const missing = validateStoryboard(VALID, { ...CTX, requireCapacityModel: true });
    expect(missing.ok).toBe(false);
    expect(missing.errors.join()).toContain('elements');

    const valid = validateStoryboard(BUDGETED, { ...CTX, requireCapacityModel: true });
    expect(valid.errors).toEqual([]);
    expect(valid.ok).toBe(true);
  });

  it('asset-led 是合法 layout（素材主导大图小字布局）', () => {
    const v = validateStoryboard({ ...BUDGETED, layout: 'asset-led' }, { ...CTX, requireCapacityModel: true });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('逐拍模拟生命周期并阻止同时驻留区块超预算', () => {
    const overloaded: MotionStoryboard = {
      ...BUDGETED,
      elements: [
        ...BUDGETED.elements!,
        { id: 'note', role: 'support', slot: 'header', content: '补充说明', heightRatio: 0.24 },
      ],
      capacity: { maxVisible: 2, maxHeightRatio: 0.62 },
      beats: [
        BUDGETED.beats[0],
        {
          ...BUDGETED.beats[1],
          lifecycle: { enter: ['hero', 'note'], update: ['title'] },
        },
      ],
    };
    const result = validateStoryboard(overloaded, { ...CTX, requireCapacityModel: true });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/同时驻留|预计占高/);
  });
});


/* ---------- anchor 使用硬闸门（导演不得无视 bible 自选角落小字） ---------- */

/** 合法的关键词锚点分镜（除闸门外的机器校验全部通过，便于隔离闸门行为）。 */
const ANCHOR: MotionStoryboard = {
  claim: '供应链关键词',
  carrier: 'concept',
  layout: 'corner-anchor',
  scene: '右上角关键词小字',
  focus: { beat: 1 },
  data: { variant: 'anchor', term: '光模块' },
  beats: [
    { cue: null, kind: 'build', adds: '锚点入场' },
    { cue: 1, kind: 'accent', adds: '关键词点亮' },
  ],
};

const QUOTE_I3_DIRECTIVE = { preferredCarrier: 'quote', intensity: 3 };

describe('anchor 使用硬闸门（semanticType / bible directive）', () => {
  it('chapter-transition 段放行（纯章节路标）', () => {
    const v = validateStoryboard(ANCHOR, {
      ...CTX,
      semanticType: 'chapter-transition',
      bibleDirective: QUOTE_I3_DIRECTIVE,
    });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('bible directive 标 preferredVariant=anchor 的系统弱卡段放行', () => {
    const v = validateStoryboard(ANCHOR, {
      ...CTX,
      semanticType: 'narration',
      bibleDirective: { preferredCarrier: 'concept', preferredVariant: 'anchor', intensity: 1 },
    });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('重点段（bible 指定 quote / intensity=3）自选 anchor 打回，文案含指定载体与 intensity', () => {
    const v = validateStoryboard(ANCHOR, {
      ...CTX,
      semanticType: 'quote',
      bibleDirective: QUOTE_I3_DIRECTIVE,
    });
    expect(v.ok).toBe(false);
    const message = v.errors.find((e) => e.includes('关键词锚点'));
    expect(message).toBeDefined();
    expect(message).toContain('carrier=quote');
    expect(message).toContain('intensity=3');
    expect(message).toContain('增量卡');
  });

  it('directive 无 preferredVariant 按未标记处理：普通叙述段自选 anchor 打回', () => {
    const v = validateStoryboard(ANCHOR, {
      ...CTX,
      semanticType: 'narration',
      bibleDirective: { preferredCarrier: 'list-build', intensity: 2 },
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain('关键词锚点');
  });

  it('semanticType 不可得时兜底放行（手动选段 / 旧项目不卡死）', () => {
    const v = validateStoryboard(ANCHOR, { ...CTX, bibleDirective: QUOTE_I3_DIRECTIVE });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('仅声明 corner-anchor 布局（非 anchor variant）同样被闸', () => {
    const cornerOnly: MotionStoryboard = {
      ...ANCHOR,
      carrier: 'quote',
      data: { text: '一句金句' },
    };
    const v = validateStoryboard(cornerOnly, {
      ...CTX,
      semanticType: 'quote',
      bibleDirective: QUOTE_I3_DIRECTIVE,
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain('corner-anchor');
  });

  it('非 anchor variant / 非 corner-anchor 布局不受闸门影响', () => {
    const typewriter: MotionStoryboard = {
      ...ANCHOR,
      layout: undefined,
      data: { variant: 'typewriter', term: '新名词', definition: '一句全新释义' },
    };
    const v = validateStoryboard(typewriter, {
      ...CTX,
      semanticType: 'data',
      bibleDirective: { preferredCarrier: 'data-hero', intensity: 3 },
    });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    // 满版数据卡照常通过
    expect(
      validateStoryboard(VALID, { ...CTX, semanticType: 'data', bibleDirective: QUOTE_I3_DIRECTIVE }).ok,
    ).toBe(true);
  });
});

describe('叙事运镜 / 指示标注归一化', () => {
  const withBeats = (extra: Record<string, unknown>) =>
    JSON.stringify({
      claim: 'c',
      carrier: 'data-hero',
      scene: 's',
      beats: [
        { cue: null, kind: 'build', adds: '标题' },
        { cue: 1, kind: 'accent', adds: '数字' },
      ],
      ...extra,
    });

  it('合法运镜按拍号排序保留，越界 / 非法 move / 同拍重复被丢弃', () => {
    const sb = parseStoryboard(
      withBeats({
        camera: [
          { beat: 1, move: 'focus', target: 'main' },
          { beat: 9, move: 'push-in' },
          { beat: 0, move: 'zoom-crazy' },
          { beat: 1, move: 'pull-out' },
          { beat: 0, move: 'pan-left' },
        ],
      }),
    );
    expect(sb?.camera).toEqual([
      { beat: 0, move: 'pan-left' },
      { beat: 1, move: 'focus', target: 'main' },
    ]);
  });

  it('运镜超过上限被截断（整卡最多 2 次）', () => {
    const sb = parseStoryboard(
      withBeats({
        beats: [
          { cue: null, kind: 'build', adds: 'a' },
          { cue: 1, kind: 'build', adds: 'b' },
          { cue: 2, kind: 'build', adds: 'c' },
        ],
        camera: [
          { beat: 0, move: 'push-in' },
          { beat: 1, move: 'pull-out' },
          { beat: 2, move: 'pan-right' },
        ],
      }),
    );
    expect(sb?.camera).toHaveLength(2);
  });

  it('标注非法 kind 丢弃，target 缺省为 main，同槽位只留最后一个', () => {
    const sb = parseStoryboard(
      withBeats({
        annotate: [
          { beat: 0, kind: 'sparkle' },
          { beat: 0, kind: 'circle' },
          { beat: 1, kind: 'spotlight' },
          { beat: 1, kind: 'underline', target: 'header' },
        ],
      }),
    );
    expect(sb?.annotate).toEqual([
      { beat: 1, kind: 'spotlight', target: 'main' },
      { beat: 1, kind: 'underline', target: 'header' },
    ]);
  });

  it('未声明 camera / annotate 时保持 undefined（不侵入既有分镜）', () => {
    const sb = parseStoryboard(withBeats({}));
    expect(sb?.camera).toBeUndefined();
    expect(sb?.annotate).toBeUndefined();
  });
});

describe('载体塌陷闸门（bible 规划图形化 → 分镜写成纯文字）', () => {
  const collapsed = (extra: Partial<MotionStoryboard> = {}): MotionStoryboard => ({
    claim: '出口结构在变',
    carrier: 'concept',
    scene: '一句结论',
    focus: { beat: 1, emphasis: 'slam' },
    beats: [
      { cue: null, kind: 'build', adds: '标题' },
      { cue: 1, kind: 'accent', adds: '结论' },
    ],
    ...extra,
  });
  const ctx = { cueCount: 4, transcript: '2019年是12，2022年是18，2025年是41。', bibleDirective: { preferredCarrier: 'trend', intensity: 3 as const } };

  it('第 1 轮打回并给出两条出路', () => {
    const v = validateStoryboard(collapsed(), ctx);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain('carrier="trend"');
    expect(v.errors.join()).toContain('carrierDeviation');
  });

  it('第 2 轮起降级为提醒——绝不因为软规则把卡片打没', () => {
    const v = validateStoryboard(collapsed(), { ...ctx, attempt: 1 });
    expect(v.errors.filter((e) => e.includes('carrierDeviation'))).toEqual([]);
    expect(v.warnings.join()).toContain('carrierDeviation');
  });

  it('写了合法偏离理由即放行', () => {
    const v = validateStoryboard(collapsed({ carrierDeviation: { reason: 'no-data' } }), ctx);
    expect(v.errors.filter((e) => e.includes('carrierDeviation'))).toEqual([]);
  });

  it('非法理由不算数；未规划图形化载体 / 未塌陷则不触发', () => {
    expect(
      validateStoryboard(collapsed({ carrierDeviation: { reason: 'because' as never } }), ctx).ok,
    ).toBe(false);
    // bible 本就规划 concept
    expect(
      validateStoryboard(collapsed(), { ...ctx, bibleDirective: { preferredCarrier: 'concept', intensity: 2 } })
        .errors.filter((e) => e.includes('carrierDeviation')),
    ).toEqual([]);
    // 偏离到 data-hero 仍是数据表达，不拦
    expect(
      validateStoryboard(collapsed({ carrier: 'data-hero', data: { value: 41, unit: '' } }), ctx)
        .errors.filter((e) => e.includes('carrierDeviation')),
    ).toEqual([]);
  });
});
