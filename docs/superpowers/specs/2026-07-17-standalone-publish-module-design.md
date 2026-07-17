# 独立发布模块(自由发布)设计

日期:2026-07-17

## 目标

把发布 tab 抽象成项目无关的发布核心,并在欢迎页新增「自由发布」入口:用户给任意视频路径 + 一段主题描述,AI 生成封面 + 标题 + 简介,一键发布到所有已登录平台。

## 现状结论

- 上传核心(`electron/publish/runner.ts` + `platforms/*` + `publish:run` IPC)已经项目无关:只吃 `filePath` + shared 元数据 + 账号 ID。
- 耦合全在渲染层:`PublishWorkbench.tsx`(~1563 行)揉了 UI、AI 元数据生成、covers/ 扫描、project.json 持久化(meta.title 双写镜像)、发布历史。
- 欢迎页是 `src/pages/Setup.tsx`,页面路由是 `App.tsx` 的 `AppPage` 状态机。

## 架构:三层

### 1. 项目无关核心层

- `src/lib/publish/draft.ts`:`PublishDraft` 类型 —— `filePath` / `title` / `desc` / `tags` / `covers`(按比例 Record)/ `thumbnail` / `bilibiliTid`。纯数据,不感知 project。
- `src/hooks/usePublishRunner.ts`:抽出 runPublish / 登录失效重登重试 / 逐目标进度聚合(现散在 PublishWorkbench ~762–920 行),输入 `PublishDraft` + 目标账号,底层走现有 `publish:run` / `startPublish`(接底部统一进度)。
- `src/components/publish/core/`:元数据表单(标题/简介/tags + AI 生成按钮)、封面选择、平台目标 + 进度行(`ResultRow` / `AccountStatusBadge` 迁入)。
- AI 生成复用 `generatePublishMetadata` / `recommendBilibiliPartition`,它们只吃 source 文本;核心层不关心文本来源。

### 2. 项目适配层

`PublishWorkbench` 瘦身为薄壳,只保留项目特有职责:

- project.json publish/meta 段读写与 debounce 持久化;`meta.title` 真源 + `publish.title` 镜像双写不变。
- `covers/` 目录扫描(useCoverStudio)+ `analysisResult` 作 AI 源材料。
- 发布历史写回 project.json(ProjectList 徽标依赖)。
- 对外行为不变,现有测试全部保持通过。

### 3. 自由发布层

- 入口:`Setup.tsx` 快捷按钮组新增「发布视频」;`AppPage` 加 `'free-publish'`,新页面 `src/pages/FreePublish.tsx`。
- 表单:任意视频文件选择器 + 主题 textarea。
- AI:以主题文本作 source,生成标题/简介/tags/B 站分区。
- 封面:AI 按主题文生图,产物写 `userData/publish/standalone/<jobId>/covers/`;`generateCoverImages` 从只认 projectDir 放宽为可指定输出目录。
- 持久化:全局 `userData/publish/standalone-history.json`(草稿 + 发布历史),新增一对 IPC 读写,main / preload / electron-api 三件套同步。

## Electron 侧改动

- 上传核心零改动。
- 新增 standalone 历史读写 IPC。
- `generateCoverImages` 输出目录参数放宽(保持 projectDir 调用路径兼容)。

## 测试

- 核心 hook / lib 单测(draft、runner 状态机、AI source 组装)。
- PublishWorkbench 现有测试作为重构回归门。
- FreePublish 表单与历史持久化测试。

## 风险与策略

主要回归面是 PublishWorkbench 拆解。策略:第一步只抽核心、不改行为、跑通现有测试;第二步落自由发布页与新 IPC。
