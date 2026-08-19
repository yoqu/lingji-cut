import type { ProjectData } from './project-persistence';
import type { TimelineData } from '../types';
import {
  buildAICardTimelineDraft,
  type AICard,
  type AICardOverlayData,
} from '../types/ai';
import {
  resolveDirectorFallbackPolicy,
  resolveDirectorRenderStrategy,
  type DirectorSegmentPlan,
  type ProductionOutputKey,
} from '../types/director';
import type { ProductionQualityIssue, ProductionQualityReport } from '../types/production';

export interface ProductionQualityFingerprintAudit {
  /** Keyed by the persisted path, not the resolved absolute path. */
  currentByPath: ReadonlyMap<string, string | null>;
}

interface FrozenMediaAsset {
  path: string;
  fingerprint?: string;
  label: string;
  shotId?: string;
}

function collectFrozenMediaAssets(project: ProjectData): FrozenMediaAsset[] {
  const footage = project.production?.footage;
  const segments = new Map(
    (project.production?.approvedPlan?.segments ?? []).map((segment) => [segment.id, segment]),
  );
  const cards = new Map(
    (project.aiAnalysis.analysisResult?.cards ?? []).map((card) => [card.segmentId, card]),
  );
  const usesCompositeMedia = (segmentId: string): boolean => {
    const card = cards.get(segmentId);
    if (!card || card.renderStrategy !== 'agent-composite') return false;
    const segment = segments.get(segmentId);
    return !(
      card.motionCard?.productionReport?.fallbackUsed
      && segment
      && resolveDirectorFallbackPolicy(segment) !== 'block'
    );
  };
  const assets: FrozenMediaAsset[] = [
    ...(footage?.placements ?? []).map((placement) => ({
      path: placement.sourcePath,
      fingerprint: placement.fileFingerprint,
      label: `独立素材 ${placement.sourcePath}`,
      shotId: placement.segmentId,
    })),
    ...(footage?.compositionInputs ?? [])
      .filter((input) => usesCompositeMedia(input.segmentId))
      .map((input) => ({
        path: input.asset.path,
        fingerprint: input.fileFingerprint,
        label: `组合素材 ${input.asset.filename}`,
        shotId: input.segmentId,
      })),
  ];
  for (const card of cards.values()) {
    if (card.renderStrategy !== 'agent-composite') continue;
    const segment = segments.get(card.segmentId);
    if (
      card.motionCard?.productionReport?.fallbackUsed
      && segment
      && resolveDirectorFallbackPolicy(segment) !== 'block'
    ) continue;
    for (const binding of card.assetBindings ?? []) {
      assets.push({
        path: binding.filePath,
        fingerprint: binding.fileFingerprint,
        label: `组合素材 ${binding.request?.query ?? binding.slot}`,
        shotId: card.id,
      });
    }
  }
  return assets.filter((asset) => Boolean(asset.path?.trim()));
}

export function collectProductionFingerprintPaths(project: ProjectData): string[] {
  return [...new Set(collectFrozenMediaAssets(project).map((asset) => asset.path))];
}

function frozenMediaIssues(
  project: ProjectData,
  audit?: ProductionQualityFingerprintAudit,
): ProductionQualityIssue[] {
  const issues: ProductionQualityIssue[] = [];
  const seen = new Set<string>();
  for (const asset of collectFrozenMediaAssets(project)) {
    const identity = `${asset.path}\u0000${asset.fingerprint ?? ''}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (!asset.fingerprint) {
      issues.push({
        severity: 'error',
        source: 'asset',
        code: 'frozen-media-fingerprint-missing',
        message: `${asset.label} 缺少批准时文件指纹，请重新制作该镜头后再导出`,
        shotId: asset.shotId,
      });
      continue;
    }
    if (!audit) continue;
    const current = audit.currentByPath.get(asset.path);
    if (current === asset.fingerprint) continue;
    issues.push({
      severity: 'error',
      source: 'asset',
      code: current ? 'frozen-media-changed' : 'frozen-media-missing',
      message: current
        ? `${asset.label} 在批准后已被替换，请重新制作该镜头后再导出`
        : `${asset.label} 已不存在或无法读取，请重新选择素材后再导出`,
      shotId: asset.shotId,
    });
  }
  return issues;
}

function remoteAssetIssues(timeline: TimelineData): ProductionQualityIssue[] {
  const paths = [timeline.podcast.audioPath, ...timeline.overlays.map((overlay) => overlay.assetPath)];
  return paths
    .filter((assetPath) => /^https?:\/\//iu.test(assetPath))
    .map((assetPath) => ({
      severity: 'error' as const,
      source: 'asset' as const,
      code: 'remote-asset',
      message: `质量导出前必须本地化远程素材：${assetPath}`,
    }));
}

const OUTPUT_LABELS: Record<ProductionOutputKey, string> = {
  cards: '画面卡片',
  cover: '封面',
  audio: '声音',
  timeline: '时间线',
  footage: '真实素材',
};

function productionStateIssues(project: ProjectData): ProductionQualityIssue[] {
  const production = project.production;
  if (!production || production.version !== 3 || !production.workflow || !production.outputs) return [];
  const plan = production.approvedPlan;
  const workflowEngaged = Boolean(plan) || production.workflow.stage !== 'idle';
  if (!workflowEngaged) return [];

  const issues: ProductionQualityIssue[] = [];
  const stage = production.workflow.stage;
  if (stage === 'quality-blocked') {
    issues.push({
      severity: 'error',
      source: 'render',
      code: 'production-workflow-quality-blocked',
      message: `导演制作仍处于质量阻断状态${production.workflow.error ? `：${production.workflow.error}` : ''}`,
    });
  } else if (stage === 'error') {
    issues.push({
      severity: 'error',
      source: 'render',
      code: 'production-workflow-failed',
      message: `导演制作流程执行失败${production.workflow.error ? `：${production.workflow.error}` : ''}`,
    });
  } else if (
    stage !== 'complete'
    && stage !== 'refining'
    && !(production.legacyProtected && stage === 'animatic-review')
  ) {
    issues.push({
      severity: 'error',
      source: 'render',
      code: 'production-workflow-incomplete',
      message: `导演制作流程尚未完成（${stage}），不能导出旧时间线`,
    });
  }

  if (production.pendingImpact) {
    issues.push({
      severity: 'error',
      source: 'render',
      code: 'production-impact-pending',
      message: '已批准的导演修订尚未完成制作，不能导出旧时间线',
    });
  }

  if (!plan) return issues;
  const requiredOutputs: ProductionOutputKey[] = ['cards', 'cover', 'audio', 'timeline'];
  if (
    !production.legacyProtected
    && plan.segments.some((segment) => (
      segment.enabled && resolveDirectorRenderStrategy(segment) !== 'motion-card'
    ))
  ) {
    requiredOutputs.push('footage');
  }

  for (const output of requiredOutputs) {
    const state = production.outputs?.[output];
    const label = OUTPUT_LABELS[output];
    if (!state || state.status === 'empty' || state.status === 'generating') {
      issues.push({
        severity: 'error',
        source: 'render',
        code: 'production-output-incomplete',
        message: `${label}制作产物尚未完成`,
      });
    } else if (state.status === 'failed') {
      issues.push({
        severity: 'error',
        source: 'render',
        code: 'production-output-failed',
        message: `${label}制作产物失败${state.error ? `：${state.error}` : ''}`,
      });
    } else if (state.status === 'stale') {
      issues.push({
        severity: 'error',
        source: 'render',
        code: 'production-output-stale',
        message: `${label}制作产物已过期，请按当前导演方案重新制作`,
      });
    }
    if (state?.directorRevision !== plan.revision) {
      issues.push({
        severity: 'error',
        source: 'render',
        code: 'production-output-revision-stale',
        message: `${label}制作产物属于旧导演版本，当前为 v${plan.revision}`,
      });
    }
  }

  const executionRevision = production.execution?.generationProvenance?.directorRevision;
  if (executionRevision != null && executionRevision !== plan.revision) {
    issues.push({
      severity: 'error',
      source: 'render',
      code: 'production-execution-revision-stale',
      message: `制作执行计划属于导演 v${executionRevision}，当前为 v${plan.revision}`,
    });
  }
  return issues;
}

function cardGenerationIssues(project: ProjectData): ProductionQualityIssue[] {
  return (project.aiAnalysis.analysisResult?.cardErrors ?? []).map((error) => ({
    severity: 'error',
    source: 'visual',
    code: 'card-generation-failed',
    message: `镜头生成失败${error.segmentTitle ? `（${error.segmentTitle}）` : ''}：${error.message}`,
    shotId: error.segmentId,
  }));
}

function audioPlanIssues(project: ProjectData, timeline: TimelineData): ProductionQualityIssue[] {
  const plan = project.production?.execution?.audioPlan;
  if (!plan) return [];
  const locallyPlacedCueIds = new Set(
    timeline.overlays.flatMap((overlay) => {
      const cueId = overlay.audioData?.cueId;
      return overlay.type === 'audio'
        && cueId
        && overlay.assetPath
        && !/^https?:\/\//iu.test(overlay.assetPath)
        ? [cueId]
        : [];
    }),
  );
  const issues: ProductionQualityIssue[] = [...plan.bgm, ...plan.ambience, ...plan.stingers, ...plan.sfx]
    .filter((cue) => cue.required && !cue.assetId && !locallyPlacedCueIds.has(cue.id))
    .map((cue) => ({
      severity: 'error' as const,
      source: 'audio' as const,
      code: 'required-audio-missing',
      message: `必需声音尚未解析到本地素材：${cue.query}`,
      cueId: cue.id,
    }));
  const durationMs = timeline.podcast.durationMs
    || plan.bgm[0]?.durationMs
    || Math.max(0, ...(project.production?.execution?.shots ?? []).map((shot) => shot.endMs));
  const accentCueCount = plan.stingers.length + plan.sfx.length;
  if (durationMs >= 30_000 && accentCueCount > 0) {
    const cuesPerMinute = accentCueCount / (durationMs / 60_000);
    if (cuesPerMinute > 4) {
      issues.push({
        severity: 'warning',
        source: 'audio',
        code: 'audio-cue-density-high',
        message: `章节与重点声音密度 ${cuesPerMinute.toFixed(1)} 次/分钟，建议控制在 2–4 次/分钟`,
      });
    }
  }
  return issues;
}

function requiredCompositeAssetIssues(
  project: ProjectData,
  card: AICard,
  segment: DirectorSegmentPlan | undefined,
): ProductionQualityIssue[] {
  const report = card.motionCard?.productionReport;
  const fallbackPolicy = segment ? resolveDirectorFallbackPolicy(segment) : 'block';
  if (report?.fallbackUsed && fallbackPolicy !== 'block') return [];

  const issues: ProductionQualityIssue[] = [];
  const requiredBindings = (card.assetBindings ?? []).filter((binding) => (
    binding.usage === 'required' || binding.required === true
  ));
  const expectedRequiredAssets = [
    ...(segment?.compositionAssets ?? []),
    ...(project.production?.footage?.compositionInputs ?? [])
      .filter((input) => input.segmentId === card.segmentId),
  ].filter((input) => input.usage === 'required');
  const expectedById = new Map(expectedRequiredAssets.map((input) => [input.asset.id, input.asset.filename]));
  const requiredBindingIds = new Set(requiredBindings.map((binding) => binding.assetId));

  for (const [assetId, filename] of expectedById) {
    if (requiredBindingIds.has(assetId)) continue;
    issues.push({
      severity: 'error',
      source: 'asset',
      code: 'required-composite-media-missing',
      message: `Agent 合成镜头缺少必用素材绑定：${filename}`,
      shotId: card.id,
    });
  }
  if ((card.assetBindings ?? []).length === 0 && expectedById.size === 0) {
    issues.push({
      severity: 'error',
      source: 'asset',
      code: 'required-composite-media-missing',
      message: `Agent 合成镜头没有可用素材：${card.title}`,
      shotId: card.id,
    });
  }
  for (const binding of requiredBindings) {
    if (binding.filePath?.trim()) continue;
    issues.push({
      severity: 'error',
      source: 'asset',
      code: 'required-composite-media-missing',
      message: `Agent 合成镜头的必用素材路径为空：${binding.request?.query ?? binding.slot}`,
      shotId: card.id,
    });
  }

  const reportedAssetFailures = [
    ...(report?.assetIssues ?? []),
    ...(report?.layoutIssues ?? []),
  ].filter((issue) => (
    issue.code === 'asset-binding-missing'
    || issue.code === 'required-composite-media-not-visible'
    || issue.code === 'required-composite-visibility-unverified'
    || issue.code === 'agent-composite-media-not-visible'
    || issue.code === 'agent-composite-visibility-unverified'
  ));
  for (const issue of reportedAssetFailures) {
    issues.push({
      severity: 'error',
      source: 'asset',
      code: issue.code ?? 'required-composite-media-invalid',
      message: issue.message,
      shotId: card.id,
    });
  }
  return issues;
}

function plannedCarrierIssues(
  project: ProjectData,
  timeline: TimelineData,
): ProductionQualityIssue[] {
  const production = project.production;
  const plan = project.production?.approvedPlan;
  if (!plan || production?.legacyProtected) return [];
  const cardsBySegment = new Map(
    (project.aiAnalysis.analysisResult?.cards ?? []).map((card) => [card.segmentId, card]),
  );
  const placementsBySegment = new Map(
    (production?.footage?.placements ?? []).map((placement) => [placement.segmentId, placement]),
  );
  const aiOverlays = timeline.overlays.filter((overlay) => overlay.overlayType === 'ai-card');
  const footageOverlays = timeline.overlays.filter((overlay) => Boolean(overlay.footageData));

  const normalizeTsx = (tsx: string | undefined): string | null => {
    const normalized = tsx?.replace(/\r\n?/gu, '\n').trim();
    return normalized || null;
  };
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return Object.is(value, -0) ? 0 : value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  };
  const cardVisualFingerprint = (data: AICardOverlayData): string => {
    const motionCard = data.motionCard;
    const provenance = data.generationProvenance;
    return JSON.stringify(canonicalize({
      cardType: data.cardType,
      title: data.title,
      content: data.content,
      template: data.template,
      displayMode: data.displayMode,
      style: data.style,
      renderMode: data.renderMode ?? 'legacy',
      renderStrategy: data.renderStrategy ?? null,
      stylePresetId: data.stylePresetId ?? null,
      assetBindings: data.assetBindings ?? [],
      motionBible: data.motionBible ?? null,
      motionCard: motionCard ? {
        tsx: normalizeTsx(motionCard.tsx),
        storyboard: motionCard.storyboard ?? null,
      } : null,
      generationProvenance: provenance ? {
        directorRevision: provenance.directorRevision,
        fingerprint: provenance.fingerprint,
        generatedAt: provenance.generatedAt,
        modifiedByUser: provenance.modifiedByUser === true,
        legacyProtected: provenance.legacyProtected === true,
      } : null,
    }));
  };

  const cardOverlayMatches = (
    card: AICard,
    segment: DirectorSegmentPlan,
    strategy: 'motion-card' | 'agent-composite',
  ): boolean => {
    if (card.startMs !== segment.startMs || card.endMs !== segment.endMs) return false;
    const draft = buildAICardTimelineDraft(
      card,
      project.aiAnalysis.analysisResult?.motionBible,
    );
    const expectedVisualFingerprint = cardVisualFingerprint(draft.aiCardData);
    return aiOverlays.some((overlay) => (
      overlay.aiCardData?.sourceCardId === card.id
      && overlay.aiCardData.segmentId === card.segmentId
      && overlay.aiCardData.renderStrategy === strategy
      && overlay.startMs === draft.startMs
      && overlay.durationMs === draft.durationMs
      && cardVisualFingerprint(overlay.aiCardData) === expectedVisualFingerprint
    ));
  };
  const segmentHasAnyCardOverlay = (segmentId: string): boolean => aiOverlays.some((overlay) => {
    const sourceCard = overlay.aiCardData?.sourceCardId;
    return overlay.aiCardData?.segmentId === segmentId
      || (sourceCard ? cardsBySegment.get(segmentId)?.id === sourceCard : false);
  });
  const segmentHasAnyFootageOverlay = (segmentId: string): boolean => footageOverlays.some(
    (overlay) => overlay.footageData?.segmentId === segmentId,
  );
  const placementOverlayMatches = (segment: DirectorSegmentPlan): boolean => {
    const placement = placementsBySegment.get(segment.id);
    if (!placement) return false;
    const approvedPaths = [
      ...(segment.compositionAssets ?? []).map((input) => input.asset.path),
      segment.selectedFootage?.path,
    ].filter((filePath): filePath is string => Boolean(filePath?.trim()));
    if (
      placement.startMs !== segment.startMs
      || placement.durationMs !== Math.max(1, Math.round(segment.endMs - segment.startMs))
      || (approvedPaths.length > 0 && !approvedPaths.includes(placement.sourcePath))
    ) return false;
    return footageOverlays.some((overlay) => (
      overlay.id === placement.overlayId
      && overlay.footageData?.segmentId === segment.id
      && overlay.type === placement.kind
      && overlay.assetPath === placement.sourcePath
      && overlay.startMs === placement.startMs
      && overlay.durationMs === placement.durationMs
      && (overlay.trimStartMs ?? 0) === (placement.trimStartMs ?? 0)
    ));
  };

  return plan.segments.flatMap<ProductionQualityIssue>((segment) => {
    if (!segment.enabled) return [];
    const plannedStrategy = resolveDirectorRenderStrategy(segment);
    const card = cardsBySegment.get(segment.id);
    const noFootageCarrier = !segmentHasAnyFootageOverlay(segment.id);
    const noCardCarrier = !segmentHasAnyCardOverlay(segment.id);

    if (plannedStrategy === 'motion-card') {
      if (card?.renderStrategy === 'motion-card' && cardOverlayMatches(card, segment, 'motion-card') && noFootageCarrier) {
        return [];
      }
      return [{
        severity: 'error',
        source: 'visual',
        code: 'director-carrier-mismatch',
        message: `Motion Card 镜头未按当前导演方案进入时间线：${segment.title}`,
        shotId: card?.id ?? segment.id,
      }];
    }

    if (plannedStrategy === 'standalone-media') {
      if (placementOverlayMatches(segment) && noCardCarrier) return [];
      return [{
        severity: 'error',
        source: 'visual',
        code: 'director-carrier-mismatch',
        message: `独立素材镜头未按当前导演方案进入时间线：${segment.title}`,
        shotId: segment.id,
      }];
    }

    if (card?.renderStrategy === 'agent-composite'
      && cardOverlayMatches(card, segment, 'agent-composite')
      && noFootageCarrier) return [];
    const fallbackPolicy = resolveDirectorFallbackPolicy(segment);
    if (
      fallbackPolicy === 'motion'
      && card?.renderStrategy === 'motion-card'
      && cardOverlayMatches(card, segment, 'motion-card')
      && noFootageCarrier
    ) {
      return [{
        severity: 'warning',
        source: 'visual',
        code: 'shot-fallback',
        message: `Agent 合成镜头已按 motion 策略明确降级：${segment.title}`,
        shotId: card.id,
      }];
    }
    if (
      fallbackPolicy === 'standalone-media'
      && placementOverlayMatches(segment)
      && noCardCarrier
    ) {
      return [{
        severity: 'warning',
        source: 'visual',
        code: 'shot-fallback',
        message: `Agent 合成镜头已按 standalone-media 策略明确降级：${segment.title}`,
        shotId: segment.id,
      }];
    }
    return [{
      severity: 'error',
      source: 'visual',
      code: 'agent-composite-output-missing',
      message: `Agent 合成镜头没有符合导演策略的成片画面：${segment.title}`,
      shotId: card?.id ?? segment.id,
    }];
  });
}

function visualIssues(project: ProjectData, timeline: TimelineData): ProductionQualityIssue[] {
  const cards = project.aiAnalysis.analysisResult?.cards ?? [];
  const segments = new Map(
    (project.production?.approvedPlan?.segments ?? []).map((segment) => [segment.id, segment]),
  );
  const cardIssues = cards.flatMap((card) => {
    const report = card.motionCard?.productionReport;
    const issues: ProductionQualityIssue[] = [];
    const segment = segments.get(card.segmentId);
    const agentComposite = card.renderStrategy === 'agent-composite';
    const fallbackPolicy = segment ? resolveDirectorFallbackPolicy(segment) : 'block';
    const explicitFallback = agentComposite
      && report?.fallbackUsed === true
      && fallbackPolicy !== 'block';
    const requiresCompositeReview = agentComposite && !explicitFallback;
    const content = card.content;
    const media = content && typeof content === 'object' && 'mediaType' in content ? content : null;
    if (media && (media.generationStatus !== 'ready' || !media.assetPath)) {
      issues.push({
        severity: 'error', source: 'asset', code: 'shot-asset-missing',
        message: `镜头素材尚未生成或匹配：${card.title}`, shotId: card.id,
      });
    }
    if (requiresCompositeReview) issues.push(...requiredCompositeAssetIssues(project, card, segment));
    if (!report) {
      issues.push({
        severity: requiresCompositeReview ? 'error' : 'warning',
        source: 'visual',
        code: 'visual-review-pending',
        message: requiresCompositeReview
          ? `Agent 合成镜头尚未生成视觉审片报告，不能质量导出：${card.title}`
          : `镜头尚未生成视觉审片报告：${card.title}`,
        shotId: card.id,
      });
      return issues;
    }
    if (!report.renderOk || report.status === 'failed') {
      issues.push({
        severity: 'error',
        source: 'visual',
        code: 'shot-render-failed',
        message: `镜头未通过渲染质检：${card.title}`,
        shotId: card.id,
      });
    } else if (report.status === 'risk' || report.fallbackUsed) {
      const fallbackBlocked = requiresCompositeReview
        && report.fallbackUsed
        && fallbackPolicy === 'block';
      issues.push({
        severity: fallbackBlocked ? 'error' : 'warning',
        source: 'visual',
        code: report.fallbackUsed ? 'shot-fallback' : 'shot-risk',
        message: fallbackBlocked
          ? `Agent 合成镜头不允许在 block 策略下使用 fallback：${card.title}`
          : report.fallbackUsed && agentComposite && segment
            ? `Agent 合成镜头已按 ${fallbackPolicy} 策略明确降级：${card.title}`
            : `镜头需要人工复核：${card.title}`,
        shotId: card.id,
      });
    }
    if (report.visualReviewAvailable === false || (requiresCompositeReview && report.visualReviewAvailable !== true)) {
      issues.push({
        severity: requiresCompositeReview ? 'error' : 'warning',
        source: 'visual',
        code: 'visual-review-unavailable',
        message: requiresCompositeReview
          ? `Agent 合成镜头未完成多模态审片，不能质量导出：${card.title}`
          : `镜头未完成多模态审片：${card.title}`,
        shotId: card.id,
      });
    }
    return issues;
  });
  return [...cardIssues, ...plannedCarrierIssues(project, timeline)];
}

export function evaluateProductionQuality(
  project: ProjectData,
  timeline: TimelineData,
  audioMeasurement?: { integratedLufs: number; truePeakDbtp: number },
  fingerprintAudit?: ProductionQualityFingerprintAudit,
): ProductionQualityReport {
  const issues: ProductionQualityIssue[] = [
    ...productionStateIssues(project),
    ...cardGenerationIssues(project),
    ...remoteAssetIssues(timeline),
    ...audioPlanIssues(project, timeline),
    ...visualIssues(project, timeline),
    ...frozenMediaIssues(project, fingerprintAudit),
  ];
  const mastering = project.production?.execution?.audioPlan.mastering;
  if (audioMeasurement && mastering) {
    if (Math.abs(audioMeasurement.integratedLufs - mastering.targetLufs) > mastering.toleranceLu) {
      issues.push({
        severity: 'error',
        source: 'audio',
        code: 'master-loudness-out-of-range',
        message: `成片响度 ${audioMeasurement.integratedLufs.toFixed(1)} LUFS 超出目标 ${mastering.targetLufs} ±${mastering.toleranceLu} LU`,
      });
    }
    if (audioMeasurement.truePeakDbtp > mastering.maxTruePeakDbtp) {
      issues.push({
        severity: 'error',
        source: 'audio',
        code: 'master-true-peak-exceeded',
        message: `成片 True Peak ${audioMeasurement.truePeakDbtp.toFixed(1)} dBTP 超过 ${mastering.maxTruePeakDbtp} dBTP`,
      });
    }
  }
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  return {
    generatedAt: Date.now(),
    exportAllowed: errorCount === 0,
    degraded: issues.length > 0,
    integratedLufs: audioMeasurement?.integratedLufs,
    truePeakDbtp: audioMeasurement?.truePeakDbtp,
    remoteAssetCount: issues.filter((issue) => issue.code === 'remote-asset').length,
    issues,
  };
}
