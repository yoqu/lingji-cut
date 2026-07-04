# Motion Card 生成体系重构方案

> 状态：**已实施**（2026-07-03）。除以下两点按降级路径落地，其余全部按方案交付：
> ① 视觉审查：pi 无头 API 仅支持文本输入，审查员按降级路径改为"分镜 vs 代码"设计兑现度核对（5 问），机械项由 lint + 布局探针（新增字幕安全区检查）承担；
> ② kit 注入：卡片 TSX 是 esbuild transform 单文件编译，无需 esbuild alias——在 card-host / smoke-render 两处 require 垫片注入 `@lingji/motion-kit`（`createMotionKit(Remotion)` 工厂绑定各自的 remotion 实例）。
>
> 落地文件：`src/remotion/motion-kit/index.tsx`（运动库+API 摘要）、`src/lib/motion-card-lint.ts`、`src/lib/motion-storyboard.ts`、`src/lib/prompts/defaults.ts`（cards.segment v19 / cards.animation v5）、`resources/pi-agents/agents/*.md`（v2/v2/v3）、`electron/pipeline/motion-agent-run.ts`（分镜校验回喂 + lint 前置）、10 个预设 `motionTokens`。测试：`tests/motion-{kit-card,card-lint,storyboard,agent-run}.test.ts` + `tests/e2e-motion-card-real.test.ts`（`LINGJI_E2E=1` 真实出卡）。
>
> **真实 AI 端到端已验证**（2026-07-03，考研数据段实测）：导演产出合法 comparison 分镜（cue 锚定 [null,1,2,2,4] 与口播逐句对齐、数字忠实）→ 雕刻组合 kit（等比对比条+countUp+三种手法+状态演进）→ lint/编译/冒烟/布局探针全过 → 审查回炉 2 轮后通过。实测驱动的三项校准：布局探针改判"真裁切"（元素自身 overflow 才算）+ 越界容差吸收镜头出血；分镜与实现层加"屏上文字 ≤14 字、口播整句不上屏"硬约束（内容超高挤入字幕区的根因）；MAX_FIX_ITER 2→3、storyboard 字段别名归一化（省重出轮次）。

---

## 一、诊断：为什么现在的提示词又长又不好

当前体系的失效不是"规则不够多"，而是**架构性**的，加规则只会更糟：

1. **补丁堆积型提示词**。cards.segment 走到 v18，约 70% 内容是"违反即重做"的禁令——每条铁律对应一次历史翻车。模型的注意力全部花在合规上，而不是设计上；且禁令互相挤压（"要多样"+8 条反禁忌+幅度天花板），模型收敛到最安全的最小动效——正是要治的"PPT 感"。
2. **同一套规则五处重复**。动效词汇表 / 编排三律 / 安全区 / 确定性约束同时出现在 cards.segment、cards.animation、card-sculptor.md、card-reviewer.md、9 个预设的动效散文里。改一处漂移四处，每张卡光指令就烧 6-8k tokens。
3. **机器可查的事写给模型看**。禁 Math.random、底部 padding ≥ H*0.20、spring ≤16 帧收敛、cue 单调不减……这些全部可以用静态 lint / 布局探针 / JSON 校验确定性检查，却占了提示词的大半。**凡是代码能检查的，不该消耗提示词 token，更不该指望模型自觉。**
4. **导演产出的是"入场编排表"，不是运动设计**。cards.animation 的输出格式强制"每拍 = 元素 + 手法 + 缓动"，本质是给一叠幻灯片挑漂亮的入场动画。MG 的核心——**一个连续场景的状态演进**（元素转化、保持、让位）——在这个格式里没有载体。这是"像 PPT"的真正根因，不是缓动不够多。
5. **审查员读代码打分**。视觉质量无法从源码判断；12 条清单里 10 条机器可查；JSON 解析失败按通过处理——实际的质量门只剩编译+冒烟渲染。
6. **工艺靠散文传递**。好的 spring 参数、tabular-nums、draw-on 时长……每张卡都要求模型现场重新发明一遍，质量方差必然大。

## 二、第一性原理：知识类视频的 MG 动画本质

从 Vox / 回形针 / B 站知识区解说的制作方法出发，只有五条真原理：

1. **画面是论证，不是装饰**。每一帧回答"观众此刻需要看见什么才能懂这句话"。先选信息载体（这段该用一个大数字、一张对比表还是一条趋势线），再谈动效——载体选错，动效再好也没用。
2. **运动承载语义**。增长→生长，对比→并置，流程→依次点亮，因果→推挤。动效的价值在"变化表达关系"；入场动画是最不重要的动画。
3. **一卡一场景**。MG 是连续镜头里的状态演进，不是一叠幻灯片。新信息进来时，旧信息**保持 / 转化 / 让位 / 弱化**，而不是反复"飞入新东西"。
4. **节奏来自语音**。口播是母带，画面是伴奏（现有 cues 机制正确，保留）。两层节奏：**大拍**（信息状态变化，锚句子）+ **小重音**（高亮 / 下划线扫过 / 数字跳动，锚细节）。
5. **工艺是常量，不是创意**。好缓动、好间距、收敛参数是确定的最佳实践 → 应固化在**代码库**里，多样性来自组合而非每次重写。

## 三、新架构：三层分离

```
L3 创意（提示词，短）   选载体、编分镜、写内容 —— 只有这层需要模型判断
L2 风格（数据，JSON）   预设 = design tokens + 氛围签名 + 运动人格权重
L1 工艺（代码）         motion-kit 运行时库 + 静态 lint —— 合规与质感由构造保证
```

核心决策：**把工艺从散文搬进代码**。新增 `@lingji/motion-kit` 运行时库（esbuild alias 注入，预览/导出同一编译产物），把现在 10 种手法、摄影机、装饰层、安全区、落地强调全部实现为组件与函数。模型"组合原语"而不是"背诵规约"。

## 四、新流水线：4 阶段（角色重定义）

```
① 视觉论证设计（导演）      段落+cues → 结构化 JSON storyboard（机器可校验）
② 组件构建（雕刻）          storyboard + kit API + tokens → motionCard.tsx
③ 机械质检（无 LLM）        编译 + 静态 lint + 布局探针 + 冒烟渲染，失败回喂 ≤2 轮
④ 视觉审查（审查员）        渲染各拍落点关键帧截图 → 多模态审查设计兑现度
```

编排器（motion-agent-run.ts）的循环骨架、abort、进度回调**保持不变**，只换各阶段的输入输出契约。

### ① 导演：输出 JSON storyboard（替代逐拍文字脚本）

7 种知识视频原型穷举约 95% 的段落：

| carrier | 适用 | 终态画面 |
|---|---|---|
| `data-hero` | 一个核心数字 | 大数 + 单位 + 一条配重条 |
| `comparison` | A vs B | 双栏 / 对比条 |
| `trend` | 随时间变化 | 折线 / 阶梯 |
| `list-build` | 并列要点 | 逐条列表 |
| `process` | 步骤·流程·因果链 | 节点依次点亮 |
| `quote` | 金句 | 大字定格 |
| `concept` | 术语定义·概念拆解 | 词 + 定义 + 拆解块 |

输出 Schema：

```jsonc
{
  "claim": "一句话论点",
  "carrier": "data-hero | comparison | trend | list-build | process | quote | concept",
  "scene": "一句话描述整卡终态画面",
  "focus": { "beat": 2, "emphasis": "countup-settle | slam | underline-sweep | brighten" },
  "beats": [
    {
      "cue": 0,                       // 锚到讲出该内容的那一句；单调不减
      "kind": "build | transform | accent",
      "adds": "新出现的元素及内容（数字/专名必须来自逐字稿原文）",
      "changes": "已有元素怎么变：保持/转化/让位/弱化（可省略）",
      "motion": "一句动作意图，如'柱子从 0 生长'——不写帧数不写缓动参数"
    }
  ]
}
```

**JSON 换来的是确定性校验**（storyboard-lint，纯代码）：
- cue 索引合法、单调不减、< 句子总数 → 彻底消灭"按比例均摊"和"锚定漂移"；
- beats 1-6、adds 内容密度上限 → 替代"信息密度铁律"；
- **数字与专名必须在逐字稿中原样出现**（字符串匹配）→ 替代"数据忠实"铁律，防编造；
- carrier 枚举 → "禁具象实物"在结构上不可能违反。
校验失败直接回喂导演重出，不进入雕刻阶段。

### ② 雕刻：组合 motion-kit

输入 = 技术契约（~15 行）+ kit API 摘要（~40 行）+ storyboard JSON + preset tokens + 逐字稿。不再有词汇表 / 三律 / 反禁忌散文。

### ③ 机械质检：提示词规则 → 静态 lint

在现有 `assertCardRenders`（编译+冒烟+布局探针）前加一道 tsx-lint（regex/AST，毫秒级）：

| 现 v18 铁律 | 去向 |
|---|---|
| 禁 Math.random / Date / fetch / timer / rAF | lint（禁 API 扫描） |
| 底部字幕安全区 y ≥ H*0.80 | CardStage 内置 + 布局探针（已有） |
| cue 锚定 / 单调 / 禁均摊 / 禁硬编码帧窗 | storyboard-lint + kit `reveal()` |
| 10 种动效手法词汇表 | kit 函数（fadeUp/drawOn/countUp/slam/cascade/trackIn/…） |
| 编排三律（≥3 缓动 / ≤2 同向量 / 时长谱 ≥3×） | kit 手法自带差异化参数；lint 降级为 warn 启发式 |
| 有界摄影机 ±2% | CardStage camera（tokens 限幅，越界写不出来） |
| 装饰层氛围 / 禁背景大字水印 | CardStage ambient（按 tokens 渲染）+ lint 大字检测 |
| 落地强调 | storyboard.focus + kit emphasis 函数 |
| 数字配重 / tabular-nums | kit CountUp / StatHero 内置 |
| spring ≤16 帧收敛 / 内容层禁循环 | kit spring 预设 + lint（内容层 Math.sin 检测） |
| 信息密度上限 / 单一焦点 | storyboard-lint（beats/adds 数量） |
| 退场窗 / 尾帧 Resolve / 禁黑场 | CardStage 内置 |
| 反禁忌 8 条 | 全部由上述覆盖，**从提示词删除** |

### ④ 审查员：从"读代码对清单"改成"看画面对分镜"

利用已有的冒烟渲染管线，在每个 beat 落点 + 尾帧各渲染 1 帧 PNG（一张卡 3-7 帧），交给多模态审查员，只问 5 个设计问题：

1. 每帧是否兑现 storyboard 对应拍的 adds/changes？
2. 焦点是否一眼可辨（视觉层级）？
3. 底部字幕区是否干净？
4. 连续两帧之间是"状态演进"还是"换页"？
5. 风格是否符合 preset（配色/字体气质）？

输出仍是严格 JSON 裁决，回喂循环沿用现有 MAX_REVIEW_ITER=2。
**降级路径**：若 pi provider 当前模型不支持图片输入（需实测确认），审查员退回"storyboard vs 代码"的意图核对（5 条设计项），机械项已由 lint 承担——即便降级，也比现在 12 条机器可查清单有价值。

## 五、motion-kit API 草案

```tsx
// '@lingji/motion-kit' —— esbuild alias 注入；旧卡不 import 也能编译（向后兼容）
// 舞台：安全区 padding、镜头慢漂、装饰氛围层、退场窗、Resolve 全内置
<CardStage preset={tokens} cues={cues}>...</CardStage>

// 时间：语义锚定 + 提前量 + clamp + 空 cues 兜底，一处实现
const r = reveal(frame, cues, beatCue, { lead: 10, dur: 14 });  // 0→1 progress

// 手法（参数已调好，即 v18 词汇表的代码化）
fadeUp(r); slideIn(r, 'left'); drawOn(r); slam(frame, at, fps);
trackIn(r); cascade(r, i, n);  // 每个返回 style 片段

// 内容原语（自带 tabular-nums、等比配重、draw-on、层级排版）
<StatHero value={28842} unit="人" r={r} />
<Bar items={[...]} r={r} />         <TrendLine points={[...]} r={r} />
<CompareRow left right r={r} />     <ListBuild items r={r} />
<ProcessFlow steps r={r} />         <Quote text source r={r} />

// 焦点强调（storyboard.focus.emphasis 四选一）
emphasize(frame, landAt, 'countup-settle' | 'slam' | 'underline-sweep' | 'brighten')
```

原则：**kit 是省力路径，不是牢笼**——模型仍可写任意 JSX/interpolate 做 kit 没有的表达，lint 只拦确定性/安全区/禁 API 等硬底线。这样避免"抽象错了反而限制表达"的风险。

## 六、新提示词全文骨架

### cards.animation v5（导演 · 约 45 行，现 55 行 → 密度换质量）

```yaml
name: cards.animation
version: 5
user: |-
  你是知识类解说视频的动效导演。为这段口播设计一张 Motion Card 的分镜，只输出一个 JSON。

  设计方法（按序思考）：
  1. 提炼论点：这段口播到底在证明什么？写成一句 claim。
  2. 选载体：从 7 种原型选最能"证明"论点的一种（data-hero/comparison/trend/
     list-build/process/quote/concept）。画面只用文字、数字、表格、图表、列表、
     色块、线条——不画实物、人物、场景。
  3. 编分镜：拆成 1~6 个大拍，每拍锚到"讲出该内容的那一句"（cue 索引，单调不减）。
     一卡是一个连续场景的状态演进：每拍写清"新出现什么"与"已有元素如何变化
     （保持/转化/让位/弱化）"，不是每拍飞入一个新东西。细节处可加 accent 小重音。
  4. 标焦点：唯一语义焦点在哪一拍、用哪种落地强调。

  输入：（沿用现有上下文注入：段落、摘录、逐句节拍、风格补充）
  输出 JSON Schema：（第四节的 Schema 原文）
  硬约束：cue 单调不减且合法；数字与专名必须在逐字稿原样出现；beats ≤6。
```

### cards.segment v19（雕刻 · 约 60 行，现 150 行）

```yaml
name: cards.segment
version: 19
user: |-
  把分镜实现为一个 Remotion 组件，用 write 写入 ./motionCard.tsx。

  技术契约（机器逐条校验，违反直接打回）：
  - 单文件，export default function Card({ cues = [] })，根节点 <CardStage>（或 AbsoluteFill）；cues 可能为空。
  - 一切动画是 useCurrentFrame() 的纯函数；禁 Math.random/Date/fetch/timer。
  - 只从 '@lingji/motion-kit'、'remotion'、'react' 导入。

  motion-kit API：（生成的 ~40 行 API 摘要，单一事实来源=kit 的 .d.ts）

  实现要领（唯一需要你判断的部分）：
  - 每拍揭示帧一律用 reveal(frame, cues, beat.cue)——提前量/兜底/clamp 它已处理。
  - 分镜的 motion 意图 → 选 kit 手法或自写 interpolate；同卡别全用同一种。
  - beats 的 changes/让位按分镜执行；已出现的元素保持终态，不消失不循环。
  - 字大字少、大量留白；正文 ≥ H*0.026；焦点在安全区内垂直居中。
  - 颜色/字体/氛围/镜头全部来自注入的 preset tokens（<CardStage preset>），不自配色。

  分镜：{{storyboard}}
  逐字稿（数字与文案唯一来源）：{{segmentTranscript}}
  风格 tokens：{{presetTokens}}
```

### 角色文件（各 ~10 行）

- **card-director.md**：身份 + "严格按任务书 Schema 输出 JSON" + 精雕模式说明（诊断现有 storyboard/组件的设计问题再修正）。铁律全部删除（由 storyboard-lint 承担）。
- **card-sculptor.md**：身份 + file-first 工作方式 + "收到 lint/审查意见逐条修，不整文件重写"。铁律全部删除（由 tsx-lint 承担）。
- **card-reviewer.md**：身份 + 5 个设计问题 + JSON 裁决格式。12 条机械清单删除。

## 七、风格预设瘦身：散文 → tokens

`VisualStylePreset.facets.motion`（每个 ~65 行散文，约 1.5k tokens）改为结构化 `motionTokens`：

```jsonc
{
  "palette": { "bg": "#0A0A12", "ink": "#E6E8F0", "muted": "#7A7F99", "accent": "#7C5CFF" },
  "fonts": { "display": "...", "body": "...", "mono": "..." },
  "typeScale": { "hero": [0.13, 0.18], "body": [0.04, 0.052], "label": [0.022, 0.028] },
  "surface": { "kind": "glass", "radius": 16 },          // 玻璃卡/无面/色块 等
  "ambient": { "kind": "orbs", "opacity": [0.15, 0.25] }, // CardStage 渲染，模型不写氛围代码
  "camera": { "mode": "push", "range": [0.98, 1.02] },
  "motionPersona": { "prefer": ["drawOn", "countUp"], "easing": "crisp", "emphasis": "brighten" }
}
```

kit 消费 tokens 渲染氛围与镜头；每预设从 ~1.5k tokens 降到 ~200，且"预设改写 trunk 规则"这类散文冲突（如玻璃卡 vs 禁 background）不复存在——surface.kind 就是合法开关。cover facet（文生图）不动。

## 八、迁移路径与验收

| 阶段 | 内容 | 预估 |
|---|---|---|
| 1 | motion-kit（CardStage/reveal/手法/原语）+ esbuild alias + tsx-lint | 2-3 天 |
| 2 | storyboard JSON Schema + storyboard-lint + cards.animation v5 + cards.segment v19 + 三角色瘦身 + 编排器契约对接 | 1-2 天 |
| 3 | 9 预设 motion facet → motionTokens（cover 不动） | 1 天 |
| 4 | 关键帧截图 + 多模态视觉审查（先实测 pi 图片输入；不支持则走降级路径） | 1-2 天 |
| 5 | **A/B 实机验收**：同一期节目 10 段，旧 v18 vs 新链路各出一遍，人工只看三件事——跟不跟口播、像不像 PPT、风格保不保真 | 0.5 天 |

阶段 1 可独立上线（现有提示词直接受益于 lint 提前拦截）；阶段 2 起才切换提示词。PromptKind 名称不变（沿用 cards.segment / cards.animation 的用户覆盖机制），版本号 bump。

风险与对策：
- kit 抽象不足限制表达 → kit 定位为省力路径，模型保留写任意 JSX 的自由，lint 只拦硬底线；
- lint 误杀 → error/warn 分级，warn 不回喂只记录；
- 多模态审查不可用 → 降级为意图核对，管线不阻塞。

## 九、预期收益

- 每卡指令 tokens：~6-8k → ~2.5k（kit API + 短契约 + JSON 分镜）。
- 提示词维护面：5 处重复 → 1 处（kit 的 .d.ts 是手法唯一事实来源）。
- 机械合规：从"指望模型自觉 + 审查员抽查"→ 构造保证 + 确定性 lint。
- 质量方差：工艺参数固化在 kit，模型只做设计判断——这正是 LLM 擅长与不擅长的正确分工。
- "PPT 感"根治点：storyboard 的 changes 字段强制"状态演进"思维 + 视觉审查按帧核对，而不是靠"≥3 种缓动"这类代理指标。
