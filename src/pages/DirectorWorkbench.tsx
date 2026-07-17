import { Clapperboard, RefreshCw, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { DirectorExecutionPanel } from '../components/director/DirectorExecutionPanel';
import { DirectorPlanEditor } from '../components/director/DirectorPlanEditor';
import { compareDirectorPlans } from '../lib/director-workflow';
import { isDirectorBgmEnabled } from '../lib/director-audio-options';
import { useDirectorWorkspace } from '../hooks/useDirectorWorkspace';
import type { AppPage } from '../lib/electron-api';
import type { DirectorPlan } from '../types/director';
import { Alert, Badge, Button, Spinner, Textarea } from '../ui';
import styles from './DirectorWorkbench.module.css';

export function DirectorWorkbench({
  projectDir,
  setPage,
}: {
  projectDir: string;
  setPage: (page: AppPage) => void;
}) {
  const director = useDirectorWorkspace(projectDir);
  const [globalPrompt, setGlobalPrompt] = useState('');
  const [draft, setDraft] = useState<DirectorPlan | null>(null);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);

  useEffect(() => {
    const next = director.production.draftPlan;
    setDraft(next);
    setSelectedSegmentId((current) => current && next?.segments.some((segment) => segment.id === current)
      ? current
      : next?.segments[0]?.id ?? null);
  }, [director.production.draftPlan]);

  const impact = useMemo(() => {
    if (!draft || !director.production.approvedPlan) return null;
    return compareDirectorPlans(director.production.approvedPlan, draft);
  }, [director.production.approvedPlan, draft]);
  const validation = validatePlan(draft);
  const hasApproved = Boolean(director.production.approvedPlan);

  const openRevision = async () => {
    const approved = director.production.approvedPlan;
    if (!approved) return;
    const next = {
      ...structuredClone(approved),
      revision: approved.revision + 1,
      approvedAt: undefined,
      updatedAt: Date.now(),
    };
    setDraft(next);
    setSelectedSegmentId(next.segments[0]?.id ?? null);
    await director.saveDraft(next);
  };

  if (director.loading) {
    return <div className={styles.centerState}><Spinner size={16} />读取导演方案…</div>;
  }

  return (
    <main className={styles.root} data-agent-zone="director-workbench">
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={styles.icon}><Clapperboard size={17} /></span>
          <div><span>全片制作控制</span><h1>导演台</h1></div>
        </div>
        <div className={styles.statusGroup}>
          <Badge variant="secondary" size="sm">{stageLabel(director.production.workflow.stage)}</Badge>
          {director.working ? <Button variant="secondary" size="sm" onClick={() => void director.cancel()}>暂停制作</Button> : null}
        </div>
      </header>

      {director.error ? <div className={styles.alert}><Alert variant="destructive">{director.error}</Alert></div> : null}

      {!draft && !hasApproved ? (
        <section className={styles.emptyState}>
          <div className={styles.emptyIcon}><Clapperboard size={22} /></div>
          <h2>先确定整片怎么讲，再开始制作</h2>
          <p>导演方案只分析结构、节奏、载体、封面和声音方向。批准前不会生成卡片、封面图或声音资产。</p>
          <label className={styles.promptField}>
            <span>补充创作要求</span>
            <Textarea value={globalPrompt} onChange={(event) => setGlobalPrompt(event.target.value)} rows={4} resize="vertical" placeholder="例如：节奏克制，重点突出数字证据，避免营销感" />
          </label>
          <Button variant="primary" size="md" onClick={() => void director.generatePlan(globalPrompt)} disabled={director.working}>
            {director.working ? <Spinner size={14} /> : <Clapperboard size={14} />}
            生成导演方案
          </Button>
        </section>
      ) : null}

      {hasApproved ? (
        <section className={styles.approvedBar}>
          <div>
            <span>当前批准方案</span>
            <strong>v{director.production.approvedPlan?.revision} · {director.production.approvedPlan?.segments.filter((segment) => segment.enabled).length} 个镜头</strong>
          </div>
          {!draft ? <Button variant="secondary" size="sm" onClick={() => void openRevision()} disabled={director.working}>
            <RefreshCw size={13} />修改导演方案
          </Button> : null}
        </section>
      ) : null}

      {draft ? (
        <>
          <DirectorPlanEditor
            plan={draft}
            selectedSegmentId={selectedSegmentId}
            onSelectSegment={setSelectedSegmentId}
            onChange={setDraft}
          />
          <footer className={styles.actionBar}>
            <div className={styles.impact}>
              {validation ? <><ShieldAlert size={14} /><span>{validation}</span></> : impact ? <span>{impactText(impact)}</span> : <span>批准后将开始生成画面、封面与声音计划</span>}
            </div>
            <div className={styles.actions}>
              <Button variant="secondary" onClick={() => draft && void director.saveDraft(draft)} disabled={director.working}>保存草案</Button>
              <Button variant="primary" onClick={() => draft && void director.approveAndProduce(draft)} disabled={director.working || Boolean(validation)}>
                {director.working ? <Spinner size={14} /> : null}批准并开始制作
              </Button>
            </div>
          </footer>
        </>
      ) : null}

      {hasApproved ? <DirectorExecutionPanel
        projectDir={projectDir}
        production={director.production}
        working={director.working}
        progress={director.progress}
        onResume={() => void director.resume()}
        onOpenEditor={() => setPage('editor')}
      /> : null}
    </main>
  );
}

function validatePlan(plan: DirectorPlan | null): string | null {
  if (!plan) return null;
  if (!plan.summary.trim()) return '请填写整片内容摘要';
  if (!plan.motionBible.visualThesis.trim()) return '请填写整片视觉命题';
  if (!plan.coverDirection.prompt.trim()) return '请填写封面方向';
  if (isDirectorBgmEnabled(plan.audioDirection) && !plan.audioDirection.bgmStyle.trim()) {
    return '请填写 BGM 风格，或关闭背景音乐';
  }
  if (!plan.segments.some((segment) => segment.enabled)) return '至少保留一个制作镜头';
  if (plan.segments.some((segment) => !segment.carrier.trim())) return '所有启用镜头都必须分配信息载体';
  return null;
}

function stageLabel(stage: string): string {
  return ({
    idle: '尚未规划', 'director-planning': '导演规划中', 'director-review': '等待方案确认',
    'production-running': '制作执行中', 'production-paused': '制作已暂停',
    'animatic-review': 'Animatic 待审', refining: '精修中', 'quality-blocked': '质检未通过',
    complete: '制作完成', error: '需要处理',
  } as Record<string, string>)[stage] ?? stage;
}

function impactText(impact: ReturnType<typeof compareDirectorPlans>): string {
  const parts = [
    impact.allCards ? '全部画面' : impact.segmentIds.length ? `${impact.segmentIds.length} 个画面` : '',
    impact.cover ? '封面' : '', impact.audio ? '声音' : '', impact.timeline ? '时间线' : '',
  ].filter(Boolean);
  return parts.length > 0 ? `批准后将更新：${parts.join('、')}` : '方案修改不影响现有制作结果';
}
