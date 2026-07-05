# 作品标题统一体系 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把作品标题升格为 `project.json` 顶层 `meta.title` 真源，复用 `publish.metadata` 生成链路，在应用内工作流与 headless 流水线中自动生成，并作为 `{{title}}` 变量注入封面提示词。

**Architecture:** 数据层新增 `meta` 段（`resolveWorkTitle` 做 meta→publish 回退）；生成层把 `buildMetadataSource` 提为共享；`analyzeSrt` 新增 `generateWorkTitle` 钩子让标题赶在内部 `cover.regeneration` 调用前就绪；另有独立 `publish_metadata` headless run + MCP 工具 + CLI 子命令供单独触发。

**Tech Stack:** TypeScript / Electron IPC / Zustand / Vitest / MCP SDK / zod

**Spec:** `docs/superpowers/specs/2026-07-05-unified-work-title-design.md`

约定：所有验证命令在仓库根目录执行；每个任务结束提交一次。

---

### Task 1: project-persistence 新增 meta 段

**Files:**
- Modify: `src/lib/project-persistence.ts`
- Test: `tests/project-persistence.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/project-persistence.test.ts` 的 `describe('project-persistence', ...)` 内追加（imports 处补 `extractMetaSection, resolveWorkTitle, DEFAULT_PROJECT_META`）：

```ts
  it('extractMetaSection 对旧工程缺 meta 段补默认值', () => {
    const data = createDefaultProjectData();
    expect(extractMetaSection(data)).toEqual({ title: '' });
  });

  it('mergeProjectSection 合并 meta 段并经序列化保留', () => {
    const data = createDefaultProjectData();
    const merged = mergeProjectSection(data, 'meta', { title: '爆款标题' });
    const roundTrip = JSON.parse(JSON.stringify(merged));
    expect(extractMetaSection(roundTrip)).toEqual({ title: '爆款标题' });
  });

  it('resolveWorkTitle 优先 meta.title，回退 publish.title，两者皆空返回空串', () => {
    const data = createDefaultProjectData();
    expect(resolveWorkTitle(data)).toBe('');
    const withPublish = mergeProjectSection(data, 'publish', {
      ...DEFAULT_PUBLISH_META,
      title: '发布段旧标题',
    });
    expect(resolveWorkTitle(withPublish)).toBe('发布段旧标题');
    const withMeta = mergeProjectSection(withPublish, 'meta', { title: '  真源标题  ' });
    expect(resolveWorkTitle(withMeta)).toBe('真源标题');
  });
```

若文件尚未导入 `DEFAULT_PUBLISH_META` 也一并补上。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/project-persistence.test.ts`
Expected: FAIL（`extractMetaSection` 未导出）

- [ ] **Step 3: 实现**

`src/lib/project-persistence.ts`：

在 `ProjectPublishMeta` 定义之后插入：

```ts
/** 作品级元信息。title 是作品标题唯一真源；发布/封面/流水线均引用它。 */
export interface ProjectMetaSection {
  title: string;
}
```

`ProjectData` 内 `publish?` 之后加字段：

```ts
  /** 作品级元信息（标题真源）；缺省视为空。 */
  meta?: ProjectMetaSection;
```

`ProjectSection` 联合类型加 `| 'meta'`。

`DEFAULT_PUBLISH_META` 之后加：

```ts
export const DEFAULT_PROJECT_META: ProjectMetaSection = {
  title: '',
};
```

`extractPublishSection` 之后加：

```ts
export function extractMetaSection(data: ProjectData): ProjectMetaSection {
  return { ...DEFAULT_PROJECT_META, ...(data.meta ?? {}) };
}

/** 作品标题：meta.title 为真源，旧工程回退 publish.title（惰性迁移）。 */
export function resolveWorkTitle(data: ProjectData): string {
  return data.meta?.title?.trim() || data.publish?.title?.trim() || '';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/project-persistence.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/project-persistence.ts tests/project-persistence.test.ts
git commit -m "feat(project): project.json 新增 meta 段作为作品标题真源"
```

---

### Task 2: buildMetadataSource 提取到共享 lib

**Files:**
- Modify: `src/lib/publish-metadata.ts`
- Modify: `src/components/publish/PublishWorkbench.tsx:46-62`（删除本地函数，改 import）
- Test: `tests/publish-metadata.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/publish-metadata.test.ts` 追加（import 处补 `buildMetadataSource`）：

```ts
describe('buildMetadataSource', () => {
  it('拼接分析摘要/关键词/段落概要', () => {
    const source = buildMetadataSource(
      {
        summary: '本期讲AI',
        keywords: ['AI', '播客'],
        segments: [{ title: '开场', summary: '引入话题' }],
      },
      '',
    );
    expect(source).toContain('节目总结：本期讲AI');
    expect(source).toContain('关键词：AI、播客');
    expect(source).toContain('1. 开场：引入话题');
  });

  it('分析为空时回退字幕原文（截断 3000 字符）', () => {
    const source = buildMetadataSource(null, 'x'.repeat(4000));
    expect(source).toContain('字幕内容：');
    expect(source.length).toBeLessThan(3100);
  });

  it('段落最多取 16 条', () => {
    const segments = Array.from({ length: 20 }, (_, i) => ({ title: `段${i + 1}` }));
    const source = buildMetadataSource({ segments }, '');
    expect(source).toContain('16. 段16');
    expect(source).not.toContain('17. 段17');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/publish-metadata.test.ts`
Expected: FAIL（`buildMetadataSource` 未导出）

- [ ] **Step 3: 实现**

`src/lib/publish-metadata.ts` 在 `PublishMetadataInput` 之前加：

```ts
/** buildMetadataSource 接受的最小结构：AIAnalysisResult 与 planning 结果均满足。 */
export interface MetadataSourceInput {
  summary?: string;
  keywords?: string[];
  segments?: Array<{ title: string; summary?: string }>;
}

/** 拼接 AI 分析摘要 / 关键词 / 段落，兜底用字幕原文，作为发布文案生成素材。 */
export function buildMetadataSource(analysis: MetadataSourceInput | null, srtText: string): string {
  const parts: string[] = [];
  if (analysis?.summary) parts.push(`节目总结：${analysis.summary}`);
  if (analysis?.keywords?.length) parts.push(`关键词：${analysis.keywords.join('、')}`);
  if (analysis?.segments?.length) {
    const segs = analysis.segments
      .slice(0, 16)
      .map((s, i) => `${i + 1}. ${s.title}${s.summary ? `：${s.summary}` : ''}`)
      .join('\n');
    parts.push(`段落概要：\n${segs}`);
  }
  if (parts.length === 0 && srtText.trim()) {
    parts.push(`字幕内容：${srtText.trim().slice(0, 3000)}`);
  }
  return parts.join('\n\n');
}
```

`src/components/publish/PublishWorkbench.tsx`：删除第 46-62 行的本地 `buildMetadataSource`（含其 JSDoc 注释），在文件顶部 import 区加：

```ts
import { buildMetadataSource } from '../../lib/publish-metadata';
```

同时可从该文件的 `AIAnalysisResult` import 处确认是否仍被其它地方使用，不再使用则移除该类型 import。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/publish-metadata.test.ts tests/publish/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/publish-metadata.ts src/components/publish/PublishWorkbench.tsx tests/publish-metadata.test.ts
git commit -m "refactor(publish): buildMetadataSource 提取到共享 lib"
```

---

### Task 3: 封面提示词模板新增 {{title}} 变量

**Files:**
- Modify: `src/lib/prompts/defaults.ts:51-65`（COVER_REGENERATION，version 7 → 8）
- Modify: `src/lib/prompts/types.ts:241-245`（变量注册）
- Modify: `src/lib/ai-analysis.ts`（`buildCoverPromptRegenerationPrompt` ~:941、`RegenerateCoverPromptOptions` :181、`regenerateCoverPrompt` :2026）
- Test: `tests/ai-analysis.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/ai-analysis.test.ts` 顶部 import 补 `buildCoverPromptRegenerationPrompt`（从 `../src/lib/ai-analysis`），文件末尾追加：

```ts
describe('buildCoverPromptRegenerationPrompt', () => {
  it('workTitle 注入 {{title}}；缺省渲染为"无"', () => {
    const withTitle = buildCoverPromptRegenerationPrompt({ workTitle: '爆款标题X' });
    expect(withTitle).toContain('爆款标题X');
    const withoutTitle = buildCoverPromptRegenerationPrompt({});
    expect(withoutTitle).toContain('本期作品标题');
    expect(withoutTitle).toMatch(/本期作品标题[\s\S]{0,80}无/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai-analysis.test.ts -t buildCoverPromptRegenerationPrompt`
Expected: FAIL（模板无"本期作品标题"文案）

- [ ] **Step 3: 实现**

`src/lib/prompts/defaults.ts` 把 `COVER_REGENERATION` 整体替换为（`version: 8`，新增标题块）：

```ts
const COVER_REGENERATION = `name: cover.regeneration
description: 封面提示词重生成（视觉系统：短视频缩略图 · B站知识区 / YouTube thumbnail 风）
version: 8
user: |-
  你是一名服务于知识类短视频 / 播客节目的封面提示词工程师，目标是产出 B 站知识区 / YouTube 高点击率缩略图风格的 16:9 封面。
  请结合本期字幕内容，重生成 1 条可直接喂给 AI 生图模型的封面提示词。

  本期作品标题（不为"无"时，封面主文案必须使用该标题或其精炼变体，语义保持一致；为"无"时自行提炼主文案）：
  {{title}}

  已有整期创作提示词：
  {{globalPrompt}}

  当前封面提示词（仅用于参考，可改写）：
  {{currentPrompt}}

  {{styleSystemBlock}}
`;
```

`src/lib/prompts/types.ts` 的 `'cover.regeneration'` 条目 `variables` 数组首位加：

```ts
      { name: 'title', description: '作品标题（为空填"无"）；封面主文案应使用该标题或其精炼变体' },
```

`src/lib/ai-analysis.ts`：

1. `RegenerateCoverPromptOptions`（:181）加字段：

```ts
  /** 作品标题；注入 cover.regeneration 的 {{title}}，空值渲染为"无"。 */
  workTitle?: string;
```

2. `buildCoverPromptRegenerationPrompt`（:941）options 类型加 `workTitle?: string`，渲染 vars 改为：

```ts
  return renderUserPromptWithLock('cover.regeneration', tpl, {
    title: options.workTitle?.trim() || '无',
    globalPrompt: globalPrompt || '无',
    currentPrompt: currentPrompt || '无',
    styleSystemBlock: getStyleFacetBlock(options.stylePresetId, 'cover'),
  });
```

3. `regenerateCoverPrompt`（:2026）解构处加 `workTitle,`，并在 `buildCoverPromptRegenerationPrompt({...})` 调用对象里加 `workTitle,`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai-analysis.test.ts tests/prompts.test.ts tests/prompts-io.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/prompts/defaults.ts src/lib/prompts/types.ts src/lib/ai-analysis.ts tests/ai-analysis.test.ts
git commit -m "feat(cover): cover.regeneration 模板新增 {{title}} 作品标题变量 (v8)"
```

---

### Task 4: analyzeSrt 新增 generateWorkTitle 钩子

**Files:**
- Modify: `src/lib/ai-analysis.ts`（`AnalyzeSrtOptions` :118-157、planning 完成后 ~:1571-1595）
- Test: `tests/ai-analysis.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/ai-analysis.test.ts` 的 `describe('analyzeSrt', ...)` 内追加（import 处补 `getBuiltinPromptTemplate`，来自 `../src/lib/prompts`；若已有则复用）：

```ts
  it('generateWorkTitle 结果注入内部 cover.regeneration 调用的 {{title}}', async () => {
    const structuredCaller = vi
      .fn<typeof generateStructuredData>()
      .mockResolvedValueOnce({
        segments: [baseSegment],
        coverPrompts: ['规划兜底封面'],
        summary: '节目总结',
        keywords: ['AI'],
        globalPrompt: '',
      })
      .mockResolvedValueOnce({ coverPrompt: '带标题的封面提示词' });
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX });
    const generateWorkTitle = vi.fn().mockResolvedValue('爆款标题X');
    const onCoverPromptsReady = vi.fn();

    await analyzeSrt(baseEntries, settings, {
      generateStructuredData: structuredCaller,
      generateMotionCard: motionCaller,
      coverTemplate: getBuiltinPromptTemplate('cover.regeneration'),
      onCoverPromptsReady,
      generateWorkTitle,
    });

    expect(generateWorkTitle).toHaveBeenCalledTimes(1);
    expect(generateWorkTitle.mock.calls[0][0].summary).toBe('节目总结');
    // 第二次 structured 调用即 cover.regeneration，其 prompt 参数应含标题
    expect(structuredCaller).toHaveBeenCalledTimes(2);
    expect(structuredCaller.mock.calls[1]?.[1]).toContain('爆款标题X');
    expect(onCoverPromptsReady).toHaveBeenCalledWith(['带标题的封面提示词']);
  });

  it('generateWorkTitle 抛错时封面调用照常进行（{{title}} 为"无"）', async () => {
    const structuredCaller = vi
      .fn<typeof generateStructuredData>()
      .mockResolvedValueOnce({
        segments: [baseSegment],
        coverPrompts: ['规划兜底封面'],
        summary: '节目总结',
        keywords: ['AI'],
        globalPrompt: '',
      })
      .mockResolvedValueOnce({ coverPrompt: '无标题封面提示词' });
    const motionCaller = vi
      .fn<MotionCardAgentProvider>()
      .mockResolvedValue({ tsx: VALID_MOTION_TSX });

    await analyzeSrt(baseEntries, settings, {
      generateStructuredData: structuredCaller,
      generateMotionCard: motionCaller,
      coverTemplate: getBuiltinPromptTemplate('cover.regeneration'),
      onCoverPromptsReady: vi.fn(),
      generateWorkTitle: vi.fn().mockRejectedValue(new Error('LLM 超时')),
    });

    expect(structuredCaller).toHaveBeenCalledTimes(2);
    expect(structuredCaller.mock.calls[1]?.[1]).not.toContain('爆款标题X');
  });
```

注意：若 mock 的第二次返回值形状与 `parseCoverPromptResult` 不符（它接受 `{ coverPrompt: string }` 或 `{ coverPrompts: string[] }`），按实际解析器调整。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai-analysis.test.ts -t generateWorkTitle`
Expected: FAIL（`generateWorkTitle` 选项不存在 / prompt 不含标题）

- [ ] **Step 3: 实现**

`src/lib/ai-analysis.ts`：

1. `AnalyzeSrtOptions`（`onCoverPromptsReady` 之后）加：

```ts
  /** planning 完成后生成/取回作品标题；返回值注入 cover.regeneration 的 {{title}}。
   * 生成与落盘（fill-if-empty）由调用方负责；抛错或返回 null 时封面无标题继续。 */
  generateWorkTitle?: (planning: SegmentPlanningResult) => Promise<string | null>;
```

2. `analyzeSrt` 内部：在 `onPlanningDone` 的 try/catch（~:1571-1575）之后、cover 的 IIFE（:1580）之前插入：

```ts
  // 作品标题：planning 一完成就并行生成，赶在下方 cover.regeneration 调用前就绪。
  const workTitlePromise: Promise<string | null> = options.generateWorkTitle
    ? options.generateWorkTitle(planning).catch(() => null)
    : Promise.resolve(null);
```

（若该作用域内 options 已被完全解构，改为在顶部解构 `generateWorkTitle` 并使用之。）

3. cover IIFE 内 `regenerateCoverPrompt(entries, settings, {...})`（:1588）调用前加 `const workTitle = await workTitlePromise;`，调用对象里加 `workTitle: workTitle ?? undefined,`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai-analysis.test.ts tests/ai-analysis-card-progress.test.ts tests/ai-segment-analysis.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-analysis.ts tests/ai-analysis.test.ts
git commit -m "feat(analyze): analyzeSrt 新增 generateWorkTitle 钩子，标题先于封面提示词就绪"
```

---

### Task 5: 封面手动重生成路径传入 workTitle（IPC handler + cover-run）

**Files:**
- Modify: `electron/ai-generation-ipc.ts`（helper ~:51 之后、`regenerate-cover-prompt` handler :544 附近）
- Modify: `electron/pipeline/runs/cover-run.ts:69-77`
- Test: `tests/cover-run.test.ts`

不改 IPC 名称/参数——主进程从 projectDir 自取标题。

- [ ] **Step 1: 写失败测试**

`tests/cover-run.test.ts` 的 `describe('runCoverPromptHeadless', ...)` 内追加一条（参照该文件既有 fixture 的写法：它会往临时项目目录写 project.json 并注入 `deps.regenerate`；沿用同一 helper，只是 project.json 里加 `meta` 段）：

```ts
  it('passes resolveWorkTitle(project) as workTitle to regenerate', async () => {
    // 在既有 fixture 基础上给 project.json 增加 { meta: { title: '标题真源' } }
    // regenerate mock 捕获第三参 opts
    // expect(capturedOpts.workTitle).toBe('标题真源');
  });
```

按该测试文件现有的 setup helper 具体化以上骨架：复制既有 'generates prompts and persists...' 用例，project 数据加 `meta: { title: '标题真源' }`，`deps.regenerate` mock 记录 `opts`，断言 `opts.workTitle === '标题真源'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/cover-run.test.ts`
Expected: 新用例 FAIL（workTitle undefined）

- [ ] **Step 3: 实现**

`electron/pipeline/runs/cover-run.ts`：import 处加 `import { resolveWorkTitle } from '../../../src/lib/project-persistence';`，`runCoverPromptHeadless` 的 `regenerate(entries, settings, {...})` 调用对象加：

```ts
    workTitle: resolveWorkTitle(project) || undefined,
```

`electron/ai-generation-ipc.ts`：

1. import 处加 `import { resolveWorkTitle } from '../src/lib/project-persistence';`
2. `loadProjectStylePresetId` 之后加：

```ts
/** 读取作品标题（meta.title → publish.title 回退）；无 projectDir 或读取失败返回 undefined。 */
async function loadProjectWorkTitle(projectDir?: string): Promise<string | undefined> {
  if (!projectDir) return undefined;
  try {
    return resolveWorkTitle(await loadProjectFile(projectDir)) || undefined;
  } catch {
    return undefined;
  }
}
```

3. `regenerate-cover-prompt` handler 的 `regenerateCoverPrompt(args.entries, args.settings, {...})` 调用对象加：

```ts
          workTitle: await loadProjectWorkTitle(args.projectDir),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/cover-run.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/ai-generation-ipc.ts electron/pipeline/runs/cover-run.ts tests/cover-run.test.ts
git commit -m "feat(cover): 封面提示词重生成注入作品标题（IPC handler 与 headless run 自取）"
```

---

### Task 6: 主进程 analyze IPC 接线（生成标题并落盘）

**Files:**
- Modify: `electron/ai-generation-ipc.ts`（`analyze-srt` handler :127-233）

主进程 handler 无单测先例，本任务以 TypeScript 编译 + 既有测试回归验证；端到端行为在 Task 11 验证。

- [ ] **Step 1: 实现**

`electron/ai-generation-ipc.ts`：

1. import 区补：

```ts
import { buildMetadataSource } from '../src/lib/publish-metadata';
import {
  extractMetaSection,
  extractPublishSection,
} from '../src/lib/project-persistence';
import { saveProjectSection } from './project-file';
import { emitProjectUpdated } from './pipeline/headless-generation';
import type { SegmentPlanningResult } from '../src/lib/ai-analysis';
```

（`resolveWorkTitle`、`loadProjectFile`、`generatePublishMetadata`、`resolvePromptBinding` 已有 import，注意合并。）

2. `analyze-srt` handler 内，`coverTemplate` 加载之后加：

```ts
        const publishTemplate = await loadEffectivePromptTemplate('publish.metadata', {
          userDataPath,
          projectDir: args.projectDir,
        });
        // 作品标题：planning 完成后生成（fill-if-empty），落盘 meta + publish（title 镜像）。
        const generateWorkTitle = args.projectDir
          ? async (planning: SegmentPlanningResult): Promise<string | null> => {
              const projectDir = args.projectDir!;
              try {
                const existing = await loadProjectWorkTitle(projectDir);
                if (existing) return existing;
                const sourceText = buildMetadataSource(planning, '');
                if (!sourceText.trim()) return null;
                const binding = resolvePromptBinding(
                  'publish.metadata',
                  args.settings,
                  args.projectBindings ?? null,
                );
                const md = await generatePublishMetadata(
                  args.settings,
                  { sourceText },
                  { template: publishTemplate, binding },
                );
                const data = await loadProjectFile(projectDir);
                await saveProjectSection(projectDir, 'meta', {
                  ...extractMetaSection(data),
                  title: md.title,
                });
                const publish = extractPublishSection(data);
                await saveProjectSection(projectDir, 'publish', {
                  ...publish,
                  title: md.title,
                  desc: publish.desc || md.desc,
                  tagsInput: publish.tagsInput || md.tags.join(', '),
                });
                emitProjectUpdated(getMainWindow, projectDir, ['meta', 'publish']);
                writeAppLog('info', 'publish', '作品标题已生成', md.title);
                return md.title;
              } catch (error) {
                writeAppLog(
                  'warn',
                  'publish',
                  '作品标题生成失败（封面将无标题继续）',
                  error instanceof Error ? error.message : String(error),
                );
                return null;
              }
            }
          : undefined;
```

（`getMainWindow` / `writeAppLog` 来自该文件的 `AiGenerationIpcContext`，与既有 handler 同源取用。）

3. `analyzeSrt(entries, args.settings, {...})` 调用对象加一行 `generateWorkTitle,`。

- [ ] **Step 2: 类型与回归验证**

Run: `npx tsc --noEmit -p . 2>&1 | head -20`（若项目无根 tsconfig 直接可用则以 `npm run build` 的类型检查为准，放到 Task 11）
Run: `npx vitest run tests/ai-analysis.test.ts`
Expected: 无新增类型错误；测试 PASS

- [ ] **Step 3: Commit**

```bash
git add electron/ai-generation-ipc.ts
git commit -m "feat(analyze): analyze-srt IPC 接线作品标题生成（fill-if-empty 落盘 meta+publish）"
```

---

### Task 7: headless analyze-run 接线

**Files:**
- Modify: `electron/pipeline/runs/analyze-run.ts`
- Test: `tests/analyze-run.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/analyze-run.test.ts` 参照既有用例（tmp 项目目录 + `deps.analyze` mock）追加：

```ts
  it('injects generateWorkTitle that returns existing title without regenerating', async () => {
    // 既有 fixture 的 project.json 增加 meta: { title: '既有标题' }
    // deps.analyze mock 捕获 options
    // const title = await capturedOptions.generateWorkTitle({ summary: 's', keywords: [], segments: [] });
    // expect(title).toBe('既有标题');
  });
```

按该文件现有 helper 具体化：复制一条既有成功用例，project.json 写入 `meta: { title: '既有标题' }`，`deps.analyze` 记录第三参 `options`，run 完成后调用 `options.generateWorkTitle(...)` 断言直接返回既有标题（不触发 LLM——headless settings 未配置时若走生成路径会抛错，直接返回即证明 fill-if-empty 生效）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/analyze-run.test.ts`
Expected: 新用例 FAIL（`options.generateWorkTitle` undefined）

- [ ] **Step 3: 实现**

`electron/pipeline/runs/analyze-run.ts`：

1. import 区补：

```ts
import { buildMetadataSource, generatePublishMetadata } from '../../../src/lib/publish-metadata';
import { resolvePromptBinding } from '../../../src/lib/llm/binding-resolver';
import {
  extractMetaSection,
  extractPublishSection,
  resolveWorkTitle,
} from '../../../src/lib/project-persistence';
import type { SegmentPlanningResult } from '../../../src/lib/ai-analysis';
```

2. 模板 `Promise.all` 数组追加第四项：

```ts
      loadEffectivePromptTemplate('publish.metadata', { userDataPath, projectDir: projectPath }),
```

解构改为 `const [planningTemplate, { cardTemplate, imageTemplate, animationTemplate }, coverTemplate, publishTemplate] = ...`。

3. `generateMotionCard` 定义之后加：

```ts
  // 作品标题：planning 完成后生成（fill-if-empty），落盘 meta + publish（title 镜像）。
  const generateWorkTitle = async (planning: SegmentPlanningResult): Promise<string | null> => {
    try {
      const project = await loadProjectFile(projectPath);
      const existing = resolveWorkTitle(project);
      if (existing) return existing;
      const sourceText = buildMetadataSource(planning, '');
      if (!sourceText.trim()) return null;
      const binding = resolvePromptBinding('publish.metadata', settings, projectBindings);
      const md = await generatePublishMetadata(
        settings,
        { sourceText },
        { template: publishTemplate, binding },
      );
      const headless = new HeadlessProjectContext(projectPath);
      await headless.saveSection('meta', { ...extractMetaSection(project), title: md.title });
      const publish = extractPublishSection(project);
      await headless.saveSection('publish', {
        ...publish,
        title: md.title,
        desc: publish.desc || md.desc,
        tagsInput: publish.tagsInput || md.tags.join(', '),
      });
      return md.title;
    } catch {
      return null; // 标题失败不阻断分析与封面
    }
  };
```

4. `analyze(entries, settings, {...})` 调用对象加一行 `generateWorkTitle,`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/analyze-run.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/pipeline/runs/analyze-run.ts tests/analyze-run.test.ts
git commit -m "feat(pipeline): headless analyze 接线作品标题生成"
```

---

### Task 8: 独立 publish_metadata run + 任务 kind + 进度桥

**Files:**
- Create: `electron/pipeline/runs/publish-metadata-run.ts`
- Modify: `electron/pipeline/types.ts`（PIPELINE_TASK_KINDS）
- Modify: `src/lib/pipeline-progress-bridge.ts`（kind 联合 + KIND_MAP）
- Test: `tests/publish-metadata-run.test.ts`（新建，参照 tests/cover-run.test.ts）
- Test: `tests/pipeline-types.test.ts`、`tests/pipeline-progress-bridge.test.ts`（更新期望）

- [ ] **Step 1: 写失败测试**

新建 `tests/publish-metadata-run.test.ts`（fixture 写法参照 `tests/cover-run.test.ts` 的 tmp 目录 + fake handle）：

```ts
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi } from 'vitest';
import { runPublishMetadataHeadless } from '../electron/pipeline/runs/publish-metadata-run';

function fakeHandle() {
  return {
    taskId: 'tk',
    signal: new AbortController().signal,
    update: vi.fn(),
  } as never;
}

async function makeProject(data: object): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lingji-pubmeta-'));
  await writeFile(join(dir, 'project.json'), JSON.stringify(data), 'utf-8');
  return dir;
}

const BASE_PROJECT = {
  version: 1,
  createdAt: 't',
  updatedAt: 't',
  timeline: null,
  script: { templateId: 't', annotations: [], reviewState: 'idle', lastReviewedDocVersion: 0 },
  aiAnalysis: {
    analysisResult: { summary: '总结', keywords: ['AI'], segments: [], coverPrompts: [], cards: [] },
    coverCandidates: [],
  },
};

describe('runPublishMetadataHeadless', () => {
  it('已有标题时跳过（fill-if-empty）', async () => {
    const dir = await makeProject({ ...BASE_PROJECT, meta: { title: '既有标题' } });
    const generate = vi.fn();
    const result = await runPublishMetadataHeadless(
      { projectPath: dir, userDataPath: dir, handle: fakeHandle() },
      { generate },
    );
    expect(result).toEqual({ skipped: true, title: '既有标题' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('生成并落盘 meta + publish（title 镜像，desc/tags 只填空）', async () => {
    const dir = await makeProject({
      ...BASE_PROJECT,
      publish: { title: '', desc: '已有描述', tagsInput: '', thumbnail: '', bilibiliTid: '' },
    });
    // headless settings/模板加载依赖 userData 目录结构，直接注入 generate mock 绕开 LLM；
    // loadFullHeadlessAISettings 若在无配置时抛错，则参照 cover-run.test.ts 的 settings mock 方式处理。
    const generate = vi.fn().mockResolvedValue({ title: '新标题', desc: '新描述', tags: ['a', 'b'] });
    const result = await runPublishMetadataHeadless(
      { projectPath: dir, userDataPath: dir, handle: fakeHandle() },
      { generate },
    );
    expect(result).toEqual({ skipped: false, title: '新标题' });
    const saved = JSON.parse(await readFile(join(dir, 'project.json'), 'utf-8'));
    expect(saved.meta.title).toBe('新标题');
    expect(saved.publish.title).toBe('新标题');
    expect(saved.publish.desc).toBe('已有描述'); // 只填空
    expect(saved.publish.tagsInput).toBe('a, b');
  });

  it('force 时即使已有标题也重生成', async () => {
    const dir = await makeProject({ ...BASE_PROJECT, meta: { title: '旧标题' } });
    const generate = vi.fn().mockResolvedValue({ title: '强制新标题', desc: '', tags: [] });
    const result = await runPublishMetadataHeadless(
      { projectPath: dir, userDataPath: dir, handle: fakeHandle(), params: { force: true } },
      { generate },
    );
    expect(result).toEqual({ skipped: false, title: '强制新标题' });
  });
});
```

注意：若 `loadFullHeadlessAISettings` / `loadEffectivePromptTemplate` 在裸目录下抛错，参照 `tests/cover-run.test.ts` 与 `tests/analyze-run.test.ts` 的现成 mock/fixture 手法（vi.mock 或写入最小配置文件），保持与邻近测试一致。

`tests/pipeline-types.test.ts`：期望数组在 `'sculpt_card'` 后插入 `'publish_metadata'`。
`tests/pipeline-progress-bridge.test.ts`：若有 KIND_MAP 全量断言，补 `publish_metadata`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/publish-metadata-run.test.ts tests/pipeline-types.test.ts`
Expected: FAIL（模块不存在 / kind 缺失）

- [ ] **Step 3: 实现**

`electron/pipeline/types.ts`：`PIPELINE_TASK_KINDS` 在 `'sculpt_card'` 后插入 `'publish_metadata',`。

`src/lib/pipeline-progress-bridge.ts`：kind 联合类型同位置加 `| 'publish_metadata'`；`KIND_MAP` 加：

```ts
  publish_metadata: { category: 'ai-write', label: '生成发布文案' },
```

新建 `electron/pipeline/runs/publish-metadata-run.ts`：

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildMetadataSource,
  generatePublishMetadata,
} from '../../../src/lib/publish-metadata';
import { resolvePromptBinding } from '../../../src/lib/llm/binding-resolver';
import {
  extractMetaSection,
  extractPublishSection,
  resolveWorkTitle,
} from '../../../src/lib/project-persistence';
import { parseSrt } from '../../../src/lib/srt-parser';
import { loadFullHeadlessAISettings, loadHeadlessProjectBindings } from '../headless-settings';
import { GenerationError } from '../generation-error';
import { HeadlessProjectContext } from '../context';
import { loadEffectivePromptTemplate } from '../../prompts-io';
import { loadProjectFile } from '../../project-file';
import type { GenerationRunCtx } from '../headless-generation';

interface MetadataDeps {
  generate?: typeof generatePublishMetadata;
}

/**
 * 生成作品标题与发布文案，落盘 meta.title（真源）+ publish 段（title 镜像，desc/tags 只填空）。
 * 默认 fill-if-empty：已有标题（resolveWorkTitle 非空）时跳过；params.force 强制重生成。
 */
export async function runPublishMetadataHeadless(
  ctx: GenerationRunCtx,
  deps: MetadataDeps = {},
): Promise<{ skipped: boolean; title: string }> {
  const generate = deps.generate ?? generatePublishMetadata;
  const { projectPath, userDataPath, handle, params } = ctx;
  const force = params?.force === true;

  handle.update({ phase: '装配设置', percent: 10 });
  const project = await loadProjectFile(projectPath);
  const existingTitle = resolveWorkTitle(project);
  if (existingTitle && !force) {
    handle.update({ phase: '已有标题，跳过', percent: 100 });
    return { skipped: true, title: existingTitle };
  }

  const analysisResult = project.aiAnalysis?.analysisResult ?? null;
  let srtText = '';
  try {
    const srt = await readFile(join(projectPath, 'podcast-subtitles.srt'), 'utf-8');
    srtText = parseSrt(srt)
      .map((e) => e.text)
      .join(' ');
  } catch {
    // 无字幕时仅依赖分析结果
  }
  const sourceText = buildMetadataSource(analysisResult, srtText);
  if (!sourceText.trim()) {
    throw new GenerationError('no_source', '没有可用于生成文案的内容，请先运行字幕分析或生成字幕。');
  }

  const settings = await loadFullHeadlessAISettings(userDataPath);
  const projectBindings = await loadHeadlessProjectBindings(projectPath);
  const template = await loadEffectivePromptTemplate('publish.metadata', {
    userDataPath,
    projectDir: projectPath,
  });
  const binding = resolvePromptBinding('publish.metadata', settings, projectBindings);

  handle.update({ phase: '生成文案', percent: 40 });
  const md = await generate(
    settings,
    { sourceText, currentTitle: existingTitle || undefined },
    { template, binding },
  );

  handle.update({ phase: '写入', percent: 90 });
  const headless = new HeadlessProjectContext(projectPath);
  await headless.saveSection('meta', { ...extractMetaSection(project), title: md.title });
  const publish = extractPublishSection(project);
  await headless.saveSection('publish', {
    ...publish,
    title: md.title,
    desc: publish.desc || md.desc,
    tagsInput: publish.tagsInput || md.tags.join(', '),
  });
  handle.update({ phase: '完成', percent: 100 });
  return { skipped: false, title: md.title };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/publish-metadata-run.test.ts tests/pipeline-types.test.ts tests/pipeline-progress-bridge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/pipeline/types.ts src/lib/pipeline-progress-bridge.ts electron/pipeline/runs/publish-metadata-run.ts tests/publish-metadata-run.test.ts tests/pipeline-types.test.ts tests/pipeline-progress-bridge.test.ts
git commit -m "feat(pipeline): 新增 publish_metadata headless run（fill-if-empty + force）"
```

---

### Task 9: MCP 工具注册 + lingji CLI publish 子命令

**Files:**
- Modify: `electron/pipeline/headless-generation.ts`
- Create: `cli/src/commands/publish.ts`
- Modify: `cli/src/index.ts`（case 分发 + usage 帮助文本）
- Test: `tests/pipeline-mcp-registration.test.ts`（期望工具列表）
- Test: `tests/cli-publish-command.test.ts`（新建，参照 tests/cli-cover-command.test.ts）

- [ ] **Step 1: 写失败测试**

`tests/pipeline-mcp-registration.test.ts` 的 expected 工具名数组加 `'lingji_generate_publish_metadata'`。

新建 `tests/cli-publish-command.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { runPublishCommand } from '../cli/src/commands/publish';
import type { ToolCaller } from '../cli/src/client';

function fake() {
  const calls: Array<{ name: string; args?: unknown }> = [];
  const client: ToolCaller = {
    async call(name, args) {
      calls.push({ name, args });
      return name === 'lingji_get_active_project' ? { projectPath: '/p' } : { taskId: 'tk' };
    },
    async close() {},
  };
  return { client, calls };
}

describe('runPublishCommand', () => {
  it('meta → lingji_generate_publish_metadata', async () => {
    const { client, calls } = fake();
    await runPublishCommand('meta', {}, client);
    expect(calls.some((c) => c.name === 'lingji_generate_publish_metadata')).toBe(true);
  });

  it('--force 透传为工具入参', async () => {
    const { client, calls } = fake();
    await runPublishCommand('meta', { force: true }, client);
    const call = calls.find((c) => c.name === 'lingji_generate_publish_metadata');
    expect((call?.args as { force?: boolean }).force).toBe(true);
  });

  it('未知子命令抛 bad_args', async () => {
    const { client } = fake();
    await expect(runPublishCommand('xxx', {}, client)).rejects.toThrow(/未知 publish 子命令/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/cli-publish-command.test.ts tests/pipeline-mcp-registration.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`electron/pipeline/headless-generation.ts`：import `runPublishMetadataHeadless`（from `'./runs/publish-metadata-run'`）；`registerGenerationTools` 内 `lingji_generate_covers` 注册之后加：

```ts
  registerGenerationTool(server, getMainWindow, getUserDataPath, {
    name: 'lingji_generate_publish_metadata',
    title: '生成作品标题与发布文案',
    description:
      '基于分析结果/字幕生成作品标题+描述+标签，写入 project.json 的 meta 与 publish 节；默认已有标题时跳过（force 强制重生成）。返回 taskId（fire-and-poll）。',
    kind: 'publish_metadata',
    sections: ['meta', 'publish'],
    extraInput: { force: z.boolean().optional().describe('已有标题时也强制重新生成') },
    run: (ctx) => runPublishMetadataHeadless(ctx),
  });
```

新建 `cli/src/commands/publish.ts`：

```ts
// cli/src/commands/publish.ts
import type { ToolCaller } from '../client';
import { runGenerationCommand } from './generation';
import { CliError } from '../errors';
const MAP: Record<string, string> = {
  meta: 'lingji_generate_publish_metadata',
};
export async function runPublishCommand(action: string | undefined, flags: Record<string, string | boolean>, client: ToolCaller): Promise<unknown> {
  const tool = action ? MAP[action] : undefined;
  if (!tool) throw new CliError(`未知 publish 子命令: ${action ?? '(空)'}（支持 meta）`, 'bad_args', 2);
  return runGenerationCommand({
    toolName: tool,
    flags,
    client,
    extraArgs: flags.force === true ? { force: true } : undefined,
  });
}
```

`cli/src/index.ts`：import `runPublishCommand`；case 分发（`case 'cover':` 之后）加：

```ts
    case 'publish':
      return runPublishCommand(action, flags, client);
```

并在 usage/帮助文本（若有命令列表）补一行 `publish meta [--force] [--wait]  生成作品标题与发布文案`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/cli-publish-command.test.ts tests/pipeline-mcp-registration.test.ts tests/cli-cover-command.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/pipeline/headless-generation.ts cli/src/commands/publish.ts cli/src/index.ts tests/cli-publish-command.test.ts tests/pipeline-mcp-registration.test.ts
git commit -m "feat(mcp/cli): lingji_generate_publish_metadata 工具 + lingji publish meta 命令"
```

---

### Task 10: PublishWorkbench 接入 meta 真源

**Files:**
- Modify: `src/components/publish/PublishWorkbench.tsx`（hydration :503-541、持久化 :550-568）

行为变化：标题回填优先 `meta.title`；防抖持久化同时写 `meta` 段（publish.title 保持镜像，各平台上传链路零改动）；监听 `onProjectUpdated` 在后台生成标题时 fill-if-empty 回灌，防止防抖写回用旧空值覆盖。

- [ ] **Step 1: 实现**

1. import 处把 `extractPublishSection` 一组补上 `extractMetaSection`。

2. hydration effect（:514-537）中：

```ts
      let saved: ProjectPublishMeta | null = null;
      let savedMetaTitle = '';
      try {
        const raw = await window.electronAPI.loadProject(projectDir);
        const data = JSON.parse(raw) as ProjectData;
        saved = extractPublishSection(data);
        savedMetaTitle = extractMetaSection(data).title;
      } catch {
        saved = null;
      }
      if (cancelled) return;
      if (saved) {
        const savedTitle = savedMetaTitle || saved.title;
        if (savedTitle) setTitle((prev) => prev || savedTitle);
        // …其余字段回填保持原样…
```

3. 防抖持久化 effect（:562-566）中 `saveProjectSection(projectDir, 'publish', ...)` 之后并行写 meta：

```ts
      window.electronAPI
        .saveProjectSection(projectDir, 'meta', JSON.stringify({ title }))
        .catch(() => {});
```

4. 持久化 effect 之后新增监听（fill-if-empty 回灌）：

```ts
  // 后台（工作流/流水线）生成标题后回灌本地态，避免防抖写回用空标题覆盖新值。
  useEffect(() => {
    if (!projectDir || !window.electronAPI?.onProjectUpdated) return;
    return window.electronAPI.onProjectUpdated((payload) => {
      if (payload.projectPath !== projectDir) return;
      if (!payload.sections.includes('meta') && !payload.sections.includes('publish')) return;
      void (async () => {
        try {
          const raw = await window.electronAPI.loadProject(projectDir);
          const data = JSON.parse(raw) as ProjectData;
          const metaTitle = extractMetaSection(data).title;
          const saved = extractPublishSection(data);
          if (metaTitle) setTitle((prev) => prev || metaTitle);
          if (saved.desc) setDesc((prev) => prev || saved.desc);
          if (saved.tagsInput) setTagsInput((prev) => prev || saved.tagsInput);
        } catch {
          // 刷新失败忽略，下次打开自然回填
        }
      })();
    });
  }, [projectDir]);
```

（`onProjectUpdated` 契约见 `src/lib/electron-api.ts:415`，App.tsx:378-386 有同款用法。）

- [ ] **Step 2: 回归验证**

Run: `npx vitest run tests/publish/ tests/publish-metadata.test.ts`
Expected: PASS（该组件无直接单测，靠周边测试 + Task 11 build 验证）

- [ ] **Step 3: Commit**

```bash
git add src/components/publish/PublishWorkbench.tsx
git commit -m "feat(publish): 发布 tab 标题接入 meta 真源（镜像写回 + 后台生成回灌）"
```

---

### Task 11: 文档同步 + 全量验证

**Files:**
- Modify: `CLAUDE.md`（project.json 结构、MCP 工具列表两处描述）

- [ ] **Step 1: 更新 CLAUDE.md**

「工程文件与持久化」小节 `project.json` 结构列表加一行：

```markdown
- `meta`：作品级元信息（标题真源 `meta.title`；发布 tab / 封面 / 流水线均引用，`publish.title` 保持镜像）。
```

「Agent / ACP / MCP 约束」中 MCP 工具枚举句补「生成作品标题与发布文案」。

- [ ] **Step 2: 全量测试**

Run:

```bash
npx vitest run tests/project-persistence.test.ts tests/publish-metadata.test.ts tests/ai-analysis.test.ts tests/cover-run.test.ts tests/analyze-run.test.ts tests/publish-metadata-run.test.ts tests/pipeline-types.test.ts tests/pipeline-progress-bridge.test.ts tests/pipeline-mcp-registration.test.ts tests/cli-publish-command.test.ts tests/cli-cover-command.test.ts tests/prompts.test.ts tests/prompts-io.test.ts tests/publish/
```

Expected: 全部 PASS

- [ ] **Step 3: 构建验证（类型检查兜底）**

Run: `npm run build`
Expected: 编译通过，无类型错误

- [ ] **Step 4: 全量测试回归**

Run: `npm test`
Expected: PASS（若有与本改动无关的既有失败，如实记录）

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 同步 meta 段与发布文案 MCP 工具"
```

---

## 影响面核对（提交前）

- 共享类型 `ProjectData` 变更：新增可选 `meta` 段，向后兼容；`ProjectSection` 联合已同步，`saveProjectSection` 泛型透传无需白名单改动。
- 提示词模板：`cover.regeneration` v7→v8（版本门槛已过滤旧覆盖），新变量缺省渲染"无"。
- IPC：零签名变更（标题由主进程按 projectDir 自取）。
- 导出链路：未触碰。
- 已知取舍：发布 tab 打开期间后台生成标题的竞态用 `onProjectUpdated` fill-if-empty 回灌缓解；用户已手输标题时后台永不覆盖（fill-if-empty）。
