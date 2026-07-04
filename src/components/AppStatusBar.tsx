import { useMemo } from 'react';
import { Activity } from 'lucide-react';
import { useAgentStore } from '../store/agent';
import { useAgentFeedStore } from '../store/agent-feed';
import { useAiEditStore } from '../store/ai-edit';
import { useScriptStore } from '../store/script';
import { getOriginalStats, getGeneratedScriptStats, getAnnotationSummary } from '../lib/script-utils';
import { Button, Popover, PopoverContent, PopoverTrigger, Tooltip, TooltipContent, TooltipTrigger } from '../ui';
import styles from './AppStatusBar.module.css';
import { StatusBarProgressLine } from './StatusBarProgressLine';
import { StatusBarTaskSummary } from './StatusBarTaskSummary';
import { TaskProgressPanel } from './TaskProgressPanel';
import { AgentObservationPanel } from './AgentObservationPanel';

// ─── 圆形进度图标常量 ──────────────────────────────────────
const ICON_RADIUS = 6;
const ICON_CENTER = 8;
const ICON_VIEWBOX = 16;
const ICON_CIRCUMFERENCE = 2 * Math.PI * ICON_RADIUS;

function formatPercent(percent: number | null): string {
  if (percent == null) return '--';
  return `${percent.toFixed(1)}%`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

// ─── 连接状态标签 ───────────────────────────────────────────
const STATUS_LABELS: Record<string, string> = {
  disconnected: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  prompting: '思考中…',
  error: '连接错误',
};

// ─── 上下文窗口弹出面板 ──────────────────────────────────────
function ContextPopover({
  used,
  size,
  percent,
}: {
  used: number;
  size: number;
  percent: number;
}) {
  return (
    <div className={styles.popover}>
      <div className={styles.popoverTitle}>上下文窗口</div>
      <div className={styles.popoverRow}>
        <span>使用率</span>
        <span>{formatPercent(percent)}</span>
      </div>
      <div className={styles.progressBar}>
        <div className={styles.progressFill} style={{ width: `${percent}%` }} />
      </div>
      <div className={styles.popoverRow}>
        <span>已用 / 总量</span>
        <span>
          {formatNumber(used)} / {formatNumber(size)}
        </span>
      </div>
    </div>
  );
}

// ─── 上下文窗口指示器 ───────────────────────────────────────
function ContextWindowIndicator() {
  const contextUsage = useAgentStore((s) => s.contextUsage);

  if (!contextUsage) return null;

  const { used, size } = contextUsage;
  if (size <= 0) return null;

  const percent = Math.max(0, Math.min(100, (used / size) * 100));
  const dashOffset = ICON_CIRCUMFERENCE * (1 - percent / 100);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button.Ghost size="xs" className={styles.contextUsage} aria-label="上下文窗口用量详情">
          <svg
            aria-hidden="true"
            width={14}
            height={14}
            viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
          >
            <circle
              cx={ICON_CENTER}
              cy={ICON_CENTER}
              r={ICON_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              opacity="0.25"
            />
            <circle
              cx={ICON_CENTER}
              cy={ICON_CENTER}
              r={ICON_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeDasharray={`${ICON_CIRCUMFERENCE} ${ICON_CIRCUMFERENCE}`}
              strokeDashoffset={dashOffset}
              style={{ transformOrigin: 'center', transform: 'rotate(-90deg)' }}
              opacity="0.75"
            />
          </svg>
          <span>{formatPercent(percent)}</span>
        </Button.Ghost>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className={`w-[220px] p-0 ${styles.popoverContent}`}>
        <ContextPopover used={used} size={size} percent={percent} />
      </PopoverContent>
    </Popover>
  );
}

// ─── AI 生成过程观测入口 ─────────────────────────────────────
function ObservationIndicator() {
  const hasSessions = useAgentFeedStore((s) => s.sessions.size > 0);
  const hasActive = useAgentFeedStore((s) => s.hasActive);
  const panelOpen = useAgentFeedStore((s) => s.panelOpen);
  const openPanel = useAgentFeedStore((s) => s.openPanel);
  const closePanel = useAgentFeedStore((s) => s.closePanel);

  if (!hasSessions) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button.Ghost
          size="xs"
          aria-label="AI 生成过程观测"
          onClick={() => (panelOpen ? closePanel() : openPanel())}
        >
          <Activity size={13} className={hasActive ? 'animate-pulse' : undefined} />
        </Button.Ghost>
      </TooltipTrigger>
      <TooltipContent side="top" align="end">
        {hasActive ? 'AI 生成进行中 · 查看过程' : '查看 AI 生成过程记录'}
      </TooltipContent>
    </Tooltip>
  );
}

// ─── 连接状态指示器 ─────────────────────────────────────────
function ConnectionIndicator() {
  const status = useAgentStore((s) => s.status);
  const autoConnectError = useAgentStore((s) => s.autoConnectError);

  const displayStatus = autoConnectError && status === 'disconnected' ? 'error' : status;
  const label = STATUS_LABELS[displayStatus] || displayStatus;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={styles.connectionStatus}>
          <div className={styles.statusDot} data-status={displayStatus} />
          <span>{label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" align="end">
        {autoConnectError || label}
      </TooltipContent>
    </Tooltip>
  );
}

// ─── 写稿工作台统计 ────────────────────────────────────────
function WorkbenchStatsIndicator() {
  const mounted = useScriptStore((s) => s.workbenchMounted);
  const originalText = useScriptStore((s) => s.originalText);
  const scriptText = useScriptStore((s) => s.scriptText);
  const annotations = useScriptStore((s) => s.annotations);

  const summary = useMemo(() => {
    if (!mounted) return null;
    const parts: string[] = [];
    const orig = getOriginalStats(originalText);
    const script = getGeneratedScriptStats(scriptText);
    const annot = getAnnotationSummary(annotations);

    if (orig.charCount > 0) {
      parts.push(`原稿 ${orig.charCount.toLocaleString()} 字 · ${orig.paragraphs} 行`);
    }
    if (script.charCount > 0) {
      parts.push(`口播稿 ${script.charCount.toLocaleString()} 字 · 约 ${script.readMinutes} 分钟`);
    }
    if (annot.total > 0) {
      parts.push(`批注 ${annot.total} 条 · 待处理 ${annot.pending}`);
    }
    return parts.length > 0 ? parts.join('  |  ') : null;
  }, [mounted, originalText, scriptText, annotations]);

  if (!summary) return null;
  return <span>{summary}</span>;
}

// ─── 主组件 ────────────────────────────────────────────────
// ─── AI 编辑锁定指示 ─────────────────────────────────────────
function AiEditLockIndicator() {
  const locked = useAiEditStore((s) => s.locked);
  const scope = useAiEditStore((s) => s.scope);
  const reason = useAiEditStore((s) => s.reason);
  if (!locked) return null;
  const scopeLabel = scope === 'video' ? '视频' : scope === 'script' ? '脚本' : null;
  return (
    <span className={styles.aiEditLock}>
      <span className={styles.aiEditLockDot} />
      <span>AI 正在编辑此项目（已锁定{scopeLabel ? ` · ${scopeLabel}` : ''}{reason ? ` · ${reason}` : ''}）</span>
    </span>
  );
}

export function AppStatusBar() {
  return (
    <div className={styles.statusBar}>
      <StatusBarProgressLine />
      <TaskProgressPanel />
      <AgentObservationPanel />
      <div className={styles.left}>
        <AiEditLockIndicator />
        <WorkbenchStatsIndicator />
        <StatusBarTaskSummary />
      </div>
      <div className={styles.right}>
        <ObservationIndicator />
        <ContextWindowIndicator />
        <ConnectionIndicator />
      </div>
    </div>
  );
}
