export const PROMPT_KINDS = [
  'production.director',
  'planning.segment',
  'cover.regeneration',
  'motion.bible',
  'cards.segment',
  'cards.animation',
  'script.review',
  'card.image',
  'card.video',
  'publish.metadata',
  'publish.partition',
] as const;

export type PromptKind = (typeof PROMPT_KINDS)[number];

export function isPromptKind(value: unknown): value is PromptKind {
  return typeof value === 'string' && (PROMPT_KINDS as readonly string[]).includes(value);
}

export type PromptScope = 'builtin' | 'global' | 'project';

export type PromptGroup = 'project' | 'ai-analysis' | 'script';

export const PROMPT_CATEGORIES = ['script-template'] as const;
export type PromptCategory = (typeof PROMPT_CATEGORIES)[number];

export function isPromptCategory(value: unknown): value is PromptCategory {
  return typeof value === 'string' && (PROMPT_CATEGORIES as readonly string[]).includes(value);
}

export interface PromptCategoryMeta {
  category: PromptCategory;
  label: string;
  description: string;
  group: PromptGroup;
  variables: { name: string; description: string }[];
  allowAdd: boolean;
  allowDelete: boolean;
}

export const PROMPT_CATEGORY_META: Record<PromptCategory, PromptCategoryMeta> = {
  'script-template': {
    category: 'script-template',
    label: '口播模板',
    description: '写稿风格模板。system 段放写作指令，user 段会被原始素材替换',
    group: 'script',
    variables: [
      { name: 'rawText', description: '原始素材内容（用户提供的 original.md）' },
    ],
    allowAdd: true,
    allowDelete: true,
  },
};

export interface UserPromptEntry {
  id: string;
  category: PromptCategory;
  name: string;
  description: string;
  version?: number;
  system: string;
  user: string;
  isBuiltin: boolean;
  createdAt?: string;
  updatedAt?: string;
  /** MiMo 演绎人设：原样作为 MiMo role:user 指令；仅 MiMo 使用 */
  ttsStyle?: string;
  /** 打标风格倾向：注入打标 prompt 的一句话偏好 */
  ttsAnnotateHint?: string;
}

export interface UserPromptSeed {
  id: string;
  category: PromptCategory;
  name: string;
  description: string;
  version: number;
  system: string;
  user: string;
  /** MiMo 演绎人设：原样作为 MiMo role:user 指令；仅 MiMo 使用 */
  ttsStyle?: string;
  /** 打标风格倾向：注入打标 prompt 的一句话偏好 */
  ttsAnnotateHint?: string;
}

/**
 * 用户自定义提示词条目的绑定 key。与 PromptKind 共享 PromptBindingMap 的 key 空间，
 * 但通过 `user:` 前缀隔离，避免与内置 kind 冲突。
 */
export function userPromptBindingKey(category: PromptCategory, id: string): string {
  return `user:${category}:${id}`;
}

/** 解析用户提示词绑定 key；非 user 前缀返回 null */
export function parseUserPromptBindingKey(
  key: string,
): { category: PromptCategory; id: string } | null {
  if (!key.startsWith('user:')) return null;
  const rest = key.slice('user:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const category = rest.slice(0, sep);
  const id = rest.slice(sep + 1);
  if (!isPromptCategory(category)) return null;
  if (!id) return null;
  return { category, id };
}

export interface PromptTemplate {
  name: string;
  description?: string;
  version?: number;
  system?: string;
  user: string;
}

export interface EffectivePromptTemplate extends PromptTemplate {
  sourceScope: PromptScope;
}

export interface LockedContract {
  /** 拼接位置；当前统一用 user-tail，保留扩展性 */
  position: 'user-tail';
  /** 实际拼进 prompt 的文本 */
  content: string;
  /** 给用户的说明，解释为何不可编辑 */
  reason: string;
}

export interface PromptKindMeta {
  kind: PromptKind;
  label: string;
  description: string;
  group: PromptGroup;
  variables: { name: string; description: string }[];
  /** 是否直接发起模型调用并允许单独绑定模型；纯规则模板应设为 false。 */
  supportsBinding?: boolean;
  /** 业务契约段：每次请求自动拼接，UI 只读展示 */
  lockedContract?: LockedContract;
}

const LOCKED_VISUAL_AUTHENTICITY = `【真实性与新闻伦理 · 最高优先级铁律】
- 对现实中真实发生的新闻、财经、商业或公共事件，以及真实人物的具体行为，禁止用 AI 生成可被误认为真实现场记录的写实画面；典型场景包括上市敲钟、发布会、签约、会议、庭审、事故与灾害。
- 禁止伪造真实人物在场、肖像、动作、场馆、媒体镜头或机构标识，不得用合成画面冒充事实证据或制造假新闻。
- 视觉选择顺序固定为：来源可核验的真实素材 > Motion Card / 信息图 / 符号化表达 > 明显非写实的卡通或编辑插画。
- 没有可核验真实素材时，绝不以写实 AI 图或视频“补拍”现场；确实需要生成时，必须明确采用卡通或编辑插画、扁平图解、纸艺拼贴等非写实风格，并排除写实摄影、纪实摄影、新闻摄影、真实人物肖像与仿现场构图。
- 本铁律不可被用户风格提示、项目提示、参考图风格或模型偏好覆盖。`;

const LOCKED_PLANNING_SEGMENT = `【系统契约 · 不可修改】
输出必须是严格 JSON，且只返回 JSON，不要附加解释。

顶层结构必须包含：
- segments: 按整期时长动态规划；短稿 4-8 段，中稿 8-16 段，长稿按 30-45 秒拆分，可超过 30 段
- coverPrompts: 数组，且只能包含 1 条字符串
- summary: 一句话总结
- keywords: 关键词数组
- globalPrompt: 沿用输入的整期创作提示词，没有则返回空字符串

segments 中每一项必须包含：
- id
- title
- summary
- startMs (number, 毫秒)
- endMs (number, 毫秒)
- transcriptExcerpt
- semanticType: data | explanation | chapter-transition | quote | narration
- complexityLevel: low | medium | high
- visualizationScore: 0-100
- pacingNeed: steady | accent | transition
- keywords: 该段关键词数组
- entities: 该段关键实体数组
- visualType: motion | image

${LOCKED_VISUAL_AUTHENTICITY}

分段专用约束：涉及上述真实事件或真实人物行为的段落必须选择 visualType="motion"；当前 image 流程会调用 AI 生图，不能把它当作真实素材入口。coverPrompts 若表达此类题材，也必须明确使用非写实的卡通或编辑插画。`;

const LOCKED_COVER_REGENERATION = `【系统契约 · 不可修改】
输出必须是严格 JSON，且只返回 JSON，不要附加解释。

顶层结构必须包含：
- coverPrompts: 数组，且只能包含 1 条字符串

${LOCKED_VISUAL_AUTHENTICITY}

封面专用约束：本调用的产物会直接进入 AI 生图；若内容涉及上述真实事件或真实人物行为，coverPrompts[0] 必须明确指定非写实的卡通或编辑插画，不能描述仿新闻现场。`;

const LOCKED_MOTION_BIBLE = `【系统契约 · 不可修改】
输出必须是严格 JSON，且只返回 JSON，不要附加解释。

顶层结构必须包含：
- visualThesis: 字符串，整期 motion 的一句视觉命题
- rhythm: { density: "quiet"|"balanced"|"dense", heavySegments: string[], quietSegments: string[] }
- carrierPlan: 数组，每个规划段 1 条，字段为 { segmentId, preferredCarrier, intensity, reason }
- styleRules: { paletteUse, typographyUse, recurringMotif? }
- transitionRules: { default: "crossfade"|"hard-cut"|"push"|"wipe", matchCutCandidates: [{ fromSegmentId, toSegmentId, motif }] }

约束：
- segmentId 必须来自输入段落，不得自创
- intensity 只能是 1、2、3
- heavySegments 与 quietSegments 不得重叠
- carrierPlan 要避免连续 3 个 segment 使用同一 carrier

${LOCKED_VISUAL_AUTHENTICITY}

Motion Bible 专用约束：上述题材只能规划来源可核验的真实素材或符号化 Motion 表达，不得把写实 AI 重演写进 visualThesis、carrierPlan、styleRules 或 recurringMotif。`;

const LOCKED_CARDS_SEGMENT = `【系统契约 · 不可修改】
用 write / edit 工具把完整组件写入工作目录的 motionCard.tsx（修复轮次用 edit 针对性修改）；不要把组件源码全文输出到对话，只简述实现了分镜的哪几拍。
组件必须是单文件 TSX：export default function Card({ cues = [], timingPlan })；只能 import remotion / react / @lingji/motion-kit；动画必须是 useCurrentFrame() 的纯函数，禁止 fetch/setTimeout/setInterval/Math.random/new Date/requestAnimationFrame 等非确定性或副作用 API（静态 lint 会逐条拦截）。
组件必须完整：函数体内必须 return 真实 JSX（<CardStage> 或 <AbsoluteFill> 根节点），严禁用 “// ... build out the rest”/“// TODO”/“…” 等注释收尾或 return null，否则渲染黑屏视为失败。
卡片的标题 / 时间 / 类型 / 样式等元信息由系统从 segment 合成，不需要、也不要在代码里或代码外输出这些字段。`;

const LOCKED_CARDS_ANIMATION = `【系统契约 · 不可修改】
只输出一个 JSON 对象（不加 markdown 代码块、不加任何解释），结构如下：
{
  "claim": "一句话论点",
  "carrier": "data-hero|comparison|trend|list-build|process|quote|concept|timeline|matrix|funnel|network|before-after|stacked-composition",
  "scene": "一句话描述整卡终态画面",
  "focus": { "beat": 1, "emphasis": "countup-settle|slam|underline-sweep|brighten" },
  "beats": [
    { "cue": null, "kind": "build", "adds": "新出现的元素及内容", "motion": "动作意图" },
    { "cue": 2, "kind": "build|transform|accent", "adds": "…", "changes": "已有元素如何变化（可省略）", "motion": "…" }
  ]
}
beats 1-6 个；cue 必须是逐句节拍里的合法索引且随拍序单调不减（仅第 0 拍允许 null）；adds/changes 中的数字与专名必须来自逐字稿原文。机器会逐条校验，不合法将被打回重出。

${LOCKED_VISUAL_AUTHENTICITY}

分镜资产专用约束：上述题材的真实素材请求必须使用 reusePolicy="manual-only"；没有真实素材时优先不用 assets，改用 Motion 信息图。确需生成象征性替代画面时，只能使用 visualTreatment="diagram-prop"，并在 query 中明确“卡通编辑插画、非写实”。`;

const LOCKED_SCRIPT_REVIEW = `【系统契约 · 不可修改】
请以严格 JSON 格式返回审查结果，且只返回 JSON：
{
  "annotations": [
    {
      "originalText": "需要标注的原文片段（必须是稿件中的精确子串）",
      "issue": "问题描述",
      "suggestion": "修改建议（替换后的完整文本）",
      "severity": "error | warning | info"
    }
  ]
}

字段约束：
- originalText 必须是稿件中能精确匹配的子串
- severity 必须是 error | warning | info 之一
- suggestion 必须是可以直接替换 originalText 的完整文本`;

const LOCKED_CARD_IMAGE = `【系统契约 · 不可修改】
只输出**一段连续的简体中文文生图提示词**，不要附加任何前缀、后缀、解释、标题、列表、JSON 或 markdown 代码块。
不要包裹引号；不要换行；不要标注"提示词："或"Prompt:"等前导文本。
画面中禁止出现任何文字 / UI 元素 / Logo / 水印 / 字幕条。

${LOCKED_VISUAL_AUTHENTICITY}

图片卡专用约束：若输入涉及上述题材，输出提示词必须逐字包含“卡通或编辑插画、明显非写实、非摄影、不可被误认为真实照片或新闻现场”，且不得包含“写实摄影”“纪实摄影”“新闻摄影”“电影级实拍”“真实人物肖像”等指令。`;

const LOCKED_CARD_VIDEO = `【系统契约 · 不可修改】
只输出一段可直接用于文生视频模型的英文 prompt，不要附加解释、标题、列表、JSON 或 markdown 代码块。

${LOCKED_VISUAL_AUTHENTICITY}

视频卡专用约束：若输入涉及上述题材，只能要求 clearly stylized cartoon or editorial animation, obviously non-photorealistic, not documentary footage；禁止 photorealistic、documentary、news footage、live-action reenactment、real-person likeness。`;

const LOCKED_PUBLISH_METADATA = `【系统契约 · 不可修改】
只返回严格 JSON，不要任何解释、前后缀或多余文本，结构如下：
{ "title": "字符串", "desc": "字符串", "tags": ["标签1", "标签2"] }`;

const LOCKED_PUBLISH_PARTITION = `【系统契约 · 不可修改】
只返回严格 JSON，不要任何解释、前后缀或多余文本，结构如下：
{ "tid": 数字 }
其中 tid 必须是【可选分区清单】里列出的某个 tid，不得自创、不得返回主分区或清单外的数字。`;

export const PROMPT_KIND_META: Record<PromptKind, PromptKindMeta> = {
  'production.director': {
    kind: 'production.director',
    label: '导演制作规则',
    description:
      '整片镜头节奏、视觉焦点、章节边界、转场与声音设计规则；自动注入字幕分段规划和 Motion Bible。',
    group: 'ai-analysis',
    variables: [],
    supportsBinding: false,
  },
  'planning.segment': {
    kind: 'planning.segment',
    label: '字幕分段规划',
    description: '整篇字幕拆分为多个语义段落，并给出 1 条封面提示词、总结、关键词',
    group: 'ai-analysis',
    variables: [
      { name: 'globalPromptLine', description: '额外创作要求行；有值时形如"额外创作要求：xxx"，无值为空字符串' },
    ],
    lockedContract: {
      position: 'user-tail',
      content: LOCKED_PLANNING_SEGMENT,
      reason: '业务侧按此 schema 解析分段数据、封面提示词、关键词；修改会导致分析结果无法落库。',
    },
  },
  'cover.regeneration': {
    kind: 'cover.regeneration',
    label: '封面提示词重生成',
    description: '根据字幕与现有提示词重生成单条 16:9 播客封面提示词',
    group: 'ai-analysis',
    variables: [
      { name: 'title', description: '作品标题（为空填"无"）；封面主文案应使用该标题或其精炼变体' },
      { name: 'globalPrompt', description: '整期创作提示词（为空填"无"）' },
      { name: 'currentPrompt', description: '当前封面提示词（为空填"无"）' },
      { name: 'styleSystemBlock', description: '系统风格库注入的视觉系统块；由所选风格预设的对应 facet 决定' },
    ],
    lockedContract: {
      position: 'user-tail',
      content: LOCKED_COVER_REGENERATION,
      reason: '业务侧从 JSON.coverPrompts[0] 读取提示词；修改会导致封面重生成无法解析。',
    },
  },
  'cards.segment': {
    kind: 'cards.segment',
    label: '段落信息卡片生成',
    description: '把 cards.animation 的 JSON 分镜实现为 Motion Card（组合 @lingji/motion-kit 的 Remotion TSX 组件，file-first 写入 motionCard.tsx，需通过 lint + 渲染校验）',
    group: 'ai-analysis',
    variables: [
      { name: 'motionKitApi', description: '@lingji/motion-kit 的 API 摘要（CardStage/useBeats/内容原语/手法函数；与 kit 实现同源维护）' },
      { name: 'presetMotionTokens', description: '所选风格预设的 motion tokens JSON（palette/fonts/typeScale/surface/ambient/camera/persona），原样定义为 TOKENS 常量' },
      { name: 'presetStyleNotes', description: '风格预设的少量专属提示（如玻璃拟态面板、渐变标题）；无则为空' },
      { name: 'animationDirection', description: '本卡 JSON 分镜（cards.animation 产出的 storyboard；无则为"无"）' },
      { name: 'assetContext', description: '已解析资产绑定摘要；外部资产层会按 slot 植入，雕刻师需要为素材预留布局空间' },
      { name: 'motionBible', description: '整片 Motion Bible 摘要与本段 directive；无则为降级说明' },
      { name: 'segmentCues', description: '本段逐句字幕节拍列表（[k] +秒数 文本；索引 k 与运行时 cues 数组对齐，与分镜的 cue 字段对应）' },
      { name: 'segmentId', description: 'segment id' },
      { name: 'segmentTitle', description: 'segment 标题' },
      { name: 'segmentSummary', description: 'segment 摘要' },
      { name: 'cardPrompt', description: '单卡追加提示词' },
      { name: 'currentCardSection', description: '当前卡片线索多行块（由调用方构造）' },
      { name: 'programContext', description: '节目级浓缩上下文（节目摘要、关键词、当前段在整期中的位置）' },
      { name: 'globalPrompt', description: '整期创作提示词（兼容旧模板）' },
      { name: 'programSummary', description: '节目级总结（兼容旧模板）' },
      { name: 'keywords', description: '节目关键词（兼容旧模板）' },
      { name: 'segmentTranscriptExcerpt', description: 'segment 原始摘录（兼容旧模板）' },
      { name: 'styleSystemBlock', description: '兼容旧模板：与 presetMotionTokens 同源的风格块' },
      { name: 'sandboxReference', description: '兼容旧模板：运行时约束说明' },
    ],
    lockedContract: {
      position: 'user-tail',
      content: LOCKED_CARDS_SEGMENT,
      reason: '业务侧按此结构取 motionCard.tsx 并做 lint + Remotion 渲染校验；修改会导致卡片无法生成。',
    },
  },
  'motion.bible': {
    kind: 'motion.bible',
    label: '整片 Motion Bible',
    description: '在单卡生成前规划整期 motion 的视觉命题、节奏密度、载体分布、风格规则与转场策略',
    group: 'ai-analysis',
    variables: [
      { name: 'globalPrompt', description: '整期创作提示词（为空填"无"）' },
      { name: 'programSummary', description: '节目级总结（为空填"无"）' },
      { name: 'keywords', description: '节目关键词（顿号分隔，无则为"无"）' },
      { name: 'segments', description: '规划后的 segment 列表 JSON（id/title/summary/semanticType/complexityLevel/pacingNeed/visualType）' },
    ],
    lockedContract: {
      position: 'user-tail',
      content: LOCKED_MOTION_BIBLE,
      reason: '业务侧按此 JSON Schema 解析整片 motion 导演策略，并把 segment directive 注入单卡生成链路。',
    },
  },
  'cards.animation': {
    kind: 'cards.animation',
    label: '视觉论证分镜',
    description: '为单个 motion 段落设计结构化 JSON 分镜（论点 / 载体 / 逐拍状态演进 / 焦点），机器校验后交给 cards.segment 实现',
    group: 'ai-analysis',
    variables: [
      { name: 'globalPrompt', description: '整期创作提示词（为空填"无"）' },
      { name: 'programSummary', description: '节目级总结（为空填"无"）' },
      { name: 'keywords', description: '节目关键词（顿号分隔，无则为"无"）' },
      { name: 'segmentId', description: 'segment id' },
      { name: 'segmentTitle', description: 'segment 标题' },
      { name: 'segmentSummary', description: 'segment 摘要' },
      { name: 'segmentTranscriptExcerpt', description: 'segment 原始摘录' },
      { name: 'segmentCues', description: '本段逐句字幕节拍列表（[k] +秒数 文本；索引 k 即分镜 cue 字段的合法取值）' },
      { name: 'cardPrompt', description: '用户单卡追加提示词（风格/语气参考；无则为"无"）' },
      { name: 'motionBible', description: '整片 Motion Bible 摘要与本段 directive；用于控制 carrier、强弱与风格一致性' },
    ],
    lockedContract: {
      position: 'user-tail',
      content: LOCKED_CARDS_ANIMATION,
      reason: '编排器按此 JSON Schema 解析并机器校验分镜（cue 合法性 / 数字防编造）；修改会导致分镜无法进入出卡流程。',
    },
  },
  'script.review': {
    kind: 'script.review',
    label: '文稿 AI 审查',
    description: '口播稿审稿提示词。模型返回 annotations JSON（originalText/issue/suggestion/severity）',
    group: 'script',
    variables: [
      { name: 'scriptText', description: '待审查的完整口播稿正文' },
    ],
    lockedContract: {
      position: 'user-tail',
      content: LOCKED_SCRIPT_REVIEW,
      reason: '业务侧按 annotations[] 定位批注；修改会让审查结果无法在编辑器中展示。',
    },
  },
  'card.image': {
    kind: 'card.image',
    label: '段落图片卡',
    description:
      '为单个 segment 生成中文文生图提示词；由 cards.segment 拆出 image 卡片后单独调用，产物用于 image provider 文生图',
    group: 'ai-analysis',
    variables: [
      { name: 'globalPrompt', description: '整期创作提示词（为空填"无"）' },
      { name: 'programSummary', description: '节目级总结（为空填"无"）' },
      { name: 'keywords', description: '节目关键词（顿号分隔，无则为"无"）' },
      { name: 'segmentId', description: 'segment id' },
      { name: 'segmentTitle', description: 'segment 标题' },
      { name: 'segmentSummary', description: 'segment 摘要' },
      { name: 'segmentExcerpt', description: 'segment 字幕摘录' },
      { name: 'cardTitle', description: '卡片标题（cards.segment 已确定）' },
      { name: 'cardContent', description: '卡片描述（cards.segment 已确定，承载视觉意象）' },
      { name: 'displayMode', description: '显示模式：fullscreen 或 pip' },
      { name: 'aspectRatio', description: '画幅比例：16:9 / 9:16 / 1:1 / 4:3 / 3:4' },
      { name: 'cardPromptHint', description: '用户单卡追加提示词，可选（无则为"无"）' },
      { name: 'styleSystemBlock', description: '系统风格库注入的视觉系统块；由所选风格预设的对应 facet 决定' },
    ],
    lockedContract: {
      position: 'user-tail',
      content: LOCKED_CARD_IMAGE,
      reason:
        '业务侧直接把模型返回值作为文生图 prompt 喂给 ImageProvider；附加任何前后缀或 JSON 都会污染图像生成效果。',
    },
  },
  'card.video': {
    kind: 'card.video',
    label: '段落视频卡',
    description: '为单个 segment 生成 AI 视频卡的提示词；产物用于 video provider 文生视频',
    group: 'ai-analysis',
    variables: [
      { name: 'segmentTitle', description: 'segment 标题' },
      { name: 'segmentSummary', description: 'segment 摘要' },
      { name: 'segmentExcerpt', description: 'segment 字幕摘录' },
      { name: 'displayMode', description: '显示模式：fullscreen 或 pip' },
      { name: 'aspectRatio', description: '画幅比例：16:9 / 9:16 / 1:1' },
      { name: 'durationSeconds', description: '视频时长（秒），档位由 provider capabilities 决定' },
    ],
    lockedContract: {
      position: 'user-tail',
      content: LOCKED_CARD_VIDEO,
      reason: '业务侧会把提示词直接交给 VideoProvider；真实性规则必须不可编辑，避免生成仿新闻现场的写实视频。',
    },
  },
  'publish.metadata': {
    kind: 'publish.metadata',
    label: '发布文案生成',
    description:
      '发布选项卡「AI 一键生成」标题 / 简介 / 标签。一次调用同时产出三者，标题受平台 30 字上限约束、硬控在 25 字内（含标点）。本提示词只写约束规则；【节目内容】与可选的【已有标题】由系统在请求时自动追加为内容消息，无需在此用变量占位。',
    group: 'project',
    variables: [],
    lockedContract: {
      position: 'user-tail',
      content: LOCKED_PUBLISH_METADATA,
      reason: '业务侧按 { title, desc, tags } 解析并回填发布表单；修改会导致生成结果无法落库。',
    },
  },
  'publish.partition': {
    kind: 'publish.partition',
    label: 'B站分区推荐',
    description:
      '发布选项卡「智能推荐分区」根据标题 / 描述自动选 B站投稿分区。本提示词只写选择规则；【标题】【描述】与【可选分区清单】由系统在请求时自动追加为内容消息，无需在此用变量占位。',
    group: 'project',
    variables: [],
    lockedContract: {
      position: 'user-tail',
      content: LOCKED_PUBLISH_PARTITION,
      reason: '业务侧按 { tid } 解析并校验回填分区选择器；修改会导致推荐结果无法落库。',
    },
  },
};
