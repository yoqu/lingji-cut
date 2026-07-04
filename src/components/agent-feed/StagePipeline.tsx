import React from 'react';
import { STAGE_NAMES, STAGE_ORDER, type AgentFeedStage, type StageState } from '../../store/agent-feed';
import styles from './agent-feed.module.css';

interface StagePipelineProps {
  stages: Record<AgentFeedStage, StageState>;
  /** 点击节点跳转到该阶段第一条对话。 */
  onStageClick?: (stage: AgentFeedStage) => void;
}

export function StagePipeline({ stages, onStageClick }: StagePipelineProps) {
  return (
    <div className={styles.pipeline} aria-label="生成阶段">
      {STAGE_ORDER.map((stage, i) => {
        const st = stages[stage];
        return (
          <React.Fragment key={stage}>
            {i > 0 ? <span className={styles.pipelineLink} /> : null}
            <button
              type="button"
              className={styles.pipelineNode}
              data-status={st.status}
              title={`${STAGE_NAMES[stage]}${st.round ? `（第 ${st.round} 轮重试）` : ''}`}
              onClick={() => onStageClick?.(stage)}
            >
              <span className={styles.pipelineDot} data-status={st.status} />
              <span>{STAGE_NAMES[stage]}</span>
              {st.round ? <span className={styles.pipelineRound}>↻{st.round}</span> : null}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}
