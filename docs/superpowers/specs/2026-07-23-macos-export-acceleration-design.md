# macOS 导出加速设计（VideoToolbox 硬件编码）

日期：2026-07-23

## 背景与证据

2026-07-22 合入的分块导出架构（`electron/remotion/chunk-*`、`gpu-runtime.ts`）在 macOS 上已无平台门槛地生效：分块并行（典型 M 系芯片 2 worker × 3 页面）、每块输入裁剪（props 减约 95%）、块间独立编码天然绕开此前「macOS 并行编码被 freemem 误判关闭（约 24% 损失）」的问题。

但两项硬件加速是 Windows 专属：

- 编码器探测只认 `h264_nvenc`（`gpu-runtime.ts probeFfmpegEncoder`），mac 必然回落 `libx264` 纯 CPU 编码。
- `chromiumOptionsForPlatform` 只在 win32 请求 `gl: 'angle'`。

本机实测确认两个关键前提：

1. Remotion 自带的 `@remotion/compositor-darwin-arm64` ffmpeg（n7.1）**已包含 `h264_videotoolbox`**（Apple Silicon 专用媒体引擎硬编），无需引入任何新二进制。
2. 直接 spawn 该 ffmpeg/ffprobe 报 `dyld: Library not loaded: libavdevice.dylib`——dylib 以裸名引用，dyld 只在 cwd 可解析，spawn 必须设 `cwd=<compositor 目录>`（比 DYLD_LIBRARY_PATH 更简单且两个二进制通用）。这还揭示一个存量 bug：mac 上每块渲染后的 ffprobe 校验必然 dyld 失败，导致分块路径整体回退单体渲染——mac 此前实际没吃到分块收益。
3. 该 ffmpeg 是裁剪版：lavfi `color`/`nullsrc` 源不可用（缺 `wrapped_avframe` 解码器）、rawvideo demuxer 缺失，但保留 png 解码器与 image2 demuxer。smoke encode 因此统一改为循环一张内嵌 141 字节黑色 PNG（`-loop 1 -framerate 30 -i smoke.png -frames:v 16`），对裁剪版与 Windows 完整版 FFmpeg 均兼容。

历史约束（export-acceleration 记忆）：GL 调参、concurrency 矩阵搜索此前已被否决，无新证据不重启；mac 单体路径基线约 3.4× 实时。

## 目标

1. macOS（Apple Silicon 优先，Intel 兼容）导出编码切换到 `h264_videotoolbox`，把 CPU 让给瓶颈端（Chrome 截帧）。
2. 保持 H.264 MP4、分辨率、fps、码率档位语义不变。
3. 探测失败自动回落 `libx264`，不让兼容性变成导出失败；实际编码器写入 telemetry。
4. 用同一真实项目在本机做前后对比实测，以 JSONL 数据说话，不设硬性倍数。

## 非目标

- 不做 GL/Metal 调参（仅沿用已有 renderer 遥测）。
- 不做并发矩阵搜索（沿用 `resolveChunkExecutionConfig` 现有默认，保留 env 覆盖）。
- 不改 Windows NVENC 路径行为。
- 不引入新 FFmpeg 二进制或改打包产物结构。

## 方案

完全复刻 NVENC 已验证的模式：**探测 → smoke encode → Remotion `hardwareAcceleration` 保持 `disable` → 经 `ffmpegOverride` 仅替换 stitcher 的 `libx264`**。

### 1. 编码器探测（`gpu-runtime.ts`）

- `probeFfmpegEncoder` 增加平台感知：darwin 上候选编码器为 `h264_videotoolbox`，win32 仍为 `h264_nvenc`，其余平台直接 `libx264`。
- probe 结构泛化为候选无关字段：`candidate`（候选硬编名）、`advertised`、`smokeOk`、`encoder`；telemetry 事件 `export.encoder.probe` 随之更新（JSONL 消费端无 schema 约束）。
- 所有 ffmpeg/ffprobe spawn（含 `probeMediaFile`/`probeChunkMedia`）统一设 `cwd=二进制所在目录`，修复裸名 dylib 解析；dev 态与打包态（`app.asar.unpacked` 下 dylib 同目录）同样适用。
- VideoToolbox smoke encode：循环内嵌 PNG 输入，`-frames:v 16 -c:v h264_videotoolbox -b:v 1000k -pix_fmt yuv420p -f null -`。默认 `allow_sw=0`，无硬件时 smoke 直接失败，自然回落。30 秒超时兜底输入异常导致的无限 loop。

### 2. stitcher override（`createH264TsFfmpegOverride`）

- 签名改为接收目标编码器：`createH264TsFfmpegOverride(encoder, quality)`。
- `h264_videotoolbox` 分支：替换 `-c:v libx264` 为 `h264_videotoolbox`，并**整对移除 `-preset`**（VT 无此选项，保留会直接报错）；码率沿用 Remotion 已注入的 `-b:v`（三档质量继续由码率区分）。
- `h264_nvenc` 分支保持现状（preset p1/p4/p6）。

### 3. 回退链（`chunk-renderer.ts`）

- `encoder` 联合类型扩展为 `'h264_nvenc' | 'h264_videotoolbox' | 'libx264'`（同步 `render.ts`、`render-video-headless.ts`、测试）。
- `isEncoderFailure` 正则追加 `videotoolbox|vt_`；`cpu-encoder` 回退落点仍为 `libx264`，单块内自动降级并记入 `fallbacks`。

### 4. 遥测与观测

- 复用既有事件，不新增日志系统：`export.encoder.probe`（候选/smoke/生效编码器/回落原因）、`export.chunk.end`（每块 encoder、renderFps）、`export.gpu.probe`（mac 上照常记录 renderer，仅观测）。

## 错误处理

- ffmpeg 不存在 / probe 抛错 / smoke 失败 → `libx264`，`fallbackReason` 写明原因，导出继续。
- 块级 VT 编码运行期失败 → `renderChunkWithFallback` 降级 CPU 编码重试，本块 `fallbacks` 记录 `cpu-encoder`。
- 分块编排整体失败 → 既有 `export.chunk.fallback` 回退单体路径，行为不变。

## 测试策略

TDD，先写失败测试：

1. `remotion-gpu-runtime.test.ts`：darwin 候选为 videotoolbox 且注入 `DYLD_LIBRARY_PATH`；smoke 失败回落及原因；win32 行为不变。
2. override：VT 分支替换编码器且移除 `-preset` 对；NVENC 分支回归不变。
3. `remotion-chunk-renderer.test.ts`：VT 运行期失败触发 `cpu-encoder` 降级。
4. `render-video-headless.test.ts`：按平台选择候选编码器接线。

## 真实验收

同一 mac、同一真实项目、同档位各跑一次完整导出（改动前后）：

1. JSONL 证明 `export.encoder.probe` 生效编码器为 `h264_videotoolbox`、无块级 cpu-encoder 降级。
2. 对比总耗时与各块 `renderFps`；同时观察截帧/编码差值确认 CPU 释放效果。
3. `ffprobe` 校验最终 MP4：H.264、目标分辨率、30fps、AAC、帧数与时长一致。
4. 人工抽查画质（VT 与 x264 同码率下观感差异，重点看文字边缘）；若 quality 档画质不可接受，追加「quality 档保留 libx264」的档位开关（当前默认三档全用 VT，保持简单）。

## 方案取舍

- GL/Metal 调参与并发矩阵搜索：历史已否决且无新证据，仅保留遥测观测，若 JSONL 显示 mac headless 长期落在软件渲染且截帧仍是瓶颈，再单独立项。
- 引入系统 ffmpeg 或自带新 ffmpeg：不必要，Remotion 自带 ffmpeg 已含 VT，且避免打包与许可证复杂度。
- `hardwareAcceleration: 'if-possible'`（Remotion 原生 VT 支持）：分块路径用 `h264-ts`，Remotion 4.0.484 对其禁用原生硬件加速，与 NVENC 同理必须走 ffmpegOverride，保持两平台同构。
