import {
  ChevronDown,
  ChevronUp,
  Clapperboard,
  History,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { DirectorExecutionPanel } from '../components/director/DirectorExecutionPanel';
import { DirectorPlanEditor } from '../components/director/DirectorPlanEditor';
import { compareDirectorPlans } from '../lib/director-workflow';
import { isDirectorBgmEnabled } from '../lib/director-audio-options';
import { firstDirectorPlanApprovalError } from '../lib/director-plan-validation';
import { legacyShowDirectorPlanVersion } from '../lib/show-director-version';
import { useDirectorWorkspace } from '../hooks/useDirectorWorkspace';
import { loadAISettings } from '../store/ai';
import type { AppPage } from '../lib/electron-api';
import { DEFAULT_KACUT_BASE_URL } from '../types/ai';
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
  const [kacutBaseUrl, setKacutBaseUrl] = useState(DEFAULT_KACUT_BASE_URL);
  const [kacutEnabled, setKacutEnabled] = useState(false);
  const [showPreviousExecution, setShowPreviousExecution] = useState(false);

  useEffect(() => {
    let disposed = false;
    void loadAISettings().then((settings) => {
      const baseUrl = settings?.kacut?.baseUrl?.trim();
      if (!disposed && baseUrl) setKacutBaseUrl(baseUrl);
      if (!disposed) setKacutEnabled(settings?.kacut?.enabled === true);
    });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const next = director.production.draftPlan;
    setDraft(next);
    setSelectedSegmentId((current) => current && next?.segments.some((segment) => segment.id === current)
      ? current
      : next?.segments[0]?.id ?? null);
  }, [director.production.draftPlan]);

  useEffect(() => {
    if (director.planning) setShowPreviousExecution(false);
  }, [director.planning]);

  useEffect(() => {
    setShowPreviousExecution(false);
  }, [director.production.draftPlan?.revision, director.production.approvedPlan?.revision]);

  const impact = useMemo(() => {
    if (!draft || !director.production.approvedPlan) return null;
    return compareDirectorPlans(director.production.approvedPlan, draft);
  }, [director.production.approvedPlan, draft]);
  const validation = validatePlan(draft);
  const hasApproved = Boolean(director.production.approvedPlan);
  const draftDirty = Boolean(
    draft
    && JSON.stringify(draft) !== JSON.stringify(director.production.draftPlan),
  );
  const savingDraft = director.draftSaveStatus === 'saving';
  const legacyDirectorVersion = draft ? legacyShowDirectorPlanVersion(draft) : null;
  const lockedSegmentCount = draft?.segments.filter((segment) => (
    Object.values(segment.userLocks ?? {}).some(Boolean)
  )).length ?? 0;
  const lockedPlanFieldCount = Object.values(draft?.userLocks ?? {}).filter(Boolean).length;
  const lockedSegmentFieldCount = draft?.segments.reduce((total, segment) => (
    total + Object.values(segment.userLocks ?? {}).filter(Boolean).length
  ), 0) ?? 0;
  const protectedEditText = lockedPlanFieldCount + lockedSegmentFieldCount > 0
    ? ` 当前有 ${lockedPlanFieldCount} 个整片字段、${lockedSegmentCount} 个镜头中的 ${lockedSegmentFieldCount} 项修改受保护，重新编排会原样保留。`
    : '';

  const replan = async () => {
    if (!draft) return;
    try {
      if (draftDirty) await director.saveDraft(draft);
      await director.generatePlan(draft.userPrompt?.trim() || globalPrompt.trim() || undefined);
    } catch {
      // saveDraft exposes the actionable error in the workbench and keeps the current draft open.
    }
  };

  const openRevision = async () => {
    const approved = director.production.approvedPlan;
    if (!approved) return;
    setShowPreviousExecution(false);
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
          <Badge variant="secondary" size="sm">
            {director.planning ? '导演规划中' : stageLabel(director.production.workflow.stage)}
          </Badge>
          {director.producing ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void director.cancel()}
              disabled={director.cancelling}
            >
              {director.cancelling ? '暂停中…' : '暂停制作'}
            </Button>
          ) : null}
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
            {director.planning ? <Spinner size={14} /> : <Clapperboard size={14} />}
            生成导演方案
          </Button>
        </section>
      ) : null}

      {draft || hasApproved ? (
        <section className={styles.approvedBar}>
          <div>
            <span>{draft ? '正在审阅的导演草案' : '当前批准方案'}</span>
            <strong>
              {draft
                ? `草案 v${draft.revision} · ${draft.segments.filter((segment) => segment.enabled).length} 个镜头`
                : `批准 v${director.production.approvedPlan?.revision} · ${director.production.approvedPlan?.segments.filter((segment) => segment.enabled).length} 个镜头`}
            </strong>
            {draft ? (
              <small>
                {hasApproved
                  ? `当前成片仍使用批准 v${director.production.approvedPlan?.revision}；下方草案批准后才会重新生成画面。`
                  : '下方内容只是导演规划，批准后才会开始生成真实画面。'}
              </small>
            ) : null}
          </div>
          {!draft ? <Button variant="secondary" size="sm" onClick={() => void openRevision()} disabled={director.working}>
            <RefreshCw size={13} />修改导演方案
          </Button> : null}
        </section>
      ) : null}

      {draft && legacyDirectorVersion ? (
        <section className={styles.legacyPlanBar} data-testid="legacy-director-plan-warning">
          <div>
            <strong>这份草案仍由旧版导演流程生成</strong>
            <span>
              草案 v{draft.revision} 是方案修订号，不是导演引擎版本。当前内容来自角色 v{legacyDirectorVersion.role}
              {' · '}工作流 v{legacyDirectorVersion.workflow}，不会自动获得新版搜材审计与 Agent Composite 编排。
              {protectedEditText}
            </span>
          </div>
          <Button variant="primary" size="sm" onClick={() => void replan()} disabled={director.working || savingDraft}>
            <RefreshCw size={13} />用当前导演重新编排
          </Button>
        </section>
      ) : null}

      {draft ? (
        <>
          <DirectorPlanEditor
            plan={draft}
            selectedSegmentId={selectedSegmentId}
            onSelectSegment={setSelectedSegmentId}
            onChange={(nextDraft) => {
              if (!director.working) setDraft(nextDraft);
            }}
            onCommit={async (nextDraft) => {
              if (!director.working) await director.saveDraft(nextDraft);
            }}
            readOnly={director.working}
            footagePlacements={director.production.footage?.placements ?? []}
            kacutBaseUrl={kacutBaseUrl}
            kacutEnabled={kacutEnabled}
          />
          <footer className={styles.actionBar}>
            <div className={styles.impact}>
              {legacyDirectorVersion
                ? <><ShieldAlert size={14} /><span>旧版导演草案不能直接开始制作，请先用当前导演重新编排。{protectedEditText}</span></>
                : validation
                  ? <><ShieldAlert size={14} /><span>{validation}</span></>
                  : impact
                    ? <span>{impactText(impact)}</span>
                    : <span>批准后将开始生成画面、封面与声音计划</span>}
            </div>
            <div className={styles.actions}>
              <Button
                variant="secondary"
                onClick={() => void replan()}
                disabled={director.working || savingDraft}
              >
                <RefreshCw size={14} />重新编排
              </Button>
              <span className={styles.saveState} data-status={draftDirty ? 'dirty' : director.draftSaveStatus}>
                {savingDraft
                  ? '正在保存导演草案…'
                  : director.draftSaveStatus === 'error'
                    ? '导演草案保存失败，修改仍保留在当前页面'
                    : draftDirty
                      ? '导演草案有未保存修改'
                      : director.draftSaveStatus === 'saved'
                        ? '导演草案已保存，尚未制作'
                        : '导演草案已同步，尚未制作'}
              </span>
              <Button variant="secondary" onClick={() => draft && void director.saveDraft(draft)} disabled={director.working || savingDraft || !draftDirty}>
                {savingDraft ? '保存中…' : '保存导演草案'}
              </Button>
              <Button
                variant="primary"
                onClick={() => draft && void director.approveAndProduce(draft)}
                disabled={director.working || savingDraft || Boolean(validation) || Boolean(legacyDirectorVersion)}
                title={legacyDirectorVersion ? '请先用当前导演重新编排旧版草案' : undefined}
              >
                {director.producing ? <Spinner size={14} /> : null}批准并开始制作
              </Button>
            </div>
          </footer>
        </>
      ) : null}

      {hasApproved && draft && !director.planning ? (
        <section className={styles.previousResultsBar} aria-label="旧批准版本制作结果">
          <div className={styles.previousResultsLead}>
            <History size={15} />
            <div>
              <strong>旧批准 v{director.production.approvedPlan?.revision} 的制作结果</strong>
              <small>不属于当前草案 v{draft.revision}，默认收起以免与重新编排结果混淆。</small>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowPreviousExecution((current) => !current)}
            aria-expanded={showPreviousExecution}
          >
            {showPreviousExecution ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {showPreviousExecution ? '收起旧版结果' : '查看旧版结果'}
          </Button>
        </section>
      ) : null}

      {hasApproved && (!draft || (showPreviousExecution && !director.planning)) ? (
        <DirectorExecutionPanel
          key={`${director.production.approvedPlan?.revision}:${draft ? 'history' : 'current'}`}
          projectDir={projectDir}
          production={director.production}
          working={director.producing}
          progress={director.progress}
          onResume={() => void director.resume()}
          onOpenEditor={() => setPage('editor')}
          readOnly={Boolean(draft)}
        />
      ) : null}
    </main>
  );
}

function validatePlan(plan: DirectorPlan | null): string | null {
  if (!plan) return null;
  if (isDirectorBgmEnabled(plan.audioDirection) && !plan.audioDirection.bgmStyle.trim()) {
    return '请填写 BGM 风格，或关闭背景音乐';
  }
  return firstDirectorPlanApprovalError(plan);
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
