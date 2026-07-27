import { Copy, FileUp, Newspaper, RefreshCw, Search, Sparkles, Square, User } from 'lucide-react';
import {
  selectAutoWorkbenchStage,
  selectEffectiveWorkbenchStage,
  selectOriginalFileReadiness,
  selectScriptFileReadiness,
  WORKBENCH_STAGE_LABELS,
  type WorkbenchStage,
} from '../../lib/script-workbench-stage';
import { getAllRoles } from '../../lib/script-templates';
import { Select, type SelectOption } from '../../ui';
import { useScriptStore } from '../../store/script';
import { useTaskProgressStore } from '../../store/task-progress';
import { ModelSelector } from './ModelSelector';
import styles from './QuickActionBar.module.css';

interface QuickActionBarProps {
  onImportText: () => void;
  onImportDouyin: () => void;
  onImportWechat: () => void;
}

const STAGE_OPTIONS: WorkbenchStage[] = [
  'not_started',
  'original_ready',
  'script_ready',
  'review_issues',
  'review_clean',
];

/** 内容区顶部快捷操作栏：根据真实文件状态派生阶段，并允许用户手动校准显示阶段 */
export function QuickActionBar({ onImportText, onImportDouyin, onImportWechat }: QuickActionBarProps) {
  const workbenchStage = useScriptStore(selectAutoWorkbenchStage);
  const effectiveWorkbenchStage = useScriptStore(selectEffectiveWorkbenchStage);
  const originalReadiness = useScriptStore(selectOriginalFileReadiness);
  const scriptReadiness = useScriptStore(selectScriptFileReadiness);
  const agentOperation = useScriptStore((s) => s.agentOperation);
  const reviewState = useScriptStore((s) => s.reviewState);
  const scriptText = useScriptStore((s) => s.scriptText);
  const annotations = useScriptStore((s) => s.annotations);
  const activeStreamId = useScriptStore((s) => s.activeStream.streamId);
  const selectedRole = useScriptStore((s) => s.selectedRole);
  const manualStageOverride = useScriptStore((s) => s.manualStageOverride);
  const setSelectedRole = useScriptStore((s) => s.setSelectedRole);
  const setManualStageOverride = useScriptStore((s) => s.setManualStageOverride);
  const clearManualStageOverride = useScriptStore((s) => s.clearManualStageOverride);
  const activeAITask = useTaskProgressStore((s) => {
    if (!activeStreamId) return null;
    const task = s.tasks.get(activeStreamId);
    if (
      !task ||
      task.status !== 'active' ||
      (task.category !== 'ai-write' && task.category !== 'ai-review') ||
      !task.canCancel ||
      !task.onCancel
    ) {
      return null;
    }
    return task;
  });
  const generateScriptCb = useScriptStore((s) => s.workbenchCallbacks.generateScript);
  const regenerateScript = useScriptStore((s) => s.workbenchCallbacks.regenerateScript);
  const reviewScriptCb = useScriptStore((s) => s.workbenchCallbacks.reviewScript);

  const roles = getAllRoles();
  const roleOptions: SelectOption[] = roles.map((role) => ({ value: role.id, label: role.name }));
  const isOperating = agentOperation.isOperating;
  const hasOriginal = originalReadiness !== 'missing';
  const hasScript = scriptReadiness !== 'missing';
  const hasActionableAnnotations = annotations.some(
    (annotation) => annotation.status === 'pending' && !annotation.stale,
  );
  const canGenerateScript =
    workbenchStage === 'original_ready' && originalReadiness === 'ready';
  const canReviewScript = scriptReadiness === 'ready' && Boolean(reviewScriptCb);
  const canRegenerateScript = scriptReadiness === 'ready' && Boolean(regenerateScript);
  const canCopyScript = scriptReadiness === 'ready' && Boolean(scriptText.trim());

  const handleGenerate = () => {
    if (!generateScriptCb || isOperating) return;
    void generateScriptCb();
  };

  const handleReview = () => {
    if (!reviewScriptCb || isOperating) return;
    void reviewScriptCb();
  };

  const handleRegenerate = () => {
    if (!regenerateScript || isOperating) return;
    void regenerateScript();
  };

  const handleCopy = () => {
    if (scriptText) {
      navigator.clipboard.writeText(scriptText).catch(() => {});
    }
  };

  const handleAcceptAll = () => {
    useScriptStore.getState().acceptAllAnnotations();
  };

  const handleStop = () => {
    if (!activeAITask) return;
    const interrupt = activeAITask.onCancel;
    useTaskProgressStore.getState().cancelTask(activeAITask.id, '用户停止');
    interrupt?.();
  };

  const roleSelector = (
    <div className={styles.roleSelector}>
      <User size={12} className={styles.roleIcon} />
      <Select
        options={roleOptions}
        value={selectedRole}
        onChange={(event) => setSelectedRole(event.target.value)}
        disabled={isOperating}
        className={styles.roleSelectWrap}
        controlClassName={styles.compactControl}
      />
    </div>
  );

  const stageOptions: SelectOption[] = [
    { value: '__auto__', label: '按文件自动判断' },
    ...STAGE_OPTIONS.map((stage) => ({ value: stage, label: WORKBENCH_STAGE_LABELS[stage] })),
  ];

  const stageControls = (
    <div className={styles.stageControls}>
      <span className={styles.stageMeta}>
        稿件阶段：{WORKBENCH_STAGE_LABELS[effectiveWorkbenchStage]}
        {manualStageOverride ? '（手动）' : '（自动）'}
      </span>
      <Select
        aria-label="稿件阶段判断"
        options={stageOptions}
        value={manualStageOverride ?? '__auto__'}
        onChange={(event) => {
          const nextValue = event.target.value;
          if (nextValue === '__auto__') {
            clearManualStageOverride();
            return;
          }
          setManualStageOverride(nextValue as WorkbenchStage);
        }}
        className={styles.stageSelectWrap}
        controlClassName={styles.compactControl}
      />
      {manualStageOverride ? (
        <button
          type="button"
          className={styles.btn}
          onClick={clearManualStageOverride}
        >
          恢复自动
        </button>
      ) : null}
    </div>
  );

  const renderBar = (hint: string, actions: React.ReactNode) => (
    <div className={styles.bar}>
      <div className={styles.hint}>
        <span>{hint}</span>
        {stageControls}
      </div>
      <div className={styles.actions}>{actions}</div>
    </div>
  );

  if (isOperating) {
    return renderBar('正在处理当前稿件', agentOperation.canInterrupt && activeAITask?.onCancel ? (
      <button
        type="button"
        className={`${styles.btn} ${styles.dangerBtn}`}
        onClick={handleStop}
      >
        <Square size={12} />
        停止
      </button>
    ) : null);
  }

  if (!hasOriginal && !hasScript) {
    return renderBar(
      '开始创作',
      <>
        <button
          type="button"
          className={`${styles.btn} ${styles.primaryBtn}`}
          onClick={onImportText}
        >
          <FileUp size={12} />
          导入原稿
        </button>
        <button type="button" className={styles.btn} onClick={onImportWechat}>
          <Newspaper size={12} />
          公众号文章
        </button>
        <button type="button" className={styles.btn} onClick={onImportDouyin}>
          <FileUp size={12} />
          导入媒体
        </button>
      </>,
    );
  }

  const stageHint = (() => {
    if (workbenchStage === 'original_ready' && originalReadiness === 'empty') {
      return '原稿文件已创建，等待补充内容';
    }
    if (reviewState === 'stale') {
      return '内容已变更，建议重新审查';
    }
    if (effectiveWorkbenchStage === 'review_clean') {
      return '审查已完成';
    }
    if (workbenchStage === 'review_issues' && hasActionableAnnotations && reviewState === 'issues') {
      return '审查发现问题';
    }
    if (workbenchStage === 'original_ready') {
      return '原稿已就绪';
    }
    if (workbenchStage === 'script_ready' || hasScript) {
      return '口播稿已生成';
    }
    return '当前阶段需要校准，请手动调整';
  })();

  return renderBar(
    stageHint,
    <>
      {(canGenerateScript || canReviewScript || canRegenerateScript) ? roleSelector : null}
      {(canGenerateScript || canRegenerateScript) ? <ModelSelector /> : null}
      {canGenerateScript ? (
        <button
          type="button"
          className={`${styles.btn} ${styles.primaryBtn}`}
          disabled={!generateScriptCb}
          onClick={handleGenerate}
          title="根据原稿和当前角色生成口播稿"
        >
          <Sparkles size={12} />
          生成口播稿
        </button>
      ) : null}
      {workbenchStage === 'review_issues' && hasActionableAnnotations && reviewState === 'issues' ? (
        <button
          type="button"
          className={`${styles.btn} ${styles.primaryBtn}`}
          onClick={handleAcceptAll}
        >
          全部接受建议
        </button>
      ) : null}
      {canReviewScript ? (
        <button
          type="button"
          className={`${styles.btn} ${
            !canGenerateScript && !canCopyScript ? styles.primaryBtn : ''
          }`}
          disabled={!reviewScriptCb}
          onClick={handleReview}
          title="检查口播稿并生成可逐条处理的建议"
        >
          <Search size={12} />
          {reviewState === 'issues' || reviewState === 'stale' || effectiveWorkbenchStage === 'review_clean'
            ? '重新审查'
            : '审查口播稿'}
        </button>
      ) : null}
      {canRegenerateScript ? (
        <button
          type="button"
          className={styles.btn}
          disabled={!regenerateScript}
          onClick={handleRegenerate}
        >
          <RefreshCw size={12} />
          重新生成
        </button>
      ) : null}
      {canCopyScript ? (
        <button
          type="button"
          className={`${styles.btn} ${effectiveWorkbenchStage === 'review_clean' ? styles.primaryBtn : ''}`}
          onClick={handleCopy}
        >
          <Copy size={12} />
          复制口播稿
        </button>
      ) : null}
      {workbenchStage === 'original_ready' && originalReadiness !== 'empty' ? (
        <>
          <button type="button" className={styles.btn} onClick={onImportText}>
            <FileUp size={12} />
            重新导入
          </button>
          <button type="button" className={styles.btn} onClick={onImportWechat}>
            <Newspaper size={12} />
            公众号文章
          </button>
          <button type="button" className={styles.btn} onClick={onImportDouyin}>
            <FileUp size={12} />
            媒体导入
          </button>
        </>
      ) : null}
      {originalReadiness === 'empty' ? (
        <>
          <button
            type="button"
            className={`${styles.btn} ${styles.primaryBtn}`}
            onClick={onImportText}
          >
            <FileUp size={12} />
            导入原稿
          </button>
          <button type="button" className={styles.btn} onClick={onImportDouyin}>
            <FileUp size={12} />
            导入媒体
          </button>
        </>
      ) : null}
    </>,
  );
}
