# Remotion Chunked GPU Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前 28 分钟项目的单体 CPU 导出改为完全离线的分块 ANGLE/NVENC 导出，首次完整导出稳定控制在 18 分钟内；每次导出均重新渲染全部分块。

**Architecture:** 保持一个完整 Remotion composition 和绝对帧坐标，将它切成固定 1,800 帧的渲染块；每块只传入相交的 overlay、字幕和 compiled card，再以 `h264-ts` 和独立 AAC 输出，最后由 `combineChunks()` 合并。Windows 安装包内置离线 Chrome 与经过真实 smoke encode 验证的现代 FFmpeg；GPU、NVENC 或分块路径失败时有明确遥测并回退到兼容路径。

**Tech Stack:** Electron 41、TypeScript 6、Remotion 4.0.484、Vitest、Node.js、Chromium ANGLE、FFmpeg/NVENC、NSIS。

---

## 文件结构

- Create: `electron/remotion/chunk-plan.ts` — 纯函数：块范围、相交判断、每块 props 裁剪。
- Create: `electron/remotion/gpu-runtime.ts` — ANGLE 与 NVENC 运行时选择、真实 smoke probe。
- Create: `electron/remotion/chunk-renderer.ts` — worker 调度、块重试、进度聚合、合并。
- Modify: `electron/remotion/render.ts` — 暴露 composition 选择、单块 `h264-ts` 渲染和 `combineChunks()` 薄封装。
- Modify: `electron/remotion/render-video-headless.ts` — 用分块编排器替换单体主路径，并保留单体回退与现有 mastering。
- Modify: `scripts/package-windows.cjs` — 固定并校验现代 FFmpeg，覆盖 compositor 目录中的 FFmpeg/FFprobe，并携带许可证。
- Modify: `scripts/package-windows-installer.cjs` — 确保新增运行时文件进入 NSIS。
- Test: `tests/remotion-chunk-plan.test.ts`
- Test: `tests/remotion-gpu-runtime.test.ts`
- Test: `tests/remotion-chunk-renderer.test.ts`
- Test: `tests/remotion-browser-packaging.test.ts`
- Test: `tests/package-windows-stage.test.ts`
- Test: `tests/render-video-headless.test.ts`

### Task 1: 分块范围与输入裁剪

**Files:**
- Create: `electron/remotion/chunk-plan.ts`
- Test: `tests/remotion-chunk-plan.test.ts`

- [ ] **Step 1: 写块范围失败测试**

```ts
import {describe, expect, it} from 'vitest';
import {planRenderChunks} from '../electron/remotion/chunk-plan';

describe('planRenderChunks', () => {
  it('creates inclusive fixed-size ranges and a short tail', () => {
    expect(planRenderChunks(5_557, 1_800)).toEqual([
      {index: 0, startFrame: 0, endFrame: 1_799, frameCount: 1_800},
      {index: 1, startFrame: 1_800, endFrame: 3_599, frameCount: 1_800},
      {index: 2, startFrame: 3_600, endFrame: 5_399, frameCount: 1_800},
      {index: 3, startFrame: 5_400, endFrame: 5_556, frameCount: 157},
    ]);
  });
  it('rejects non-positive inputs', () => {
    expect(() => planRenderChunks(0, 1_800)).toThrow(/duration/i);
    expect(() => planRenderChunks(100, 0)).toThrow(/chunk/i);
  });
});
```

- [ ] **Step 2: 运行测试并确认因缺少模块失败**

Run: `npx vitest run tests/remotion-chunk-plan.test.ts`

Expected: FAIL，提示无法解析 `electron/remotion/chunk-plan`。

- [ ] **Step 3: 实现最小块规划函数**

```ts
export interface RenderChunk {
  index: number;
  startFrame: number;
  endFrame: number;
  frameCount: number;
}

export function planRenderChunks(durationInFrames: number, framesPerChunk: number): RenderChunk[] {
  if (!Number.isInteger(durationInFrames) || durationInFrames < 1) throw new Error('durationInFrames must be positive');
  if (!Number.isInteger(framesPerChunk) || framesPerChunk < 1) throw new Error('framesPerChunk must be positive');
  const chunks: RenderChunk[] = [];
  for (let startFrame = 0, index = 0; startFrame < durationInFrames; startFrame += framesPerChunk, index++) {
    const endFrame = Math.min(durationInFrames - 1, startFrame + framesPerChunk - 1);
    chunks.push({index, startFrame, endFrame, frameCount: endFrame - startFrame + 1});
  }
  return chunks;
}
```

- [ ] **Step 4: 写输入裁剪失败测试**

测试必须构造：完全在块外的 overlay、跨块 overlay、恰好从块尾后一帧开始的 overlay、额外音频、两条 SRT、两张 compiled card。断言只保留半开区间 `[chunkStartMs, chunkEndExclusiveMs)` 相交项，保留原始绝对 `startMs`，并只保留已入选 ai-card ID 对应的编译结果与字幕高亮。

```ts
const result = sliceChunkInput({timeline, srtEntries, compiledCards}, {index: 1, startFrame: 1800, endFrame: 3599, frameCount: 1800});
expect(result.timeline.overlays.map((item) => item.id)).toEqual(['crossing-card', 'audio-in-chunk']);
expect(result.timeline.overlays[0].startMs).toBe(59_500);
expect(result.srtEntries.map((entry) => entry.index)).toEqual([2]);
expect(Object.keys(result.compiledCards)).toEqual(['crossing-card']);
expect(result.timeline.podcast.durationMs).toBe(timeline.podcast.durationMs);
```

- [ ] **Step 5: 实现帧/毫秒相交和纯函数裁剪**

实现 `sliceChunkInput(input, chunk, fps)`：overlay 使用 `startMs + durationMs`，SRT 使用 `startMs/endMs`；保留整个 `podcast`、画布、轨道、字幕样式和总时长，只替换 `overlays`、`editedSubtitles`、`subtitleHighlights`。为避免转场断裂，相交区间左右各扩展 `CARD_CROSSFADE_FRAMES`，但 render 的 `frameRange` 不扩展。

- [ ] **Step 6: 运行测试并提交**

Run: `npx vitest run tests/remotion-chunk-plan.test.ts`

Expected: PASS。

```powershell
git add electron/remotion/chunk-plan.ts tests/remotion-chunk-plan.test.ts
git commit -m "feat(export): plan and slice Remotion chunks"
```

### Task 2: 不使用持久化渲染缓存

2026-07-23 根据产品决定移除块缓存。调度器不得计算缓存键、读取或提交历史块，也不得发出缓存命中/未命中事件；每次导出只使用本次运行的临时块，合并完成后统一清理。

### Task 3: GPU 与 NVENC 运行时探测

**Files:**
- Create: `electron/remotion/gpu-runtime.ts`
- Test: `tests/remotion-gpu-runtime.test.ts`

- [ ] **Step 1: 写 NVENC 真实 probe 失败测试**

用注入的 `spawn` 模拟三种情况：没有 `h264_nvenc`；列出 encoder 但 smoke encode 退出码 1；smoke encode 退出码 0。断言前两种选择 `{remotionHardwareAcceleration:'disable', encoder:'libx264'}`；成功时仍保持 Remotion 为 `disable`，但选择 `{encoder:'h264_nvenc', usesFfmpegOverride:true}`，并保留 stderr 摘要作为 fallback reason。原因是 Remotion 4.0.484 的原生 gate 明确拒绝 `h264-ts + required`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/remotion-gpu-runtime.test.ts`

Expected: FAIL，缺少模块。

- [ ] **Step 3: 实现 FFmpeg 版本、encoder 和 smoke encode**

smoke 命令固定使用 16 帧的 lavfi color 输入并输出到 null：

```ts
[
  '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'color=c=black:s=128x128:r=30:d=0.54',
  '-frames:v', '16', '-c:v', 'h264_nvenc', '-preset', 'p4',
  '-f', 'null', 'NUL',
]
```

仅检查 `-encoders` 不算成功。结果类型含 `ffmpegVersion`、`nvencAdvertised`、`nvencSmokeOk`、`remotionHardwareAcceleration`、`usesFfmpegOverride` 和 `fallbackReason`。

- [ ] **Step 4: 实现 Chromium GL 配置和日志判定**

Windows 请求 `chromiumOptions: {gl: 'angle', ignoreCertificateErrors: false}`。聚合浏览器日志，匹配 `ANGLE`、`NVIDIA|AMD|Intel` 和 `SwiftShader`；只有硬件名命中且不含 SwiftShader 才记录 `hardwareGpu:true`。ANGLE 导航失败由调度器以默认 GL 单页重试。

- [ ] **Step 5: 运行测试并提交**

Run: `npx vitest run tests/remotion-gpu-runtime.test.ts`

Expected: PASS。

```powershell
git add electron/remotion/gpu-runtime.ts tests/remotion-gpu-runtime.test.ts
git commit -m "feat(export): probe ANGLE and NVENC runtime"
```

### Task 4: Remotion 单块渲染、日志摘要与合并

**Files:**
- Modify: `electron/remotion/render.ts`
- Test: `tests/remotion-chunk-renderer.test.ts`

- [ ] **Step 1: 写渲染参数失败测试**

mock `@remotion/renderer`，断言 `renderChunk()` 调用：`codec:'h264-ts'`、`frameRange:[start,end]`、`compositionStart:0`、`enforceAudioTrack:true`、`forSeamlessAacConcatenation:true`、`separateAudioTo:<chunk>.aac`、`chromiumOptions.gl:'angle'`、裁剪后的 inputProps、`hardwareAcceleration:'disable'` 与离线 `binariesDirectory`；NVENC 命中时断言 `ffmpegOverride` 只在 stitcher 中把 `libx264/preset` 替换为 `h264_nvenc/p1|p4|p6`。

- [ ] **Step 2: 写合并参数失败测试**

断言块按 `startFrame` 排序后传给：

```ts
combineChunks({
  videoFiles,
  audioFiles,
  outputLocation,
  codec: 'h264',
  fps,
  framesPerChunk,
  preferLossless: false,
  compositionDurationInFrames,
  audioCodec: 'aac',
  audioBitrate,
  binariesDirectory,
});
```

- [ ] **Step 3: 实现可复用 composition 与块渲染薄层**

`selectRemotionComposition()` 只执行一次；`renderRemotionChunk()` 返回 `slowestFrames`、耗时和 browser log summary；`combineRemotionChunks()` 只负责严格参数映射。浏览器逐帧 debug 不再逐条调用 telemetry：只累计 `{debug,warn,error,total,firstError}`，块结束时发一次。

- [ ] **Step 4: 运行测试并提交**

Run: `npx vitest run tests/remotion-chunk-renderer.test.ts`

Expected: PASS，且旧 `tests/render-video-headless.test.ts` 仍 PASS。

```powershell
git add electron/remotion/render.ts tests/remotion-chunk-renderer.test.ts
git commit -m "feat(export): render and combine h264-ts chunks"
```

### Task 5: 块 worker 调度、回退和 telemetry

**Files:**
- Create: `electron/remotion/chunk-renderer.ts`
- Modify: `electron/remotion/render-video-headless.ts`
- Modify: `tests/remotion-export-concurrency.test.ts`
- Modify: `tests/render-video-headless.test.ts`
- Test: `tests/remotion-chunk-renderer.test.ts`

- [ ] **Step 1: 写 worker 上限和进度失败测试**

构造 5 个块与延迟 promise，断言默认 `resolveChunkWorkers(...)=2`、单块 concurrency 默认 2、任意时刻活动块不超过 worker 数，总页面不超过 6，最终进度单调并等于 1。

- [ ] **Step 2: 写回退状态机失败测试**

同一块第一次失败后以单页同 GL 重试；含 ANGLE/GPU 错误再以默认 GL 重试；含 NVENC 错误后本次运行禁用 NVENC 并以 CPU 重试。断言每种降级只发生一次，无限重试被禁止，未完成块失败后才允许回退旧单体导出。

- [ ] **Step 3: 实现调度器**

```ts
export async function runChunkPool<T>(items: readonly T[], workers: number, run: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({length: Math.min(workers, items.length)}, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await run(item);
    }
  }));
}
```

环境变量：`LINGJI_EXPORT_CHUNK_SECONDS` 默认 60；`LINGJI_EXPORT_CHUNK_WORKERS` 默认 2；沿用 `LINGJI_EXPORT_CONCURRENCY` 作为每块页面数。自动值必须令 `workers * concurrency <= 4`，显式诊断值硬上限 6。

- [ ] **Step 4: 接入 headless 导出主路径**

在素材外置、卡片编译、bundle 后：选择 composition → 规划块 → 对每块裁剪输入 → 调度全部块 render → probe → `combineChunks()` 输出到目标同目录临时文件 → ffprobe 验证 → rename 到用户路径。保留 quality mastering 在最终 MP4 之后执行。

Telemetry 必须发：`export.chunk.plan`、`export.chunk.start/end`、`export.gpu.probe`、`export.encoder.probe`、`stage.start/end{stage:'export.render.chunks'}`、`stage.start/end{stage:'export.combine'}`；禁止产生缓存事件和逐 browser debug JSONL。

- [ ] **Step 5: 运行定向测试和全量测试并提交**

Run: `npx vitest run tests/remotion-chunk-plan.test.ts tests/remotion-gpu-runtime.test.ts tests/remotion-chunk-renderer.test.ts tests/remotion-export-concurrency.test.ts tests/render-video-headless.test.ts`

Expected: PASS。

Run: `npm test`

Expected: 全部 PASS。

```powershell
git add electron/remotion/chunk-renderer.ts electron/remotion/render-video-headless.ts tests/remotion-export-concurrency.test.ts tests/render-video-headless.test.ts
git commit -m "feat(export): orchestrate uncached GPU chunk rendering"
```

### Task 6: Windows 离线现代 FFmpeg 打包

**Files:**
- Modify: `scripts/package-windows.cjs`
- Modify: `scripts/package-windows-installer.cjs`
- Modify: `tests/package-windows-stage.test.ts`
- Modify: `tests/remotion-browser-packaging.test.ts`

- [ ] **Step 1: 写打包失败测试**

断言 Windows x64 的固定 manifest 包含版本、HTTPS 下载 URL、SHA-256 和许可证；stage 目录最终同时含 `remotion.exe`、现代 `ffmpeg.exe`、`ffprobe.exe`、所需 DLL、Chrome executable 和许可证。mock 的 smoke probe 失败时打包必须失败，不能只凭 `-encoders` 通过。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/package-windows-stage.test.ts tests/remotion-browser-packaging.test.ts`

Expected: FAIL，当前仍固定 `@ffmpeg-installer/win32-x64@4.1.0`。

- [ ] **Step 3: 实现固定版本下载、哈希和 stage**

只支持当前 Windows x64 产品；下载产物放 `.tmp/ffmpeg-vendor`，每次复用前重算 archive 和 executable 的 SHA-256。解压后将现代 FFmpeg 文件覆盖到 staged `node_modules/@remotion/compositor-win32-x64-msvc/`，保留该目录的 `remotion.exe` / `ffprobe.exe`，并复制 `LICENSE.txt`。Windows 打包机在 staged 文件上运行 16 帧 NVENC smoke encode；无 GPU 的 CI 只警告，用户机器运行时 probe 才是 encoder 选择的最终依据；设置 `LINGJI_REQUIRE_NVENC_SMOKE=1` 时打包 smoke 失败即终止。

- [ ] **Step 4: 运行测试、构建和目录包**

Run: `npx vitest run tests/package-windows-stage.test.ts tests/remotion-browser-packaging.test.ts tests/package-windows-installer.test.ts`

Expected: PASS。

Run: `npm run build && npm run bundle:remotion && npm run package:win`

Expected: `release/灵机剪影-win32-x64` 和 NSIS 安装包生成成功；打包日志显示离线 Chrome 和现代 FFmpeg 已 stage，NVENC smoke PASS。

- [ ] **Step 5: 运行离线文件审计并提交**

Run: 对 release 目录中的 Chrome、`remotion.exe`、`ffmpeg.exe`、`ffprobe.exe` 执行 `Test-Path`，再执行 release 内 FFmpeg 的 16 帧 NVENC smoke。

Expected: 全部存在且 smoke exit code 0。

```powershell
git add scripts/package-windows.cjs scripts/package-windows-installer.cjs tests/package-windows-stage.test.ts tests/remotion-browser-packaging.test.ts
git commit -m "build(win): bundle verified modern FFmpeg for NVENC"
```

### Task 7: Computer Use 真实性能矩阵和完整验收

**Files:**
- Modify only if measurements identify a concrete bottleneck in the files above.
- Read: `%APPDATA%/灵机剪影/logs/auto-run/*.jsonl`
- Produce: 用户选择的最终 MP4。

- [ ] **Step 1: 读取 Computer Use 操作规则**

在接管桌面前完整读取 `computer-use` 的 `SKILL.md`，然后调用 `sky.documentation('guidance')`；需要 API 或确认规则时再读取相应文档。禁止操作 Codex 窗口。

- [ ] **Step 2: 从真实 release 应用触发三类 60 秒测试**

用 `release/灵机剪影-win32-x64/灵机剪影.exe` 打开现有项目，从应用 UI 导出普通、复杂、转场密集区间。测试 worker/concurrency：`1x1`、`1x2`、`2x2`、`2x3`、`3x2`，总页面不超过 6；每次从新 JSONL 读取实际 chunk fps、GPU renderer、NVENC smoke、峰值失败与总耗时。

- [ ] **Step 3: 按停止规则选择极限稳定组合**

新组合比当前最佳提升不足 5%时停止；若差距不足 5%，选页面更少者。ANGLE 崩溃、浏览器连接重置、显存不足、块 probe 失败任一出现即回到上一个稳定组合。将默认 worker/concurrency 固化并补测试。

- [ ] **Step 4: 完整导出同一个 28 分钟项目**

从真实 UI 发起 1280×720、30fps、平衡档完整导出。若超过 18 分钟或失败，先读该次 JSONL 的 `stage.end`、`export.chunk.end` 和 GPU/encoder probe，再针对最慢环节调块大小或并发，重新构建并复测；不能凭感觉调参。

- [ ] **Step 5: ffprobe 和边界验收**

用打包内 `ffprobe.exe` 验证最终文件：H.264、1280×720、30fps、50,557 帧、AAC、时长约 1685.27 秒。抽查每个 60 秒边界前后帧和音频连续性；修改一处文字后再次完整导出，确认全部块重新渲染且成片使用最新文字。

- [ ] **Step 6: 最终回归**

Run: `npm test`

Expected: 全部 PASS。

Run: `npm run build && npm run bundle:remotion`

Expected: PASS。

最终汇报必须包含：38:02 基线、最佳参数、完整导出耗时、实际 fps、GPU renderer、NVENC 结果、无缓存证据、ffprobe 摘要，以及仍存在的硬件/驱动边界。

---

## 自检

- Spec coverage：范围规划、输入裁剪、ANGLE、NVENC smoke、并发搜索、无缓存块合并、回退、telemetry、离线打包和 Computer Use 真实验收均有对应任务。
- Placeholder scan：无 TBD/TODO/“稍后实现”；每个生产改动都有明确测试、命令和预期结果。
- Type consistency：统一使用 inclusive `startFrame/endFrame`、`frameCount`、`framesPerChunk`；所有块保持 `compositionStart:0` 与绝对时间坐标；最终 codec `h264`，中间 codec `h264-ts`。
