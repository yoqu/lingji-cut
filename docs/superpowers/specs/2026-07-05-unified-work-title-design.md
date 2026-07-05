# 作品标题统一体系设计（方案 A）

日期：2026-07-05
状态：已确认方案 A，待实现

## 目标

把作品标题从「发布 tab 的附属字段」升格为「作品级属性」：

1. `project.json` 顶层新增 `meta.title` 作为标题唯一真源。
2. 复用现有 `publish.metadata` 提示词与 `generatePublishMetadata` 生成链路，不新建提示词 kind。
3. 一键流水线新增标题生成步骤（analyze 之后、covers 之前）。
4. 封面提示词 `cover.regeneration` 新增 `{{title}}` 变量。

非目标：不新增独立「作品信息」UI 面板；desc/tags 仍留在 publish 段；项目文件夹名保持独立，不与标题联动。

## 1. 数据模型

`src/lib/project-persistence.ts`：

```ts
export interface ProjectMetaSection {
  title: string
}
```

- `ProjectData` 增加 `meta?: ProjectMetaSection`；新增 `DEFAULT_PROJECT_META`、`extractMetaSection`、`resolveWorkTitle(data)`（meta.title → publish.title 回退）。
- `saveProjectSection` 对 `ProjectSection` 泛型透传，`'meta'` 加入联合类型后主进程无需额外白名单改动。
- 迁移：读取时若 `meta.title` 为空且 `publish.title` 非空，采用 `publish.title`（惰性迁移，不做批量重写）。

镜像规则：发布 tab 持久化 publish 段时，`publish.title` 始终镜像 `meta.title`，保证现有各平台上传链路（读 `publish.title`）零改动。

## 2. 生成链路统一

- `PublishWorkbench.tsx` 私有函数 `buildMetadataSource(analysis, srtText)` 提取到 `src/lib/publish-metadata.ts` 并导出，renderer 与 headless 共用。
- `generatePublishMetadata`（`src/lib/publish-metadata.ts`）保持不变，仍产出 `{ title, desc, tags }`。
- 发布 tab 标题输入框改为读写 `meta.title`（加载优先级：`meta.title` → `publish.title`），「生成」按钮行为不变（显式覆盖，当前标题作风格参考传入）。

## 3. 工作流标题生成

关键时序事实（精读代码后确认）：应用内一键工作流的封面提示词由 `analyzeSrt` 内部在 planning 完成后**并行**调用 `cover.regeneration` 产出（`ai-analysis.ts:1588`，Track C 直接消费）。要让封面拿到标题，标题必须在这次调用前就绪——独立的"analyze 之后"流水线步骤对应用内工作流来不及。

因此拆成两层：

**a) analyzeSrt 钩子（应用内工作流 + headless analyze 共用）**
- `AnalyzeSrtOptions` 新增 `generateWorkTitle?: (planning) => Promise<string | null>`；planning 完成后立即触发（与卡片并行），`cover.regeneration` 调用 await 其结果注入 `{{title}}`；失败返回 null 不阻断封面。
- 两个调用方（`analyze-srt` IPC handler、`electron/pipeline/runs/analyze-run.ts`）各自构造该回调：fill-if-empty（已有标题直接返回）→ `buildMetadataSource(planning)` → `generatePublishMetadata` → 落盘 `meta` + `publish`（title 镜像，desc/tags 只填空）→ `emitProjectUpdated(['meta','publish'])`。

**b) 独立 `publish_metadata` run（手动/工作流单独触发）**
- 新增 `electron/pipeline/runs/publish-metadata-run.ts`：加载 analysisResult + SRT → `buildMetadataSource` → `generatePublishMetadata` → 落盘同上。
- 覆盖策略：`resolveWorkTitle` 非空时跳过返回 skipped；`force` 参数强制重生成。
- `PIPELINE_TASK_KINDS` 加 `publish_metadata`，进度桥 KIND_MAP 补 label；MCP 面注册 `lingji_generate_publish_metadata`；lingji CLI 加 `publish meta` 子命令。

## 4. 封面标题变量

- `COVER_REGENERATION` 模板（`src/lib/prompts/defaults.ts`）新增 `{{title}}` 变量，文案指导：标题作为封面主文案/语义锚点；无标题时按现有内容逻辑生成。**bump 模板 version** 以过覆盖版本门槛。
- `src/lib/prompts/types.ts` 的 `cover.regeneration` 变量表注册 `title`。
- `src/lib/ai-analysis.ts` `buildCoverPromptRegenerationPrompt` 增加 `workTitle` 入参，空值渲染为 `无`（与 `globalPrompt` 同规）；`RegenerateCoverPromptOptions` 透传。
- 调用方传值（均不改 IPC 签名）：`regenerate-cover-prompt` 主进程 handler 用 `loadProjectWorkTitle(args.projectDir)`（仿 `loadProjectStylePresetId`）自取；headless `cover-run.ts` 用已加载的 `project` 取 `resolveWorkTitle`；`analyzeSrt` 内部调用用 `generateWorkTitle` 钩子结果。
- 发布 tab 打开期间标题被后台生成：`PublishWorkbench` 监听 `onProjectUpdated`（meta/publish 段）做 fill-if-empty 回灌，避免防抖写回用空标题覆盖新生成值。

## 5. 错误处理

- 流水线标题生成失败：failTask 上报，不阻断后续 covers/export（封面模板兼容空标题）。
- LLM 返回解析失败：沿用 `parsePublishMetadata` 现有容错。
- `meta` 段缺失的旧工程：按可选段处理，读取回退 `publish.title`，首次保存时自然补齐。

## 6. 测试

- `project-persistence`：meta 段 extract/merge、旧工程（无 meta 有 publish.title）迁移读取。
- `publish-metadata`：`buildMetadataSource` 提取后的单测（分析结果组料 / SRT 回退）。
- `prompts`：`cover.regeneration` 带/不带 title 的渲染结果。
- pipeline run：`publish_metadata` 填空/跳过/force 三种路径（按现有 run 测试模式）。
- IPC 三件套若有签名变化（`generate-publish-metadata` 预计无变化），同步 main/preload/electron-api。

## 影响面（高风险项核对）

- 共享类型 `ProjectData` 变更：新增可选段，向后兼容，需同步 electron/project-file.ts 与测试。
- 提示词模板变更：仅加可选变量并 bump version，旧覆盖模板缺 `{{title}}` 时渲染为空串不报错。
- 不改 IPC 名称与现有参数结构；不改导出链路。
