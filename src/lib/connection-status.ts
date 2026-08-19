/**
 * 状态栏聚合连接状态：AI Agent / 灵机素材（KaCut）/ 灵机采风（Sonar 桥）。
 *
 * 这里只放纯派生逻辑，探测与渲染在 components/StatusBarConnections.tsx。
 */
import type { ConnectionStatus } from '../../electron/acp/types';
import type { KacutSettings } from '../types/ai';
import type { KacutLibraryDigest } from '../types/footage';
import { formatKacutEndpointForDisplay } from './kacut-endpoint';
import type { SonarBridgeInfo } from './electron-api';

export type ConnectionLevel = 'connected' | 'connecting' | 'idle' | 'error' | 'disabled';

export type ConnectionKey = 'agent' | 'kacut' | 'sonar';

export interface ConnectionEntry {
  key: ConnectionKey;
  label: string;
  level: ConnectionLevel;
  /** 一行状态说明，直接展示在弹窗里 */
  detail: string;
}

/** 采风插件无心跳，只能按"最近一次桥交互"判活；超过该窗口降级为"已配对"。 */
export const SONAR_ACTIVE_WINDOW_MS = 30 * 60 * 1000;

export type KacutProbe =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; digest: KacutLibraryDigest | null }
  | { status: 'failed' };

const AGENT_LEVEL: Record<ConnectionStatus, ConnectionLevel> = {
  disconnected: 'idle',
  connecting: 'connecting',
  connected: 'connected',
  prompting: 'connected',
  error: 'error',
};

const AGENT_DETAIL: Record<ConnectionStatus, string> = {
  disconnected: '未连接，AI 对话与自动化编辑不可用',
  connecting: '正在连接…',
  connected: '已连接，可直接对话与托管编辑',
  prompting: '已连接 · 正在思考',
  error: '连接错误',
};

export function deriveAgentConnection(
  status: ConnectionStatus,
  autoConnectError: string | null,
): ConnectionEntry {
  const failed = Boolean(autoConnectError) && status === 'disconnected';
  return {
    key: 'agent',
    label: 'AI Agent',
    level: failed ? 'error' : AGENT_LEVEL[status] ?? 'idle',
    detail: failed ? autoConnectError! : AGENT_DETAIL[status] ?? status,
  };
}

const KIND_LABEL: Record<string, string> = { video: '视频', image: '图片', gif: 'GIF', audio: '音频' };
const KIND_ORDER = ['video', 'image', 'gif', 'audio'];

/** 素材库摘要一行展示：`3 个库 · 1,234 条素材 · 视频 800`。 */
export function formatKacutDigest(digest: KacutLibraryDigest | null): string {
  if (!digest) return '已连接，素材库摘要获取失败（不影响检索）';
  const kinds = [...KIND_ORDER, ...Object.keys(digest.kindCounts).filter((k) => !KIND_ORDER.includes(k))]
    .filter((kind, index, all) => all.indexOf(kind) === index && (digest.kindCounts[kind] ?? 0) > 0)
    .map((kind) => `${KIND_LABEL[kind] ?? kind} ${(digest.kindCounts[kind] ?? 0).toLocaleString()}`);
  return [`${digest.libraryCount} 个库`, `${digest.itemCount.toLocaleString()} 条素材`, ...kinds].join(' · ');
}

export function deriveKacutConnection(
  settings: KacutSettings | null,
  probe: KacutProbe,
): ConnectionEntry {
  const base = { key: 'kacut' as const, label: '灵机素材' };
  if (!settings || !settings.enabled) {
    return { ...base, level: 'disabled', detail: '未启用素材联动，规划全部段落照常出卡' };
  }
  switch (probe.status) {
    case 'checking':
      return { ...base, level: 'connecting', detail: `正在检测 ${formatKacutEndpointForDisplay(settings.baseUrl)}…` };
    case 'ok':
      return { ...base, level: 'connected', detail: formatKacutDigest(probe.digest) };
    case 'failed':
      return { ...base, level: 'error', detail: '连不上，请打开灵机素材 App 并在其「MCP 设置」中启用本机服务' };
    default:
      return { ...base, level: 'idle', detail: '待检测' };
  }
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前。 */
export function formatRelativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const minute = 60_000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  return `${Math.floor(diff / (24 * 60 * minute))} 天前`;
}

export function deriveSonarConnection(info: SonarBridgeInfo | null, now: number): ConnectionEntry {
  const base = { key: 'sonar' as const, label: '灵机采风' };
  if (!info || !info.running) {
    return { ...base, level: 'error', detail: '本机联动桥未启动，重启灵机剪影后重试' };
  }
  const endpoint = `http://127.0.0.1:${info.port}`;
  if (!info.lastSeenAt) {
    return { ...base, level: 'idle', detail: `桥已就绪，等待采风插件连接 · ${endpoint}` };
  }
  const when = formatRelativeTime(info.lastSeenAt, now);
  if (now - info.lastSeenAt <= SONAR_ACTIVE_WINDOW_MS) {
    return { ...base, level: 'connected', detail: `插件已连接 · 最近活动 ${when}` };
  }
  return { ...base, level: 'idle', detail: `已配对但近期无活动 · 最近活动 ${when}` };
}

const LEVEL_WEIGHT: Record<ConnectionLevel, number> = {
  error: 4,
  connecting: 3,
  idle: 2,
  connected: 1,
  disabled: 0,
};

export interface ConnectionSummary {
  /** 图标状态点取值（最严重的一项，disabled 不参与） */
  level: ConnectionLevel;
  /** 状态栏一行文案 */
  text: string;
}

/** 汇总：只统计启用中的项；全部连上说"连接正常"，否则报未连接 / 异常数量。 */
export function summarizeConnections(entries: ConnectionEntry[]): ConnectionSummary {
  const countable = entries.filter((e) => e.level !== 'disabled');
  if (countable.length === 0) return { level: 'disabled', text: '未启用连接' };

  const level = countable.reduce<ConnectionLevel>(
    (worst, e) => (LEVEL_WEIGHT[e.level] > LEVEL_WEIGHT[worst] ? e.level : worst),
    'connected',
  );
  const connected = countable.filter((e) => e.level === 'connected').length;
  if (connected === countable.length) return { level: 'connected', text: '连接正常' };

  const errors = countable.filter((e) => e.level === 'error').length;
  if (errors > 0) return { level, text: `${errors} 项连接异常` };
  return { level, text: `${connected}/${countable.length} 已连接` };
}
