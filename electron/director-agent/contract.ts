import type { SrtEntry } from '../../src/types';
import type {
  DirectorAssetDecision,
  DirectorCompositionIntent,
  DirectorFallbackDecision,
  DirectorFallbackPolicy,
  DirectorPlan,
  DirectorSegmentPlan,
  DirectorSegmentLocks,
} from '../../src/types/director';
import type { AISegmentAnalysis } from '../../src/types/ai';
import type { KacutClip, SelectedFootageAsset } from '../../src/types/footage';
import type {
  MotionBibleDensity,
  MotionBibleTransition,
  MotionDirectiveCameraMove,
  MotionDirectiveComposition,
  MotionDirectiveMediaRole,
} from '../../src/types/motion';
import type { VisualShotPurpose } from '../../src/types/production';
import { alignCoverPromptTitle, resolveCoverPromptTitle } from '../../src/lib/cover-title';
import { createDirectorInputFingerprint } from '../../src/lib/director-workflow';

export interface ShowDirectorAssetChoice {
  candidateId: string;
  usage: 'required' | 'optional';
  trimStartMs?: number;
  reason: string;
  confidence?: number;
}

export interface ShowDirectorRejectedAsset {
  candidateId: string;
  reason: string;
  confidence?: number;
}

export interface ShowDirectorSegmentDraft {
  key: string;
  firstEntryIndex: number;
  lastEntryIndex: number;
  title: string;
  summary: string;
  semanticType: AISegmentAnalysis['semanticType'];
  complexityLevel: AISegmentAnalysis['complexityLevel'];
  visualizationScore: number;
  pacingNeed: AISegmentAnalysis['pacingNeed'];
  keywords: string[];
  entities: string[];
  enabled: boolean;
  purpose: VisualShotPurpose;
  carrier: string;
  intensity: 1 | 2 | 3;
  renderStrategy: 'motion-card' | 'standalone-media' | 'agent-composite';
  visualType?: AISegmentAnalysis['visualType'];
  composition?: MotionDirectiveComposition;
  cameraMove?: MotionDirectiveCameraMove;
  mediaRole?: MotionDirectiveMediaRole;
  transition?: MotionBibleTransition;
  footageQuery?: string;
  fallbackPolicy?: DirectorFallbackPolicy;
  compositionIntent?: DirectorCompositionIntent;
  selectedAssets?: ShowDirectorAssetChoice[];
  rejectedAssets?: ShowDirectorRejectedAsset[];
  strategyReason: string;
  confidence: number;
  mediaIndispensability?: string;
  graphicsIndispensability?: string;
  strategyStatus?: 'ready' | 'blocked' | 'fallback';
  blockedReason?: string;
  fallbackDecision?: DirectorFallbackDecision;
}

export interface ShowDirectorDraft {
  title: string;
  summary: string;
  keywords: string[];
  globalPrompt?: string;
  coverDirection: DirectorPlan['coverDirection'];
  audioDirection: DirectorPlan['audioDirection'];
  visualThesis: string;
  rhythmDensity: MotionBibleDensity;
  styleRules: DirectorPlan['motionBible']['styleRules'];
  defaultTransition: MotionBibleTransition;
  matchCuts: Array<{ fromKey: string; toKey: string; motif: string }>;
  segments: ShowDirectorSegmentDraft[];
  zeroCompositeReason?: string;
  warnings?: string[];
}

export interface DirectorAgentCandidate {
  /** 镜头作用域内的候选 ID；同一素材可同时服务多个镜头而不互相覆盖。 */
  candidateId?: string;
  clip: KacutClip;
  query: string;
  shotKey?: string;
  narrativeNeed?: string;
  inspected: boolean;
}

export type DirectorMaterialSearchOutcome =
  | 'candidates'
  | 'empty'
  | 'partial'
  | 'retryable-error'
  | 'fatal-error';

export interface DirectorMaterialSearchAudit {
  shotKey: string;
  query: string;
  /** 总导演从素材库标签目录中为当前镜头选择的真实标签；旧检查点可能缺失。 */
  selectedTags?: string[];
  /** 本次工具调用实际尝试的查询词；旧检查点可能缺失。 */
  queriesTried?: string[];
  /** 本次工具调用成功完成检索的媒介类型；旧检查点可能缺失。 */
  kinds?: Array<'video' | 'image'>;
  outcome: DirectorMaterialSearchOutcome;
  candidateCount: number;
  errorCount: number;
}

export interface DirectorDraftIssue {
  code: string;
  path: string;
  message: string;
  repairHint: string;
}

export interface ValidateShowDirectorDraftOptions {
  entries: SrtEntry[];
  candidates: ReadonlyMap<string, DirectorAgentCandidate>;
  existingPlan?: DirectorPlan | null;
  materialReview?: {
    enabled: boolean;
    searchAttempts: number;
    searchFailures: number;
    searches?: readonly DirectorMaterialSearchAudit[];
  };
}

const SEMANTIC_TYPES = new Set(['data', 'explanation', 'chapter-transition', 'quote', 'narration']);
const COMPLEXITIES = new Set(['low', 'medium', 'high']);
const PACING_NEEDS = new Set(['steady', 'accent', 'transition']);
const PURPOSES = new Set(['context', 'explain', 'compare', 'evidence', 'emphasis', 'transition', 'breath']);
const STRATEGIES = new Set(['motion-card', 'standalone-media', 'agent-composite']);
const VISUAL_TYPES = new Set(['motion', 'image', 'footage']);
const COMPOSITIONS = new Set(['graphic', 'full-bleed', 'media-window', 'split']);
const CAMERA_MOVES = new Set(['static', 'push-in', 'pull-out', 'pan-left', 'pan-right', 'tracking']);
const MEDIA_ROLES = new Set(['evidence', 'context', 'emotion', 'demonstration']);
const TRANSITIONS = new Set(['crossfade', 'hard-cut', 'push', 'wipe', 'match-cut']);
const FALLBACK_POLICIES = new Set(['standalone-media', 'motion', 'block']);
const STRATEGY_STATUSES = new Set(['ready', 'blocked', 'fallback']);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function issue(
  issues: DirectorDraftIssue[],
  code: string,
  path: string,
  message: string,
  repairHint: string,
): void {
  issues.push({ code, path, message, repairHint });
}

function validateIntent(
  value: unknown,
  path: string,
  issues: DirectorDraftIssue[],
): value is DirectorCompositionIntent {
  const intent = record(value);
  if (!intent) {
    issue(issues, 'composition_intent_required', path, 'agent-composite 缺少合成意图', '补充 narrativeGoal、focalPriority、temporalRelationship、mustShow、avoid');
    return false;
  }
  let ok = true;
  for (const field of ['narrativeGoal', 'focalPriority', 'temporalRelationship'] as const) {
    if (!nonEmpty(intent[field])) {
      issue(issues, 'composition_intent_field_required', `${path}.${field}`, `${field} 不能为空`, '用镜头语义而不是布局模板描述这一字段');
      ok = false;
    }
  }
  for (const field of ['mustShow', 'avoid'] as const) {
    if (!stringArray(intent[field])) {
      issue(issues, 'composition_intent_list_invalid', `${path}.${field}`, `${field} 必须是字符串数组`, '返回字符串数组；没有内容时返回 []');
      ok = false;
    }
  }
  return ok;
}

function validateFallbackDecision(
  value: unknown,
  path: string,
  issues: DirectorDraftIssue[],
): value is DirectorFallbackDecision {
  const decision = record(value);
  if (!decision) return false;
  const ok = (decision.from === 'agent-composite' || decision.from === 'standalone-media')
    && (decision.to === 'motion-card' || decision.to === 'standalone-media')
    && decision.explicit === true
    && nonEmpty(decision.reason);
  if (!ok) {
    issue(issues, 'fallback_decision_invalid', path, '显式退路字段不完整', '填写 from、to、reason，并固定 explicit=true');
  }
  return ok;
}

export function validateShowDirectorDraft(
  value: unknown,
  options: ValidateShowDirectorDraftOptions,
): { ok: true; draft: ShowDirectorDraft } | { ok: false; issues: DirectorDraftIssue[] } {
  const issues: DirectorDraftIssue[] = [];
  const draft = record(value);
  if (!draft) {
    return {
      ok: false,
      issues: [{
        code: 'draft_not_object',
        path: '$',
        message: '导演草案必须是对象',
        repairHint: '按 director_submit_draft 的 schema 重新提交完整对象',
      }],
    };
  }

  for (const field of ['title', 'summary', 'visualThesis'] as const) {
    if (!nonEmpty(draft[field])) issue(issues, 'required_text_missing', `$.${field}`, `${field} 不能为空`, '补充忠于口播内容的文本');
  }
  if (!options.existingPlan?.userLocks?.title && nonEmpty(draft.title) && (Array.from(draft.title.trim()).length < 8 || Array.from(draft.title.trim()).length > 14)) {
    issue(issues, 'title_length_invalid', '$.title', '作品标题必须为 8-14 个字符', '改成自然、克制且适合口播视频的短标题');
  }
  if (!options.existingPlan?.userLocks?.summary && nonEmpty(draft.summary) && (Array.from(draft.summary.trim()).length < 30 || Array.from(draft.summary.trim()).length > 80)) {
    issue(issues, 'summary_length_invalid', '$.summary', '作品简介必须为 30-80 个字符', '用一到两句概括核心观点，不写广告套话');
  }
  if (!stringArray(draft.keywords) || draft.keywords.length === 0) {
    issue(issues, 'keywords_invalid', '$.keywords', 'keywords 必须是非空字符串数组', '给出 3-8 个中文关键词');
  }
  if (draft.rhythmDensity !== 'quiet' && draft.rhythmDensity !== 'balanced' && draft.rhythmDensity !== 'dense') {
    issue(issues, 'rhythm_density_invalid', '$.rhythmDensity', 'rhythmDensity 无效', '使用 quiet、balanced 或 dense');
  }
  if (!TRANSITIONS.has(String(draft.defaultTransition))) {
    issue(issues, 'transition_invalid', '$.defaultTransition', '默认转场无效', '使用 crossfade、hard-cut、push、wipe 或 match-cut');
  }
  const cover = record(draft.coverDirection);
  if (!cover || !nonEmpty(cover.prompt) || !nonEmpty(cover.composition)) {
    issue(issues, 'cover_direction_invalid', '$.coverDirection', '封面方向必须包含 prompt 与 composition', '封面 prompt 必须明确使用与 title 完全一致的标题文字');
  } else if (nonEmpty(draft.title) && resolveCoverPromptTitle(cover.prompt) !== draft.title.trim()) {
    issue(issues, 'cover_title_mismatch', '$.coverDirection.prompt', '封面主标题与作品标题不一致', `把封面唯一文字标题逐字改为“${draft.title.trim()}”`);
  }
  const audio = record(draft.audioDirection);
  if (
    !audio
    || !nonEmpty(audio.bgmStyle)
    || !finite(audio.energy)
    || ![1, 2, 3].includes(audio.energy)
    || !['quiet', 'balanced', 'active'].includes(String(audio.soundDensity))
  ) {
    issue(issues, 'audio_direction_invalid', '$.audioDirection', '声音方向字段不完整', '补充 bgmStyle、energy(1-3)、soundDensity');
  }
  const styleRules = record(draft.styleRules);
  if (!styleRules || !nonEmpty(styleRules.paletteUse) || !nonEmpty(styleRules.typographyUse)) {
    issue(issues, 'style_rules_invalid', '$.styleRules', '视觉风格必须包含 paletteUse 与 typographyUse', '描述整片统一的色彩与字体使用方式');
  }

  if (!Array.isArray(draft.segments) || draft.segments.length === 0) {
    issue(issues, 'segments_required', '$.segments', '至少需要一个镜头段', '覆盖全部字幕条目并按顺序拆分镜头');
  } else {
    const entryPositions = new Map(options.entries.map((entry, position) => [entry.index, position]));
    const seenKeys = new Set<string>();
    let expectedPosition = 0;
    let readyCompositeCount = 0;
    for (let index = 0; index < draft.segments.length; index += 1) {
      const path = `$.segments[${index}]`;
      const segment = record(draft.segments[index]);
      if (!segment) {
        issue(issues, 'segment_invalid', path, '镜头必须是对象', '按镜头 schema 重新填写');
        continue;
      }
      if (!nonEmpty(segment.key) || seenKeys.has(String(segment.key))) {
        issue(issues, 'segment_key_invalid', `${path}.key`, '镜头 key 为空或重复', '为每个镜头提供本草案内唯一的短 key');
      } else seenKeys.add(segment.key);
      const firstPosition = finite(segment.firstEntryIndex) ? entryPositions.get(segment.firstEntryIndex) : undefined;
      const lastPosition = finite(segment.lastEntryIndex) ? entryPositions.get(segment.lastEntryIndex) : undefined;
      if (firstPosition == null || lastPosition == null || firstPosition > lastPosition) {
        issue(issues, 'segment_range_invalid', path, '字幕起止索引不存在或顺序错误', '从 director_get_context 返回的 entry.index 中选择有效首尾索引');
      } else {
        if (firstPosition !== expectedPosition) {
          issue(issues, 'segment_coverage_invalid', `${path}.firstEntryIndex`, '镜头存在字幕遗漏、重叠或乱序', `本镜头应从 entry.index=${options.entries[expectedPosition]?.index ?? '末尾'} 开始`);
        }
        expectedPosition = lastPosition + 1;
      }
      for (const field of ['title', 'summary', 'carrier', 'strategyReason'] as const) {
        if (!nonEmpty(segment[field])) issue(issues, 'segment_text_missing', `${path}.${field}`, `${field} 不能为空`, '给出具体、可执行且忠于口播的内容');
      }
      if (!SEMANTIC_TYPES.has(String(segment.semanticType))) issue(issues, 'semantic_type_invalid', `${path}.semanticType`, 'semanticType 无效', '使用 data、explanation、chapter-transition、quote 或 narration');
      if (!COMPLEXITIES.has(String(segment.complexityLevel))) issue(issues, 'complexity_invalid', `${path}.complexityLevel`, 'complexityLevel 无效', '使用 low、medium 或 high');
      if (!PACING_NEEDS.has(String(segment.pacingNeed))) issue(issues, 'pacing_need_invalid', `${path}.pacingNeed`, 'pacingNeed 无效', '使用 steady、accent 或 transition');
      if (!PURPOSES.has(String(segment.purpose))) issue(issues, 'purpose_invalid', `${path}.purpose`, 'purpose 无效', '使用工具 schema 中列出的镜头用途');
      if (!finite(segment.visualizationScore) || segment.visualizationScore < 0 || segment.visualizationScore > 100) issue(issues, 'visualization_score_invalid', `${path}.visualizationScore`, 'visualizationScore 必须是 0-100', '给出 0-100 数字');
      if (!finite(segment.confidence) || segment.confidence < 0 || segment.confidence > 1) issue(issues, 'confidence_invalid', `${path}.confidence`, 'confidence 必须是 0-1', '给出 0-1 数字，不要使用百分数');
      if (![1, 2, 3].includes(Number(segment.intensity))) issue(issues, 'intensity_invalid', `${path}.intensity`, 'intensity 必须是 1、2 或 3', '按镜头信息强度选择');
      if (!stringArray(segment.keywords) || !stringArray(segment.entities)) issue(issues, 'segment_arrays_invalid', path, 'keywords 与 entities 必须是字符串数组', '没有实体时 entities 返回 []');
      if (segment.visualType != null && !VISUAL_TYPES.has(String(segment.visualType))) issue(issues, 'visual_type_invalid', `${path}.visualType`, 'visualType 无效', '使用 motion、image 或 footage');
      if (segment.composition != null && !COMPOSITIONS.has(String(segment.composition))) issue(issues, 'composition_invalid', `${path}.composition`, 'composition 无效', '使用 graphic、full-bleed、media-window 或 split');
      if (segment.cameraMove != null && !CAMERA_MOVES.has(String(segment.cameraMove))) issue(issues, 'camera_move_invalid', `${path}.cameraMove`, 'cameraMove 无效', '使用工具 schema 中列出的镜头运动');
      if (segment.mediaRole != null && !MEDIA_ROLES.has(String(segment.mediaRole))) issue(issues, 'media_role_invalid', `${path}.mediaRole`, 'mediaRole 无效', '使用 evidence、context、emotion 或 demonstration');
      if (segment.transition != null && !TRANSITIONS.has(String(segment.transition))) issue(issues, 'shot_transition_invalid', `${path}.transition`, '镜头转场无效', '使用工具 schema 中列出的转场');
      if (!STRATEGIES.has(String(segment.renderStrategy))) {
        issue(issues, 'render_strategy_invalid', `${path}.renderStrategy`, 'renderStrategy 无效', '使用 motion-card、standalone-media 或 agent-composite');
        continue;
      }
      if (segment.fallbackPolicy != null && !FALLBACK_POLICIES.has(String(segment.fallbackPolicy))) issue(issues, 'fallback_policy_invalid', `${path}.fallbackPolicy`, 'fallbackPolicy 无效', '使用 standalone-media、motion 或 block');
      if (segment.strategyStatus != null && !STRATEGY_STATUSES.has(String(segment.strategyStatus))) issue(issues, 'strategy_status_invalid', `${path}.strategyStatus`, 'strategyStatus 无效', '使用 ready、blocked 或 fallback');

      const status = segment.strategyStatus ?? 'ready';
      if (status === 'blocked' && !nonEmpty(segment.blockedReason)) {
        issue(issues, 'blocked_reason_required', `${path}.blockedReason`, 'blocked 镜头必须说明阻塞原因', '说明已尝试的检索与缺失的可信素材');
      }
      if (status === 'fallback' && !validateFallbackDecision(segment.fallbackDecision, `${path}.fallbackDecision`, issues)) {
        issue(issues, 'fallback_reason_required', `${path}.fallbackDecision`, 'fallback 镜头必须保留显式退路决策', '记录原策略、实际策略和具体原因');
      }

      const selected = Array.isArray(segment.selectedAssets) ? segment.selectedAssets : [];
      const rejected = Array.isArray(segment.rejectedAssets) ? segment.rejectedAssets : [];
      const selectedIds = new Set<string>();
      for (let assetIndex = 0; assetIndex < selected.length; assetIndex += 1) {
        const assetPath = `${path}.selectedAssets[${assetIndex}]`;
        const choice = record(selected[assetIndex]);
        if (!choice || !nonEmpty(choice.candidateId) || !['required', 'optional'].includes(String(choice.usage)) || !nonEmpty(choice.reason)) {
          issue(issues, 'asset_choice_invalid', assetPath, '已选素材字段不完整', '填写 candidateId、usage、reason，可选 confidence/trimStartMs');
          continue;
        }
        if (selectedIds.has(choice.candidateId)) issue(issues, 'asset_choice_duplicate', `${assetPath}.candidateId`, '同一素材被重复选择', '每个 candidateId 只保留一条');
        selectedIds.add(choice.candidateId);
        const candidate = options.candidates.get(choice.candidateId);
        if (!candidate) {
          issue(issues, 'asset_candidate_unknown', `${assetPath}.candidateId`, '素材不在本轮搜索候选池', '先调用 director_search_materials，再使用返回的 candidateId');
        } else {
          if (candidate.query !== 'user-locked' && candidate.shotKey !== segment.key) {
            issue(issues, 'asset_shot_mismatch', `${assetPath}.candidateId`, '素材候选不属于当前镜头', `为 shotKey=${String(segment.key)} 重新检索并检视素材`);
          }
          if (!candidate.inspected) issue(issues, 'asset_not_inspected', `${assetPath}.candidateId`, '素材尚未经过画面检视', '先调用 director_inspect_material 查看代表帧，再结合可见内容、媒介角色与非误导边界决定是否采用');
          if (candidate.clip.kind !== 'video' && candidate.clip.kind !== 'image') issue(issues, 'asset_kind_invalid', `${assetPath}.candidateId`, '镜头只能选择图片或视频', '重新搜索 image/video 素材');
        }
      }
      for (let assetIndex = 0; assetIndex < rejected.length; assetIndex += 1) {
        const rejectedPath = `${path}.rejectedAssets[${assetIndex}]`;
        const choice = record(rejected[assetIndex]);
        if (!choice || !nonEmpty(choice.candidateId) || !nonEmpty(choice.reason)) {
          issue(issues, 'rejected_asset_invalid', rejectedPath, '淘汰素材字段不完整', '填写 candidateId 与具体淘汰理由');
        } else if (!options.candidates.has(choice.candidateId)) {
          issue(issues, 'asset_candidate_unknown', `${rejectedPath}.candidateId`, '淘汰素材不在本轮候选池', '只记录 search_materials 返回的 candidateId');
        }
      }

      if (segment.renderStrategy === 'standalone-media' && status === 'ready') {
        if (segment.visualType !== 'image' && segment.visualType !== 'footage') {
          issue(issues, 'standalone_visual_type_required', `${path}.visualType`, 'standalone-media 必须明确是图片或视频素材', '图片使用 image，视频使用 footage');
        }
        if (selected.length !== 1 || record(selected[0])?.usage !== 'required') {
          issue(issues, 'standalone_asset_required', `${path}.selectedAssets`, 'standalone-media 必须且只能选择一项 required 素材', '检视候选后选择一项能独立承载镜头的图片或视频');
        }
      }
      if (segment.renderStrategy === 'agent-composite' && status === 'ready') {
        readyCompositeCount += 1;
        if (segment.visualType !== 'image' && segment.visualType !== 'footage') {
          issue(issues, 'composite_visual_type_required', `${path}.visualType`, 'agent-composite 必须明确使用图片或视频真实素材', '图片使用 image，视频使用 footage');
        }
        validateIntent(segment.compositionIntent, `${path}.compositionIntent`, issues);
        if (!nonEmpty(segment.mediaIndispensability) || !nonEmpty(segment.graphicsIndispensability)) {
          issue(issues, 'dual_indispensability_required', path, 'agent-composite 缺少双重不可替代论证', '分别说明去掉真实素材和去掉图形解释后会损失什么');
        }
        if (!selected.some((choice) => record(choice)?.usage === 'required')) {
          issue(issues, 'composite_required_asset_missing', `${path}.selectedAssets`, 'agent-composite 至少需要一项 required 素材', '选择经画面检视且能承担明确媒介角色的可信素材');
        }
        if (segment.fallbackPolicy == null) {
          issue(issues, 'composite_fallback_policy_required', `${path}.fallbackPolicy`, 'agent-composite 必须显式选择失败策略', '可信素材不可替代时优先使用 block');
        }
      }
    }
    if (expectedPosition !== options.entries.length) {
      const finalEntry = options.entries[options.entries.length - 1];
      issue(issues, 'segment_coverage_incomplete', '$.segments', '镜头没有覆盖全部字幕', `最后一个镜头必须覆盖到 entry.index=${finalEntry?.index ?? 0}`);
    }
    if (readyCompositeCount === 0 && !nonEmpty(draft.zeroCompositeReason)) {
      issue(issues, 'zero_composite_reason_required', '$.zeroCompositeReason', '全片没有可执行 agent-composite，但未说明原因', '说明为什么每个镜头都不满足双重不可替代，或为何可信素材不足');
    }
    const enabledSegments = draft.segments.map(record).filter((segment) => segment?.enabled !== false);
    const allMotion = enabledSegments.length > 0
      && enabledSegments.every((segment) => segment?.renderStrategy === 'motion-card');
    if (allMotion && options.materialReview?.enabled) {
      const searches = options.materialReview.searches;
      const searchedCandidates = [...options.candidates.values()].filter((candidate) => candidate.query !== 'user-locked');
      const inspectedCandidates = searchedCandidates.filter((candidate) => candidate.inspected);
      if (options.materialReview.searchAttempts === 0) {
        issue(
          issues,
          'all_motion_search_required',
          '$.segments',
          '素材库可用时，不能在完全没有搜材审计的情况下提交全片 Motion',
          '选择至少一个可能受益于真实素材的镜头，完成检索与代表帧检视后再逐镜头决定是否仍保留 Motion',
        );
      }
      if (
        options.materialReview.searches == null
        && options.materialReview.searchFailures > 0
        && inspectedCandidates.length === 0
      ) {
        issue(
          issues,
          'all_motion_search_failed',
          '$.segments',
          '素材检索失败时不能直接把全片定为 Motion',
          '改写查询并重试检索；召回候选后先检视代表帧，再逐镜头判断是否保留 Motion',
        );
      }
      if (searches != null && searches.some((search) => Array.isArray(search.kinds))) {
        const enabledShotKeys = new Set(enabledSegments.map((segment) => String(segment?.key ?? '')));
        const completedKinds = new Set(
          searches
            .filter((search) => enabledShotKeys.has(search.shotKey))
            .flatMap((search) => search.kinds ?? []),
        );
        if (!completedKinds.has('video') || !completedKinds.has('image')) {
          issue(
            issues,
            'all_motion_media_audit_incomplete',
            '$.segments',
            '全片 Motion 结论只完成了单一媒介检索，尚未同时审计视频与图片素材',
            '至少完成一次 video 与 image 检索；默认使用 kind="any"，视频候选弱时也要检查可用图片',
          );
        }
      }
      if (searches != null) {
        const searchedShotKeys = new Set(searches.map((search) => search.shotKey));
        const missingBreathSearches = enabledSegments
          .filter((segment) => ['context', 'transition', 'breath'].includes(String(segment?.purpose)))
          .map((segment) => String(segment?.key ?? ''))
          .filter((shotKey) => shotKey && !searchedShotKeys.has(shotKey));
        if (missingBreathSearches.length > 0) {
          issue(
            issues,
            'all_motion_broll_search_required',
            '$.segments',
            `换气型镜头 ${missingBreathSearches.join('、')} 尚未检索可用空镜`,
            '为 context、transition、breath 镜头按物理主体、动作和场景完成搜材，再决定是否保留 Motion',
          );
        }
      }
      const latestSearchByShot = new Map<string, DirectorMaterialSearchAudit>();
      for (const search of searches ?? []) {
        latestSearchByShot.set(search.shotKey, search);
      }
      for (const [shotKey, search] of latestSearchByShot) {
        const unresolved = search.outcome === 'retryable-error'
          || search.outcome === 'fatal-error'
          || (search.outcome === 'partial' && search.candidateCount === 0);
        if (!unresolved) continue;
        const segment = enabledSegments.find((item) => item?.key === shotKey);
        if (segment?.strategyStatus === 'blocked' || segment?.strategyStatus === 'fallback') continue;
        issue(
          issues,
          'all_motion_search_unresolved',
          '$.segments',
          `镜头 ${shotKey} 的最后一次素材检索仍未解决，不能被其它镜头的成功检视抵消`,
          '串行重试该镜头；仍不可用时将该镜头明确标记为 blocked，或记录完整的 fallbackDecision',
        );
      }
      const uninspectedShotKeys = new Set(
        searchedCandidates
          .filter((candidate) => !candidate.inspected && candidate.shotKey)
          .map((candidate) => candidate.shotKey!),
      );
      for (const candidate of inspectedCandidates) {
        if (candidate.shotKey) uninspectedShotKeys.delete(candidate.shotKey);
      }
      if (uninspectedShotKeys.size > 0) {
        issue(
          issues,
          'all_motion_candidates_uninspected',
          '$.segments',
          '全片 Motion 结论中仍有已命中但未检视的素材候选',
          `先为镜头 ${[...uninspectedShotKeys].join('、')} 检视至少一个代表候选，并写明采用或淘汰理由`,
        );
      }
      for (const candidate of inspectedCandidates) {
        const shotKey = candidate.shotKey;
        if (!shotKey) continue;
        const segment = enabledSegments.find((item) => item?.key === shotKey);
        if (!segment) continue;
        const candidateId = candidate.candidateId ?? candidate.clip.id;
        const decisions = [
          ...(Array.isArray(segment.selectedAssets) ? segment.selectedAssets : []),
          ...(Array.isArray(segment.rejectedAssets) ? segment.rejectedAssets : []),
        ];
        if (decisions.some((choice) => record(choice)?.candidateId === candidateId)) continue;
        issue(
          issues,
          'all_motion_candidate_decision_missing',
          '$.segments',
          `镜头 ${shotKey} 已检视素材 ${candidateId}，但没有记录采用或淘汰结论`,
          '在该镜头的 selectedAssets 或 rejectedAssets 中写入 candidateId 与基于代表帧的具体理由',
        );
      }
    }

    const segmentKeys = new Set(draft.segments.map((item) => record(item)?.key).filter(nonEmpty));
    if (!Array.isArray(draft.matchCuts)) {
      issue(issues, 'match_cuts_invalid', '$.matchCuts', 'matchCuts 必须是数组', '没有匹配剪辑时返回 []');
    } else {
      draft.matchCuts.forEach((value, index) => {
        const match = record(value);
        if (!match || !segmentKeys.has(String(match.fromKey)) || !segmentKeys.has(String(match.toKey)) || !nonEmpty(match.motif)) {
          issue(issues, 'match_cut_invalid', `$.matchCuts[${index}]`, '匹配剪辑引用无效或缺少 motif', 'fromKey/toKey 必须引用本草案镜头 key');
        }
      });
    }
  }

  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, draft: value as ShowDirectorDraft };
}

function selectedAsset(clip: KacutClip): SelectedFootageAsset {
  return {
    id: clip.id,
    filename: clip.filename,
    path: clip.path,
    kind: clip.kind as 'video' | 'image',
    score: clip.score,
    durationSec: clip.durationSec,
    thumbnailFile: clip.thumbnailFile,
    matchedSegmentStart: clip.matchedSegmentStart,
    pixelWidth: clip.pixelWidth,
    pixelHeight: clip.pixelHeight,
  };
}

function rangeEntries(entries: SrtEntry[], first: number, last: number): SrtEntry[] {
  const start = entries.findIndex((entry) => entry.index === first);
  const end = entries.findIndex((entry) => entry.index === last);
  return entries.slice(start, end + 1);
}

function overlapDuration(segment: DirectorSegmentPlan, entries: SrtEntry[]): number {
  const startMs = entries[0]?.startMs;
  const endMs = entries[entries.length - 1]?.endMs;
  if (startMs == null || endMs == null) return 0;
  return Math.max(0, Math.min(segment.endMs, endMs) - Math.max(segment.startMs, startMs));
}

function overlappingLockedSegment(
  existingPlan: DirectorPlan | null,
  entries: SrtEntry[],
): DirectorSegmentPlan | undefined {
  return existingPlan?.segments
    .filter((segment) => segment.userLocks && overlapDuration(segment, entries) > 0)
    .sort((left, right) => overlapDuration(right, entries) - overlapDuration(left, entries))[0];
}

function applyLocks(
  segment: DirectorSegmentPlan,
  existingPlan: DirectorPlan | null,
  entries: SrtEntry[],
): DirectorSegmentPlan {
  const existing = overlappingLockedSegment(existingPlan, entries);
  const locks: DirectorSegmentLocks | undefined = existing?.userLocks;
  if (!existing || !locks) return segment;
  let next = { ...segment, userLocks: { ...locks } };
  if (locks.strategy) {
    next = {
      ...next,
      renderStrategy: existing.renderStrategy,
      visualType: existing.visualType,
      carrier: existing.carrier,
      fallbackPolicy: existing.fallbackPolicy,
      footageFallback: existing.footageFallback,
      strategyStatus: existing.strategyStatus,
      blockedReason: existing.blockedReason,
      fallbackDecision: existing.fallbackDecision,
      strategyReason: existing.strategyReason ?? existing.rationale,
      rationale: existing.rationale,
    };
  }
  if (locks.assets) {
    next = {
      ...next,
      selectedFootage: existing.selectedFootage,
      compositionAssets: existing.compositionAssets,
      assetDecisions: existing.assetDecisions,
      footageQuery: existing.footageQuery,
    };
  }
  if (locks.direction) {
    next = {
      ...next,
      title: existing.title,
      summary: existing.summary,
      enabled: existing.enabled,
      purpose: existing.purpose,
      intensity: existing.intensity,
      compositionIntent: existing.compositionIntent,
      composition: existing.composition,
      cameraMove: existing.cameraMove,
      mediaRole: existing.mediaRole,
      transition: existing.transition,
      rationale: existing.rationale,
    };
  }
  return next;
}

export interface BuildDirectorPlanOptions {
  entries: SrtEntry[];
  revision: number;
  globalPrompt?: string;
  stylePresetId?: string;
  candidates: ReadonlyMap<string, DirectorAgentCandidate>;
  existingPlan?: DirectorPlan | null;
  now?: number;
}

export function buildDirectorPlanFromAgentDraft(
  draft: ShowDirectorDraft,
  options: BuildDirectorPlanOptions,
): DirectorPlan {
  const now = options.now ?? Date.now();
  const keyToId = new Map<string, string>();
  draft.segments.forEach((segment, index) => {
    keyToId.set(segment.key, `seg-${String(index + 1).padStart(3, '0')}-${segment.firstEntryIndex}-${segment.lastEntryIndex}`);
  });
  const segments = draft.segments.map((source): DirectorSegmentPlan => {
    const entries = rangeEntries(options.entries, source.firstEntryIndex, source.lastEntryIndex);
    const id = keyToId.get(source.key)!;
    const selected = (source.selectedAssets ?? []).map((choice) => ({
      choice,
      candidate: options.candidates.get(choice.candidateId)!,
    }));
    const compositionAssets = selected.map(({ choice, candidate }) => ({
      asset: selectedAsset(candidate.clip),
      usage: choice.usage,
      trimStartMs: choice.trimStartMs,
    }));
    const decisions: DirectorAssetDecision[] = [
      ...selected.map(({ choice, candidate }) => ({
        candidateId: candidate.clip.id,
        decision: 'selected' as const,
        reason: choice.reason,
        confidence: choice.confidence,
        inspected: candidate.inspected,
      })),
      ...(source.rejectedAssets ?? []).map((choice) => ({
        candidateId: options.candidates.get(choice.candidateId)?.clip.id ?? choice.candidateId,
        decision: 'rejected' as const,
        reason: choice.reason,
        confidence: choice.confidence,
        inspected: options.candidates.get(choice.candidateId)?.inspected ?? false,
      })),
    ];
    const renderStrategy = source.renderStrategy;
    const primary = compositionAssets.find((item) => item.usage === 'required') ?? compositionAssets[0];
    const visualType = source.visualType
      ?? (renderStrategy === 'motion-card'
        ? 'motion'
        : primary?.asset.kind === 'image'
          ? 'image'
          : 'footage');
    const segment: DirectorSegmentPlan = {
      id,
      title: source.title.trim(),
      summary: source.summary.trim(),
      startMs: entries[0].startMs,
      endMs: entries[entries.length - 1].endMs,
      transcriptExcerpt: entries.map((entry) => entry.text.trim()).filter(Boolean).join(' '),
      semanticType: source.semanticType,
      complexityLevel: source.complexityLevel,
      visualizationScore: source.visualizationScore,
      pacingNeed: source.pacingNeed,
      keywords: source.keywords,
      entities: source.entities,
      visualType,
      footageQuery: renderStrategy === 'motion-card' ? undefined : source.footageQuery?.trim(),
      footageFallback: source.fallbackPolicy === 'motion' ? 'motion' : undefined,
      enabled: source.enabled,
      purpose: source.purpose,
      carrier: renderStrategy === 'standalone-media' ? 'footage' : source.carrier,
      intensity: source.intensity,
      selectedFootage: renderStrategy === 'standalone-media' && primary
        ? primary.asset
        : undefined,
      renderStrategy,
      compositionIntent: renderStrategy === 'agent-composite' ? source.compositionIntent : undefined,
      compositionAssets: renderStrategy === 'motion-card' ? undefined : compositionAssets,
      fallbackPolicy: renderStrategy === 'motion-card' ? undefined : source.fallbackPolicy,
      composition: renderStrategy === 'agent-composite'
        ? undefined
        : source.composition ?? (renderStrategy === 'standalone-media' ? 'full-bleed' : 'graphic'),
      cameraMove: source.cameraMove ?? (renderStrategy === 'motion-card' ? 'static' : 'push-in'),
      mediaRole: source.mediaRole ?? (source.semanticType === 'data' ? 'evidence' : 'context'),
      transition: source.transition,
      rationale: source.strategyReason.trim(),
      strategyReason: source.strategyReason.trim(),
      strategyConfidence: source.confidence,
      mediaIndispensability: source.mediaIndispensability?.trim(),
      graphicsIndispensability: source.graphicsIndispensability?.trim(),
      assetDecisions: decisions.length > 0 ? decisions : undefined,
      strategyStatus: source.strategyStatus ?? 'ready',
      blockedReason: source.blockedReason?.trim(),
      fallbackDecision: source.fallbackDecision,
    };
    return applyLocks(segment, options.existingPlan ?? null, entries);
  });
  const planLocks = options.existingPlan?.userLocks;
  const title = planLocks?.title && options.existingPlan?.title?.trim()
    ? options.existingPlan.title.trim()
    : draft.title.trim();
  const summary = planLocks?.summary && options.existingPlan?.summary.trim()
    ? options.existingPlan.summary.trim()
    : draft.summary.trim();
  const coverDirection = planLocks?.cover && options.existingPlan
    ? options.existingPlan.coverDirection
    : { ...draft.coverDirection, prompt: alignCoverPromptTitle(draft.coverDirection.prompt, title) };
  const audioDirection = planLocks?.audio && options.existingPlan
    ? options.existingPlan.audioDirection
    : draft.audioDirection;
  const visualThesis = planLocks?.globalDirection && options.existingPlan
    ? options.existingPlan.motionBible.visualThesis
    : draft.visualThesis.trim();
  const styleRules = planLocks?.globalDirection && options.existingPlan
    ? options.existingPlan.motionBible.styleRules
    : draft.styleRules;
  const transitionRules = planLocks?.globalDirection && options.existingPlan
    ? options.existingPlan.motionBible.transitionRules
    : {
        default: draft.defaultTransition,
        matchCutCandidates: draft.matchCuts.map((match) => ({
          fromSegmentId: keyToId.get(match.fromKey)!,
          toSegmentId: keyToId.get(match.toKey)!,
          motif: match.motif,
        })),
      };
  return {
    revision: options.revision,
    inputFingerprint: createDirectorInputFingerprint({
      entries: options.entries,
      globalPrompt: options.globalPrompt,
      stylePresetId: options.stylePresetId,
    }),
    title,
    summary,
    keywords: draft.keywords.map((value) => value.trim()).filter(Boolean),
    userPrompt: options.globalPrompt?.trim() || undefined,
    globalPrompt: options.globalPrompt?.trim() || draft.globalPrompt?.trim() || undefined,
    segments,
    motionBible: {
      visualThesis,
      rhythm: {
        density: draft.rhythmDensity,
        heavySegments: segments.filter((segment) => segment.intensity === 3).map((segment) => segment.id),
        quietSegments: segments.filter((segment) => segment.intensity === 1).map((segment) => segment.id),
      },
      carrierPlan: segments.map((segment) => ({
        segmentId: segment.id,
        visualType: segment.visualType,
        preferredCarrier: segment.carrier,
        intensity: segment.intensity,
        composition: segment.composition,
        cameraMove: segment.cameraMove,
        mediaRole: segment.mediaRole,
        renderStrategy: segment.renderStrategy,
        compositionIntent: segment.compositionIntent,
        fallbackPolicy: segment.fallbackPolicy,
        mediaQuery: segment.footageQuery,
        footageFallback: segment.footageFallback,
        transition: segment.transition,
        reason: segment.rationale,
      })),
      styleRules,
      transitionRules,
      generatedAt: now,
      fallbackUsed: segments.some((segment) => segment.strategyStatus === 'fallback'),
      warnings: segments
        .filter((segment) => segment.strategyStatus === 'blocked' || segment.strategyStatus === 'fallback')
        .map((segment) => ({
          severity: segment.strategyStatus === 'blocked' ? 'error' as const : 'warning' as const,
          code: segment.strategyStatus === 'blocked' ? 'director-shot-blocked' : 'director-shot-fallback',
          message: segment.blockedReason ?? segment.fallbackDecision?.reason ?? '镜头使用了显式退路',
          segmentId: segment.id,
        })),
    },
    coverDirection,
    audioDirection,
    warnings: draft.warnings ?? [],
    zeroCompositeReason: draft.zeroCompositeReason?.trim() || undefined,
    userLocks: planLocks ? { ...planLocks } : undefined,
    createdAt: options.existingPlan?.createdAt ?? now,
    updatedAt: now,
  };
}
