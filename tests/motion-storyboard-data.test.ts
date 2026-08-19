import { describe, expect, it } from 'vitest';
import { measureTranscriptOverlap, validateStoryboard, type MotionStoryboard } from '../src/lib/motion-storyboard';

const BEATS: MotionStoryboard['beats'] = [
  { cue: null, kind: 'build', adds: '标题入场' },
  { cue: 1, kind: 'accent', adds: '核心内容落地' },
];

const CTX = { cueCount: 4, transcript: '新易盛环比增长43%，天孚通信增长40%，中际旭创增长38%。' };

function sb(partial: Partial<MotionStoryboard>): MotionStoryboard {
  return {
    claim: '新易盛中报预增',
    carrier: 'list-build',
    scene: '终态',
    focus: { beat: 1, emphasis: 'slam' },
    beats: BEATS,
    ...partial,
  };
}

function errorsOf(storyboard: MotionStoryboard, transcript = CTX.transcript): string[] {
  return validateStoryboard(storyboard, { cueCount: CTX.cueCount, transcript }).errors;
}

describe('validateStoryboardData（per-carrier data 机器校验）', () => {
  it('合法 data 通过：data-hero / table / list-build', () => {
    expect(errorsOf(sb({ carrier: 'data-hero', data: { value: 43, unit: '%', label: '环比增速' } }))).toEqual([]);
    expect(
      errorsOf(sb({ carrier: 'table', data: { columns: ['公司', '增速'], rows: [['新易盛', '43%'], ['天孚通信', '40%']] } })),
    ).toEqual([]);
    expect(errorsOf(sb({ carrier: 'list-build', data: { items: ['需求爆发', '订单饱满'] } }))).toEqual([]);
  });

  it('无 data 时照常通过（回落提取，兼容旧模板）', () => {
    expect(errorsOf(sb({ carrier: 'data-hero' }))).toEqual([]);
  });

  it('非法 variant 报错', () => {
    const errors = errorsOf(sb({ carrier: 'list-build', data: { items: ['a'], variant: 'grid' as never } }));
    expect(errors.some((e) => e.includes('variant'))).toBe(true);
  });

  it('kinetic typography 变体：quote word-pop / concept typewriter / list-build keyword-scan', () => {
    // 合法样本通过
    expect(
      errorsOf(
        sb({ carrier: 'quote', data: { variant: 'word-pop', text: '新易盛是最强主线', words: ['新易盛', '是', '最强主线'] } }),
      ),
    ).toEqual([]);
    expect(
      errorsOf(sb({ carrier: 'concept', data: { variant: 'typewriter', term: '环比增速', definition: '相对上一个统计周期的增长比例' } })),
    ).toEqual([]);
    expect(
      errorsOf(sb({ carrier: 'list-build', data: { items: ['需求爆发', '订单饱满'], variant: 'keyword-scan', keywords: ['爆发', ''] } })),
    ).toEqual([]);

    // word-pop 缺 words / 块数越界被打回
    const noWords = errorsOf(sb({ carrier: 'quote', data: { variant: 'word-pop', text: '新易盛是最强主线' } }));
    expect(noWords.some((e) => e.includes('words') && e.includes('2~8'))).toBe(true);
    const tooMany = errorsOf(
      sb({ carrier: 'quote', data: { variant: 'word-pop', text: '新易盛是最强主线', words: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] } }),
    );
    expect(tooMany.some((e) => e.includes('2~8'))).toBe(true);

    // keyword-scan 仍按普通 ListBuild 4 条上限；keywords 超出 items 条数被打回
    const fiveItems = errorsOf(
      sb({ carrier: 'list-build', data: { items: ['a', 'b', 'c', 'd', 'e'], variant: 'keyword-scan' } }),
    );
    expect(fiveItems.some((e) => e.includes('1~4'))).toBe(true);
    const kwOverflow = errorsOf(
      sb({ carrier: 'list-build', data: { items: ['需求爆发'], variant: 'keyword-scan', keywords: ['爆发', '多出'] } }),
    );
    expect(kwOverflow.some((e) => e.includes('配对'))).toBe(true);
  });

  it('条数上限：list-build 普通 4 条、变体 5 条、table 5 行', () => {
    expect(
      errorsOf(sb({ carrier: 'list-build', data: { items: ['a', 'b', 'c', 'd', 'e'] } })).some((e) => e.includes('1~4')),
    ).toBe(true);
    expect(
      errorsOf(sb({ carrier: 'list-build', data: { items: ['a', 'b', 'c', 'd', 'e'], variant: 'rank' } })),
    ).toEqual([]);
    expect(
      errorsOf(
        sb({
          carrier: 'table',
          data: { columns: ['公司'], rows: [['a'], ['b'], ['c'], ['d'], ['e'], ['f']] },
        }),
      ).some((e) => e.includes('1~5 行')),
    ).toBe(true);
  });

  it('上屏文本长度：条目 >14 字、标题 >10 字被打回', () => {
    const errors = errorsOf(
      sb({ carrier: 'list-build', data: { items: ['这是一条远远超过十四字上限的上屏文案内容'] } }),
    );
    expect(errors.some((e) => e.includes('超过上限 14'))).toBe(true);
    const titleErrors = errorsOf(
      sb({ carrier: 'concept', data: { variant: 'section', title: '这个章节标题实在太长了' } }),
    );
    expect(titleErrors.some((e) => e.includes('超过上限 10'))).toBe(true);
  });

  it('data 数字防编造：value / points 必须在逐字稿中', () => {
    const heroErrors = errorsOf(sb({ carrier: 'data-hero', data: { value: 99, unit: '%', label: '环比增速' } }));
    expect(heroErrors.some((e) => e.includes('99') && e.includes('逐字稿'))).toBe(true);

    const trendErrors = errorsOf(sb({ carrier: 'trend', data: { points: [43, 40, 77] } }));
    expect(trendErrors.some((e) => e.includes('77'))).toBe(true);
    expect(errorsOf(sb({ carrier: 'trend', data: { points: [43, 40, 38] } }))).toEqual([]);
  });

  it('允许把中文口播数字精确写成阿拉伯数字卡面', () => {
    const transcript = '总销量四十一万九千两百一十一辆，海外销量十七万九千八百四十一辆，同比增长百分之一百二十四点三。';
    const errors = errorsOf(sb({
      carrier: 'data-hero',
      data: {
        variant: 'stat-grid',
        items: [
          { value: '419,211辆', label: '总销量' },
          { value: '179,841辆', label: '海外销量' },
          { value: '124.3%', label: '同比增长' },
        ],
      },
    }), transcript);

    expect(errors).toEqual([]);
  });

  it('中文数量写法被卡面风格门禁打回，专有名词不误伤', () => {
    const chineseNumbers = errorsOf(sb({
      carrier: 'data-hero',
      data: {
        variant: 'stat-grid',
        items: [
          { value: '四十一万九千两百一十一辆', label: '总销量' },
          { value: '百分之一百二十四点三', label: '同比增长' },
        ],
      },
    }), '总销量四十一万九千两百一十一辆，同比增长百分之一百二十四点三。');
    expect(chineseNumbers.some((error) => error.includes('必须使用阿拉伯数字'))).toBe(true);

    expect(errorsOf(sb({
      carrier: 'concept',
      data: { variant: 'section', title: '一叶知秋' },
    }), '大家好，我是一叶知秋。')).toEqual([]);

    const claimNumbers = errorsOf(sb({
      carrier: 'data-hero',
      claim: '海外销量十七万九千八百四十一辆',
      data: { value: 179841, unit: '辆', label: '海外销量' },
    }), '海外销量十七万九千八百四十一辆。');
    expect(claimNumbers.some((error) => error.includes('必须使用阿拉伯数字'))).toBe(true);

    const fabricatedClaim = errorsOf(sb({
      carrier: 'data-hero',
      claim: '海外销量179,842辆',
      data: { value: 179841, unit: '辆', label: '海外销量' },
    }), '海外销量十七万九千八百四十一辆。');
    expect(fabricatedClaim.some((error) => error.includes('179842') && error.includes('不得编造'))).toBe(true);
  });

  it('中文口播数字转写仍禁止换算和四舍五入', () => {
    const errors = errorsOf(sb({
      carrier: 'data-hero',
      data: { value: 41.92, unit: '万辆', label: '总销量' },
    }), '总销量四十一万九千两百一十一辆。');

    expect(errors.some((error) => error.includes('41.92') && error.includes('不得编造 / 换算 / 四舍五入'))).toBe(true);
  });

  it('matrix 的 x/y 是布局坐标，不参与数字防编造', () => {
    const errors = errorsOf(
      sb({
        carrier: 'matrix',
        data: { items: [{ label: '优先做', x: 78, y: 72 }, { label: '暂缓', x: 28, y: 36 }] },
      }),
    );
    expect(errors).toEqual([]);
  });

  it('scale-impact 缺 max 报错；stat-grid 条数校验', () => {
    expect(
      errorsOf(sb({ carrier: 'data-hero', data: { value: 43, variant: 'scale-impact' } })).some((e) => e.includes('max')),
    ).toBe(true);
    expect(
      errorsOf(sb({ carrier: 'data-hero', data: { variant: 'stat-grid', items: [{ value: '43%', label: '增速' }] } })).some(
        (e) => e.includes('2~4'),
      ),
    ).toBe(true);
  });

  it('network links 引用越界报错', () => {
    const errors = errorsOf(sb({ carrier: 'network', data: { nodes: ['平台', '创作者'], links: [[0, 5]] } }));
    expect(errors.some((e) => e.includes('links[0]'))).toBe(true);
  });

  it('comparison 变体：horizontal-bars 上限 5 项、bar 上限 4 项、非法变体报错', () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `项${i + 1}`, value: [43, 40, 38][i % 3] }));
    expect(errorsOf(sb({ carrier: 'comparison', data: { variant: 'horizontal-bars', items: make(5) } }))).toEqual([]);
    expect(
      errorsOf(sb({ carrier: 'comparison', data: { variant: 'horizontal-bars', items: make(6) } })).some((e) =>
        e.includes('2~5'),
      ),
    ).toBe(true);
    expect(
      errorsOf(sb({ carrier: 'comparison', data: { variant: 'bar', items: make(5) } })).some((e) => e.includes('2~4')),
    ).toBe(true);
    expect(errorsOf(sb({ carrier: 'comparison', data: { variant: 'column', items: make(6) } }))).toEqual([]);
    expect(
      errorsOf(sb({ carrier: 'comparison', data: { variant: 'pie' as never, items: make(2) } })).some((e) =>
        e.includes('variant'),
      ),
    ).toBe(true);
  });

  it('quote citation 变体：source 必填、date 可选且忠于逐字稿', () => {
    expect(errorsOf(sb({ carrier: 'quote', data: { variant: 'citation', text: '新易盛环比增长43%', source: '中报纪要' } }))).toEqual([]);
    const missing = errorsOf(sb({ carrier: 'quote', data: { variant: 'citation', text: '新易盛环比增长43%' } }));
    expect(missing.some((e) => e.includes('source'))).toBe(true);
    expect(
      errorsOf(sb({ carrier: 'quote', data: { variant: 'citation', text: '新易盛环比增长43%', source: '中报纪要', date: '2024.12' } })).some(
        (e) => e.includes('2024.12') && e.includes('逐字稿'),
      ),
    ).toBe(true);
  });
});

describe('文字防复述（卡面文字不得复述口播）', () => {
  const TRANSCRIPT = '光模块是本轮算力行情里确定性最高的方向，订单已经排到了明年下半年，海外大客户还在持续加单。';
  const errorsIn = (storyboard: MotionStoryboard, transcript = TRANSCRIPT) =>
    validateStoryboard(storyboard, { cueCount: CTX.cueCount, transcript }).errors;

  it('measureTranscriptOverlap：归一化与贪心覆盖的纯函数行为', () => {
    // 全文照抄：ratio=1、matched=全长
    expect(measureTranscriptOverlap(['光模块是本轮算力行情'], '光模块是本轮算力行情')).toEqual({
      totalChars: 10,
      matchedChars: 10,
      ratio: 1,
    });
    // 标点 / 数字先剥离再比对：「增长43%」与「增长了百分之43」的数字不计入重合
    const stripped = measureTranscriptOverlap(['营收28842万元创新高'], '营收28842万元创新高');
    expect(stripped.totalChars).toBe('营收万元创新高'.length);
    // kicker 级短标签（≤6 字）不参与计算
    expect(measureTranscriptOverlap(['光模块', '算力'], TRANSCRIPT).totalChars).toBe(0);
    // transcript 为空 / 归一化为空（纯数字）时跳过
    expect(measureTranscriptOverlap(['任意文本'], '').ratio).toBe(0);
    expect(measureTranscriptOverlap(['任意文本'], '28842').ratio).toBe(0);
    // 分散命中的公共片段也累计（贪心摘取多个公共子串）
    const scattered = measureTranscriptOverlap(['光模块的订单加单'], TRANSCRIPT);
    expect(scattered.matchedChars).toBe('光模块'.length + '订单'.length + '加单'.length);
  });

  it('阐述类卡整段照抄口播被打回：concept / list-build / process / timeline', () => {
    const copied = {
      claim: '光模块是本轮算力行情里确定性最高的方向',
      items: ['订单已经排到了明年下半年', '海外大客户还在持续加单'],
    };
    const listErrors = errorsIn(sb({ carrier: 'list-build', data: { items: copied.items }, claim: copied.claim }));
    // 打回文案：优先提炼增量或改图形/素材载体；锚点仅限章节路标 / 系统弱卡，不再是通用逃生出口
    expect(
      listErrors.some(
        (e) =>
          e.includes('复述口播') &&
          e.includes('提炼增量') &&
          e.includes('图形 / 素材载体') &&
          e.includes('章节路标'),
      ),
    ).toBe(true);
    const processErrors = errorsIn(
      sb({ carrier: 'process', data: { steps: copied.items }, claim: copied.claim }),
    );
    expect(processErrors.some((e) => e.includes('复述口播'))).toBe(true);
    const timelineErrors = errorsIn(
      sb({ carrier: 'timeline', data: { items: copied.items }, claim: copied.claim }),
    );
    expect(timelineErrors.some((e) => e.includes('复述口播'))).toBe(true);
    const conceptErrors = errorsIn(
      sb({ carrier: 'concept', data: { term: '光模块', definition: '海外大客户还在持续加单' }, claim: copied.claim }),
    );
    expect(conceptErrors.some((e) => e.includes('复述口播'))).toBe(true);
  });

  it('豁免：quote 原话上屏、图形/数据载体、kicker 级短标签、term 锚点', () => {
    // quote：金句本来就是原话上屏
    expect(
      errorsIn(sb({ carrier: 'quote', data: { text: '光模块是本轮算力行情里确定性最高的方向' }, claim: '光模块是本轮算力行情里确定性最高的方向' })),
    ).toEqual([]);
    // 图形 / 数据载体：提供结构化增量，不查复述
    expect(errorsIn(sb({ carrier: 'data-hero', claim: '光模块是本轮算力行情里确定性最高的方向' }))).toEqual([]);
    // 全是 kicker 级短标签（≤6 字）：参与计算的文本为 0，直接跳过
    expect(
      errorsIn(sb({ carrier: 'list-build', data: { items: ['光模块', '算力', '确定性'] }, claim: '光模块' })),
    ).toEqual([]);
    // concept 的 term 是关键词锚点（专名豁免），不计入；hint 虽全重合但 ≤14 字属短文本噪声
    expect(
      errorsIn(
        sb({
          carrier: 'concept',
          data: { term: '已经排到了明年下', definition: '独特结构', hint: '海外大客户还在持续加单' },
          claim: '独立看法',
        }),
      ),
    ).toEqual([]);
  });

  it('边界阈值：重合 >70% 且 >14 字才触发（等号不触发）', () => {
    // 14 字全重合：matched 不 >14，不触发
    expect(errorsIn(sb({ carrier: 'list-build', claim: '光模块是本轮算力行情里确定性' }))).toEqual([]);
    // 15 字全重合：触发
    expect(
      errorsIn(sb({ carrier: 'list-build', claim: '光模块是本轮算力行情里确定性最' })).some((e) => e.includes('复述口播')),
    ).toBe(true);
    // ratio 恰好 0.7（21/30）：不 >0.7，不触发
    const transcript24 = '订单已经排到了明年下半年海外大客户还在持续加单中';
    const copied21 = '订单已经排到了明年下半年海外大客户还在持续';
    const atRatio = validateStoryboard(
      sb({ carrier: 'list-build', claim: `${copied21}九字独创补充观点呀` }),
      { cueCount: CTX.cueCount, transcript: transcript24 },
    ).errors;
    expect(measureTranscriptOverlap([`${copied21}九字独创补充观点呀`], transcript24).ratio).toBe(0.7);
    expect(atRatio.some((e) => e.includes('复述口播'))).toBe(false);
    // 19/29 ≈ 65.5% 低于阈值：不触发
    expect(errorsIn(sb({ carrier: 'list-build', claim: '光模块是本轮算力行情里确定性最高的方向再补充九个独创观点字' }))).toEqual([]);
  });

  it('无 transcript 时跳过检测（缺省参数的最小接线）', () => {
    const copied = sb({ carrier: 'list-build', claim: '光模块是本轮算力行情里确定性最高的方向' });
    expect(errorsIn(copied, '')).toEqual([]);
    expect(validateStoryboard(copied, { cueCount: CTX.cueCount }).errors).toEqual([]);
  });
});

describe('concept anchor 变体（关键词锚点卡）', () => {
  it('合法形态：term 单关键词 / keywords 1~3 个', () => {
    expect(errorsOf(sb({ carrier: 'concept', data: { variant: 'anchor', term: '光模块' } }))).toEqual([]);
    expect(errorsOf(sb({ carrier: 'concept', data: { variant: 'anchor', keywords: ['算力'] } }))).toEqual([]);
    expect(errorsOf(sb({ carrier: 'concept', data: { variant: 'anchor', keywords: ['算力', '光模块', '订单'] } }))).toEqual([]);
  });

  it('definition 不允许（锚点无释义）', () => {
    const errors = errorsOf(
      sb({ carrier: 'concept', data: { variant: 'anchor', term: '光模块', definition: '本轮算力行情的核心载体' } }),
    );
    expect(errors.some((e) => e.includes('definition') && e.includes('无释义'))).toBe(true);
  });

  it('term 与 keywords 二选一；两者缺失报错', () => {
    expect(
      errorsOf(sb({ carrier: 'concept', data: { variant: 'anchor', term: '光模块', keywords: ['算力'] } })).some((e) =>
        e.includes('二选一'),
      ),
    ).toBe(true);
    expect(
      errorsOf(sb({ carrier: 'concept', data: { variant: 'anchor' } })).some(
        (e) => e.includes('term') && e.includes('keywords'),
      ),
    ).toBe(true);
  });

  it('关键词长度与个数上限：term ≤6 字、keywords ≤3 个且每个 ≤6 字', () => {
    expect(
      errorsOf(sb({ carrier: 'concept', data: { variant: 'anchor', term: '光模块的大行情' } })).some((e) =>
        e.includes('超过上限 6'),
      ),
    ).toBe(true);
    expect(
      errorsOf(sb({ carrier: 'concept', data: { variant: 'anchor', keywords: ['算力', '光模块', '订单', '加单'] } })).some(
        (e) => e.includes('1~3'),
      ),
    ).toBe(true);
    expect(
      errorsOf(sb({ carrier: 'concept', data: { variant: 'anchor', keywords: ['算力', '光模块的大行情'] } })).some((e) =>
        e.includes('keywords[1]'),
      ),
    ).toBe(true);
  });

  it('非法 variant 报错文案更新为 section | typewriter | anchor', () => {
    expect(
      errorsOf(sb({ carrier: 'concept', data: { variant: 'grid' as never, term: 'a', definition: 'b' } })).some((e) =>
        e.includes('anchor'),
      ),
    ).toBe(true);
  });
});
