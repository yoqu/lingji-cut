import type { VisualStylePreset } from '../types/ai';
import { DEFAULT_STYLE_PRESET_ID } from '../types/ai';
import { SWISS_GRID } from './card-style-presets/swiss-grid';
import { NYT_DATA } from './card-style-presets/nyt-data';
import { CYBER_GLITCH } from './card-style-presets/cyber-glitch';
import { FILM_LEAK } from './card-style-presets/film-leak';
import { HAND_SKETCH } from './card-style-presets/hand-sketch';
import { SOFT_APPLE } from './card-style-presets/soft-apple';
import { DARK_GRAPH } from './card-style-presets/dark-graph';
import { XHS_PASTEL } from './card-style-presets/xhs-pastel';
import { MONO_BOLD } from './card-style-presets/mono-bold';

const EDITORIAL_EINK_COVER = `===== 视觉系统：短视频缩略图 / Thumbnail 风（默认锁定，禁止替换）=====
美学锚点：B 站知识区头部 UP 主缩略图 × YouTube 解说类频道 thumbnail × 商业短视频封面。
整张封面必须是"真实场景照片 + 卡通插画元素 + 大字综艺标题"的混合体，靠夸张冲突制造点击欲。

Design DNA（违反任何一条，缩略图感都会垮）：
1. 强冲突主体 —— 一个真实人物 / 物件 + 一个夸张卡通元素（夸张表情吉祥物、卡通监控摄像头、巨大眼睛、卡通箭头、对话气泡、放大镜、警示标志等），两者之间存在视觉冲突或戏剧关系
2. 字必须大、必须狠 —— 主标题字号占画面高度 18%-28%，是整张图的视觉焦点，比脸还显眼
3. 真实 + 卡通混合 —— 不要纯插画、不要纯写实，必须是合成感（真实办公室照片 + 卡通摄像头叠加；真实人物背影 + 卡通对话气泡）
4. 单一霓虹 accent —— 只允许 cyan(#00E5FF) / lime(#A6FF00) / magenta(#FF2EC4) 三选一，全图围绕这一种 accent 配色，禁止双 accent
5. 暗色科技底 —— 背景统一偏暗（深蓝黑 #0A0E1A / 暗灰 #14161C / 黑紫 #0F0A1A），制造 accent 发光感

===== 颜色 token（硬性锁定）=====
- 背景色 bg：从 #0A0E1A / #14161C / #0F0A1A 中选 1
- accent（霓虹主色，全图配额 ≤ 25% 面积，整张图只允许这一种霓虹）：cyan #00E5FF / lime #A6FF00 / magenta #FF2EC4 三选一
- 主标题填色 = accent 本色或更浅一档高光色
- 主标题描边 = 纯黑 #000000，描边粗度占字高 8%-12%（厚到看不清字内细节为止）
- 高光边 = 纯白 #FFFFFF，1-2px 极细，沿描边外侧
- 3D 立体投影 = 黑色或 accent 深色，向右下偏移 4%-8% 字高，硬阴影不要 blur
- 副标题颜色 = 纯白 #FFFFFF + 纯黑描边；或 accent 反色 + 黑描边

【提示词结构规范】
单条提示词必须按以下 7 个维度、严格按序组织，用中文逗号"，"或分号"；"串联，整体长度 140-220 字：

1. 主体（自然语言）
   - 真实人物或真实物件，明确动作姿态、外貌、服装、视角（背对镜头 / 侧脸 / 半身 / 仰视等）
   - 示例：一位男性程序员背对镜头坐在办公桌前；一只手伸向手机屏幕的特写；一摞堆到天花板的文件
2. 卡通元素 / 戏剧冲突（自然语言，必填）
   - 在主体周围叠加 1 个夸张卡通元素，用于制造视觉冲突或戏剧关系
   - 可选：卡通监控摄像头带巨大眼睛盯着主体；夸张卡通箭头指向某处；漂浮的对话气泡 / 思考气泡；卡通警示标志；放大镜聚焦在细节上；爆炸符号；表情夸张的吉祥物
   - 必须明确卡通元素的位置（画面左上 / 右上 / 中部 / 围绕主体）与情绪（盯着、嘲讽、警告、惊讶等）
3. 环境（自然语言）
   - 真实场景 + 暗色科技氛围：开放式办公室 / 深夜书房 / 服务器机房 / 街头夜景 / 复古录音室
   - 必须暗色调，桌面 / 屏幕 / 墙面有 accent 色的微光反射，强化 accent 统一感
4. 画面风格（独立词组，严格照抄以下组合）
   - "真实摄影合成，卡通插画叠加，互联网短视频封面设计，B站知识区缩略图风，YouTube thumbnail style"
5. 美学词（独立词组，必须覆盖以下 4 类，每类至少 1 个）
   - 色彩：高饱和度，强对比，深色科技底，单色霓虹点缀（cyan / lime / magenta 三选一并明确写出色名）
   - 灯光：戏剧化布光，霓虹氛围光，硬光高对比，accent 色边缘光
   - 构图：中心冲击构图 / 三分构图 / 对角线动势，主体居中或偏左，标题占据视觉黄金区
   - 装饰：背景斜切几何分割线，accent 色发光边框，暗色径向渐变，accent 色装饰箭头条 / 锯齿条
6. 质量词（独立词组，2-3 个）
   - 4K 超清，锐利清晰，富有层次的合成质感，大师级缩略图设计
7. 画面文字（必须包含主标题，可选副标题，由以下两段组成）
   - 7.1 文本：先从整期字幕提炼 1 条 4-8 个汉字的主标题（要狠、要冲突、要带钩子，例如"公司合法监控""你被算法骗了""老板不会告诉你"），用中文引号""…""精确包裹；可再追加 1 条 ≤6 字副标题（""摸鱼的你！""""我不允许""），同样用引号包裹
   - 7.2 排版约束（独立词组串联，必填项不可省）：
     · 字体族（主标题）：粗体综艺封面字 / 阿里妈妈数黑体 / 站酷酷黑 / 字魂综艺粗黑 / 优设标题黑；禁止衬线、禁止花体、禁止手写
     · 字重：Black / Heavy（必须最重的一档）
     · 字号：主标题占画面高度 18%-28%（不能更小），副标题占画面高度 6%-10%
     · 主标题填色：accent 霓虹色（必须明确写出 cyan #00E5FF / lime #A6FF00 / magenta #FF2EC4 之一）
     · 描边：纯黑 #000000 厚描边，粗度约字高 10%
     · 高光：1-2px 纯白 #FFFFFF 高光边沿描边外侧
     · 立体投影：黑色硬阴影向右下偏移约字高 6%，无模糊
     · 副标题：白色填色 + 黑色描边，可倾斜 6°-10° 制造冲突感
     · 排版位置：主标题居中或居中偏下，覆盖画面下半部 1/3；副标题贴在主标题右上或左下角；都不得遮挡主体面部
     · 主副标题之间允许加 1 条 accent 色装饰短线 / 箭头 / 锯齿条作为视觉串联

【强制规则】
- 主体 / 卡通元素 / 环境 必须是可读的自然语言句子，清晰交代"谁、和什么卡通元素、在哪里"
- 画面风格 / 美学词 / 质量词 / 排版约束 必须是独立词组，用中文逗号串联，禁止展开成长句
- 越靠前权重越高，严格按 主体 → 卡通元素 → 环境 → 风格 → 美学 → 质量 → 文字与排版 的顺序排布
- 整体长度 140-220 字；必须包含 1 个夸张卡通元素 + 1 条主标题 + 至多 1 条副标题
- 使用中文逗号"，"或分号"；"分隔要素，禁止使用换行、斜杠 /、括号堆叠或其它特殊符号
- 必须使用简体中文；色值、字体族名、风格锚点英文（YouTube thumbnail / B站）可保留
- 文字标题必须用中文引号""…""精确包裹，保证 AI 生图的文字准确率
- 整张图只允许出现 1 条主标题 + 至多 1 条副标题，禁止期号、署名、水印、logo、日期、二维码、UI 控件
- 标题文本必须紧扣本期核心冲突 / 反差 / 钩子，禁止"美丽、震撼、惊艳、极致、终极"等空泛形容词
- accent 色全图只能出现 1 种霓虹（cyan / lime / magenta 三选一），禁止双霓虹混搭
- 面向 16:9 封面：主体不能被裁掉、标题不能贴边、卡通元素与主体必须有清晰的空间关系
- 禁止裸露、暴力、政治敏感、真人换脸、明星肖像、品牌侵权

【参考示例】（仅示范格式与颗粒度，不要照抄内容；该示例使用 cyan accent）
一位男性程序员背对镜头坐在开放式办公桌前面对三块显示器敲键盘，画面右上角悬浮着一只夸张的卡通监控摄像头，摄像头有一只巨大的卡通眼睛圆睁着死死盯着员工后脑，整体氛围紧张戏剧化，环境是深夜暗色调开放式办公室，桌面与屏幕透出青色微光打在墙面与天花板上，真实摄影合成，卡通插画叠加，互联网短视频封面设计，B站知识区缩略图风，YouTube thumbnail style，高饱和度，强对比，深色科技底 #0A0E1A，单色霓虹点缀 cyan #00E5FF，戏剧化布光，霓虹氛围光，硬光高对比，cyan 边缘光，中心冲击构图，主体居中偏左，背景斜切几何分割线，cyan 发光边框，暗色径向渐变，cyan 装饰箭头条，4K 超清，锐利清晰，大师级缩略图设计，画面下半部居中呈现主标题""公司合法监控""，字魂综艺粗黑，Black，字号约占画面高度 24%，主色 cyan #00E5FF 霓虹填充，纯黑 #000000 厚描边约字高 10%，1-2px 纯白 #FFFFFF 高光边，黑色硬阴影向右下偏移字高 6%，主标题右上方贴一条副标题""摸鱼的你！""为白色填色配纯黑描边并倾斜 8°，主副标题之间加一条 cyan 锯齿装饰条作为视觉串联，全部文字均不遮挡主体面部`;

const EDITORIAL_EINK: VisualStylePreset = {
  id: DEFAULT_STYLE_PRESET_ID,
  name: '电子杂志墨水',
  description: '深色克制社论风：衬线标题、hairline 分隔、无渐变无阴影、单一系统蓝 accent。',
  tags: ['深色', '社论', '克制'],
  source: 'deck-guizang-editorial / web-proto-editorial',
  palette: { bg: '#0E0E10', ink: '#ECE7DA', muted: '#8A8478', accent: '#0A84FF' },
  fonts: {
    display: "'Noto Serif SC', Georgia, serif",
    body: "'PingFang SC', 'Noto Sans SC', sans-serif",
    mono: "'SF Mono', 'JetBrains Mono', monospace",
  },
  facets: { cover: EDITORIAL_EINK_COVER, image: '' },
  motionTokens: {
    palette: { bg: '#0E0E10', ink: '#ECE7DA', muted: '#8A8478', accent: '#0A84FF', track: 'rgba(236,231,218,0.12)' },
    fonts: {
      display: "'Noto Serif SC','Source Han Serif SC','Songti SC',Georgia,serif",
      body: "'PingFang SC','Hiragino Sans GB','Noto Sans SC','Helvetica Neue',sans-serif",
      mono: "'SF Mono','JetBrains Mono','Source Code Pro',Menlo,monospace",
    },
    typeScale: { hero: 0.15, dataHero: 0.3, lead: 0.05, body: 0.036, label: 0.025 },
    surface: { kind: 'none' },
    ambient: { kind: 'hairline', opacity: [0.08, 0.16] },
    camera: { mode: 'push', range: [0.99, 1.01] },
    persona: { easing: 'crisp', emphasis: 'brighten' },
  },
  motionStyleNotes:
    '克制杂志感：数字与 hero 标题必用衬线（display 字体）；分隔只靠留白与 1px hairline，禁渐变 / 阴影 / 圆角面板 / emoji；accent 蓝整卡只出现在唯一焦点上。',
  preview: {},
};

export const VISUAL_STYLE_PRESETS: VisualStylePreset[] = [
  EDITORIAL_EINK,
  SWISS_GRID,
  NYT_DATA,
  CYBER_GLITCH,
  FILM_LEAK,
  HAND_SKETCH,
  SOFT_APPLE,
  DARK_GRAPH,
  XHS_PASTEL,
  MONO_BOLD,
];

export function listStylePresets(): VisualStylePreset[] {
  return VISUAL_STYLE_PRESETS;
}
