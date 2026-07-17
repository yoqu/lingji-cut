import { Check, Circle, CircleAlert } from 'lucide-react';
import type { ProjectData } from '../../lib/project-persistence';
import { allProductionCues } from '../../lib/production-workbench';
import type { MotionProductionPlan } from '../../types/production';
import type { ProjectProductionWorkflow } from '../../types/director';
import { Button } from '../../ui';
import styles from './ProductionContent.module.css';

const STAGE_LABELS = {
  idle: '尚未开始',
  'director-planning': '导演规划中',
  'director-review': '等待导演方案确认',
  'production-running': '制作执行中',
  'production-paused': '制作已暂停',
  'animatic-review': '等待导演确认',
  refining: '精修中',
  'quality-blocked': '质量检查未通过',
  complete: '制作完成',
  error: '制作出错',
} as const;

export function ProductionOverview({
  project,
  plan,
  workflow,
  onApprove,
  onReopen,
  onRunQuality,
}: {
  project: ProjectData;
  plan: MotionProductionPlan;
  workflow?: ProjectProductionWorkflow;
  onApprove: () => void;
  onReopen: () => void;
  onRunQuality: () => void;
}) {
  const cues = allProductionCues(plan);
  const resolvedCues = cues.filter((cue) => cue.assetId).length;
  const requiredMissing = cues.filter((cue) => cue.required && !cue.assetId).length;
  const workflowStage = workflow?.stage ?? 'idle';
  const steps = [
    { label: '口播', done: Boolean(project.timeline?.podcast.audioPath) },
    { label: 'Motion Bible', done: Boolean(plan.motionBible.visualThesis) },
    { label: '镜头', done: plan.shots.length > 0 },
    { label: '素材', done: plan.shots.every((shot) => shot.assetRequests.length === 0 || shot.assetRequests.every((item) => item.query.trim())) },
    { label: '声音', done: requiredMissing === 0 },
    { label: 'Animatic', done: ['animatic-review', 'refining', 'quality-blocked', 'complete'].includes(workflowStage) },
    { label: '质检', done: plan.qualityReport?.exportAllowed === true },
  ];

  return (
    <div className={styles.view}>
      <div className={styles.statusHeader}>
        <div>
          <span className={styles.eyebrow}>制作状态</span>
          <strong className={styles.statusTitle}>{STAGE_LABELS[workflowStage]}</strong>
        </div>
        <span className={styles.modeBadge}>{workflow?.mode === 'director' ? '导演模式' : '一键模式'}</span>
      </div>

      <ol className={styles.pipelineSteps}>
        {steps.map((step) => (
          <li key={step.label} data-complete={step.done}>
            {step.done ? <Check size={12} /> : <Circle size={12} />}
            <span>{step.label}</span>
          </li>
        ))}
      </ol>

      <section className={styles.section}>
        <div className={styles.sectionHeading}>Motion Bible</div>
        <p className={styles.lead}>{plan.motionBible.visualThesis}</p>
        <dl className={styles.definitionGrid}>
          <div><dt>节奏密度</dt><dd>{plan.motionBible.rhythm.density}</dd></div>
          <div><dt>镜头数量</dt><dd>{plan.shots.length}</dd></div>
          <div><dt>视觉规则</dt><dd>{plan.motionBible.styleRules.paletteUse}</dd></div>
          <div><dt>文字规则</dt><dd>{plan.motionBible.styleRules.typographyUse}</dd></div>
        </dl>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeading}>制作完整度</div>
        <div className={styles.metricsLine}>
          <span>{plan.sequences.length} 个章节</span>
          <span>{plan.shots.length} 个镜头</span>
          <span>{resolvedCues}/{cues.length} 条声音已解析</span>
        </div>
        {requiredMissing > 0 ? (
          <div className={styles.inlineWarning}>
            <CircleAlert size={14} />
            <span>{requiredMissing} 条必需声音尚未生成或匹配</span>
          </div>
        ) : null}
      </section>

      <div className={styles.actionRow}>
        {workflowStage === 'animatic-review' || workflowStage === 'director-review' ? (
          <Button variant="primary" size="sm" onClick={onApprove}>批准 Animatic，进入精修</Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={onReopen}>退回导演修改</Button>
        )}
        <Button variant="secondary" size="sm" onClick={onRunQuality}>运行制作检查</Button>
      </div>
    </div>
  );
}
