/**
 * 待创作箱（设计文档第 6 节）。
 *
 * 列出声呐扩展经本地桥推入的二创素材（转录稿 + 元数据）。
 * 「生成初稿」复用现有 autoMode 流水线：上层把转录稿写成 original.md 后起飞 AI 二创写稿。
 * 桥配置区展示本机端点 + token，供用户复制进扩展设置。
 *
 * 布局：欢迎页里作为左侧固定宽栏（右侧为本地草稿），可收起为细窄竖条。
 * 收件靠桥实时推送（onSonarInboxUpdated），故无手动刷新按钮。
 */
import { memo, useCallback, useEffect, useState } from 'react';
import {
  Inbox,
  Trash2,
  Sparkles,
  Copy,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
} from 'lucide-react';
import { Alert, Button, ConfirmDialog } from '../../ui';
import {
  canDraftInboxItem,
  type SonarInboxItem,
} from '../../lib/sonar-inbox';
import styles from './SonarInboxPanel.module.css';

interface SonarInboxPanelProps {
  /** 生成初稿：上报需要创作的收件项，由上层打开预填的「导入文稿」弹窗选目录/模型。 */
  onRequestDraft: (item: SonarInboxItem) => void;
}

const COLLAPSE_KEY = 'sonar-inbox-collapsed';
const SONAR_EXTENSION_VERSION = '0.1.0';
const SONAR_EXTENSION_DOWNLOAD_URL =
  'https://yoqu.github.io/lingji-cut-homepage/downloads/lingji-caifeng-chrome-extension-v0.1.0.zip';

const STATUS_LABEL: Record<SonarInboxItem['status'], string> = {
  pending: '待创作',
  creating: '生成中',
  drafted: '已生成',
  failed: '失败',
};

interface InboxRowProps {
  item: SonarInboxItem;
  onDraft: (item: SonarInboxItem) => void;
  onRemove: (item: SonarInboxItem) => void;
}

/**
 * 单条收件项（网格卡片）。memo + content-visibility（见 CSS）一起把长列表的渲染/排版成本降到只算可视区。
 * 封面用 loading="lazy"，滚动到才解码，避免几十张抖音 CDN 大图一次性占满主线程。
 */
/** 视频发布时间 → 短格式：当年省略年份（07-05 12:53），跨年带年份。 */
function formatPublishedAt(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

const InboxRow = memo(function InboxRow({ item, onDraft, onRemove }: InboxRowProps) {
  return (
    <li className={styles.item}>
      {item.coverUrl ? (
        <img
          src={item.coverUrl}
          alt=""
          className={styles.cover}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div className={styles.coverPlaceholder} />
      )}
      <div className={styles.itemMeta}>
        <span className={styles.creator}>{item.creatorName}</span>
        <span className={styles.publishedAt}>{formatPublishedAt(item.publishedAt)}</span>
        <span className={`${styles.badge} ${styles[`badge_${item.status}`]}`}>
          {STATUS_LABEL[item.status]}
        </span>
      </div>
      <div className={styles.itemTitle}>{item.title}</div>
      {item.insight ? (
        <div className={styles.insight} title={item.insight.hook}>
          <Sparkles size={11} />
          <span>{item.insight.angle}</span>
        </div>
      ) : null}
      <div className={styles.transcript}>{item.transcript.fullText.slice(0, 90)}</div>
      <div className={styles.itemActions}>
        <Button
          size="sm"
          className={styles.draftBtn}
          onClick={() => onDraft(item)}
          disabled={!canDraftInboxItem(item) || item.status === 'creating'}
        >
          <Sparkles size={14} />
          生成初稿
        </Button>
        <button className={styles.iconBtn} onClick={() => onRemove(item)} title="移除">
          <Trash2 size={14} />
        </button>
      </div>
    </li>
  );
});

export function SonarInboxPanel({ onRequestDraft }: SonarInboxPanelProps) {
  const [items, setItems] = useState<SonarInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [bridge, setBridge] = useState<{ port: number; token: string } | null>(null);
  const [showBridge, setShowBridge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [downloadUrlCopied, setDownloadUrlCopied] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;

  const refresh = useCallback(async () => {
    if (!api?.sonarInboxList) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await api.sonarInboxList();
      setItems(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取待创作箱失败');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    if (api?.sonarBridgeInfo) {
      void api.sonarBridgeInfo().then(setBridge).catch(() => {});
    }
    // 扩展推送到桥后，主进程派发 sonar-inbox-updated → 实时刷新，无需手动刷新。
    const off = api?.onSonarInboxUpdated?.(() => void refresh());
    return () => off?.();
  }, [refresh, api]);

  const toggleCollapse = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* 忽略存储不可用 */
      }
      return next;
    });
  }, []);

  const handleDraft = useCallback(
    (item: SonarInboxItem) => {
      setError(null);
      onRequestDraft(item);
    },
    [onRequestDraft],
  );

  const handleRemove = useCallback(
    async (item: SonarInboxItem) => {
      await api?.sonarInboxRemove?.(item.id).catch(() => {});
      void refresh();
    },
    [api, refresh],
  );

  const handleClearAll = useCallback(async () => {
    await api?.sonarInboxClear?.().catch(() => {});
    void refresh();
  }, [api, refresh]);

  const copyToken = useCallback(() => {
    if (!bridge) return;
    void navigator.clipboard?.writeText(bridge.token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [bridge]);

  const openExtensionDownload = useCallback(() => {
    if (api?.openExternal) {
      api.openExternal(SONAR_EXTENSION_DOWNLOAD_URL);
      return;
    }
    window.open(SONAR_EXTENSION_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');
  }, [api]);

  const copyExtensionDownloadUrl = useCallback(() => {
    void navigator.clipboard?.writeText(SONAR_EXTENSION_DOWNLOAD_URL).then(() => {
      setDownloadUrlCopied(true);
      setTimeout(() => setDownloadUrlCopied(false), 1500);
    });
  }, []);

  // 桌面端 IPC 不可用（如纯 web）或为空且无桥信息：不渲染。
  if (!api?.sonarInboxList) return null;
  if (!loading && items.length === 0 && !bridge) return null;

  const count = items.length;

  // 收起态：细窄竖条（图标 + 数量 + 展开箭头 + 竖排标题），整条可点展开。
  if (collapsed) {
    return (
      <section className={`${styles.panel} ${styles.collapsed}`}>
        <button className={styles.rail} onClick={toggleCollapse} title="展开待创作箱">
          <Inbox size={18} />
          {count > 0 ? <span className={styles.railCount}>{count}</span> : null}
          <ChevronsRight size={16} className={styles.railChevron} />
          <span className={styles.railLabel}>待创作箱</span>
        </button>
      </section>
    );
  }

  return (
    <section className={styles.panel}>
      <header className={styles.header}>
        <div className={styles.title}>
          <Inbox size={16} />
          <span>待创作箱</span>
          {count > 0 ? <span className={styles.countBadge}>{count}</span> : null}
        </div>
        <div className={styles.headerActions}>
          {bridge ? (
            <button className={styles.linkBtn} onClick={() => setShowBridge((v) => !v)}>
              {showBridge ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              桥配置
            </button>
          ) : null}
          {count > 0 ? (
            <button
              className={styles.linkBtn}
              onClick={() => setConfirmClear(true)}
              title="清空全部"
            >
              <Trash2 size={14} />
              清空
            </button>
          ) : null}
          <button className={styles.iconBtn} onClick={toggleCollapse} title="收起">
            <ChevronsLeft size={16} />
          </button>
        </div>
      </header>
      <p className={styles.subtitle}>来自声呐监听的二创素材</p>

      <div className={styles.extensionBox}>
        <div className={styles.extensionInfo}>
          <span className={styles.extensionTitle}>灵机采风插件 v{SONAR_EXTENSION_VERSION}</span>
          <code className={styles.extensionUrl}>{SONAR_EXTENSION_DOWNLOAD_URL}</code>
        </div>
        <div className={styles.extensionActions}>
          <button className={styles.downloadBtn} onClick={openExtensionDownload}>
            <Download size={13} />
            下载
          </button>
          <button className={styles.iconBtn} onClick={copyExtensionDownloadUrl} title="复制下载地址">
            <Copy size={13} className={downloadUrlCopied ? styles.copiedIcon : undefined} />
          </button>
        </div>
      </div>

      {showBridge && bridge ? (
        <div className={styles.bridgeBox}>
          <div className={styles.bridgeRow}>
            <span className={styles.bridgeLabel}>端点</span>
            <code className={styles.bridgeValue}>http://127.0.0.1:{bridge.port}</code>
          </div>
          <div className={styles.bridgeRow}>
            <span className={styles.bridgeLabel}>Token</span>
            <code className={styles.bridgeValue}>{bridge.token}</code>
            <button className={styles.iconBtn} onClick={copyToken} title="复制 token">
              <Copy size={13} />
            </button>
            {copied ? <span className={styles.copied}>已复制</span> : null}
          </div>
          <p className={styles.bridgeHint}>
            ① 下载 ZIP 并解压。② 打开 Chrome → 扩展程序 → 开发者模式 → 加载已解压的扩展程序。
            ③ 在扩展「设置 → 灵机剪影联动」点「一键连接灵机剪影」即可。
          </p>
        </div>
      ) : null}

      {error ? <Alert variant="error">{error}</Alert> : null}

      {!loading && count === 0 ? (
        <div className={styles.empty}>暂无素材，等待声呐推送…</div>
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <InboxRow key={item.id} item={item} onDraft={handleDraft} onRemove={handleRemove} />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="清空待创作箱"
        description={`将删除全部 ${count} 条素材，且不可恢复。确定继续？`}
        confirmText="清空"
        confirmVariant="destructive"
        onConfirm={handleClearAll}
      />
    </section>
  );
}
