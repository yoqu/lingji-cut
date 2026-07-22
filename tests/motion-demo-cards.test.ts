/**
 * motion-demo-cards —— 设置界面「动效系统预览」demo 注册表的质量门禁。
 *
 * 每条 demo 走与生产卡片相同的静态校验（lint requireSafeLayout）与 esbuild 编译，
 * 并与 cards.segment v24 的载体→原语映射做漂移比对：映射变了或 demo 变了都会在这里红。
 */
import { describe, expect, it } from 'vitest';
import {
  MOTION_DEMO_CARDS,
  MOTION_DEMO_CARRIER_META,
  buildDemoCardTsx,
} from '../src/remotion/motion-kit/demo-cards';
import { STORYBOARD_CARRIERS } from '../src/lib/motion-storyboard';
import { lintMotionCardTsx } from '../src/lib/motion-card-lint';
import { getMotionTokensBlock } from '../src/lib/card-style';
import { DEFAULT_PROMPT_YAML } from '../src/lib/prompts/defaults';
import { compileCardTsx } from '../electron/remotion/compile-card-node';

const DEFAULT_TOKENS_JSON = getMotionTokensBlock(undefined);

/** 从 cards.segment 模板文本解析载体→原语映射（格式：`carrier→A / B / C（注释）；`）。 */
function parseCarrierMapping(template: string): Map<string, string[]> {
  const line = template
    .split('\n')
    .find((l) => l.includes('→') && l.includes('data-hero'));
  expect(line, 'cards.segment 模板中应存在载体→原语映射行').toBeTruthy();
  const map = new Map<string, string[]>();
  for (const seg of line!.split('；')) {
    const m = seg.match(/([a-z-]+)→([^；。]+)/);
    if (!m) continue;
    const carrier = m[1].trim();
    if (!(STORYBOARD_CARRIERS as readonly string[]).includes(carrier)) continue;
    const primitives = m[2]
      .replace(/（[^）]*）/g, '') // 去掉「（markers 点亮拐点）」类注释
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
    map.set(carrier, primitives);
  }
  return map;
}

describe('demo 卡片静态校验（生产同款 lint）', () => {
  for (const demo of MOTION_DEMO_CARDS) {
    it(`${demo.id}（${demo.primitive}）通过 lint，无 error 级问题`, () => {
      const tsx = buildDemoCardTsx(demo, DEFAULT_TOKENS_JSON);
      const result = lintMotionCardTsx(tsx, { requireSafeLayout: true });
      const errors = result.issues.filter((i) => i.severity === 'error');
      expect(errors, errors.map((e) => `${e.code}: ${e.message}`).join('\n')).toEqual([]);
    });
  }
});

describe('demo 卡片可编译（esbuild，与预览同链路）', () => {
  for (const demo of MOTION_DEMO_CARDS) {
    it(`${demo.id} 编译成功且含 default 导出`, async () => {
      const tsx = buildDemoCardTsx(demo, DEFAULT_TOKENS_JSON);
      const compiled = await compileCardTsx(demo.id, tsx);
      expect(compiled.error, compiled.error).toBeUndefined();
      expect(compiled.js).toBeTruthy();
      expect(compiled.js).toMatch(/exports\.default|module\.exports/);
    });
  }
});

describe('demo 注册表与 cards.segment v24 载体映射不漂移', () => {
  const mapping = parseCarrierMapping(DEFAULT_PROMPT_YAML['cards.segment']);

  it('13 个载体全部在映射中', () => {
    for (const carrier of STORYBOARD_CARRIERS) {
      expect(mapping.has(carrier), `映射缺少载体 ${carrier}`).toBe(true);
    }
  });

  it('映射里的每个原语都有 demo（可预览）', () => {
    const demoed = new Set(MOTION_DEMO_CARDS.map((d) => d.primitive));
    for (const [carrier, primitives] of mapping) {
      for (const p of primitives) {
        expect(demoed.has(p), `${carrier}→${p} 缺少 demo`).toBe(true);
      }
    }
  });

  it('每个非补充 demo 都登记在对应载体的映射里', () => {
    for (const demo of MOTION_DEMO_CARDS) {
      if (demo.supplementary) continue;
      const primitives = mapping.get(demo.carrier) ?? [];
      expect(
        primitives.includes(demo.primitive),
        `${demo.primitive} 未出现在映射 ${demo.carrier}→[${primitives.join(', ')}]`,
      ).toBe(true);
    }
  });

  it('13 个载体每个都至少有一条 demo', () => {
    for (const carrier of STORYBOARD_CARRIERS) {
      expect(
        MOTION_DEMO_CARDS.some((d) => d.carrier === carrier && !d.supplementary),
        `载体 ${carrier} 没有 demo`,
      ).toBe(true);
    }
  });

  it('分组元信息覆盖全部载体 + supplementary 组', () => {
    const carriers = new Set(MOTION_DEMO_CARRIER_META.map((m) => m.carrier));
    for (const carrier of STORYBOARD_CARRIERS) {
      expect(carriers.has(carrier), `分组元信息缺少 ${carrier}`).toBe(true);
    }
    expect(carriers.has('supplementary')).toBe(true);
  });
});

describe('demo 节拍合法性', () => {
  for (const demo of MOTION_DEMO_CARDS) {
    it(`${demo.id}：cues 单调不减且在时长预算内`, () => {
      expect(demo.cues.length).toBeGreaterThan(0);
      for (let i = 1; i < demo.cues.length; i += 1) {
        expect(demo.cues[i]).toBeGreaterThanOrEqual(demo.cues[i - 1]);
      }
      const lastCue = demo.cues[demo.cues.length - 1];
      expect(demo.durationInFrames).toBeGreaterThanOrEqual(lastCue + 30);
      // tsx 内 anchors 数量 ≤ cues + 1（第 0 拍 null + 每 cue 一拍）
      const anchorsMatch = demo.tsx.match(/useBeats\(cues, (\[[^\]]*\])/);
      expect(anchorsMatch, `${demo.id} 未找到 useBeats anchors`).toBeTruthy();
      const anchors = anchorsMatch![1].replace(/[[\]]/g, '').split(',').map((s) => s.trim());
      expect(anchors[0]).toBe('null');
      expect(anchors.length).toBeLessThanOrEqual(demo.cues.length + 1);
    });
  }
});
