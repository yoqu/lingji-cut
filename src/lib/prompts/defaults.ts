import type { PromptKind } from './types';

const PRODUCTION_DIRECTOR = `name: production.director
description: 导演制作规则（自动注入分段规划与 Motion Bible）
version: 2
user: |-
  你正在为知识类播客制作专业 MG 视频。以下规则决定整片的导演节奏、视觉组织和声音密度；必须结合口播语义执行，而不是机械套模板。

  ===== 镜头与信息密度 =====
  - 一张 AICard 严格对应一个 VisualShot；3-5 分钟节目目标 30-50 个有效镜头。
  - 常规镜头保持 4-7 秒，复杂解释可到 10 秒；只有主动留白的 breath 镜头可以更长。
  - 每个镜头只承担一个结论、关系、数据或情绪动作；每帧只有一个主视觉焦点，最多两个次级动作。
  - 卡片只展示结论、关键词、数据和关系，不完整复制口播或字幕。
  - 每 0.8-1.5 秒安排一次有意义的微状态变化，每 2-4 秒完成一次信息推进；没有新信息时宁可保持，不做无意义循环。

  ===== 真实性与新闻伦理（最高优先级铁律） =====
  - 对现实中真实发生的新闻、财经、商业或公共事件（例如上市敲钟、发布会、签约、会议、庭审、事故与灾害），禁止用 AI 生成可被误认为真实现场记录的写实画面；不得伪造真实人物在场、动作、场馆、媒体镜头或机构标识，避免制造假新闻。
  - 素材优先顺序固定为：来源可核验的真实素材 > Motion Card / 信息图 / 符号化表达 > 明显非写实的卡通或编辑插画。没有真实素材时，绝不以写实 AI 图“补拍”现场。
  - 确实需要 AI 生成来辅助表达时，必须明确指定卡通或编辑插画、扁平图解、纸艺拼贴等非写实风格，并明确排除写实摄影、纪实摄影、新闻摄影、真实人物肖像与仿现场构图。

  ===== 动作与转场 =====
  - 每个信息镜头按 anticipation → reveal → emphasis → hold → resolve 组织；重点落点必须对齐口播重音。
  - 转场必须由共享形状、颜色、位置、方向或语义关系驱动；不要把全片统一做成淡入淡出。
  - 同类 carrier 不得连续出现 3 次；重点、常规、留白镜头要形成可感知的强弱节奏。
  - 章节边界必须来自话题、论点或叙事阶段的真实变化，不得把普通重点句误判为章节。

  ===== 声音设计 =====
  - 声音提示总密度建议每分钟 2-4 次；不为每次文字、数字或图形出现机械配音效。
  - stinger 只用于真正章节切换或叙事阶段变化；同一章节内的普通重点使用克制的 sfx，或不使用声音提示。
  - whoosh、impact、riser 只服务明确的视觉动作与语义落点，避免覆盖关键词起始辅音。
  - BGM 要给连续口播留出中频空间，能量变化跟随章节与论证强弱，不使用持续抢占注意力的主旋律或突然 drop。
  - 环境声只在能建立具体场景、空间或情绪时使用，不作为默认背景填充。

  ===== 决策原则 =====
  - 先保证口播理解，再增加观看刺激；所有视觉和声音动作都必须回答“它在帮助观众理解什么”。
  - 提示词负责创作判断，系统代码仍会执行镜头时长、音效预算、最小间隔、安全区、响度和素材本地化等硬门禁。
`;

const PLANNING_SEGMENT = `name: planning.segment
description: 字幕分段规划提示词
version: 7
user: |-
  你是一个播客内容分析助手。请先完整理解整篇字幕，再把节目拆成有明确语义边界的段落。
  {{globalPromptLine}}

  段落拆分要求：
  - 必须按真实话题边界拆分，而不是按 token 长度硬切；同一话题的展开与收束可以分成 2-3 段，让卡片承载更细的子主题
  - 每个 segment 就是一个可独立制作的 MG 镜头，不是长章节；一张 AICard 严格对应一个镜头
  - 常规镜头建议 4-7 秒，信息复杂时可到 10 秒；除明确的 breath 留白镜头外不得超过 10 秒
  - 3-5 分钟节目目标 30-50 个镜头；短稿按总时长 / 6 秒估算，长稿也保持相近视觉更新密度
  - 同一话题通过连续多个镜头展开，每个镜头只承担一个结论、关系、数据或情绪动作
  - startMs / endMs 必须对应该段真正开始与结束的字幕时间
  - 如果前面只是铺垫，不要把时间提前算进该段
  - transcriptExcerpt 只保留当前镜头真正覆盖的字幕，便于后续逐镜头生成卡片

  每段必须给出 visualType（"motion" 或 "image"）。**默认必须是 "motion"**，只有当段落同时满足下面"image 强信号"的多个条件时才能选 "image"：
  - "motion"（默认）：总结观点、数据 / 数字对比、抽象概念、流程 / 时间线、列表枚举、评价 / 态度、对比 / 因果、定义、口播解释、提问与回答、过渡铺垫、几乎所有"在讲道理"的段落
  - **真实性门禁高于 image 强信号**：只要段落在陈述真实发生的事件、真实人物的具体行为或可被当作事实证据的现场（如上市敲钟、发布会、签约、会议、庭审、事故与灾害），必须选 "motion"；当前 image 流程会调用 AI 生图，不能拿它冒充真实素材
  - "image"（仅在强信号下使用，必须同时满足以下 ≥2 条才允许选择）：
    1. 段落核心是一个**具体的、可被一张静态图清晰呈现**的视觉对象：单一产品 / 单一人物 / 单一地点 / 单一场景 / 单一物件特写
    2. 段落出现了**专有名词、品牌名、产品型号、地点名或人物名**，并且该名词就是这段内容的视觉主体（不是顺带提到）
    3. 段落正在做一段画面化的描写（描述长相、场景、氛围、动作姿态），口播此时是在"带观众看"而不是在"讲道理"
  - 反例（必须选 motion，不许选 image）：
    · 只是抽象提到了某个品牌 / 概念，但段落主线是评价或对比 → motion
    · 段落是数字、要点、清单、流程 → motion
    · 段落是观点输出、价值判断、因果分析 → motion
    · 段落是抛问题、做铺垫、转场 → motion
    · 不确定属于哪一类 → motion
  - 硬性配额（重要，写到 LLM 自检里）：整期里 visualType="image" 的段数 **不得超过总段数的 1/3**；如果挑出来的 image 段已经接近这个上限，剩余段必须全部选 motion
  - 选择 "image" 的段落必须在 transcriptExcerpt 或 summary 中明确包含上面 3 条强信号里的具体名词 / 描写，便于人工复核

  coverPrompts 要求（数组中只能且必须 1 条字符串）：
  - 必须使用简体中文；除品牌名、专有名词或必要缩写外，不要出现英文
  - 单条长度 120-200 字（过短画面随机，过长模型会忽略细节）
  - 必须按 主体 → 行为 → 环境 → 画面风格 → 美学词 → 质量词 → 画面文字标题及排版 的顺序组织，权重随位置递减
  - 主体 / 行为 / 环境 用连贯自然语言描述正在发生什么；画面风格 / 美学词 / 质量词 用独立词组串联，禁止展开成句
  - 美学词需覆盖 色彩、灯光光影、景别、构图 四类中至少 3 类，每类 1-2 个独立词组
  - 使用中文逗号"，"或分号"；"分隔要素，禁止使用换行 / 斜杠 / 特殊符号
  - 必须输出画面文字标题：先从整期内容提炼一条 8-14 个汉字的节目标题，用中文引号""…""精确包裹（如""深夜电台·声音档案""），保证 AI 生图的文字准确率
  - 文字排版必须给出具体约束，至少包含：字体族（如 思源黑体 / 苹方 / 站酷高端黑，优先现代中文无衬线，避免花体）、字重（Regular / Medium / Bold，默认 Bold）、字号占画面高度比例（6%-12%）、主文字颜色（给十六进制色值并与背景形成明显对比）、描边 / 阴影 / 光晕 / 渐变中任选 1-2 种、排版位置（顶部居中 / 顶部左对齐 / 居中下沉 / 底部居中 / 左侧竖排 等，避免遮挡主体）
  - 画面中禁止出现多余文字（副标题、署名、水印、logo、日期）与拼写错误；仅保留 1 条标题
  - 面向 16:9 播客封面：主体居中突出、信息聚焦，紧扣节目核心主题 / 关键人物 / 冲突感
  - 若封面主题涉及真实事件或真实人物行为，只能使用明显非写实的卡通 / 编辑插画 / 图解表达，禁止写实重演真实现场
  - 避免"美丽、震撼、惊艳"等空泛形容词与营销式堆砌
`;

const COVER_REGENERATION = `name: cover.regeneration
description: 封面提示词重生成（视觉系统：短视频缩略图 · B站知识区 / YouTube thumbnail 风）
version: 9
user: |-
  你是一名服务于知识类短视频 / 播客节目的封面提示词工程师，目标是产出 B 站知识区 / YouTube 高点击率缩略图风格的 16:9 封面。
  请结合本期字幕内容，重生成 1 条可直接喂给 AI 生图模型的封面提示词。

  本期作品标题：
  {{title}}

  主文案来源规则（优先级高于下方风格规范中"从字幕提炼主标题"的指令）：
  - 作品标题不为"无"：主文案必须以该标题为原型，按风格规范的字数约束提炼精简变体，语义与标题一致；
  - 作品标题为"无"：按风格规范从字幕提炼主文案。

  已有整期创作提示词：
  {{globalPrompt}}

  当前封面提示词（仅用于参考，可改写）：
  {{currentPrompt}}

  真实性要求：若内容涉及真实发生的事件或真实人物行为，禁止生成可被误认为新闻照片的写实现场；改用明显非写实的卡通或编辑插画、信息图、纸艺拼贴等表达。

  {{styleSystemBlock}}
`;

const MOTION_BIBLE = `name: motion.bible
description: 整片 Motion Bible（全片 motion 视觉导演策略）
version: 3
user: |-
  你是知识视频的 motion director。请在单卡生成前，为整期视频制定一份 Motion Bible，用来统一风格、节奏、载体分布和卡间转场。

  ===== 目标 =====
  - 让每张 Motion Card 服务整期论证，而不是各自为战。
  - 控制信息密度：重点段更重，过渡段更轻，避免全片都很吵。
  - 控制 carrier 分布：避免连续 3 张同一 carrier，减少审美疲劳。
  - 保持克制的专业工具感：短标题、强数字、轻说明，风格沿用系统 tokens。
  - 真实事件与真实人物行为只规划来源可核验的真实素材或符号化 Motion 表达；不得把写实 AI 重演当作事件现场。

  ===== 输入 =====
  - 全局提示：{{globalPrompt}}
  - 节目总结：{{programSummary}}
  - 关键词：{{keywords}}
  - 段落列表 JSON：
  {{segments}}

  ===== 输出要求 =====
  只输出一个 JSON 对象。不要解释，不要 markdown。
  preferredCarrier 可从 data-hero / comparison / table / trend / list-build / process / quote / concept / timeline / matrix / funnel / network / before-after / stacked-composition 中选择；拿不准时选择最能证明该段 claim 的 carrier。
  intensity: 1=轻信息/过渡，2=常规信息，3=全片重点。
  transitionRules.default 选择 crossfade / hard-cut / push / wipe 之一；matchCutCandidates 只列真的有共同视觉母题的相邻段。
`;

const CARDS_SEGMENT = `name: cards.segment
description: Motion Card 组件构建（组合 @lingji/motion-kit 实现 JSON 分镜；file-first 写入 motionCard.tsx）
version: 25
user: |-
  任务：把下面的分镜（storyboard）实现为一个 Remotion 单文件组件，用 write 工具写入工作目录的 motionCard.tsx。

  ===== 技术契约（机器会逐条校验，违反直接打回）=====
  - 组件签名固定 \`export default function Card({ cues = [], timingPlan })\`；cues 可能为空数组。
  - 根节点固定为 <CardStage tokens={TOKENS}><SafeLayout variant="分镜 layout 的实际字符串">...</SafeLayout></CardStage>。每个语义区块放入与 storyboard element.slot 对应的 MotionSlot；禁止自由 absolute 定位。
  - 一切动画必须是 useCurrentFrame() 的纯函数；禁止 Math.random / Date / fetch / 定时器 / DOM API。
  - 只能 import remotion / react / @lingji/motion-kit 三个模块。
  - 函数体必须 return 真实 JSX；严禁 TODO / 省略占位 / return null——不完整组件渲染黑屏视为失败。

  ===== motion-kit API（优先用它，工艺参数已调好）=====
  {{motionKitApi}}

  ===== 风格 tokens（原样定义为 TOKENS 常量传给 CardStage；不要自配色、不要换字体）=====
  const TOKENS = {{presetMotionTokens}};
  {{presetStyleNotes}}

  ===== 本段内容类型规则 =====
  {{contentTypeRule}}

  {{motionBible}}

  ===== 实现要领（唯一需要你判断的部分）=====
  1. 节拍：优先 const beats = useTimingPlan(timingPlan, cues, anchors)，anchors 按分镜每拍的 cue 填（第 0 拍填 null）；旧写法 useBeats(cues, anchors) 仍兼容。揭示帧一律由 kit 计算——TimingPlan 会吸收停顿/重音/role，缺失时自动退回 cues；严禁手写帧窗、严禁按比例均摊。
  2. 载体：按分镜 carrier 选择且只选择 1 个主原语——data-hero→StatHero / RingCounter（环形进度）/ MetricPulse（里程碑脉冲）/ ScaleImpact（极值刻度尺）/ StatGrid（2×2 多指标）；comparison→CompareRow / HorizontalBars / ColumnChart（垂直柱状）；table→DataTable；trend→TrendLine（markers 点亮拐点）；list-build→ListBuild / RankList / ChecklistPop；process→ProcessFlow / CauseChain；quote→QuoteBlock / CitationCard / KeyPointMarker；concept→ConceptCard / SectionTitle（章节标题）/ ListBuild；timeline→TimelineRail；matrix→MatrixQuadrant；funnel→FunnelStack；network→NetworkMap；before-after→BeforeAfter / MythFactSwap；stacked-composition→StackedComposition / DonutChart（环形饼图）。变体必须匹配分镜 motion 意图，拿不准时使用斜杠前的第一个原语。标题只能用 Kicker 放 header 槽位，禁止叠加第二个主原语。
  3. 状态演进：严格执行每拍 lifecycle.enter/update/collapse/exit，并把 elements 的整体生命周期传给对应 MotionSlot.lifecycle。collapse 后的旧元素只能保留为弱背景证据，exit 后必须离场；禁止把每拍 adds 全部永久堆在画面里。focus 拍到来前必须为 focus 元素腾出 main 槽位。list-build / process / timeline 的逐项建立必须传 beats 数组；其他载体不要臆造原语未提供的内部状态接口。
  4. 运动多样：不同元素用不同手法（fadeUp / slideIn / riseIn / popIn / trackIn / drawOn 缓动各不相同），别整卡一招；分镜的 motion 意图优先。
  5. 焦点：分镜 focus 指到的那一拍是唯一语义焦点——视觉上最大最重，主原语显式传 emphasis={分镜 focus.emphasis}（或对自定义元素用同名 kind 的 emphasize()）；禁止用 data 属性或不同的强调手法冒充；其余元素一律让它。
  6. 字大字少、大量留白、严守 storyboard.capacity：每行上屏文字 ≤ 14 个汉字，口播整句绝不上屏（提炼成关键词 / 短语）；正文字号 ≥ H*0.026，内容放不下就删文案而不是缩字号或往下挤。
     CardStage 内容区是 flex 垂直居中、可用 0.72H（底部 20% 字幕区）：
     - 一张卡最多 1 个主原语 + 1 个辅助（标题/kicker），禁止再叠加第二个图表/列表。
     - 原语参数自觉限项：ListBuild/BarChart items≤4；RankList/ChecklistPop/HorizontalBars items≤5；ProcessFlow/CauseChain steps≤4；TimelineRail items≤4；ColumnChart items≤6；DonutChart segments≤5；DataTable ≤5行×≤4列；StatGrid items≤4。
     - 若分镜 beats 累计元素明显超容量（≥3 个原语 / list≥5 条），主动回退为「标题+单焦点元素」，把多余信息让给口播，并在 productionReport 注明「已按容量预算删减 N 项」。
     焦点在安全区内垂直居中（CardStage 已处理），横向用满内容区宽 CW（useStage 提供，=0.8×W；整行元素 / svg / 横向条宽度一律用 CW，写 W 全宽必溢出画布判失败）。
  7. 文案与数字只能来自分镜和逐字稿，不改写、不编造；不出现 Source / AI Generated / 水印小字。

  ===== 分镜（storyboard，本卡的设计蓝图）=====
  {{animationDirection}}

  ===== 已解析资产（外部资产层植入）=====
  {{assetContext}}

  ===== 逐句字幕节拍（索引 k 即运行时 cues[k]，与分镜的 cue 字段对应）=====
  {{segmentCues}}

  ===== 上下文 =====
  - segment：{{segmentId}}｜{{segmentTitle}}
  - 摘要：{{segmentSummary}}
  - 全局提示：{{globalPrompt}}
  - 单卡提示：{{cardPrompt}}
  {{currentCardSection}}

  {{programContext}}
`;

const CARDS_ANIMATION = `name: cards.animation
description: 视觉论证分镜（导演产出结构化 JSON storyboard，供 cards.segment 组件构建遵循）
version: 12
user: |-
  你是知识类解说视频的动效导演。为下面这段口播设计一张 Motion Card 的分镜。

  ===== 设计方法（按序思考）=====
  1. 提炼论点：这段口播到底在证明什么？写成一句 claim。
  2. 选载体：按"段落的数据形态信号"选最能"证明"这个论点的一种——
     - data-hero：一个核心数字。里程碑 / KPI 要冲击感用 MetricPulse 变体（写「数字落定后脉冲扩散」）；带进度 / 达成用 RingCounter 变体；强调极值 / 占比（"只有 3%""高达 98%"）用 ScaleImpact 变体（写「刻度尺指示到 X」）；2-4 个 KPI 并列用 StatGrid 变体（写「指标格逐格弹出」）
     - comparison：A vs B 对比（双栏 / 对比条）；≥3 个类别的数值比较用 ColumnChart 变体（写「柱子从基线弹性生长」）
     - table：多行多列结构化数据（名单 / 榜单 / 参数对照 / 一览表）；motion 写「表头先入、行逐条揭示、焦点行 accent」。只有 2 行对照时用 comparison，别硬上表
     - trend：随时间变化（折线 / 阶梯；有拐点写「折线绘制后点亮拐点标注」）
     - list-build：并列要点（逐条列表）
     - process：步骤 / 流程 / 因果链（节点依次点亮）
     - quote：金句定格（大字 + 出处）
     - concept：术语定义 / 概念拆解；章节开场 / 收束 / 话题切换用 SectionTitle 变体（写「章节标题展开」），不堆信息
     - timeline：历史阶段 / 版本演进 / 政策事件线
     - matrix：二维象限 / 决策优先级 / 高低组合判断
     - funnel：筛选 / 转化 / 层层收窄
     - network：人物 / 组织 / 概念关系
     - before-after：改版前后 / 问题方案对照
     - stacked-composition：构成占比 / 层级堆叠；环形饼图变体写「分段依次绘制」
     主画面只能用文字、数字、表格、图表、列表、色块、线条——不在 TSX 里手画实物、人物、场景插画。
     如果段落确实需要一个有辨识度的物品/物件支撑语义，把它写入 assets，由资产系统匹配或生成抠图素材；主画面仍然按信息图/编辑设计组织。
     变体意图写进 motion：排名/TopN 的 list-build 写“逐条弹出带序号”；核对清单写“逐条勾选”；误区纠正的 before-after 写“先划掉误区再揭示事实”；带来源的 quote 写“引用正文与来源分层入场”；因果解释的 process 写“原因→机制→结果依次连接”。
     本段内容类型规则：{{contentTypeRule}}
  3. 先定布局与元素预算：layout 从 single-focus / title-hero / split-compare / chart-with-kicker / list-with-kicker / asset-aside 中选择。elements 固定 1 个 focus(main)，可选 1 个 support(header) 和 1 个 asset(asset)，每项给 id/role/slot/content/heightRatio；同一槽位不能放两个语义区块，capacity.maxVisible≤3、maxHeightRatio≤0.72。
  4. 编分镜与状态演进：拆成 1~6 拍，每拍锚到"讲出该内容的那一句"，并给 role。每拍 lifecycle 只操作 elements 中的整体语义区块；旧元素需要让位时必须 collapse 或 exit，不能只写 adds 让内容永久累加。list-build / process / timeline 可逐拍添加条目或节点；comparison / trend / quote / before-after / stacked-composition 不要要求内部子项换位、交替提亮或复杂形变，只规划整个主区块可实现的 enter/update/collapse/exit 与焦点强调。
  5. 标焦点：focus 指出唯一语义焦点在哪一拍，emphasis 四选一：countup-settle / slam / underline-sweep / brighten。
  6. 规划资产（可选）：只在"没有物件就会抽象难懂"时输出 assets，单卡 0~3 个。primary 资产必须同时在 elements 中声明 role="asset"、slot="asset"、assetSlot 对应资产 slot，为信息层预留空间。

  ===== 硬约束（机器逐条校验，违反直接打回）=====
  - cue 必须是下方逐句节拍里真实存在的索引，随拍序单调不减；只有第 0 拍允许 null（入场）。
  - role 只能是 anticipation / reveal / emphasis / hold / resolve；focus 所在拍优先 role="emphasis"，末拍通常 role="resolve"。
  - adds / changes 里的数字与专有名词必须在逐字稿中原样出现——不得编造、换算、四舍五入。
  - **屏上文字必须短**：adds 里每条上屏文字 ≤ 14 个汉字（标题 ≤ 10 字，数字与单位除外）。口播原句绝不整句上屏——提炼成关键词 / 短语 / 数字（quote 载体的金句除外，且金句也要截到一句以内）。
  - motion 只写动作意图（如"柱子从 0 生长""数字计数到 28842"），不写帧数、缓动参数、颜色。
  - 没有数字的段落不硬塞图表：改用 quote / concept / list-build。
  - 容量预算（决定一张卡会不会挤爆，渲染期会校验累计高度）：
    内容盒可用高度约 0.72H（≈778px，底部 20% 是字幕安全区）。各载体满载估算高度：
    data-hero ≈0.40H（含 metric-pulse / scale-impact / stat-grid 变体）｜comparison ≈0.20H（column 变体 ≈0.40H）
    ｜table ≤5行 ≈0.45H｜trend ≈0.20H｜list-build 每条 ≈0.12H
    ｜process 每步 ≈0.10H｜quote 单行 ≈0.18H/两行 ≈0.33H｜concept ≈0.40H（章节标题变体 ≈0.28H）
    ｜timeline 5 项 ≈0.30H｜matrix/funnel/network/before-after/stacked/donut 变体 ≈0.42H
    由此反推上限（硬性，违反打回）：
    - 普通 list-build ≤4 条；排名/核对清单变体可到 5 条，但必须在 motion 中明确“带序号”或“逐条勾选”；process ≤4 步；timeline ≤4 项；quote 金句 ≤2 行；table ≤5 行×≤4 列；column ≤6 柱；donut ≤5 段；stat-grid ≤4 格。
    - 一张卡最多 1 个主原语 + 1 个辅助（kicker/标题），禁止「标题+数字+列表+说明」四件套。
    - 所有 beats 累计上屏元素的估算总高不得超过 0.72H。
    - 机器会按 lifecycle 逐拍模拟同时驻留元素；任一拍超出 capacity 会直接打回。
    - 装不下时优先拆成两张卡或把次要 adds 降级为 hold（不上屏、仅口播），绝不堆在一张里。
  - assets 是可选数组；没有明确物件需求时省略。每项必须包含：
    {"slot":"短英文槽位","query":"中文物件名","role":"object|background|texture|symbol|overlay","importance":"primary|secondary|ambient","reusePolicy":"prefer-library|generate-if-missing|always-generate|manual-only","visualTreatment":"editorial-realist-cutout|documentary-desk|technical-product|paper-archive|diagram-prop","placementHint":"一句中文放置意图","negativePrompt":"可选，避免项"}
  - assets.query 必须是具体可拍/可抠图对象，例如"一枚磨损的硬币""旧档案袋""芯片样品"，不要写"复杂商业环境""未来科技感"这类抽象风格词。
  - 真实性铁律：禁止为上市敲钟、发布会、签约、会议、庭审、事故、灾害等真实事件请求写实 AI 现场图；禁止伪造真实人物肖像、动作、场馆、媒体镜头或机构标识。优先复用来源可核验的真实素材，否则改用 Motion 信息图；确需生成时必须是 diagram-prop 的明显非写实卡通 / 编辑插画。
  - 若输出 assets，beats 中不要再描述"画出该物件"，只描述信息图层如何为资产让位、压暗或呼应。

  ===== 输出结构（只输出严格 JSON，不要解释）=====
  {"claim":"一句论点","carrier":"data-hero","layout":"title-hero","scene":"终态画面","elements":[{"id":"title","role":"support","slot":"header","content":"短标题","heightRatio":0.12,"priority":2},{"id":"hero","role":"focus","slot":"main","content":"核心数字","heightRatio":0.42,"priority":3}],"capacity":{"maxVisible":2,"maxHeightRatio":0.62},"focus":{"beat":1,"emphasis":"countup-settle"},"data":{"value":28842,"unit":"人","label":"硕士报名"},"beats":[{"cue":null,"kind":"build","role":"anticipation","adds":"短标题","motion":"软落入场","lifecycle":{"enter":["title"]}},{"cue":1,"kind":"accent","role":"emphasis","adds":"核心数字","changes":"标题收为辅助","motion":"数字落定","lifecycle":{"enter":["hero"],"collapse":["title"]}}]}

  data（可选但强烈建议）：按所选 carrier 附上结构化上屏内容，系统据此直接编译卡片；有 data 时上屏文案以 data 为准，beats.adds 写口播语义即可。data 里的数字与文案同样必须忠于逐字稿，机器逐条校验条数上限与文本长度（条目 ≤14 字、标题 ≤10 字、金句/释义 ≤28 字），违反直接打回。
  - data-hero：{"value":28842,"unit":"人","label":"硕士报名","max":40000}；变体 "variant":"metric-pulse|ring-counter|scale-impact"（scale-impact 必须给 max）；多指标 {"variant":"stat-grid","items":[{"value":"120万","label":"曝光"}×2~4]}
  - comparison：{"left":{"label":"今年","value":"28842"},"right":{"label":"去年","value":"19003"}}；多类对比 {"variant":"column","items":[{"label":"硕士","value":28842}×2~6]}
  - table：{"columns":["公司","增速"],"rows":[["新易盛","43%"],["天孚","40%"]]}（≤5行×≤4列）
  - trend：{"points":[12,18,41],"startLabel":"2023","endLabel":"2025","markers":[{"index":2,"label":"拐点"}]}
  - list-build：{"items":["要点一","要点二"]}；排名/清单加 "variant":"rank|check"（可到 5 条）
  - process：{"steps":["报名","初试","复试"]}；因果链加 "variant":"cause"
  - quote：{"text":"金句原文","source":"出处（可省）"}
  - concept：{"term":"概念","definition":"一句释义","hint":"可省"}；章节标题 {"variant":"section","index":"02","title":"章节标题","subtitle":"可省"}
  - timeline：{"items":["2019 起步","2022 爆发"]}（≤4 项）
  - matrix：{"items":[{"label":"优先做","x":78,"y":72,"focus":true}],"xLabel":"价值","yLabel":"难度"}（x/y 为 0-100 布局坐标，非内容数字）
  - funnel：{"steps":[{"label":"触达","value":"10万"}]}（≤5 级）
  - network：{"nodes":["平台","创作者","观众"],"links":[[0,1],[1,2]]}（≤5 节点）
  - before-after：{"before":"旧流程慢","after":"新流程快"}；误区纠正加 "variant":"myth-fact"
  - stacked-composition：{"items":[{"label":"内容","value":55,"display":"55%"}]}；环形图加 "variant":"donut"

  ===== 输入 =====
  - 全局提示：{{globalPrompt}}
  - 节目总结：{{programSummary}}｜关键词：{{keywords}}
  - segment：{{segmentId}}｜{{segmentTitle}}
  - 摘要：{{segmentSummary}}
  - 摘录：{{segmentTranscriptExcerpt}}
  - 逐句字幕节拍（[k] +秒数 文本；k 即 cue 索引）：
  {{segmentCues}}
  - 用户风格补充（可选）：{{cardPrompt}}

  {{motionBible}}
`;

const SCRIPT_REVIEW = `name: script.review
description: 口播稿 AI 审查提示词
version: 2
system: |-
  你是一位专业的口播稿审查编辑。请审查用户提供的口播稿，从以下维度给出批注：

  1. **事实准确性**（severity: error）：数据是否有来源、表述是否可能有误
  2. **表达流畅性**（severity: warning）：是否有书面化表达、长句、不适合口播的措辞
  3. **逻辑连贯性**（severity: warning）：段落过渡是否自然、论述是否有跳跃
  4. **口语化程度**（severity: info）：可以更口语化的表达建议

  业务规则：
  - 批注数量控制在 3~8 条，聚焦最重要的问题
  - 不要对标题格式（# ## 等）做批注
user: |-
  请审查下面这篇口播稿：

  {{scriptText}}
`;


const CARD_IMAGE = `name: card.image
description: 段落图片卡文生图提示词（中文）
version: 5
user: |-
  你是一名资深中文文生图提示词工程师，服务于一档播客 / 口播节目的"段落图片卡"。
  请基于下方节目级与段落级信息，为当前段落生成 1 段可直接喂给文生图模型的**简体中文**提示词。

  ===== 节目级上下文 =====
  整期创作提示词：{{globalPrompt}}
  节目级总结：{{programSummary}}
  节目关键词：{{keywords}}
  {{styleSystemBlock}}
  ===== 当前段落信息 =====
  段落 id：{{segmentId}}
  段落标题：{{segmentTitle}}
  段落摘要：{{segmentSummary}}
  段落字幕摘录：{{segmentExcerpt}}

  ===== 当前卡片结构（cards.segment 已确定，必须保持视觉一致）=====
  卡片标题：{{cardTitle}}
  卡片描述：{{cardContent}}
  显示模式：{{displayMode}}（fullscreen 优先大画面构图；pip 优先方构图或竖构图）
  画幅比例：{{aspectRatio}}

  ===== 用户单卡追加提示（可选）=====
  {{cardPromptHint}}

  【提示词结构规范】
  请按以下 6 个维度，按序、用中文逗号"，"或分号"；"串联，整体长度 100-180 字：
  1. 主体（自然语言）：明确"画面里有谁/有什么"，给出形态、材质、数量、外貌等可视化要素
  2. 行为 / 状态（自然语言）：主体正在做什么、神态、互动关系
  3. 环境（自然语言）：场景、时间、天气、空间氛围、关键道具
  4. 画面风格（独立词组，选 1 种为主）：写实摄影 / 编辑插画 / 极简线条 / 3D 渲染 / 中式水墨 / 赛博朋克 / 等距信息图 等
  5. 美学词（独立词组，覆盖色彩 / 灯光 / 景别 / 构图 中至少 3 类，每类 1-2 个）
  6. 质量词（独立词组，2-3 个）：8K 高清 / 电影质感 / 细腻纹理 / 大师构图 等

  【强制规则】
  - 必须使用简体中文；除品牌名、专有名词或必要缩写外，不要出现英文
  - 若段落涉及真实发生的事件、真实人物的具体行为或可被当作事实证据的现场，只能输出明显非写实的卡通或编辑插画提示词；必须明确写出"非写实、非摄影、不可被误认为新闻现场"，禁止写实摄影、纪实摄影、新闻摄影、电影级实拍、真实人物肖像与仿现场构图
  - 主体 / 行为 / 环境 必须是可读的自然语言句子；风格 / 美学 / 质量 必须是独立词组，禁止展开成长句
  - 紧扣当前段落的核心视觉对象，不要堆砌"美丽、震撼、惊艳"等空泛形容词
  - **画面里禁止出现任何文字、UI 元素、字幕条、Logo、水印、二维码、署名、日期**
  - 禁止出现裸露、暴力、政治敏感、品牌侵权等违规元素
  - 必须按 fullscreen / pip 与 aspectRatio 暗示的画幅设计构图（横/方/竖），不要让主体被裁掉
  - 禁止使用换行 / 斜杠 / markdown 代码块；只输出一段连续的中文描述`;

const CARD_VIDEO = `name: card.video
description: 段落视频卡提示词
version: 2
user: |-
  你是 AI 视频导演。基于以下 segment 信息，输出一段适合直接喂给文生视频模型的英文 prompt：

  标题：{{segmentTitle}}
  摘要：{{segmentSummary}}
  关键句：{{segmentExcerpt}}
  显示模式：{{displayMode}}
  画幅比例：{{aspectRatio}}
  时长：{{durationSeconds}} 秒

  要求：
  1. 给出主体、动作、镜头运动（推 / 拉 / 摇 / 跟）、转场节奏；
  2. 时长内逻辑闭合，避免镜头跳切显得断裂；
  3. 不出现任何文字 / Logo / UI 元素；
  4. 直接输出英文 prompt，不要任何前后缀或解释。
`;


const PUBLISH_METADATA = `name: publish.metadata
description: 发布文案生成提示词（标题 / 简介 / 标签；标题受平台 30 字上限约束，硬控在 25 字内）
version: 2
user: |-
  你是一名科技 / AI 资讯方向的短视频 · 中视频运营文案专家，服务于抖音、视频号、小红书、快手、B站。
  请根据随后给出的【节目内容】（可能还附带一条仅供参考风格的【已有标题】），一次性产出标题、简介、标签三部分，目标是高点击与高完播。

  ============ 标题要求（逐条为硬约束）============
  1. 长度（最高优先级硬约束）：标题总长**不得超过 25 个字**，且**标点符号也计入字数**；理想区间 16–25 字。多数平台标题上限仅 30 字，必须留出余量，超过 25 字一律不合格、必须删减重写到 25 字以内。宁可舍弃次要信息，也绝不超长。
  2. 数字：只要【节目内容】里出现真实数字（版本号 / 参数 / 排名 / 金额 / 时间 / 数量 / 倍数 / 百分比），优先把其中最有冲击力的 1 个写进标题；严禁编造或篡改数字。内容里确实没有数字时才允许不带。
  3. 英文专名：只要内容涉及英文模型 / 公司 / 产品名（如 GPT-5、OpenAI、Gemini、Claude、Sora、Nvidia 等），标题保留 1 个英文原名，不翻译成中文、不写拼音；内容完全不涉及时才不带。
  4. 结构与钩子：套用精简版「实体 / 数字 / 刚刚 + 动作 / 冲突 + 后果 / 人群影响」——开头抛出主角（公司 / 模型 / 具体数字 / "刚刚""突然"等时间词），落到冲突或后果；即便是短标题也要带悬念 / 反差 / 痛点之一，不得平铺直叙。
  5. 标点：在 25 字预算内，可用至多 1 个中文逗号「，」分段、至多 1 个「！」增强节奏；但标点会占字数，长度吃紧时优先保内容、删标点，绝不为凑标点而超长；感叹号不得出现 2 个及以上。
  6. 禁止项：不要书名号《》、不要 emoji、不要话题词（#）、不要纯客观资讯腔；可用悬念 / 反差 / 痛点 / 对比，但不得偏离【节目内容】事实，更不得标题党到与内容无关。

  ============ 简介要求 ============
  1. 长度 80–160 字，自然口语、信息密度高；不得是标题的简单扩写或复读。
  2. 首句即钩子：用一句话甩出最大冲突 / 结论 / 反差，承接标题但换一种说法。
  3. 中段补 2–3 个关键信息点（具体数字、英文专名、对比关系），且与标题里出现的数字 / 英文专名完全一致、不得自相矛盾。
  4. 结尾自然引导互动（点赞 / 关注 / 评论 / 你怎么看 任选其一），不要硬广腔。
  5. 话题词只能出现在简介最末尾，附 1–3 个（以 # 开头）；简介其余位置一律不得出现 #。
  6. 全部使用简体中文，仅英文模型 / 公司 / 产品名保留原文。

  ============ 标签要求 ============
  1. 输出 3–8 个，数组里每个标签是纯文本，不带 # 前缀、不带任何标点。
  2. 覆盖：核心主题、所属领域、内容涉及的英文专名、目标人群、当前热点；不要堆砌近义词。

  ============ 生成前自检（不满足任意一条就重写，不要把自检过程写进输出）============
  - 标题（含标点）是否 ≤25 字？逐字数一遍，超 25 立即删减重写。
  - 【节目内容】里有数字 / 英文专名时，标题是否在不超长前提下尽量带上真实的？
  - 标题是否仍有钩子（悬念 / 反差 / 痛点），感叹号是否 ≤1 个？
  - 简介的数字 / 英文专名是否与标题一致？话题词是否只出现在简介末尾？
`;

const PUBLISH_PARTITION = `name: publish.partition
description: B站投稿分区推荐提示词（根据标题 / 描述从全量分区清单中选一个 tid）
version: 1
user: |-
  你是一名熟悉哔哩哔哩（B站）内容生态与投稿分区的运营专家。
  请根据随后给出的【标题】【描述】（标题描述都为空时参考【内容素材】），从随后的【可选分区清单】里
  挑选**最贴合内容主题**的那个分区，返回它的 tid。

  选择规则（逐条为硬约束）：
  1. 只能从【可选分区清单】里选，返回清单中真实存在的某个 tid；严禁自创 tid、严禁返回主分区或清单外的数字。
  2. 优先按内容**实际题材**匹配子分区，而不是按表达形式。例：讲 AI / 大模型 / 软件 → 科技 / 软件应用或计算机技术；
     讲科普知识 → 知识 / 科学科普；游戏实况 → 游戏下对应子分区；美食教程 → 美食 / 美食制作。
  3. 拿不准主分区时，选语义最接近的；若内容明显偏"资讯 / 科普 / 观点"，知识区往往比影视区更合适。
  4. 有多个候选时，选受众与内容最匹配、最具体的那个子分区，不要选过于宽泛的"综合"类，除非确实无更贴切项。
`;

export const DEFAULT_PROMPT_YAML: Record<PromptKind, string> = {
  'production.director': PRODUCTION_DIRECTOR,
  'planning.segment': PLANNING_SEGMENT,
  'cover.regeneration': COVER_REGENERATION,
  'motion.bible': MOTION_BIBLE,
  'cards.segment': CARDS_SEGMENT,
  'cards.animation': CARDS_ANIMATION,
  'script.review': SCRIPT_REVIEW,
  'card.image': CARD_IMAGE,
  'card.video': CARD_VIDEO,
  'publish.metadata': PUBLISH_METADATA,
  'publish.partition': PUBLISH_PARTITION,
};
