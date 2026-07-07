import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { m } from 'framer-motion';
import { springs, durations, easings } from '../../ui/lib/motion';
import { useScriptStore } from '../../store/script';
import { getCurrentProjectDir } from '../../store/timeline';
import { useConversationList } from '../../hooks/use-conversation-list';
import { AgentHeader } from './AgentHeader';
import { ChatPane } from './ChatPane';
import styles from './AgentSidebar.module.css';
import { ConversationWorkspaceProvider } from '../../contexts/conversation-workspace-context';
import { AcpConnectionsProvider, useAcpConnections } from '../../contexts/acp-connections-context';
import { ConversationRuntimeProvider } from '../../contexts/conversation-runtime-context';

const MIN_WIDTH = 320;
const MAX_WIDTH = 700;

interface AgentSidebarProps {
  /** 打开设置中心并定位 Agent tab（点击对话头部 agent 只读标记触发）。 */
  onOpenAgentSettings?: () => void;
}

function AgentSidebarWorkspace({
  projectDir,
  onOpenAgentSettings,
}: {
  projectDir: string | null;
  onOpenAgentSettings?: () => void;
}) {
  const conversationProjectId = useMemo(() => projectDir, [projectDir]);

  if (!conversationProjectId) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 text-center text-sm text-mac-text-muted/60">
        先打开一个项目目录，才能使用会话工作区。
      </div>
    );
  }

  return (
    <ConversationWorkspaceProvider projectId={conversationProjectId}>
      <AcpConnectionsProvider>
        <ConversationRuntimeProvider>
          <SidebarWorkspaceShell
            projectDir={conversationProjectId}
            onOpenAgentSettings={onOpenAgentSettings}
          />
        </ConversationRuntimeProvider>
      </AcpConnectionsProvider>
    </ConversationWorkspaceProvider>
  );
}

export function SidebarWorkspaceShell({
  projectDir,
  onOpenAgentSettings,
}: {
  projectDir: string;
  onOpenAgentSettings?: () => void;
}) {
  const [explicitConversationId, setExplicitConversationId] = useState<number | null>(null);
  const connections = useAcpConnections();
  const {
    activeConversationId,
    deleteConversation,
    setActiveConversation,
  } = useConversationList();

  // 侧边栏打开后，workspace bootstrap 会加载上次活跃/首条会话；
  // 自动同步到 explicitConversationId 以触发连接。
  useEffect(() => {
    if (explicitConversationId === null && activeConversationId !== null) {
      setExplicitConversationId(activeConversationId);
    }
  }, [explicitConversationId, activeConversationId]);

  // 新建会话由 ConversationDropdown 自己用 getPreferredAgentType() 创建后回调；
  // 这里仅负责切到新会话以触发连接。
  function handleCreatedConversation(conversationId: number) {
    setExplicitConversationId(conversationId);
    void setActiveConversation(conversationId);
  }

  async function handleSelectConversation(conversationId: number) {
    setExplicitConversationId(conversationId);
    await setActiveConversation(conversationId);
  }

  async function handleDeleteConversation(conversationId: number) {
    try {
      await connections.disconnect(conversationId);
    } catch {
      // 会话可能本来就没建立 runtime，删除时忽略即可。
    }

    if (explicitConversationId === conversationId) {
      setExplicitConversationId(null);
    }
    await deleteConversation(conversationId);
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 flex">
      <ChatPane
        projectDir={projectDir}
        explicitActivated={explicitConversationId !== null}
        explicitConversationId={explicitConversationId}
        onSelectConversation={(conversationId) => {
          void handleSelectConversation(conversationId);
        }}
        onCreateConversation={handleCreatedConversation}
        onDeleteConversation={(conversationId) => {
          void handleDeleteConversation(conversationId);
        }}
        onOpenAgentSettings={onOpenAgentSettings}
      />
    </div>
  );
}

export function AgentSidebar({ onOpenAgentSettings }: AgentSidebarProps = {}) {
  const scriptProjectDir = useScriptStore((s) => s.projectDir);
  const [width, setWidth] = useState(420);
  const resizingRef = useRef(false);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      const startX = e.clientX;
      const startWidth = width;

      const onMove = (moveEvent: MouseEvent) => {
        if (!resizingRef.current) return;
        const delta = startX - moveEvent.clientX;
        setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + delta)));
      };
      const onUp = () => {
        resizingRef.current = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [width],
  );

  const projectDir = scriptProjectDir || getCurrentProjectDir();

  return (
    <m.aside
      className={styles.sidebar}
      style={{ width }}
      initial={{ x: width, opacity: 0 }}
      animate={{ x: 0, opacity: 1, transition: springs.smooth }}
      exit={{
        x: width,
        opacity: 0,
        transition: { duration: durations.base, ease: easings.easeOutExpo },
      }}
    >
      <div className={styles.resizeHandle} onMouseDown={handleResizeStart} />
      <div className={styles.content}>
        <AgentHeader />
        <AgentSidebarWorkspace
          projectDir={projectDir}
          onOpenAgentSettings={onOpenAgentSettings}
        />
      </div>
    </m.aside>
  );
}
