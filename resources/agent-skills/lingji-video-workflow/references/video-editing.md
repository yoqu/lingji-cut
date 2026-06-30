# 视频编辑参考

直接编辑灵机剪影视频时间轴或 Motion Card 源码前读取本文件。

## 可编辑文件

- `<projectDir>/project.json` → only the `timeline` section.
- `<projectDir>/ai-cards/<overlayId>/motionCard.tsx` → Motion Card Remotion source.

Do not edit generated media artifacts: `podcast-audio.mp3`, `podcast-subtitles*.srt`, `covers/`, `ai-cards/<id>/image.png`, or rendered MP4 files.

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

After editing `project.json`, read `<projectDir>/.lingji/edit-result.json`. If `ok:false`, fix the listed `errors[].field` / `errors[].message`, rewrite `project.json`, and check again until `ok:true`. Editing `motionCard.tsx` does not produce this result file.

## Project JSON Boundaries

Only edit `timeline`. Do not hand-edit top-level `aiAnalysis` or `script` while doing video-domain work.

Common editable fields in `timeline.overlays[]`:

- `startMs`, `durationMs`: milliseconds; `startMs >= 0`, `durationMs > 0`.
- `position`: `{ "x": number, "y": number, "width": number, "height": number }` in canvas pixels.
- `motion`: overlay enter/exit/loop animation.
- `textData`: text content, font, color, shadow, stroke, opacity, rotation, and text animation for text overlays.
- `audioData`: volume, fades, trim start, source duration, mute state for audio overlays.

Do not change `id` unless explicitly migrating dependencies; it maps to `ai-cards/<id>/`.

## Animation Values

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

## Subtitle Style

Edit `timeline.subtitle` for global voiceover subtitle styling:

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

Hard constraints:

- No Markdown code fence; the file is raw TSX.
- Export a default React function component.
- Render real JSX; do not return `null`.
- Prefer Remotion frame-driven animation with `useCurrentFrame()`, `useVideoConfig()`, `interpolate`, `spring`, `AbsoluteFill`, and `Sequence`.
- Keep the component pure: no side effects, no external network requests, no timers.

### Images inside a Motion Card

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
