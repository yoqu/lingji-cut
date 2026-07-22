import type { VisualStylePreset } from '../../types/ai';

const FILM_LEAK_COVER = `===== 视觉系统：胶片电影 封面 =====
美学锚点：35mm 电影定格 × 信箱画幅 × 暖橙漏光片名字卡。16:9 封面是一帧被投影的电影画面：上下黑边、暖橙漏光、奶油斜体衬线大标题，制造电影质感钩子。

按维度顺序组织（主体→构图→风格→美学→质量→文字排版），中文逗号串联，120-180 字：
1. 主体：一帧电影感的暖色画面，可有真实人物剪影或一个被暖光照亮的物件，画面带暖橙漏光与细腻胶片颗粒，无卡通元素。
2. 构图：上下信箱黑边形成 2.39:1 宽银幕画幅，暖橙漏光从一角溢入，主体居中或偏置留白，奶油斜体大标题压住画幅下缘。
3. 风格：35mm 胶片电影定格，cinematic film still，暖色调电影摄影，信箱宽银幕画幅，光晕漏光 film light leak，颗粒质感。
4. 美学：暗暖棕黑底 #1A0F0A，奶油色文字 #F3EAD6，单点缀暖橙漏光 #FF8A3D，14% 胶片颗粒，无冷色无霓虹，暖调高质感。
5. 质量：4K 超清，锐利清晰，电影级调色，胶片质感大师级摄影。
6. 文字排版：从字幕提炼 1 条 4-10 字主标题用中文引号""…""精确包裹，奶油色衬线斜体粗体（思源宋体 / Georgia，Semibold italic），占版面高度 16%-26%，暖橙漏光点缀；可选 1 条 mono 时间码风 kicker。

强制规则：
- 主标题必用中文引号""…""精确包裹保证文字准确率；标题必衬线斜体；整图只允许 1 主标题 + 至多 1 kicker，禁止水印 / logo / 日期。
- 暖橙为唯一 accent，禁止冷色 / 霓虹 / 第二种彩色 / 渐变光晕乱铺。
- 必上下信箱黑边 + 暖橙漏光 + 胶片颗粒；禁止圆角卡片、卡通贴纸、冷色调。`;

const FILM_LEAK_IMAGE = `===== 视觉系统：胶片电影 段落配图 =====
美学锚点：电影内文配图 —— 一帧暖橙漏光、胶片颗粒的宽银幕画面，图内不出现任何文字。

按维度顺序组织（主体→构图→风格→美学→质量），中文逗号串联，90-150 字：
1. 主体：紧扣本段语义的电影感画面 —— 暖光照亮的剪影、被漏光笼罩的物件或场景，暖橙漏光 + 胶片颗粒，无卡通元素。
2. 构图：上下信箱黑边形成宽银幕画幅，暖橙漏光从一角溢入，主体居中或偏置留白。
3. 风格：35mm 胶片电影定格，cinematic film still，暖色调电影摄影，信箱宽银幕，光晕漏光 film light leak。
4. 美学：暗暖棕黑底 #1A0F0A，奶油暖调 #F3EAD6，单点缀暖橙漏光 #FF8A3D，14% 胶片颗粒，无冷色无霓虹。
5. 质量：4K 超清，锐利清晰，电影级调色，胶片质感大师级摄影。

强制规则：
- 图内禁止出现任何文字 / 数字标签 / 水印 / logo（段落配图不承载标题）。
- 暖橙为唯一 accent，禁止冷色 / 霓虹 / 第二 accent；必上下信箱黑边 + 暖橙漏光 + 胶片颗粒。`;

export const FILM_LEAK: VisualStylePreset = {
  id: 'film-leak',
  name: '胶片电影',
  description: '暗暖信箱画幅：奶油斜体衬线大字、暖橙径向漏光、14% 胶片颗粒、mono 时间码，亮度一次性点亮入场。',
  tags: ['暗暖', '电影', '胶片'],
  source: 'frame-light-leak-cinema',
  palette: { bg: '#1A0F0A', ink: '#F3EAD6', muted: '#B89B7A', accent: '#FF8A3D' },
  fonts: {
    display: "'Noto Serif SC','Georgia',serif",
    body: "'PingFang SC','Noto Sans SC',sans-serif",
    mono: "'JetBrains Mono',monospace",
  },
  facets: { cover: FILM_LEAK_COVER, image: FILM_LEAK_IMAGE },
  motionTokens: {
    palette: { bg: '#1A0F0A', ink: '#F3EAD6', muted: '#B89B7A', accent: '#FF8A3D', track: 'rgba(243,234,214,0.12)' },
    fonts: {
      display: "'Noto Serif SC','Georgia',serif",
      body: "'PingFang SC','Noto Sans SC',sans-serif",
      mono: "'JetBrains Mono',monospace",
    },
    typeScale: { hero: 0.16, dataHero: 0.3, lead: 0.046, label: 0.023 },
    surface: { kind: 'none' },
    ambient: { kind: 'orbs', opacity: [0.15, 0.3], color: '#FF8A3D' },
    camera: { mode: 'pull', range: [1.02, 0.98] },
    persona: { easing: 'calm', emphasis: 'brighten' },
  },
  motionStyleNotes:
    '上下各压约 12% 纯黑 letterbox 信箱黑边（固定背景层，不参与动画）；hero 用奶油色衬线 italic 电影片名字卡 + 角落 mono 时间码；整卡入场做一次性"放映机点亮"（opacity 0→1 + brightness 0.3→1，只一次不循环），底层另铺约 14% 静态胶片颗粒，禁任何冷色。',
  motionSpec: {
    chartRules: '图表只用奶油色和暖橙单色线条，降低网格存在感，避免产品仪表盘观感。',
    emphasisRules: '整卡只允许一次放映机点亮；焦点以暖橙提亮或缓慢落定完成。',
    typographyRules: 'hero 使用奶油色斜体衬线，时间、出处和单位使用角落 mono 字幕。',
    banned: '禁止冷色、霓虹、循环漏光、现代 UI 卡片、持续颗粒位移。',
  },
  contentTypeRules: {
    quote: {
      preferredCarriers: ['quote'],
      renderingRules: '金句按电影片名字卡处理，出处或时间码置于角落，保持一至两行。',
      density: 'light',
    },
    'chapter-transition': {
      preferredCarriers: ['quote', 'concept'],
      renderingRules: '仅用片名式章节标题与一次放映机点亮完成过场。',
      density: 'light',
    },
  },
  preview: {
    motionHtml: `<style>
  .sp-root{position:relative;width:100%;height:100%;display:grid;align-content:end;gap:3%;font-family:'Noto Serif SC','Georgia',serif;background:#1A0F0A;color:#F3EAD6;box-sizing:border-box;padding:12% 7%;overflow:hidden;}
  .sp-bar-top,.sp-bar-bottom{position:absolute;left:0;right:0;height:12%;background:#000000;pointer-events:none;z-index:2;}
  .sp-bar-top{top:0;}
  .sp-bar-bottom{bottom:0;}
  .sp-leak{position:absolute;inset:0;pointer-events:none;background:radial-gradient(circle at 88% 18%, rgba(255,138,61,0.4), transparent 58%);}
  .sp-grain{position:absolute;inset:0;pointer-events:none;opacity:0.14;background:repeating-linear-gradient(0deg, rgba(255,255,255,0.5) 0 1px, rgba(0,0,0,0) 1px 2px);}
  .sp-code{position:relative;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.16em;color:#FF8A3D;}
  .sp-title{position:relative;font-style:italic;font-size:clamp(26px,8.5vw,62px);font-weight:600;letter-spacing:0.01em;line-height:1.1;}
  .sp-sub{position:relative;font-family:'PingFang SC','Noto Sans SC',sans-serif;font-size:clamp(11px,2.6vw,15px);color:#B89B7A;line-height:1.45;}
</style>
<div class="sp-root" id="sp-root">
  <div class="sp-leak"></div>
  <div class="sp-grain"></div>
  <div class="sp-bar-top"></div>
  <div class="sp-bar-bottom"></div>
  <div class="sp-code">REEL 01 — 00:01:24:08</div>
  <div class="sp-title">示例标题</div>
  <div class="sp-sub">一句副标题或注解</div>
</div>
<script>
  (function(){
    var tl = gsap.timeline({ paused: true });
    tl.from('#sp-root', { opacity: 0, filter: 'brightness(0.3)', duration: 0.7, ease: 'power2.out' })
      .from('.sp-code', { y: 14, opacity: 0, duration: 0.4, ease: 'power2.out' }, '-=0.2')
      .from('.sp-title', { y: 22, opacity: 0, duration: 0.6, ease: 'power3.out' }, '-=0.2')
      .from('.sp-sub', { y: 14, opacity: 0, duration: 0.45, ease: 'power2.out' }, '-=0.2');
    window.__lingjiMotionTimelines = window.__lingjiMotionTimelines || [];
    window.__lingjiMotionTimelines.push(tl);
  })();
</script>`,
  },
};
