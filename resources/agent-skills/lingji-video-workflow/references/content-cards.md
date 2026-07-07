# 内容卡片参考

仅当任务明确涉及 AI 内容卡片时读取本文件：例如总结卡片生成链路、生成或重生成卡片、检查卡片产物、修复卡片与时间轴集成，或产出具体的卡片 brief。

## 卡片生成链路

`subtitle analyze` 是内容卡片的核心步骤。应用会读取 `podcast-subtitles.srt`，并写入 `project.json.aiAnalysis`。

内部顺序：

1. `planning.segment`：把字幕全文拆成语义 `segments`，再根据真实字幕时间重锚定，并拆分过长段落。
2. `analyze.cover-prompt`：与卡片生成并行生成封面提示词。
3. `cards.segment`：为每个 motion 段生成一份 Motion Card TSX 源码。
4. `cards.animation`：可选，为 motion 卡片设计 JSON 分镜（storyboard：论点/载体/逐拍状态演进/焦点）。
5. `card.image`：对 image 段生成图片 prompt，并通过图片 provider 物化资产。
6. 持久化最终 `AIAnalysisResult`，编辑器再把启用的卡片排布到时间轴。

## 输出契约

分析结果包含：

- `segments`：语义段落范围，包含 `id`、`title`、`summary`、`startMs`、`endMs`，可选 `visualType`。
- `cards`：最终 `AICard[]`。
- `coverPrompts`：一个或多个封面提示词。
- `summary` 和 `keywords`。
- 可选 `cardErrors`：记录失败段落。

每张卡片通过以下位置完成集成：

- `project.json.aiAnalysis.analysisResult.cards[]`
- `project.json.timeline.overlays[]` 中 `overlayType === "ai-card"` 的 overlay
- Motion Card 对应 `ai-cards/<overlayId>/motionCard.tsx`（按 timeline overlay 的 `id` 命名，**不是** `cardId`）
- image 卡片对应 `ai-cards/<cardId>/image.png` 或等价的 `content.assetPath`

## 卡片类型

- `motion`：Remotion TSX 卡片，`renderMode: "motion-card"`，源码在 `motionCard.tsx`。
- `image`：生成式静态图片卡片，content 为 `MediaCardContent`。
- `video`：生成式视频媒体卡片，content 为 `MediaCardContent`。

对“手选字幕生成单卡”的场景，使用 single-card 路径。它会根据选中的字幕范围创建合成 segment，生成一张 Motion Card，持久化到 `aiAnalysis`，并插入匹配的 timeline overlay。

## CLI 上下文与验证

先列出现有卡片，再导出上下文：

```bash
node "$LINGJI_CLI" cards list --project <projectDir> --json
```

根据 `cardId` 或 `segmentId` 获取约束上下文：

```bash
node "$LINGJI_CLI" cards context --project <projectDir> --card <cardId> --json
```

该命令返回：

- 项目风格预设与解析后的视觉系统
- `cards.segment` / `cards.animation` / `card.image` / `card.video` 的有效提示词
- 当前卡片、段落、timeline overlay
- 可用于单卡生成的字幕摘录与 cues

验证卡片时必须执行：

```bash
node "$LINGJI_CLI" cards validate <cardId> --project <projectDir> --json
```

验证要求：

- Motion Card 必须先通过渲染校验
- 图片 / 视频卡必须确认 `assetPath` 对应文件存在
- 必须检查文本对齐、遮挡、溢出、过长文本无换行、文字裁切和元素越界等问题
- 若返回 warning，优先按 warning 修复；若返回 error，必须修到无 error 才能交付

## 卡片 Brief 模板

```markdown
目标：
输入：
当前项目：
分段来源：
卡片类型：
产物文件：
时间轴插入：
验证：
```

## 编辑规则

- 不要手写生成媒体。使用 CLI 生成链路或 card-media handlers。
- 保持 `aiAnalysis.cards[]`、timeline overlays、卡片源码/资产三者一致。
- 直接编辑 `project.json` 或 `motionCard.tsx` 前，先读取 `video-editing.md`。
- 如果卡片缺少 timeline overlay，根据卡片的 `sourceCardId`、`startMs`、`displayDurationMs` 和 `aiCardData` 重建 overlay。
- 不要把系统内置 AI 当成最终卡片生成器；它只提供约束、提示词与风格上下文。

## 编辑器刷新机制（修改 Motion Card 必读）

修改 Motion Card 内容后，编辑器必须实时呈现最新卡片，无需重开项目。两条修改路径各自的刷新方式：

- **精雕 motion 卡**：`cards sculpt <cardId> [--notes "<要求>"] --wait`（→ `lingji_sculpt_card`）对现有 motion 卡做多 agent 精雕：导演诊断现有 motionCard.tsx 的编排问题 → 雕刻修改 → 渲染验证 → 审查回炉（≤2 轮）。适合"动画像 PPT / 缓动单调 / 节奏不跟口播"这类质量问题；重生成（regenerate）同样走多 agent 引擎，但从头出卡。耗时分钟级，务必 `--wait` 或轮询 task。
- **CLI 卡片命令**（`cards regenerate` / `cards convert` / `cards update`）：工具写回 `aiAnalysis` 后会自动发出 `pipeline:project-updated` 信号，编辑器据此把更新后的卡片重新灌回已放置的 timeline overlay（含 `motionCard.tsx`、时间、展示模式）。**优先使用这些命令改卡**，刷新全自动。
- **file-first 直接改 `ai-cards/<overlayId>/motionCard.tsx`**：编辑器在项目打开期间常驻文件监听，保存即触发对应 overlay 的预览热重载。路径必须用 **overlayId**（见 `video-editing.md`），否则改了不生效。

刷新失败的排查顺序：① 路径是否用了 overlayId 而非 cardId；② 该卡是否已放置到时间轴（未放置的卡只更新列表数据，时间轴无对应 overlay）；③ 改动是否落盘成功（`cards validate` 复核）。
