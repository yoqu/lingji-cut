/**
 * apply-card-storyboard —— Inspector 分镜编辑的唯一出口。
 *
 * 模板编译产物（productionReport.compiled）或尚无动画的卡：由分镜确定性重编译 TSX，
 * 保存后预览链路（compileMotionCards → compiledCards）自动热更新；
 * LLM 精雕产物：只落盘分镜草案，动画替换必须走精雕管线，避免静默覆盖精修结果。
 */
import type { AICard } from '../types/ai';
import type { MotionStoryboard } from './motion-storyboard';
import { compileMotionCardFromStoryboard } from './motion-card-templates';
import { lintMotionCardTsx } from './motion-card-lint';
import { buildMotionCardProductionReport } from './motion-production-report';
import { getMotionTokensBlock } from './card-style';

export type StoryboardApplyResult =
  | { mode: 'recompiled'; updates: Partial<AICard> }
  | { mode: 'needs-sculpt'; updates: Partial<AICard> };

/** 动画是否可由分镜确定性重编译；精雕产物返回 false。 */
export function canRecompileFromStoryboard(card: AICard): boolean {
  const motion = card.motionCard;
  if (!motion?.tsx?.trim()) return true;
  return motion.productionReport?.compiled === true;
}

export function applyStoryboardToCard(
  card: AICard,
  storyboard: MotionStoryboard,
  stylePresetId?: string | null,
): StoryboardApplyResult {
  const animationDirection = JSON.stringify(storyboard, null, 2);
  const baseMotion = card.motionCard ?? { compiledAt: 0, prompt: card.cardPrompt ?? '', retryCount: 0 };

  if (!canRecompileFromStoryboard(card)) {
    return {
      mode: 'needs-sculpt',
      updates: { animationDirection, motionCard: { ...baseMotion, storyboard } },
    };
  }

  const tokens = getMotionTokensBlock(stylePresetId ?? card.stylePresetId);
  const tsx = compileMotionCardFromStoryboard(storyboard, tokens, {
    assetsResolved: Boolean(card.assetBindings?.length),
  });
  const lint = lintMotionCardTsx(tsx);
  if (!lint.ok) {
    const errors = lint.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.message)
      .join('；');
    throw new Error(`分镜模板编译未通过静态检查：${errors || '未知错误'}`);
  }

  return {
    mode: 'recompiled',
    updates: {
      animationDirection,
      renderMode: 'motion-card',
      motionCard: {
        ...baseMotion,
        tsx,
        compiledAt: Date.now(),
        compileError: undefined,
        storyboard,
        productionReport: buildMotionCardProductionReport({
          compiled: true,
          lintIssues: lint.issues,
          renderOk: true,
          visualReviewAvailable: false,
          unavailableReason: '编辑器内模板重编译：跳过布局探针与 LLM 审查。',
        }),
      },
    },
  };
}
