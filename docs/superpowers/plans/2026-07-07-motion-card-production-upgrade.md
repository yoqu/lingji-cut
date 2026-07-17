# Motion Card 专业制作升级长期路线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 若拆分并行开发，优先在当前会话内按阶段派发；只有涉及独立长期分支或大面积 UI/渲染并行时再使用 worktree。

**Goal:** 把现有 Motion Card 生成体系从“单卡 AI 生成 + 机械校验”升级为“可审片、可精修、跨卡统一、节奏可控、表达载体丰富”的专业知识视频 MG 制作流水线。

**Architecture:** 保留已落地的导演分镜 JSON → 雕刻实现 → 机械质检 → 审查回炉主链路；向外扩展三层能力：制作质检层（关键帧 contact sheet + 视觉审片 + 质检面板）、整片导演层（Motion Bible + 跨卡节奏/风格一致性）、高级制作层（Storyboard 可视化编辑、专业 carrier 库、音画联动 timing plan）。

**Tech Stack:** Electron / React 19 / Remotion 4 / Zustand / TypeScript / Vitest / Playwright layout probe / existing pi headless agent runtime.

**Related Context:**
- `MOTION-CARD-REDESIGN.md` — 2026-07-03 已实施的 motion card 生成体系重构。
- `docs/superpowers/plans/2026-06-24-content-adaptive-animation-direction.md` — cards.animation 演进背景。
- `docs/superpowers/plans/2026-07-04-agent-feed-inspector.md` — 多 agent 观测面板与阶段管线。
- `electron/pipeline/motion-agent-run.ts` — 当前导演/雕刻/质检/审查编排器。
- `src/lib/motion-storyboard.ts` — 当前 storyboard schema 与机器校验。
- `src/remotion/motion-kit/index.tsx` — 当前 motion 原语与 timing 基础。
- `electron/remotion/smoke-render.ts` — 当前编译、冒烟渲染、布局探针。

---

## 当前基线

现有系统已经具备专业化基础：

- `cards.animation` 导演产出结构化 storyboard，包含 claim / carrier / beats / focus。
- `cards.segment` 雕刻师组合 `@lingji/motion-kit` 生成 Remotion TSX。
- `motion-card-lint` + `assertCardRenders` 提供禁 API、import、clamp、字幕安全区、裁切、对比度等机械质检。
- `useBeats(cues, anchors)` 让卡片揭示跟随字幕句起点。
- `motion-agent-run` 已有修复、回炉、兜底出卡循环。

主要缺口：

1. 审片还以 storyboard + TSX 为主，缺少“看画面”的多帧审查。
2. warning 与 fallback 结果没有形成用户可见的制作质检状态。
3. 每张卡独立生成，缺少整片级节奏、风格、载体分布和转场策略。
4. 用户精修入口偏代码/重生成，缺少可视化 storyboard 编辑。
5. carrier 库仍偏基础七类，复杂知识表达容易退化成列表/大数字。
6. timing 已从字幕句起点升级为 SRT pause/accent + 可选 TTS/audio/BGM metadata + 卡间 transition plan。

---

## Roadmap

建议按 6 个阶段推进。前两阶段是质量地基；第 3、4 阶段建立导演台；第 5、6 阶段扩展表达与节奏。

| 阶段 | 名称 | 价值 | 主要风险 |
|---|---|---|---|
| Phase 1 | 制作质检可视化 | 让问题可见、可追踪、可人工判断 | 截图/探针成本与缓存策略 |
| Phase 2 | 视觉审片闭环 | 从看代码审查升级为看画面审查 | pi 多模态能力不稳定，需要降级路径 |
| Phase 3 | 整片 Motion Bible | 同一期视频风格、强弱、载体统一 | 全片策略可能过度约束单卡表达 |
| Phase 4 | Storyboard 可视化编辑器 | 用户能改分镜而非反复重抽 | UI 状态与卡片/时间线同步复杂 |
| Phase 5 | 专业信息载体库 | 提升知识表达上限，减少列表化 | kit 原语、fallback、reviewer 同步扩展 |
| Phase 6 | 音画联动与剪辑节奏 | 从字幕对齐升级到专业落点 | 音频分析与渲染 timing 合约需稳定 |

---

## Phase 1: 制作质检可视化

**Goal:** 每张 motion 卡生成后都能看到关键帧、质检结果、风险等级与是否兜底出卡。

**Architecture:** 在现有 `assertCardRenders` / `validateMotionCardTsx` 基础上新增 `MotionCardProductionReport`。报告聚合 storyboard、framesChecked、layout issues、lint issues、review verdict、fallbackUsed、agent rounds。渲染端通过现有 agent feed / card inspector 展示。

**Progress (2026-07-07):**
- 已新增 `MotionCardProductionReport` / `MotionCardQualityStatus`，并通过 `src/lib/motion-production-report.ts` 聚合状态。
- 已让 `motion-agent-run` 返回 production report，并透传到最终 `motionCard.productionReport`。
- 已新增 `src/lib/motion-keyframes.ts`，可根据 storyboard / cues 选择首帧、beat 落点、尾帧索引。
- 已在 `electron/remotion/smoke-render.ts` 暴露 `renderMotionCardContactSheet`，按关键帧生成 PNG contact sheet，并以 card/tsx/storyboard hash 做缓存。
- 已在 Electron / headless 分析链路中传入 `motion-contact-sheets` 缓存目录，report 会记录 contact sheet 路径、缓存命中和失败原因。
- 已在 `AICardInspector` 的 Motion 状态区展示 report 状态、轮次、关键帧数量和 issue 摘要。

### 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/types/motion.ts` | 修改 | 新增 `MotionCardProductionReport` / `MotionCardQualityStatus` |
| `electron/remotion/smoke-render.ts` | 修改 | 暴露关键帧截图/markup/issue 汇总能力 |
| `electron/pipeline/motion-agent-run.ts` | 修改 | 编排器填充 report，标记 fallback / review / fix rounds |
| `src/store/ai.ts` | 修改 | 保存 report 到 `AICard.motionCard` 或旁路 metadata |
| `src/components/AICardInspector.tsx` | 修改 | 展示质检摘要、fallback 标记、warning 列表 |
| `tests/motion-production-report.test.ts` | 新建 | report 聚合纯逻辑测试 |
| `tests/motion-agent-run.test.ts` | 修改 | 验证 fallback/review/validation 状态写入 report |

### Tasks

- [x] **Task 1.1: 定义生产质检数据模型**
  - `MotionCardQualityStatus = 'pass' | 'acceptable' | 'risk' | 'fallback' | 'failed'`
  - report 字段至少包含：`status`、`framesChecked`、`lintIssues`、`layoutIssues`、`reviewIssues`、`fallbackUsed`、`fixRounds`、`reviewRounds`、`generatedAt`。
  - 验证：纯单测覆盖 issue → status 的映射。

- [x] **Task 1.2: 关键帧 contact sheet 数据管线**
  - 先实现轻量版本：保存关键帧 frame index 与静态 markup/布局摘要。
  - 再扩展 PNG/contact sheet 落盘，避免第一步引入过大渲染成本。
  - 验证：给定 storyboard beats，能推导首帧、每拍落点、尾帧。

- [x] **Task 1.3: Inspector 质检面板**
  - 显示“通过 / 可接受 / 有风险 / 保底稿 / 失败”。
  - warning 不阻断，但必须可见。
  - fallback 卡显示“保底稿，可重新精雕”。
  - 验证：React SSR/render 测试覆盖不同状态文案。

### Acceptance

- 每张生成成功的 motion 卡都有可查询 report。
- fallback 与 warning 不再静默。
- 不改变现有生成成功/失败语义；只是增加可见性和可追溯性。

---

## Phase 2: 视觉审片闭环

**Goal:** 审查员基于画面关键帧判断设计兑现度，而不是只读 TSX。

**Architecture:** 在机械校验通过后，为 storyboard 的每个 beat 落点生成关键帧截图或 contact sheet；reviewer 输入改为 storyboard + contact sheet + 机械结论 + TSX 摘要。若当前 pi 模型不支持图片输入，则明确降级为“视觉审片不可用”，但不伪装为审查通过。

**Progress (2026-07-07):**
- 已将关键帧选择策略与 contact sheet 缓存接入审查前置流程，reviewer prompt 会收到 frame index、contact sheet 路径/缓存状态和机械校验结论。
- 已升级 reviewer issue schema，支持 `frame` / `beat` / `visualProblem`，并更新 `card-reviewer` 角色说明。
- 已将审查 JSON 解析失败从“静默通过”改为 `review-unavailable` warning，report 状态降级为 `acceptable`，不触发无意义回炉。
- 当前 pi headless reviewer 仍没有可靠图片多模态输入，因此 `visualReviewAvailable=false` 会明确记录降级原因；真正“看图裁决”留待后续接入支持图片的 reviewer transport。

### 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `electron/remotion/smoke-render.ts` | 修改 | 提供 `renderMotionCardKeyframes` 或 contact sheet helper |
| `electron/pipeline/motion-agent-run.ts` | 修改 | 审查阶段输入 contact sheet，审查失败回喂具体帧/拍 |
| `resources/pi-agents/agents/card-reviewer.md` | 修改 | 审片规则从代码核对升级为画面核对 |
| `src/lib/motion-storyboard.ts` | 修改 | 暴露 beat landing frame 推导 helper |
| `tests/motion-keyframes.test.ts` | 新建 | 关键帧选择与降级路径测试 |
| `tests/motion-agent-run.test.ts` | 修改 | 审片失败回炉与不可用状态测试 |

### Tasks

- [x] **Task 2.1: 关键帧选择策略**
  - 帧集合：`0`、每个 beat 的 `land`、尾帧、跨卡 overlap frame（若有）。
  - 帧数量上限：默认 8，超出时保留 focus beat 与尾帧。
  - 验证：不同 beat 数、无 cues、短卡片均可返回合法帧。

- [x] **Task 2.2: Contact sheet 生成与缓存**
  - 以 cardId + tsx hash + storyboard hash 为 key。
  - 生成失败不影响机械通过，但 report 标记 `visualReviewAvailable=false`。
  - 验证：重复请求命中缓存；tsx 改变后缓存失效。

- [x] **Task 2.3: Reviewer 输入与裁决升级**
  - 输出仍保持严格 JSON：`pass`、`issues[]`。
  - issue 增加 `frame` / `beat` / `visualProblem` 字段。
  - JSON 解析失败不再默认 pass，改为 `reviewUnavailable` 或重试一次。
  - 验证：解析失败、审查不通过、仅 warn 三种路径。

### Acceptance

- 审查问题能定位到“第几拍/第几帧”。
- 视觉审片不可用时 UI 与 report 明确降级，不冒充通过。
- 审查失败仍能走现有回炉循环，且回炉后重新机械校验。

---

## Phase 3: 整片 Motion Bible

**Goal:** 在单卡生成前建立整片视觉导演策略，控制风格、节奏、载体分布和卡间转场。

**Architecture:** planning 完成后新增 `motion.bible` 生成步骤。输入为全片 summary、segments、keywords、style preset、用户 globalPrompt；输出 `MotionBible` JSON。每张 motion 卡的 director/sculptor prompt 注入 bible 摘要；生成后做跨卡一致性检查。

**Progress (2026-07-07):**
- 已新增 `MotionBible` / `MotionSegmentDirective` 类型，并将 `motionBible?: MotionBible` 保存到 `AIAnalysisResult`。
- 已注册 `motion.bible` PromptKind 与默认模板，planning 后生成整片 Motion Bible；模型失败或 schema 异常时回退 deterministic bible，不阻断出卡。
- 已将 segment-level directive 注入 director、sculptor 与 reviewer prompt；单卡重生、手动选段、headless pipeline 均会透传现有 `motionBible`。
- 已新增 `src/lib/motion-bible.ts`，覆盖 parse / normalize / validate / fallback / 跨卡一致性 warning；已通过 `tests/motion-bible.test.ts` 与 `tests/ai-analysis.test.ts`。

### 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/types/motion.ts` | 修改 | 新增 `MotionBible` / `MotionSegmentDirective` |
| `src/lib/prompts/types.ts` | 修改 | 新增 PromptKind `motion.bible` |
| `src/lib/prompts/defaults.ts` | 修改 | 新增 `MOTION_BIBLE` 默认模板 |
| `src/lib/ai-analysis.ts` | 修改 | planning 后生成/注入 bible |
| `src/lib/motion-bible.ts` | 新建 | parse/validate/normalize bible |
| `src/store/ai.ts` | 修改 | 保存 bible 到 analysisResult 或 AI state |
| `tests/motion-bible.test.ts` | 新建 | schema 与一致性检查测试 |

### Schema 草案

```ts
interface MotionBible {
  visualThesis: string;
  rhythm: {
    density: 'quiet' | 'balanced' | 'dense';
    heavySegments: string[];
    quietSegments: string[];
  };
  carrierPlan: Array<{
    segmentId: string;
    preferredCarrier?: string;
    intensity: 1 | 2 | 3;
    reason: string;
  }>;
  styleRules: {
    paletteUse: string;
    typographyUse: string;
    recurringMotif?: string;
  };
  transitionRules: {
    default: 'crossfade' | 'hard-cut' | 'push' | 'wipe';
    matchCutCandidates: Array<{ fromSegmentId: string; toSegmentId: string; motif: string }>;
  };
}
```

### Tasks

- [x] **Task 3.1: `motion.bible` PromptKind 与默认模板**
  - 只输出 JSON。
  - 约束 carrier 分布，避免连续同型。
  - 验证：内置模板注册、变量完整。

- [x] **Task 3.2: Bible 校验与降级**
  - segmentId 必须来自 planning。
  - intensity 合法；heavy/quiet 不重叠。
  - 失败时回退为 deterministic bible，不阻断出卡。
  - 验证：非法 segmentId、重复 carrier、缺字段。

- [x] **Task 3.3: 注入单卡生成链路**
  - director prompt 得到当前 segment directive 与全片 style/rhythm 摘要。
  - reviewer 增加“是否违背 Motion Bible”的检查。
  - 验证：`buildDirectorPrompt` / `buildCardPrompt` 包含 bible 摘要。

- [x] **Task 3.4: 跨卡一致性检查**
  - 检查连续 3+ 张同 carrier、连续多张 high intensity、style token 漂移。
  - 只产 warning，不阻断首版生成。
  - 验证：纯函数输入 cards + bible 输出 warnings。

### Acceptance

- 同一期视频存在一个可读、可保存、可重用的 Motion Bible。
- 单卡生成能遵循 segment-level directive。
- 系统能识别审美疲劳和风格漂移。

---

## Phase 4: Storyboard 可视化编辑器

**Goal:** 用户不用编辑 TSX，也能修改 claim、carrier、beats、cue、focus，然后按当前分镜重雕。

**Architecture:** 将 `AICard.animationDirection` 从纯 JSON 文本升级为可结构化编辑的 storyboard 数据视图。UI 修改后保存为 JSON；“按当前分镜重雕”只跑 sculptor + 质检 + 审查，不重跑 director；仍保留原 card id 与时间线 overlay。

**Progress (2026-07-07):**
- 已新增 `motionCard.storyboard` 与 `storyboardHistory`，生成 / 重雕时会保存结构化分镜，并记录上一版 storyboard + TSX + hash。
- 已新增 `StoryboardEditor`，嵌入 Inspector，可编辑 claim / carrier / focus / emphasis / scene / beat cue / adds，并即时显示 `validateStoryboard` 错误。
- 已让合法 `animationDirectionDraft` 跳过 director，直接进入 sculptor + 质检 + reviewer；Inspector “精雕动画”会使用当前未保存 draft。
- 已支持 Inspector 一键回退上一版 storyboard/tsx。
- 已接入轻量 `CuePicker`：Inspector 从当前卡片时间窗内字幕句生成本地 cue 选项，beat cue 可下拉选择；同时 beat role 可在 UI 中编辑。

### 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/components/motion-storyboard/StoryboardEditor.tsx` | 新建 | 分镜编辑主组件 |
| `src/components/motion-storyboard/BeatList.tsx` | 新建 | beat 增删改与排序 |
| `src/components/motion-storyboard/CuePicker.tsx` | 新建 | 从字幕句选择 cue |
| `src/components/AICardInspector.tsx` | 修改 | 嵌入 storyboard editor 与重雕按钮 |
| `src/store/ai.ts` | 修改 | 新增 `resculptCardFromStoryboard(cardId)` |
| `src/lib/motion-storyboard.ts` | 修改 | 增加 edit-friendly normalize 与 validation messages |
| `tests/motion-storyboard-editor.test.tsx` | 新建 | UI 行为测试 |
| `tests/store-ai-motion-resculpt.test.ts` | 新建 | 只跑 sculptor 路径测试 |

### Tasks

- [x] **Task 4.1: Storyboard 数据持久化梳理**
  - 明确 `animationDirection` 存 JSON string，还是新增 `motionCard.storyboard`。
  - 推荐新增结构化字段，保留 string 兼容旧卡。
  - 验证：旧卡能 parse，新卡保存结构化数据。

- [x] **Task 4.2: Inspector 分镜编辑 UI**
  - 可改：carrier、claim、focus beat、emphasis、beat cue、adds、changes、motion。
  - cue picker 展示本卡时间窗内字幕句。
  - 即时显示 validateStoryboard 的错误。
  - 验证：非法 cue / beats > 6 / 缺 adds 均可见。

- [x] **Task 4.3: 按当前分镜重雕**
  - 跳过 director，复用当前 storyboard 调 sculptor。
  - 保留 id、segmentId、startMs、displayMode、enabled、timeline sourceCardId。
  - 验证：mock provider 断言未创建 director session。

- [x] **Task 4.4: 分镜版本历史**
  - 每次重雕记录 previous storyboard 与 tsx hash。
  - 支持回退到上一个 storyboard/tsx。
  - 验证：回退不破坏时间线 overlay。

### Acceptance

- 用户可以通过 UI 修正错误分镜并重雕。
- 重雕不改变卡片身份与时间线位置。
- 分镜错误在调用 LLM 前被本地拦截。

---

## Phase 5: 专业信息载体库扩展

**Goal:** 扩展知识视频常用图形语言，减少所有内容退化为 `list-build` / `data-hero`。

**Architecture:** 扩展 storyboard carrier 枚举、motion-kit 原语、fallback 编译器、director prompt、reviewer 规则和 layout probe 测试。每新增一个 carrier 必须同时具备：schema、kit component、fallback、prompt 示例、review criterion、测试。

**Progress (2026-07-07):**
- 已扩展 `STORYBOARD_CARRIERS`，新增 timeline / matrix / funnel / network / before-after / stacked-composition，并同步 Motion Bible carrier 选择启发式。
- 已在 `@lingji/motion-kit` 新增 `TimelineRail` / `MatrixQuadrant` / `FunnelStack` / `NetworkMap` / `BeforeAfter` / `StackedComposition`，并同步 import 白名单与 API 摘要。
- 已让 deterministic fallback 针对新 carrier 使用对应原语，而不是全部退化为列表。
- 已更新 director/sculptor/reviewer prompt 与角色说明，增加载体适配审查。
- 已通过 `tests/motion-storyboard.test.ts`、`tests/motion-card-fallback.test.ts`、`tests/motion-kit-card.test.ts`。

### 新增 carrier 优先级

| Carrier | 用途 | Kit 原语 |
|---|---|---|
| `timeline` | 历史阶段、版本演进、政策/事件时间线 | `TimelineRail` |
| `matrix` | 二维象限、决策对比、优先级判断 | `MatrixQuadrant` |
| `funnel` | 筛选、转化、层层收窄 | `FunnelStack` |
| `network` | 人物/组织/概念关系 | `NetworkMap` |
| `before-after` | 改版前后、问题/方案对照 | `BeforeAfter` |
| `stacked-composition` | 构成占比、层级堆叠 | `StackedComposition` |

### 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/lib/motion-storyboard.ts` | 修改 | carrier 枚举与校验 |
| `src/remotion/motion-kit/index.tsx` | 修改 | 新增原语组件 |
| `src/lib/motion-card-fallback.ts` | 修改 | 新 carrier 的保底 TSX |
| `src/lib/prompts/defaults.ts` | 修改 | director/sculptor prompt 更新 |
| `resources/pi-agents/agents/card-reviewer.md` | 修改 | 载体适配审查 |
| `tests/motion-kit-card.test.ts` | 修改 | 新原语 SSR/布局测试 |
| `tests/motion-storyboard.test.ts` | 修改 | carrier 校验测试 |
| `tests/motion-card-fallback.test.ts` | 修改 | fallback 覆盖新增 carrier |

### Tasks

- [x] **Task 5.1: Carrier 扩展框架**
  - 先增加 schema 和 prompt 描述，不立刻要求 director 使用。
  - 每个 carrier 配 `whenToUse` 与 `antiPattern`。
  - 验证：旧 carrier 兼容，新 carrier 可解析。

- [x] **Task 5.2: 第一批原语：timeline / matrix / funnel**
  - 三个最常见，优先落地。
  - 每个原语支持 `beat` 或 `beats`，遵守 CardStage 安全盒。
  - 验证：SSR 不报错，布局探针不侵入字幕区。

- [x] **Task 5.3: 第二批原语：network / before-after / stacked-composition**
  - network 必须限制节点数量，防止拥挤。
  - before-after 必须支持 split/wipe 动作。
  - 验证：节点/文本过多时 fallback 自动裁剪。

- [x] **Task 5.4: Reviewer 载体适配检查**
  - 检查 carrier 是否真的承载论证，而不是只换皮。
  - 错载体返回 error 或 warn。
  - 验证：mock reviewer 或纯规则覆盖明显错配。

### Acceptance

- 新 carrier 不只是 prompt 名字，而是端到端可生成、可校验、可 fallback。
- 常见知识段落能覆盖 timeline / matrix / funnel 等表达。
- 载体过载时系统宁可删减内容，不挤压字幕区。

---

## Phase 6: 音画联动与剪辑节奏

**Goal:** 从“按字幕句开始揭示”升级到“按语音重音、停顿、BGM 与剪辑节奏落点”。

**Architecture:** 新增 `TimingPlan`，在 render plan 或 analysis 阶段从 SRT/audio/TTS metadata 提取 pause、energy、emphasis、beat。motion-kit 提供 `useTimingPlan`，兼容 `useBeats`。storyboard beat 增加 role：anticipation / reveal / emphasis / hold / resolve。

**Progress (2026-07-07):**
- 已新增 `TimingPlan` / `TimingBeatRole` 类型与 `src/lib/motion-timing.ts`，第一版基于 SRT 窗口推导 cues、>400ms 停顿、字幕数字/短句/强调词 accent，以及 storyboard beat role 的 start/land/hold。
- 已让 storyboard beat 支持可选 `role`，旧分镜解析时按首拍 / focus / 末拍自动补 anticipation / emphasis / resolve 等默认角色。
- 已在 `buildRenderPlan` 为 AI 卡注入 `timingPlan`，并通过 `MainComposition -> AICardOverlay -> CardHost` 传给生成组件；冒烟渲染也支持传入 timingPlan。
- 已在 `@lingji/motion-kit` 新增 `useTimingPlan(timingPlan, cues, anchors)`，无 timingPlan 时保持 `useBeats` 旧行为；lint / prompt / sculptor 角色说明已同步。
- 已新增可选 `motionTimingMetadata` 合约；若 TTS/audio/BGM 分析提供 `speech` / `bgm` accent，会合并进 `TimingPlan.accents`，没有 metadata 时仍使用 SRT 兜底。
- 已将 Motion Bible 随 AI card overlay 透传到 Remotion render plan，相邻全屏卡会按 transitionRules 选择 crossfade / hard-cut / push / wipe / match-cut，并与 CardStage 退场窗口对齐。

### 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/types/motion.ts` | 修改 | `TimingPlan` / `TimingBeatRole` |
| `src/lib/motion-timing.ts` | 新建 | 从 SRT/audio metadata 推导 timing plan |
| `src/remotion/motion-kit/index.tsx` | 修改 | `useTimingPlan` / role-based helpers |
| `src/remotion/timeline-to-sequences.ts` | 修改 | 给 ai-card clip 注入 timing plan |
| `src/lib/motion-storyboard.ts` | 修改 | beat role schema 与校验 |
| `src/lib/prompts/defaults.ts` | 修改 | director prompt 增加 role 设计 |
| `tests/motion-timing.test.ts` | 新建 | timing 推导测试 |
| `tests/timeline-to-sequences.test.ts` | 修改 | timing plan 注入测试 |

### TimingPlan 草案

```ts
type TimingBeatRole = 'anticipation' | 'reveal' | 'emphasis' | 'hold' | 'resolve';

interface TimingPlan {
  fps: number;
  cues: number[];
  pauses: Array<{ frame: number; durationFrames: number }>;
  accents: Array<{ frame: number; strength: 1 | 2 | 3; source: 'speech' | 'subtitle' | 'bgm' }>;
  beats: Array<{
    storyboardBeatIndex: number;
    role: TimingBeatRole;
    startFrame: number;
    landFrame: number;
    holdUntil?: number;
  }>;
}
```

### Tasks

- [x] **Task 6.1: SRT-based timing plan**
  - 先不做音频 DSP，仅用字幕间隙、句长、标点推导 pause/accent。
  - 句末停顿 > 400ms 作为 resolve 候选。
  - 验证：长停顿、短句、密集字幕均合理。

- [x] **Task 6.2: `useTimingPlan` 兼容层**
  - 无 timing plan 时回退 `useBeats`。
  - 支持 anticipation 提前、emphasis 落点、holdUntil。
  - 验证：空 plan / 有 plan 输出稳定 progress。

- [x] **Task 6.3: Director role 设计升级**
  - storyboard beat 增加 `role`。
  - focus beat 默认 emphasis。
  - 验证：旧 storyboard 无 role 时 normalize 补默认值。

- [x] **Task 6.4: Audio/TTS metadata 增强**
  - 若 TTS 或音频分析能提供能量/重音，合并到 accents。
  - BGM beat 作为后续增强，不作为第一版硬依赖。
  - 验证：无音频 metadata 不阻断。

- [x] **Task 6.5: 卡间转场 timing**
  - 从 Motion Bible 的 transitionRules 选择 crossfade/hard-cut/push/wipe/match-cut。
  - 与 CardStage 出场窗对齐。
  - 验证：相邻全屏卡不同 transition 下不露底、不黑场。

### Acceptance

- 卡片重点数字/金句能落在重音或停顿附近。
- 每张卡有 anticipation/reveal/hold/resolve 的节奏结构。
- 无音频分析时仍保持当前 cues 行为。

---

## 横向质量门禁

所有阶段都必须遵守：

1. **旧项目兼容**：旧 motionCard.tsx 与旧 `animationDirection` 字符串可继续预览/导出。
2. **出卡稳定性优先**：视觉审片、Motion Bible、TimingPlan 失败时应降级而非让整段空白，除非机械渲染失败。
3. **机械可查不上 prompt**：禁 API、布局、安全区、导入、clamp、schema 合法性继续用代码查。
4. **用户改动保号**：重雕、改分镜、换 carrier 不改变 card id / segmentId / timeline sourceCardId。
5. **成本可控**：contact sheet 与视觉审片必须缓存；一键流程不得因审片把总时长放大到不可接受。
6. **观测完整**：新增阶段必须接入 auto-run telemetry 或 agent feed，至少记录 duration、ok、fallback/unavailable 原因。

---

## 推荐实施顺序

1. Phase 1.1 → 1.3：先让 report 与 UI 可见。
2. Phase 2.1 → 2.3：再让 reviewer 看关键帧。
3. Phase 3.1 → 3.4：引入整片 Motion Bible。
4. Phase 4.1 → 4.3：做分镜可视化编辑与重雕。
5. Phase 5 分两批 carrier 推进，每批都端到端。
6. Phase 6 先 SRT timing，再音频/TTS metadata，再 BGM beat。

---

## 验证策略

- **Unit:** schema normalize/validate、report status mapping、timing plan、carrier fallback。
- **Integration:** `motion-agent-run` 模拟 director/sculptor/reviewer，覆盖视觉审片不可用、fallback、回炉。
- **Render Smoke:** 新 carrier 原语 SSR + `assertCardRenders`。
- **UI SSR:** Inspector 质检面板、Storyboard editor、CuePicker。
- **E2E Optional:** `LINGJI_E2E=1` 真实模型出卡，抽样生成 contact sheet 并检查 report。

关键命令建议：

```bash
npx vitest run tests/motion-storyboard.test.ts tests/motion-card-lint.test.ts tests/motion-agent-run.test.ts
npx vitest run tests/motion-production-report.test.ts tests/motion-bible.test.ts tests/motion-timing.test.ts
LINGJI_E2E=1 npx vitest run tests/e2e-motion-card-real.test.ts
```

---

## 非目标

- 不在本计划内替换 Remotion 渲染栈。
- 不把 AI 生成代码改成远端执行或多租户沙箱。
- 不要求第一阶段就支持多模态 reviewer；必须有文本降级路径。
- 不要求用户必须进入 storyboard 编辑器；自动生成仍是默认主路径。
- 不为每个 carrier 引入复杂第三方图表库，优先保持 motion-kit 原语可控、可审查。

---

## 风险与缓解

| 风险 | 表现 | 缓解 |
|---|---|---|
| Contact sheet 成本高 | 一键流程明显变慢 | 按 hash 缓存；先 metadata 后 PNG；只对失败/精修卡生成高清图 |
| 多模态审片不可用 | reviewer 无法读图或 API 不支持图片 | 明确 `visualReviewAvailable=false`；保留机械质检 + TSX 设计核对 |
| Motion Bible 过度约束 | 单卡表达变保守 | Bible 只给 directive，不做硬阻断；reviewer 只对明显违背出 warning |
| Storyboard UI 复杂 | 编辑状态与 JSON/TSX 不一致 | 结构化字段为主，string 仅兼容；所有保存前走 validateStoryboard |
| Carrier 扩展造成质量回退 | 新原语越界或拥挤 | 每个 carrier 必须同时配 fallback + layout probe 测试 |
| TimingPlan 误判节奏 | 动画提前/迟到 | 保留 `useBeats` fallback；role timing 只在证据足够时启用 |

---

## Completion Definition

长期目标全部完成时，应满足：

- [x] Motion 卡 Inspector 能展示生产质检报告、关键帧/缩略图、fallback 状态和 warning。
- [x] Reviewer 能基于关键帧或明确降级路径输出可追踪审片结论。
- [x] 一键分析能生成并保存 Motion Bible，单卡生成能消费它。
- [x] 用户能在 UI 编辑 storyboard 并按当前分镜重雕。
- [x] 新增至少 6 个专业 carrier，且每个 carrier 具备 kit 原语、fallback、校验与测试。
- [x] TimingPlan 支持至少 SRT pause/accent，motion-kit 能基于 role 控制 anticipation/reveal/hold/resolve。
- [x] 全部新增能力有单测或集成测试覆盖；关键渲染路径通过 smoke render。
