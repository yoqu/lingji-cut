/**
 * AgentFeedView — AI 卡片多 agent 生成过程的共享观测视图。
 *
 * 编辑器右侧 Inspector（常驻停靠）与状态栏浮层（编辑器外）共用：
 * 左侧卡片轨（多卡并行时每卡一个头像，活跃呼吸）、顶部阶段管线
 * （导演→雕刻→质检→审查，点击跳转该阶段对话）、下方角色对话流
 * （角色头像 + 模型徽标，复用 renderBlocks）。
 */

import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { renderBlocks } from '../agent/AssistantMessage';
import {
  useAgentFeedStore,
  type AgentFeedRole,
  type AgentFeedSession,
  type AgentFeedStage,
} from '../../store/agent-feed';
import { RoleAvatar } from './RoleAvatar';
import { StagePipeline } from './StagePipeline';
import styles from './agent-feed.module.css';

function modelShortName(model: string | undefined): string {
  if (!model) return '默认模型';
  return model.split('/').pop() || model;
}

function SessionView({ session }: { session: AgentFeedSession }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  };

  // 流式更新贴底跟随；上滚后不强拉（与 MessageList 行为一致）。
  useLayoutEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session]);

  useEffect(() => {
    pinnedRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.key]);

  const scrollToStage = (stage: AgentFeedStage) => {
    const el = scrollRef.current?.querySelector(`[data-stage="${stage}"]`);
    if (el) {
      pinnedRef.current = false;
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  };

  const lastIndex = session.turns.length - 1;
  return (
    <div className={styles.sessionView}>
      <div className={styles.sessionHead} title={session.label}>
        {session.label}
      </div>
      <StagePipeline stages={session.stages} onStageClick={scrollToStage} />
      <div ref={scrollRef} onScroll={handleScroll} className={styles.messages}>
        {session.turns.map((turn, index) => {
          const role = (turn.agentId ?? 'orchestrator') as AgentFeedRole;
          const stage = session.turnStages[String(turn.id)];
          return (
            <div
              key={String(turn.id)}
              data-stage={stage}
              style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
            >
              <div className={styles.turnCaption}>
                <RoleAvatar role={role} />
                <span>{turn.agentName}</span>
                {role !== 'orchestrator' ? (
                  <span className={styles.modelBadge} title={session.modelsByRole[role]}>
                    {modelShortName(session.modelsByRole[role])}
                  </span>
                ) : null}
              </div>
              {renderBlocks(turn.blocks, {
                isLastAssistant: index === lastIndex,
                isStreaming: index === lastIndex && session.status === 'active',
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface AgentFeedViewBodyProps {
  sessions: Map<string, AgentFeedSession>;
  selectedKey: string | null;
  onSelectSession: (key: string) => void;
}

/** 展示层（测试直供 props；运行时由 AgentFeedView 从 store 取）。 */
export function AgentFeedViewBody({ sessions, selectedKey, onSelectSession }: AgentFeedViewBodyProps) {
  const list = Array.from(sessions.values()).sort((a, b) => b.startedAt - a.startedAt);
  if (list.length === 0) {
    return (
      <div className={styles.empty}>
        暂无生成过程：卡片生成开始后这里会实时显示各 agent 的对话与阶段进展。
      </div>
    );
  }
  const selected = (selectedKey && sessions.get(selectedKey)) || list[0];

  return (
    <div className={styles.view}>
      {list.length > 1 ? (
        <div className={styles.cardRail}>
          {list.map((session) => (
            <button
              key={session.key}
              type="button"
              className={`${styles.cardAvatar} ${
                selected.key === session.key ? styles.cardAvatarSelected : ''
              }`}
              data-status={session.status}
              title={session.label}
              onClick={() => onSelectSession(session.key)}
            >
              {session.label.slice(0, 1)}
            </button>
          ))}
        </div>
      ) : null}
      <SessionView session={selected} />
    </div>
  );
}

export function AgentFeedView() {
  const sessions = useAgentFeedStore((s) => s.sessions);
  const selectedKey = useAgentFeedStore((s) => s.selectedKey);
  const selectSession = useAgentFeedStore((s) => s.selectSession);
  return <AgentFeedViewBody sessions={sessions} selectedKey={selectedKey} onSelectSession={selectSession} />;
}
