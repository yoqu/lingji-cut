import type { VisualStylePreset } from '../../types/ai';

const DARK_GRAPH_COVER = `===== 视觉系统：暗色数据图谱 封面 =====
美学锚点：暗色科技 deck × 深空 navy 渐变 × 玻璃拟态 + 力导向图谱。16:9 封面是一帧深空科技界面：深蓝紫渐变底 + 静态模糊光球 + 玻璃卡 + 渐变大标题 + SVG 节点图谱意象，制造科技点击钩子。

按维度顺序组织（主体→构图→风格→美学→质量→文字排版），中文逗号串联，120-180 字：
1. 主体：一个发光的力导向数据图谱或半透明玻璃信息卡作为视觉主体，节点与连线交织成网络，深空科技感，无人物特写、无卡通元素。
2. 构图：深空 navy 渐变底，角落静态紫蓝模糊光球点缀氛围，玻璃卡 / 图谱居中悬浮，大标题压住版面，克制留白。
3. 风格：暗色科技 deck，obsidian / claude 暗色界面风，玻璃拟态 glassmorphism，力导向知识图谱，深空数据可视化。
4. 美学：深空 navy 底 #0A0A12，浅文字 #E6E8F0，单点缀紫蓝 #7C5CFF，标题可用紫→蓝→绿渐变 #A855F7→#60A5FA→#34D399，静态光球氛围，无杂乱霓虹。
5. 质量：4K 超清，锐利清晰，专业科技视觉，数据可视化大师级精度。
6. 文字排版：从字幕提炼 1 条 4-10 字主标题用中文引号""…""精确包裹，无衬线粗体（Inter，Bold），占版面高度 16%-26%，紫→蓝→绿渐变填色或浅色填色，accent 紫蓝点缀；可选 1 条 mono 小字 kicker。

强制规则：
- 主标题必用中文引号""…""精确包裹保证文字准确率；整图只允许 1 主标题 + 至多 1 kicker，禁止水印 / logo / 日期。
- 紫蓝为唯一 accent 体系，渐变文字仅用于主标题，禁止混入暖橙 / 高饱和绿大色块。
- 必深空 navy 渐变底 + 静态模糊光球 + 玻璃卡 / 图谱意象；禁止浅底、卡通贴纸。`;

export const DARK_GRAPH: VisualStylePreset = {
  id: 'dark-graph',
  name: '暗色数据图谱',
  description: '深空 navy 渐变底：静态模糊光球、玻璃拟态卡、紫→蓝→绿渐变标题、纯 SVG 力导向图谱一次性揭示，单点缀紫蓝。',
  tags: ['暗色', '数据', '科技'],
  source: 'deck-graphify-dark / deck-obsidian-claude',
  palette: { bg: '#0A0A12', ink: '#E6E8F0', muted: '#7A7F99', accent: '#7C5CFF' },
  fonts: {
    display: "'Inter','Noto Sans SC',sans-serif",
    body: "'Inter','Noto Sans SC',sans-serif",
    mono: "'JetBrains Mono',monospace",
  },
  facets: { cover: DARK_GRAPH_COVER },
  motionTokens: {
    palette: { bg: '#0A0A12', ink: '#E6E8F0', muted: '#7A7F99', accent: '#7C5CFF', track: 'rgba(255,255,255,0.08)' },
    fonts: {
      display: "'Inter','Noto Sans SC',sans-serif",
      body: "'Inter','Noto Sans SC',sans-serif",
      mono: "'JetBrains Mono',monospace",
    },
    typeScale: { hero: 0.15, dataHero: 0.28, lead: 0.046, body: 0.036, label: 0.025 },
    surface: { kind: 'glass', bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.10)', radius: 16 },
    ambient: { kind: 'orbs', opacity: [0.15, 0.25], color: '#7C5CFF' },
    camera: { mode: 'push', range: [0.98, 1.02] },
    persona: { easing: 'crisp', emphasis: 'brighten' },
  },
  motionStyleNotes:
    '深空科技 deck：关键内容放玻璃拟态卡（surface tokens 已定义）；hero 标题可用静态渐变文字（linear-gradient 90deg #A855F7→#60A5FA→#34D399 + backgroundClip:text，不做逐帧色相循环）；图谱类内容用纯 SVG circle/line 一次性揭示。',
  motionSpec: {
    chartRules: '关系与趋势使用细 SVG 线和低亮轨道，紫蓝 accent 只点亮主节点或主线。',
    emphasisRules: '节点、折线和数字一次揭示并短暂提亮，不做持续发光或自动游走。',
    typographyRules: '标题使用 Inter Bold，标签与数值使用 JetBrains Mono；正文保持高对比浅色。',
    banned: '禁止暖橙大色块、逐帧色相循环、重霓虹描边、密集玻璃卡套卡。',
  },
  contentTypeRules: {
    explanation: {
      preferredCarriers: ['process', 'network', 'concept'],
      renderingRules: '关系优先用节点链路或图谱表达，主节点单独提亮，避免把解释拆成多张玻璃小卡。',
      density: 'normal',
    },
    data: {
      preferredCarriers: ['trend', 'data-hero', 'network'],
      renderingRules: '用紫蓝主线或主节点承载数据焦点，辅助线降低亮度并保持可追踪关系。',
      density: 'heavy',
    },
  },
  preview: {
    motionHtml: `<style>
  .sp-root{position:relative;width:100%;height:100%;display:grid;place-content:center;gap:5%;font-family:'Inter','Noto Sans SC',sans-serif;background:linear-gradient(135deg,#0A0A12,#12121F);color:#E6E8F0;box-sizing:border-box;padding:7% 6%;overflow:hidden;}
  .sp-orb{position:absolute;width:42%;height:42%;border-radius:50%;pointer-events:none;filter:blur(46px);}
  .sp-orb-a{top:-8%;left:-6%;background:radial-gradient(circle, rgba(124,92,255,0.28), transparent 62%);}
  .sp-orb-b{bottom:-10%;right:-8%;background:radial-gradient(circle, rgba(52,211,153,0.18), transparent 62%);}
  .sp-card{position:relative;justify-self:center;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.10);border-radius:16px;padding:7% 8%;display:grid;gap:14px;text-align:center;}
  .sp-kicker{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.08em;color:#7C5CFF;text-transform:uppercase;}
  .sp-title{font-size:clamp(24px,7vw,52px);font-weight:700;letter-spacing:-0.01em;line-height:1.1;background:linear-gradient(90deg,#A855F7,#60A5FA,#34D399);-webkit-background-clip:text;background-clip:text;color:transparent;}
  .sp-graph{display:block;margin:0 auto;}
  .sp-sub{font-size:clamp(11px,2.6vw,15px);color:#7A7F99;line-height:1.45;}
</style>
<div class="sp-root">
  <div class="sp-orb sp-orb-a"></div>
  <div class="sp-orb sp-orb-b"></div>
  <div class="sp-card">
    <div class="sp-kicker">GRAPH</div>
    <div class="sp-title">示例标题</div>
    <svg class="sp-graph" width="120" height="48" viewBox="0 0 120 48">
      <line class="sp-edge" x1="20" y1="34" x2="60" y2="14" stroke="rgba(124,92,255,0.45)" stroke-width="1.5"/>
      <line class="sp-edge" x1="60" y1="14" x2="100" y2="34" stroke="rgba(124,92,255,0.45)" stroke-width="1.5"/>
      <circle class="sp-node" cx="20" cy="34" r="5" fill="#7C5CFF"/>
      <circle class="sp-node" cx="60" cy="14" r="6" fill="#60A5FA"/>
      <circle class="sp-node" cx="100" cy="34" r="5" fill="#34D399"/>
    </svg>
    <div class="sp-sub">一句副标题或注解</div>
  </div>
</div>
<script>
  (function(){
    var tl = gsap.timeline({ paused: true });
    tl.from('.sp-card', { y: 26, opacity: 0, scale: 0.97, duration: 0.6, ease: 'power3.out' })
      .from('.sp-kicker', { y: 10, opacity: 0, duration: 0.4, ease: 'power2.out' }, '-=0.25')
      .from('.sp-title', { y: 14, opacity: 0, duration: 0.5, ease: 'power3.out' }, '-=0.25')
      .from('.sp-edge', { opacity: 0, duration: 0.4, ease: 'power2.out' }, '-=0.15')
      .from('.sp-node', { scale: 0, opacity: 0, transformOrigin: 'center', duration: 0.4, stagger: 0.08, ease: 'power2.out' }, '-=0.2')
      .from('.sp-sub', { y: 12, opacity: 0, duration: 0.45, ease: 'power2.out' }, '-=0.2');
    window.__lingjiMotionTimelines = window.__lingjiMotionTimelines || [];
    window.__lingjiMotionTimelines.push(tl);
  })();
</script>`,
  },
};
