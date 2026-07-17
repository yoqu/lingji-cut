import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_FIX_ITER,
  MAX_REVIEW_ITER,
  MAX_STORYBOARD_ITER,
  MAX_STORYBOARD_PARSE_RETRY,
  createMotionCardAgentProvider,
  parseReviewVerdict,
  resolveMotionCardModels,
} from '../electron/pipeline/motion-agent-run';
import type { MotionCardAgentContext } from '../src/lib/ai-analysis';
import type { PiAgentRole, PiAgentRoleName } from '../electron/agent-runtime/pi-agents-seed';
import type { AISettings, LLMProvider } from '../src/types/ai';

const VALID_TSX = `import { AbsoluteFill, useCurrentFrame } from 'remotion';
export default function Card({ cues = [] }) {
  const frame = useCurrentFrame();
  return <AbsoluteFill>{frame}</AbsoluteFill>;
}`;

const SAFE_TSX = `import { CardStage, SafeLayout, MotionSlot, useBeats, Kicker, StatHero } from '@lingji/motion-kit';
const TOKENS = { palette: { bg: '#101820', ink: '#fff', muted: '#8996A3', accent: '#4F8CFF' } };
export default function Card({ cues = [] }) {
  const beats = useBeats(cues, [null, 1]);
  return <CardStage tokens={TOKENS}><SafeLayout variant="title-hero">
    <MotionSlot name="header"><Kicker text="考研报名" beat={beats[0]} /></MotionSlot>
    <MotionSlot name="main"><StatHero value={28842} unit="人" beat={beats[1]} /></MotionSlot>
  </SafeLayout></CardStage>;
}`;

/** 合法分镜：cue 单调、数字 28842 在逐字稿中存在。 */
const STORYBOARD = JSON.stringify({
  claim: '硕士报名人数远超博士',
  carrier: 'data-hero',
  layout: 'title-hero',
  scene: '一个大数字与等比配重条',
  elements: [
    { id: 'title', role: 'support', slot: 'header', content: '考研报名', heightRatio: 0.12 },
    { id: 'hero', role: 'focus', slot: 'main', content: '28842 人', heightRatio: 0.42 },
  ],
  capacity: { maxVisible: 2, maxHeightRatio: 0.62 },
  focus: { beat: 1, emphasis: 'countup-settle' },
  beats: [
    { cue: null, kind: 'build', adds: '标题：考研报名', motion: '软落入场', lifecycle: { enter: ['title'] } },
    { cue: 1, kind: 'build', adds: '数字 28842 人', changes: '标题收为辅助', motion: '数字计数到 28842', lifecycle: { enter: ['hero'], collapse: ['title'] } },
  ],
});

const ROLE: Record<string, PiAgentRole> = {
  'card-director': { name: 'card-director', version: '2', tools: [], systemPrompt: '导演' },
  'card-sculptor': { name: 'card-sculptor', version: '2', tools: ['read', 'write', 'edit'], systemPrompt: '雕刻' },
  'card-reviewer': { name: 'card-reviewer', version: '3', tools: [], systemPrompt: '审查' },
};

interface FakeSessionScript {
  /** 按 systemPrompt 区分角色；返回本轮回复文本，可产生副作用（雕刻写文件）。 */
  reply: (role: string, text: string, cwd: string, turn: number) => Promise<string> | string;
}

function makeDeps(script: FakeSessionScript) {
  const prompts: Array<{ role: string; text: string }> = [];
  const sessions: Array<{ role: string; model?: string }> = [];
  const createSession = vi.fn(async (input: { systemPrompt: string; cwd: string; model?: string }) => {
    let turn = 0;
    sessions.push({ role: input.systemPrompt, model: input.model });
    return {
      prompt: async (text: string) => {
        turn += 1;
        prompts.push({ role: input.systemPrompt, text });
        return String(await script.reply(input.systemPrompt, text, input.cwd, turn));
      },
      dispose: vi.fn(),
      abort: vi.fn(),
    };
  });
  return {
    prompts,
    sessions,
    deps: {
      createSession,
      loadRole: async (name: PiAgentRoleName) => ROLE[name],
      ensureConfig: async () => undefined,
      ensureRoles: async () => undefined,
    },
  };
}

function makeCtx(overrides: Partial<MotionCardAgentContext> = {}): MotionCardAgentContext {
  return {
    segmentId: 'seg-1',
    segmentTitle: '测试段',
    buildDirectorPrompt: () => '导演任务书（分镜）',
    buildCardPrompt: (dir) => `出卡任务书；分镜：${dir ?? '无'}`,
    segmentTranscript: '今年考研硕士报名28842人，比博士多得多。',
    cueCount: 3,
    qualityMode: 'director',
    ...overrides,
  };
}

function providerWith(script: FakeSessionScript, extra: Record<string, unknown> = {}) {
  const { prompts, sessions, deps } = makeDeps(script);
  const phases: string[] = [];
  const provider = createMotionCardAgentProvider({
    userDataPath: '/tmp/user-data',
    projectPath: '/tmp/project',
    rolesSeedDir: '/tmp/seed',
    onPhase: (p) => phases.push(p),
    deps,
    ...extra,
  });
  return { provider, prompts, sessions, phases };
}

const writeTsx = (cwd: string, tsx = VALID_TSX) => writeFile(path.join(cwd, 'motionCard.tsx'), tsx, 'utf-8');

describe('parseReviewVerdict', () => {
  it('解析严格 JSON 与带围栏/前后缀的 JSON', () => {
    expect(parseReviewVerdict('{"pass": true, "issues": []}')).toEqual({ pass: true, issues: [] });
    const wrapped = parseReviewVerdict('结论如下\n```json\n{"pass": false, "issues": [{"code":"content-missing","rule": "关键文案缺失"}]}\n```');
    expect(wrapped.pass).toBe(false);
    expect(wrapped.issues[0]?.rule).toBe('关键文案缺失');
  });

  it('无法解析时显式标记审查不可用', () => {
    const verdict = parseReviewVerdict('审查通过，没有问题。');
    expect(verdict.pass).toBe(false);
    expect(verdict.unavailableReason).toContain('未输出 JSON');
    expect(verdict.issues[0]).toMatchObject({
      severity: 'warn',
      code: 'review-unavailable',
    });
  });

  it('审查员误写 pass=true 时，白名单硬错误仍按未通过处理', () => {
    const verdict = parseReviewVerdict('{"pass":true,"issues":[{"code":"focus-missing","severity":"warn","rule":"焦点内容未出现"}]}');
    expect(verdict.pass).toBe(false);
    expect(verdict.issues[0]?.severity).toBe('error');
  });

  it('设计保真问题即使误写 error 也降级为非阻断 warning', () => {
    const verdict = parseReviewVerdict('{"pass":false,"issues":[{"code":"emphasis-mismatch","severity":"error","rule":"slam 未完全兑现"}]}');
    expect(verdict.pass).toBe(true);
    expect(verdict.issues[0]?.severity).toBe('warn');
  });
});

describe('createMotionCardAgentProvider（导演分镜→雕刻→机械质检→审查）', () => {
  it('一次通过：返回 tsx 与规范化分镜 JSON，阶段序列完整', async () => {
    const { provider, phases } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          await writeTsx(cwd);
          return '已写入';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    const validate = vi.fn();
    const result = await provider(makeCtx({ validate }));
    expect(result.tsx).toContain('export default function Card');
    expect(result.animationDirection).toContain('"carrier": "data-hero"');
    expect(validate).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['导演', '雕刻', '验证', '审查']);
  });

  it('雕刻任务书注入了分镜 JSON 与逐字稿', async () => {
    const { provider, prompts } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          await writeTsx(cwd);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    await provider(makeCtx());
    const sculptPrompt = prompts.find((p) => p.role === '雕刻')!.text;
    expect(sculptPrompt).toContain('"claim"');
    expect(sculptPrompt).toContain('28842');
    expect(sculptPrompt).toContain('逐字稿');
    expect(sculptPrompt).toContain('motionCard.tsx');
  });

  it('机械校验返回的 layout warnings 会保留到 productionReport', async () => {
    const { provider } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          await writeTsx(cwd);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    const validate = vi.fn(async () => ({
      ok: true,
      renderOk: true,
      framesChecked: [0, 20, 40],
      issues: [{ severity: 'warning' as const, code: 'possible-occlusion', message: '需复核' }],
    }));
    const result = await provider(makeCtx({ validate }));
    expect(result.productionReport?.layoutIssues).toEqual([
      expect.objectContaining({ source: 'layout', code: 'possible-occlusion' }),
    ]);
  });

  it('机械校验接收真实镜头时长、字幕 TimingPlan 与逐拍探针帧', async () => {
    const { provider } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          await writeTsx(cwd);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    const validate = vi.fn();
    await provider(makeCtx({
      validate,
      timingInput: {
        srt: [
          { index: 1, startMs: 10_000, endMs: 11_000, text: '考研报名' },
          { index: 2, startMs: 12_000, endMs: 13_000, text: '硕士报名28842人' },
        ],
        startMs: 10_000,
        durationMs: 6_000,
        fps: 30,
      },
    }));
    const validationInput = validate.mock.calls[0]?.[1];
    expect(validationInput).toMatchObject({ durationInFrames: 180, cues: [0, 60] });
    expect(validationInput.frames).toEqual(expect.arrayContaining([0, 179]));
    expect(validationInput.frames.length).toBeGreaterThan(3);
  });

  it('导演输出 assets 后先解析资产，再把资产上下文注入雕刻任务书', async () => {
    const baseStoryboard = JSON.parse(STORYBOARD);
    const storyboardWithAssets = JSON.stringify({
      ...baseStoryboard,
      elements: [
        ...baseStoryboard.elements,
        { id: 'archive', role: 'asset', slot: 'asset', assetSlot: 'archive_prop', content: '旧档案袋', heightRatio: 0.25 },
      ],
      capacity: { maxVisible: 3, maxHeightRatio: 0.72 },
      beats: [
        { ...baseStoryboard.beats[0], lifecycle: { enter: ['title', 'archive'] } },
        { ...baseStoryboard.beats[1], lifecycle: { enter: ['hero'], collapse: ['title', 'archive'] } },
      ],
      assets: [
        {
          slot: 'archive_prop',
          query: '旧档案袋',
          role: 'object',
          importance: 'primary',
          reusePolicy: 'generate-if-missing',
          visualTreatment: 'editorial-realist-cutout',
          placementHint: '左下角前景',
        },
      ],
    });
    const resolveAssets = vi.fn(async () => ({
      bindings: [
        {
          slot: 'archive_prop',
          assetId: 'asset-archive',
          filePath: '/tmp/archive.png',
          treatment: {
            profile: 'editorial-realist-cutout' as const,
            lighting: 'soft-left',
            palette: 'low-saturation',
            shadow: 'soft-ground',
            perspective: 'front-3q',
          },
          placement: {
            x: 86,
            y: 330,
            width: 280,
            depth: 'foreground' as const,
          },
        },
      ],
      generationRequests: [],
      unresolved: [],
    }));
    const { provider, prompts, phases } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return storyboardWithAssets;
        if (role === '雕刻') {
          await writeTsx(cwd);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });

    const result = await provider(makeCtx({
      sourceCardId: 'card-asset',
      resolveAssets,
      buildCardPrompt: (_dir, assetBindings) =>
        `出卡任务书；资产：${assetBindings?.map((binding) => binding.slot).join(',') || '无'}`,
    }));

    expect(resolveAssets).toHaveBeenCalledWith({
      requests: expect.arrayContaining([expect.objectContaining({ slot: 'archive_prop' })]),
      sourceCardId: 'card-asset',
      signal: undefined,
    });
    expect(prompts.find((p) => p.role === '雕刻')!.text).toContain('archive_prop');
    expect(result.assetBindings?.[0]?.assetId).toBe('asset-archive');
    expect(phases).toEqual(['导演', '资产生成', '雕刻', '验证', '审查']);
  });

  it('分镜不合法（cue 越界）时回喂导演重出，第二轮通过', async () => {
    const bad = STORYBOARD.replace('"cue":1', '"cue":99');
    let directorTurn = 0;
    const { provider, prompts, phases } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') {
          directorTurn += 1;
          return directorTurn === 1 ? bad : STORYBOARD;
        }
        if (role === '雕刻') {
          await writeTsx(cwd);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    const result = await provider(makeCtx());
    expect(result.animationDirection).toContain('"cue": 1');
    expect(directorTurn).toBe(2);
    expect(phases).toContain(`分镜重出 1/${MAX_STORYBOARD_ITER}`);
    const retryPrompt = prompts.filter((p) => p.role === '导演')[1]!.text;
    expect(retryPrompt).toContain('越界');
  });

  it('分镜编造数字（不在逐字稿中）会被机器校验打回', async () => {
    const fabricated = STORYBOARD.replace(/28842/g, '99999');
    const { provider } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return fabricated;
        if (role === '雕刻') {
          await writeTsx(cwd);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    await expect(provider(makeCtx())).rejects.toThrow(/99999/);
  });

  it('导演持续产出非法分镜时在 MAX_STORYBOARD_ITER 后抛错', async () => {
    const bad = STORYBOARD.replace('"cue":1', '"cue":99');
    const { provider } = providerWith({ reply: (role) => (role === '导演' ? bad : 'ok') });
    await expect(provider(makeCtx())).rejects.toThrow(/机器校验/);
  });

  it('解析失败走独立预算：两轮解析重试后仍有完整语义回喂轮', async () => {
    const bad = STORYBOARD.replace('"cue":1', '"cue":99');
    let directorTurn = 0;
    const replies = ['我先想一想，不输出 JSON', '这是散文回复', bad, STORYBOARD];
    const { provider, prompts } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') {
          directorTurn += 1;
          return replies[directorTurn - 1] ?? STORYBOARD;
        }
        if (role === '雕刻') {
          await writeTsx(cwd);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    const result = await provider(makeCtx());
    expect(result.animationDirection).toContain('"cue": 1');
    expect(directorTurn).toBe(4);
    const parseRetryPrompt = prompts.filter((p) => p.role === '导演')[1]!.text;
    expect(parseRetryPrompt).toContain('只输出一个 JSON');
  });

  it('导演回复始终无法解析时按解析预算抛错（错误信息可区分）', async () => {
    let directorTurn = 0;
    const { provider } = providerWith({
      reply: (role) => {
        if (role === '导演') {
          directorTurn += 1;
          return '我不会输出 JSON';
        }
        return 'ok';
      },
    });
    await expect(provider(makeCtx())).rejects.toThrow(/无法解析/);
    expect(directorTurn).toBe(1 + MAX_STORYBOARD_PARSE_RETRY);
  });

  it('lint 拦截禁用 API 并回喂雕刻修复', async () => {
    let sculptTurn = 0;
    const badTsx = VALID_TSX.replace('{frame}', '{Math.random()}');
    const { provider, prompts } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          sculptTurn += 1;
          await writeTsx(cwd, sculptTurn === 1 ? badTsx : VALID_TSX);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    const validate = vi.fn();
    const result = await provider(makeCtx({ validate }));
    expect(result.tsx).toContain('{frame}');
    expect(sculptTurn).toBe(2);
    const fixPrompt = prompts.filter((p) => p.role === '雕刻')[1]!.text;
    expect(fixPrompt).toContain('banned-random');
    // lint 失败的那一轮不应触发渲染校验
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('渲染校验失败回喂雕刻修复，第二次通过', async () => {
    let sculptTurn = 0;
    const { provider, phases } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          sculptTurn += 1;
          await writeTsx(cwd, sculptTurn === 1 ? VALID_TSX.replace('{frame}', '{bad}') : VALID_TSX);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    const validate = vi.fn(async (tsx: string) => {
      if (tsx.includes('{bad}')) throw new Error('bad is not defined');
    });
    const result = await provider(makeCtx({ validate }));
    expect(result.tsx).toContain('{frame}');
    expect(sculptTurn).toBe(2);
    expect(phases).toContain(`修复 1/${MAX_FIX_ITER}`);
  });

  it('修复轮耗尽后先降级重写一次，仍失败才抛错（无直连回退）', async () => {
    const rescuePrompts: string[] = [];
    const { provider } = providerWith({
      reply: async (role, text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          if (text.includes('降级重写')) rescuePrompts.push(text);
          await writeTsx(cwd);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    const validate = vi.fn(async () => {
      throw new Error('always bad');
    });
    await expect(provider(makeCtx({ validate }))).rejects.toThrow(/降级重写后仍未通过/);
    // 首轮 + MAX_FIX_ITER 轮修复 + 1 轮降级重写 + 1 次确定性兜底尝试（validate 全挂才最终抛错）
    expect(validate).toHaveBeenCalledTimes(1 + MAX_FIX_ITER + 1 + 1);
    expect(rescuePrompts).toHaveLength(1);
    expect(rescuePrompts[0]).toContain('内容原语');
  });

  it('LLM 雕刻彻底失败时确定性兜底出卡（分镜模板渲染，跳过审查）', async () => {
    let reviewerPrompted = 0;
    const { provider, phases } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          await writeTsx(cwd, VALID_TSX.replace('{frame}', '{overflow}'));
          return 'ok';
        }
        reviewerPrompted += 1;
        return '{"pass": true, "issues": []}';
      },
    });
    // 模型产物永远布局失败；兜底模板卡（不含 overflow 标记）可通过
    const validate = vi.fn(async (tsx: string) => {
      if (tsx.includes('{overflow}')) throw new Error('布局越界');
    });
    const result = await provider(makeCtx({ validate }));
    expect(result.tsx).toContain('<CardStage');
    expect(result.tsx).toContain('<Kicker');
    expect(result.tsx).toContain('useBeats');
    expect(phases).toContain('兜底出卡');
    // 兜底卡是确定性模板，直接收尾不进审查
    expect(reviewerPrompted).toBe(0);
  });

  it('降级重写产出通过校验时正常出卡', async () => {
    let sawRescue = false;
    const { provider, phases } = providerWith({
      reply: async (role, text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          if (text.includes('降级重写')) sawRescue = true;
          await writeTsx(cwd, sawRescue ? VALID_TSX : VALID_TSX.replace('{frame}', '{overflow}'));
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    const validate = vi.fn(async (tsx: string) => {
      if (tsx.includes('{overflow}')) throw new Error('布局越界');
    });
    const result = await provider(makeCtx({ validate }));
    expect(result.tsx).toContain('{frame}');
    expect(phases).toContain('简化重写');
  });

  it('审查不通过回炉一轮后通过', async () => {
    let reviewTurn = 0;
    let sculptPrompts = 0;
    const { provider, phases } = providerWith({
      reply: async (role, text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          sculptPrompts += 1;
          if (sculptPrompts > 1) expect(text).toContain('状态演进');
          await writeTsx(cwd);
          return 'ok';
        }
        reviewTurn += 1;
        return reviewTurn === 1
          ? '{"pass": false, "issues": [{"code":"contradictory-state","severity": "error", "rule": "状态演进", "fix": "终态保留矛盾内容"}]}'
          : '{"pass": true, "issues": []}';
      },
    });
    const result = await provider(makeCtx({ validate: vi.fn() }));
    expect(result.tsx).toContain('export default');
    expect(sculptPrompts).toBe(2);
    expect(reviewTurn).toBe(2);
    expect(phases).toContain(`回炉 1/${MAX_REVIEW_ITER}`);
  });

  it('导演模式审查持续不通过时在 MAX_REVIEW_ITER 后触发质量门禁', async () => {
    let reviewTurn = 0;
    const { provider } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          await writeTsx(cwd);
          return 'ok';
        }
        reviewTurn += 1;
        return '{"pass": false, "issues": [{"code":"focus-missing","rule": "焦点内容未出现"}]}';
      },
    });
    await expect(provider(makeCtx({ validate: vi.fn() }))).rejects.toThrow(/质量门禁阻断/);
    expect(reviewTurn).toBe(1 + MAX_REVIEW_ITER);
  });

  it('自动模式审查持续不通过时切换为安全布局兜底卡', async () => {
    const { provider, phases } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          await writeTsx(cwd, SAFE_TSX);
          return 'ok';
        }
        return '{"pass": false, "issues": [{"code":"focus-missing","severity":"error","rule": "焦点内容未出现"}]}';
      },
    });
    const result = await provider(makeCtx({ qualityMode: 'auto', validate: vi.fn() }));
    expect(result.productionReport?.fallbackUsed).toBe(true);
    expect(result.tsx).toContain('<SafeLayout');
    expect(phases).toContain('质量降级');
  });

  it('审查员输入含分镜、机械校验结论与关键帧审片材料', async () => {
    const { provider, prompts } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          await writeTsx(cwd);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    await provider(makeCtx({ validate: vi.fn() }));
    const reviewPrompt = prompts.find((p) => p.role === '审查')!.text;
    expect(reviewPrompt).toContain('storyboard');
    expect(reviewPrompt).toContain('Motion Bible');
    expect(reviewPrompt).toContain('机械校验结论');
    expect(reviewPrompt).toContain('关键帧审片材料');
    expect(reviewPrompt).toContain('frame index');
    expect(reviewPrompt).toContain('设计兑现度');
  });

  it('审查员输出不可解析时不回炉，report 记录审查不可用 warning', async () => {
    let sculptPrompts = 0;
    const { provider } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          sculptPrompts += 1;
          await writeTsx(cwd);
          return 'ok';
        }
        return '审查通过，没有问题。';
      },
    });
    const result = await provider(makeCtx({ validate: vi.fn() }));
    expect(result.tsx).toContain('export default');
    expect(sculptPrompts).toBe(1);
    expect(result.productionReport?.status).toBe('acceptable');
    expect(result.productionReport?.reviewIssues[0]).toMatchObject({
      severity: 'warning',
      code: 'review-unavailable',
    });
    expect(result.productionReport?.unavailableReason).toContain('未输出 JSON');
  });

  it('refine 模式：现有 TSX 进导演诊断上下文并预写入工作目录', async () => {
    const existing = VALID_TSX.replace('Card', 'OldCard');
    const { provider, prompts } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          await writeTsx(cwd);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    await provider(makeCtx({ existingTsx: existing }));
    const directorPrompt = prompts.find((p) => p.role === '导演')!.text;
    expect(directorPrompt).toContain('OldCard');
    const sculptPrompt = prompts.find((p) => p.role === '雕刻')!.text;
    expect(sculptPrompt).toContain('edit 工具');
  });

  it('用户已有草案进导演创作约束', async () => {
    const { provider, prompts } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          await writeTsx(cwd);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    await provider(makeCtx({ animationDirectionDraft: '用数字大卡呈现' }));
    const directorPrompt = prompts.find((p) => p.role === '导演')!.text;
    expect(directorPrompt).toContain('用数字大卡呈现');
  });

  it('合法 storyboard 草案默认仍会重新导演', async () => {
    const { provider, sessions, phases, prompts } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          await writeTsx(cwd);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    const result = await provider(makeCtx({ animationDirectionDraft: STORYBOARD, validate: vi.fn() }));
    expect(result.animationDirection).toContain('"carrier": "data-hero"');
    expect(phases).not.toContain('复用分镜');
    expect(phases[0]).toBe('导演');
    expect(sessions.map((s) => s.role)).toContain('导演');
    expect(prompts.some((p) => p.role === '导演')).toBe(true);
  });

  it('显式 reuseStoryboardDraft 时，合法 storyboard 草案会跳过导演', async () => {
    const { provider, sessions, phases, prompts } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '雕刻') {
          await writeTsx(cwd);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    const result = await provider(makeCtx({
      animationDirectionDraft: STORYBOARD,
      reuseStoryboardDraft: true,
      validate: vi.fn(),
    }));
    expect(result.animationDirection).toContain('"carrier": "data-hero"');
    expect(phases).toContain('复用分镜');
    expect(sessions.map((s) => s.role)).toEqual(['雕刻', '审查']);
    expect(prompts.some((p) => p.role === '导演')).toBe(false);
  });

  it('abort 信号已触发时立即失败', async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider } = providerWith({ reply: () => '不应到达' }, { signal: controller.signal });
    await expect(provider(makeCtx())).rejects.toThrow(/取消/);
  });

  it('观测事件：phase/审查里程碑/done 按序发出，携带卡片键与标签', async () => {
    const events: Array<{ role: string; kind: string; text?: string; cardKey: string; cardLabel?: string }> = [];
    let reviewTurn = 0;
    const { provider } = providerWith(
      {
        reply: async (role, _text, cwd) => {
          if (role === '导演') return STORYBOARD;
          if (role === '雕刻') {
            await writeTsx(cwd);
            return 'ok';
          }
          reviewTurn += 1;
          return reviewTurn === 1
            ? '{"pass": false, "issues": [{"code":"contradictory-state","rule": "状态演进"}]}'
            : '{"pass": true, "issues": []}';
        },
      },
      { onAgentEvent: (ev: { role: string; kind: string; text?: string; cardKey: string; cardLabel?: string }) => events.push(ev) },
    );
    await provider(makeCtx({ validate: vi.fn(), label: '硕士报名人数' }));
    expect(events.every((e) => e.cardKey === 'seg-1' && e.cardLabel === '硕士报名人数')).toBe(true);
    const phases = events.filter((e) => e.kind === 'phase').map((e) => e.text);
    expect(phases).toContain('导演');
    expect(phases).toContain('雕刻');
    expect(events.some((e) => e.kind === 'milestone' && e.text?.includes('审查未通过'))).toBe(true);
    expect(events.some((e) => e.kind === 'milestone' && e.text === '审查通过')).toBe(true);
    expect(events[events.length - 1]).toMatchObject({ kind: 'done', role: 'orchestrator' });
  });

  it('观测事件：生成失败时发 error 事件后再抛错', async () => {
    const events: Array<{ kind: string; text?: string }> = [];
    const { provider } = providerWith(
      { reply: (role) => (role === '导演' ? '我不会输出 JSON' : 'ok') },
      { onAgentEvent: (ev: { kind: string; text?: string }) => events.push(ev) },
    );
    await expect(provider(makeCtx())).rejects.toThrow(/无法解析/);
    const last = events[events.length - 1];
    expect(last.kind).toBe('error');
    expect(last.text).toContain('无法解析');
  });

  it('观测事件：角色会话注入 onEvent，流式文本按角色转发', async () => {
    const events: Array<{ role: string; kind: string; text?: string }> = [];
    const captured: Array<{ systemPrompt: string; onEvent?: (ev: unknown) => void }> = [];
    const { deps } = makeDeps({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          await writeTsx(cwd);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    const inner = deps.createSession;
    const provider = createMotionCardAgentProvider({
      userDataPath: '/tmp/user-data',
      projectPath: '/tmp/project',
      rolesSeedDir: '/tmp/seed',
      onAgentEvent: (ev) => events.push(ev as never),
      deps: {
        ...deps,
        createSession: async (input) => {
          captured.push(input as never);
          return inner(input as never);
        },
      },
    });
    await provider(makeCtx({ validate: vi.fn() }));
    // 三个角色会话都注入了 onEvent
    expect(captured.filter((c) => typeof c.onEvent === 'function')).toHaveLength(3);
    // 模拟导演会话吐流式文本 → 转发为 director 的 text 事件
    captured[0].onEvent!({ type: 'text_delta', delta: '分镜草稿' });
    expect(events.some((e) => e.role === 'director' && e.kind === 'text' && e.text === '分镜草稿')).toBe(true);
    // 模拟雕刻工具调用 → tool_use 事件
    captured[1].onEvent!({ type: 'tool_use', id: 't1', name: 'write', input: { path: 'motionCard.tsx' } });
    expect(events.some((e) => e.role === 'sculptor' && e.kind === 'tool_use')).toBe(true);
  });

  it('会话级模型下发：导演用 directorModel，雕刻/审查用 sculptorModel', async () => {
    const { provider, sessions } = providerWith(
      {
        reply: async (role, _text, cwd) => {
          if (role === '导演') return STORYBOARD;
          if (role === '雕刻') {
            await writeTsx(cwd);
            return 'ok';
          }
          return '{"pass": true, "issues": []}';
        },
      },
      { directorModel: 'px/anim-model', sculptorModel: 'px/card-model' },
    );
    await provider(makeCtx({ validate: vi.fn() }));
    expect(sessions.find((s) => s.role === '导演')?.model).toBe('px/anim-model');
    expect(sessions.find((s) => s.role === '雕刻')?.model).toBe('px/card-model');
    expect(sessions.find((s) => s.role === '审查')?.model).toBe('px/card-model');
  });

  it('未配置会话模型时透传 undefined（跟随 pi 默认）', async () => {
    const { provider, sessions } = providerWith({
      reply: async (role, _text, cwd) => {
        if (role === '导演') return STORYBOARD;
        if (role === '雕刻') {
          await writeTsx(cwd);
          return 'ok';
        }
        return '{"pass": true, "issues": []}';
      },
    });
    await provider(makeCtx({ validate: vi.fn() }));
    expect(sessions.every((s) => s.model === undefined)).toBe(true);
  });
});

describe('resolveMotionCardModels（提示词绑定 → 会话模型）', () => {
  const grok: LLMProvider = {
    id: 'gk', name: 'Grok', type: 'openai_compatible',
    baseUrl: 'https://grok.example/v1', apiKey: 'sk', models: ['grok-composer-2.5-fast'],
  };
  const doubao: LLMProvider = {
    id: 'db', name: 'doubao', type: 'openai_compatible',
    baseUrl: 'https://ark.example/v3', apiKey: 'sk', models: ['Doubao-Seed-2.0-Code'],
  };
  const baseSettings = (): AISettings => ({
    llmProviders: [grok, doubao],
    imageProviders: [], videoProviders: [],
    defaultProviderId: 'db', defaultModel: 'Doubao-Seed-2.0-Code',
    promptBindings: {},
  }) as unknown as AISettings;

  it('cards.animation → directorModel，cards.segment → sculptorModel', () => {
    const s = baseSettings();
    s.promptBindings = {
      'cards.animation': { providerId: 'gk', model: 'grok-composer-2.5-fast' },
      'cards.segment': { providerId: 'gk', model: 'grok-composer-2.5-fast' },
    } as never;
    expect(resolveMotionCardModels(s, null)).toEqual({
      directorModel: 'gk/grok-composer-2.5-fast',
      sculptorModel: 'gk/grok-composer-2.5-fast',
    });
  });

  it('未绑定时回退全局默认 provider/model（仍产出 ref，不 undefined）', () => {
    expect(resolveMotionCardModels(baseSettings(), null)).toEqual({
      directorModel: 'db/Doubao-Seed-2.0-Code',
      sculptorModel: 'db/Doubao-Seed-2.0-Code',
    });
  });

  it('绑定模型不在 provider 列表时吞掉异常返回 undefined（跟随 pi 默认）', () => {
    const s = baseSettings();
    s.promptBindings = {
      'cards.segment': { providerId: 'gk', model: '不存在的模型' },
    } as never;
    expect(resolveMotionCardModels(s, null).sculptorModel).toBeUndefined();
  });
});

describe('观测事件：结构化 stage/round 与模型标注', () => {
  it('phase 事件带 stage', async () => {
    const feed: Array<Record<string, unknown>> = [];
    const { provider } = providerWith(
      {
        reply: async (role, _text, cwd) => {
          if (role === '导演') return STORYBOARD;
          if (role === '雕刻') { await writeTsx(cwd); return 'ok'; }
          return '{"pass": true, "issues": []}';
        },
      },
      { onAgentEvent: (ev: Record<string, unknown>) => feed.push(ev) },
    );
    await provider(makeCtx());

    const phases = feed.filter((e) => e.kind === 'phase').map((e) => [e.text, e.stage]);
    expect(phases).toEqual([
      ['导演', 'director'],
      ['雕刻', 'sculpt'],
      ['验证', 'mechqa'],
      ['审查', 'review'],
    ]);
  });

  it('修复等重试 phase 带 round', async () => {
    const feedRounds: Array<Record<string, unknown>> = [];
    let sculptTurn = 0;
    const { provider } = providerWith(
      {
        reply: async (role, _text, cwd) => {
          if (role === '导演') return STORYBOARD;
          if (role === '雕刻') {
            sculptTurn += 1;
            // 第一轮写坏卡（缺 export default），第二轮修好 → 触发一次 修复 1/N
            await writeTsx(cwd, sculptTurn === 1 ? 'const x = 1;' : VALID_TSX);
            return 'ok';
          }
          return '{"pass": true, "issues": []}';
        },
      },
      { onAgentEvent: (ev: Record<string, unknown>) => feedRounds.push(ev) },
    );
    await provider(makeCtx());
    const fix = feedRounds.find((e) => e.kind === 'phase' && String(e.text).startsWith('修复'));
    expect(fix).toMatchObject({ stage: 'mechqa', round: 1 });
  });

  it('角色流事件携带各自会话的 model', async () => {
    const feed: Array<Record<string, unknown>> = [];
    const roles: Record<string, { name: string; version: string; tools: string[]; systemPrompt: string }> = {
      'card-director': { name: 'card-director', version: '2', tools: [], systemPrompt: '导演' },
      'card-sculptor': { name: 'card-sculptor', version: '2', tools: ['read', 'write', 'edit'], systemPrompt: '雕刻' },
      'card-reviewer': { name: 'card-reviewer', version: '3', tools: [], systemPrompt: '审查' },
    };
    const deps = {
      createSession: async (input: {
        systemPrompt: string;
        cwd: string;
        model?: string;
        onEvent?: (ev: unknown) => void;
      }) => ({
        prompt: async (_text: string) => {
          input.onEvent?.({ type: 'text_delta', delta: 'x' });
          if (input.systemPrompt === '导演') return STORYBOARD;
          if (input.systemPrompt === '雕刻') { await writeTsx(input.cwd); return 'ok'; }
          return '{"pass": true, "issues": []}';
        },
        dispose: () => {},
        abort: () => {},
      }),
      loadRole: async (name: string) => roles[name],
      ensureConfig: async () => undefined,
      ensureRoles: async () => undefined,
    };
    const provider = createMotionCardAgentProvider({
      userDataPath: '/tmp/user-data',
      projectPath: '/tmp/project',
      rolesSeedDir: '/tmp/seed',
      directorModel: 'prov/dir-model',
      sculptorModel: 'prov/sculpt-model',
      onAgentEvent: (ev) => feed.push(ev as Record<string, unknown>),
      deps: deps as never,
    });
    await provider(makeCtx());
    const byRole = (role: string) => feed.filter((e) => e.role === role && e.kind === 'text');
    expect(byRole('director')[0]).toMatchObject({ model: 'prov/dir-model' });
    expect(byRole('sculptor')[0]).toMatchObject({ model: 'prov/sculpt-model' });
    expect(byRole('reviewer')[0]).toMatchObject({ model: 'prov/sculpt-model' });
  });
});

describe('production report contact sheet', () => {
  it('启用 contactSheetCacheDir 时生成并记录 PNG 缓存路径', async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'lingji-agent-sheet-'));
    const { provider } = providerWith(
      {
        reply: async (role, _text, cwd) => {
          if (role === '导演') return STORYBOARD;
          if (role === '雕刻') {
            await writeTsx(cwd);
            return 'ok';
          }
          return '{"pass": true, "issues": []}';
        },
      },
      { contactSheetCacheDir: cacheDir },
    );
    const result = await provider(makeCtx());
    expect(result.productionReport?.contactSheetCacheKey).toMatch(/^[a-f0-9]{24}$/);
    expect(result.productionReport?.contactSheetPath).toContain(cacheDir);
    expect(result.productionReport?.contactSheetCached).toBe(false);
    expect(result.productionReport?.contactSheetError).toBeUndefined();
  }, 120_000);
});
