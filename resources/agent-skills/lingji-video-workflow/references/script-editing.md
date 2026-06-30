# 脚本编辑参考

直接编辑灵机项目的 `original.md` 或 `script.md` 前读取本文件。

## 范围

Editable files:

- `<projectDir>/original.md`: raw source material.
- `<projectDir>/script.md`: final voiceover script used for TTS/subtitles.

Do not edit video timeline, cards, audio, subtitles, covers, or rendered media in this mode.

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

## Save Behavior

- Saving `script.md` externally reloads the script workspace and creates a version history entry with source `external`.
- Saving `original.md` externally reloads the corresponding workspace tab.
- If audio/subtitles should reflect a changed script, rerun generation via the CLI: `node "$LINGJI_CLI" audio gen --wait` then `node "$LINGJI_CLI" subtitle analyze --wait` (see `cli-workflow.md`).

## Direct Edit Steps

1. Confirm `<projectDir>` contains the Lingji project files.
2. 执行 `lingji edit lock --scope script`。
3. Read the target Markdown file.
4. Apply the requested rewrite or polish.
5. Write the complete updated Markdown file.
6. 执行 `lingji edit unlock`。
7. Report that downstream generated artifacts may need regeneration.
