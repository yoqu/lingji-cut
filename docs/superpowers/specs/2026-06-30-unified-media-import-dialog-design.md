# 统一媒体导入弹窗 设计

日期：2026-06-30

## 背景与问题

当前媒体导入是「两阶段弹窗」：

- **第一阶段**（`Setup.tsx` 内联弹窗，抖音 / 本地视频各一个）：负责「创建项目」——解析标题或选文件 → 选父目录 → 工程名 → 一键成稿配置 → 调 `onMediaImport(...)` 建项目并跳脚本工作台。
- **第二阶段**（`DouyinImportDialog.tsx`，在工作台）：已是「多 Tab（抖音 / 本地视频 / 本地音频）+ 进度条」统一形态，负责在已建项目里真正下载 / 转录，提交回调 `onSubmit(source)`。

诉求：去掉第一阶段那个入口弹窗，把第二阶段的多 Tab 弹窗提到第一级，抖音 / 本地视频 / 本地音频同级 Tab，一个弹窗支持多 Tab 导入。

## 已确认决策

1. **目录 / 工程名**：自动推导（目录=上次使用目录，工程名=抖音标题 / 文件名去扩展名）+ 弹窗内可编辑。
2. **一键成稿配置**（autoMode / 参数 / 模型绑定）：内嵌进统一弹窗。
3. **入口**：管理页快捷栏「抖音导入」「本地视频」「导入音频」三按钮 → 三合一为「导入媒体」。
4. **旧 audio+SRT 目录扫描流程**（不转录、直接进 editor 时间线）：直接去掉。

## 方案

### 一、`DouyinImportDialog` 升级为唯一媒体导入弹窗，双模式

- **`create` 模式**（管理页，新增）：三 Tab + 源输入之外，增加：
  - 工程名输入框（自动推导，可编辑）
  - 存放目录（默认取「上次使用目录」，首次回退手选 `selectProjectDirectory`，可更换）
  - 一键成稿开关 + 参数 + 模型绑定（复用 Setup 现有配置 UI）
  - 提交 → `onCreate(parentDir, title, source, autoMode, autoParams, modelBinding)`（即现 `onMediaImport`）→ 关闭跳工作台。
  - 本模式不在弹窗内显示进度。
- **`import` 模式**（工作台，现状不变）：三 Tab + 进度条，提交 `onSubmit(source)`。

进度连续性：`create` 提交后跳工作台，现有 `pendingMediaImport` 机制自动打开同款弹窗接管进度条，视觉上是同一弹窗延续。

### 二、`Setup.tsx`

- 删除：抖音内联弹窗、本地视频内联弹窗、音频+SRT 目录扫描弹窗及其状态（`scanImportDirectory` / `scanResult` / `selectedAudio` / `selectedSrt` / `importDialogOpen` 等）。
- 快捷栏三按钮合并为单个「导入媒体」，打开 `DouyinImportDialog` 的 `create` 模式。
- 保留「导入文稿」「导入项目」按钮。

### 三、新增能力

- 「上次使用目录」轻量持久化（localStorage 或 app config），供目录字段默认值。

## 影响面 / 风险

- `onComplete`(audio+SRT→editor) props 链路：实施前核实调用方，仅 Setup 使用则一并清理，否则保留接口只摘 Setup 入口。
- 无新增 IPC，复用 `selectProjectDirectory` / `resolveDouyinUrl` / `selectMediaFile`。
- `DouyinImportDialog` 现有 `import` 模式调用方（`ScriptWorkbench` / `EmptyGuide` / `QuickActionBar`）需保持行为不变。

## 验证

- `npx vitest run`（相关测试）
- 手动：管理页「导入媒体」→ 三 Tab 各创建项目一次 + 一键成稿开关；工作台内导入保持原样。
