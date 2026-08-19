import type {
  DirectorCompositionIntent,
  DirectorFallbackPolicy,
  DirectorPlan,
  DirectorRenderStrategy,
  DirectorSegmentPlan,
  ProjectProductionState,
} from '../types/director';
import {
  resolveDirectorFallbackPolicy,
  resolveDirectorRenderStrategy,
} from '../types/director';
import type { FootageCompositionInput } from '../types/footage';
import type { AISegment } from '../types/ai';

export interface ApprovedCardRegenerationContext {
  renderStrategy: DirectorRenderStrategy;
  compositionIntent?: DirectorCompositionIntent;
  compositionInputs: FootageCompositionInput[];
  fallbackPolicy: DirectorFallbackPolicy;
}

export type ApprovedCardRegenerationOverrides = Partial<ApprovedCardRegenerationContext> & {
  /** 仅供导演制作链路执行已批准的 motion 退路，不能作为普通策略覆盖。 */
  approvedFallbackExecution?: 'motion';
};

export class ApprovedDirectorSegmentMismatchError extends Error {
  readonly code = 'approved_director_segment_mismatch';

  constructor(segmentId: string, detail?: string) {
    super(
      detail
        ? `镜头 ${segmentId} 与已批准导演方案不一致：${detail}`
        : `已批准导演方案中不存在镜头 ${segmentId}，已停止生成以避免绕过导演方案。`,
    );
    this.name = 'ApprovedDirectorSegmentMismatchError';
  }
}

export class AgentCompositeStoryboardRegenerationError extends Error {
  readonly code = 'agent_composite_storyboard_requires_pi';

  constructor(segmentId: string) {
    super(
      `镜头 ${segmentId} 是已批准的 Agent 合成镜头，分镜、冻结素材与 Remotion 源码必须由 Pi Agent 整体重生成或精雕。`,
    );
    this.name = 'AgentCompositeStoryboardRegenerationError';
  }
}

interface ApprovedRegenerationSource {
  plan: DirectorPlan;
  segment: DirectorSegmentPlan;
  segmentIndex: number;
  persistedInputs: FootageCompositionInput[];
  footageCurrent: boolean;
}

function expectedFootageFingerprint(plan: DirectorPlan): string {
  return `footage-${plan.inputFingerprint}-${plan.revision}`;
}

function resolveApprovedSource(
  production: ProjectProductionState | null | undefined,
  segmentId: string,
): ApprovedRegenerationSource | null {
  const plan = production?.approvedPlan;
  if (!plan?.approvedAt) return null;
  const segmentIndex = plan.segments.findIndex((item) => item.id === segmentId);
  if (segmentIndex < 0) return null;
  const footage = production?.footage;
  const output = production?.outputs?.footage;
  const footageCurrent = Boolean(
    footage
    && output?.status === 'current'
    && output.directorRevision === plan.revision
    && footage.generationProvenance?.directorRevision === plan.revision
    && footage.generationProvenance.fingerprint === expectedFootageFingerprint(plan),
  );
  return {
    plan,
    segment: plan.segments[segmentIndex],
    segmentIndex,
    persistedInputs: footageCurrent
      ? (footage?.compositionInputs ?? []).filter((input) => input.segmentId === segmentId)
      : [],
    footageCurrent,
  };
}

function normalizedTrimStartMs(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value ?? 0)) : 0;
}

function inputMatchesApprovedAsset(
  input: FootageCompositionInput,
  approved: NonNullable<DirectorSegmentPlan['compositionAssets']>[number],
): boolean {
  return input.asset.id === approved.asset.id
    && input.asset.path === approved.asset.path
    && input.asset.kind === approved.asset.kind
    && input.usage === approved.usage
    && normalizedTrimStartMs(input.trimStartMs) === normalizedTrimStartMs(approved.trimStartMs);
}

function inputMatchesFrozenInput(
  input: FootageCompositionInput,
  frozen: FootageCompositionInput,
): boolean {
  return inputMatchesApprovedAsset(input, frozen)
    && input.segmentId === frozen.segmentId
    && input.segmentIndex === frozen.segmentIndex
    && input.startMs === frozen.startMs
    && input.durationMs === frozen.durationMs
    && input.fileFingerprint === frozen.fileFingerprint;
}

function compositionIntentMatches(
  left: DirectorCompositionIntent | undefined,
  right: DirectorCompositionIntent | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.narrativeGoal === right.narrativeGoal
    && left.focalPriority === right.focalPriority
    && left.temporalRelationship === right.temporalRelationship
    && JSON.stringify(left.mustShow) === JSON.stringify(right.mustShow)
    && JSON.stringify(left.avoid) === JSON.stringify(right.avoid);
}

/** 校验调用方镜头身份并返回批准方案中的规范镜头，避免同 ID 篡改时间码或正文。 */
export function requireExactApprovedDirectorSegment(
  production: ProjectProductionState | null | undefined,
  requested: AISegment,
): DirectorSegmentPlan {
  const source = resolveApprovedSource(production, requested.id);
  if (!source) throw new ApprovedDirectorSegmentMismatchError(requested.id);
  if (
    requested.startMs !== source.segment.startMs
    || requested.endMs !== source.segment.endMs
  ) {
    throw new ApprovedDirectorSegmentMismatchError(requested.id, '请求时间码与已批准镜头不一致');
  }
  if (
    requested.title !== source.segment.title
    || requested.summary !== source.segment.summary
    || (requested.transcriptExcerpt ?? '') !== (source.segment.transcriptExcerpt ?? '')
    || (requested.semanticType ?? null) !== (source.segment.semanticType ?? null)
  ) {
    throw new ApprovedDirectorSegmentMismatchError(requested.id, '请求内容与已批准镜头不一致');
  }
  return source.segment;
}

/** 从已批准导演方案恢复单卡制作契约，避免重生成绕过导演决策。 */
export function resolveApprovedCardRegenerationContext(
  production: ProjectProductionState | null | undefined,
  segmentId: string,
): ApprovedCardRegenerationContext | null {
  const source = resolveApprovedSource(production, segmentId);
  if (!source) return null;

  return {
    renderStrategy: resolveDirectorRenderStrategy(source.segment),
    compositionIntent: source.segment.compositionIntent,
    compositionInputs: source.persistedInputs,
    fallbackPolicy: resolveDirectorFallbackPolicy(source.segment),
  };
}

/**
 * 严格恢复已批准镜头契约。显式输入只能是 current 素材产物的严格子集，
 * 不允许调用方用自报路径或文件指纹绕过已落盘的 revision / provenance。
 */
export function requireApprovedCardRegenerationContext(
  production: ProjectProductionState | null | undefined,
  segmentId: string,
  overrides: ApprovedCardRegenerationOverrides = {},
): ApprovedCardRegenerationContext {
  const source = resolveApprovedSource(production, segmentId);
  if (!source) throw new ApprovedDirectorSegmentMismatchError(segmentId);
  const approved: ApprovedCardRegenerationContext = {
    renderStrategy: resolveDirectorRenderStrategy(source.segment),
    compositionIntent: source.segment.compositionIntent,
    compositionInputs: source.persistedInputs,
    fallbackPolicy: resolveDirectorFallbackPolicy(source.segment),
  };

  const approvedMotionFallback = Boolean(
    overrides.approvedFallbackExecution === 'motion'
    && approved.renderStrategy === 'agent-composite'
    && approved.fallbackPolicy === 'motion'
    && overrides.renderStrategy === 'motion-card'
    && overrides.fallbackPolicy === 'block'
    && Array.isArray(overrides.compositionInputs)
    && overrides.compositionInputs.length === 0,
  );
  if (overrides.approvedFallbackExecution && !approvedMotionFallback) {
    throw new ApprovedDirectorSegmentMismatchError(
      segmentId,
      '执行退路与已批准的 Agent 合成 motion 退路不一致',
    );
  }

  if (
    !approvedMotionFallback
    && overrides.renderStrategy
    && overrides.renderStrategy !== approved.renderStrategy
  ) {
    throw new ApprovedDirectorSegmentMismatchError(segmentId, '重生成请求试图覆盖已批准执行策略');
  }
  if (
    !approvedMotionFallback
    && overrides.fallbackPolicy
    && overrides.fallbackPolicy !== approved.fallbackPolicy
  ) {
    throw new ApprovedDirectorSegmentMismatchError(segmentId, '重生成请求试图覆盖已批准失败退路');
  }
  if (
    overrides.compositionIntent
    && !compositionIntentMatches(overrides.compositionIntent, approved.compositionIntent)
  ) {
    throw new ApprovedDirectorSegmentMismatchError(segmentId, '重生成请求试图覆盖已批准合成意图');
  }

  const hasInputOverride = overrides.compositionInputs !== undefined;
  const hasFreshInputs = (overrides.compositionInputs?.length ?? 0) > 0;
  if (
    (approved.renderStrategy === 'agent-composite' || hasFreshInputs)
    && !source.footageCurrent
  ) {
    throw new ApprovedDirectorSegmentMismatchError(
      segmentId,
      '当前导演版本的素材产物尚未就绪，请先完成素材冻结',
    );
  }

  const compositionInputs = hasInputOverride
    ? overrides.compositionInputs ?? []
    : approved.compositionInputs;
  const mismatchedInput = compositionInputs.find((input) => input.segmentId !== segmentId);
  if (mismatchedInput) {
    throw new ApprovedDirectorSegmentMismatchError(
      segmentId,
      `组合素材属于镜头 ${mismatchedInput.segmentId}`,
    );
  }
  const expectedStartMs = source.segment.startMs;
  const expectedDurationMs = source.segment.endMs - source.segment.startMs;
  const mistimedInput = compositionInputs.find((input) => (
    input.segmentIndex !== source.segmentIndex
    || input.startMs !== expectedStartMs
    || input.durationMs !== expectedDurationMs
  ));
  if (mistimedInput) {
    throw new ApprovedDirectorSegmentMismatchError(
      segmentId,
      `组合素材 ${mistimedInput.asset.id} 的镜头时间范围不一致`,
    );
  }
  const unfrozenInput = compositionInputs.find((input) => !input.fileFingerprint?.trim());
  if (unfrozenInput) {
    throw new ApprovedDirectorSegmentMismatchError(
      segmentId,
      `组合素材 ${unfrozenInput.asset.id} 缺少冻结文件指纹`,
    );
  }

  const approvedAssets = source.segment.compositionAssets ?? [];
  const frozenReferences = source.persistedInputs;
  const unapprovedInput = compositionInputs.find((input) => (
    !frozenReferences.some((frozen) => inputMatchesFrozenInput(input, frozen))
  ));
  if (unapprovedInput) {
    throw new ApprovedDirectorSegmentMismatchError(
      segmentId,
      `组合素材 ${unapprovedInput.asset.id} 不在已批准素材绑定中`,
    );
  }

  const missingRequired = approvedMotionFallback
    ? undefined
    : approvedAssets.find((binding) => (
        binding.usage === 'required'
        && !compositionInputs.some((input) => inputMatchesApprovedAsset(input, binding))
      ));
  if (missingRequired) {
    throw new ApprovedDirectorSegmentMismatchError(
      segmentId,
      `必用组合素材 ${missingRequired.asset.id} 未包含在重生成输入中`,
    );
  }

  return {
    renderStrategy: approvedMotionFallback ? 'motion-card' : approved.renderStrategy,
    compositionIntent: approved.compositionIntent,
    compositionInputs,
    fallbackPolicy: approvedMotionFallback ? 'block' : approved.fallbackPolicy,
  };
}

/**
 * 旧的单次文本分镜入口只服务标准 Motion Card。Agent 合成必须让 Pi 同时维护
 * 分镜、冻结素材绑定与 Remotion 源码，不能单独替换其中一个产物。
 */
export function requireApprovedAnimationDirectionContext(
  production: ProjectProductionState | null | undefined,
  requested: AISegment,
): { segment: DirectorSegmentPlan; context: ApprovedCardRegenerationContext } {
  const segment = requireExactApprovedDirectorSegment(production, requested);
  const context = requireApprovedCardRegenerationContext(production, segment.id);
  if (context.renderStrategy === 'agent-composite') {
    throw new AgentCompositeStoryboardRegenerationError(segment.id);
  }
  return { segment, context };
}
