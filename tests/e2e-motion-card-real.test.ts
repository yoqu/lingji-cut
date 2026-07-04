/**
 * 真实 AI 端到端出卡测试（默认跳过；LINGJI_E2E=1 时启用）。
 *
 * 走完整新链路：导演（JSON 分镜 + 机器校验）→ 雕刻（motion-kit 组合）→
 * 机械质检（lint + 编译 + 冒烟渲染 + 布局探针）→ 审查（设计兑现度）。
 * 依赖本机应用的全局 AI 设置（~/Library/Application Support/灵机剪影），
 * 会产生真实 LLM 调用与费用。
 *
 * 运行：LINGJI_E2E=1 npx vitest run tests/e2e-motion-card-real.test.ts --testTimeout 900000
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateCardForSegment } from '../src/lib/ai-analysis';
import { createMotionCardAgentProvider } from '../electron/pipeline/motion-agent-run';
import { assertCardRenders, validateMotionCardTsx } from '../electron/remotion/smoke-render';
import { lintMotionCardTsx } from '../src/lib/motion-card-lint';
import { parseStoryboard, validateStoryboard } from '../src/lib/motion-storyboard';
import type { SrtEntry } from '../src/types';
import type { AISettings } from '../src/types/ai';

const ENABLED = process.env.LINGJI_E2E === '1';
const d = ENABLED ? describe : describe.skip;

/** 真实感测试段：数据密集型口播（考研报名），带明确数字与递进结构。 */
const ENTRIES: SrtEntry[] = [
  { index: 1, startMs: 0, endMs: 3200, text: '今年考研的数据出来了，变化非常大。' },
  { index: 2, startMs: 3200, endMs: 7600, text: '全国硕士研究生报名人数达到28842人，创下新高。' },
  { index: 3, startMs: 7600, endMs: 11800, text: '而博士报名只有2403人，两者差了十倍还多。' },
  { index: 4, startMs: 11800, endMs: 16000, text: '也就是说，绝大多数人挤在硕士这一条赛道上。' },
  { index: 5, startMs: 16000, endMs: 20000, text: '这背后是就业压力在推着大家往前走。' },
];

const SEGMENT = {
  id: 'e2e-seg-1',
  title: '考研报名数据对比',
  summary: '硕士报名28842人远超博士2403人，反映就业压力下的赛道拥挤。',
  startMs: 0,
  endMs: 20000,
  transcriptExcerpt: '硕士报名28842人，博士2403人，差了十倍还多。',
};

const OUT_DIR = path.join(os.tmpdir(), 'lingji-e2e-motion');

d('真实 AI 出卡端到端（新链路全阶段）', () => {
  it('生成可渲染的 motionCard.tsx，分镜合法且组件通过全部机械质检', async () => {
    const userDataPath = path.join(os.homedir(), 'Library', 'Application Support', '灵机剪影');
    const rolesSeedDir = path.resolve(__dirname, '..', 'resources', 'pi-agents', 'agents');

    const phases: string[] = [];
    const provider = createMotionCardAgentProvider({
      userDataPath,
      projectPath: OUT_DIR,
      rolesSeedDir,
      onPhase: (p) => {
        phases.push(p);
        console.log(`[e2e] 阶段: ${p}`);
      },
    });

    const card = await generateCardForSegment(
      ENTRIES,
      { summary: '考研数据解读节目', keywords: ['考研', '就业'], globalPrompt: '' },
      SEGMENT,
      {} as AISettings,
      {
        generateMotionCard: provider,
        validateMotionSource: assertCardRenders,
        visualType: 'motion',
        stylePresetId: 'editorial-eink',
        segmentIndex: 0,
        totalSegments: 1,
        telemetry: {
          emit: (event, data) => console.log(`[e2e] ${event}`, JSON.stringify(data)),
        },
      },
    );

    // 落盘产物供人工查看
    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, 'motionCard.tsx'), card.motionCard?.tsx ?? '', 'utf-8');
    await fs.writeFile(path.join(OUT_DIR, 'storyboard.json'), card.animationDirection ?? '', 'utf-8');
    console.log(`[e2e] 产物目录: ${OUT_DIR}`);
    console.log(`[e2e] 阶段序列: ${phases.join(' → ')}`);

    // 1) 分镜：合法 JSON storyboard，数字忠于逐字稿
    const storyboard = parseStoryboard(card.animationDirection ?? '');
    expect(storyboard).not.toBeNull();
    const sbVerdict = validateStoryboard(storyboard, {
      cueCount: ENTRIES.length,
      transcript: ENTRIES.map((e) => e.text).join(''),
    });
    expect(sbVerdict.errors).toEqual([]);

    // 2) 组件：lint 通过、编译 + 冒烟渲染 + 布局探针（含字幕安全区）通过
    const tsx = card.motionCard?.tsx ?? '';
    expect(tsx).toContain('export default');
    const lint = lintMotionCardTsx(tsx);
    expect(lint.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const cues = ENTRIES.map((e) => Math.round(((e.startMs - SEGMENT.startMs) / 1000) * 30));
    const validation = await validateMotionCardTsx(tsx, { cues, checkRenderedLayout: true });
    expect(validation.render.ok).toBe(true);
    expect(validation.issues.filter((i) => i.severity === 'error')).toEqual([]);

    // 3) 设计层：使用了 motion-kit 的节拍锚定（跟口播的根基）
    expect(tsx).toContain('@lingji/motion-kit');
    expect(tsx).toContain('useBeats');
  }, 900_000);
});
