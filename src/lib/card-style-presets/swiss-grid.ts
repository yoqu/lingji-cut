import type { VisualStylePreset } from '../../types/ai';

const SWISS_GRID_COVER = `===== 视觉系统：瑞士国际主义网格 封面 =====
美学锚点：国际主义海报 × 严格栅格 × 巨字号留白。16:9 封面是一张对齐网格的极简海报，靠字号与留白制造张力，不靠人物特写或卡通元素。

按以下维度顺序组织提示词（主体→构图→风格→美学→质量→文字排版），中文逗号串联，整体 120-180 字：
1. 主体：一个极简的几何或排版主体（巨大无衬线标题占据左半版面，或单个对齐网格的抽象几何块），暖白底面，无人物特写、无卡通元素。
2. 构图：严格 16 栏网格对齐，左对齐上对齐，大面积负空间留白，主元素吸附列基线，绝对直角不留圆角。
3. 风格：瑞士国际主义平面设计，Helvetica/Inter Tight 排版海报，极简栅格设计，Josef Müller-Brockmann style。
4. 美学：暖白底 #FAF8F2，纯黑墨 #111111，单点缀克莱因蓝 #0033A0，1px hairline 分隔，无阴影无渐变无发光，高对比极简。
5. 质量：4K 超清，锐利清晰，专业平面设计排版，海报级精度。
6. 文字排版：从字幕提炼 1 条 4-10 字主标题用中文引号""…""精确包裹，超大无衬线粗体（Inter Tight / Helvetica，Bold/Black），左对齐占版面高度 18%-28%，纯黑墨填色，仅 1 个词或 1 条短色条用克莱因蓝点缀；可选 1 条 mono 大写小字 kicker。

强制规则：
- 主标题必用中文引号""…""精确包裹以保证文字准确率；整图只允许 1 条主标题 + 至多 1 条 kicker，禁止水印 / logo / 日期 / 二维码。
- 克莱因蓝全图只能 1 处点缀，禁止第二种彩色、禁止霓虹、禁止渐变。
- 必须暖白底 + 纯黑墨 + 直角栅格；禁止圆角卡片、阴影、人物大头照、卡通贴纸。`;

export const SWISS_GRID: VisualStylePreset = {
  id: 'swiss-grid',
  name: '瑞士国际主义',
  description: '暖白底 16 栏栅格、极致字号对比、绝对直角 1px hairline、单点缀克莱因蓝。',
  tags: ['浅色', '网格', '极简'],
  source: 'deck-swiss-international',
  palette: { bg: '#FAF8F2', ink: '#111111', muted: '#6B6B6B', accent: '#0033A0' },
  fonts: {
    display: "'Inter Tight','Helvetica Neue',Arial,sans-serif",
    body: "'Inter','Noto Sans SC',sans-serif",
    mono: "'JetBrains Mono',monospace",
  },
  facets: { cover: SWISS_GRID_COVER },
  motionTokens: {
    palette: { bg: '#FAF8F2', ink: '#111111', muted: '#6B6B6B', accent: '#0033A0', track: 'rgba(17,17,17,0.12)' },
    fonts: {
      display: "'Inter Tight','Helvetica Neue',Arial,sans-serif",
      body: "'Inter','Noto Sans SC',sans-serif",
      mono: "'JetBrains Mono',monospace",
    },
    typeScale: { hero: 0.2, dataHero: 0.3, lead: 0.057, body: 0.036, label: 0.023 },
    surface: { kind: 'none' },
    ambient: { kind: 'grid', opacity: [0.04, 0.06] },
    camera: { mode: 'still' },
    persona: { easing: 'crisp', emphasis: 'settle' },
  },
  motionStyleNotes:
    '一切元素吸附 16 栏隐形网格的列基线（左对齐、上对齐，禁 flex 居中堆叠），最大与最小字号比 ≥6:1；borderRadius 恒为 0，克莱因蓝整卡只出现 1 次；accent 色条 scaleX 揭示到位后做一次 2-3px overshoot 微冲。',
  preview: {
    motionHtml: `<style>
  .sp-root{width:100%;height:100%;display:grid;grid-template-columns:repeat(16,1fr);grid-template-rows:1fr auto auto;gap:4%;font-family:'Inter Tight','Helvetica Neue',Arial,sans-serif;background:#FAF8F2;color:#111111;box-sizing:border-box;padding:7% 6%;align-content:end;}
  .sp-kicker{grid-column:1 / 7;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#6B6B6B;}
  .sp-title{grid-column:1 / 14;font-size:clamp(28px,9vw,72px);font-weight:700;letter-spacing:-0.02em;line-height:0.98;}
  .sp-bar{grid-column:1 / 5;height:6px;background:#0033A0;transform-origin:left;}
  .sp-sub{grid-column:1 / 12;font-size:clamp(11px,2.6vw,16px);font-weight:500;color:#6B6B6B;line-height:1.3;}
</style>
<div class="sp-root">
  <div class="sp-kicker">VOL. 01 — GRID SYSTEM</div>
  <div class="sp-title">示例标题</div>
  <div class="sp-bar"></div>
  <div class="sp-sub">一句副标题或注解</div>
</div>
<script>
  (function(){
    var tl = gsap.timeline({ paused: true });
    tl.from('.sp-kicker', { y: 16, opacity: 0, duration: 0.4, ease: 'power2.out' })
      .from('.sp-title', { y: 24, opacity: 0, duration: 0.6, ease: 'power3.out' }, '-=0.15')
      .from('.sp-bar', { scaleX: 0, duration: 0.5, ease: 'power3.out' }, '-=0.2')
      .from('.sp-sub', { y: 14, opacity: 0, duration: 0.45, ease: 'power2.out' }, '-=0.2');
    window.__lingjiMotionTimelines = window.__lingjiMotionTimelines || [];
    window.__lingjiMotionTimelines.push(tl);
  })();
</script>`,
  },
};
