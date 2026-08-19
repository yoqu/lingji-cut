---
name: show-director-workflow
description: 驱动 Pi 全片总导演自主读取项目、检索检视素材、制定综合镜头策略、校验并提交导演草案
version: 8
---
# Show Director Workflow

本 skill 用于全片导演规划，不用于批准制作或直接生成 Remotion 画面。导演 Agent 必须通过受控工具导航项目，不能把“生成一次结构化 JSON”当作完整工作流。

## 执行顺序

1. 调用 `director_get_context`，读取字幕 cue、当前草案、已批准方案、用户锁定、风格和素材服务能力。
2. 通看整片，先建立“观点、证据、解释”关系图。跨相邻 cue 扫描证据与解释是否需要合成同一个连续视觉论证，再确定语义镜头；不要把初始 cue 当成不可改变的最终分段。
3. 在大批量检索或展开整片镜头前建立工作草案检查点；如何交替分镜、检索和检视由总导演依据当前片子自主决定，不设置固定的第二、第三个工具动作。尚待搜材的镜头可暂时 blocked，后续按原 key 更新。若 context 已恢复包含镜头的 `workingDraftCheckpoint`，初始化时保留镜头并先分页读取现状，不得从头重做。不得在任何草案状态都没有时连续批量搜索。
4. 对 footage 候选执行“完整标签选词 -> AI 实时关联 -> 归因搜索 -> 粗筛 -> 精检”：每次搜索写明 `shotKey` 与 `narrativeNeed`，默认 `kind="any"` 同时搜索视频与图片。总导演优先通读 `materialLibrary.sceneTagCatalog`，从完整真实标签目录选择 1-6 个 `selectedTags`；旧素材服务缺少该字段时回退 `topSceneTags`。再根据本次字幕、镜头 `keywords/entities` 和叙事需求即时生成首选 `query` 与 1-4 个 `relatedQueries`，不得编造目录外标签或依赖代码词典、固定行业同义词、跨项目查询模板。上下文只提供标签聚合统计，不一次性注入素材路径、OCR、ASR、代表帧或全部条目明细。工具只做标准化、去重、串行拉取与审计，在候选不足且没有传输错误时继续下一条 AI 关联查询，并返回 `selectedTags`、`queriesTried`、`kinds` 及候选实际命中的 query。先搜来源特定的事实证据，再按当前语义搜索主体、动作、环境或空镜；视频候选弱时必须补看图片。`director_inspect_material` 才提供采用依据。低分候选经成功检视后仍可采用；采用理由必须写清可见内容、媒介角色和非误导边界。每轮精检 1-2 个候选，检视失败不能伪装成已看过；每个已检视候选都要在所属镜头记录采用或淘汰结论。素材库可用但最终全片选择 Motion 时，必须完成 video+image 双媒介审计，并逐个搜索 `context`、`transition`、`breath` 镜头的可用空镜；这不构成素材数量或占比配额。
5. 按 [Agent Composite 策略](references/agent-composite-strategy.md)做双重不可替代判定，并完成全片节奏复核。
6. 按 [导演草案契约](references/draft-contract.md)生成标题、简介、封面方向、镜头决策、fallback 与 blocked 信息，同时保留所有用户锁定。
7. 用 `director_patch_working_segments` 每批最多 8 个镜头持续写入或更新；不要等待用户逐批批准，也不要在一次参数中传输整片草案。
8. 用 `director_read_working_draft` 分页复核全片。按 key 修订镜头，重分段时通过 `deleteKeys` 清理旧镜头；修改后继续工作，不向用户提问。
9. 调用 `director_validate_working_draft`，根据机器返回的问题自主修订；修改会使校验失效，重新通过后才调用 `director_submit_working_draft`。完整 draft 的校验/提交工具只用于极短草案兼容路径。
10. 提交后向用户简短反馈关键判断。草案仍需用户批准，Agent 不得自行进入制作阶段。

## 工具使用

工具的输入、输出和副作用边界见 [工具契约](references/tool-contract.md)。不得使用 bash/curl 绕过工具层，也不得把 MCP 地址、token、绝对路径或素材指纹写进提示词和最终回复。

## 示例

- [具备双重不可替代的组合镜头](examples/agent-composite-shot.json)
- [整片零组合镜头审计](examples/zero-composite-audit.json)

示例只说明决策语义，不是数量模板。不要为了贴合示例强行安排素材或 composite，也不要设置素材占比、连续段数或首尾禁用规则。
