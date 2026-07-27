# AGENTS.md

给 AI agent（Claude Code、Codex、Gemini 等）的协作指引。CLAUDE.md 是面向项目结构 / 改动规范的指南；本文件只关心**"一键成稿"流水线的耗时观测**。

---

## 当用户反馈"系统卡 / 慢 / 太慢 / 跑了好久 / 等很久"

**绝对优先**：先去读 auto-run jsonl 日志，定位耗时瓶颈，再做任何分析。不要凭感觉猜哪一步慢。

### 日志位置

- macOS：`~/Library/Application Support/灵机剪影/logs/auto-run/`
- Windows：`%APPDATA%\灵机剪影\logs\auto-run\`
- Linux：`~/.config/灵机剪影/logs/auto-run/`
- 应用包名以 `package.json` 的 `productName` 为准

目录结构：

```
logs/auto-run/
  LATEST.txt                       ← 文本，内容是最近一次 runId
  autorun-<ts>-<rand>.jsonl        ← 每次一键流程一份 jsonl
  autorun-<ts>-<rand>.jsonl
  ...
```

### 怎么找"最近一次卡顿的运行"

最快路径：

```bash
LOGDIR="$HOME/Library/Application Support/灵机剪影/logs/auto-run"
LATEST=$(cat "$LOGDIR/LATEST.txt")
cat "$LOGDIR/$LATEST.jsonl"
```

如果用户描述的是"前一两次"，按 mtime 列：

```bash
ls -lt "$LOGDIR"/*.jsonl | head -10
```

### 日志事件结构

每行一条 JSON，公共字段：

```json
{ "runId": "...", "ts": 1717_..., "kind": "...", ...payload }
```

主要 kind：

| kind | 何时发出 | 关键字段 |
|---|---|---|
| `run.start` | 每次一键开跑 | `autoMode`, `startFromStep`, `projectDir` |
| `run.end` | 流程结束（成功 / 失败 / 取消） | `ok`, `failedStage?`, `cancelled?`, `error?` |
| `stage.start` / `stage.end` | 主进程粗粒度阶段（`tts` / `cover` / `analyze.planning` / `analyze.cards` / `highlights`） | `stage`, `durationMs`, `ok` |
| `stage.start` / `stage.end`（导演） | 导演方案规划 | `stage:"director.plan"`, `revision`, `segments`, `ok` |
| `director.approved` | 人工批准导演方案并开始制作 | `taskId`, `directorRevision`, `impact` |
| `checkpoint.auto-approved` | 一键模式自动批准导演方案或 Animatic | `checkpoint`, `taskId`, `directorRevision` |
| `checkpoint.waiting` | 导演模式到达人工检查点 | `checkpoint`, `taskId`, `directorRevision` |
| `production.tracks.start` / `production.tracks.end` | 画面、封面、声音、高亮四轨并行 | `taskId`, `directorRevision`, `impact`, `cardErrors`, `coverError`, `audioOutcome` |
| `production.resume` | 从持久化输出状态恢复制作 | `taskId`, `mode` |
| `planning.done.received` | renderer 收到 `analyze-planning-done` 事件，封面轨道启动 | `coverPrompts`, `segments` |
| `card.start` / `card.end` | 单段卡片生成 | `segmentIndex`, `visualType`, `durationMs`, `ok` |
| `card.compile.start` / `card.compile.end` | motion 卡 template 模式确定性编译（storyboard → TSX，不经 LLM） | `segmentId`, `carrier`, `durationMs`, `ok`, `error?`；分镜声明 assets 时附 `assetRequested` / `assetResolved` / `assetUnresolved`（物化失败 → 编译退回纯文字布局，靠这三个字段观测降级） |
| `card.image.start` / `card.image.end` | image 卡片调图像 provider 物化资产 | `segmentIndex`, `durationMs` |
| `highlight.batch.start` / `highlight.batch.end` | 字幕高亮单 batch | `batchIndex`, `batchTotal`, `durationMs` |
| `llm.start` / `llm.firstChunk` / `llm.end` | 每次结构化 / 文本 LLM 调用 | `label`, `attempt`, `thinking`, `latencyMs`, `durationMs`, `outputChars`, `retry`, `willRetry`, `error` |

`llm.start / llm.end` 是定位瓶颈的核心。常见 label：
- `planning.segment` — 规划分段（最容易卡 10 分钟以上的那一步）
- `cards.segment#i/N(seg-x)` — 每段卡片
- `card.image(seg-x)` — image 卡片的中文 prompt 二次调用
- `cover.regeneration` — 单独重生封面 prompt
- `highlights#i/N` — 单 batch 字幕高亮

### 标准诊断流程

读完 jsonl 后，按以下顺序检查：

1. **总耗时**：`run.start.ts` → `run.end.ts`，让用户看到"实际跑了 N 分 N 秒"
2. **每个 stage 的 durationMs**：把 `stage.end` 全部拎出来，找最大那个
3. **如果 stage 是 `analyze.cards`，深入查**：
   - 哪些 `card.end.durationMs` 超过中位数 2 倍 → 长尾段
   - 哪些 `card.end.ok=false` → 失败段（仍然消耗了完整一次 LLM）
4. **如果 stage 是 `analyze.planning`，深入查 `llm.end{label:"planning.segment"}`**：
   - `durationMs` 多少？
   - `attempt` 是不是 0？有没有 `retry:true`（说明触发了 JSON 解析重试，时间×2）
   - `thinking` 是不是 true？非推理任务用了 thinking 模型直接砍掉
5. **如果 stage 是 `highlights`**：现在默认并发 4，如果还是慢，看 `highlight.batch.end` 是不是大部分 ≥ 30s → batch 内字幕太密或模型太慢
6. **TTS 慢**：MiniMax 服务端问题，本地能做的只有换 model
7. **cover 慢**：基本是 image provider 慢，看 `stage.end{stage:"cover"}` 的 durationMs 与 candidates count

### 导演门禁与四轨并行的预期形态

TTS 之后先单独执行 `director.plan`。导演模式停在 `checkpoint.waiting{checkpoint:"director-review"}`；一键模式记录 `checkpoint.auto-approved`。批准前不得出现卡片 Agent、图像 Provider、封面出图、声音 Provider 或高亮调用。

批准后 `production.tracks.start` 同时启动四路：cards、cover、audio、highlights。全部完成后原子替换时间线；导演模式进入 Animatic 等待，一键模式自动批准 Animatic 并完成。若恢复运行，先出现 `production.resume`，已是 current 且 provenance 匹配的产物不应重复调用。

### 把发现转成行动

不要只罗列数字。读完之后给用户：
- 总耗时（实际 vs 目标）
- 最慢的 1-2 个 stage / call，附实际 ms
- 直接归因（thinking 模型 / 静默 retry / image 卡片占比过高 / provider 慢 / 并发不足）
- 1-3 个可执行建议（换 binding 模型、调整 `cardGenerationConcurrency`、改 `highlights.concurrency`、瘦身 prompt）

---

## 这套观测体系的代码触点（修改时请保持同步）

- `electron/telemetry/auto-run-logger.ts` — 写盘、读盘、列近期 run
- `electron/main.ts` — `auto-run-telemetry/append|list-recent|read-run|get-latest|get-log-dir` IPC；`makeMainTelemetry(runId)` 工厂
- `electron/preload.ts` — `appendAutoRunEvent / listAutoRunLogs / readAutoRunLog / getLatestAutoRunLog / getAutoRunLogDir / onAnalyzePlanningDone`
- `src/lib/telemetry/auto-run.ts` — `createAutoRunTelemetry(runId)` 包装 + `TelemetryHook` 类型，被 lib 层共用
- `src/lib/llm/index.ts` — `generateStructuredData` 接 `telemetry`，emits `llm.start / firstChunk / end`
- `src/lib/ai-analysis.ts` — `analyzeSrt` 接 `telemetry` 与 `onPlanningDone`；emits `stage.start/end{stage:"analyze.planning"|"analyze.cards"}`、`card.start/end`、`card.image.start/end`
- `electron/pipeline/motion-agent-run.ts` — motion 卡编排器；template 模式（默认）emits `card.compile.start/end`（确定性编译，不经 LLM），agent 模式经 `emit()` emits `llm.end{label:"<seg>:director|storyboard|validate|review|fallback"}`；`AISettings.motionCardMode` 切换两条路径；hybrid 模式的分流决议以 `motionPath` / `motionPathReason` 附加字段挂在这两组既有事件上
- `electron/pipeline/motion-hybrid.ts` — hybrid 分段筛选纯函数（阈值 / 每期上限截断 / 单卡兜底）+ `buildHybridSelectionFromPlan`（从导演方案构建预选表）。批量预选注入 `ctx.hybridDecision` 的三处入口（均须保留 `motionCardMode:'hybrid'` 让遥测带 `motionPathReason`）：headless `electron/pipeline/runs/analyze-run.ts`、renderer 一键的 `analyze-srt` IPC（projectDir 分支）与逐段生成的 `generate-ai-card-for-segment` IPC（后两者在 `electron/ai-generation-ipc.ts`，从 project.json 的 approvedPlan 构建）
- `src/lib/subtitle-highlight-runner.ts` — `concurrency`、`telemetry`；emits `stage.*` + `highlight.batch.*`
- `src/hooks/useAIVideoWorkflow.ts` — 写稿 / TTS 后进入导演编排器，维护两个检查点与恢复入口
- `src/lib/director-production-client.ts` — 批准后四轨并行与 revision/task 隔离
- `src/lib/director-production-persistence.ts` — 产物状态、原子时间线替换和 Animatic 检查点

新增耗时操作时也按这个套路接入，不要再发明独立日志。

---

## 性能调优默认值（2026-05-25 改）

- `cardGenerationConcurrency`：默认 2，目标值 4-6（在 `src/store/ai.ts` / `src/types/ai.ts`）
- `motionCardMode`：默认 `'template'`（storyboard → `src/lib/motion-card-templates.ts` 确定性编译，单卡仅 1 次导演 LLM 调用）；`'agent'` 为旧 LLM 雕刻+审查链路（精雕强制 agent）；`'hybrid'` 为混合：重点段（visualizationScore ≥ 75、semanticType 为 data/quote、bible intensity=3，任一命中）走 agent 精雕，其余走 template，每期 agent 段 ≤ ceil(总段数/3) 且 ≤ 6、按分数截断，超出回落 template（判定在 `electron/pipeline/motion-hybrid.ts`）。分镜可选 `data` 字段由 `validateStoryboardData` 机器校验（`src/lib/motion-storyboard.ts`）
- `subtitle-highlight-runner.concurrency`：默认 3，workflow 内传入 4
- `STRUCTURED_IDLE_TIMEOUT_MS` / `STRUCTURED_THINKING_IDLE_TIMEOUT_MS` / `STRUCTURED_HARD_TIMEOUT_MS` 在 `src/lib/llm/index.ts`
- `STRUCTURED_MAX_RETRIES = 1`（首次 JSON 解析失败会再跑一次完整请求；从日志 `llm.end{retry:true}` 可观察到）

---

## 不要做的事

- 不要为新耗时操作另起一套日志文件；直接调 `tel.event(kind, extra)` 或 `tel.stage(name, fn)`
- 不要在 lib 层直接调用 electron IPC；用 `TelemetryHook` 接口，main 显式注入
- 不要把任何 API Key / 项目敏感内容放进 telemetry payload；只记 label / durationMs / 字符数 / 段数等度量
- 用户说"系统慢"时，不要直接给猜测和建议；先读 jsonl，再讨论

---

## 版本发布与 CHANGELOG 维护（铁律）

每次 bump `package.json` 版本号、打 tag、发 GitHub Release 时，**必须同步更新 `CHANGELOG.md`**。不允许只 bump 版本不写 changelog，也不允许"明天补一下"——一次发布一次落盘。

### 强制流程

发布新版本 = **三件事一起做**，缺一不可：

1. **更新 `CHANGELOG.md`**：在文件顶部新增 `## [x.y.z] - YYYY-MM-DD` 段落，按 Keep a Changelog 分类（Added / Changed / Fixed / Removed / Deprecated / Security）。底部更新 `[x.y.z]: https://github.com/yoqu/lingji-cut/compare/<prev>...<this>` 比较链接。
2. **bump `package.json` + `package-lock.json`**：跑 `npm install --package-lock-only` 让 lockfile 同步。
3. **打 tag 并推到 origin**：`git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push origin vX.Y.Z`，触发 `.github/workflows/release.yml` 多平台构建。

### Release Notes 同步

GitHub Release 的 body **必须**来自 `CHANGELOG.md` 对应版本段落（中文 + emoji 头），让用户在 Release 页直接看到改了啥。两种姿势：

- **预创建**：tag 推送后立即 `gh release edit vX.Y.Z --notes-file <提取后的段落>`，让 workflow 把二进制附加上去。
- **后修正**：workflow 完成后用 `gh release edit vX.Y.Z --notes-file` 覆盖 body。

### 怎么写 CHANGELOG 条目

- 一句话写清楚**用户视角的变化**（"封面提示词改版"），而不是技术细节（"重构 prompts/defaults.ts"）。
- 内部重构 / 测试 / 打包细节归到 `Changed` 末尾或 `Build / Packaging`，不要单列在 Added。
- 涉及破坏性变更（IPC 改名、`project.json` schema 变更、Composition ID 变化）必须在条目里**显式标注 BREAKING**。
- 引用具体文件路径时用反引号包裹（`src/lib/...`），让阅读者能直接跳代码。

### Semver 边界

- **patch (x.y.Z)**：bug 修复、文档、依赖小升、不影响外部行为的重构。
- **minor (x.Y.0)**：新功能、新 IPC、新 Provider、新 prompt kind，向后兼容。
- **major (X.0.0)**：破坏性变更——`project.json` schema 不兼容、IPC 删除 / 改名、Composition 入口变化、要求用户手动迁移的任何场景。

拿不准时跑 `git log v<上一版>..HEAD --first-parent --pretty=format:"%h %s"` 看变化量级，再做判断。

### Agent 自检清单

被要求"发版" / "release 一个新版本" / "更新版本号" 时，按这个顺序：

1. `git status` 确认工作区干净
2. `git log v<latest-tag>..HEAD --first-parent` 拉变更列表，按 Keep a Changelog 分类
3. 在 `CHANGELOG.md` 顶部新增版本段落（含日期、分类、compare 链接）
4. 改 `package.json` 版本号，跑 `npm install --package-lock-only` 同步 lockfile
5. 一个 commit 提交（消息：`chore(release): bump version to X.Y.Z`），或 changelog + bump 分两个 commit 都可
6. push main → 打 tag → push tag → 等 workflow → `gh release edit` 写入 Release notes

漏掉任何一步都算不完整发布。
