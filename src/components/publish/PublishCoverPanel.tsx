import { useState } from 'react';
import { Check, RefreshCw, Sparkles, Loader2, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import type { CoverCandidate, ImageAspectRatio } from '../../types/ai';
import { toFileSrc } from '../../lib/utils';
import {
  PUBLISH_RATIOS,
  resolvePublishRatioPrompt,
  type CoverStudio,
} from './useCoverStudio';

const RATIO_CSS: Record<string, string> = { '16:9': '16 / 9', '4:3': '4 / 3', '3:4': '3 / 4' };

function coverSrc(imageUrl: string, createdAt?: number): string {
  const base = toFileSrc(imageUrl);
  return createdAt ? `${base}?v=${createdAt}` : base;
}

function btn(active = false): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 9px',
    fontSize: 12,
    borderRadius: 6,
    border: '1px solid var(--color-border, rgba(0,0,0,0.12))',
    background: active ? 'color-mix(in srgb, var(--color-system-blue) 12%, transparent)' : 'var(--color-bg-elevated)',
    color: active ? 'var(--color-system-blue)' : 'var(--color-text-secondary)',
    cursor: 'pointer',
  };
}

function CoverThumb({
  candidate,
  ratio,
  isThumbnail,
  busy,
  canRegenerate,
  onSelect,
  onRegenerate,
}: {
  candidate: CoverCandidate;
  ratio: ImageAspectRatio;
  isThumbnail: boolean;
  busy: boolean;
  canRegenerate: boolean;
  onSelect: () => void;
  onRegenerate: () => void;
}) {
  const hasImage = Boolean(candidate.imageUrl);
  return (
    <div style={{ width: ratio === '3:4' ? 108 : 150, flexShrink: 0 }}>
      <button
        type="button"
        onClick={hasImage ? onSelect : undefined}
        title={hasImage ? '设为发布封面' : candidate.error || '生成失败'}
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: RATIO_CSS[ratio],
          borderRadius: 8,
          overflow: 'hidden',
          border: isThumbnail
            ? '2px solid var(--color-system-blue)'
            : '1px solid var(--color-border, rgba(0,0,0,0.12))',
          background: 'var(--color-bg-subtle, rgba(0,0,0,0.04))',
          cursor: hasImage ? 'pointer' : 'default',
          padding: 0,
          display: 'block',
        }}
      >
        {hasImage ? (
          <img
            src={coverSrc(candidate.imageUrl, candidate.createdAt)}
            alt="封面"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              color: 'var(--color-error, #ef4444)',
              padding: 6,
              textAlign: 'center',
            }}
          >
            生成失败
          </div>
        )}
        {busy && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.45)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Loader2 size={20} style={{ color: '#fff', animation: 'spin 1s linear infinite' }} />
          </div>
        )}
        {isThumbnail && !busy && (
          <div
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: 'var(--color-system-blue)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Check size={12} style={{ color: '#fff' }} />
          </div>
        )}
      </button>
      {canRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          disabled={busy}
          style={{ ...btn(), marginTop: 4, width: '100%', justifyContent: 'center', opacity: busy ? 0.6 : 1 }}
        >
          <RefreshCw size={11} />
          重新生成
        </button>
      )}
    </div>
  );
}

export function PublishCoverPanel({
  studio,
  selectedByRatio,
  onSelectRatio,
  emptyPromptHint = '暂无封面生成描述；可直接选用下方已有封面，或先在编辑器生成内容卡片。',
}: {
  /** 由父级持有的封面工作台（单一数据源，便于父级按比例自动预填）。 */
  studio: CoverStudio;
  /** 每个比例当前选中的封面路径（视频号 4:3+3:4，抖音 3:4+16:9）。 */
  selectedByRatio: Partial<Record<ImageAspectRatio, string>>;
  /** 点选某比例的封面：同图再点为取消该比例。 */
  onSelectRatio: (ratio: ImageAspectRatio, path: string) => void;
  /** 无封面生成描述时的引导文案（项目 / 自由发布场景不同）。 */
  emptyPromptHint?: string;
}) {
  const [expandedPrompt, setExpandedPrompt] = useState<Record<string, boolean>>({});
  const anyBusy = studio.busyRatios.length > 0 || studio.busyCandidateIds.length > 0;
  // 没有封面提示词时仍展示已存在的封面（含磁盘扫描结果），仅禁用 AI 生成相关按钮。
  const canGenerate = !!studio.basePrompt;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Global actions */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => void studio.fillMissing()}
          disabled={!canGenerate || anyBusy || studio.missingRatios.length === 0}
          style={{ ...btn(), opacity: !canGenerate || anyBusy || studio.missingRatios.length === 0 ? 0.5 : 1 }}
        >
          <Sparkles size={12} />
          补全缺失比例{studio.missingRatios.length > 0 ? `（${studio.missingRatios.length}）` : ''}
        </button>
        <button
          type="button"
          onClick={() => void studio.regenerateAll()}
          disabled={!canGenerate || anyBusy}
          style={{ ...btn(), opacity: !canGenerate || anyBusy ? 0.5 : 1 }}
        >
          {anyBusy ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={12} />}
          全部重新生成
        </button>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          视频号 / 抖音都用 4:3 横版 + 3:4 竖版各选一张
        </span>
      </div>

      {studio.scanUnavailable && (
        <div style={{ fontSize: 12, color: 'var(--color-error, #ef4444)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <AlertTriangle size={13} style={{ flexShrink: 0 }} />
          封面扫描能力未加载（主进程为旧版本）。请完全退出并重启应用后再试，即可读取 covers/ 中已有的 4:3 / 3:4 图片。
        </div>
      )}

      {!canGenerate && (
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <AlertTriangle size={13} style={{ color: 'var(--color-warning, #f59e0b)', flexShrink: 0 }} />
          {emptyPromptHint}
        </div>
      )}

      {studio.error && (
        <div style={{ fontSize: 12, color: 'var(--color-error, #ef4444)', display: 'flex', gap: 4, alignItems: 'center' }}>
          <AlertTriangle size={12} />
          {studio.error}
        </div>
      )}

      {/* Per-ratio groups */}
      {PUBLISH_RATIOS.map(({ ratio, label, hint }) => {
        const group = studio.groups[ratio] ?? [];
        const ratioBusy = studio.busyRatios.includes(ratio);
        const promptOpen = !!expandedPrompt[ratio];
        const groupPrompt = resolvePublishRatioPrompt(
          studio.basePrompt,
          ratio,
          group[0]?.prompt,
        );
        return (
          <div
            key={ratio}
            style={{
              borderRadius: 8,
              border: '1px solid var(--color-border-subtle, rgba(0,0,0,0.08))',
              padding: '10px 12px',
              background: 'var(--color-bg-elevated)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{label}</span>
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{hint}</span>
              <button
                type="button"
                onClick={() => void studio.regenerateRatio(ratio)}
                disabled={!canGenerate || ratioBusy}
                title={canGenerate ? '' : '需先在编辑器完成 AI 分析生成封面提示词'}
                style={{ ...btn(), marginLeft: 'auto', opacity: !canGenerate || ratioBusy ? 0.5 : 1 }}
              >
                {ratioBusy ? (
                  <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                ) : (
                  <RefreshCw size={11} />
                )}
                {group.length === 0 ? '生成' : '重新生成'}
              </button>
            </div>

            {/* Prompt (collapsible) */}
            <button
              type="button"
              onClick={() => setExpandedPrompt((p) => ({ ...p, [ratio]: !p[ratio] }))}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
                color: 'var(--color-text-secondary)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                marginBottom: promptOpen ? 6 : 0,
              }}
            >
              {promptOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              提示词
            </button>
            {promptOpen && (
              <div
                style={{
                  fontSize: 11,
                  lineHeight: 1.6,
                  color: 'var(--color-text-secondary)',
                  whiteSpace: 'pre-wrap',
                  background: 'var(--color-bg-subtle, rgba(0,0,0,0.03))',
                  borderRadius: 6,
                  padding: '6px 8px',
                  marginBottom: 8,
                  maxHeight: 140,
                  overflow: 'auto',
                }}
              >
                {groupPrompt}
              </div>
            )}

            {/* Thumbnails */}
            {group.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', padding: '8px 0' }}>
                {ratioBusy
                  ? '生成中…'
                  : canGenerate
                    ? '暂无此比例封面，点「生成」创建'
                    : '暂无此比例封面（可在 covers/ 放入对应比例图片，或先完成 AI 分析）'}
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {group.map((c) => (
                  <CoverThumb
                    key={c.id}
                    candidate={c}
                    ratio={ratio}
                    canRegenerate={canGenerate}
                    isThumbnail={Boolean(c.imageUrl) && c.imageUrl === selectedByRatio[ratio]}
                    busy={studio.busyCandidateIds.includes(c.id)}
                    onSelect={() => onSelectRatio(ratio, c.imageUrl)}
                    onRegenerate={() => void studio.regenerateOne(c.id)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
