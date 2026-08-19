# Director Tool Contract

## `director_get_context`

只读。返回项目身份、字幕 cue、当前草案、已批准方案、用户锁定、素材服务能力和风格设置。素材摘要优先包含完整 `sceneTagCatalog`（标签、计数、视频/图片等类型分布），旧素材服务回退 `topSceneTags`；不返回素材路径、OCR、ASR、代表帧或全部条目明细。恢复运行时先调用它，以磁盘状态而不是会话记忆为准。

## `director_search_materials`

只读。按 `shotKey`、`narrativeNeed` 和中文 query 召回视频或图片候选，默认使用 `kind="any"` 同时检查两种媒介。总导演先从 `sceneTagCatalog` 选择 1-6 个真实 `selectedTags`（旧素材服务回退 `topSceneTags`），再根据本次字幕、镜头实体与关键词、叙事需求生成首选 `query` 与 1-4 个 `relatedQueries`。所选标签和查询必须来自当期上下文，工具不内置行业关键词、同义词映射或语义回退规则，只负责标准化、去重、串行拉取和审计。目录外标签返回 `invalid-input` 和 `unknownTags`，Agent 必须从当期目录重选，程序不会生成替代词。候选稀疏且没有传输错误时继续尝试后续 AI 关联查询，返回 `selectedTags`、`queriesTried`、成功完成的 `kinds`，并在每个候选上返回实际命中的 `query`。先搜来源特定的事实证据，再按当前语义搜索主体、动作、环境和空镜；视频候选弱时补看图片。返回的候选还包含稳定 ID、相关度、类型、时长、画幅和可检视能力。搜索必须逐次串行完成，不得并发堆叠。返回的 `outcome` 为 `candidates | empty | partial | invalid-input | retryable-error | fatal-error`：只有 `empty` 表示请求成功但零命中；`invalid-input` 只表示 AI 选择了目录外标签，修正输入后重试；`partial`、`retryable-error` 和 `fatal-error` 均不得被解释成“素材库没有内容”。相关度只用于召回排序，不是采用门槛：不得因为候选低于固定分数就拒绝检视，也不得因为候选高分就自动采用。搜索记录必须能追溯到它试图证明或呈现的镜头需求，并随工作草案检查点恢复；恢复后不能把旧失败清零成“未搜索”。全片仍选择 Motion 时，必须完成 video+image 双媒介审计，并为 `context`、`transition`、`breath` 镜头分别留下搜材记录；这是搜索完整性要求，不强制采用素材。

## `director_inspect_material`

只读。读取候选的缩略图、代表帧或 contact sheet，并返回可见主体、可用片段与检视失败原因。Agent 只有在工具成功返回视觉证据后才能声称看过素材；无法检视的 required 候选必须 blocked。成功检视后，Agent 按可见内容、媒介角色和非误导边界作出选择，人工或 Agent 明确选择的低分候选可以执行。为控制多模态上下文，每轮只精检 1-2 个粗筛候选。

## `director_initialize_working_draft`

检查点写工具。保存不含 `segments` 的草案头部，包括标题、简介、封面、声音、视觉主张和全片风格，并写入项目内的可恢复工作检查点。重复调用只更新头部并默认保留已写镜头；只有明确重做全片分镜时才使用 `resetSegments=true`。初始化或更新后，既有校验状态立即失效。

## `director_patch_working_segments`

检查点写工具。每批最多写入 8 个完整镜头，按 `key` upsert，同 key 修订不会产生重复项，并立即更新项目内的可恢复工作检查点。重分段遗留镜头必须通过 `deleteKeys` 显式删除。每次修改后继续当前任务，不等待用户逐批批准；既有校验状态立即失效。

## `director_read_working_draft`

只读。按字幕顺序分页返回工作草案镜头，可选在当前页附带草案头部；不会返回完整长片对象。使用 `offset`、`limit` 和返回的 `nextOffset` 完成全片复核。

## `director_validate_working_draft`

只读校验。服务端组合草案头部与全部已缓存镜头，再执行完整导演契约校验。只有当前 `workingVersion` 通过后才能提交；任何头部或镜头修改都要求重新校验。

## `director_submit_working_draft`

唯一持久化写工具。只接收 `expectedRevision`，由服务端重新组合并校验当前工作草案，再使用乐观版本锁原子保存。普通文本、分批保存成功或校验成功都不等于已经提交。

## `director_validate_draft`

短片兼容的只读校验。一次传入完整草案，检查内容与 working draft 校验一致。长片默认不使用，避免反复传输整片对象。

## `director_submit_draft`

短片兼容的持久化写工具。一次传入完整草案并使用上下文返回的 base revision 原子提交；版本冲突时拒绝覆盖，Agent 必须重新读取上下文并在保留用户新修改的前提下重放未锁定决策。提交不批准制作，不得与 working draft 路径混用。

## 失败与恢复

- 工具返回 `retryable-error`：不要立即并发或连续重试，也不要改判 Motion；先继续其它工作，稍后对同一 query 串行重试一次，重复失败则 blocked。
- 工具返回 `partial`：保留已召回候选并优先检视；仍缺关键媒介时再串行补搜失败类型。
- 工具返回 `fatal-error`：保留素材需求并 blocked，记录错误与恢复条件。
- revision 冲突：重新读取上下文，不得用旧草案强写。
- required 素材失效：保留用户选择，blocked；不得静默换素材。
- 校验失败：按 issue 修订后再次校验，不得跳过。
- 进程重启或任务中断：下一轮 context 会恢复同 revision、同字幕、同基准方案的工作检查点；初始化时保留镜头，分页读取后继续。已检视候选会要求当前会话重新看图，不能沿用“看过”的声明。
