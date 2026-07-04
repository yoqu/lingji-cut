import { Clapperboard, Hammer, ShieldCheck, Workflow, type LucideIcon } from 'lucide-react';
import type { AgentFeedRole } from '../../store/agent-feed';
import styles from './agent-feed.module.css';

const ROLE_ICONS: Record<AgentFeedRole, LucideIcon> = {
  director: Clapperboard,
  sculptor: Hammer,
  reviewer: ShieldCheck,
  orchestrator: Workflow,
};

export function RoleAvatar({ role, size = 18 }: { role: AgentFeedRole; size?: number }) {
  const Icon = ROLE_ICONS[role] ?? Workflow;
  return (
    <span className={styles.roleAvatar} data-role={role} style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.62)} />
    </span>
  );
}
