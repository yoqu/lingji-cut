# Lingji CLI Workflow Reference

Drive the running Lingji desktop app from the shell. Generation/export/import happen inside the app; the CLI is a thin client that connects to it and triggers/poll tasks. The result animates in the app window (bottom progress bar, refreshed timeline/cards) — there is no headless rendering here.

## Invocation

```bash
node "$LINGJI_CLI" <command> [flags]
```

`$LINGJI_CLI` is injected by the app and points at the bundled CLI entry (`dist-cli/lingji.mjs`). If it is empty, fall back to `lingji <command>` (the CLI on PATH).

## Connection

The CLI resolves the app's local MCP endpoint automatically, in this order:

1. `--server <url>` flag.
2. `LINGJI_MCP_URL` env var.
3. `~/.lingji/mcp-endpoint.json` (written by the app while it runs).
4. Default `http://127.0.0.1:19820/mcp`.

If connecting fails, the Lingji app is not running (or no project context). Ask the user to launch 灵机剪影 and open the project, then retry. Do **not** fall back to hand-writing media or telling the user to click Export manually — retry the CLI once the app is up.

## Project Resolution

Generation/export commands resolve the target project as:

1. `--project <path>` if given.
2. Otherwise the app's **current active project** (`project current`).
3. If neither exists, the CLI errors `no_project` — ask which project, then pass `--project`.

So to act on whatever the user has open in the app, just omit `--project`.

## Command Set

```
project current                       app's active project
project list                          recent projects
project open <path>                   validate / show project state
audio gen [--project <p>] [--wait]    口播音频 (TTS) → podcast-audio + subtitles
subtitle analyze [--wait]             语义分段 + 卡片 + 封面提示词 → aiAnalysis
cover prompt|image|gen [--wait]       封面提示词 / 出图 / 一次性
cards gen|list|show|update|regenerate|sculpt|regen-media|convert|delete [<cardId>] [--to <type>] [--notes <要求>] [--wait]
export [--out <file>] [--wait]        渲染 H.264 MP4
task status|list|cancel|wait <id>     任务管理
```

Global flags: `--json` (machine-readable), `--server <url>` (override endpoint).

## Async Fire-And-Poll

Generation/export are async: they start a task and return a `taskId`.

- Prefer `--wait`: the CLI polls to terminal status and streams `[task] <status> <percent>% <phase>` to stderr.
- Without `--wait`, capture the `taskId` and poll yourself: `task wait <id>` (or `task status <id>` with `--json`).
- On `failed`, report `error.code`, `error.message`, and whether it is retryable.
- To stop: `task cancel <id>`.

Polling cadence (when polling manually): every ~500 ms for the first 5 s, then every ~2 s.

## Full Manuscript-To-Video Route

1. `project current` (or `project open <path>` / ask the user to open it in the app).
2. Put source material into `original.md`; draft/revise `script.md` (file-first — see `script-editing.md`).
3. `audio gen --wait`
4. `subtitle analyze --wait` (cards are produced together with analysis).
5. `cover gen --wait` (and `cards ...` refinements as needed).
6. File-first edits for timeline, subtitles, card timing/placement, Motion Card animation (see `video-editing.md`).
7. `export --wait [--out <file>]`.
8. Verify the MP4 exists and report the path plus any remaining file-first edits.

## Media Import

The CLI does not expose an `import` command yet. If the user needs to import a Douyin/local video or audio as source material, ask them to use the app's import entry (Welcome → 抖音导入 / 素材导入), then resume from the generated `original.md` and project files. Do not hand-fabricate imported media.

## Slow Or Stuck Runs

If the user says it is slow/stuck/long-running, inspect the auto-run JSONL logs before diagnosing:

- macOS log dir: `~/Library/Application Support/灵机剪影/logs/auto-run/`
- Latest run pointer: `LATEST.txt`
- Main event kinds: `stage.start`, `stage.end`, `llm.start`, `llm.firstChunk`, `llm.end`, `card.start`, `card.end`, `highlight.batch.end`

Report total runtime, slowest stages/calls, and one to three concrete next actions.
