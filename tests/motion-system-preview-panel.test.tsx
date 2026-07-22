/**
 * MotionSystemPreviewPanel 轻测：node 环境 renderToStaticMarkup（effects 不执行，
 * 编译 mock 返回空映射 → 每格渲染占位，Player 不挂载），只断言分组与原语清单完整。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MotionSystemPreviewPanel } from '../src/components/settings/MotionSystemPreviewPanel';
import { MOTION_DEMO_CARDS, MOTION_DEMO_CARRIER_META } from '../src/remotion/motion-kit/demo-cards';

describe('MotionSystemPreviewPanel', () => {
  beforeAll(() => {
    (globalThis as { window?: unknown }).window = {
      electronAPI: { compileMotionCards: async () => ({}) },
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    };
  });

  it('渲染全部载体分组与每个原语名', () => {
    const html = renderToStaticMarkup(
      <MotionSystemPreviewPanel
        presetId="editorial-eink"
        scope="global"
        onScopeChange={() => undefined}
        hasProject={false}
      />,
    );

    for (const meta of MOTION_DEMO_CARRIER_META) {
      expect(html, `缺少分组 ${meta.label}`).toContain(meta.label);
      expect(html, `缺少分组描述 ${meta.label}`).toContain(meta.description);
    }
    for (const demo of MOTION_DEMO_CARDS) {
      expect(html, `缺少原语 ${demo.primitive}`).toContain(demo.primitive);
      expect(html, `缺少 ${demo.id} 的用途说明`).toContain(demo.summary);
    }
    // 当前生效风格名应出现（editorial-eink = 电子杂志墨水）
    expect(html).toContain('电子杂志墨水');
  });

  it('无编译能力时降级为说明文案', () => {
    (globalThis as { window?: unknown }).window = { electronAPI: {} };
    const html = renderToStaticMarkup(
      <MotionSystemPreviewPanel
        presetId="editorial-eink"
        scope="global"
        onScopeChange={() => undefined}
        hasProject={false}
      />,
    );
    expect(html).toContain('当前环境不支持动效编译预览');
  });
});
