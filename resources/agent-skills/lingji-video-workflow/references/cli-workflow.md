# Lingji CLI 工作参考

CLI 是运行中桌面应用的薄客户端：生成/导入/导出/发布都在应用内执行，CLI 负责触发与轮询，应用窗口同步展示进度。没有独立 headless 渲染。

## 调用与连接

```bash
node "$LINGJI_CLI" <command> [flags]    # $LINGJI_CLI 为空则用 PATH 上的 lingji
```

CLI 自动解析应用控制服务端点（含鉴权 token）：

1. `--server <url>` / `--token <t>` flag。
2. `LINGJI_CONTROL_URL` / `LINGJI_CONTROL_TOKEN` 环境变量。
3. `~/.lingji/control-endpoint.json`（应用运行期间写入，含 url + token）。
4. 默认 `http://127.0.0.1:19820`。

连接失败 = 应用没在运行。请用户启动灵机剪影后重试 CLI；不要改为手搓媒体或让用户手动点导出。

## 项目解析

生成/导出命令的目标项目：`--project <path>` 优先，否则用应用当前活动项目；两者皆无时报 `no_project`——问清目标项目后传 `--project`。

## 命令清单

唯一真源：`node "$LINGJI_CLI" help`。域概览：

- `project` 创建/打开/查询项目；`state` 查项目产物/编辑器/设置/文件。
- `import <url|file> --wait` 导入抖音链接或本地音视频，转录写入 original.md。
- `script read|review` 读稿 / 提交审稿批注（写稿走 file-first）。
- `audio gen` / `subtitle analyze` / `cover gen` / `cards <action>` 生成链路；`run` 一键串行。
- `export` 导出 MP4；`publish` 发布到平台账号；`settings` 查/改默认设置。
- `task status|list|cancel|wait` 任务管理；`edit lock|heartbeat|unlock|status` file-first 锁。

## 异步 fire-and-poll

生成/导出/发布命令启动任务后返回 `taskId`：

- 优先加 `--wait`：CLI 轮询至终态，stderr 输出 `[task] <status> <percent>% <phase>`。
- 手动轮询：`task wait <id>` 或 `task status <id> --json`；前 5 秒每 ~500ms，之后每 ~2s。
- `failed` 时报告 `error.code` / `error.message`；`task cancel <id>` 可中止。
- `import --wait` 轮询导入进度至 `done`/`error`（导入不走 task 体系，有独立 importId）。

## 慢 / 卡诊断

用户反馈慢、卡住、跑很久时，先读 auto-run JSONL 日志再下结论：

- macOS 日志目录：`~/Library/Application Support/灵机剪影/logs/auto-run/`，最新指针 `LATEST.txt`。
- 关键事件：`stage.start/end`、`llm.start/firstChunk/end`、`card.start/end`、`highlight.batch.end`。
- 汇报总耗时、最慢阶段/调用，以及 1-3 条具体下一步。
