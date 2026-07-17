import { MousePointer2 } from 'lucide-react';
import styles from './AgentCursor.module.css';

/**
 * 统一 AI 虚拟鼠标指针：系统蓝指针 + 简洁文本标签。
 * 审稿浮动指针与全局操作反馈层共用此组件，不要另行实现。
 */
export function AgentCursor({ label = 'AI' }: { label?: string }) {
  return (
    <>
      <MousePointer2 className={styles.pointer} size={20} strokeWidth={1.5} aria-hidden="true" />
      <span className={styles.label}>{label}</span>
    </>
  );
}
