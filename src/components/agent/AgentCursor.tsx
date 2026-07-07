import styles from './AgentCursor.module.css';

/**
 * 统一 AI 虚拟鼠标指针（铁律视觉：绿色 #34d399 指针 + AI 标签）。
 * 审稿浮动指针与全局操作反馈层共用此组件，不要另行实现。
 */
export function AgentCursor({ label = 'AI' }: { label?: string }) {
  return (
    <>
      <svg width="20" height="24" viewBox="0 0 20 24" fill="none">
        <path
          d="M1 1L1 18.5L5.5 14L10.5 22L13.5 20.5L8.5 12.5L14 11.5L1 1Z"
          fill="rgba(52, 211, 153, 0.85)"
          stroke="rgba(255,255,255,0.6)"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
      <span className={styles.label}>{label}</span>
    </>
  );
}
