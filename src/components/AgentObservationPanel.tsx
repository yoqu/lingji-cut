/**
 * AgentObservationPanel — AI 卡片多 agent 生成过程的浮层入口（编辑器外兜底）。
 *
 * 状态栏上方浮层（与 TaskProgressPanel 同模式），内容复用 AgentFeedView。
 * 编辑器内该内容停靠在右侧 Inspector（dockMounted 时 openPanel 不再打开本浮层）。
 */

import { AgentFeedView } from './agent-feed/AgentFeedView';
import { useAgentFeedStore } from '../store/agent-feed';
import styles from './AgentObservationPanel.module.css';

export function AgentObservationPanel() {
  const panelOpen = useAgentFeedStore((s) => s.panelOpen);
  const closePanel = useAgentFeedStore((s) => s.closePanel);
  const clearAll = useAgentFeedStore((s) => s.clearAll);

  if (!panelOpen) return null;

  return (
    <>
      <div className={styles.overlay} onClick={closePanel} />
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.title}>AI 生成过程观测</span>
          <button className={styles.headerBtn} onClick={clearAll} title="清除全部观测记录">
            清除记录
          </button>
          <button className={styles.headerBtn} onClick={closePanel}>
            关闭
          </button>
        </div>
        <AgentFeedView />
      </div>
    </>
  );
}
