import type { VisualStylePreset } from '../../types/ai';

const NYT_DATA_COVER = `===== 视觉系统：NYT 数据社论 封面 =====
美学锚点：纽约时报数据社论头图 × 手绘折线图 × 衬线权威标题。16:9 封面是一张「数据 + 社论标题」的暖白底图，靠一条手绘感折线 / 一组柱状图 + serif 大标题制造权威钩子。

按维度顺序组织（主体→构图→风格→美学→质量→文字排版），中文逗号串联，120-180 字：
1. 主体：一条手绘风格的折线图或一组简洁柱状图作为视觉主体，单墨色线条 + 1 条新闻红焦点线 / 焦点柱，暖白纸面，无人物、无卡通元素。
2. 构图：图表占据画面中部或左侧，serif 大标题压住上方或下方，留白克制，hairline 网格基线，绝对直角。
3. 风格：纽约时报数据社论风，The Upshot data journalism style，手绘折线图，编辑设计排版，报纸社论美学。
4. 美学：暖白底 #F7F5EE，纯墨 #121212，单点缀新闻红 #A91D1D，单墨色数据可视化，无渐变无发光，高对比克制。
5. 质量：4K 超清，锐利清晰，专业编辑设计，数据新闻级精度。
6. 文字排版：从字幕提炼 1 条 6-12 字 serif 主标题用中文引号""…""精确包裹，衬线粗体（思源宋体 / Georgia，Semibold），占版面高度 14%-22%，纯墨色填色；可选 1 条 11px mono 大写 kicker 用新闻红点缀。

强制规则：
- 主标题必用中文引号""…""精确包裹保证文字准确率；标题必衬线；整图只允许 1 主标题 + 至多 1 mono kicker，禁止水印 / logo / 日期。
- 新闻红全图只 1 处焦点点缀，禁止彩虹数据色、禁止第二种彩色、禁止渐变填充。
- 必暖白底 + 单墨数据图 + 直角；禁止圆角卡片、阴影、3D 立体图表、卡通贴纸。`;

const NYT_DATA_IMAGE = `===== 视觉系统：NYT 数据社论 段落配图 =====
美学锚点：社论内文配图 —— 一张单墨色 + 新闻红的手绘感数据示意图，图内不出现任何文字。

按维度顺序组织（主体→构图→风格→美学→质量），中文逗号串联，90-150 字：
1. 主体：紧扣本段语义的抽象数据示意 —— 一条手绘折线、一组简洁柱、一个标点圆点的趋势图，单墨色线条 + 1 条新闻红焦点，暖白纸面。
2. 构图：图形居中或偏置留白，hairline 基线，绝对直角，不留圆角。
3. 风格：纽约时报数据社论配图，手绘折线图，编辑插画，单墨色数据可视化。
4. 美学：暖白底 #F7F5EE，纯墨 #121212，单点缀新闻红 #A91D1D，无渐变无发光，克制高对比。
5. 质量：4K 超清，锐利清晰，专业编辑插画精度。

强制规则：
- 图内禁止出现任何文字 / 数字标签 / 水印 / logo（段落配图不承载标题）。
- 新闻红只 1 处焦点，禁止彩虹色、第二 accent、渐变；必暖白底 + 单墨数据图 + 直角。`;

export const NYT_DATA: VisualStylePreset = {
  id: 'nyt-data',
  name: 'NYT 数据社论',
  description: '暖白社论风：serif 大标题、手绘 SVG 折线/柱、单墨色 + 新闻红 accent、等宽脚注。',
  tags: ['暖白', '数据', '社论'],
  source: 'frame-data-chart-nyt',
  palette: { bg: '#F7F5EE', ink: '#121212', muted: '#6E6E6E', accent: '#A91D1D' },
  fonts: {
    display: "'Noto Serif SC','Georgia',serif",
    body: "'PingFang SC','Noto Sans SC',sans-serif",
    mono: "'JetBrains Mono',monospace",
  },
  facets: { cover: NYT_DATA_COVER, image: NYT_DATA_IMAGE },
  motionTokens: {
    palette: { bg: '#F7F5EE', ink: '#121212', muted: '#6E6E6E', accent: '#A91D1D', track: 'rgba(18,18,18,0.12)' },
    fonts: {
      display: "'Noto Serif SC','Georgia',serif",
      body: "'PingFang SC','Noto Sans SC',sans-serif",
      mono: "'JetBrains Mono',monospace",
    },
    typeScale: { hero: 0.14, dataHero: 0.3, lead: 0.046, label: 0.02 },
    surface: { kind: 'none' },
    ambient: { kind: 'grain', opacity: [0.04, 0.06] },
    camera: { mode: 'push', range: [0.985, 1.015] },
    persona: { easing: 'calm', emphasis: 'brighten' },
  },
  motionStyleNotes:
    '社论证据感：大标题与数据数字必用衬线 display，kicker / 脚注必 mono；图表纯 SVG 描线揭示（折线 strokeDashoffset、柱 height 单调一次到位），焦点线用 accent、对照线用 muted，禁彩虹多色；数字到终值用字色短暂加深强调，不做位移缩放。',
  motionSpec: {
    chartRules: '折线纯描线揭示，柱形保持直角；焦点线用新闻红，对照线与网格用 muted hairline。',
    emphasisRules: '数字到终值只做字色加深或轻微提亮，不做位移、缩放或弹跳。',
    typographyRules: '标题和数据数字使用衬线 display；kicker、单位、来源和脚注使用 mono。',
    banned: '禁止彩虹数据色、渐变填充、3D 图表、圆角卡片和循环脉冲。',
  },
  contentTypeRules: {
    data: {
      preferredCarriers: ['trend', 'data-hero', 'comparison'],
      renderingRules: '先展示证据图表或核心数字，单位和时间范围必须完整；焦点仅使用新闻红。',
      density: 'heavy',
    },
    quote: {
      preferredCarriers: ['quote'],
      renderingRules: '使用报刊引文版式，衬线金句配 mono 来源，不使用装饰卡片。',
      density: 'light',
    },
  },
  preview: {
    motionHtml: `<style>
  .sp-root{width:100%;height:100%;display:flex;flex-direction:column;justify-content:flex-end;gap:4%;font-family:'Noto Serif SC','Georgia',serif;background:#F7F5EE;color:#121212;box-sizing:border-box;padding:7% 7%;}
  .sp-kicker{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#A91D1D;}
  .sp-chart{width:100%;height:38%;}
  .sp-line{fill:none;stroke:#A91D1D;stroke-width:3;stroke-linecap:round;stroke-linejoin:round;}
  .sp-base{stroke:rgba(18,18,18,0.2);stroke-width:1;}
  .sp-title{font-size:clamp(22px,6vw,46px);font-weight:600;line-height:1.1;}
  .sp-sub{font-family:'PingFang SC','Noto Sans SC',sans-serif;font-size:clamp(11px,2.6vw,15px);color:#6E6E6E;line-height:1.45;}
</style>
<div class="sp-root">
  <div class="sp-kicker">THE UPSHOT — DATA</div>
  <svg class="sp-chart" viewBox="0 0 300 100" preserveAspectRatio="none">
    <line class="sp-base" x1="0" y1="92" x2="300" y2="92"></line>
    <polyline class="sp-line" points="6,80 70,58 130,66 200,28 294,12"></polyline>
  </svg>
  <div class="sp-title">示例标题</div>
  <div class="sp-sub">一句副标题或注解</div>
</div>
<script>
  (function(){
    var tl = gsap.timeline({ paused: true });
    var line = document.querySelector('.sp-line');
    var len = line && line.getTotalLength ? line.getTotalLength() : 400;
    if (line) { line.style.strokeDasharray = len; line.style.strokeDashoffset = len; }
    tl.from('.sp-kicker', { y: 14, opacity: 0, duration: 0.4, ease: 'power2.out' })
      .to('.sp-line', { strokeDashoffset: 0, duration: 0.9, ease: 'power2.out' }, '-=0.1')
      .from('.sp-title', { y: 22, opacity: 0, duration: 0.55, ease: 'power3.out' }, '-=0.4')
      .from('.sp-sub', { y: 14, opacity: 0, duration: 0.45, ease: 'power2.out' }, '-=0.2');
    window.__lingjiMotionTimelines = window.__lingjiMotionTimelines || [];
    window.__lingjiMotionTimelines.push(tl);
  })();
</script>`,
  },
};
