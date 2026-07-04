---
name: lingji-video-workflow
version: 2
description: >-
  用于灵机剪影/Lingji 视频制作协作：从稿件、素材目录或已有项目开始，打开或创建
  灵机项目，整理 original.md，撰写或修改 script.md，通过内置 `lingji` CLI 驱动
  桌面应用完成 TTS、字幕分析、封面、内容卡片和导出，并以 file-first 方式编辑
  project.json 时间轴、字幕、覆盖层或 ai-cards 下的 Motion Card TSX。触发场景包括：
  从稿件到视频、灵机剪影项目处理、改稿生成视频、导出视频/MP4、调整视频卡片/
  字幕/动画，或继续处理某个 Lingji project workflow。
---

# 灵机剪影稿件到视频工作流

## 总览

这个 skill 用来把稿件或素材目录变成一条灵机剪影视频，并继续做精修。只有两类工作机制：按场景选择正确机制，不要发明第三条路径。

1. **生成 / 导出 → 使用 `lingji` CLI。** 音频 TTS、字幕分析、封面、卡片、动效生成和 MP4 导出都在正在运行的灵机剪影桌面应用里执行。通过内置 CLI 触发这些动作，CLI 会连接实时应用窗口，应用内进度条和时间轴会刷新。这不依赖当前 agent 会话是否注册了 MCP 工具；不要要求用户手动点击这些步骤。（媒体导入暂时没有 CLI 命令，见 `cli-workflow.md`。）
2. **已有文本 / 时间轴文件 → file-first 编辑。** `original.md`、`script.md`、`project.json` 的 timeline/overlays，以及 `ai-cards/<id>/motionCard.tsx` 直接在磁盘上编辑；应用会监听文件变化并热重载。

只有 CLI 返回成功，或你确实确认了输出文件存在，才能说生成/导出已完成。不要手写伪造生成媒体（音频、字幕、封面图、MP4）；这些只能由 CLI 或应用内生成链路产出。

## `lingji` CLI

通过注入的入口路径调用，开发环境和打包环境都可用：

```bash
node "$LINGJI_CLI" <command> [flags]
```

如果 `$LINGJI_CLI` 为空，回退到 PATH 上的 `lingji` 命令：`lingji <command>`。如果两者都不可用，通常说明灵机剪影应用没有运行；请让用户先启动应用再重试。（CLI 通过本地 endpoint 连接运行中的应用，应用关闭时没有 endpoint。）

**项目定位：** 生成/导出命令不传 `--project` 时，默认作用于应用当前打开的 active project。只有需要操作另一个项目时，才传 `--project <path>`。

**常用命令：**

| 目标 | 命令 |
| --- | --- |
| 查看应用当前项目 | `node "$LINGJI_CLI" project current` |
| 列出最近项目 | `node "$LINGJI_CLI" project list` |
| 打开 / 校验项目 | `node "$LINGJI_CLI" project open <path>` |
| Generate口播音频 (TTS) | `node "$LINGJI_CLI" audio gen --wait` |
| 字幕分析 + 内容卡片 | `node "$LINGJI_CLI" subtitle analyze --wait` |
| 封面（提示词 / 图片 / 全流程） | `node "$LINGJI_CLI" cover gen --wait` |
| 卡片（list/show/update/regenerate/sculpt/regen-media/convert/delete） | `node "$LINGJI_CLI" cards <action> [<cardId>] [--to <type>] [--notes <要求>] [--wait]` |
| **导出 MP4** | `node "$LINGJI_CLI" export --wait [--out <file>]` |
| 任务状态 / 等待 / 取消 | `node "$LINGJI_CLI" task status\|wait\|cancel <taskId>` |

任意命令都可加 `--json` 获取机器可读输出。`--wait` 会轮询异步任务直到终态，并把 `[task] <status> <percent>% <phase>` 输出到 stderr。

完整执行“稿件 → 视频”前，先读 `references/cli-workflow.md`，了解连接细节、异步任务 fire-and-poll 模式和导入边界。

## 按需读取参考

只读取当前步骤真正需要的参考文件：

- `references/cli-workflow.md`：连接应用、解析项目、CLI 命令集、异步轮询、媒体导入边界。
- `references/script-editing.md`：直接编辑 `original.md` 或 `script.md` 前读取。
- `references/video-editing.md`：直接编辑 `project.json`、字幕、覆盖层或 Motion Card TSX 前读取。
- `references/content-cards.md`：总结、生成、检查或修复 AI 内容卡片，以及处理 `aiAnalysis` / timeline overlay 集成前读取。

## 工作流

1. **确认来源和目标。** 来源可以是稿件、素材目录、音视频文件、URL，或已有灵机项目。先运行 `node "$LINGJI_CLI" project current` 查看应用当前打开的项目。若当前没有项目，先在应用里打开/创建项目（或请用户处理），再重新检查。

2. **准备稿件。** 把原始素材整理到 `original.md`；把最终口播稿写入或改写到 `script.md`（file-first，见 `script-editing.md`）。

3. **通过 CLI 运行生成链路**，按顺序执行，每步加 `--wait`：
   - `audio gen` → `subtitle analyze` → `cover gen`，必要时再执行 `cards ...`。
   - 轮询到终态；失败时报告 CLI 的 `error.code` / `error.message`。

4. **精修结果。** 调整 timing、placement、字幕样式、overlay motion 或 Motion Card 动画时，按 file-first 方式编辑 `project.json` / `motionCard.tsx`（见 `video-editing.md`）。处理内容卡片结构、卡片产物或重生成策略时，先加载 `content-cards.md`。稿件问题则先改 `script.md`，再重跑 `audio gen` / `subtitle analyze`。

5. **导出。** 运行 `node "$LINGJI_CLI" export --wait`，可选 `--out <file>`。完成后报告输出路径。

6. **验证并汇报。** 汇报项目路径、执行过的命令、导出产物和仍保留的 file-first 修改。若用户反馈慢、卡住或跑很久，先读最新 auto-run JSONL 日志再诊断（见 `cli-workflow.md`）。

## File-First 安全规则

直接编辑灵机项目磁盘文件时：

- 写入前先执行 `node "$LINGJI_CLI" edit lock --project <projectDir> --scope script|video --reason "<说明>" --json`，让应用锁定内容操作界面。
- 编辑超过约 60 秒时执行 `node "$LINGJI_CLI" edit heartbeat --project <projectDir> --json`。
- 完成后执行 `node "$LINGJI_CLI" edit unlock --project <projectDir> --json`，即使后续步骤失败也要清理锁。
- 写入 `project.json` 后读取 `.lingji/edit-result.json`，若不是 `ok:true`，按错误修复后再检查。

## 边界

- 生成/导出只走 `lingji` CLI（不要依赖 MCP 工具，也不要让用户手动点）。文本/时间轴/源码文件走 file-first。导入仍在应用内完成（暂时没有 CLI 命令）。
- 不要手写生成媒体：`podcast-audio.*`、`podcast-subtitles*.srt`、`covers/`、`ai-cards/<id>/image.png`、MP4。
- 不要把 API key、token 或 provider secrets 写入项目文件或 telemetry。
- 视频域编辑时，不要修改 `project.json` 里的 `aiAnalysis` 或 `script` 字段，除非当前任务明确就是处理这些结构。
- 不要改 overlay `id`，除非用户明确要求迁移，并且你同步更新所有依赖路径。
