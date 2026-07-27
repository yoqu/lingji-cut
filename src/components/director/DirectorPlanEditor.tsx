import { AlertTriangle, CheckCircle2, Plus, Trash2 } from 'lucide-react';
import type { DirectorPlan, DirectorSegmentPlan } from '../../types/director';
import { Button, Checkbox, Input, PillGroup, Select, Switch, Textarea } from '../../ui';
import {
  areDirectorSoundEffectsEnabled,
  isDirectorBgmEnabled,
} from '../../lib/director-audio-options';
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

export function DirectorPlanEditor({
  plan,
  selectedSegmentId,
  onSelectSegment,
  onChange,
}: {
  plan: DirectorPlan;
  selectedSegmentId: string | null;
  onSelectSegment: (segmentId: string) => void;
  onChange: (plan: DirectorPlan) => void;
}) {
  const selected = plan.segments.find((segment) => segment.id === selectedSegmentId) ?? plan.segments[0];
  const bgmEnabled = isDirectorBgmEnabled(plan.audioDirection);
  const soundEffectsEnabled = areDirectorSoundEffectsEnabled(plan.audioDirection);
  const patchPlan = (patch: Partial<DirectorPlan>) => onChange({ ...plan, ...patch, updatedAt: Date.now() });
  const patchBible = (patch: Partial<DirectorPlan['motionBible']>) => patchPlan({
    motionBible: { ...plan.motionBible, ...patch },
  });
  const patchSegment = (patch: Partial<DirectorSegmentPlan>) => {
    if (!selected) return;
    const segments = plan.segments.map((segment) => segment.id === selected.id ? { ...segment, ...patch } : segment);
    const next = segments.find((segment) => segment.id === selected.id)!;
    const carrierPlan = plan.motionBible.carrierPlan.map((directive) => directive.segmentId === next.id
      ? { ...directive, preferredCarrier: next.carrier, intensity: next.intensity, reason: next.rationale }
      : directive);
    if (!carrierPlan.some((directive) => directive.segmentId === next.id)) {
      carrierPlan.push({ segmentId: next.id, preferredCarrier: next.carrier, intensity: next.intensity, reason: next.rationale });
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

  return (
    <div className={styles.workspace}>
      <aside className={styles.outline} aria-label="导演段落纲要">
        <div className={styles.outlineHeader}>
          <strong>内容结构</strong><span>{plan.segments.length} 个镜头</span>
        </div>
        <div className={styles.segmentList}>
          {plan.segments.map((segment, index) => (
            <button
              key={segment.id}
              type="button"
              className={styles.segmentButton}
              data-active={segment.id === selected?.id}
              data-enabled={segment.enabled}
              aria-pressed={segment.id === selected?.id}
              onClick={() => onSelectSegment(segment.id)}
            >
              <span className={styles.segmentIndex}>{index + 1}</span>
              <span className={styles.segmentLabel}>
                <strong>{segment.title}</strong>
                <small>{formatTime(segment.startMs)} - {formatTime(segment.endMs)} · 强度 {segment.intensity}</small>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <main className={styles.editor}>
        <Section title="整片导演命题">
          <Field label="内容摘要">
            <Textarea value={plan.summary} rows={3} resize="vertical" onChange={(event) => patchPlan({ summary: event.target.value })} />
          </Field>
          <Field label="关键词">
            <Input value={plan.keywords.join('，')} onChange={(event) => patchPlan({
              keywords: event.target.value.split(/[,，、]/u).map((value) => value.trim()).filter(Boolean),
            })} />
          </Field>
          <Field label="整体创作要求">
            <Textarea value={plan.globalPrompt ?? ''} rows={2} resize="vertical" onChange={(event) => patchPlan({ globalPrompt: event.target.value })} />
          </Field>
          <Field label="视觉命题">
            <Textarea value={plan.motionBible.visualThesis} rows={2} resize="vertical" onChange={(event) => patchBible({ visualThesis: event.target.value })} />
          </Field>
          <Field label="整片节奏密度">
            <PillGroup fullWidth wrap={false} value={plan.motionBible.rhythm.density} items={[
              { value: 'quiet', label: '克制' }, { value: 'balanced', label: '平衡' }, { value: 'dense', label: '密集' },
            ]} onChange={(density) => patchBible({ rhythm: { ...plan.motionBible.rhythm, density } })} />
          </Field>
        </Section>

        {selected ? <Section title={`镜头 ${plan.segments.indexOf(selected) + 1} · ${selected.title}`}>
          <label className={styles.enableRow}>
            <Checkbox checked={selected.enabled} onChange={(enabled) => patchSegment({ enabled })} />
            <span>纳入制作执行</span>
            <small>时间码与口播顺序来自字幕，不在导演台修改</small>
          </label>
          <div className={styles.twoColumns}>
            <Field label="镜头标题"><Input value={selected.title} onChange={(event) => patchSegment({ title: event.target.value })} /></Field>
            <Field label="镜头用途"><Select value={selected.purpose} options={PURPOSES} onChange={(event) => patchSegment({ purpose: event.target.value as DirectorSegmentPlan['purpose'] })} /></Field>
          </div>
          <Field label="镜头摘要"><Textarea value={selected.summary} rows={3} resize="vertical" onChange={(event) => patchSegment({ summary: event.target.value })} /></Field>
          <div className={styles.twoColumns}>
            <Field label="视觉形式"><PillGroup fullWidth wrap={false} value={selected.visualType ?? 'motion'} items={[
              { value: 'motion', label: 'Motion' }, { value: 'image', label: '图片' },
            ]} onChange={(visualType) => patchSegment({ visualType })} /></Field>
            <Field label="信息强度"><PillGroup fullWidth wrap={false} value={String(selected.intensity)} items={[
              { value: '1', label: '轻' }, { value: '2', label: '中' }, { value: '3', label: '重' },
            ]} onChange={(value) => patchSegment({ intensity: Number(value) as 1 | 2 | 3 })} /></Field>
          </div>
          <Field label="信息载体"><Select value={selected.carrier} options={CARRIERS} allowCustomValue onChange={(event) => patchSegment({ carrier: event.target.value })} /></Field>
          <Field label="导演理由"><Textarea value={selected.rationale} rows={2} resize="vertical" onChange={(event) => patchSegment({ rationale: event.target.value })} /></Field>
        </Section> : null}

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

        <Section title="封面与声音方向">
          <Field label="封面方向"><Textarea value={plan.coverDirection.prompt} rows={3} resize="vertical" onChange={(event) => patchPlan({ coverDirection: { ...plan.coverDirection, prompt: event.target.value } })} /></Field>
          <div className={styles.twoColumns}>
            <Field label="封面构图"><Input value={plan.coverDirection.composition} onChange={(event) => patchPlan({ coverDirection: { ...plan.coverDirection, composition: event.target.value } })} /></Field>
            <Field label="封面氛围"><Input value={plan.coverDirection.mood ?? ''} onChange={(event) => patchPlan({ coverDirection: { ...plan.coverDirection, mood: event.target.value } })} /></Field>
          </div>
          <Field label="封面字体方向"><Input value={plan.coverDirection.typography ?? ''} onChange={(event) => patchPlan({ coverDirection: { ...plan.coverDirection, typography: event.target.value } })} /></Field>
          <Field label="封面排除项"><Textarea value={plan.coverDirection.negativeConstraints ?? ''} rows={2} resize="vertical" onChange={(event) => patchPlan({ coverDirection: { ...plan.coverDirection, negativeConstraints: event.target.value } })} /></Field>
          <div className={styles.audioOptions}>
            <div className={styles.audioOption}>
              <div><strong>背景音乐</strong><span>为连续口播添加低干扰配乐</span></div>
              <Switch checked={bgmEnabled} aria-label="启用背景音乐" onChange={(bgmEnabled) => patchPlan({ audioDirection: { ...plan.audioDirection, bgmEnabled } })} />
            </div>
            <div className={styles.audioOption}>
              <div><strong>环境与音效</strong><span>在章节切换和重点镜头加入声音提示</span></div>
              <Switch checked={soundEffectsEnabled} aria-label="启用环境与音效" onChange={(soundEffectsEnabled) => patchPlan({ audioDirection: { ...plan.audioDirection, soundEffectsEnabled } })} />
            </div>
          </div>
          {bgmEnabled ? <>
            <Field label="BGM 风格"><Textarea value={plan.audioDirection.bgmStyle} rows={2} resize="vertical" onChange={(event) => patchPlan({ audioDirection: { ...plan.audioDirection, bgmStyle: event.target.value } })} /></Field>
            <Field label="音乐能量"><PillGroup fullWidth wrap={false} value={String(plan.audioDirection.energy)} items={[
              { value: '1', label: '低' }, { value: '2', label: '中' }, { value: '3', label: '高' },
            ]} onChange={(value) => patchPlan({ audioDirection: { ...plan.audioDirection, energy: Number(value) as 1 | 2 | 3 } })} /></Field>
          </> : null}
          {soundEffectsEnabled ? (
            <Field label="音效密度"><PillGroup fullWidth wrap={false} value={plan.audioDirection.soundDensity} items={[
              { value: 'quiet', label: '少' }, { value: 'balanced', label: '平衡' }, { value: 'active', label: '多' },
            ]} onChange={(soundDensity) => patchPlan({ audioDirection: { ...plan.audioDirection, soundDensity } })} /></Field>
          ) : null}
          {!bgmEnabled && !soundEffectsEnabled ? (
            <div className={styles.audioDisabledNote}>本片只保留口播，不生成背景音乐和提示音效。</div>
          ) : null}
        </Section>
      </main>

      <aside className={styles.review}><ReviewPanel plan={plan} /></aside>
      <details className={styles.reviewDrawer}>
        <summary><AlertTriangle size={13} />风险与检查</summary>
        <div><ReviewPanel plan={plan} /></div>
      </details>
    </div>
  );
}

function ReviewPanel({ plan }: { plan: DirectorPlan }) {
  return (
    <>
      <strong>导演检查</strong>
      <ReviewRow ok={plan.segments.some((segment) => segment.intensity === 3)} text="至少一个重点镜头" />
      <ReviewRow ok={plan.segments.every((segment) => Boolean(segment.carrier.trim()))} text="全部镜头已分配载体" />
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

function ReviewRow({ ok, text }: { ok: boolean; text: string }) {
  return <div className={styles.reviewRow} data-ok={ok}>{ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}<span>{text}</span></div>;
}

function formatTime(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
