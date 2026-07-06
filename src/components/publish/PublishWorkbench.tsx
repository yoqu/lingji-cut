import { useEffect, useRef, useState } from 'react';
import { Upload, Film, Image as ImageIcon, Tag, Check, X, Loader2, ChevronDown, ChevronRight, Sparkles, History, RotateCcw, LogIn } from 'lucide-react';
import { Button, Checkbox, ConfirmDialog, Field, Input, Select } from '../../ui';
import {
  BILIBILI_PARTITIONS,
  findPartition,
} from '../../lib/publish/bilibili-partitions';
import { CHROMIUM_PLATFORMS } from '../../lib/publish/chromium-platforms';
import { DependencyDownloadNotice } from './DependencyDownloadCard';
import { Spinner } from '../../ui/primitives/Spinner';
import { usePublishStore, type PublishResult } from '../../store/publish';
import { loadAISettings, useAIStore } from '../../store/ai';
import { useTimelineStore } from '../../store/timeline';
import type { PublishAccount, PublishShared, PublishTarget } from '../../lib/electron-api';
import {
  extractPublishSection,
  PUBLISH_HISTORY_MAX,
  type ProjectData,
  type ProjectPublishMeta,
  type PublishHistoryEntry,
  type PublishHistoryResult,
  type PublishHistoryTarget,
} from '../../lib/project-persistence';
import { buildMetadataSource } from '../../lib/publish-metadata';
import { PublishCoverPanel } from './PublishCoverPanel';
import { autoFillCovers, useCoverStudio } from './useCoverStudio';
import { isInsideDir } from '../../lib/publish/resolve-video-file';

/** 渲染层 basename：避免引入 node:path。 */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** 相对时间展示（与 PublishAccountsTab 同口径）。 */
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PLATFORM_LABEL: Record<string, string> = {
  douyin: '抖音',
  tencent: '视频号',
  xiaohongshu: '小红书',
  kuaishou: '快手',
  bilibili: 'B站',
};

function AccountStatusBadge({ status }: { status: PublishAccount['status'] }) {
  const config = {
    valid: { label: '已登录', color: 'var(--color-success, #22c55e)' },
    expired: { label: '已过期', color: 'var(--color-warning, #f59e0b)' },
    unknown: { label: '未知', color: 'var(--color-text-tertiary, #888)' },
  }[status];
  return (
    <span
      style={{
        fontSize: 11,
        padding: '2px 6px',
        borderRadius: 4,
        background: `color-mix(in srgb, ${config.color} 15%, transparent)`,
        color: config.color,
        fontWeight: 500,
      }}
    >
      {config.label}
    </span>
  );
}

function ResultRow({
  accountId,
  state,
  percent,
  message,
}: {
  accountId: string;
  state: string;
  percent?: number;
  message?: string;
}) {
  const icon =
    state === 'success' ? (
      <Check size={14} style={{ color: 'var(--color-success, #22c55e)' }} />
    ) : state === 'failed' ? (
      <X size={14} style={{ color: 'var(--color-error, #ef4444)' }} />
    ) : state === 'login-expired' ? (
      <LogIn size={14} style={{ color: 'var(--color-warning, #f59e0b)' }} />
    ) : state === 'running' ? (
      <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-system-blue)' }} />
    ) : null;

  const pctStr = percent != null ? ` ${percent}%` : '';
  const barWidth = percent != null ? `${Math.max(0, Math.min(100, percent))}%` : '0%';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 0',
        fontSize: 13,
        borderBottom: '1px solid var(--color-border-subtle, rgba(0,0,0,0.06))',
      }}
    >
      <span style={{ minWidth: 16 }}>{icon}</span>
      <span style={{ flex: 1, color: 'var(--color-text-primary)' }}>
        {PLATFORM_LABEL[accountId.split('_')[0]] ?? accountId.split('_')[0]}{' '}
        <span style={{ color: 'var(--color-text-secondary)' }}>
          {accountId.split('_').slice(1).join('_')}
        </span>
      </span>
      {state === 'running' && percent != null && (
        <div
          style={{
            width: 80,
            height: 4,
            background: 'var(--color-border-subtle, rgba(0,0,0,0.1))',
            borderRadius: 2,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: barWidth,
              height: '100%',
              background: 'var(--color-system-blue)',
              borderRadius: 2,
              transition: 'width 0.3s ease',
            }}
          />
        </div>
      )}
      <span
        style={{
          fontSize: 12,
          color:
            state === 'success'
              ? 'var(--color-success, #22c55e)'
              : state === 'failed'
                ? 'var(--color-error, #ef4444)'
                : state === 'login-expired'
                  ? 'var(--color-warning, #f59e0b)'
                  : 'var(--color-text-secondary)',
          minWidth: 60,
          textAlign: 'right',
        }}
      >
        {state === 'success'
          ? '成功'
          : state === 'failed'
            ? message ?? '失败'
            : state === 'login-expired'
              ? '登录已过期'
              : state === 'running'
                ? `上传中${pctStr}`
                : '等待中'}
      </span>
    </div>
  );
}

const OVERALL_CONFIG: Record<
  PublishHistoryEntry['overallState'],
  { label: string; color: string }
> = {
  success: { label: '全部成功', color: 'var(--color-success, #22c55e)' },
  partial: { label: '部分成功', color: 'var(--color-warning, #f59e0b)' },
  failed: { label: '全部失败', color: 'var(--color-error, #ef4444)' },
};

/** 一条发布历史记录：可展开查看各账号结果，失败账号支持就地重登。 */
function HistoryEntryCard({
  entry,
  disabled,
  reloginBusyId,
  onRepublish,
  onRelogin,
}: {
  entry: PublishHistoryEntry;
  disabled: boolean;
  reloginBusyId: string | null;
  onRepublish: (entry: PublishHistoryEntry) => void;
  onRelogin: (target: PublishHistoryTarget) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const overall = OVERALL_CONFIG[entry.overallState];
  return (
    <div
      style={{
        border: '1px solid var(--color-border-subtle, rgba(0,0,0,0.08))',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          background: 'var(--color-bg-elevated)',
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flex: 1,
            minWidth: 0,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            textAlign: 'left',
          }}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span
            style={{
              fontSize: 13,
              color: 'var(--color-text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {entry.fileName}
          </span>
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
            {formatRelativeTime(entry.publishedAt)} · {entry.targets.length} 个账号
          </span>
        </button>
        <span
          style={{
            fontSize: 11,
            padding: '2px 6px',
            borderRadius: 4,
            background: `color-mix(in srgb, ${overall.color} 15%, transparent)`,
            color: overall.color,
            fontWeight: 500,
            flexShrink: 0,
          }}
        >
          {overall.label}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onRepublish(entry)}
          disabled={disabled}
          style={{ flexShrink: 0 }}
        >
          <RotateCcw size={12} style={{ marginRight: 4 }} />
          重新发布
        </Button>
      </div>
      {expanded && (
        <div style={{ padding: '4px 12px 8px' }}>
          {entry.targets.map((t) => {
            const result = entry.results[t.accountId];
            const failed = result?.state === 'failed';
            const isRelogging = reloginBusyId === t.accountId;
            return (
              <div
                key={t.accountId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 0',
                  fontSize: 13,
                  borderBottom: '1px solid var(--color-border-subtle, rgba(0,0,0,0.06))',
                }}
              >
                <span style={{ minWidth: 16 }}>
                  {failed ? (
                    <X size={14} style={{ color: 'var(--color-error, #ef4444)' }} />
                  ) : (
                    <Check size={14} style={{ color: 'var(--color-success, #22c55e)' }} />
                  )}
                </span>
                <span style={{ flex: 1, minWidth: 0, color: 'var(--color-text-primary)' }}>
                  {PLATFORM_LABEL[t.platform] ?? t.platform}{' '}
                  <span style={{ color: 'var(--color-text-secondary)' }}>{t.accountName}</span>
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: failed ? 'var(--color-error, #ef4444)' : 'var(--color-success, #22c55e)',
                    textAlign: 'right',
                    maxWidth: 200,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={failed ? result?.message : undefined}
                >
                  {failed ? result?.message ?? '失败' : '成功'}
                </span>
                {failed && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onRelogin(t)}
                    disabled={disabled || isRelogging}
                    style={{ flexShrink: 0 }}
                  >
                    {isRelogging ? (
                      <Spinner size={11} />
                    ) : (
                      <LogIn size={12} style={{ marginRight: 4 }} />
                    )}
                    <span style={{ marginLeft: isRelogging ? 4 : 0 }}>重新登录</span>
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function PublishWorkbench({ projectDir }: { projectDir: string | null }) {
  const { accounts, job, results, loadAccounts, startPublish, cancelPublish, addAccount, loadSettings } =
    usePublishStore();
  const settings = usePublishStore((s) => s.settings);
  const lastExportPath = usePublishStore((s) => s.lastExportPath);

  // Form state
  const [filePath, setFilePath] = useState('');
  const [thumbnail, setThumbnail] = useState('');
  // 多比例封面：每个比例各选一张（视频号 4:3+3:4，抖音 3:4+16:9）
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  // B站分区 ID（tid，全平台共享，仅 B站使用）— 经分区选择器写入，仍存为字符串
  const [bilibiliTid, setBilibiliTid] = useState('');
  // 级联选择器的主分区态（由 bilibiliTid 反查同步，picker 切换时维护）
  const [bilibiliParentId, setBilibiliParentId] = useState<number | null>(null);
  // AI 智能推荐分区
  const [isRecommendingPartition, setIsRecommendingPartition] = useState(false);
  const [partitionError, setPartitionError] = useState<string | null>(null);

  // AI 文案生成
  const [isGeneratingMeta, setIsGeneratingMeta] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  // 封面联动面板展开
  const [showCoverPanel, setShowCoverPanel] = useState(true);
  // 文案/封面回填完成标记（状态版，驱动封面自动预填 effect）
  const [hydrated, setHydrated] = useState(false);
  // 封面工作台（父级持有，单一数据源）：扫描 covers/ + AI 候选，按比例分组
  const coverStudio = useCoverStudio(projectDir);

  // Multi-select: set of checked account IDs
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Chromium 自动化组件安装状态：null=未知/检测中
  const [chromiumInstalled, setChromiumInstalled] = useState<boolean | null>(null);

  // 发布历史（随项目持久化，新→旧）
  const [historyEntries, setHistoryEntries] = useState<PublishHistoryEntry[]>([]);
  // 就地重登：二维码 / 进行中账号 / 提示
  const [qrcodePng, setQrcodePng] = useState<string | null>(null);
  const [reloginBusyId, setReloginBusyId] = useState<string | null>(null);
  const [reloginMsg, setReloginMsg] = useState<{ text: string; isError: boolean } | null>(null);
  const unsubQrcodeRef = useRef<(() => void) | null>(null);
  // 发布中检测到登录态失效 → 弹窗确认重登（promise 桥，等待用户决策）
  const [loginPrompt, setLoginPrompt] = useState<PublishHistoryTarget | null>(null);
  const loginPromptResolveRef = useRef<((ok: boolean) => void) | null>(null);

  const askRelogin = (target: PublishHistoryTarget): Promise<boolean> =>
    new Promise((resolve) => {
      loginPromptResolveRef.current = resolve;
      setLoginPrompt(target);
    });

  // 关闭弹窗并回传用户决策（幂等：confirm / cancel / 蒙层关闭只兑现一次）
  const resolveLoginPrompt = (ok: boolean) => {
    const resolve = loginPromptResolveRef.current;
    loginPromptResolveRef.current = null;
    setLoginPrompt(null);
    resolve?.(ok);
  };

  // Derive publishing state from store job — no local state needed
  const isPublishing = !!job;

  // 选中的账号是否包含需要 Chromium 的平台
  const needsChromium = selectedAccountIds.some((id) => {
    const p = accounts.find((a) => a.id === id)?.platform;
    return p != null && CHROMIUM_PLATFORMS.has(p);
  });
  const chromiumMissing = needsChromium && chromiumInstalled === false;

  // 文案持久化：hydrate 完成前禁止 autosave，避免用空值覆盖磁盘上的已存文案
  const hydratedRef = useRef(false);

  useEffect(() => {
    void loadAccounts();
    void loadSettings();
    return () => {
      unsubQrcodeRef.current?.();
      unsubQrcodeRef.current = null;
    };
  }, [loadAccounts, loadSettings]);

  // 勾选需要 Chromium 的平台时检测组件是否已安装（发布前门控）
  useEffect(() => {
    if (!needsChromium) {
      setChromiumInstalled(null);
      return;
    }
    let cancelled = false;
    setChromiumInstalled(null);
    window.publishAPI
      .getChromiumStatus()
      .then((s) => {
        if (!cancelled) setChromiumInstalled(s.installed);
      })
      .catch(() => {
        if (!cancelled) setChromiumInstalled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [needsChromium]);

  // ── 联动编辑器：同会话刚导出且属于当前项目时，立即反映到视频文件输入 ──
  // lastExportPath 为全局态、跨项目不清空，必须按当前 projectDir 过滤，避免串用上一个项目的成片。
  useEffect(() => {
    if (lastExportPath && projectDir && isInsideDir(lastExportPath, projectDir)) {
      setFilePath((prev) => prev || lastExportPath);
    }
  }, [lastExportPath, projectDir]);

  // ── 切换项目：重置并从「当前项目目录」解析视频文件（避免沿用上一个项目的路径） ──
  useEffect(() => {
    if (!projectDir) {
      setFilePath('');
      return;
    }
    let cancelled = false;
    void (async () => {
      // 视频文件：仅当 lastExportPath 属于当前项目才直接用；否则扫描本项目目录最新成片。
      const last = usePublishStore.getState().lastExportPath;
      let resolved = last && isInsideDir(last, projectDir) ? last : null;
      if (!resolved) {
        resolved = await window.electronAPI.findLatestExport(projectDir).catch(() => null);
      }
      // 切项目即重置（resolved 为空则清空输入），不再 `prev ||` 保留旧项目路径。
      if (!cancelled) setFilePath(resolved ?? '');
      // 封面：默认取编辑器选定的封面候选
      const selectedCover = useAIStore
        .getState()
        .coverCandidates.find((c) => c.selected && c.imageUrl);
      if (selectedCover && !cancelled) {
        setThumbnail((prev) => prev || selectedCover.imageUrl);
        // 编辑器选定封面为 16:9 整期封面 → 预填 16:9 槽
        setCovers((prev) => (prev['16:9'] ? prev : { ...prev, '16:9': selectedCover.imageUrl }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  // ── 文案持久化：项目切换时从 project.json 回填已存的标题/描述/标签/封面/覆盖 ──
  useEffect(() => {
    hydratedRef.current = false;
    setHydrated(false);
    setHistoryEntries([]);
    if (!projectDir) {
      hydratedRef.current = true;
      setHydrated(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      let saved: ProjectPublishMeta | null = null;
      try {
        const raw = await window.electronAPI.loadProject(projectDir);
        saved = extractPublishSection(JSON.parse(raw) as ProjectData);
      } catch {
        saved = null;
      }
      if (cancelled) return;
      if (saved) {
        // 已存文案优先于派生预填（派生预填仍用 prev|| 兜底空值）
        if (saved.title) setTitle((prev) => prev || saved!.title);
        if (saved.desc) setDesc((prev) => prev || saved!.desc);
        if (saved.tagsInput) setTagsInput((prev) => prev || saved!.tagsInput);
        if (saved.thumbnail) setThumbnail((prev) => prev || saved!.thumbnail);
        if (saved.covers && Object.keys(saved.covers).length) {
          setCovers((prev) => ({ ...saved!.covers, ...prev }));
        }
        if (saved.bilibiliTid) setBilibiliTid((prev) => prev || saved!.bilibiliTid!);
        if (saved.history?.length) setHistoryEntries(saved.history);
      }
      hydratedRef.current = true;
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  // ── 封面按比例自动预填：扫描/生成出的 4:3 / 3:4 等比例图自动选中，无需手动点选。 ──
  //    仅填补空槽（已选或已回填的比例保持不变），并在 hydration 完成后才运行，避免覆盖已存选择。
  useEffect(() => {
    if (!hydrated) return;
    setCovers((prev) => autoFillCovers(coverStudio.groups, prev));
  }, [hydrated, coverStudio.groups]);

  // ── 文案持久化：标题/描述/标签/封面/覆盖变更时防抖写回 project.json ──
  useEffect(() => {
    if (!projectDir || !hydratedRef.current) return;
    const meta: ProjectPublishMeta = {
      title,
      desc,
      tagsInput,
      thumbnail,
      covers,
      bilibiliTid,
      history: historyEntries,
    };
    const timer = setTimeout(() => {
      window.electronAPI
        .saveProjectSection(projectDir, 'publish', JSON.stringify(meta))
        .catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [projectDir, title, desc, tagsInput, thumbnail, covers, bilibiliTid, historyEntries]);

  const handleGenerateMeta = async () => {
    setMetaError(null);
    const settings = await loadAISettings();
    if (!settings) {
      setMetaError('请先在「设置 → AI」完成大模型配置');
      return;
    }
    const analysis = useAIStore.getState().analysisResult;
    const srtText = useTimelineStore
      .getState()
      .srtEntries.map((e) => e.text)
      .join(' ');
    const sourceText = buildMetadataSource(analysis, srtText);
    if (!sourceText.trim()) {
      setMetaError('暂无内容可供生成，请先完成 AI 分析或导入字幕');
      return;
    }
    setIsGeneratingMeta(true);
    try {
      const projectBindings = projectDir
        ? await window.electronAPI.readPromptBindings('project', projectDir).catch(() => null)
        : null;
      const md = await window.electronAPI.generatePublishMetadata({
        settings,
        sourceText,
        currentTitle: title.trim() || undefined,
        projectDir: projectDir || undefined,
        projectBindings,
      });
      if (md.title) setTitle(md.title);
      if (md.desc) setDesc(md.desc);
      if (md.tags.length) setTagsInput(md.tags.join(', '));
    } catch (e) {
      setMetaError(e instanceof Error ? e.message : 'AI 文案生成失败');
    } finally {
      setIsGeneratingMeta(false);
    }
  };

  // bilibiliTid 变化（hydrate / AI 推荐 / 手选）时，反查并同步主分区态
  useEffect(() => {
    const n = parseInt(bilibiliTid, 10);
    const found = Number.isInteger(n) ? findPartition(n) : null;
    if (found) setBilibiliParentId(found.parent.id);
  }, [bilibiliTid]);

  const handleRecommendPartition = async () => {
    setPartitionError(null);
    const settings = await loadAISettings();
    if (!settings) {
      setPartitionError('请先在「设置 → AI」完成大模型配置');
      return;
    }
    // 标题 / 描述均空时，回退用 AI 分析摘要 / 字幕作为依据
    let fallbackSource: string | undefined;
    if (!title.trim() && !desc.trim()) {
      const analysis = useAIStore.getState().analysisResult;
      const srtText = useTimelineStore
        .getState()
        .srtEntries.map((e) => e.text)
        .join(' ');
      fallbackSource = buildMetadataSource(analysis, srtText);
      if (!fallbackSource.trim()) {
        setPartitionError('请先填写或生成标题 / 描述');
        return;
      }
    }
    setIsRecommendingPartition(true);
    try {
      const projectBindings = projectDir
        ? await window.electronAPI.readPromptBindings('project', projectDir).catch(() => null)
        : null;
      const { tid } = await window.electronAPI.recommendBilibiliPartition({
        settings,
        title: title.trim(),
        desc: desc.trim(),
        fallbackSource,
        projectDir: projectDir || undefined,
        projectBindings,
      });
      setBilibiliTid(String(tid));
    } catch (e) {
      setPartitionError(e instanceof Error ? e.message : 'AI 分区推荐失败');
    } finally {
      setIsRecommendingPartition(false);
    }
  };

  const toggleAccount = (accId: string) => {
    setSelectedAccountIds((prev) =>
      prev.includes(accId) ? prev.filter((id) => id !== accId) : [...prev, accId],
    );
    setValidationError(null);
  };

  const handlePickFile = async () => {
    const path = await window.electronAPI.selectMediaFile('video');
    if (path) setFilePath(path);
  };

  // 扫描当前项目目录最新成片（用户手动触发；自动解析失败或导出后可一键刷新）。
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const handleScanVideo = async () => {
    if (!projectDir) {
      setScanMsg('未打开项目，无法扫描');
      return;
    }
    setScanMsg(null);
    setIsScanning(true);
    try {
      const found = await window.electronAPI.findLatestExport(projectDir).catch(() => null);
      if (found) setFilePath(found);
      else setScanMsg('当前项目目录未找到可发布的 MP4 成片，请先在编辑器导出，或手动选择文件');
    } finally {
      setIsScanning(false);
    }
  };

  const handlePickThumbnail = async () => {
    const path = await window.electronAPI.selectMediaFile('image');
    if (path) setThumbnail(path);
  };

  const handlePublish = async () => {
    if (!filePath) return;
    if (selectedAccountIds.length === 0) return;

    setValidationError(null);

    // ── Chromium 组件门控：抖音/视频号/小红书/快手发布前必须已安装 Chromium ──
    if (chromiumMissing) {
      setValidationError('发布前请先下载浏览器组件（Chromium）');
      return;
    }

    const sharedTags = tagsInput
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);

    // ── B站专项校验（全平台共享文案，B站额外需要 tid + 描述）─────────────────────
    const hasBilibili = selectedAccountIds.some(
      (id) => accounts.find((a) => a.id === id)?.platform === 'bilibili',
    );
    const tid = parseInt(bilibiliTid.trim(), 10);
    if (hasBilibili) {
      if (!bilibiliTid.trim() || isNaN(tid) || tid <= 0) {
        setValidationError('发布到 B站需要先选择分区');
        return;
      }
      if (!desc.trim()) {
        setValidationError('发布到 B站需要填写描述');
        return;
      }
    }

    // 多比例封面：仅收集已选比例；单图 thumbnail 作为兜底（优先竖图，兼容旧/单封面平台）
    const ratios = ['16:9', '4:3', '3:4'] as const;
    const coversObj = ratios.reduce<Record<string, string>>((acc, r) => {
      if (covers[r]) acc[r] = covers[r];
      return acc;
    }, {});
    const primaryThumb = covers['3:4'] || covers['16:9'] || covers['4:3'] || thumbnail || undefined;
    const shared = {
      title,
      desc,
      tags: sharedTags,
      thumbnail: primaryThumb,
      covers: Object.keys(coversObj).length ? coversObj : undefined,
    };

    // Build targets — 全平台共用 shared 文案，B站附加 tid
    const targets: PublishTarget[] = selectedAccountIds.map((accountId) => {
      const acc = accounts.find((a) => a.id === accountId);
      const bilibiliExtra: PublishTarget['bilibili'] =
        acc?.platform === 'bilibili' && !isNaN(tid) ? { tid } : undefined;
      return {
        accountId,
        ...(bilibiliExtra ? { bilibili: bilibiliExtra } : {}),
      };
    });

    // 历史记录的目标快照（含平台/昵称，供展示与就地重登）
    const historyTargets: PublishHistoryTarget[] = selectedAccountIds.map((accountId) => {
      const acc = accounts.find((a) => a.id === accountId);
      return {
        accountId,
        platform: acc?.platform ?? accountId.split('_')[0],
        accountName: acc?.accountName ?? accountId.split('_').slice(1).join('_'),
        ...(acc?.platform === 'bilibili' && !isNaN(tid) ? { bilibiliTid: tid } : {}),
      };
    });

    await runPublish(filePath, shared, targets, historyTargets);
  };

  // 执行发布并在完成后落一条历史记录（新发布与重新发布共用）
  const runPublish = async (
    fp: string,
    shared: PublishShared,
    targets: PublishTarget[],
    historyTargets: PublishHistoryTarget[],
  ) => {
    try {
      await startPublish(fp, shared, targets, true);
    } catch {
      // 错误已在 store 内处理（failTask）；下方仍据最终 results 落历史
    }
    // 合并各账号最终结果（自动续发会逐账号覆盖）
    const merged: Record<string, PublishResult> = { ...usePublishStore.getState().results };

    // ── 登录态失效自动续发：弹窗确认 → 重登 → 立即重发该账号 ──
    const expired = historyTargets.filter((t) => merged[t.accountId]?.state === 'login-expired');
    for (const t of expired) {
      const confirmed = await askRelogin(t);
      if (!confirmed) continue; // 用户取消：保留失效态（落历史记为失败）
      const loggedIn = await reloginAccount(t);
      if (!loggedIn) continue; // 重登失败/取消扫码：保留
      setReloginMsg({ text: `${t.accountName} 登录成功，正在继续发布…`, isError: false });
      const single: PublishTarget = {
        accountId: t.accountId,
        ...(t.bilibiliTid != null ? { bilibili: { tid: t.bilibiliTid } } : {}),
      };
      try {
        await startPublish(fp, shared, [single], true);
      } catch {
        /* 失败据 results 落历史 */
      }
      merged[t.accountId] = usePublishStore.getState().results[t.accountId] ?? merged[t.accountId];
      const okNow = merged[t.accountId]?.state === 'success';
      setReloginMsg({
        text: okNow ? `${t.accountName} 发布成功` : `${t.accountName} 续发未成功，可稍后重试`,
        isError: !okNow,
      });
    }

    const resultMap: Record<string, PublishHistoryResult> = {};
    let okCount = 0;
    for (const t of historyTargets) {
      const ok = merged[t.accountId]?.state === 'success';
      if (ok) okCount += 1;
      resultMap[t.accountId] = {
        state: ok ? 'success' : 'failed',
        message: ok ? undefined : merged[t.accountId]?.message,
      };
    }
    const overallState: PublishHistoryEntry['overallState'] =
      okCount === historyTargets.length ? 'success' : okCount === 0 ? 'failed' : 'partial';
    const entry: PublishHistoryEntry = {
      id: crypto.randomUUID(),
      publishedAt: Date.now(),
      fileName: baseName(fp),
      filePath: fp,
      shared: {
        title: shared.title,
        desc: shared.desc,
        tags: shared.tags,
        thumbnail: shared.thumbnail,
        covers: shared.covers,
        bilibiliTid: historyTargets.find((t) => t.bilibiliTid != null)?.bilibiliTid,
      },
      targets: historyTargets,
      results: resultMap,
      overallState,
    };
    setHistoryEntries((prev) => [entry, ...prev].slice(0, PUBLISH_HISTORY_MAX));
  };

  // 从历史记录重新发布（沿用当时的文件 / 文案 / 目标）
  const handleRepublish = (entry: PublishHistoryEntry) => {
    if (isPublishing) return;
    const shared = {
      title: entry.shared.title,
      desc: entry.shared.desc,
      tags: entry.shared.tags,
      thumbnail: entry.shared.thumbnail,
      covers: entry.shared.covers,
    };
    const targets: PublishTarget[] = entry.targets.map((t) => ({
      accountId: t.accountId,
      ...(t.bilibiliTid != null ? { bilibili: { tid: t.bilibiliTid } } : {}),
    }));
    void runPublish(entry.filePath, shared, targets, entry.targets);
  };

  // 重登核心：挂二维码事件 → 触发登录 → 返回是否成功。手动重登与发布中自动续发共用。
  const reloginAccount = async (target: PublishHistoryTarget): Promise<boolean> => {
    const platform = target.platform as PublishAccount['platform'];
    setReloginBusyId(target.accountId);
    setReloginMsg({
      text: settings.headlessLogin
        ? `正在为 ${target.accountName} 重新登录，二维码将显示在下方，请扫码…`
        : `正在为 ${target.accountName} 打开浏览器扫码登录…`,
      isError: false,
    });
    setQrcodePng(null);
    if (!unsubQrcodeRef.current) {
      unsubQrcodeRef.current = window.publishAPI.onQrcode((p) => setQrcodePng(p.png));
    }
    try {
      const res = await addAccount(platform, target.accountName);
      if (res.success) setQrcodePng(null);
      else setReloginMsg({ text: res.message || '登录失败', isError: true });
      return res.success;
    } catch (err) {
      setReloginMsg({ text: err instanceof Error ? err.message : '登录异常', isError: true });
      return false;
    } finally {
      setReloginBusyId(null);
      unsubQrcodeRef.current?.();
      unsubQrcodeRef.current = null;
    }
  };

  // 就地重新登录失败账号（无需进入设置页）；手动入口，成功后由用户手动重发
  const handleRelogin = async (target: PublishHistoryTarget) => {
    const ok = await reloginAccount(target);
    if (ok) setReloginMsg({ text: '重新登录成功，可点「重新发布」重试', isError: false });
  };

  // Show results from last run (store clears job on completion but keeps results)
  const jobResults = results;
  const hasResults = Object.keys(jobResults).length > 0;
  const targetCount = selectedAccountIds.length;

  // ── B站分区选择器派生值 ──
  const parentOptions = BILIBILI_PARTITIONS.map((p) => ({
    value: String(p.id),
    label: p.name,
  }));
  const childOptions =
    bilibiliParentId != null
      ? (BILIBILI_PARTITIONS.find((p) => p.id === bilibiliParentId)?.children ?? []).map((c) => ({
          value: String(c.id),
          label: c.name,
        }))
      : [];
  const selectedPartition = findPartition(parseInt(bilibiliTid, 10));

  return (
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--color-border-subtle, rgba(0,0,0,0.08))',
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 16,
            fontWeight: 600,
            color: 'var(--color-text-primary)',
          }}
        >
          发布视频
        </h2>
        {projectDir && (
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            {projectDir}
          </p>
        )}
      </div>

      {/* Form */}
      <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Video file */}
        <Field label="视频文件" required>
          <div style={{ display: 'flex', gap: 8 }}>
            <Input
              value={filePath}
              onChange={(e) => {
                setScanMsg(null);
                setFilePath(e.target.value);
              }}
              placeholder="选择 MP4 文件或直接输入路径…"
              leftIcon={<Film size={14} />}
              style={{ flex: 1 }}
            />
            <Button
              variant="outline"
              onClick={handleScanVideo}
              disabled={!projectDir || isScanning}
              style={{ flexShrink: 0 }}
              leftIcon={
                isScanning ? (
                  <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                ) : (
                  <RotateCcw size={14} />
                )
              }
            >
              扫描项目
            </Button>
            <Button variant="outline" onClick={handlePickFile} style={{ flexShrink: 0 }}>
              选择…
            </Button>
          </div>
          {scanMsg && (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              {scanMsg}
            </div>
          )}
        </Field>

        {/* Thumbnail (optional) + 封面联动面板 */}
        <Field
          label="封面缩略图"
          hint="视频号 / 抖音都用 4:3 横版 + 3:4 竖版各选一张；16:9 为编辑器整期封面 / 单图兜底"
        >
          <div style={{ display: 'flex', gap: 8 }}>
            <Input
              value={thumbnail}
              onChange={(e) => setThumbnail(e.target.value)}
              placeholder="封面图路径（点下方封面或手动选择）"
              leftIcon={<ImageIcon size={14} />}
              style={{ flex: 1 }}
            />
            <Button variant="outline" onClick={handlePickThumbnail} style={{ flexShrink: 0 }}>
              选择…
            </Button>
          </div>
          <button
            type="button"
            onClick={() => setShowCoverPanel((v) => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              marginTop: 8,
              fontSize: 12,
              color: 'var(--color-system-blue)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {showCoverPanel ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            封面比例与生成（16:9 / 4:3 / 3:4）
          </button>
          {showCoverPanel && (
            <div style={{ marginTop: 8 }}>
              <PublishCoverPanel
                studio={coverStudio}
                selectedByRatio={covers}
                onSelectRatio={(ratio, path) =>
                  setCovers((prev) => {
                    const next = { ...prev };
                    if (next[ratio] === path) delete next[ratio];
                    else next[ratio] = path;
                    return next;
                  })
                }
              />
            </div>
          )}
        </Field>

        {/* AI 一键生成文案 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button
            variant="outline"
            onClick={() => void handleGenerateMeta()}
            disabled={isGeneratingMeta}
            style={{ flexShrink: 0 }}
          >
            {isGeneratingMeta ? (
              <>
                <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', marginRight: 6 }} />
                生成中…
              </>
            ) : (
              <>
                <Sparkles size={14} style={{ marginRight: 6 }} />
                AI 一键生成标题/描述/标签
              </>
            )}
          </Button>
          {metaError && (
            <span style={{ fontSize: 12, color: 'var(--color-error, #ef4444)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <X size={12} />
              {metaError}
            </span>
          )}
        </div>

        {/* Title */}
        <Field label="标题" required hint="所有平台共用同一份标题">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="视频标题"
          />
        </Field>

        {/* Description */}
        <Field label="描述">
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="视频描述（可选）"
            rows={3}
            style={{
              width: '100%',
              resize: 'vertical',
              padding: '8px 10px',
              fontSize: 13,
              border: '1px solid var(--color-border, rgba(0,0,0,0.15))',
              borderRadius: 6,
              background: 'var(--color-input-bg, var(--color-bg-elevated))',
              color: 'var(--color-text-primary)',
              fontFamily: 'inherit',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </Field>

        {/* Tags */}
        <Field label="标签" hint="用逗号分隔多个标签，所有平台共用">
          <Input
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="标签1, 标签2, 标签3"
            leftIcon={<Tag size={14} />}
          />
        </Field>

        {/* Account multi-select */}
        <Field label="发布到" required>
          {accounts.length === 0 ? (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 6,
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border, rgba(0,0,0,0.1))',
                fontSize: 13,
                color: 'var(--color-text-secondary)',
              }}
            >
              暂无账号，请前往「设置 → 发布账号」添加账号
            </div>
          ) : (
            <div
              style={{
                borderRadius: 6,
                border: '1px solid var(--color-border, rgba(0,0,0,0.1))',
                overflow: 'hidden',
              }}
            >
              {accounts.map((acc, idx) => {
                const isChecked = selectedAccountIds.includes(acc.id);
                const isValid = acc.status === 'valid';
                const isLast = idx === accounts.length - 1;
                return (
                  <div
                    key={acc.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 14px',
                      borderBottom: isLast ? 'none' : '1px solid var(--color-border-subtle, rgba(0,0,0,0.06))',
                      background: isChecked
                        ? 'color-mix(in srgb, var(--color-system-blue) 6%, transparent)'
                        : 'transparent',
                      opacity: !isValid ? 0.55 : 1,
                    }}
                  >
                    <Checkbox
                      checked={isChecked}
                      disabled={!isValid}
                      onChange={() => toggleAccount(acc.id)}
                      className="flex-1 min-w-0"
                      label={
                        <span style={{ fontSize: 13 }}>
                          <span style={{ fontWeight: 500 }}>
                            {PLATFORM_LABEL[acc.platform] ?? acc.platform}
                          </span>
                          {' '}
                          <span style={{ color: 'var(--color-text-secondary)' }}>{acc.accountName}</span>
                        </span>
                      }
                    />
                    <AccountStatusBadge status={acc.status} />
                    {!isValid && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          void handleRelogin({
                            accountId: acc.id,
                            platform: acc.platform,
                            accountName: acc.accountName,
                          })
                        }
                        disabled={isPublishing || reloginBusyId === acc.id}
                        style={{ flexShrink: 0 }}
                        title="就地重新登录"
                      >
                        {reloginBusyId === acc.id ? (
                          <Spinner size={11} />
                        ) : (
                          <LogIn size={12} style={{ marginRight: 4 }} />
                        )}
                        <span style={{ marginLeft: reloginBusyId === acc.id ? 4 : 0 }}>重登</span>
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Field>

        {/* B站分区 ID — 仅选中 B站账号时显示，全平台共享一份 */}
        {selectedAccountIds.some(
          (id) => accounts.find((a) => a.id === id)?.platform === 'bilibili',
        ) && (
          <Field label="B站分区" required hint="发布到 B站必填；选择最贴合内容的子分区，或用「智能推荐分区」按标题/描述自动选">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Select
                    placeholder="主分区"
                    options={parentOptions}
                    value={bilibiliParentId != null ? String(bilibiliParentId) : ''}
                    onChange={(e) => {
                      const nextParent = parseInt(e.target.value, 10);
                      setBilibiliParentId(Number.isInteger(nextParent) ? nextParent : null);
                      // 切换主分区后清空子分区，强制重新选择
                      setBilibiliTid('');
                      setPartitionError(null);
                    }}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Select
                    placeholder="子分区"
                    options={childOptions}
                    disabled={bilibiliParentId == null}
                    value={bilibiliTid}
                    onChange={(e) => {
                      setBilibiliTid(e.target.value);
                      setPartitionError(null);
                    }}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <Button
                  variant="outline"
                  onClick={() => void handleRecommendPartition()}
                  disabled={isRecommendingPartition}
                  style={{ flexShrink: 0 }}
                >
                  {isRecommendingPartition ? (
                    <>
                      <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', marginRight: 6 }} />
                      推荐中…
                    </>
                  ) : (
                    <>
                      <Sparkles size={14} style={{ marginRight: 6 }} />
                      智能推荐分区
                    </>
                  )}
                </Button>
                {selectedPartition && (
                  <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    已选：{selectedPartition.parent.name} / {selectedPartition.sub.name}（tid {selectedPartition.sub.id}）
                  </span>
                )}
                {partitionError && (
                  <span style={{ fontSize: 12, color: 'var(--color-error, #ef4444)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <X size={12} />
                    {partitionError}
                  </span>
                )}
              </div>
            </div>
          </Field>
        )}

        {/* Chromium 组件门控提示：未安装时引导下载，禁用发布 */}
        {chromiumMissing && (
          <DependencyDownloadNotice
            kind="chromium"
            onSuccess={() => {
              setChromiumInstalled(true);
              setValidationError(null);
            }}
            onError={(msg) => setValidationError(msg)}
          />
        )}

        {/* Publish button */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button
            variant="primary"
            onClick={handlePublish}
            disabled={isPublishing || !filePath || targetCount === 0 || chromiumMissing}
            style={{ minWidth: 140 }}
          >
            {isPublishing ? (
              <>
                <Spinner size={14} />
                <span style={{ marginLeft: 6 }}>发布中…</span>
              </>
            ) : (
              <>
                <Upload size={14} style={{ marginRight: 6 }} />
                一键发布{targetCount > 0 ? ` (${targetCount} 个目标)` : ''}
              </>
            )}
          </Button>
          {isPublishing && (
            <Button variant="ghost" onClick={cancelPublish}>
              取消
            </Button>
          )}
          {targetCount === 0 && !isPublishing && (
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              请勾选至少一个账号
            </span>
          )}
          {validationError && !isPublishing && (
            <span
              style={{
                fontSize: 12,
                color: 'var(--color-error, #ef4444)',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <X size={12} />
              {validationError}
            </span>
          )}
        </div>

        {/* Per-target progress rows */}
        {hasResults && (
          <div
            style={{
              borderRadius: 8,
              border: '1px solid var(--color-border, rgba(0,0,0,0.1))',
              padding: '8px 14px',
              background: 'var(--color-bg-elevated)',
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
                marginBottom: 4,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              发布进度
            </div>
            {Object.entries(jobResults).map(([accountId, result]) => (
              <ResultRow
                key={accountId}
                accountId={accountId}
                state={result.state}
                percent={result.percent}
                message={result.message}
              />
            ))}
          </div>
        )}

        {/* 就地重登：状态提示 + 二维码 */}
        {(reloginMsg || qrcodePng) && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '12px 14px',
              borderRadius: 8,
              border: '1px solid var(--color-border, rgba(0,0,0,0.1))',
              background: 'var(--color-bg-elevated)',
            }}
          >
            {reloginMsg && (
              <span
                style={{
                  fontSize: 13,
                  color: reloginMsg.isError
                    ? 'var(--color-error, #ef4444)'
                    : 'var(--color-text-secondary)',
                }}
              >
                {reloginMsg.text}
              </span>
            )}
            {qrcodePng && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                  请使用 App 扫描二维码登录
                </span>
                <img
                  src={`file://${qrcodePng}`}
                  alt="登录二维码"
                  style={{ width: 160, height: 160, borderRadius: 6, background: '#fff' }}
                />
              </div>
            )}
          </div>
        )}

        {/* 发布历史 */}
        {historyEntries.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              <History size={13} />
              发布历史
            </div>
            {historyEntries.map((entry) => (
              <HistoryEntryCard
                key={entry.id}
                entry={entry}
                disabled={isPublishing}
                reloginBusyId={reloginBusyId}
                onRepublish={handleRepublish}
                onRelogin={(t) => void handleRelogin(t)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 发布中检测到登录态失效：弹窗确认 → 重登 → 自动续发 */}
      <ConfirmDialog
        open={!!loginPrompt}
        onOpenChange={() => {}}
        title="账号登录已过期"
        description={
          loginPrompt
            ? `${PLATFORM_LABEL[loginPrompt.platform] ?? loginPrompt.platform}账号「${loginPrompt.accountName}」登录态已失效，需要重新登录。确认后将打开扫码登录，扫码成功后自动继续发布。`
            : ''
        }
        confirmText="重新登录"
        cancelText="稍后再说"
        onConfirm={() => resolveLoginPrompt(true)}
        onCancel={() => resolveLoginPrompt(false)}
      />
    </div>
  );
}
