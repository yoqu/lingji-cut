# Motion 卡片「内容堆叠重叠」优化方案(A 提示词 + B 校验)

## 根因回顾
"叠在一起"是三层叠加:① `CardStage` 内容盒是 `flex column + justifyContent:center` 且无 `flexShrink/overflow` 兜底,子内容超 `0.72H` 时上下对称溢出被外层 `overflow:hidden` 裁切;② 所有原语用固定 `H*` 倍数定高不收缩,`ListBuild` 5 项就占 `0.53H`;③ 提示词只约束"单条 ≤14 字",无"一张卡能装多少元素"的容量预算;④ smoke-render 对 flex 居中对称溢出有漏检(`text-clipped` 阈值 + `possible-occlusion` 只看 `position!=='static'`)。

---

## 方案 A:提示词加「信息容量预算」(改 `src/lib/prompts/defaults.ts`)

### A1. `cards.animation`(line 179 硬约束块)新增「容量预算」条目
在现有硬约束里追加(给导演可计算的心智模型):

```
- 容量预算（决定一张卡会不会挤爆，渲染期会校验累计高度）：
  内容盒可用高度约 0.72H（≈778px，底部 20% 是字幕安全区）。各载体满载估算高度：
  data-hero ≈0.40H｜comparison ≈0.20H｜trend ≈0.20H｜list-build 每条 ≈0.12H
  ｜process 每步 ≈0.10H｜quote 单行 ≈0.18H/两行 ≈0.33H｜concept ≈0.40H
  ｜timeline 5 项 ≈0.30H｜matrix/funnel/network/before-after/stacked ≈0.42H
  由此反推上限（硬性，违反打回）：
  - list-build ≤4 条；process ≤4 步；timeline ≤4 项；quote 金句 ≤2 行。
  - 一张卡最多 1 个主原语 + 1 个辅助（kicker/标题），禁止「标题+数字+列表+说明」四件套。
  - 所有 beats 累计上屏元素的估算总高不得超过 0.72H。
  - 装不下时优先拆成两张卡或把次要 adds 降级为 hold（不上屏、仅口播），绝不堆在一张里。
```

### A2. `cards.segment`(line 128 实现要领第 6 条)扩展布局容量约束
把第 6 条"字大字少"扩为含容量约束:

```
6. 字大字少、大量留白、严守容量：每行上屏文字 ≤ 14 个汉字，口播整句绝不上屏；
   正文字号 ≥ H*0.026，内容放不下就删文案而不是缩字号或往下挤。
   CardStage 内容区是 flex 垂直居中、可用 0.72H（底部 20% 字幕区）：
   - 一张卡最多 1 个主原语 + 1 个辅助（标题/kicker），禁止再叠加第二个图表/列表。
   - 原语参数自觉限项：ListBuild/BarChart items≤4、ProcessFlow steps≤4、TimelineRail items≤4。
   - 若分镜 beats 累计元素明显超容量（≥3 个原语 / list≥5 条），主动回退为「标题+单焦点元素」，
     把多余信息让给口播，并在 productionReport 注明「已按容量预算删减 N 项」。
   横向用满 CW（=0.8×W；写 W 全宽必溢出判失败），焦点在安全区内垂直居中（CardStage 已处理）。
```

### A3. bump prompt version
`cards.segment` v20 → v21,`cards.animation` v5 → v6(项目惯例:改内容 bump version)。

---

## 方案 B:校验层补「内容盒溢出」检测(改 `electron/remotion/smoke-render.ts` + `src/remotion/motion-kit/index.tsx`)

### B1. CardStage 内容盒加标记(`motion-kit/index.tsx:497`)
内容盒 div 加 `data-role="cardstage-content"`(纯标记,零渲染影响):
```tsx
<div style={{ ...flex column... }} data-role="cardstage-content">
```

### B2. LayoutProbe 捕获 data-role(`smoke-render.ts:262-287` + 329-417)
- `LayoutProbe` 接口加 `role?: string` 字段。
- `inspectRenderedLayout` 的 `page.evaluate` 里读 `(el as HTMLElement).dataset.role`,写入 probe。

### B3. 内容盒累计高度检测(`smoke-render.ts` inspectLayoutRisks,522 循环内)
新增 error 级检测(主防线)。对 `role === 'cardstage-content'` 的节点:
```ts
if (node.role === 'cardstage-content' && node.clientHeight > 0 &&
    node.scrollHeight > node.clientHeight + 1) {  // 1px 容差;scrollHeight 不受镜头 transform 影响
  pushCappedIssue({
    severity: 'error',
    code: 'content-box-overflow',
    message: `内容区元素累计高度 ${Math.round(node.scrollHeight)}px 超过可用 ${Math.round(node.clientHeight)}px（0.72H），会被居中裁切--必须删减元素/缩短文案/减少列表项，而不是堆叠。`,
  });
}
```
原理:内容盒是 flex column 无 overflow,子内容超 0.72H 时 `scrollHeight > clientHeight`,且 scrollHeight 是布局尺寸不受镜头 scale 影响--这是最干净的"装不下"信号,直接堵住 flex 居中漏检。error 级会触发 `assertCardRenders` → `validateWithFixes` 修复循环自动打回重修。

### B4. possible-occlusion 放宽 static 门(`smoke-render.ts:582-597`)
把"仅 `position!=='static'` 才报"放宽为:对 `directText || isMedia` 元素无论 position 相交即报 warning(抓绝对定位混入 flex 导致的重叠)。配合 B3,B3 抓"垂直堆叠超容",B4 抓"定位重叠",互补。

---

## 测试与验证
- 在 smoke-render 现有测试目录加用例:一个故意塞 6 条 ListBuild + StatHero 的超载 tsx,断言检出 `content-box-overflow` error;一个正常单原语卡不误报。
- 手测:跑一次一键流程,观察高密度段是否还出现堆叠;查 auto-run jsonl 里 `card` 相关 fix 轮次是否如预期触发。
- 回归:正常卡(单 StatHero / 单 QuoteBlock)确保不误判。

## 风险
- B3 误报风险:内容盒 `scrollHeight` 在某些原语(如 `overflow:'visible'` 的大字 hero)可能天然略超。用 1px 容差 + 仅对 `role=cardstage-content` 节点判定(精准),误报面小;若仍误报可调容差到 `0.02*H`。
- A 方案靠 AI 自觉,不能 100% 杜绝超载卡,故 B 是必要兜底。两者配合预计消除大部分堆叠问题。
- 不动原语运行时行为(方向 C),零回归现有卡的视觉。

## 不做
- 不在 storyboard JSON 解析层加机器校验(adds 是自由文本难计数,渲染校验已是最终防线)。
- 不改原语固定高度 / 不加 flexShrink(方向 C,留后续,需全卡回归)。