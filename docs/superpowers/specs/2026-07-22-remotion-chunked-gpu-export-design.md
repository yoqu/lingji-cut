# Remotion 本地分块 GPU 导出设计

日期：2026-07-22

## 背景与证据

当前 720p「平衡」导出样本时长 1685.27 秒（28 分 5 秒），共 50,557 帧，完整导出耗时 2,281,511ms（38 分 2 秒），实际速度 22.2fps。`export.render` 占总耗时 99.94%，素材物化、卡片编译和 bundle 合计不足 1.5 秒。

该项目包含 280 个 Motion Card、320 条字幕、295 个 overlay。`MainComposition` 为整片建立约 600 个 `Sequence`，并把约 14.2MB 的 `inputProps` 和全部 280 份卡片编译产物注入每个浏览器页面。单帧通常只显示一张卡，但页面仍持有整片数据。项目只有 13 段视频素材，合计 102.4 秒，因此迁移视频解码组件不会解决主要瓶颈。

本机内置 Chrome 在默认 GL 后端下实际使用 SwiftShader。相同浏览器和 1280×720 截帧基准中，SwiftShader 为 15.09fps，ANGLE/D3D11 命中 RTX 4060 Ti 后为 23.95fps。Remotion 自带 Windows FFmpeg 只有 `libx264`；安装包现有旧 FFmpeg 虽声明 `h264_nvenc`，但在当前驱动上实际编码失败。

Remotion 官方文档给出以下约束：

- Headless Chromium 可能禁用 GPU；桌面 GPU 场景推荐 `angle`。
- `angle` 对长渲染存在已知内存泄漏，官方建议把大视频拆成多个部分。
- 分块渲染应使用 `frameRange`、`h264-ts`、`compositionStart` 和 `combineChunks()`。
- Windows NVENC 需要通过 `binariesDirectory` 提供带 `h264_nvenc` 的 FFmpeg。
- `@remotion/web-renderer` 只有单并发且不完整支持任意 CSS，不适合当前自由 TSX Motion Card。

官方参考：

- https://www.remotion.dev/docs/performance
- https://www.remotion.dev/docs/gpu
- https://www.remotion.dev/docs/gl-options
- https://www.remotion.dev/docs/distributed-rendering
- https://www.remotion.dev/docs/hardware-acceleration
- https://www.remotion.dev/docs/client-side-rendering/limitations

## 目标

1. 保持 1280×720、30fps、H.264、AAC 以及现有时间线视觉与音频语义不变。
2. 首次完整导出目标不超过 15 分钟，硬性验收上限 18 分钟；相对 38 分 2 秒基线至少提升 2 倍。
3. 每次导出都重新渲染全部分块，不复用任何历史视频画面。
4. 完全离线导出；Chrome、Remotion 二进制和兼容现代驱动的 FFmpeg 均进入安装包。
5. GPU、NVENC 或分块路径不可用时自动回退，不让兼容性问题变成导出失败。
6. 保持现有 auto-run JSONL 观测体系，不新增独立日志系统。

## 非目标

- 本次不把自由 TSX Motion Card 重写为纯 FFmpeg、Canvas 或 WebGL 模板。
- 本次不切换到 `@remotion/web-renderer`。
- 本次不降低时间线帧率或通过重复帧伪装 30fps。
- 本次不依赖云端 Lambda 或外部渲染机器。

## 总体架构

单体 `renderMedia()` 改为本地编排器：

```text
完整时间线
  -> 固定帧数分块
  -> 为每块裁剪 timeline / SRT / compiledCards
  -> 2–3 个块并行渲染 h264-ts + 独立音频
  -> 校验每个块
  -> combineChunks() 原子合并
  -> ffprobe 校验最终 MP4
```

ANGLE、NVENC 和分块裁剪是同一个方案的组成部分。仅分块而不裁剪不会减少总工作量；主要收益来自每个页面只接收当前块需要的数据，以及短生命周期浏览器避免 ANGLE 长片内存泄漏。

## 分块计划

- 默认每块 1,800 帧，即 60 秒；除最后一块外长度一致，符合 Remotion 分布式渲染约束。
- 50,557 帧会生成 29 个块，范围从 `[0, 1799]` 到最后一个不足 1,800 帧的范围。
- 使用完整 composition 的帧坐标，`compositionStart` 对完整导出固定为 0。
- 卡片跨块转场最多额外查看边界两侧 `CARD_CROSSFADE_FRAMES`，但实际输出仍严格裁在块的 `frameRange` 内。
- 块大小可由 `LINGJI_EXPORT_CHUNK_SECONDS` 覆盖，仅用于受控基准和故障诊断。

## 输入裁剪

每块构造独立、不可变的 `MainCompositionProps`：

- `timeline.overlays` 只保留与块范围相交的视觉、文本、视频和音频 overlay；跨边界项保留原始绝对起止时间。
- podcast 元数据和整片 duration 保持不变，以保证 composition 长度和绝对帧坐标一致。
- `srtEntries` 只保留与块范围相交的字幕，并保留原始时间。
- `compiledCards` 只保留本块 overlay ID 对应的编译产物。
- 与转场边界相交的前后卡片都进入块输入，避免块边界画面变化。
- `subtitleHighlights` 保留影响当前块字幕的条目；数量很小时允许整体保留。

按当前项目估算，每块通常只含约 10 张卡和 12 条字幕，单页面编译卡数据由 280 份降至约 10 份，约减少 95%。

## GPU 与编码器选择

### Chromium

- Windows 默认请求 `chromiumOptions.gl: 'angle'`。
- 启动时读取 WebGL renderer；只有明确命中 NVIDIA/AMD/Intel 硬件而非 SwiftShader 才记录为 GPU 生效。
- ANGLE 初始化失败时，该块以默认 GL 重试一次。
- 浏览器按块释放，避免官方文档描述的长片 ANGLE 内存泄漏积累。

### FFmpeg / NVENC

- Windows 安装包加入固定版本、可校验哈希的现代 FFmpeg，并保留许可证文件。
- 构建时把现代 `ffmpeg.exe` 与 Remotion compositor 的 `ffprobe.exe`、`remotion.exe` 及 DLL 组成完整 `binariesDirectory`。
- 运行时不仅检查 `-encoders` 是否包含 `h264_nvenc`，还执行极短的真实 NVENC smoke encode；旧 FFmpeg“声明支持但驱动调用失败”必须被识别。
- Remotion 4.0.484 明确禁止 `h264-ts` 使用 `hardwareAcceleration:'required'`。smoke encode 成功时保持 Remotion 为 `disable`，再通过其公开的 `ffmpegOverride` 仅把 stitcher 的 `libx264` 替换为 `h264_nvenc`；失败则不注入 override，明确选择 `libx264`。这不是静默回退，实际 encoder 必须写入 telemetry。
- 三档质量继续使用现有码率。NVENC preset 映射为 speed=`p1`、balanced=`p4`、quality=`p6`；CPU 回退沿用 ultrafast、veryfast、medium。
- 有效 GL renderer、编码器和回退原因写入 telemetry。

## 并发模型与性能搜索

默认从“2 个块并行 × 每块 2 页面”开始，总页面数为 4，与已验证稳定上限一致。由于裁剪后 props 大幅缩小，受控基准会测试以下组合：

- 块 worker：1、2、3。
- 每块 Remotion concurrency：1、2、3。
- 总页面数默认不超过 6；8GB 显存机器不直接放大到历史上失败的 26 页面。

使用当前项目的普通、复杂、转场密集三个 60 秒区间进行矩阵测试。选择完整成功且吞吐最高的组合；若两个组合差距小于 5%，选择页面更少、内存更低的组合。环境变量 `LINGJI_EXPORT_CHUNK_WORKERS` 和既有 `LINGJI_EXPORT_CONCURRENCY` 保留诊断覆盖能力。

性能搜索到达以下任一条件即停止：

- 新组合相对当前最佳提升不足 5%。
- 出现浏览器连接重置、ANGLE/GPU 崩溃、显存不足或块输出校验失败。
- CPU、GPU 编码器或 GPU 3D 已持续饱和，继续加页面只增加排队。

## 分块编码与合并

每块按 Remotion 官方分布式渲染参数输出：

- `codec: 'h264-ts'`
- `frameRange: [startFrame, endFrame]`
- `compositionStart: 0`
- `enforceAudioTrack: true`
- AAC 路径启用 `forSeamlessAacConcatenation`
- 需要音频时使用 `separateAudioTo` 保存对应音频块

全部块完成后使用 `combineChunks()`：

- `videoFiles` 和 `audioFiles` 严格按帧范围排序。
- 最终 codec 传 `h264`。
- `framesPerChunk` 为 1,800。
- `compositionDurationInFrames` 为 50,557（按实际 composition 读取，不硬编码）。
- fps、码率、音频 codec、metadata、binariesDirectory 与块渲染保持一致。
- 合并到同目录临时文件，校验成功后原子替换用户目标路径。

## 不使用持久化渲染缓存

根据 2026-07-23 的产品决定，导出不读取或写入历史视频分块。每次导出都在独立临时目录中重新渲染全部块，合并完成或失败后清理临时文件。这样牺牲热导出速度，换取时间线文字、字幕和卡片修改不会复用旧画面。

## 进度、取消与错误处理

- 总进度按所有块的帧数加权。
- 用户取消时终止所有活动 `renderMedia()`、停止调度新块并清理临时文件。
- 单块失败先以同一 GPU 配置、单页面重试一次。
- ANGLE 失败则默认 GL 重试；NVENC 失败则 CPU 编码重试并在本次运行中禁用 NVENC。
- 若分块编排或合并出现不可恢复错误，可回退现有单体导出路径；回退原因必须明确记录。
- 最终输出校验失败时不覆盖用户已有文件。

## Telemetry

继续写入 `<userData>/logs/auto-run/<runId>.jsonl`，新增事件不另起日志：

- `export.chunk.plan`：块大小、块数、worker、页面并发、预计 props 缩减。
- `export.chunk.start/end`：范围、输入规模、耗时和渲染 fps。
- `export.gpu.probe`：请求 GL、有效 renderer、是否硬件 GPU。
- `export.encoder.probe`：FFmpeg 版本、NVENC smoke 结果、有效编码器。
- `stage.start/end{stage:'export.render.chunks'}`。
- `stage.start/end{stage:'export.combine'}`。

不再为每条 browser debug 写一行 JSONL。只聚合 debug/warn/error 数量，并保留首个错误摘要；现有一次导出 56,720 条逐帧 debug 的行为必须消除。

## 测试策略

实现采用 TDD，先写失败测试再写生产代码：

1. 分块范围：整除、尾块、单帧和边界输入。
2. 输入裁剪：跨块 overlay、14 帧转场、字幕、附加音频、compiledCards。
3. 无缓存回归：重复导出必须再次渲染全部块，且不得产生缓存事件。
4. GPU/编码器探测：NVENC 列出但 smoke 失败时回退；成功时必须选择经过测试的 `h264-ts` stitcher override，且 Remotion 原生 `hardwareAcceleration` 保持 `disable` 以绕开其 codec gate。
5. 并发调度：上限、取消、单块重试、GPU 降级、CPU 降级。
6. `combineChunks()` 参数和块顺序。
7. Windows 打包：现代 FFmpeg、许可证、Remotion compositor 和离线 Chrome 全部进入目录包与 NSIS。
8. 短集成测试：至少三个块，验证边界音画连续和最终帧数。

## 真实验收

使用 Computer Use 从 `release/灵机剪影-win32-x64` 实际应用界面触发，不用测试脚本冒充 UI：

1. 对三个代表性 60 秒区间跑旧路径与新路径矩阵，选择最快稳定组合。
2. 用同一项目、720p、平衡档完整导出。
3. 新 JSONL 必须证明 ANGLE 命中 RTX 4060 Ti、编码器为 `h264_nvenc`、全部块均重新渲染且 worker/合并按设计运行。
4. `ffprobe` 验证 H.264、1280×720、30fps、50,557 帧、AAC、时长约 1685.27 秒。
5. 检查每个块边界前后帧和音频连续性。
6. 首次完整导出硬上限 18 分钟、目标 15 分钟；未达到则继续调块大小和并发，直到新增组合提升不足 5%或触发稳定性边界。
7. 再次导出并修改文字，验证两次都完整渲染且成片使用最新文字。

## 方案取舍

纯 FFmpeg 可以把最终封装压到分钟级，但无法直接渲染当前任意 React/CSS/TSX 卡片，必须重写 Motion Card 引擎，不作为本次修复。`@remotion/web-renderer` 减少进程间通信并使用 WebCodecs，但当前只有单并发，且自由卡片可能使用不受支持的 CSS；待分块方案完成后可单独做兼容性实验，不进入本次关键路径。
