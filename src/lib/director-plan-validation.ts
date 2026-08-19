import {
  resolveDirectorRenderStrategy,
  type DirectorCompositionIntent,
  type DirectorPlan,
  type DirectorSegmentPlan,
} from '../types/director';

export interface DirectorPlanValidationIssue {
  code: string;
  message: string;
  segmentId?: string;
}

function textLength(value: string | undefined): number {
  return Array.from(value?.trim() ?? '').length;
}

function intentComplete(intent: DirectorCompositionIntent | undefined): boolean {
  return Boolean(
    intent?.narrativeGoal.trim()
    && intent.focalPriority.trim()
    && intent.temporalRelationship.trim()
    && Array.isArray(intent.mustShow)
    && Array.isArray(intent.avoid),
  );
}

function selectedAssets(segment: DirectorSegmentPlan) {
  if (segment.compositionAssets?.length) return segment.compositionAssets;
  return segment.selectedFootage
    ? [{ asset: segment.selectedFootage, usage: 'required' as const }]
    : [];
}

function inspectedSelection(segment: DirectorSegmentPlan, assetId: string): boolean {
  return segment.assetDecisions?.some((decision) => (
    decision.candidateId === assetId
    && decision.decision === 'selected'
    && decision.inspected === true
  )) ?? false;
}

/** Approval-time contract shared by the renderer UI and the atomic project mutation. */
export function validateDirectorPlanForApproval(plan: DirectorPlan): DirectorPlanValidationIssue[] {
  const issues: DirectorPlanValidationIssue[] = [];
  const push = (code: string, message: string, segmentId?: string) => {
    issues.push({ code, message, segmentId });
  };

  if (!plan.title?.trim()) push('title-required', '请填写作品标题');
  if (!plan.summary.trim()) push('summary-required', '请填写作品简介');
  if (plan.agentPlanning && !plan.userLocks?.title && (textLength(plan.title) < 8 || textLength(plan.title) > 14)) {
    push('title-length', '作品标题应为 8-14 个字符');
  }
  if (plan.agentPlanning && !plan.userLocks?.summary && (textLength(plan.summary) < 30 || textLength(plan.summary) > 80)) {
    push('summary-length', '作品简介应为 30-80 个字符');
  }
  if (!plan.motionBible.visualThesis.trim()) push('visual-thesis-required', '请填写整片视觉命题');
  if (!plan.coverDirection.prompt.trim()) push('cover-required', '请填写封面方向');
  if (!plan.segments.some((segment) => segment.enabled)) push('enabled-segment-required', '至少保留一个制作镜头');

  const enabled = plan.segments.filter((segment) => segment.enabled);
  for (const segment of enabled) {
    const strategy = resolveDirectorRenderStrategy(segment);
    const assets = selectedAssets(segment);
    const required = assets.filter((binding) => binding.usage === 'required');
    const prefix = `镜头“${segment.title}”`;

    if (!segment.carrier.trim()) push('carrier-required', `${prefix}缺少信息载体`, segment.id);
    if (segment.strategyStatus === 'blocked') {
      push('segment-blocked', `${prefix}仍处于阻塞状态`, segment.id);
    }

    if (strategy === 'motion-card') {
      if (segment.visualType === 'footage') {
        push('motion-footage-invalid', `${prefix}的 Motion 卡不能把视频素材形态标为 footage`, segment.id);
      }
      continue;
    }

    if (segment.visualType !== 'image' && segment.visualType !== 'footage') {
      push('media-visual-type-required', `${prefix}必须明确选择图片或视频素材形态`, segment.id);
    }
    if (strategy === 'standalone-media' && (required.length !== 1 || assets.length !== 1)) {
      push('standalone-asset-required', `${prefix}必须预览并选定一项必用素材`, segment.id);
    }
    if (strategy === 'agent-composite') {
      if (!intentComplete(segment.compositionIntent)) {
        push('composition-intent-required', `${prefix}的合成意图不完整`, segment.id);
      }
      if (!segment.mediaIndispensability?.trim() || !segment.graphicsIndispensability?.trim()) {
        push('dual-indispensability-required', `${prefix}缺少素材与信息层的双重不可替代论证`, segment.id);
      }
      if (required.length === 0) {
        push('composite-asset-required', `${prefix}缺少必用真实素材`, segment.id);
      }
      if (!segment.fallbackPolicy) {
        push('composite-fallback-required', `${prefix}缺少制作失败退路`, segment.id);
      }
    }

    for (const binding of required) {
      const expectedVisualType = binding.asset.kind === 'video' ? 'footage' : 'image';
      if (segment.visualType !== expectedVisualType) {
        push('asset-visual-type-mismatch', `${prefix}的素材形态与必用素材类型不一致`, segment.id);
      }
      if (!inspectedSelection(segment, binding.asset.id)) {
        push('asset-review-required', `${prefix}的必用素材尚未留下预览审阅记录`, segment.id);
      }
    }
  }

  if (plan.agentPlanning) {
    const composites = enabled.filter((segment) => (
      resolveDirectorRenderStrategy(segment) === 'agent-composite'
      && segment.strategyStatus !== 'blocked'
    ));
    if (composites.length === 0 && !plan.zeroCompositeReason?.trim()) {
      push('zero-composite-reason-required', '导演方案没有 Agent 合成镜头，且缺少零组合审计理由');
    }
  }

  return issues;
}

export function firstDirectorPlanApprovalError(plan: DirectorPlan): string | null {
  return validateDirectorPlanForApproval(plan)[0]?.message ?? null;
}
