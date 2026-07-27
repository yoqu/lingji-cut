# 卡片分类统一 + AICardInspector 重构设计

日期：2026-07-27

## 背景

卡片文字内容分类（`AICardType`：summary/data/insight/chapter/quote）与动效系统载体分类（`StoryboardCarrier`：14 种）并行维护。前者已名存实亡——新生成的 motion 卡一律被 `ai-analysis.ts` 强制写成 `type: 'motion'`，Inspector 的类型 pill 行是僵尸 UI。同时 Inspector 分镜区把同一份 JSON 渲染两遍（raw textarea + 结构化编辑器），Carrier 14 个英文 pill 强制单行溢出。

## 目标

1. 语义分类唯一真源 = `StoryboardCarrier`；`AICardType` 仅保留渲染形态。
2. Inspector 分镜区以结构化编辑器为唯一主视图，布局清晰、中文标签。

## 数据层

- `AICardType` 缩为 `'motion' | 'image' | 'video'`。
- 迁移：`ai-persistence` 清洗时将存量 `summary/data/insight/chapter/quote` 映射为 `'motion'`；核实无 `motionCard` 旧卡的渲染分支，必要时用 `motion-card-fallback` 补 fallback storyboard。
- 新增 carrier 元数据映射（中文 label + description，从 `demo-cards.ts` 收编），与 `STORYBOARD_CARRIERS` 同源；`motion-bible`、`DirectorPlanEditor`、`demo-cards` 的硬编码副本改为派生（`DirectorPlanEditor` 的 `'image'` 作为显式额外项）。
- 删除零引用死代码 `MotionTemplateKey`。
- 手动建卡（`SubtitleCardDialog` / `manual-card-types`）改为选 carrier，产出带初始 storyboard 的 motion 卡。
- `DEFAULT_CARD_STYLE`、卡片列表徽标按新 3 类收缩；语义标签显示 carrier 中文名。
- 提示词模板不动（无版本 bump）。

## Inspector UI

自上而下：

1. **内容**：标题 / 内容 / 追加提示词 / 卡片风格 pill。类型 pill 行删除。
2. **分镜**（结构化主视图）：
   - 头部：生成分镜 + 回退上一版
   - 载体下拉 Select（中文+英文值）；强调 4 项 pill；Focus 数字
   - Claim 输入框、Scene 文本域
   - 节拍列表改良网格（序号/角色/cue/描述/删），列宽自适应
   - 校验错误/警告
   - 折叠区「JSON 源码」：raw textarea 收入，调试用
3. 展示设置 / 外部资产 / Motion 状态区维持现状。

## 不做

- emphasis 双命名（`settle`/`countup-settle`）合并——运行时翻译是存量兼容层，不碰。

## 验证

- 迁移单测（旧 type 卡加载）。
- `card-style` / `motion-demo-cards` / storyboard 相关测试同步。
- `npx vitest run` 相关文件 + `npm run build`。
