# 发布草案契约

`publish_validate_draft` 与 `publish_submit_draft` 接受同一份草案。

你只需要提交文案：

- `title`：非空标题
- 可选：`desc`、`tags`、`coverPrompt`、`bilibiliTid`、`notes`（给用户看的一句识别说明）

不要提交 `filePath` 或 `covers`。成片和封面由程序按体积、时长、像素比例选定并在校验时填入。

校验只检查成片是否存在、标题非空、若有封面则文件存在。不检查文件名模式。

提交后写入 `{workDir}/.lingji/publish.json`，等待用户核对。这不是发布成功。
