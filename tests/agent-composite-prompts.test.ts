import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPT_YAML, PROMPT_KIND_META } from '../src/lib/prompts';

describe('Agent 原子合成提示词契约', () => {
  it('cards.animation 与 cards.segment 暴露同一 compositionContract 变量', () => {
    for (const kind of ['cards.animation', 'cards.segment'] as const) {
      expect(DEFAULT_PROMPT_YAML[kind]).toContain('{{compositionContract}}');
      expect(PROMPT_KIND_META[kind].variables.some((variable) => variable.name === 'compositionContract')).toBe(true);
    }
  });

  it('标准 Motion Card 保持 SafeLayout，原子合成才允许自由整帧布局', () => {
    const segment = DEFAULT_PROMPT_YAML['cards.segment'];
    expect(segment).toContain('标准 Motion Card 的根节点固定 <CardStage');
    expect(segment).toContain('禁止自由 absolute 定位');
    expect(segment).toContain('若上方契约明确为 Agent 原子合成');
    expect(segment).toContain('AbsoluteFill / absolute / clipPath / mask / transform');
  });

  it('三个角色只在原子合成契约下启用冻结素材规则', () => {
    const readRole = (name: string) => readFileSync(
      new URL(`../resources/pi-agents/agents/${name}.md`, import.meta.url),
      'utf8',
    );
    const director = readRole('card-director');
    const sculptor = readRole('card-sculptor');
    const reviewer = readRole('card-reviewer');

    expect(director).toContain('素材池已在批准时冻结');
    expect(director).toContain('不得新增 `assets`');
    expect(sculptor).toContain('普通 Motion Card 必须使用 `CardStage > SafeLayout > MotionSlot`');
    expect(sculptor).toContain('所有 `required` 素材都必须以 `<BoundMedia');
    expect(reviewer).toContain('逐项对照冻结素材清单、TSX 与 contact sheet');
    expect(reviewer).toContain('`content-missing` 硬错误');
    expect(reviewer).toContain('必须填写顶层 `unavailableReason`');
    expect(reviewer).toContain('至少给出一条 `visual-unverified` warn');
    expect(reviewer).toContain('必须省略顶层 `unavailableReason`');
  });

  it('桌面精雕与 headless 精雕都会复用已批准的分镜草案', () => {
    const desktopIpc = readFileSync(
      new URL('../electron/ai-generation-ipc.ts', import.meta.url),
      'utf8',
    );
    const headlessCardRun = readFileSync(
      new URL('../electron/pipeline/runs/card-run.ts', import.meta.url),
      'utf8',
    );

    expect(desktopIpc).toContain('reuseStoryboardDraft: args.refineExistingMotion === true');
    expect(headlessCardRun).toContain('reuseStoryboardDraft: refineExistingMotion');
    expect(desktopIpc).toContain(
      'const approvedSegment = requireExactApprovedDirectorSegment(project.production, args.segment);',
    );
    expect(desktopIpc).toContain(
      'regenerateAICard(args.entries, args.card, approvedSegment, args.settings, {',
    );
    expect(headlessCardRun).toContain(
      '? requireExactApprovedDirectorSegment(data.production, requestedSegment)',
    );
    expect(headlessCardRun).toContain(
      'regenerate(l.entries, l.card, l.segment, l.settings, opts)',
    );
  });

  it('桌面单次分镜入口必须经过批准镜头上下文，不能直接使用调用方镜头', () => {
    const desktopIpc = readFileSync(
      new URL('../electron/ai-generation-ipc.ts', import.meta.url),
      'utf8',
    );

    expect(desktopIpc).toContain('requireApprovedAnimationDirectionContext(');
    expect(desktopIpc).toContain('          approvedSegment,\n          args.settings,');
    expect(desktopIpc).toContain('...directorContext');
  });
});
