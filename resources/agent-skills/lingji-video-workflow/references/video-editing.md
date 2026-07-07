# 视频编辑参考

直接编辑灵机剪影视频时间轴或 Motion Card 源码前读取本文件。

## 可编辑文件

- `<projectDir>/project.json` → 仅 `timeline` 段。
- `<projectDir>/ai-cards/<overlayId>/motionCard.tsx` → Motion Card Remotion 源码。

不要编辑生成产物：`podcast-audio.mp3`、`podcast-subtitles*.srt`、`covers/`、`ai-cards/<id>/image.png`、渲染出的 MP4。

## CLI 锁定与结果协议

编辑前不要手写 `.lingji/edit-lock.json`。先通过 CLI 请求应用锁定界面：

```bash
node "$LINGJI_CLI" edit lock --project <projectDir> --scope video --reason "AI 正在编辑视频内容" --json
```

如果编辑超过约 60 秒，刷新心跳：

```bash
node "$LINGJI_CLI" edit heartbeat --project <projectDir> --json
```

完成、失败或中断前都要解除锁定：

```bash
node "$LINGJI_CLI" edit unlock --project <projectDir> --json
```

锁定后，应用会禁用内容编辑界面，AI 面板仍可查看。`.lingji/edit-lock.json` 只是应用写出的兼容信号，不再由 agent 直接维护。

写入 `project.json` 后读取 `<projectDir>/.lingji/edit-result.json`；若 `ok:false`，按 `errors[].field` / `errors[].message` 修复并重写，直到 `ok:true`。编辑 `motionCard.tsx` 不产生该结果文件。

## project.json 边界

只编辑 `timeline`。做视频域工作时不要手改顶层 `aiAnalysis` 或 `script`。`timeline.overlays[]` 常用可编辑字段：

- `startMs`、`durationMs`：毫秒；`startMs >= 0`，`durationMs > 0`。
- `position`：`{ "x", "y", "width", "height" }`，画布像素。
- `motion`：overlay 进/出/循环动画。
- `textData`：文字 overlay 的内容、字体、颜色、阴影、描边、透明度、旋转与文字动画。
- `audioData`：音频 overlay 的音量、淡入淡出、裁剪起点、源时长、静音。

不要改 `id`（对应 `ai-cards/<id>/` 目录），除非明确迁移并同步所有依赖。

## 动画取值

`motion.enter`:

- `none`
- `fadeIn`
- `slideInLeft`
- `slideInRight`
- `slideInUp`
- `slideInDown`
- `scaleIn`
- `bounceIn`

`motion.exit`:

- `none`
- `fadeOut`
- `slideOutLeft`
- `slideOutRight`
- `slideOutUp`
- `slideOutDown`
- `scaleOut`
- `bounceOut`

Overlay `motion.loop`:

- `none`
- `pulse`
- `float`
- `flicker`

`textData.animation.loop` also allows `typewriter`.

## 字幕样式

全局口播字幕样式编辑 `timeline.subtitle`：

- `fontSize`
- `color`
- `position`: `top`, `bottom`, or `center`
- `highlightEnabled`
- `highlightBackgroundColor`
- `highlightTextColor`
- `highlightPaddingX`
- `highlightPaddingY`
- `highlightRadius`
- `highlightAnimation`: `pop`, `wipe`, or `none`
- `maxCharsPerEntry`
- `autoResegment`

## Motion Card TSX

Edit `<projectDir>/ai-cards/<overlayId>/motionCard.tsx` directly. 文件名用 timeline overlay 的 `id`（即 `<overlayId>`），不是 `cardId`；写错路径不会生效。

保存即生效：项目打开期间编辑器常驻文件监听，写入 `motionCard.tsx` 会自动热重载对应 overlay 的预览，无需重开项目。若改了无反应，先确认路径用的是 overlayId、且该卡已放置到时间轴。

硬约束：

- No Markdown code fence; the file is raw TSX.
- Export a default React function component.
- Render real JSX; do not return `null`.
- Prefer Remotion frame-driven animation with `useCurrentFrame()`, `useVideoConfig()`, `interpolate`, `spring`, `AbsoluteFill`, and `Sequence`.
- Keep the component pure: no side effects, no external network requests, no timers.

### Motion Card 内引用图片

Reference project images through the injected global `cardAsset(relativePath)` — never with absolute paths, `staticFile()` on an absolute path, or large inline `base64` data URIs (these break export: `staticFile() does not support absolute paths`, or multi-MB cards that crash the headless render with out-of-memory).

- Put the image file under the project, e.g. `<projectDir>/assets/<name>.png`, then reference it with a **project-relative** path.
- Wrap it with `cardAsset`, which resolves to `file://` in preview and to the materialized bundle path on export:

```tsx
import { AbsoluteFill, Img, useCurrentFrame } from 'remotion';

export default function Card() {
  return (
    <AbsoluteFill>
      <Img src={cardAsset('assets/codex-visuals/eu-factory.png')} style={{ width: '100%' }} />
    </AbsoluteFill>
  );
}
```

- `cardAsset` is provided by the host runtime; do not import or redefine it.
- The referenced file must already exist on disk under the project before export.
- Tiny inline SVG/icon data URIs (< ~8KB) are tolerated, but prefer `cardAsset` for any real photo/illustration.
