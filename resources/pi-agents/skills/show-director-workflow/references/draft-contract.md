# Director Draft Contract

## 全局字段

- `title`: 8-14 个汉字，自然、有观点但不像广告，忠于字幕。
- `summary`: 30-80 字，直接说明本期在讲什么。
- `coverDirection.prompt`: 画面主标题逐字等于 `title`，使用中文引号包裹，除此之外不规划其它画面文字。
- `segments`: 覆盖所有启用的语义镜头；时间来自字幕 cue 映射，Agent 不自由编造毫秒。
- `zeroCompositeReason`: 草案顶层字段。仅在没有可执行的 `agent-composite` 时必填，必须反映逐段双重不可替代检查结果。

草案没有顶层 `audit` 或 `blocked` 清单。无法安全完成的镜头在对应 `segments[]` 项内标记 `strategyStatus="blocked"`，并用 `blockedReason` 写清原因、已尝试动作与恢复条件。

## 镜头字段

每个镜头使用草案字段 `key`、`firstEntryIndex`、`lastEntryIndex` 和 `carrier`。`key` 在本草案内唯一；首尾索引必须直接引用 `director_get_context` 返回的 `entry.index`，连续、无重叠地覆盖字幕。不要提交运行时方案中的 `segmentId`、`startMs`、`endMs` 或 `preferredCarrier`。

镜头还应明确 `title`、`summary`、`semanticType`、`complexityLevel`、`visualizationScore`、`pacingNeed`、`keywords`、`entities`、`enabled`、`purpose`、`intensity`、`renderStrategy`、`strategyReason` 与 `confidence`。`purpose` 只能是 `context`、`explain`、`compare`、`evidence`、`emphasis`、`transition`、`breath` 之一。`visualType`、`composition`、`cameraMove`、`mediaRole` 和 `transition` 按镜头需要填写；使用 footage 时以 `footageQuery` 提供可检索的中文 query。composite 额外要求：

- `compositionIntent`
- `selectedAssets`，每项标记 `required` 或 `optional`，并记录具体采用理由；理由要说明检视画面中的可见主体或动作、对应 `mediaRole` 以及为何不会误导
- `rejectedAssets`，记录检视后淘汰的候选与具体理由
- `mediaIndispensability` 与 `graphicsIndispensability`
- 显式 `fallbackPolicy`
- 候选检视依据，不得只记录搜索分数；分数仅用于排序，不设最低采用分

每个成功检视的候选都必须出现在所属镜头的 `selectedAssets` 或 `rejectedAssets` 中。素材库可用且全片最终均为 `motion-card` 时，至少要有一次可追溯的有效检索；这只证明导演做过媒介比较，不要求最终采用固定数量的素材。

镜头无法执行时在该镜头内使用 `strategyStatus="blocked"` + `blockedReason`；采用退路时在该镜头内使用 `strategyStatus="fallback"` + `fallbackDecision`。不得创建顶层 blocked 清单，也不得把失败后的实际策略伪装成原导演决策。

## 用户锁定

上下文中标记为 locked 或 modifiedByUser 的内容不可覆盖：

- 标题、简介或封面方向
- 镜头开关、媒介和执行策略
- 选择的素材、裁剪点与 required/optional 用途
- 人工编辑过的镜头文案和制作结果

重新编排时复制锁定值，只对未锁定项重新决策。锁定素材文件失效、锁定字段互相冲突或锁定策略违反硬真实性规则时，保留原值并标记 blocked，等待用户处理。

## 提交条件

长片草案必须先通过 `director_validate_working_draft`，并在未继续修改的情况下调用 `director_submit_working_draft`。完整 draft 的 `director_validate_draft` / `director_submit_draft` 仅用于极短草案兼容路径。Agent 应修正全部 error；对保留的 warning 提供具体理由。提交只保存待审草案，不得批准、生成卡片、出封面图、生成声音或改时间线。
