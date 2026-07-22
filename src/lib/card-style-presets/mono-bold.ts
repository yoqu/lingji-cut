import type { VisualStylePreset } from '../../types/ai';

const MONO_BOLD_COVER = `===== 视觉系统：极简大字 封面 =====
美学锚点：极简导航 deck × 单色满版 × 超大粗体标题。16:9 封面极致克制：单色深底满铺 + 占画面大比例的超大粗体标题 + 一条 4px 亮黄短色条，靠大字冲击制造钩子。

按维度顺序组织（主体→构图→风格→美学→质量→文字排版），中文逗号串联，120-180 字：
1. 主体：画面主体就是超大粗体标题文字本身，占据画面大比例，无人物特写、无卡通元素、无多余图形。
2. 构图：单色深底满铺，超大标题居中或居左压满版面，一条 4px 亮黄短色条作视觉锚点，极致留白克制。
3. 风格：极简大字海报，单色满版，超大粗体 display 排版，瑞士极简，editorial bold typography，minimal poster。
4. 美学：单色深底 #1B1B1F，近白文字 #F5F5F0，单点缀亮黄 #FFE600 短色条，纯净无渐变无光晕无阴影，高对比克制。
5. 质量：4K 超清，锐利清晰，专业排版视觉，极简海报级精度。
6. 文字排版：从字幕提炼 1 条 4-10 字主标题用中文引号""…""精确包裹，超粗无衬线（Inter Tight / Helvetica Neue，Black 800-900），占版面高度 22%-32%（必须超大），近白填色，配 1 条 4px 亮黄短色条；可选 1 条 mono 小字 kicker。

强制规则：
- 主标题必用中文引号""…""精确包裹保证文字准确率；整图只允许 1 主标题 + 至多 1 kicker，禁止水印 / logo / 日期。
- 亮黄为唯一 accent 且仅作短色条 / 焦点，禁止第二种彩色、禁止渐变 / 光晕 / 阴影氛围。
- 必单色满版深底 + 超大粗体标题 + 4px 亮黄短色条；禁止浅底、纹理、卡通贴纸。`;

export const MONO_BOLD: VisualStylePreset = {
  id: 'mono-bold',
  name: '极简大字',
  description: '单色满版深底：占画面大比例的超大粗体标题、4px 亮黄短色条 scaleX 揭示、mono 箭头前缀列表，极致克制。',
  tags: ['高对比', '极简', '大字'],
  source: 'deck-dir-key-nav / deck-simple',
  palette: { bg: '#1B1B1F', ink: '#F5F5F0', muted: '#8A8A82', accent: '#FFE600' },
  fonts: {
    display: "'Inter Tight','Helvetica Neue',sans-serif",
    body: "'Inter','Noto Sans SC',sans-serif",
    mono: "'JetBrains Mono',monospace",
  },
  facets: { cover: MONO_BOLD_COVER },
  motionTokens: {
    palette: { bg: '#1B1B1F', ink: '#F5F5F0', muted: '#8A8A82', accent: '#FFE600', track: 'rgba(245,245,240,0.12)' },
    fonts: {
      display: "'Inter Tight','Helvetica Neue',sans-serif",
      body: "'Inter','Noto Sans SC',sans-serif",
      mono: "'JetBrains Mono',monospace",
    },
    typeScale: { hero: 0.23, dataHero: 0.35, lead: 0.046, body: 0.037 },
    surface: { kind: 'none' },
    ambient: { kind: 'none' },
    camera: { mode: 'pan', range: [0.985, 1.015] },
    persona: { easing: 'crisp', emphasis: 'settle' },
  },
  motionStyleNotes:
    '超大标题是绝对焦点（字重 800-900、lineHeight 0.95），hero 用重砸式入场（全卡唯一鼓励 overshoot 的场景）；唯一彩色装饰是一条 4px 亮黄短色条，scaleX 揭示到位后 105%→100% 微冲收敛；列表项一律 mono "→" 箭头前缀逐项硬切，底面纯净单色无任何氛围层。',
  motionSpec: {
    chartRules: '图表使用黑白高反差与单根亮黄焦点条，标签简短且靠统一基线。',
    emphasisRules: 'hero 可重砸入场并短暂 overshoot；亮黄色条只在落定时微冲一次。',
    typographyRules: '标题使用 800-900 超粗无衬线，正文使用 Inter，列表前缀和数据标签使用 mono。',
    banned: '禁止氛围装饰、圆角卡片、渐变、第二 accent、柔和漂移和长段正文。',
  },
  contentTypeRules: {
    'chapter-transition': {
      preferredCarriers: ['concept', 'quote'],
      renderingRules: '只保留一行超大章节标题与一条亮黄色短线，不添加解释文本。',
      density: 'light',
    },
    data: {
      preferredCarriers: ['data-hero', 'comparison'],
      renderingRules: '用一个超大数字或双项对决制造冲击，其他数据退为 mono 小标签。',
      density: 'normal',
    },
  },
  preview: {
    motionHtml: `<style>
  .sp-root{position:relative;width:100%;height:100%;display:grid;align-content:center;gap:4%;font-family:'Inter Tight','Helvetica Neue',sans-serif;background:#1B1B1F;color:#F5F5F0;box-sizing:border-box;padding:8% 7%;overflow:hidden;}
  .sp-kicker{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#8A8A82;}
  .sp-title{font-size:clamp(34px,11vw,84px);font-weight:800;letter-spacing:-0.02em;line-height:0.95;}
  .sp-bar{width:16%;height:4px;background:#FFE600;transform-origin:left;}
  .sp-list{display:grid;gap:6px;font-family:'JetBrains Mono',monospace;font-size:clamp(11px,2.6vw,15px);color:#8A8A82;letter-spacing:0.02em;}
</style>
<div class="sp-root">
  <div class="sp-kicker">SECTION 01</div>
  <div class="sp-title">示例标题</div>
  <div class="sp-bar"></div>
  <div class="sp-list">
    <div class="sp-item">→ 第一条要点</div>
    <div class="sp-item">→ 第二条要点</div>
  </div>
</div>
<script>
  (function(){
    var tl = gsap.timeline({ paused: true });
    tl.from('.sp-kicker', { y: 12, opacity: 0, duration: 0.4, ease: 'power2.out' })
      .from('.sp-title', { y: 24, opacity: 0, duration: 0.6, ease: 'power3.out' }, '-=0.15')
      .from('.sp-bar', { scaleX: 0, duration: 0.5, ease: 'power3.out' }, '-=0.2')
      .from('.sp-item', { y: 14, opacity: 0, duration: 0.4, stagger: 0.1, ease: 'power2.out' }, '-=0.2');
    window.__lingjiMotionTimelines = window.__lingjiMotionTimelines || [];
    window.__lingjiMotionTimelines.push(tl);
  })();
</script>`,
  },
};
