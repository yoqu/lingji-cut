import type { VisualStylePreset } from '../../types/ai';

const XHS_PASTEL_COVER = `===== 视觉系统：小红书柔彩 封面 =====
美学锚点：小红书图文封面 × 马卡龙柔彩 × Playfair 斜体大字。16:9 封面是一张奶油底精致生活卡：柔焦马卡龙色块 + 大圆角柔卡 + 斜体衬线大标题，制造柔和点击钩子。

按维度顺序组织（主体→构图→风格→美学→质量→文字排版），中文逗号串联，120-180 字：
1. 主体：一张奶油底的精致马卡龙大圆角柔卡或柔和生活质感画面作为视觉主体，柔和悬浮，无人物特写、无卡通元素。
2. 构图：奶油白底，角落 2-3 个柔焦马卡龙色块（粉 / 薄荷 / 天蓝）点缀氛围，主体卡片居中柔和大圆角，斜体大标题压住版面，柔和留白。
3. 风格：小红书图文卡风，马卡龙柔彩，pastel aesthetic，柔焦色块，大圆角柔和卡，精致生活笔记感。
4. 美学：奶油白底 #FEF8F1，柔黑文字 #3A3A3A，单点缀马卡龙粉 #FF9EB5，辅以薄荷 #9EE6C8 / 天蓝 #A9D7F5 柔焦色块，柔和无霓虹无暗调。
5. 质量：4K 超清，锐利清晰，柔和精致质感，小红书爆款封面级精度。
6. 文字排版：从字幕提炼 1 条 4-10 字主标题用中文引号""…""精确包裹，衬线斜体（Playfair Display Italic / 思源宋体，Semibold），占版面高度 16%-26%，柔黑或马卡龙粉填色，accent 粉点缀；可选 1 条 mono 小字 01 编号 kicker。

强制规则：
- 主标题必用中文引号""…""精确包裹保证文字准确率；整图只允许 1 主标题 + 至多 1 kicker，禁止水印 / logo / 日期。
- 马卡龙粉为唯一语义 accent，薄荷 / 天蓝仅作柔焦色块不抢焦点，禁止高饱和霓虹 / 暗黑底。
- 必奶油白底 + 柔焦马卡龙色块 + 大圆角柔卡；禁止直角硬边、卡通贴纸、暗黑底。`;

const XHS_PASTEL_IMAGE = `===== 视觉系统：小红书柔彩 段落配图 =====
美学锚点：小红书图文内文配图 —— 一帧奶油底、柔焦马卡龙色块、大圆角柔和的生活质感画面，图内不出现任何文字。

按维度顺序组织（主体→构图→风格→美学→质量），中文逗号串联，90-150 字：
1. 主体：紧扣本段语义的柔和生活质感画面 —— 一组柔焦马卡龙色块、柔和悬浮的圆角元素或精致静物，奶油柔光，无卡通元素。
2. 构图：奶油白底，角落 2-3 个柔焦马卡龙色块（粉 / 薄荷 / 天蓝）点缀，主体居中柔和大圆角，柔和留白。
3. 风格：小红书图文配图风，马卡龙柔彩，pastel aesthetic，柔焦色块，大圆角柔和质感。
4. 美学：奶油白底 #FEF8F1，柔黑 #3A3A3A，单点缀马卡龙粉 #FF9EB5，薄荷 #9EE6C8 / 天蓝 #A9D7F5 柔焦色块，柔和无霓虹无暗调。
5. 质量：4K 超清，锐利清晰，柔和精致质感，小红书图文级精度。

强制规则：
- 图内禁止出现任何文字 / 数字标签 / 水印 / logo（段落配图不承载标题）。
- 马卡龙粉为唯一语义 accent，薄荷 / 天蓝仅作柔焦色块；必奶油白底 + 柔焦色块 + 大圆角柔和，禁止暗黑底 / 霓虹。`;

export const XHS_PASTEL: VisualStylePreset = {
  id: 'xhs-pastel',
  name: '小红书柔彩',
  description: '奶油底马卡龙柔彩：3 柔焦色块、≈28px 大圆角卡、Playfair 斜体显示字、01-04 编号序列依次揭示，单点缀马卡龙粉。',
  tags: ['浅色', '柔彩', '生活'],
  source: 'deck-xhs-pastel / card-xiaohongshu',
  palette: { bg: '#FEF8F1', ink: '#3A3A3A', muted: '#9A8E84', accent: '#FF9EB5' },
  fonts: {
    display: "'Playfair Display','Noto Serif SC',serif",
    body: "'PingFang SC','Noto Sans SC',sans-serif",
    mono: "'JetBrains Mono',monospace",
  },
  facets: { cover: XHS_PASTEL_COVER, image: XHS_PASTEL_IMAGE },
  motionTokens: {
    palette: { bg: '#FEF8F1', ink: '#3A3A3A', muted: '#9A8E84', accent: '#FF9EB5', track: 'rgba(58,58,58,0.12)' },
    fonts: {
      display: "'Playfair Display','Noto Serif SC',serif",
      body: "'PingFang SC','Noto Sans SC',sans-serif",
      mono: "'JetBrains Mono',monospace",
    },
    typeScale: { hero: 0.14, dataHero: 0.28, lead: 0.046, label: 0.035 },
    surface: { kind: 'panel', bg: 'rgba(255,255,255,0.72)', radius: 28 },
    ambient: { kind: 'orbs', opacity: [0.18, 0.3], color: '#FF9EB5' },
    camera: { mode: 'still' },
    persona: { easing: 'bouncy', emphasis: 'settle' },
  },
  motionStyleNotes:
    'hero 用 Playfair italic 斜体衬线；要点用 01 / 02 / 03 mono 编号（accent 粉）引导，像清单笔记；辅助薄荷 #9EE6C8 / 天蓝 #A9D7F5 只作角落柔焦氛围色块，不当语义 accent；圆角卡落地回弹 scale ≤1.03（比"温柔苹果"更轻），8-12 帧收敛。',
  motionSpec: {
    chartRules: '数据结构保持轻量，马卡龙粉只标主项，薄荷与天蓝仅作低权重氛围或轨道。',
    emphasisRules: '面板以轻弹进入并在 scale 1.03 内收敛；重点用粉色编号或下划线。',
    typographyRules: 'hero 使用 Playfair 斜体衬线，编号与来源使用 mono，正文保持柔和无衬线。',
    banned: '禁止暗黑底、霓虹、厚重投影、强烈抖动和多种马卡龙色争抢焦点。',
  },
  contentTypeRules: {
    quote: {
      preferredCarriers: ['quote', 'concept'],
      renderingRules: '金句使用斜体衬线大字与粉色轻强调，可置于单张柔白面板内。',
      density: 'light',
    },
    narration: {
      preferredCarriers: ['list-build', 'concept'],
      renderingRules: '使用 01-03 编号的短清单或单个概念面板，避免高密度数据图。',
      density: 'light',
    },
  },
  preview: {
    motionHtml: `<style>
  .sp-root{position:relative;width:100%;height:100%;display:grid;place-content:center;gap:5%;font-family:'Playfair Display','Noto Serif SC',serif;background:#FEF8F1;color:#3A3A3A;box-sizing:border-box;padding:7% 6%;overflow:hidden;}
  .sp-blob{position:absolute;width:38%;height:38%;border-radius:50%;pointer-events:none;filter:blur(40px);}
  .sp-blob-a{top:-6%;left:-4%;background:radial-gradient(circle, rgba(255,158,181,0.34), transparent 62%);}
  .sp-blob-b{bottom:-8%;right:-6%;background:radial-gradient(circle, rgba(158,230,200,0.30), transparent 62%);}
  .sp-blob-c{top:30%;right:4%;background:radial-gradient(circle, rgba(169,215,245,0.28), transparent 62%);width:26%;height:26%;}
  .sp-card{position:relative;justify-self:center;background:rgba(255,255,255,0.72);border-radius:28px;padding:8% 9%;box-shadow:0 6px 20px rgba(154,142,132,0.12);display:grid;gap:14px;text-align:center;}
  .sp-num{font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:600;color:#FF9EB5;letter-spacing:0.08em;}
  .sp-title{font-size:clamp(26px,7.5vw,54px);font-weight:600;font-style:italic;line-height:1.15;}
  .sp-sub{font-family:'PingFang SC','Noto Sans SC',sans-serif;font-size:clamp(11px,2.6vw,15px);color:#9A8E84;line-height:1.5;}
</style>
<div class="sp-root">
  <div class="sp-blob sp-blob-a"></div>
  <div class="sp-blob sp-blob-b"></div>
  <div class="sp-blob sp-blob-c"></div>
  <div class="sp-card">
    <div class="sp-num">01</div>
    <div class="sp-title">示例标题</div>
    <div class="sp-sub">一句副标题或注解</div>
  </div>
</div>
<script>
  (function(){
    var tl = gsap.timeline({ paused: true });
    tl.from('.sp-card', { y: 26, opacity: 0, scale: 0.97, duration: 0.6, ease: 'power3.out' })
      .from('.sp-num', { y: 10, opacity: 0, duration: 0.4, ease: 'power2.out' }, '-=0.25')
      .from('.sp-title', { y: 14, opacity: 0, duration: 0.5, ease: 'power3.out' }, '-=0.25')
      .from('.sp-sub', { y: 12, opacity: 0, duration: 0.45, ease: 'power2.out' }, '-=0.25');
    window.__lingjiMotionTimelines = window.__lingjiMotionTimelines || [];
    window.__lingjiMotionTimelines.push(tl);
  })();
</script>`,
  },
};
