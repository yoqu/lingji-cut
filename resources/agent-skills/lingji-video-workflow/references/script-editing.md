# 脚本编辑参考

直接编辑灵机项目的 `original.md` 或 `script.md` 前读取本文件。

## 范围

可编辑文件：

- `<projectDir>/original.md`：原始素材。
- `<projectDir>/script.md`：用于 TTS/字幕的最终口播稿。

此模式下不要动时间轴、卡片、音频、字幕、封面或渲染产物。

## CLI 锁定协议

写入 Markdown 前不要手写 `.lingji/edit-lock.json`。先通过 CLI 请求应用锁定脚本界面：

```bash
node "$LINGJI_CLI" edit lock --project <projectDir> --scope script --reason "AI 正在编辑脚本文稿" --json
```

如果编辑超过约 60 秒，刷新心跳：

```bash
node "$LINGJI_CLI" edit heartbeat --project <projectDir> --json
```

完成、失败或中断前都要解除锁定：

```bash
node "$LINGJI_CLI" edit unlock --project <projectDir> --json
```

脚本编辑不产生 `.lingji/edit-result.json`。`.lingji/edit-lock.json` 只是应用写出的兼容信号，不再由 agent 直接维护。

## 保存行为

- 外部保存 `script.md` 会重载脚本工作台，并创建一条来源为 `external` 的版本历史。
- 外部保存 `original.md` 会重载对应工作台标签页。
- 改稿后要让音频/字幕跟上：`node "$LINGJI_CLI" audio gen --wait`，再 `node "$LINGJI_CLI" subtitle analyze --wait`（见 `cli-workflow.md`）。

## 直接编辑步骤

1. 确认 `<projectDir>` 是灵机项目目录。
2. 执行 `lingji edit lock --scope script`。
3. 读取目标 Markdown 文件。
4. 完成改写或润色。
5. 写回完整更新后的文件。
6. 执行 `lingji edit unlock`。
7. 提示下游生成产物（音频/字幕等）可能需要重跑。
