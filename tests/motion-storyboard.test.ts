import { describe, expect, it } from 'vitest';
import {
  parseStoryboard,
  storyboardParseHint,
  validateStoryboard,
  formatStoryboardIssues,
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

  it('null 分镜直接失败', () => {
    expect(validateStoryboard(null, CTX).ok).toBe(false);
  });

  it('carrier 非法枚举报错', () => {
    const bad = { ...VALID, carrier: 'realistic-drawing' as MotionStoryboard['carrier'] };
    const v = validateStoryboard(bad, CTX);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain('carrier');
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
});
