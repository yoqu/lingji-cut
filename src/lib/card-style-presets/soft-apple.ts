import type { VisualStylePreset } from '../../types/ai';

const SOFT_APPLE_COVER = `===== 视觉系统：温柔苹果 封面 =====
美学锚点：Apple 产品发布视觉 × 银白奶油底 × squircle 大圆角卡。16:9 封面是一帧高级产品界面：银白底 + 环境柔光、squircle 圆角卡、柔和阴影、系统蓝点缀大标题，制造高级感钩子。

按维度顺序组织（主体→构图→风格→美学→质量→文字排版），中文逗号串联，120-180 字：
1. 主体：一个银白质感的 squircle 大圆角卡片或简洁产品界面元素作为视觉主体，柔和悬浮，无人物特写、无卡通元素。
2. 构图：银白奶油底 + 环境柔光，主体卡片居中悬浮带柔和大范围阴影，squircle 大圆角，留白克制高级，大标题压住版面。
3. 风格：Apple Human Interface 风，苹果产品发布会视觉，squircle 圆角，玻璃柔光质感，minimal premium UI，soft web prototype。
4. 美学：银白奶油底 #F0F1F4，近黑文字 #1D1D1F，单点缀系统蓝 #0A84FF，环境柔光，柔和阴影，无霓虹无硬阴影，高级克制。
5. 质量：4K 超清，锐利清晰，专业产品视觉，苹果发布会级精度。
6. 文字排版：从字幕提炼 1 条 4-10 字主标题用中文引号""…""精确包裹，无衬线粗体（SF Pro Display / 苹方，Semibold），占版面高度 16%-26%，近黑填色，仅 1 处系统蓝点缀；可选 1 条 mono 小字 kicker。

强制规则：
- 主标题必用中文引号""…""精确包裹保证文字准确率；整图只允许 1 主标题 + 至多 1 kicker，禁止水印 / logo / 日期。
- 系统蓝为唯一 accent，禁止霓虹 / 高饱和渐变 / 第二种彩色。
- 必银白奶油底 + squircle 大圆角 + 柔和阴影；禁止直角硬边、卡通贴纸、暗黑底。`;

const SOFT_APPLE_IMAGE = `===== 视觉系统：温柔苹果 段落配图 =====
美学锚点：苹果界面内文配图 —— 一帧银白柔光、squircle 圆角的抽象产品质感画面，图内不出现任何文字。

按维度顺序组织（主体→构图→风格→美学→质量），中文逗号串联，90-150 字：
1. 主体：紧扣本段语义的抽象产品质感画面 —— 一个 squircle 大圆角卡、一组柔和悬浮的界面元素或玻璃质感几何，银白柔光，无卡通元素。
2. 构图：银白奶油底 + 环境柔光，主体居中悬浮带柔和阴影，squircle 大圆角，留白克制。
3. 风格：Apple Human Interface 风，苹果产品视觉，squircle 圆角，玻璃柔光质感，minimal premium UI。
4. 美学：银白奶油底 #F0F1F4，近黑 #1D1D1F，单点缀系统蓝 #0A84FF，环境柔光，柔和阴影，无霓虹无硬阴影。
5. 质量：4K 超清，锐利清晰，专业产品视觉，苹果发布会级精度。

强制规则：
- 图内禁止出现任何文字 / 数字标签 / 水印 / logo（段落配图不承载标题）。
- 系统蓝为唯一 accent，禁止霓虹 / 高饱和渐变 / 第二 accent；必银白奶油底 + squircle 大圆角 + 柔和阴影。`;

export const SOFT_APPLE: VisualStylePreset = {
  id: 'soft-apple',
  name: '温柔苹果',
  description: '银白奶油底 + 环境柔光：squircle 大圆角卡、嵌套半径双描边、柔和阴影、克制弹性微动，单点缀系统蓝。',
  tags: ['浅色', '柔和', '高级'],
  source: 'web-proto-soft',
  palette: { bg: '#F0F1F4', ink: '#1D1D1F', muted: '#6E6E73', accent: '#0A84FF' },
  fonts: {
    display: "'SF Pro Display','PingFang SC',-apple-system,sans-serif",
    body: "'SF Pro Text','PingFang SC',-apple-system,sans-serif",
    mono: "'SF Mono',monospace",
  },
  facets: { cover: SOFT_APPLE_COVER, image: SOFT_APPLE_IMAGE },
  motionTokens: {
    palette: { bg: '#F0F1F4', ink: '#1D1D1F', muted: '#6E6E73', accent: '#0A84FF', track: 'rgba(29,29,31,0.12)' },
    fonts: {
      display: "'SF Pro Display','PingFang SC',-apple-system,sans-serif",
      body: "'SF Pro Text','PingFang SC',-apple-system,sans-serif",
      mono: "'SF Mono',monospace",
    },
    typeScale: { hero: 0.14, dataHero: 0.3, lead: 0.046, label: 0.025 },
    surface: { kind: 'panel', bg: '#FBFBFD', border: 'rgba(29,29,31,0.08)', radius: 24 },
    ambient: { kind: 'orbs', opacity: [0.2, 0.3], color: '#FFFFFF' },
    camera: { mode: 'push', range: [0.99, 1.01] },
    persona: { easing: 'bouncy', emphasis: 'settle' },
  },
  motionStyleNotes:
    'squircle 浮起卡是本体：嵌套子卡内圆角按 concentric（外圆角 − 内边距）收敛，双层 hairline 描边（外 rgba(29,29,31,0.08)、内 rgba(255,255,255,0.7)）+ 柔和大范围阴影 0 12px 32px rgba(29,29,31,0.10)；柔弹回弹须落在 scale ≤1.04 内，一次性收敛，不做无限 spring 物理。',
  preview: {
    motionHtml: `<style>
  .sp-root{position:relative;width:100%;height:100%;display:grid;place-content:center;gap:5%;font-family:'SF Pro Display','PingFang SC',-apple-system,sans-serif;background:#F0F1F4;color:#1D1D1F;box-sizing:border-box;padding:7% 6%;overflow:hidden;}
  .sp-glow{position:absolute;inset:0;pointer-events:none;background:radial-gradient(circle at 50% 28%, rgba(255,255,255,0.65), transparent 60%);}
  .sp-card{position:relative;justify-self:center;background:#FBFBFD;border-radius:24px;padding:7% 8%;box-shadow:0 12px 32px rgba(29,29,31,0.1);border:1px solid rgba(29,29,31,0.08);display:grid;gap:14px;text-align:center;}
  .sp-kicker{font-family:'SF Mono',monospace;font-size:11px;letter-spacing:0.06em;color:#0A84FF;text-transform:uppercase;}
  .sp-title{font-size:clamp(24px,7vw,52px);font-weight:600;letter-spacing:-0.01em;line-height:1.1;}
  .sp-sub{font-size:clamp(11px,2.6vw,15px);color:#6E6E73;line-height:1.45;}
</style>
<div class="sp-root">
  <div class="sp-glow"></div>
  <div class="sp-card">
    <div class="sp-kicker">Overview</div>
    <div class="sp-title">示例标题</div>
    <div class="sp-sub">一句副标题或注解</div>
  </div>
</div>
<script>
  (function(){
    var tl = gsap.timeline({ paused: true });
    tl.from('.sp-card', { y: 26, opacity: 0, scale: 0.97, duration: 0.6, ease: 'back.out(1.3)' })
      .from('.sp-kicker', { y: 10, opacity: 0, duration: 0.4, ease: 'power2.out' }, '-=0.25')
      .from('.sp-title', { y: 14, opacity: 0, duration: 0.5, ease: 'power3.out' }, '-=0.25')
      .from('.sp-sub', { y: 12, opacity: 0, duration: 0.45, ease: 'power2.out' }, '-=0.25');
    window.__lingjiMotionTimelines = window.__lingjiMotionTimelines || [];
    window.__lingjiMotionTimelines.push(tl);
  })();
</script>`,
  },
};
