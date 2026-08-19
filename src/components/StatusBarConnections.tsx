/**
 * 状态栏右下角聚合连接指示：AI Agent / 灵机素材（KaCut）/ 灵机采风（本机联动桥）。
 * 点击 icon 弹出各连接的具体情况与修复入口，保证创作链路畅通。
 *
 * 探测策略：挂载即测一次，之后 60s 轮询，弹窗打开时立即刷新（用户就是来看实时结果的）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Copy, LibraryBig, Plug, Radar, RefreshCw, Settings2 } from 'lucide-react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '../ui';
import { useAgentStore } from '../store/agent';
import { loadAISettings } from '../store/ai';
import { normalizeKacutSettings, type KacutSettings } from '../types/ai';
import type { SonarBridgeInfo } from '../lib/electron-api';
import type { SettingsTab } from '../pages/Settings';
import {
  deriveAgentConnection,
  deriveKacutConnection,
  deriveSonarConnection,
  summarizeConnections,
  type ConnectionEntry,
  type ConnectionKey,
  type KacutProbe,
} from '../lib/connection-status';
import styles from './StatusBarConnections.module.css';

const REFRESH_INTERVAL_MS = 60_000;

const ENTRY_ICON: Record<ConnectionKey, typeof Bot> = {
  agent: Bot,
  kacut: LibraryBig,
  sonar: Radar,
};

interface StatusBarConnectionsProps {
  /** 打开设置页并定位到指定 tab（未提供时隐藏跳转入口）。 */
  onOpenSettings?: (tab: SettingsTab) => void;
}

export function StatusBarConnections({ onOpenSettings }: StatusBarConnectionsProps) {
  const agentStatus = useAgentStore((s) => s.status);
  const autoConnectError = useAgentStore((s) => s.autoConnectError);

  const [open, setOpen] = useState(false);
  const [kacutSettings, setKacutSettings] = useState<KacutSettings | null>(null);
  const [kacutProbe, setKacutProbe] = useState<KacutProbe>({ status: 'idle' });
  const [sonar, setSonar] = useState<SonarBridgeInfo | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    setNow(Date.now());

    void api
      .sonarBridgeInfo()
      .then(setSonar)
      .catch(() => setSonar(null));

    const settings = normalizeKacutSettings((await loadAISettings().catch(() => null))?.kacut);
    setKacutSettings(settings);
    if (!settings.enabled) {
      setKacutProbe({ status: 'idle' });
      return;
    }
    setKacutProbe({ status: 'checking' });
    const ok = await api.kacutHealth(settings.baseUrl).catch(() => false);
    if (!ok) {
      setKacutProbe({ status: 'failed' });
      return;
    }
    // 摘要失败不影响"已连接"结论
    const digest = await api.kacutLibraryDigest(settings.baseUrl).catch(() => null);
    setKacutProbe({ status: 'ok', digest });
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      setCopied(false);
      if (next) void refresh();
    },
    [refresh],
  );

  const entries = useMemo<ConnectionEntry[]>(
    () => [
      deriveAgentConnection(agentStatus, autoConnectError),
      deriveKacutConnection(kacutSettings, kacutProbe),
      deriveSonarConnection(sonar, now),
    ],
    [agentStatus, autoConnectError, kacutSettings, kacutProbe, sonar, now],
  );

  const summary = useMemo(() => summarizeConnections(entries), [entries]);

  const copyBridgeInfo = useCallback(async () => {
    if (!sonar) return;
    const text = `端点 http://127.0.0.1:${sonar.port}\nToken ${sonar.token}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [sonar]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" className={styles.trigger} aria-label="连接状态详情">
          <Plug size={12} className={styles.triggerIcon} />
          <span className={styles.dot} data-level={summary.level} />
          <span>{summary.text}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className={`w-[320px] p-0 ${styles.content}`}>
        <div className={styles.panel}>
          <div className={styles.header}>
            <span className={styles.title}>连接状态</span>
            <Button.Ghost
              size="xs"
              aria-label="重新检测全部连接"
              onClick={() => void refresh()}
            >
              <RefreshCw size={12} className={kacutProbe.status === 'checking' ? styles.spinning : undefined} />
            </Button.Ghost>
          </div>
          <ul className={styles.list}>
            {entries.map((entry) => {
              const Icon = ENTRY_ICON[entry.key];
              return (
                <li key={entry.key} className={styles.row}>
                  <Icon size={14} className={styles.rowIcon} />
                  <div className={styles.rowBody}>
                    <div className={styles.rowHead}>
                      <span className={styles.dot} data-level={entry.level} />
                      <span className={styles.rowLabel}>{entry.label}</span>
                    </div>
                    <div className={styles.rowDetail}>{entry.detail}</div>
                  </div>
                  <div className={styles.rowActions}>
                    {entry.key === 'sonar' ? (
                      <Button.Ghost size="xs" aria-label="复制采风桥连接信息" onClick={() => void copyBridgeInfo()}>
                        <Copy size={12} />
                        <span>{copied ? '已复制' : '复制'}</span>
                      </Button.Ghost>
                    ) : onOpenSettings ? (
                      <Button.Ghost
                        size="xs"
                        aria-label={`打开${entry.label}设置`}
                        onClick={() => {
                          setOpen(false);
                          onOpenSettings(entry.key === 'agent' ? 'agent' : 'kacut-connect');
                        }}
                      >
                        <Settings2 size={12} />
                        <span>设置</span>
                      </Button.Ghost>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}
