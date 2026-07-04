import type { VisualStylePreset } from '../../types/ai';

export const HAND_SKETCH: VisualStylePreset = {
  id: 'hand-sketch',
  name: '手绘便签',
  description: '米黄方格纸底：手写体、便利贴黄轻微旋转卡、手绘虚线连接，便签依次贴上入场（仅 Motion 适用）。',
  tags: ['浅色', '手绘', '轻松'],
  source: 'wireframe-sketch / frame-flowchart-sticky',
  palette: { bg: '#F4EDE1', ink: '#2B2B2B', muted: '#7A6E5A', accent: '#FFD84D' },
  fonts: {
    display: "'Caveat','Kalam','Noto Sans SC',cursive",
    body: "'Kalam','Noto Sans SC',sans-serif",
    mono: "'JetBrains Mono',monospace",
  },
  facets: {},
  motionTokens: {
    palette: { bg: '#F4EDE1', ink: '#2B2B2B', muted: '#7A6E5A', accent: '#FFD84D', track: 'rgba(43,43,43,0.12)' },
    fonts: {
      display: "'Caveat','Kalam','Noto Sans SC',cursive",
      body: "'Kalam','Noto Sans SC',sans-serif",
      mono: "'JetBrains Mono',monospace",
    },
    typeScale: { hero: 0.15, lead: 0.048, body: 0.034, label: 0.023 },
    surface: { kind: 'panel', bg: '#FFD84D' },
    ambient: { kind: 'grid', opacity: [0.08, 0.08] },
    camera: { mode: 'still' },
    persona: { easing: 'bouncy', emphasis: 'settle' },
  },
  motionStyleNotes:
    '标题正文一律手写体（禁规整无衬线大字）；关键内容放便利贴黄小卡，每张终态带 ±2°（≤3°）轻微旋转 + 柔和阴影，依次"贴上"纸面，非便利贴的纯文本块不加背景；要点间用 1.5px 手绘 dashed 虚线连接（描线揭示）；方格纸底与阴影全程静止，不做呼吸漂移。',
  preview: {
    motionHtml: `<style>
  .sp-root{position:relative;width:100%;height:100%;display:grid;align-content:center;gap:5%;font-family:'Caveat','Kalam','Noto Sans SC',cursive;background:#F4EDE1;color:#2B2B2B;box-sizing:border-box;padding:7% 6%;overflow:hidden;}
  .sp-grid{position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg, rgba(43,43,43,0.08) 0 1px, transparent 1px 26px), repeating-linear-gradient(90deg, rgba(43,43,43,0.08) 0 1px, transparent 1px 26px);}
  .sp-code{position:relative;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.12em;color:#7A6E5A;}
  .sp-title{position:relative;font-size:clamp(30px,10vw,72px);font-weight:700;line-height:1.05;}
  .sp-note{position:relative;justify-self:start;background:#FFD84D;color:#2B2B2B;padding:10px 16px;font-size:clamp(13px,3vw,20px);box-shadow:0 4px 10px rgba(43,43,43,0.12);transform:rotate(-2deg);}
</style>
<div class="sp-root">
  <div class="sp-grid"></div>
  <div class="sp-code">NOTE 01</div>
  <div class="sp-title">示例标题</div>
  <div class="sp-note">一条便利贴要点</div>
</div>
<script>
  (function(){
    var tl = gsap.timeline({ paused: true });
    tl.from('.sp-code', { y: 14, opacity: 0, duration: 0.4, ease: 'power2.out' })
      .from('.sp-title', { y: 22, opacity: 0, duration: 0.55, ease: 'power3.out' }, '-=0.15')
      .from('.sp-note', { y: 16, opacity: 0, scale: 0.97, rotation: 0, duration: 0.5, ease: 'power2.out' }, '-=0.1');
    window.__lingjiMotionTimelines = window.__lingjiMotionTimelines || [];
    window.__lingjiMotionTimelines.push(tl);
  })();
</script>`,
  },
};
