# 灵机剪影 · 文件契约（file-first 编辑）

本目录是一套**与 agent 无关**的文件契约。任何能读写本地文件的 AI agent（Claude Code / Codex / Gemini 等）都可以照此**直接读写项目目录里的文件**来修改视频与文稿，无需调用任何应用内工具接口。

## 这是什么

灵机剪影是一个本地优先的 Electron 桌面创作工具。当用户在 App 中打开一个项目时，编辑器装有**热重载钩子**：

- 你对项目文件（`project.json`、`script.md`、`ai-cards/<overlayId>/motionCard.tsx` 等）的外部修改，会被编辑器监听到并**实时灌回 UI / 预览**。
- 你不需要操作运行中的 App，只需按本契约改文件，改完编辑器自己刷新。

两个能力域，各看一份契约：

| 能力域 | 改什么文件 | 契约文档 |
| --- | --- | --- |
| 视频 / 时间线 / 卡片 | `project.json`（timeline 段）+ `ai-cards/<overlayId>/motionCard.tsx` | [video-editing.md](./video-editing.md) |
| 文稿 | `script.md` / `original.md` | [script-editing.md](./script-editing.md) |

## 项目目录结构

项目目录（下文记作 `<projectDir>`）的关键文件：

```text
<projectDir>/
  project.json                       # 主工程文件：timeline / aiAnalysis / script 三段
  original.md                        # 原始素材（文稿域）
  script.md                          # 口播成稿（文稿域）
  podcast-audio.mp3                  # 口播音频（产物，勿手改）
  podcast-subtitles.srt              # 口播字幕（产物，勿手改）
  podcast-subtitles.original.srt     # 字幕原始版（产物，勿手改）
  covers/                            # 封面候选图（产物，勿手改）
  ai-cards/
    <overlayId>/
      motionCard.tsx                 # Motion Card 源码（视频域可改的独立文件）
      image.png                      # 图片卡产物（勿手改）
  configs/prompts/                   # 项目级提示词覆盖（与本契约无关）
  .lingji/
    edit-lock.json                   # 你写入的会话锁（编辑前创建，编辑后删除）
    edit-result.json                 # 编辑器写回的校验结果（你只读）
```

> `<overlayId>` 就是 `project.json` 里 `timeline.overlays[].id`。

## 会话锁协议（必须遵守）

锁的作用：锁定期间编辑器会**暂停自动保存**、状态栏显示「AI 正在编辑」，从而避免编辑器内存态把你写的文件改动覆盖掉。

**1. 编辑前：写锁。** 编辑任何项目文件前，先在 `<projectDir>/.lingji/edit-lock.json` 写入：

```json
{
  "owner": "codex",
  "scope": "video",
  "startedAt": 1718260000000,
  "heartbeat": 1718260000000,
  "ttlMs": 30000
}
```

字段（全部必填，类型必须精确，否则锁被判为无效）：

- `owner`（string）：你的标识，如 `"codex"` / `"claude-code"` / `"gemini"`。
- `scope`（string）：`"video"` 或 `"script"`，取决于你这次改哪个域。
- `startedAt`（number）：开始时刻，epoch 毫秒。
- `heartbeat`（number）：最近心跳时刻，epoch 毫秒。初次等于 `startedAt`。
- `ttlMs`（number）：锁存活窗口，毫秒。默认 `30000`。

**2. 编辑中：维持心跳。** 若编辑过程超过约 15s，定期把 `heartbeat` 更新为当前 epoch 毫秒重写该文件。规则是：编辑器把「`now - heartbeat > ttlMs`」判定为遗忘锁并**自动解锁**。只要你还在编辑，就保证心跳间隔小于 `ttlMs`（默认 30s，建议 ~10s 续一次）。

**3. 编辑后：删锁。** 编辑完成后**删除** `<projectDir>/.lingji/edit-lock.json`。

## 结果协议（改完自查）

每次你写完 `project.json`，编辑器会对它做校验并把结果写到 `<projectDir>/.lingji/edit-result.json`，结构：

```json
{
  "ok": true,
  "at": "2026-06-13T08:00:00.000Z",
  "errors": []
}
```

- `ok`（boolean）：`true` 表示改动通过校验、已被接受并热重载到预览；`false` 表示有校验错误，**脏数据不会被应用**。
- `at`（string）：ISO 时间戳，用于判断这是不是本次的最新结果。
- `errors`（array）：每项 `{ "field": string, "message": string }`，`field` 形如 `overlays[2].startMs`，`message` 是中文原因。

改完 `project.json` 后读 `edit-result.json`：若 `ok:false`，按 `errors[].field` / `errors[].message` 定位并修复，然后**重写文件再读一次**，直到 `ok:true`。

这是 agent 无关的反馈通道，**不需要调用任何应用内工具接口**。（注：`script.md` / `original.md` 是纯 Markdown，不走这套 JSON 校验。）

## 边界（铁律）

- **只做纯编辑**：编辑「已有数据」。
- **不要触发重新生成**：封面、卡片配图、TTS 配音、AI 文/图/视频生成都不在本契约内。需要这些请使用 `lingji` CLI（`audio gen` / `subtitle analyze` / `cover gen` / `export` 等），或让用户在 App 内操作。
- **不要触发重新导出 MP4**：导出请让用户在 App 内执行。
- **不要碰产物文件**：`podcast-audio.mp3`、`podcast-subtitles*.srt`、`covers/`、`ai-cards/<id>/image.png` 等是生成产物，手改会被下一次生成覆盖且可能与 `project.json` 失配。
- **视频域**：只改 [video-editing.md](./video-editing.md) 列出的字段。
- **文稿域**：只改 `script.md` / `original.md`，不要顺手改 timeline / 卡片。
