import type { RefObject } from 'react';
import { LoaderCircle, Square } from 'lucide-react';
import type { WorkflowState } from '../store/ai';
import { Button } from '../ui';
import styles from './TimelineAIOverlay.module.css';

interface TimelineAIOverlayProps {
  workflow: WorkflowState;
  timelineContainerRef: RefObject<HTMLDivElement | null>;
  compactTimeline: boolean;
  onCancel: () => void;
  onRetry: () => void;
}

export function TimelineAIOverlay({
  workflow,
  timelineContainerRef: _timelineContainerRef,
  compactTimeline: _compactTimeline,
  onCancel,
  onRetry: _onRetry,
}: TimelineAIOverlayProps) {
  const isVisible =
    workflow.step !== 'idle' && workflow.step !== 'done' && workflow.step !== 'error';

  if (!isVisible) {
    return null;
  }

  const percent = Math.round(Math.max(0, Math.min(100, workflow.progress)));
  const phase = workflow.stepLabel || '正在处理当前项目';

  return (
    <div
      data-editor-region="workflow-status"
      role="status"
      aria-live="polite"
      aria-label={`自动剪辑进行中：${phase}`}
      className={styles.root}
    >
      <LoaderCircle className={styles.spinner} size={14} aria-hidden="true" />
      <span className={styles.title}>自动剪辑</span>
      <span className={styles.phase}>{phase}</span>
      <span className={styles.percent}>{percent}%</span>
      {workflow.canCancel ? (
        <Button
          variant="ghost"
          size="xs"
          className={styles.cancelButton}
          leftIcon={<Square size={10} />}
          onClick={onCancel}
        >
          停止
        </Button>
      ) : null}
      <div className={styles.progressTrack} aria-hidden="true">
        <div className={styles.progressValue} style={{ transform: `scaleX(${percent / 100})` }} />
      </div>
    </div>
  );
}
