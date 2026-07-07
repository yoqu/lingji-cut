---
name: lingji-video-workflow
version: 3
description: >-
  用于灵机剪影/Lingji 视频制作协作：创建或打开灵机项目，导入媒体素材，整理
  original.md、撰写 script.md，通过内置 `lingji` CLI 驱动桌面应用完成 TTS、
  字幕分析、封面、内容卡片、导出 MP4 和平台发布，并以 file-first 方式编辑
  project.json 时间轴、字幕与 ai-cards 下的 Motion Card TSX。触发场景：从稿件
  到视频、一键成片、改稿重生成、调整卡片/字幕/动画、导出、发布到抖音/B站等平台。
---

# 灵机剪影视频工作流

把稿件或素材变成灵机剪影视频并持续精修。只有两类工作机制，按场景选择，不要发明第三条路径：

1. **生成 / 导入 / 导出 / 发布 → `lingji` CLI。** 项目创建、媒体导入、TTS、字幕分析、封面、卡片、MP4 导出、平台发布都由 CLI 驱动正在运行的桌面应用完成，应用内进度条与时间轴实时刷新。
2. **文本 / 时间轴 / 卡片源码 → file-first 编辑。** `original.md`、`script.md`、`project.json` 的 timeline，以及 `ai-cards/<overlayId>/motionCard.tsx` 直接改磁盘文件，应用监听变化并热重载。编辑前后走锁协议（见对应 reference）。

**禁手搓产物**：`podcast-audio.*`、`podcast-subtitles*.srt`、`covers/`、`ai-cards/<id>/image.png`、MP4 只能由生成链路产出。只有 CLI 返回成功或确认输出文件存在，才能宣称完成。不要把 API key / token 写入项目文件。

## 调用 CLI

```bash
node "$LINGJI_CLI" <command> [flags]    # $LINGJI_CLI 为空则回退 PATH 上的 lingji
```

连接失败说明应用未运行，请用户先启动灵机剪影。命令清单唯一真源是 `node "$LINGJI_CLI" help`；生成/导出类命令默认作用于应用当前活动项目（跨项目才传 `--project`），加 `--wait` 轮询到终态，`--json` 输出机器可读结果。

## 工作流骨架

1. `project current` 确认项目；没有则 `project create <path>` 或 `project open <path>`。
2. 素材是抖音链接/本地音视频时：`import <url|file> --wait`（转录写入 original.md）。
3. 整理 `original.md`、撰写 `script.md`（file-first，见 `script-editing.md`）。
4. 生成：`run --wait`（一键 音频→分析→封面），或分步 `audio gen` / `subtitle analyze` / `cover gen`。
5. 精修：改时间轴/字幕/Motion Card 走 file-first（`video-editing.md`）；改卡片结构/重生成看 `content-cards.md`；改稿后重跑 `audio gen` + `subtitle analyze`。
6. 导出：`export --wait [--out <file>]`，报告输出路径。
7. 发布（可选）：`publish accounts` 查账号 → `publish run --file <mp4> --title ... --to <账号>`（见 `publishing.md`）。
8. 汇报：项目路径、执行的命令、产物与遗留修改。慢/卡时先读 auto-run 日志（`cli-workflow.md`）。

## 按需读取参考

- `references/cli-workflow.md`：连接与端点、项目解析、异步轮询、导入、慢任务诊断。
- `references/script-editing.md`：编辑 `original.md` / `script.md` 前读。
- `references/video-editing.md`：编辑 `project.json` 时间轴、字幕样式、Motion Card TSX 前读（含锁协议与结果协议）。
- `references/content-cards.md`：生成、检查、修复 AI 内容卡片前读。
- `references/publishing.md`：发布到平台账号前读。
