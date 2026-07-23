# Remotion 浏览器离线随包设计

## 目标

Windows x64、macOS x64 与 macOS arm64 安装包必须包含与当前 `@remotion/renderer` 匹配的 Chrome Headless Shell。安装完成后，即使设备从未联网，也能导出视频。

## 方案

打包阶段根据目标平台和架构调用 Remotion 自带的浏览器准备能力，在构建机上取得其固定测试版本，并复制到发布暂存目录的 `vendor/remotion-browser/`。该目录通过 `asar.unpackDir` 落在真实文件系统中。

运行时新增一个纯路径解析模块。打包态从 `process.resourcesPath/app.asar.unpacked/vendor/remotion-browser/` 解析可执行文件并在启动 Remotion 时显式传入 `browserExecutable`；开发态返回 `undefined`，继续使用 Remotion 默认缓存。

## 平台边界

- Windows：仅正式发布使用的 x64，路径以 Remotion 实际下载产物为准。
- macOS：分别在 x64、arm64 构建任务中准备对应架构浏览器。
- 当前项目没有 Linux 安装包入口，本次不虚构 Linux 发布链路。
- 若目标架构浏览器未准备成功或可执行文件不存在，打包立即失败。

## 数据与错误处理

浏览器是只读发布资源，不写入 `project.json`，也不经过 Electron IPC。运行时不再依赖 `%APPDATA%/灵机剪影/remotion-cache` 中的浏览器副本，因此旧缓存损坏不会影响导出。

## 验证

单元测试覆盖平台映射、随包路径解析、Windows/macOS 暂存目录包含浏览器，以及 Remotion 两个调用都接收同一 `browserExecutable`。随后运行相关 Vitest、TypeScript/Electron 构建，并检查 Windows 暂存/安装目录中的真实可执行文件。
