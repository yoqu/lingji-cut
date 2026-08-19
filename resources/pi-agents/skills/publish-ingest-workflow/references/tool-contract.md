# 发布识别工具契约

只使用下列工具。不要调用 bash、write、edit 或任何上传、出图工具。

| 工具 | 作用 |
|---|---|
| `publish_get_context` | 程序扫描结果、文本摘录、已有草稿、已登录平台。必须先调用。 |
| `publish_read_text` | 读取被截断的 md/txt/json/srt。摘录已够用时不要调用。 |
| `publish_generate_metadata` | 用摘录生成标题/简介/标签。 |
| `publish_generate_cover_prompt` | 仅当 `skipCoverPrompt=false` 时调用。失败可忽略，不阻断提交。 |
| `publish_recommend_partition` | 按标题简介推荐 B站 tid。 |
| `publish_validate_draft` | 提交前必须通过。 |
| `publish_submit_draft` | 只提交文案；成片和封面由程序填入。 |

成片和封面不会让你挑选，也不要把文件标成成片或封面。
生成类工具会真实调用模型，只在缺料时使用。
