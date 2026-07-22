import type { VisualStylePreset } from '../../types/ai';

const CYBER_GLITCH_COVER = `===== 视觉系统：赛博故障 封面 =====
美学锚点：CRT 故障屏 × 等宽终端字 × RGB 色差。16:9 封面是一块通电旧显示器，近黑底 + 扫描线纹理 + 青/品红色差大标题，制造赛博点击钩子。

按维度顺序组织（主体→构图→风格→美学→质量→文字排版），中文逗号串联，120-180 字：
1. 主体：一块近黑色的故障显示屏画面，中心是一句等宽大标题文字，文字带青色与品红色的固定 RGB 色差错位，无人物特写、无卡通元素。
2. 构图：标题居中或偏上压住版面，CRT 水平扫描线纹理满铺，细微噪点 grain，绝对克制的留白。
3. 风格：赛博故障美学，CRT 扫描线，RGB 色差错位，glitch art，等宽终端排版，cyberpunk terminal style。
4. 美学：近黑底 #070708，浅灰文字 #E8E8E8，单点缀青 #00D4FF，品红 #FF2EC4 仅作色差偏移，固定静态色差不要动态模糊，高对比暗调。
5. 质量：4K 超清，锐利清晰，赛博朋克视觉，故障艺术级精度。
6. 文字排版：从字幕提炼 1 条 4-10 字主标题用中文引号""…""精确包裹，等宽粗体（Space Grotesk / JetBrains Mono，Bold），占版面高度 16%-26%，浅灰填色 + 青/品红固定色差描边错位，accent 青点缀；可选 1 条 mono 大写 kicker。

强制规则：
- 主标题必用中文引号""…""精确包裹保证文字准确率；标题必等宽；整图只允许 1 主标题 + 至多 1 kicker，禁止水印 / logo / 日期。
- 青为唯一 accent，品红仅作色差偏移不大面积铺；禁止第三种彩色、禁止氛围发光圈、禁止渐变光晕。
- 色差为固定静态错位（不是运动模糊）；必近黑底 + CRT 扫描线 + 等宽字。`;

export const CYBER_GLITCH: VisualStylePreset = {
  id: 'cyber-glitch',
  name: '赛博故障',
  description: '近黑底等宽终端风：固定青/品红色差、静态 CRT 扫描线、单 accent 青、文本块逐段揭示。',
  tags: ['暗色', '赛博', '故障'],
  source: 'frame-glitch-title / deck-hermes-cyber',
  palette: { bg: '#070708', ink: '#E8E8E8', muted: '#7A7A8A', accent: '#00D4FF' },
  fonts: {
    display: "'Space Grotesk','JetBrains Mono',monospace",
    body: "'JetBrains Mono','Noto Sans SC',monospace",
    mono: "'JetBrains Mono',monospace",
  },
  facets: { cover: CYBER_GLITCH_COVER },
  motionTokens: {
    palette: { bg: '#070708', ink: '#E8E8E8', muted: '#7A7A8A', accent: '#00D4FF', track: 'rgba(232,232,232,0.12)' },
    fonts: {
      display: "'Space Grotesk','JetBrains Mono',monospace",
      body: "'JetBrains Mono','Noto Sans SC',monospace",
      mono: "'JetBrains Mono',monospace",
    },
    typeScale: { hero: 0.17, lead: 0.045, body: 0.034, label: 0.023 },
    surface: { kind: 'none' },
    ambient: { kind: 'grain', opacity: [0.04, 0.08] },
    camera: { mode: 'pan', range: [0.99, 1.01] },
    persona: { easing: 'crisp', emphasis: 'settle' },
  },
  motionStyleNotes:
    '标题用青/品红固定色差双影（text-shadow: -2px 0 #00D4FF, 2px 0 #FF2EC4，写死不逐帧抖动）；焦点元素落地帧做一次性色差 offset snap（偏移瞬间加大再回固定值，不循环）；品红仅作色差偏移色，不当第二 accent 铺色块；底层铺静态 CRT 扫描线（repeating-linear-gradient 细横纹）。',
  motionSpec: {
    chartRules: '图表使用硬边细线与终端式标签，青色标主数据，品红只作固定色差偏移。',
    emphasisRules: '焦点落定时允许一次性色差 offset snap，随后回到固定双影。',
    typographyRules: '标题使用 Space Grotesk，正文与数据标签使用 JetBrains Mono，保持终端节奏。',
    banned: '禁止逐帧抖动、持续闪烁、双 accent 大面积铺色、柔和圆角和高斯模糊正文。',
  },
  contentTypeRules: {
    data: {
      preferredCarriers: ['data-hero', 'comparison', 'trend'],
      renderingRules: '数字与标签采用终端式短字段，主数据青色落定，禁止用品红制造第二焦点。',
      density: 'normal',
    },
  },
  preview: {
    motionHtml: `<style>
  .sp-root{position:relative;width:100%;height:100%;display:grid;place-items:center;align-content:center;gap:4%;font-family:'Space Grotesk','JetBrains Mono',monospace;background:#070708;color:#E8E8E8;box-sizing:border-box;padding:7% 7%;overflow:hidden;}
  .sp-scan{position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg, rgba(0,0,0,0) 0 2px, rgba(0,0,0,0.06) 2px 3px);}
  .sp-kicker{position:relative;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#00D4FF;}
  .sp-title{position:relative;font-size:clamp(28px,9vw,68px);font-weight:700;letter-spacing:0.01em;line-height:1.05;text-shadow:-2px 0 #00D4FF, 2px 0 #FF2EC4;}
  .sp-bar{position:relative;width:18%;height:5px;background:#00D4FF;transform-origin:left;}
  .sp-sub{position:relative;font-family:'JetBrains Mono',monospace;font-size:clamp(11px,2.6vw,15px);color:#7A7A8A;line-height:1.4;}
</style>
<div class="sp-root">
  <div class="sp-scan"></div>
  <div class="sp-kicker">SYS // SIGNAL</div>
  <div class="sp-title">示例标题</div>
  <div class="sp-bar"></div>
  <div class="sp-sub">一句副标题或注解</div>
</div>
<script>
  (function(){
    var tl = gsap.timeline({ paused: true });
    tl.from('.sp-kicker', { y: 14, opacity: 0, duration: 0.4, ease: 'power2.out' })
      .from('.sp-title', { y: 24, opacity: 0, duration: 0.6, ease: 'power3.out' }, '-=0.15')
      .from('.sp-bar', { scaleX: 0, duration: 0.5, ease: 'power3.out' }, '-=0.2')
      .from('.sp-sub', { y: 14, opacity: 0, duration: 0.45, ease: 'power2.out' }, '-=0.2');
    window.__lingjiMotionTimelines = window.__lingjiMotionTimelines || [];
    window.__lingjiMotionTimelines.push(tl);
  })();
</script>`,
  },
};
