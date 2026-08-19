import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Film,
  Image as ImageIcon,
  Layers3,
  LockKeyhole,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Unlock,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  resolveDirectorRenderStrategy,
  type DirectorCompositionIntent,
  type DirectorFallbackPolicy,
  type DirectorPlan,
  type DirectorRenderStrategy,
  type DirectorSegmentPlan,
} from '../../types/director';
import type {
  DirectorCompositionAsset,
  FootagePlacement,
  KacutClip,
  SelectedFootageAsset,
} from '../../types/footage';
import { DEFAULT_KACUT_BASE_URL } from '../../types/ai';
import { Button, Checkbox, Input, Modal, PillGroup, Select, Switch, Textarea } from '../../ui';
import {
  areDirectorSoundEffectsEnabled,
  isDirectorBgmEnabled,
} from '../../lib/director-audio-options';
import { alignCoverPromptTitle } from '../../lib/cover-title';
import { getFileNameFromPath, toFileSrc } from '../../lib/utils';
import styles from './DirectorPlanEditor.module.css';
import { CARRIER_META, STORYBOARD_CARRIERS } from '../../lib/motion-storyboard';

const CARRIERS = [
  ...STORYBOARD_CARRIERS.map((value) => ({ value, label: `${CARRIER_META[value].label} ${value}` })),
  { value: 'image', label: '图片 image' },
];

const PURPOSES = [
  ['context', '建立语境'], ['explain', '解释'], ['compare', '对比'], ['evidence', '证据'],
  ['emphasis', '强调'], ['transition', '转场'], ['breath', '留白'],
].map(([value, label]) => ({ value, label }));

const CAMERA_MOVES = [
  ['static', '固定'], ['push-in', '推近'], ['pull-out', '拉远'], ['pan-left', '左摇'],
  ['pan-right', '右摇'], ['tracking', '跟随'],
].map(([value, label]) => ({ value, label }));

const MEDIA_ROLES = [
  ['evidence', '事实证据'], ['context', '建立语境'], ['emotion', '情绪留白'], ['demonstration', '解释演示'],
].map(([value, label]) => ({ value, label }));

const SHOT_TRANSITIONS = [
  ['', '沿用整片'], ['crossfade', '交叉淡化'], ['hard-cut', '硬切'], ['push', '推移'],
  ['wipe', '擦除'], ['match-cut', '匹配剪辑'],
].map(([value, label]) => ({ value, label }));

type ShotVisualType = NonNullable<DirectorSegmentPlan['visualType']>;

type RenderStrategy = DirectorRenderStrategy;
type CompositionIntent = DirectorCompositionIntent;
type CompositionAsset = DirectorCompositionAsset;
type SegmentPatch = Partial<DirectorSegmentPlan>;
type SegmentLock = keyof NonNullable<DirectorSegmentPlan['userLocks']>;

type ShotPresentationKind =
  | 'motion-animation'
  | 'image-card'
  | 'standalone-video'
  | 'standalone-image'
  | 'agent-composite';

const STRATEGY_META = {
  'motion-card': { label: 'Motion 卡', Icon: Sparkles },
  'standalone-media': { label: '独立素材', Icon: Film },
  'agent-composite': { label: 'Agent 合成', Icon: Layers3 },
} satisfies Record<RenderStrategy, { label: string; Icon: typeof Sparkles }>;

const RENDER_STRATEGIES = [
  { value: 'motion-card', label: 'Motion 卡' },
  { value: 'standalone-media', label: '独立素材' },
  { value: 'agent-composite', label: 'Agent 合成' },
] satisfies Array<{ value: RenderStrategy; label: string }>;

const MOTION_VISUAL_TYPES = [
  { value: 'motion', label: '动态图形' },
  { value: 'image', label: '生成图片' },
] satisfies Array<{ value: ShotVisualType; label: string }>;

const MEDIA_VISUAL_TYPES = [
  { value: 'footage', label: '视频素材' },
  { value: 'image', label: '图片素材' },
] satisfies Array<{ value: ShotVisualType; label: string }>;

const FALLBACK_POLICIES = [
  { value: 'standalone-media', label: '仅保留素材' },
  { value: 'motion', label: '回退 Motion' },
  { value: 'block', label: '阻止制作' },
] satisfies Array<{ value: DirectorFallbackPolicy; label: string }>;

const FOOTAGE_REVIEW_LIMIT = 6;
export function DirectorPlanEditor({
  plan,
  selectedSegmentId,
  onSelectSegment,
  onChange,
  onCommit,
  readOnly = false,
  footagePlacements = [],
  kacutBaseUrl = DEFAULT_KACUT_BASE_URL,
  kacutEnabled = true,
}: {
  plan: DirectorPlan;
  selectedSegmentId: string | null;
  onSelectSegment: (segmentId: string) => void;
  onChange: (plan: DirectorPlan) => void;
  onCommit?: (plan: DirectorPlan) => void | Promise<void>;
  /** 导演任务运行时保留详情预览，但阻止旧草案继续写入。 */
  readOnly?: boolean;
  /** footage 轨已产出的素材放置（恢复运行 / 重审时用于展示匹配结果）。 */
  footagePlacements?: FootagePlacement[];
  /** 导演审核阶段检索素材使用的 KaCut 服务地址。 */
  kacutBaseUrl?: string;
  /** 与设置中的素材联动开关一致；关闭时不可从导演台制造“可搜材”的假象。 */
  kacutEnabled?: boolean;
}) {
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [committingSegment, setCommittingSegment] = useState(false);
  const editingSegmentDirty = useRef(false);
  const editingSegment = plan.segments.find((segment) => segment.id === editingSegmentId) ?? null;
  const editingIndex = editingSegment
    ? plan.segments.findIndex((segment) => segment.id === editingSegment.id)
    : -1;
  const placementBySegmentId = new Map(footagePlacements.map((placement) => [placement.segmentId, placement]));
  const bgmEnabled = isDirectorBgmEnabled(plan.audioDirection);
  const soundEffectsEnabled = areDirectorSoundEffectsEnabled(plan.audioDirection);
  const patchPlan = (patch: Partial<DirectorPlan>) => {
    if (readOnly) return;
    onChange({ ...plan, ...patch, updatedAt: Date.now() });
  };
  const patchLockedPlan = (
    patch: Partial<DirectorPlan>,
    lock: keyof NonNullable<DirectorPlan['userLocks']>,
  ) => patchPlan({
    ...patch,
    userLocks: { ...plan.userLocks, [lock]: true },
  });
  const setPlanLock = (lock: keyof NonNullable<DirectorPlan['userLocks']>, checked: boolean) => patchPlan({
    userLocks: { ...plan.userLocks, [lock]: checked },
  });
  const patchBible = (patch: Partial<DirectorPlan['motionBible']>) => patchLockedPlan({
    motionBible: { ...plan.motionBible, ...patch },
  }, 'globalDirection');
  const patchSegment = (segmentId: string, patch: SegmentPatch, lock?: SegmentLock) => {
    if (readOnly) return;
    const segments = plan.segments.map((segment) => {
      if (segment.id !== segmentId) return segment;
      const locks = { ...segment.userLocks, ...patch.userLocks };
      if (lock) locks[lock] = true;
      return { ...segment, ...patch, userLocks: locks };
    });
    const next = segments.find((segment) => segment.id === segmentId);
    if (!next) return;
    editingSegmentDirty.current = true;
    const nextVisualType = next.visualType ?? 'motion';
    const carrierPlan = plan.motionBible.carrierPlan.map((directive) => directive.segmentId === next.id
      ? {
          ...directive,
          visualType: nextVisualType,
          preferredCarrier: nextVisualType === 'motion' ? next.carrier : nextVisualType,
          intensity: next.intensity,
          composition: next.composition,
          cameraMove: next.cameraMove,
          mediaRole: next.mediaRole,
          renderStrategy: resolveDirectorRenderStrategy(next),
          compositionIntent: next.compositionIntent,
          fallbackPolicy: next.fallbackPolicy,
          mediaQuery: next.visualType === 'footage' ? next.footageQuery : undefined,
          footageFallback: next.visualType === 'footage' ? next.footageFallback : undefined,
          transition: next.transition,
          reason: next.rationale,
        }
      : directive);
    if (!carrierPlan.some((directive) => directive.segmentId === next.id)) {
      carrierPlan.push({
        segmentId: next.id,
        visualType: nextVisualType,
        preferredCarrier: nextVisualType === 'motion' ? next.carrier : nextVisualType,
        intensity: next.intensity,
        composition: next.composition,
        cameraMove: next.cameraMove,
        mediaRole: next.mediaRole,
        renderStrategy: resolveDirectorRenderStrategy(next),
        compositionIntent: next.compositionIntent,
        fallbackPolicy: next.fallbackPolicy,
        mediaQuery: next.visualType === 'footage' ? next.footageQuery : undefined,
        footageFallback: next.visualType === 'footage' ? next.footageFallback : undefined,
        transition: next.transition,
        reason: next.rationale,
      });
    }
    patchPlan({
      segments,
      motionBible: {
        ...plan.motionBible,
        carrierPlan,
        rhythm: {
          ...plan.motionBible.rhythm,
          heavySegments: segments.filter((segment) => segment.intensity === 3).map((segment) => segment.id),
          quietSegments: segments.filter((segment) => segment.intensity === 1).map((segment) => segment.id),
        },
      },
    });
  };
  const openSegment = (segmentId: string) => {
    if (editingSegmentId === null) editingSegmentDirty.current = false;
    onSelectSegment(segmentId);
    setEditingSegmentId(segmentId);
  };
  const closeSegment = async () => {
    if (committingSegment) return;
    if (readOnly || !editingSegmentDirty.current || !onCommit) {
      editingSegmentDirty.current = false;
      setEditingSegmentId(null);
      return;
    }
    setCommittingSegment(true);
    try {
      await onCommit(plan);
      editingSegmentDirty.current = false;
      setEditingSegmentId(null);
    } catch {
      // The parent surfaces the save error; keep the editor open so the draft is not lost.
    } finally {
      setCommittingSegment(false);
    }
  };
  useEffect(() => {
    if (readOnly) editingSegmentDirty.current = false;
  }, [readOnly]);
  const navigateSegment = (offset: -1 | 1) => {
    const next = plan.segments[editingIndex + offset];
    if (next) openSegment(next.id);
  };
  const segmentOptions = plan.segments.map((segment, index) => ({
    value: segment.id,
    label: `${index + 1}. ${segment.title}`,
  }));
  const patchMatchCut = (
    index: number,
    patch: Partial<DirectorPlan['motionBible']['transitionRules']['matchCutCandidates'][number]>,
  ) => patchBible({
    transitionRules: {
      ...plan.motionBible.transitionRules,
      matchCutCandidates: plan.motionBible.transitionRules.matchCutCandidates.map((candidate, itemIndex) => (
        itemIndex === index ? { ...candidate, ...patch } : candidate
      )),
    },
  });
  const removeMatchCut = (index: number) => patchBible({
    transitionRules: {
      ...plan.motionBible.transitionRules,
      matchCutCandidates: plan.motionBible.transitionRules.matchCutCandidates.filter((_, itemIndex) => itemIndex !== index),
    },
  });
  const addMatchCut = () => {
    if (plan.segments.length < 2) return;
    patchBible({
      transitionRules: {
        ...plan.motionBible.transitionRules,
        matchCutCandidates: [...plan.motionBible.transitionRules.matchCutCandidates, {
          fromSegmentId: plan.segments[0].id,
          toSegmentId: plan.segments[1].id,
          motif: '',
        }],
      },
    });
  };
  const enabledCount = plan.segments.filter((segment) => segment.enabled).length;
  const presentationCounts = plan.segments.reduce<Record<ShotPresentationKind, number>>((counts, segment) => {
    if (!segment.enabled) return counts;
    counts[shotPresentation(segment).kind] += 1;
    return counts;
  }, {
    'motion-animation': 0,
    'image-card': 0,
    'standalone-video': 0,
    'standalone-image': 0,
    'agent-composite': 0,
  });
  const selectedAssetCounts = plan.segments.reduce((counts, segment) => {
    if (!segment.enabled) return counts;
    if (resolveDirectorRenderStrategy(segment) === 'motion-card') return counts;
    for (const binding of segmentCompositionAssets(segment)) counts[binding.usage] += 1;
    return counts;
  }, { required: 0, optional: 0 });
  const allEnabledShotsAreMotion = enabledCount > 0
    && presentationCounts['motion-animation'] === enabledCount;
  const lockSummary = summarizePlanLocks(plan);
  const materialAudit = plan.agentPlanning;
  const motionOnlyAuditText = !kacutEnabled
    ? '素材联动当前未启用，这份全 Motion 没有经过真实素材审查。'
    : (materialAudit?.materialSearchFailures ?? 0) > 0
      ? `素材检索失败 ${materialAudit?.materialSearchFailures} 次，这份全 Motion 不能视为完整媒介结论。`
      : materialAudit?.materialSearches == null
        ? '该草案没有可核对的新版素材审计，修复不会自动改写已保存方案。'
        : materialAudit.materialSearches === 0
          ? '未记录素材检索，当前全 Motion 缺少真实素材审查依据。'
          : `已检索 ${materialAudit.materialSearches} 次、检视 ${materialAudit.inspectedCandidateCount ?? 0} 个候选，当前选择仍全部为 Motion。`;

  return (
    <>
      <div className={styles.workspace}>
        <main className={styles.canvas}>
          <section className={styles.storyboard} aria-label="全片分镜">
            <header className={styles.storyboardHeader}>
              <div>
                <span>分镜总览</span>
                <h2>全片镜头排布</h2>
              </div>
              <div className={styles.storyboardStats} aria-label="分镜统计">
                <span><strong>{enabledCount}</strong> / {plan.segments.length} 启用</span>
                <span data-media="motion-animation">Motion 动画 {presentationCounts['motion-animation']}</span>
                <span data-media="image-card">图片卡 {presentationCounts['image-card']}</span>
                <span data-media="standalone-video">视频素材 {presentationCounts['standalone-video']}</span>
                <span data-media="standalone-image">图片素材 {presentationCounts['standalone-image']}</span>
                <span data-media="agent-composite">Agent 合成 {presentationCounts['agent-composite']}</span>
                <span data-assets>必用 {selectedAssetCounts.required} · 可选 {selectedAssetCounts.optional}</span>
              </div>
            </header>
            {lockSummary.totalFields > 0 ? (
              <div className={styles.lockSummary} data-testid="director-plan-lock-summary">
                <LockKeyhole size={16} />
                <span>
                  重新编排将保留 {lockSummary.planFields} 个整片字段、{lockSummary.segmentCount} 个镜头中的 {lockSummary.segmentFields} 项手工修改
                </span>
                <Button type="button" variant="ghost" size="sm" onClick={() => patchPlan({
                  userLocks: undefined,
                  segments: plan.segments.map((segment) => segment.userLocks
                    ? { ...segment, userLocks: undefined }
                    : segment),
                })}>
                  <Unlock size={13} />解除全部保护
                </Button>
              </div>
            ) : null}
            {allEnabledShotsAreMotion ? (
              <div className={styles.motionOnlyNotice} data-testid="director-plan-motion-only-warning">
                <AlertTriangle size={17} />
                <div>
                  <strong>当前草案全部是 Motion</strong>
                  <span>视频素材 0、图片画面 0、Agent 合成 0。{motionOnlyAuditText} 可重新编排，或打开镜头检索预览素材再决定策略。</span>
                </div>
              </div>
            ) : null}
            {plan.segments.length > 0 ? (
              <div className={styles.shotGrid}>
                {plan.segments.map((segment, index) => (
                  <ShotCard
                    key={segment.id}
                    segment={segment}
                    index={index}
                    placement={placementBySegmentId.get(segment.id)}
                    active={editingSegmentId !== null && segment.id === selectedSegmentId}
                    onClick={() => openSegment(segment.id)}
                  />
                ))}
              </div>
            ) : <div className={styles.emptyShots}>暂无可编排镜头</div>}
          </section>

          <div className={styles.settingsColumns}>
            <Section title="整片导演命题">
              <Field label="作品标题">
                <Input value={plan.title ?? ''} onChange={(event) => {
                  const title = event.target.value;
                  patchPlan({
                    title,
                    coverDirection: {
                      ...plan.coverDirection,
                      prompt: alignCoverPromptTitle(plan.coverDirection.prompt, title),
                    },
                    userLocks: { ...plan.userLocks, title: true, cover: true },
                  });
                }} />
              </Field>
              <Field label="作品简介">
                <Textarea value={plan.summary} rows={3} resize="vertical" onChange={(event) => patchLockedPlan({ summary: event.target.value }, 'summary')} />
              </Field>
              <Field label="关键词">
                <Input value={plan.keywords.join('，')} onChange={(event) => patchLockedPlan({
                  keywords: event.target.value.split(/[,，、]/u).map((value) => value.trim()).filter(Boolean),
                }, 'globalDirection')} />
              </Field>
              <Field label="整体创作要求">
                <Textarea value={plan.globalPrompt ?? ''} rows={2} resize="vertical" onChange={(event) => patchLockedPlan({
                  globalPrompt: event.target.value,
                  userPrompt: event.target.value,
                }, 'globalDirection')} />
              </Field>
              <div className={styles.lockRow} aria-label="整片重新编排保护">
                <label><Checkbox checked={plan.userLocks?.title === true} onChange={(checked) => setPlanLock('title', checked)} />标题</label>
                <label><Checkbox checked={plan.userLocks?.summary === true} onChange={(checked) => setPlanLock('summary', checked)} />简介</label>
                <label><Checkbox checked={plan.userLocks?.globalDirection === true} onChange={(checked) => setPlanLock('globalDirection', checked)} />整片方向</label>
              </div>
              <Field label="视觉命题">
                <Textarea value={plan.motionBible.visualThesis} rows={2} resize="vertical" onChange={(event) => patchBible({ visualThesis: event.target.value })} />
              </Field>
              <Field label="整片节奏密度">
                <PillGroup fullWidth wrap={false} value={plan.motionBible.rhythm.density} items={[
                  { value: 'quiet', label: '克制' }, { value: 'balanced', label: '平衡' }, { value: 'dense', label: '密集' },
                ]} onChange={(density) => patchBible({ rhythm: { ...plan.motionBible.rhythm, density } })} />
              </Field>
            </Section>

            <Section title="视觉与转场规则">
              <Field label="色彩规则"><Textarea value={plan.motionBible.styleRules.paletteUse} rows={2} resize="vertical" onChange={(event) => patchBible({ styleRules: { ...plan.motionBible.styleRules, paletteUse: event.target.value } })} /></Field>
              <Field label="字体规则"><Textarea value={plan.motionBible.styleRules.typographyUse} rows={2} resize="vertical" onChange={(event) => patchBible({ styleRules: { ...plan.motionBible.styleRules, typographyUse: event.target.value } })} /></Field>
              <Field label="重复母题"><Input value={plan.motionBible.styleRules.recurringMotif ?? ''} onChange={(event) => patchBible({ styleRules: { ...plan.motionBible.styleRules, recurringMotif: event.target.value } })} /></Field>
              <Field label="默认转场"><Select value={plan.motionBible.transitionRules.default} options={[
                { value: 'crossfade', label: '交叉淡化' }, { value: 'hard-cut', label: '硬切' },
                { value: 'push', label: '推移' }, { value: 'wipe', label: '擦除' }, { value: 'match-cut', label: '匹配剪辑' },
              ]} onChange={(event) => patchBible({ transitionRules: { ...plan.motionBible.transitionRules, default: event.target.value as DirectorPlan['motionBible']['transitionRules']['default'] } })} /></Field>
              <div className={styles.matchCutField}>
                <div className={styles.matchCutHeader}>
                  <span>匹配剪辑候选</span>
                  <Button.Icon type="button" variant="ghost" aria-label="添加匹配剪辑" title="添加匹配剪辑" onClick={addMatchCut} disabled={plan.segments.length < 2}>
                    <Plus size={14} />
                  </Button.Icon>
                </div>
                {plan.motionBible.transitionRules.matchCutCandidates.map((candidate, index) => (
                  <div className={styles.matchCutRow} key={`${candidate.fromSegmentId}-${candidate.toSegmentId}-${index}`}>
                    <Select value={candidate.fromSegmentId} options={segmentOptions} onChange={(event) => patchMatchCut(index, { fromSegmentId: event.target.value })} aria-label="起始镜头" />
                    <Select value={candidate.toSegmentId} options={segmentOptions} onChange={(event) => patchMatchCut(index, { toSegmentId: event.target.value })} aria-label="目标镜头" />
                    <Input value={candidate.motif} placeholder="匹配母题" onChange={(event) => patchMatchCut(index, { motif: event.target.value })} aria-label="匹配母题" />
                    <Button.Icon type="button" variant="ghost" aria-label="删除匹配剪辑" title="删除匹配剪辑" onClick={() => removeMatchCut(index)}>
                      <Trash2 size={13} />
                    </Button.Icon>
                  </div>
                ))}
              </div>
            </Section>
          </div>

          <Section title="封面与声音方向">
            <div className={styles.lockRow} aria-label="封面与声音重新编排保护">
              <label><Checkbox checked={plan.userLocks?.cover === true} onChange={(checked) => setPlanLock('cover', checked)} />封面</label>
              <label><Checkbox checked={plan.userLocks?.audio === true} onChange={(checked) => setPlanLock('audio', checked)} />声音</label>
            </div>
            <div className={styles.coverAudioGrid}>
              <div className={styles.coverFields}>
                <Field label="封面方向"><Textarea value={plan.coverDirection.prompt} rows={3} resize="vertical" onChange={(event) => patchLockedPlan({ coverDirection: { ...plan.coverDirection, prompt: event.target.value } }, 'cover')} /></Field>
                <div className={styles.twoColumns}>
                  <Field label="封面构图"><Input value={plan.coverDirection.composition} onChange={(event) => patchLockedPlan({ coverDirection: { ...plan.coverDirection, composition: event.target.value } }, 'cover')} /></Field>
                  <Field label="封面氛围"><Input value={plan.coverDirection.mood ?? ''} onChange={(event) => patchLockedPlan({ coverDirection: { ...plan.coverDirection, mood: event.target.value } }, 'cover')} /></Field>
                </div>
                <Field label="封面字体方向"><Input value={plan.coverDirection.typography ?? ''} onChange={(event) => patchLockedPlan({ coverDirection: { ...plan.coverDirection, typography: event.target.value } }, 'cover')} /></Field>
                <Field label="封面排除项"><Textarea value={plan.coverDirection.negativeConstraints ?? ''} rows={2} resize="vertical" onChange={(event) => patchLockedPlan({ coverDirection: { ...plan.coverDirection, negativeConstraints: event.target.value } }, 'cover')} /></Field>
              </div>
              <div className={styles.audioFields}>
                <div className={styles.audioOptions}>
                  <div className={styles.audioOption}>
                    <div><strong>背景音乐</strong><span>为连续口播添加低干扰配乐</span></div>
                    <Switch checked={bgmEnabled} aria-label="启用背景音乐" onChange={(bgmEnabled) => patchLockedPlan({ audioDirection: { ...plan.audioDirection, bgmEnabled } }, 'audio')} />
                  </div>
                  <div className={styles.audioOption}>
                    <div><strong>环境与音效</strong><span>在章节切换和重点镜头加入声音提示</span></div>
                    <Switch checked={soundEffectsEnabled} aria-label="启用环境与音效" onChange={(soundEffectsEnabled) => patchLockedPlan({ audioDirection: { ...plan.audioDirection, soundEffectsEnabled } }, 'audio')} />
                  </div>
                </div>
                {bgmEnabled ? <>
                  <Field label="BGM 风格"><Textarea value={plan.audioDirection.bgmStyle} rows={2} resize="vertical" onChange={(event) => patchLockedPlan({ audioDirection: { ...plan.audioDirection, bgmStyle: event.target.value } }, 'audio')} /></Field>
                  <Field label="音乐能量"><PillGroup fullWidth wrap={false} value={String(plan.audioDirection.energy)} items={[
                    { value: '1', label: '低' }, { value: '2', label: '中' }, { value: '3', label: '高' },
                  ]} onChange={(value) => patchLockedPlan({ audioDirection: { ...plan.audioDirection, energy: Number(value) as 1 | 2 | 3 } }, 'audio')} /></Field>
                </> : null}
                {soundEffectsEnabled ? (
                  <Field label="音效密度"><PillGroup fullWidth wrap={false} value={plan.audioDirection.soundDensity} items={[
                    { value: 'quiet', label: '少' }, { value: 'balanced', label: '平衡' }, { value: 'active', label: '多' },
                  ]} onChange={(soundDensity) => patchLockedPlan({ audioDirection: { ...plan.audioDirection, soundDensity } }, 'audio')} /></Field>
                ) : null}
                {!bgmEnabled && !soundEffectsEnabled ? (
                  <div className={styles.audioDisabledNote}>本片只保留口播，不生成背景音乐和提示音效。</div>
                ) : null}
              </div>
            </div>
          </Section>
        </main>

        <aside className={styles.review}><ReviewPanel plan={plan} /></aside>
        <details className={styles.reviewDrawer}>
          <summary><AlertTriangle size={13} />风险与检查</summary>
          <div><ReviewPanel plan={plan} /></div>
        </details>
      </div>

      <Modal
        isOpen={Boolean(editingSegment)}
        onClose={() => void closeSegment()}
        title={editingSegment ? `镜头 ${editingIndex + 1} · ${editingSegment.title}` : '镜头详情'}
        size="xl"
        className={styles.shotModal}
      >
        {editingSegment ? (
          <div className={styles.shotEditor} data-testid="director-shot-editor">
            <div className={styles.shotEditorMeta}>
              <span><Clock3 size={13} />{formatTime(editingSegment.startMs)} - {formatTime(editingSegment.endMs)}</span>
              <span>{optionLabel(PURPOSES, editingSegment.purpose)}</span>
              <span>{STRATEGY_META[resolveDirectorRenderStrategy(editingSegment)].label}</span>
            </div>
            <fieldset className={styles.shotEditorFields} disabled={readOnly || committingSegment}>
              <ShotDetailEditor
                segment={editingSegment}
                placement={placementBySegmentId.get(editingSegment.id)}
                kacutBaseUrl={kacutBaseUrl}
                kacutEnabled={kacutEnabled}
                onPatch={(patch, lock) => patchSegment(editingSegment.id, patch, lock)}
              />
            </fieldset>
            <div className={styles.shotEditorFooter}>
              <div className={styles.shotNavigation}>
                <Button.Icon type="button" variant="ghost" title="上一镜头" aria-label="上一镜头" disabled={editingIndex <= 0} onClick={() => navigateSegment(-1)}>
                  <ChevronLeft size={15} />
                </Button.Icon>
                <span>{editingIndex + 1} / {plan.segments.length}</span>
                <Button.Icon type="button" variant="ghost" title="下一镜头" aria-label="下一镜头" disabled={editingIndex >= plan.segments.length - 1} onClick={() => navigateSegment(1)}>
                  <ChevronRight size={15} />
                </Button.Icon>
              </div>
              <Button type="button" variant="primary" onClick={() => void closeSegment()} disabled={committingSegment}>
                {committingSegment ? '保存中…' : '完成'}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

function ShotCard({
  segment,
  index,
  placement,
  active,
  onClick,
}: {
  segment: DirectorSegmentPlan;
  index: number;
  placement?: FootagePlacement;
  active: boolean;
  onClick: () => void;
}) {
  const visualType = shotVisualType(segment);
  const strategy = resolveDirectorRenderStrategy(segment);
  const presentation = shotPresentation(segment);
  const { Icon, label } = presentation;
  const assets = segmentCompositionAssets(segment);
  const requiredCount = assets.filter((binding) => binding.usage === 'required').length;
  const optionalCount = assets.length - requiredCount;
  const intent = segmentCompositionIntent(segment);
  const primaryAsset = assets[0]?.asset;
  const carrier = strategy === 'standalone-media'
    ? primaryAsset?.filename
      ?? (placement ? getFileNameFromPath(placement.sourcePath) : segment.footageQuery || '待匹配素材')
    : carrierLabel(segment.carrier);
  const previewSources = (strategy === 'motion-card' ? [] : assets)
    .map(({ asset }) => asset.thumbnailFile ?? (asset.kind === 'image' ? asset.path : undefined))
    .filter((source): source is string => Boolean(source));
  if (previewSources.length === 0 && placement?.thumbnailFile) previewSources.push(placement.thumbnailFile);
  const materialStatus = presentation.kind === 'image-card'
    ? '生成图片'
    : strategy === 'motion-card'
      ? '无需素材'
    : requiredCount > 0
      ? `必用素材 ${requiredCount}`
      : optionalCount > 0
        ? `可选素材 ${optionalCount}`
        : placement
          ? '素材已就绪'
          : '等待选材';
  const strategyStatus = segment.strategyStatus ?? 'ready';
  return (
    <button
      type="button"
      className={styles.shotCard}
      data-testid="director-shot-card"
      data-active={active}
      data-enabled={segment.enabled}
      data-visual-type={visualType}
      data-render-strategy={strategy}
      data-strategy-status={strategyStatus}
      aria-pressed={active}
      aria-label={`编辑镜头 ${index + 1}：${segment.title}`}
      onClick={onClick}
    >
      <span className={styles.shotPreview}>
        {previewSources.length > 0 ? (
          <span className={styles.shotPreviewAssets} data-count={Math.min(previewSources.length, 3)}>
            {previewSources.slice(0, 3).map((source, sourceIndex) => (
              <img key={`${source}-${sourceIndex}`} src={toFileSrc(source)} alt={`${segment.title} 素材 ${sourceIndex + 1}`} />
            ))}
          </span>
        ) : (
          <span className={styles.shotPreviewFallback}><Icon size={28} /><small>{carrier}</small></span>
        )}
        <span className={styles.shotType}><Icon size={13} />{label}</span>
        {!segment.enabled ? <span className={styles.disabledBadge}>未启用</span> : null}
        {segment.enabled && strategyStatus !== 'ready' ? (
          <span className={styles.shotStatus} data-status={strategyStatus}>
            {strategyStatus === 'blocked' ? '已阻塞' : '显式退路'}
          </span>
        ) : null}
        <span className={styles.manualFootageBadge} data-ready={strategyStatus === 'ready' && (requiredCount > 0 || Boolean(placement))}>{strategyStatus === 'blocked' ? '等待处理' : materialStatus}</span>
      </span>
      <span className={styles.shotBody}>
        <span className={styles.shotHeading}>
          <span className={styles.shotNumber}>{String(index + 1).padStart(2, '0')}</span>
          <span className={styles.shotTime}><Clock3 size={12} />{formatTime(segment.startMs)} - {formatTime(segment.endMs)}</span>
          <span className={styles.editGlyph} title="编辑镜头"><Pencil size={13} /></span>
        </span>
        <strong className={styles.shotTitle}>{segment.title}</strong>
        <span className={styles.shotSummary}>{segment.summary}</span>
        <span className={styles.shotCarrier}>{carrier}</span>
        {strategy === 'agent-composite' ? (
          <span className={styles.shotIntent}>{intent.narrativeGoal || segment.rationale || '待补充合成意图'}</span>
        ) : null}
        <span className={styles.shotDecision}>{segment.strategyReason || segment.rationale}</span>
        <dl className={styles.shotFacts}>
          <div><dt>用途</dt><dd>{optionLabel(PURPOSES, segment.purpose)}</dd></div>
          <div><dt>角色</dt><dd>{optionLabel(MEDIA_ROLES, segment.mediaRole ?? 'context')}</dd></div>
          <div><dt>素材</dt><dd>必用 {requiredCount} · 可选 {optionalCount}</dd></div>
          <div><dt>转场</dt><dd>{optionLabel(SHOT_TRANSITIONS, segment.transition ?? '')}</dd></div>
          <div><dt>判断</dt><dd>{typeof segment.strategyConfidence === 'number' ? `${Math.round(segment.strategyConfidence * 100)}%` : '未记录'}</dd></div>
          <div><dt>保护</dt><dd title={segmentLockText(segment)}>{segmentLockText(segment)}</dd></div>
        </dl>
        <span className={styles.intensityRow}>
          <span>信息强度</span>
          <span className={styles.intensityBars} aria-label={`信息强度 ${segment.intensity}`}>
            {[1, 2, 3].map((level) => <i key={level} data-active={level <= segment.intensity} />)}
          </span>
          <strong>{intensityLabel(segment.intensity)}</strong>
        </span>
      </span>
    </button>
  );
}

function ShotDetailEditor({
  segment,
  placement,
  kacutBaseUrl,
  kacutEnabled,
  onPatch,
}: {
  segment: DirectorSegmentPlan;
  placement?: FootagePlacement;
  kacutBaseUrl: string;
  kacutEnabled: boolean;
  onPatch: (patch: SegmentPatch, lock?: SegmentLock) => void;
}) {
  const visualType = shotVisualType(segment);
  const strategy = resolveDirectorRenderStrategy(segment);
  const assets = segmentCompositionAssets(segment);
  const intent = segmentCompositionIntent(segment);
  const patchIntent = (patch: Partial<CompositionIntent>) => onPatch({
    compositionIntent: { ...intent, ...patch },
  }, 'direction');
  const patchLock = (
    lock: keyof NonNullable<DirectorSegmentPlan['userLocks']>,
    checked: boolean,
  ) => onPatch({ userLocks: { ...segment.userLocks, [lock]: checked } });
  const changeStrategy = (nextStrategy: RenderStrategy) => {
    const primaryBinding = preferredCompositionAsset(assets);
    const standaloneAssets = primaryBinding
      ? [{ ...primaryBinding, usage: 'required' as const }]
      : [];
    const nextCarrier = segment.carrier === 'footage' || segment.carrier === 'image'
      ? 'concept'
      : segment.carrier;
    const selectedVisualType = primaryBinding?.asset.kind === 'image' ? 'image' : 'footage';
    const nextVisualType = nextStrategy === 'motion-card'
      ? visualType === 'image' ? 'image' : 'motion'
      : visualType === 'image' || visualType === 'footage'
        ? visualType
        : selectedVisualType;
    onPatch({
      renderStrategy: nextStrategy,
      visualType: nextVisualType,
      carrier: nextStrategy === 'standalone-media' ? 'footage' : nextCarrier,
      composition: nextStrategy === 'motion-card'
        ? 'graphic'
        : nextStrategy === 'standalone-media'
          ? 'full-bleed'
          : undefined,
      selectedFootage: nextStrategy === 'standalone-media' && standaloneAssets[0]
        ? selectedFootageFromBinding(standaloneAssets[0])
        : undefined,
      compositionAssets: nextStrategy === 'standalone-media' ? standaloneAssets : assets,
      ...(nextStrategy !== 'motion-card' && !segment.footageQuery?.trim()
        ? { footageQuery: segment.title }
        : {}),
      ...(nextStrategy === 'agent-composite'
        ? {
            compositionIntent: intent.narrativeGoal || intent.focalPriority
              ? intent
              : defaultCompositionIntent(segment),
            fallbackPolicy: segment.fallbackPolicy ?? 'block',
          }
        : {}),
      strategyStatus: 'ready',
      blockedReason: undefined,
      fallbackDecision: undefined,
    }, 'strategy');
  };
  return (
    <div className={styles.shotEditorForm}>
      {segment.strategyStatus === 'blocked' || segment.strategyStatus === 'fallback' ? (
        <div className={styles.strategyNotice} data-status={segment.strategyStatus}>
          <AlertTriangle size={14} />
          <span>{segment.strategyStatus === 'blocked'
            ? segment.blockedReason || '该镜头等待解决素材或真实性问题'
            : segment.fallbackDecision?.reason || '该镜头采用了显式退路'}</span>
        </div>
      ) : null}
      <label className={styles.enableRow}>
        <Checkbox checked={segment.enabled} onChange={(enabled) => onPatch({ enabled }, 'direction')} />
        <span>纳入制作执行</span>
        <small>时间码与口播顺序来自字幕，不在导演台修改</small>
      </label>
      <div className={styles.lockRow} aria-label="镜头重新编排保护">
        <span className={styles.lockHint}>已编辑内容自动进入保护</span>
        <label><Checkbox checked={segment.userLocks?.strategy === true} onChange={(checked) => patchLock('strategy', checked)} />策略</label>
        <label><Checkbox checked={segment.userLocks?.assets === true} onChange={(checked) => patchLock('assets', checked)} />素材</label>
        <label><Checkbox checked={segment.userLocks?.direction === true} onChange={(checked) => patchLock('direction', checked)} />镜头语言</label>
      </div>
      <div className={styles.twoColumns}>
        <Field label="镜头标题"><Input value={segment.title} onChange={(event) => onPatch({ title: event.target.value }, 'direction')} /></Field>
        <Field label="镜头用途"><Select value={segment.purpose} options={PURPOSES} onChange={(event) => onPatch({ purpose: event.target.value as DirectorSegmentPlan['purpose'] }, 'direction')} /></Field>
      </div>
      <Field label="镜头摘要"><Textarea value={segment.summary} rows={3} resize="vertical" onChange={(event) => onPatch({ summary: event.target.value }, 'direction')} /></Field>
      <div className={styles.twoColumns}>
        <Field label="执行策略">
          <PillGroup fullWidth wrap value={strategy} items={RENDER_STRATEGIES} onChange={(value) => changeStrategy(value as RenderStrategy)} />
        </Field>
        <Field label="信息强度"><PillGroup fullWidth wrap={false} value={String(segment.intensity)} items={[
          { value: '1', label: '轻' }, { value: '2', label: '中' }, { value: '3', label: '重' },
        ]} onChange={(value) => onPatch({ intensity: Number(value) as 1 | 2 | 3 }, 'direction')} /></Field>
      </div>
      <Field label="画面内容">
        <PillGroup
          fullWidth
          wrap={false}
          value={visualType}
          items={strategy === 'motion-card' ? MOTION_VISUAL_TYPES : MEDIA_VISUAL_TYPES}
          onChange={(value) => onPatch({
            visualType: value as ShotVisualType,
            renderStrategy: strategy,
          }, 'strategy')}
        />
      </Field>
      {strategy === 'agent-composite' ? (
        <section className={styles.intentPanel} data-testid="composition-intent-editor">
          <div className={styles.intentHeader}>
            <strong>合成意图</strong>
            <span>开放语义</span>
          </div>
          <Field label="叙事目标">
            <Textarea value={intent.narrativeGoal} rows={2} resize="vertical" onChange={(event) => patchIntent({ narrativeGoal: event.target.value })} />
          </Field>
          <div className={styles.twoColumns}>
            <Field label="视觉焦点"><Input value={intent.focalPriority} onChange={(event) => patchIntent({ focalPriority: event.target.value })} /></Field>
            <Field label="时序关系"><Input value={intent.temporalRelationship} onChange={(event) => patchIntent({ temporalRelationship: event.target.value })} /></Field>
          </div>
          <div className={styles.twoColumns}>
            <Field label="素材不可替代">
              <Textarea
                aria-label="素材不可替代"
                value={segment.mediaIndispensability ?? ''}
                rows={3}
                resize="vertical"
                onChange={(event) => onPatch({ mediaIndispensability: event.target.value }, 'direction')}
              />
            </Field>
            <Field label="信息层不可替代">
              <Textarea
                aria-label="信息层不可替代"
                value={segment.graphicsIndispensability ?? ''}
                rows={3}
                resize="vertical"
                onChange={(event) => onPatch({ graphicsIndispensability: event.target.value }, 'direction')}
              />
            </Field>
          </div>
          <div className={styles.twoColumns}>
            <Field label="必须呈现">
              <Textarea
                aria-label="必须呈现"
                value={formatIntentList(intent.mustShow)}
                rows={2}
                resize="vertical"
                onChange={(event) => patchIntent({ mustShow: parseIntentList(event.target.value) })}
              />
            </Field>
            <Field label="避免表达">
              <Textarea
                aria-label="避免表达"
                value={formatIntentList(intent.avoid)}
                rows={2}
                resize="vertical"
                onChange={(event) => patchIntent({ avoid: parseIntentList(event.target.value) })}
              />
            </Field>
          </div>
        </section>
      ) : null}
      <FootageSegmentPanel
        key={segment.id}
        query={segment.footageQuery ?? (strategy === 'motion-card' ? segment.title : undefined)}
        placement={placement}
        assets={assets}
        assetDecisions={segment.assetDecisions ?? []}
        renderStrategy={strategy}
        baseUrl={kacutBaseUrl}
        enabled={kacutEnabled}
        onPatch={(patch, lockAssets) => onPatch(patch, lockAssets ? 'assets' : undefined)}
        onAdoptStrategy={(patch) => {
          const nextStrategy = patch.renderStrategy;
          onPatch({
            ...patch,
            carrier: nextStrategy === 'standalone-media' ? 'footage' : segment.carrier,
            composition: nextStrategy === 'standalone-media' ? 'full-bleed' : undefined,
            ...(nextStrategy === 'agent-composite' ? {
              compositionIntent: intent.narrativeGoal || intent.focalPriority
                ? intent
                : defaultCompositionIntent(segment),
              fallbackPolicy: segment.fallbackPolicy ?? 'block',
            } : {
              fallbackPolicy: segment.fallbackPolicy ?? 'motion',
            }),
            userLocks: { ...segment.userLocks, strategy: true, assets: true },
            strategyStatus: 'ready',
            blockedReason: undefined,
            fallbackDecision: undefined,
          });
        }}
      />
      <div className={styles.twoColumns}>
        <Field label="镜头运动"><Select value={segment.cameraMove ?? (visualType === 'motion' ? 'static' : 'push-in')} options={CAMERA_MOVES} onChange={(event) => onPatch({ cameraMove: event.target.value as NonNullable<DirectorSegmentPlan['cameraMove']> }, 'direction')} /></Field>
        <Field label="媒介用途"><Select value={segment.mediaRole ?? 'context'} options={MEDIA_ROLES} onChange={(event) => onPatch({ mediaRole: event.target.value as NonNullable<DirectorSegmentPlan['mediaRole']> }, 'direction')} /></Field>
      </div>
      <div className={styles.twoColumns}>
        {strategy === 'agent-composite' ? (
          <Field label="制作失败退路">
            <PillGroup
              fullWidth
              wrap
              value={segment.fallbackPolicy ?? (strategy === 'agent-composite' ? 'block' : 'motion')}
              items={FALLBACK_POLICIES}
              onChange={(fallbackPolicy) => onPatch({
                fallbackPolicy: fallbackPolicy as DirectorFallbackPolicy,
                footageFallback: fallbackPolicy === 'motion' ? 'motion' : segment.footageFallback,
              }, 'strategy')}
            />
          </Field>
        ) : <span />}
        <Field label="入场转场"><Select value={segment.transition ?? ''} options={SHOT_TRANSITIONS} onChange={(event) => onPatch({ transition: (event.target.value || undefined) as DirectorSegmentPlan['transition'] }, 'direction')} /></Field>
      </div>
      {strategy !== 'standalone-media' ? (
        <Field label="信息载体"><Select value={segment.carrier} options={CARRIERS} allowCustomValue onChange={(event) => onPatch({ carrier: event.target.value }, 'direction')} /></Field>
      ) : null}
      <Field label="导演理由"><Textarea value={segment.rationale} rows={2} resize="vertical" onChange={(event) => onPatch({ rationale: event.target.value }, 'direction')} /></Field>
      <section className={styles.decisionPanel} aria-label="AI 导演判断">
        <div className={styles.decisionHeader}>
          <strong>策略判断</strong>
          <span>{typeof segment.strategyConfidence === 'number'
            ? `置信度 ${Math.round(segment.strategyConfidence * 100)}%`
            : '未记录置信度'}</span>
        </div>
        <p>{segment.strategyReason || segment.rationale}</p>
        {strategy === 'agent-composite' ? (
          <dl>
            <div><dt>素材不可替代</dt><dd>{segment.mediaIndispensability || '待补充'}</dd></div>
            <div><dt>信息层不可替代</dt><dd>{segment.graphicsIndispensability || '待补充'}</dd></div>
          </dl>
        ) : null}
        {segment.assetDecisions?.length ? (
          <ul>
            {segment.assetDecisions.map((decision) => (
              <li key={`${decision.candidateId}-${decision.decision}`} data-decision={decision.decision}>
                <strong>{decision.decision === 'selected' ? '采用' : '淘汰'}</strong>
                <span>{decision.reason}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

/** footage 段素材审核：同时检索视频和图片，先预览，再把人工选择写回导演方案。 */
function FootageSegmentPanel({
  query,
  placement,
  assets,
  assetDecisions,
  renderStrategy,
  baseUrl,
  enabled,
  onPatch,
  onAdoptStrategy,
}: {
  query?: string;
  placement?: FootagePlacement;
  assets: CompositionAsset[];
  assetDecisions: NonNullable<DirectorSegmentPlan['assetDecisions']>;
  renderStrategy: RenderStrategy;
  baseUrl: string;
  enabled: boolean;
  onPatch: (patch: SegmentPatch, lockAssets?: boolean) => void;
  onAdoptStrategy: (patch: SegmentPatch) => void;
}) {
  const [candidates, setCandidates] = useState<KacutClip[]>([]);
  const [previewAsset, setPreviewAsset] = useState<KacutClip | SelectedFootageAsset | null>(null);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchRequest = useRef(0);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const queryText = query?.trim();
  const assetsByKey = new Map(assets.map((binding) => [compositionAssetKey(binding.asset), binding]));
  const placementAsset: SelectedFootageAsset | null = placement ? {
    id: `placement:${placement.overlayId}`,
    filename: getFileNameFromPath(placement.sourcePath),
    path: placement.sourcePath,
    kind: placement.kind,
    score: placement.score,
    thumbnailFile: placement.thumbnailFile,
    matchedSegmentStart: placement.kind === 'video' ? placement.trimStartMs / 1_000 : undefined,
  } : null;

  const clearSearch = () => {
    searchRequest.current += 1;
    setCandidates([]);
    setPreviewAsset(null);
    setHasSearched(false);
    setSearchError(null);
    setSearching(false);
  };

  const searchAssets = async () => {
    if (!enabled) {
      setSearchError('素材联动未启用，请先在设置中连接并启用灵机素材');
      return;
    }
    if (!queryText) {
      setSearchError('请先填写素材检索词');
      setHasSearched(true);
      return;
    }
    const request = searchRequest.current + 1;
    searchRequest.current = request;
    setSearching(true);
    setHasSearched(false);
    setSearchError(null);
    setPreviewAsset(null);
    try {
      const results: PromiseSettledResult<KacutClip[]>[] = [];
      // 素材服务冷启动时并发搜索会互相挤占超时预算；导演台与 Pi 保持同样的顺序检索语义。
      for (const kind of ['video', 'image'] as const) {
        try {
          results.push({
            status: 'fulfilled',
            value: await window.electronAPI.kacutSearchClips({
              baseUrl, query: queryText, kind, limit: FOOTAGE_REVIEW_LIMIT,
            }),
          });
        } catch (reason) {
          results.push({ status: 'rejected', reason });
        }
      }
      if (searchRequest.current !== request) return;
      const fulfilled = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
      const unique = new Map<string, KacutClip>();
      for (const asset of fulfilled) {
        if (asset.kind !== 'video' && asset.kind !== 'image') continue;
        const key = `${asset.kind}:${asset.path}`;
        const previous = unique.get(key);
        if (!previous || asset.score > previous.score) unique.set(key, asset);
      }
      setCandidates([...unique.values()].sort((left, right) => right.score - left.score));
      setHasSearched(true);
      const rejected = results.filter((result) => result.status === 'rejected');
      if (rejected.length === results.length) {
        const reason = rejected[0]?.status === 'rejected' ? rejected[0].reason : null;
        setSearchError(reason instanceof Error ? reason.message : String(reason ?? '素材库连接失败'));
      } else if (rejected.length > 0) {
        setSearchError('部分素材类型检索失败，已展示其余候选');
      }
    } catch (error) {
      if (searchRequest.current !== request) return;
      setCandidates([]);
      setHasSearched(true);
      setSearchError(error instanceof Error ? error.message : String(error));
    } finally {
      if (searchRequest.current === request) setSearching(false);
    }
  };

  const updateAssets = (
    nextAssets: CompositionAsset[],
    nextDecisions = assetDecisions,
    nextStrategy = renderStrategy,
    resolveStrategyState = false,
  ) => {
    const preferred = preferredCompositionAsset(nextAssets);
    const normalizedAssets = nextStrategy === 'standalone-media'
      ? preferred
        ? [{ ...preferred, usage: 'required' as const }]
        : []
      : nextAssets;
    const primary = preferredCompositionAsset(normalizedAssets);
    const patch: SegmentPatch = {
      compositionAssets: normalizedAssets,
      renderStrategy: nextStrategy,
      visualType: primary?.asset.kind === 'image' ? 'image' : primary ? 'footage' : undefined,
      selectedFootage: nextStrategy === 'standalone-media' && primary
        ? selectedFootageFromBinding(primary)
        : undefined,
      assetDecisions: nextDecisions,
      ...(queryText ? { footageQuery: queryText } : {}),
      ...(resolveStrategyState ? {
        strategyStatus: 'ready' as const,
        blockedReason: undefined,
        fallbackDecision: undefined,
      } : {}),
    };
    if (nextStrategy !== renderStrategy) onAdoptStrategy(patch);
    else onPatch(patch, true);
  };

  const chooseAsset = (
    asset: KacutClip | SelectedFootageAsset,
    usage: CompositionAsset['usage'],
    nextStrategy = renderStrategy,
  ) => {
    if (asset.kind !== 'video' && asset.kind !== 'image') return;
    const normalized: SelectedFootageAsset = {
      id: asset.id,
      filename: asset.filename,
      path: asset.path,
      kind: asset.kind,
      score: asset.score,
      durationSec: asset.durationSec,
      thumbnailFile: asset.thumbnailFile,
      matchedSegmentStart: asset.matchedSegmentStart,
      pixelWidth: asset.pixelWidth,
      pixelHeight: asset.pixelHeight,
    };
    const key = compositionAssetKey(asset);
    const existing = assetsByKey.get(key);
    const binding: CompositionAsset = {
      asset: normalized,
      usage,
      trimStartMs: normalized.kind === 'video'
        ? Math.round(clampTrimSeconds(
            typeof existing?.trimStartMs === 'number'
              ? existing.trimStartMs / 1_000
              : normalized.matchedSegmentStart ?? 0,
            normalized.durationSec,
          ) * 1_000)
        : undefined,
    };
    if (nextStrategy === 'standalone-media') {
      updateAssets([{ ...binding, usage: 'required' }], [{
        candidateId: normalized.id,
        decision: 'selected',
        reason: '用户已在导演台预览并选为必用素材',
        confidence: normalized.score,
        inspected: true,
      }], nextStrategy, true);
      return;
    }
    const decisions = assetDecisions.filter((decision) => decision.candidateId !== normalized.id);
    decisions.push({
      candidateId: normalized.id,
      decision: 'selected',
      reason: `用户已在导演台预览并设为${usage === 'required' ? '必用' : '可选'}素材`,
      confidence: normalized.score,
      inspected: true,
    });
    updateAssets(
      existing
        ? assets.map((item) => compositionAssetKey(item.asset) === key ? binding : item)
        : [...assets, binding],
      decisions,
      nextStrategy,
      usage === 'required',
    );
  };

  const patchAsset = (target: CompositionAsset, patch: Partial<CompositionAsset>) => {
    updateAssets(assets.map((binding) => compositionAssetKey(binding.asset) === compositionAssetKey(target.asset)
      ? { ...binding, ...patch }
      : binding), assetDecisions, renderStrategy, patch.usage === 'required');
  };

  const removeAsset = (target: CompositionAsset) => {
    updateAssets(
      assets.filter((binding) => compositionAssetKey(binding.asset) !== compositionAssetKey(target.asset)),
      assetDecisions.filter((decision) => decision.candidateId !== target.asset.id),
    );
  };
  const previewBinding = previewAsset ? assetsByKey.get(compositionAssetKey(previewAsset)) : undefined;
  const previewStartSeconds = previewAsset?.kind === 'video'
    ? clampTrimSeconds(
        typeof previewBinding?.trimStartMs === 'number'
          ? previewBinding.trimStartMs / 1_000
          : previewAsset.matchedSegmentStart ?? 0,
        previewAsset.durationSec,
      )
    : 0;

  useEffect(() => {
    const video = previewVideoRef.current;
    if (!video || previewAsset?.kind !== 'video') return;
    const seekToPreviewStart = () => {
      const mediaDuration = Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : undefined;
      video.currentTime = clampTrimSeconds(previewStartSeconds, mediaDuration);
    };
    if (video.readyState >= 1) {
      seekToPreviewStart();
      return;
    }
    video.addEventListener('loadedmetadata', seekToPreviewStart);
    return () => video.removeEventListener('loadedmetadata', seekToPreviewStart);
  }, [previewAsset?.kind, previewAsset?.path, previewStartSeconds]);

  return (
    <div className={styles.footagePanel} data-testid="footage-segment-panel">
      <Field label="素材检索词">
        <Input
          value={query ?? ''}
          placeholder="如：城市 航拍 夜景"
          aria-label="素材检索词"
          onChange={(event) => {
            clearSearch();
            onPatch({ footageQuery: event.target.value }, false);
          }}
        />
      </Field>
      <div className={styles.footageSearchActions}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-label="检索视频和图片素材"
          disabled={!enabled || searching || !queryText}
          onClick={() => void searchAssets()}
        >
          <Search size={14} />{searching ? '检索中…' : hasSearched ? '重新检索' : '检索素材'}
        </Button>
        <span>{!enabled
          ? '素材联动未启用，当前导演不会检索新的本机素材。'
          : renderStrategy === 'standalone-media'
          ? '同时查找视频和图片，采用后将作为本镜头唯一必用素材。'
          : renderStrategy === 'agent-composite'
            ? '同时查找视频和图片，可设为必用或加入可选素材池。'
            : '可先检索和预览；采用时直接切换为独立素材或 Agent 合成。'}</span>
      </div>
      {assets.length > 0 ? (
        <div className={styles.footageSelections} data-testid="composition-asset-list">
          {assets.map((binding) => (
            <div
              key={compositionAssetKey(binding.asset)}
              className={styles.footageSelection}
              data-testid="selected-footage-asset"
              data-usage={binding.usage}
            >
              <AssetThumbnail asset={binding.asset} alt="已选素材缩略图" />
              <span className={styles.footageSelectionBody}>
                <strong>{binding.usage === 'required' ? '必用素材' : '可选素材'}</strong>
                <span>{binding.asset.filename} · 匹配度 {Math.round(binding.asset.score * 100)}%</span>
                {binding.asset.kind === 'video' ? (
                  <label className={styles.trimControl}>
                    <span>起点</span>
                    <Input
                      size="sm"
                      type="number"
                      min={0}
                      max={binding.asset.durationSec}
                      step={0.1}
                      value={formatTrimSeconds(binding.trimStartMs)}
                      aria-label={`${binding.asset.filename} 素材起点秒`}
                      onChange={(event) => {
                        const seconds = Number(event.target.value);
                        patchAsset(binding, {
                          trimStartMs: Math.round(clampTrimSeconds(seconds, binding.asset.durationSec) * 1_000),
                        });
                      }}
                    />
                    <span>秒</span>
                  </label>
                ) : null}
              </span>
              {renderStrategy === 'agent-composite' ? (
                <PillGroup
                  value={binding.usage}
                  items={[
                    { value: 'required', label: <>必用<span className={styles.visuallyHidden}> {binding.asset.filename}</span></> },
                    { value: 'optional', label: <>可选<span className={styles.visuallyHidden}> {binding.asset.filename}</span></> },
                  ]}
                  onChange={(usage) => patchAsset(binding, { usage: usage as CompositionAsset['usage'] })}
                />
              ) : null}
              <div className={styles.footageSelectionActions}>
                <Button type="button" variant="ghost" size="sm" aria-label={`预览 ${binding.asset.filename}`} onClick={() => setPreviewAsset(binding.asset)}>预览</Button>
                <Button type="button" variant="ghost" size="sm" aria-label={`移除 ${binding.asset.filename}`} onClick={() => removeAsset(binding)}>移除</Button>
              </div>
            </div>
          ))}
        </div>
      ) : placementAsset ? (
        <div className={styles.footagePlacement}>
          <AssetThumbnail asset={placementAsset} alt="已匹配素材缩略图" />
          <span>
            <strong>上次制作采用</strong>{placementAsset.filename} · 匹配度 {Math.round(placementAsset.score * 100)}%
          </span>
          <div className={styles.footageSelectionActions}>
            <Button type="button" variant="ghost" size="sm" aria-label={`预览 ${placementAsset.filename}`} onClick={() => setPreviewAsset(placementAsset)}>预览</Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-label={`采用 ${placementAsset.filename}`}
              onClick={() => chooseAsset(
                placementAsset,
                'required',
                renderStrategy === 'motion-card' ? 'standalone-media' : renderStrategy,
              )}
            >{renderStrategy === 'motion-card' ? '用作独立素材' : '采用'}</Button>
          </div>
        </div>
      ) : (
        <span className={styles.footagePending}>
          尚未选入素材；请先检索、预览并选择：{queryText || '未设置检索词'}
        </span>
      )}
      {searchError ? <p className={styles.footageSearchError}>{searchError}</p> : null}
      {hasSearched && !searching && !searchError && candidates.length === 0 ? (
        <div className={styles.footageEmpty}>没有找到可预览的视频或图片素材</div>
      ) : null}
      {candidates.length > 0 ? (
        <div className={styles.footageCandidates} data-testid="footage-candidate-list">
          {candidates.map((asset) => {
            const assetKey = `${asset.kind}:${asset.path}`;
            const selectedBinding = assetsByKey.get(assetKey);
            const isSelected = Boolean(selectedBinding);
            const isPreviewing = previewAsset?.path === asset.path && previewAsset.kind === asset.kind;
            return (
              <button
                key={assetKey}
                type="button"
                className={styles.footageCandidate}
                data-testid={`footage-candidate-${asset.id}`}
                data-selected={isSelected}
                aria-pressed={isPreviewing}
                aria-label={`预览候选素材 ${asset.filename}`}
                onClick={() => setPreviewAsset(asset)}
              >
                <AssetThumbnail asset={asset} alt={asset.filename} />
                <span className={styles.footageCandidateBody}>
                  <strong>{asset.filename}</strong>
                  <span>{asset.kind === 'video' ? '视频' : '图片'} · 匹配度 {Math.round(asset.score * 100)}%</span>
                  <small>{assetMetadata(asset)}</small>
                </span>
                {selectedBinding ? (
                  <span className={styles.footageSelectedBadge}>{selectedBinding.usage === 'required' ? '必用' : '可选'}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {previewAsset ? (
        <div className={styles.footagePreview} data-testid="footage-asset-preview">
          <div className={styles.footagePreviewMedia}>
            {previewAsset.kind === 'video' ? (
              <video
                ref={previewVideoRef}
                src={toFileSrc(previewAsset.path)}
                poster={previewAsset.thumbnailFile ? toFileSrc(previewAsset.thumbnailFile) : undefined}
                controls
                preload="metadata"
              />
            ) : (
              <img src={toFileSrc(previewAsset.path)} alt={previewAsset.filename} />
            )}
          </div>
          <div className={styles.footagePreviewDetails}>
            <div><span>文件</span><strong>{previewAsset.filename}</strong></div>
            <div><span>类型</span><strong>{previewAsset.kind === 'video' ? '视频' : '图片'}</strong></div>
            <div><span>匹配度</span><strong>{Math.round(previewAsset.score * 100)}%</strong></div>
            <div><span>规格</span><strong>{assetMetadata(previewAsset)}</strong></div>
            <div className={styles.footagePreviewActions}>
              {renderStrategy === 'motion-card' ? (
                <>
                  <Button type="button" variant="primary" size="sm" aria-label={`用作独立素材 ${previewAsset.filename}`} onClick={() => chooseAsset(previewAsset, 'required', 'standalone-media')}>
                    用作独立素材
                  </Button>
                  <Button type="button" variant="secondary" size="sm" aria-label={`用于 Agent 合成 ${previewAsset.filename}`} onClick={() => chooseAsset(previewAsset, 'required', 'agent-composite')}>
                    用于 Agent 合成
                  </Button>
                </>
              ) : (
                <Button type="button" variant="primary" size="sm" aria-label={`设为必用 ${previewAsset.filename}`} onClick={() => chooseAsset(previewAsset, 'required')}>
                  {previewBinding?.usage === 'required' ? <CheckCircle2 size={14} /> : null}
                  {previewBinding?.usage === 'required' ? '已设为必用' : '设为必用'}
                </Button>
              )}
              {renderStrategy === 'agent-composite' ? (
                <Button type="button" variant="secondary" size="sm" aria-label={`加入可选 ${previewAsset.filename}`} onClick={() => chooseAsset(previewAsset, 'optional')}>
                  {previewBinding?.usage === 'optional' ? <CheckCircle2 size={14} /> : null}
                  {previewBinding?.usage === 'optional' ? '已加入可选' : '加入可选'}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AssetThumbnail({
  asset,
  alt,
}: {
  asset: Pick<KacutClip, 'kind' | 'path' | 'thumbnailFile'>;
  alt: string;
}) {
  const src = asset.thumbnailFile ?? (asset.kind === 'image' ? asset.path : null);
  return src
    ? <img className={styles.footageThumb} src={toFileSrc(src)} alt={alt} />
    : <span className={styles.footageThumbFallback}>{asset.kind === 'video' ? <Film size={20} /> : <ImageIcon size={20} />}</span>;
}

function assetMetadata(asset: Pick<KacutClip, 'durationSec' | 'pixelWidth' | 'pixelHeight'>): string {
  const duration = typeof asset.durationSec === 'number' && asset.durationSec > 0
    ? formatAssetDuration(asset.durationSec)
    : '';
  const dimensions = asset.pixelWidth && asset.pixelHeight ? `${asset.pixelWidth}×${asset.pixelHeight}` : '';
  return [duration, dimensions].filter(Boolean).join(' · ') || '规格未读取';
}

function formatAssetDuration(durationSec: number): string {
  const seconds = Math.max(0, Math.round(durationSec));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}:${String(seconds % 60).padStart(2, '0')}` : `${seconds} 秒`;
}

function segmentCompositionAssets(segment: DirectorSegmentPlan): CompositionAsset[] {
  const assets = segment.compositionAssets;
  if (Array.isArray(assets) && assets.length > 0) {
    if (resolveDirectorRenderStrategy(segment) !== 'standalone-media') return assets;
    const required = assets.find((binding) => binding.usage === 'required');
    return required ? [{ ...required, usage: 'required' }] : [];
  }
  if (!segment.selectedFootage) return [];
  return [{
    asset: segment.selectedFootage,
    usage: 'required',
    trimStartMs: segment.selectedFootage.kind === 'video'
      ? Math.max(0, Math.round((segment.selectedFootage.matchedSegmentStart ?? 0) * 1_000))
      : undefined,
  }];
}

function segmentCompositionIntent(segment: DirectorSegmentPlan): CompositionIntent {
  const intent = segment.compositionIntent;
  return intent ?? {
    narrativeGoal: '',
    focalPriority: '',
    temporalRelationship: '',
    mustShow: [],
    avoid: [],
  };
}

function defaultCompositionIntent(segment: DirectorSegmentPlan): CompositionIntent {
  return {
    narrativeGoal: segment.rationale || segment.summary,
    focalPriority: segment.title,
    temporalRelationship: '',
    mustShow: [],
    avoid: [],
  };
}

function preferredCompositionAsset(assets: CompositionAsset[]): CompositionAsset | undefined {
  return assets.find((binding) => binding.usage === 'required') ?? assets[0];
}

function selectedFootageFromBinding(binding: CompositionAsset): SelectedFootageAsset {
  return {
    ...binding.asset,
    matchedSegmentStart: binding.asset.kind === 'video'
      ? Math.max(0, binding.trimStartMs ?? 0) / 1_000
      : binding.asset.matchedSegmentStart,
  };
}

function compositionAssetKey(asset: { kind: string; path: string }): string {
  return `${asset.kind}:${asset.path}`;
}

function formatTrimSeconds(trimStartMs?: number): string {
  return String(Number(((trimStartMs ?? 0) / 1_000).toFixed(1)));
}

function clampTrimSeconds(seconds: number, durationSec?: number): number {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec >= 0
    ? Math.min(safeSeconds, durationSec)
    : safeSeconds;
}

function formatIntentList(values: string[]): string {
  return values.join('\n');
}

function parseIntentList(value: string): string[] {
  return [...new Set(value
    .split(/[\n,，、；;]/u)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function ReviewPanel({ plan }: { plan: DirectorPlan }) {
  const enabledSegments = plan.segments.filter((segment) => segment.enabled);
  const motionCount = enabledSegments.filter((segment) => shotPresentation(segment).kind === 'motion-animation').length;
  const imageCardCount = enabledSegments.filter((segment) => shotPresentation(segment).kind === 'image-card').length;
  const standaloneVideoCount = enabledSegments.filter((segment) => shotPresentation(segment).kind === 'standalone-video').length;
  const standaloneImageCount = enabledSegments.filter((segment) => shotPresentation(segment).kind === 'standalone-image').length;
  const compositeSegments = enabledSegments.filter((segment) => resolveDirectorRenderStrategy(segment) === 'agent-composite');
  const compositeReady = compositeSegments.every((segment) => {
    const requiredAssets = segmentCompositionAssets(segment).filter((binding) => binding.usage === 'required');
    return (segment.strategyStatus ?? 'ready') === 'ready'
      && requiredAssets.length > 0
      && requiredAssets.every((binding) => segment.assetDecisions?.some((decision) => (
        decision.candidateId === binding.asset.id
        && decision.decision === 'selected'
        && decision.inspected === true
      )));
  });
  const hasNonMotionShots = imageCardCount + standaloneVideoCount + standaloneImageCount + compositeSegments.length > 0;
  const blockedCount = enabledSegments.filter((segment) => segment.strategyStatus === 'blocked').length;
  const fallbackCount = enabledSegments.filter((segment) => segment.strategyStatus === 'fallback').length;
  const zeroCompositeReason = plan.zeroCompositeReason?.trim();
  return (
    <>
      <strong>导演检查</strong>
      <ReviewRow ok={plan.segments.some((segment) => segment.intensity === 3)} text="至少一个重点镜头" />
      <ReviewRow ok={plan.segments.every((segment) => Boolean(segment.carrier.trim()))} text="全部镜头已分配载体" />
      <ReviewRow
        ok={hasNonMotionShots || Boolean(zeroCompositeReason)}
        warning={!hasNonMotionShots && Boolean(zeroCompositeReason)}
        text={hasNonMotionShots
          ? `画面类型：Motion 动画 ${motionCount} · 图片卡 ${imageCardCount} · 视频素材 ${standaloneVideoCount} · 图片素材 ${standaloneImageCount} · Agent 合成 ${compositeSegments.length}`
          : zeroCompositeReason
            ? `零组合审计：${zeroCompositeReason}`
            : '全片均为 Motion，请重新编排媒介；缺少零组合审计'}
      />
      {compositeSegments.length > 0 ? (
        <ReviewRow
          ok={compositeReady}
          text={compositeReady ? 'Agent 合成镜头均已选入并审阅必用素材' : '部分 Agent 合成镜头等待选材或审阅'}
        />
      ) : null}
      <ReviewRow
        ok={blockedCount === 0}
        text={blockedCount === 0 ? `无阻塞镜头${fallbackCount > 0 ? ` · 显式退路 ${fallbackCount}` : ''}` : `${blockedCount} 个镜头阻塞，批准前必须处理`}
      />
      <ReviewRow ok={Boolean(plan.coverDirection.prompt.trim())} text="封面方向已填写" />
      <ReviewRow
        ok={!isDirectorBgmEnabled(plan.audioDirection) || Boolean(plan.audioDirection.bgmStyle.trim())}
        text={isDirectorBgmEnabled(plan.audioDirection) ? '背景音乐方向已填写' : '背景音乐已关闭'}
      />
      <ReviewRow
        ok
        text={areDirectorSoundEffectsEnabled(plan.audioDirection) ? '环境与音效已启用' : '环境与音效已关闭'}
      />
      {plan.warnings.length > 0 ? <div className={styles.warningList}>
        {plan.warnings.map((warning) => <p key={warning}><AlertTriangle size={13} />{warning}</p>)}
      </div> : null}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className={styles.section}><h2>{title}</h2>{children}</section>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className={styles.field}><span>{label}</span>{children}</label>;
}

function ReviewRow({ ok, warning = false, text }: { ok: boolean; warning?: boolean; text: string }) {
  const state = warning ? 'warning' : ok ? 'ok' : 'error';
  return <div className={styles.reviewRow} data-ok={ok} data-state={state}>{state === 'ok' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}<span>{text}</span></div>;
}

function shotVisualType(segment: DirectorSegmentPlan): ShotVisualType {
  return segment.visualType === 'image' || segment.visualType === 'footage'
    ? segment.visualType
    : 'motion';
}

function shotPresentation(segment: DirectorSegmentPlan): {
  kind: ShotPresentationKind;
  label: string;
  Icon: typeof Sparkles;
} {
  const strategy = resolveDirectorRenderStrategy(segment);
  if (strategy === 'agent-composite') {
    return { kind: 'agent-composite', label: 'Agent 合成', Icon: Layers3 };
  }
  if (strategy === 'standalone-media') {
    const primaryAsset = segmentCompositionAssets(segment)[0]?.asset;
    const isImage = primaryAsset?.kind === 'image'
      || (!primaryAsset && shotVisualType(segment) === 'image');
    return isImage
      ? { kind: 'standalone-image', label: '图片素材', Icon: ImageIcon }
      : { kind: 'standalone-video', label: '视频素材', Icon: Film };
  }
  return shotVisualType(segment) === 'image'
    ? { kind: 'image-card', label: '图片卡', Icon: ImageIcon }
    : { kind: 'motion-animation', label: 'Motion 动画', Icon: Sparkles };
}

function summarizePlanLocks(plan: DirectorPlan): {
  planFields: number;
  segmentFields: number;
  segmentCount: number;
  totalFields: number;
} {
  const planFields = Object.values(plan.userLocks ?? {}).filter(Boolean).length;
  const lockedSegments = plan.segments.filter((segment) => (
    Object.values(segment.userLocks ?? {}).some(Boolean)
  ));
  const segmentFields = lockedSegments.reduce((total, segment) => (
    total + Object.values(segment.userLocks ?? {}).filter(Boolean).length
  ), 0);
  return {
    planFields,
    segmentFields,
    segmentCount: lockedSegments.length,
    totalFields: planFields + segmentFields,
  };
}

function segmentLockText(segment: DirectorSegmentPlan): string {
  const labels = [
    segment.userLocks?.strategy ? '策略' : '',
    segment.userLocks?.assets ? '素材' : '',
    segment.userLocks?.direction ? '镜头语言' : '',
  ].filter(Boolean);
  return labels.join('、') || '无';
}

function optionLabel(options: Array<{ value: string; label: string }>, value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

function carrierLabel(carrier: string): string {
  return CARRIER_META[carrier as keyof typeof CARRIER_META]?.label ?? carrier;
}

function intensityLabel(intensity: 1 | 2 | 3): string {
  return intensity === 3 ? '重' : intensity === 2 ? '中' : '轻';
}

function formatTime(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
