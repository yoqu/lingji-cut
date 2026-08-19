// 发布工作台核心（项目无关）：视频文件 / 封面 / 文案 / 账号 / B站分区 / 一键发布 /
// 进度 / 就地重登 / 发布历史 的完整 UI 与交互。
// 项目发布 tab（PublishWorkbench）与发布中心（PublishHub）共用；
// 数据来源与持久化由调用方通过 draft / coverStudio / generateMeta 等适配注入。

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Upload, Film, Image as ImageIcon, Tag, Check, X, Loader2, ChevronDown, ChevronRight, Sparkles, History, RotateCcw, LogIn } from 'lucide-react';
import { Button, Checkbox, ConfirmDialog, Field, Input, Select } from '../../../ui';
import {
  BILIBILI_PARTITIONS,
  findPartition,
} from '../../../lib/publish/bilibili-partitions';
import { CHROMIUM_PLATFORMS } from '../../../lib/publish/chromium-platforms';
import { DependencyDownloadNotice } from '../DependencyDownloadCard';
import { Spinner } from '../../../ui/primitives/Spinner';
import { usePublishStore } from '../../../store/publish';
import { useTaskProgressStore } from '../../../store/task-progress';
import type { PublishAccount, PublishTarget } from '../../../lib/electron-api';
import type {
  PublishHistoryEntry,
  PublishHistoryTarget,
} from '../../../lib/project-persistence';
import type { PublishMetadata } from '../../../lib/publish-metadata';
import { PLATFORM_LABEL } from '../../../lib/publish/platform-labels';
import { PublishCoverPanel } from '../PublishCoverPanel';
import type { CoverStudio } from '../useCoverStudio';
import {
  buildPublishShared,
  buildPublishTargets,
  validatePublishDraft,
  type PublishDraft,
} from '../../../lib/publish/draft';
import { usePublishRunner } from './usePublishRunner';

function startPublishAITask(label: string, phase: string): string {
  const taskId = `publish-ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  useTaskProgressStore.getState().startTask({
    id: taskId,
    category: 'publish',
    label,
    mode: 'indeterminate',
    progress: 0,
    phase,
    level: 1,
    canCancel: false,
  });
  return taskId;
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

// ─── Composer ─────────────────────────────────────────────────────────────────

export interface PublishComposerProps {
  draft: PublishDraft;
  onDraftChange: (patch: Partial<PublishDraft>) => void;
  coverStudio: CoverStudio;
  /** 头部副标题（项目路径等）；hideHeader 时忽略。 */
  subtitle?: string | null;
  hideHeader?: boolean;
  /** 视频文件字段之后插入的额外表单项。 */
  extraFields?: ReactNode;
  /** 可选「扫描」按钮：返回解析出的文件路径，null 表示未找到。 */
  onScanVideo?: (() => Promise<string | null>) | null;
  scanEmptyMessage?: string;
  /** AI 生成发布文案；素材来源由调用方决定（AI 分析 / 主题文本）。 */
  generateMeta: (draft: PublishDraft) => Promise<PublishMetadata>;
  /** AI 推荐 B站分区；兜底素材由调用方决定。 */
  recommendPartition: (draft: PublishDraft) => Promise<{ tid: number }>;
  historyEntries: PublishHistoryEntry[];
  publishedPlatforms: Record<string, number>;
  /** 一次发布（含自动续发）完成后回调；历史与已发布平台由调用方持久化。 */
  onPublished: (entry: PublishHistoryEntry) => void;
  /** 封面面板无生成描述时的引导文案。 */
  coverEmptyHint?: string;
  /** 封面面板上方的额外内容（封面提示词编辑区）。 */
  coverExtra?: ReactNode;
  /** 提供时历史区常显：无记录也渲染「发布历史」标题与此占位文案。 */
  historyEmptyText?: string;
  /** 发布中心：账号加载后默认勾选所有已登录账号。 */
  defaultSelectValidAccounts?: boolean;
}

export function PublishComposer({
  draft,
  onDraftChange,
  coverStudio,
  subtitle,
  hideHeader,
  extraFields,
  onScanVideo,
  scanEmptyMessage,
  generateMeta,
  recommendPartition,
  historyEntries,
  publishedPlatforms,
  onPublished,
  coverEmptyHint,
  coverExtra,
  historyEmptyText,
  defaultSelectValidAccounts,
}: PublishComposerProps) {
  const { accounts, loadAccounts, loadSettings } = usePublishStore();
  const runner = usePublishRunner();
  const {
    isPublishing,
    results,
    cancelPublish,
    reloginBusyId,
    reloginMsg,
    qrcodePng,
    loginPrompt,
    resolveLoginPrompt,
  } = runner;

  // 级联选择器的主分区态（由 bilibiliTid 反查同步，picker 切换时维护）
  const [bilibiliParentId, setBilibiliParentId] = useState<number | null>(null);
  const [isRecommendingPartition, setIsRecommendingPartition] = useState(false);
  const [partitionError, setPartitionError] = useState<string | null>(null);
  const [isGeneratingMeta, setIsGeneratingMeta] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [showCoverPanel, setShowCoverPanel] = useState(true);

  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const didAutoSelectAccounts = useRef(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Chromium 自动化组件安装状态：null=未知/检测中
  const [chromiumInstalled, setChromiumInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    void loadAccounts();
    void loadSettings();
  }, [loadAccounts, loadSettings]);

  useEffect(() => {
    if (!defaultSelectValidAccounts || didAutoSelectAccounts.current) return;
    const validIds = accounts.filter((acc) => acc.status === 'valid').map((acc) => acc.id);
    if (validIds.length === 0) return;
    didAutoSelectAccounts.current = true;
    setSelectedAccountIds(validIds);
  }, [accounts, defaultSelectValidAccounts]);

  // 选中的账号是否包含需要 Chromium 的平台
  const needsChromium = selectedAccountIds.some((id) => {
    const p = accounts.find((a) => a.id === id)?.platform;
    return p != null && CHROMIUM_PLATFORMS.has(p);
  });
  const chromiumMissing = needsChromium && chromiumInstalled === false;

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

  const handleGenerateMeta = async () => {
    if (isGeneratingMeta) return;
    setMetaError(null);
    const taskId = startPublishAITask('生成发布文案', '生成标题、描述和标签');
    setIsGeneratingMeta(true);
    try {
      const md = await generateMeta(draft);
      const patch: Partial<PublishDraft> = {};
      if (md.title) patch.title = md.title;
      if (md.desc) patch.desc = md.desc;
      if (md.tags.length) patch.tagsInput = md.tags.join(', ');
      onDraftChange(patch);
      useTaskProgressStore.getState().completeTask(taskId);
    } catch (e) {
      const message = e instanceof Error ? e.message : '发布文案生成失败';
      setMetaError(message);
      useTaskProgressStore.getState().failTask(taskId, message);
    } finally {
      setIsGeneratingMeta(false);
    }
  };

  // bilibiliTid 变化（hydrate / AI 推荐 / 手选）时，反查并同步主分区态
  useEffect(() => {
    const n = parseInt(draft.bilibiliTid, 10);
    const found = Number.isInteger(n) ? findPartition(n) : null;
    if (found) setBilibiliParentId(found.parent.id);
  }, [draft.bilibiliTid]);

  const handleRecommendPartition = async () => {
    if (isRecommendingPartition) return;
    setPartitionError(null);
    const taskId = startPublishAITask('推荐 B站分区', '分析标题与描述');
    setIsRecommendingPartition(true);
    try {
      const { tid } = await recommendPartition(draft);
      onDraftChange({ bilibiliTid: String(tid) });
      useTaskProgressStore.getState().completeTask(taskId);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'B站分区推荐失败';
      setPartitionError(message);
      useTaskProgressStore.getState().failTask(taskId, message);
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

  // 全选/取消全选（仅作用于已登录账号）
  const validAccounts = accounts.filter((a) => a.status === 'valid');
  const allValidSelected =
    validAccounts.length > 0 && validAccounts.every((a) => selectedAccountIds.includes(a.id));
  const toggleAllAccounts = () => {
    setSelectedAccountIds(allValidSelected ? [] : validAccounts.map((a) => a.id));
    setValidationError(null);
  };

  const handlePickFile = async () => {
    const path = await window.electronAPI.selectMediaFile('video');
    if (path) onDraftChange({ filePath: path });
  };

  // 扫描解析视频文件（项目模式：项目目录最新成片；发布中心由识别结果回填）
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const handleScanVideo = async () => {
    if (!onScanVideo) return;
    setScanMsg(null);
    setIsScanning(true);
    try {
      const found = await onScanVideo();
      if (found) onDraftChange({ filePath: found });
      else setScanMsg(scanEmptyMessage ?? '未找到可发布的 MP4 成片，请手动选择文件');
    } finally {
      setIsScanning(false);
    }
  };

  const handlePickThumbnail = async () => {
    const path = await window.electronAPI.selectMediaFile('image');
    if (path) onDraftChange({ thumbnail: path });
  };

  const handlePublish = async () => {
    if (!draft.filePath) return;
    if (selectedAccountIds.length === 0) return;

    setValidationError(null);

    const hasBilibili = selectedAccountIds.some(
      (id) => accounts.find((a) => a.id === id)?.platform === 'bilibili',
    );
    const error = validatePublishDraft(draft, { hasBilibili, chromiumMissing });
    if (error) {
      setValidationError(error);
      return;
    }

    const shared = buildPublishShared(draft);
    const { targets, historyTargets } = buildPublishTargets(draft, selectedAccountIds, accounts);
    const entry = await runner.runPublish(draft.filePath, shared, targets, historyTargets);
    onPublished(entry);
  };

  // 从历史记录重新发布（沿用当时的文件 / 文案 / 目标）
  const handleRepublish = async (entry: PublishHistoryEntry) => {
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
    const next = await runner.runPublish(entry.filePath, shared, targets, entry.targets);
    onPublished(next);
  };

  // Show results from last run (store clears job on completion but keeps results)
  const hasResults = Object.keys(results).length > 0;
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
  const selectedPartition = findPartition(parseInt(draft.bilibiliTid, 10));

  return (
    <div
      data-agent-zone="publish"
      style={{
        height: '100%',
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
      }}
    >
      {/* Header */}
      {!hideHeader && (
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
          {subtitle && (
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              {subtitle}
            </p>
          )}
        </div>
      )}

      {/* Form */}
      <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Video file */}
        <Field label="视频文件" required>
          <div style={{ display: 'flex', gap: 8 }}>
            <Input
              value={draft.filePath}
              onChange={(e) => {
                setScanMsg(null);
                onDraftChange({ filePath: e.target.value });
              }}
              placeholder="选择 MP4 文件或直接输入路径…"
              leftIcon={<Film size={14} />}
              style={{ flex: 1 }}
            />
            {onScanVideo && (
              <Button
                variant="outline"
                onClick={handleScanVideo}
                disabled={isScanning}
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
            )}
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

        {extraFields}

        {/* Thumbnail (optional) + 封面联动面板 */}
        <Field
          label="封面缩略图"
          hint="视频号 / 抖音都用 4:3 横版 + 3:4 竖版各选一张；16:9 为编辑器整期封面 / 单图兜底"
        >
          <div style={{ display: 'flex', gap: 8 }}>
            <Input
              value={draft.thumbnail}
              onChange={(e) => onDraftChange({ thumbnail: e.target.value })}
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
              {coverExtra}
              <PublishCoverPanel
                studio={coverStudio}
                emptyPromptHint={coverEmptyHint}
                selectedByRatio={draft.covers}
                onSelectRatio={(ratio, path) => {
                  const next = { ...draft.covers };
                  if (next[ratio] === path) delete next[ratio];
                  else next[ratio] = path;
                  onDraftChange({ covers: next });
                }}
              />
            </div>
          )}
        </Field>

        {/* 生成发布文案 */}
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
                生成发布文案
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
            value={draft.title}
            onChange={(e) => onDraftChange({ title: e.target.value })}
            placeholder="视频标题"
          />
        </Field>

        {/* Description */}
        <Field label="描述">
          <textarea
            value={draft.desc}
            onChange={(e) => onDraftChange({ desc: e.target.value })}
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
            value={draft.tagsInput}
            onChange={(e) => onDraftChange({ tagsInput: e.target.value })}
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
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '8px 14px',
                  borderBottom: '1px solid var(--color-border-subtle, rgba(0,0,0,0.06))',
                  background: 'var(--color-bg-elevated)',
                }}
              >
                <Checkbox
                  checked={allValidSelected}
                  indeterminate={!allValidSelected && selectedAccountIds.length > 0}
                  disabled={validAccounts.length === 0}
                  onChange={toggleAllAccounts}
                  label={
                    <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                      {allValidSelected ? '取消全选' : '全选'}（{validAccounts.length} 个可用账号）
                    </span>
                  }
                />
              </div>
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
                    {publishedPlatforms[acc.platform] != null && (
                      <span
                        title={`该平台最近发布：${formatRelativeTime(publishedPlatforms[acc.platform])}`}
                        style={{
                          fontSize: 11,
                          padding: '2px 6px',
                          borderRadius: 4,
                          background:
                            'color-mix(in srgb, var(--color-success, #22c55e) 15%, transparent)',
                          color: 'var(--color-success, #22c55e)',
                          fontWeight: 500,
                          flexShrink: 0,
                        }}
                      >
                        已发布
                      </span>
                    )}
                    <AccountStatusBadge status={acc.status} />
                    {!isValid && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          void runner.relogin({
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
          <Field label="B站分区" required hint="发布到 B站必填；选择最贴合内容的子分区，或根据标题和描述自动推荐">
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
                      onDraftChange({ bilibiliTid: '' });
                      setPartitionError(null);
                    }}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Select
                    placeholder="子分区"
                    options={childOptions}
                    disabled={bilibiliParentId == null}
                    value={draft.bilibiliTid}
                    onChange={(e) => {
                      onDraftChange({ bilibiliTid: e.target.value });
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
                      推荐分区
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
            onClick={() => void handlePublish()}
            disabled={isPublishing || !draft.filePath || targetCount === 0 || chromiumMissing}
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
            {Object.entries(results).map(([accountId, result]) => (
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

        {/* 发布历史（historyEmptyText 提供时常显，空态给占位引导） */}
        {(historyEntries.length > 0 || historyEmptyText) && (
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
            {historyEntries.length === 0 ? (
              <div
                style={{
                  padding: '12px 14px',
                  borderRadius: 8,
                  border: '1px dashed var(--color-border, rgba(0,0,0,0.12))',
                  fontSize: 12,
                  color: 'var(--color-text-tertiary)',
                }}
              >
                {historyEmptyText}
              </div>
            ) : (
              historyEntries.map((entry) => (
                <HistoryEntryCard
                  key={entry.id}
                  entry={entry}
                  disabled={isPublishing}
                  reloginBusyId={reloginBusyId}
                  onRepublish={(e) => void handleRepublish(e)}
                  onRelogin={(t) => void runner.relogin(t)}
                />
              ))
            )}
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
