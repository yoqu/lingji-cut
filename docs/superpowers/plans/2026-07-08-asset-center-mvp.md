# 资产中心 MVP 开发计划

> 来源：`ASSET-CENTER-SPEC.md`  
> 日期：2026-07-08  
> 状态：核心闭环已完成，增强项继续迭代

## 目标

把资产中心从可运行 MVP 推进到能支撑真实视频制作的资产工作流：全局素材库、项目目录产物、AI 生成素材、Motion Card 资产绑定需要形成一致的数据视图、可观测状态和可修复闭环。

## 当前切入点

现有编辑器中的 `AssetPanel` 只服务时间线素材，数据存在 timeline store 中，不适合承载跨项目素材库。资产中心应作为独立工作台接入：

- 新增工作区 tab：`资产`
- 新增页面：`AssetCenter`
- 新增主进程模块：`electron/asset-library.ts`
- 新增共享类型：`src/types/assets.ts`
- 新增 IPC：
  - `asset-library:get-state`
  - `asset-library:import-files`
  - `asset-library:update-asset`
  - `asset-library:add-to-project`

## MVP 范围

### Phase A：基础设施

- 定义 `AssetRecord`、`AssetLibraryFile`、`ProjectAssetManifest`
- 默认全局库目录：`~/Movies/灵机剪影/Assets`
- 全局库文件：`library.json`
- 项目资产池文件：`<project>/assets/manifest.json`
- 导入图片 / 视频 / 音频为资产记录
- 记录名称、类型、角色、文件路径、尺寸/时长、hash、标签、来源、处理档案

### Phase B：页面与交互

- 新增“资产”工作台入口
- 页面三栏结构：
  - 左侧：全局库 / 当前项目 / 待生成
  - 中间：资产网格、搜索、类型筛选、导入入口
  - 右侧：资产详情 Inspector
- 支持把全局资产加入当前项目
- 空状态明确告诉用户可以导入素材建立个人视觉库

### Phase C：后续预留

- `AssetRequest` / `CardAssetBinding` 类型预留给 Motion Card
- 资产记录保留 `treatment.profile = editorial-realist-cutout`
- 项目 manifest 记录 `usedBy`，第一版可为空，后续由 Motion Card 写入

### Phase D：Motion Card 资产闭环

- `cards.animation` / card-director 可输出 `assets`
- storyboard 校验资产请求字段与风格枚举
- 资产解析器优先匹配当前项目与全局素材库
- 缺失资产写入项目 manifest 的待生成队列
- 资产中心“待生成”页面可查看 prompt、忽略、恢复、选择生成结果并入库
- `AICardOverlay` 渲染已绑定的资产层

## 当前优化队列

### Phase E：资产一致性与失效检测

- [x] 资产中心状态返回项目健康检查：缺失文件、失效 manifest 引用、已确认生成结果丢失。
- [x] UI 展示健康摘要，让用户知道当前项目哪些素材链路需要修复。
- [x] Motion Card 资产解析时跳过不可用文件，避免把坏路径绑定进卡片。
- [x] `library.json` / `manifest.json` 使用串行提交与原子替换，生成阶段不占用写锁。
- [x] 项目本地扫描使用轻量指纹，避免打开资产中心时读取整段大视频。

### Phase F：项目资产生命周期

- 项目本地素材支持明确的“提升为项目资产 / 复制到项目资产池 / 从项目解除引用”动作。
- [x] 删除、替换、抠图后同步刷新健康状态、卡片绑定、已放置时间线 overlay 和当前选择。
- 对外部删除或移动的项目文件提供重新定位入口。

### Phase G：AI workflow 可观测

- [x] Director 规划出的 `assets`、匹配结果、自动生成、抠图和绑定注入进入 auto-run telemetry。
- [x] 自动生成支持 `AbortSignal`，取消后请求恢复为 `pending`，不遗留 `generating` 状态。
- [x] 待生成队列显示自动生成失败原因；自动结果以 `ready` 等待用户确认入库。
- [x] Motion Card 生成报告补充资产分辨率、透明通道、处理风格与缺失降级原因。

### Phase H：抠图能力升级

- [x] 保留当前绿幕色键作为本地快速路径。
- [x] 完整场景图与可抠物件使用不同生成策略；图片卡默认不抠图，用户显式开启后才执行。
- [x] 原图与抠图同时保留，UI 可切换预览；失败原因不再静默吞掉。
- 后续通过 CLI/workflow skill 接入 remove-background provider，处理非绿幕图。
- 加入绿边/白边/透明通道质量检查。

### Phase I：跨页面联动

- [x] 从 AI 卡片 Inspector 跳转到正在使用的资产。
- [x] Inspector 支持从库替换绑定、强制重生资产和查看资产详情。
- [x] 资产中心操作后主动刷新卡片预览和已放置时间线 overlay。
- [ ] 从普通时间线素材 overlay 直接进入资产修复（非 Motion Card，保留后续增强）。

### Phase J：导出与生产审片

- [x] `assetBindings` 进入 HyperFrames 导出物化，预览与导出使用同一文件。
- [x] Motion contact sheet 合成背景、中景、卡片和前景资产，并将资产版本纳入缓存键。
- [x] 运行时按参考画布缩放 placement，按 storyboard beat 揭示，并兑现 treatment / exit。
- [x] 生产报告把资产问题纳入 `pass / acceptable / risk` 评级。

## 暂缓内容

- AI 图片批量生成
- 语义向量搜索
- 相似素材去重 UI
- 项目归档一键复制
- 单资产 Provider 的逐百分比进度（当前已有开始/结束、耗时、模型、结果 telemetry）

## 验证

- `npm run build` 或至少 `npx tsc --noEmit`
- 资产类型/manifest 纯函数测试
- 页面能通过 TypeScript 编译
- 现有 editor / script / publish tab 不受影响

本次实际验证：

- `npx tsc --noEmit`
- `npx vitest run tests/hyperframes-assets.test.ts tests/asset-resolution.test.ts tests/asset-library-chroma-key.test.ts tests/green-screen-keyer.test.ts tests/main-card-image-ipc.test.ts tests/image-card-form.test.tsx tests/store-ai-card-media.test.ts tests/motion-agent-run.test.ts tests/motion-production-report.test.ts tests/motion-asset-layer.test.ts tests/smoke-render-card.test.ts tests/remotion-timeline-to-sequences.test.ts`
- `npm run build`
- `git diff --check`

## 风险

- 当前工作区已有大量未提交改动，本次只触碰资产中心相关文件与必要入口文件。
- `AppPage` 扩展会影响 Toolbar / WorkspaceTabs / page transition，需要同步更新类型与展示映射。
- 不在第一版修改 `project.json` schema，降低与现有项目保存逻辑冲突。
