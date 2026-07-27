import { useEffect, useMemo, useState } from 'react';
import { getAICardOverlayPosition } from '../lib/ai-card-layout';
import { listStylePresets } from '../lib/card-style-presets';
import { toFileSrc } from '../lib/utils';
import { getVideoProvider } from '../lib/video-gen/registry';
import { loadAISettings, useAIStore } from '../store/ai';
import type { AICard, MediaCardContent, VideoProvider } from '../types/ai';
import type { AssetRecord, CardAssetBinding } from '../types/assets';
import type { MotionCardProductionIssue, MotionCardProductionReport } from '../types/motion';
import {
  BEAT_ROLE_LABELS,
  CARRIER_META,
  EMPHASIS_LABELS,
  parseStoryboard,
  validateStoryboard,
} from '../lib/motion-storyboard';
import { applyStoryboardToCard, canRecompileFromStoryboard } from '../lib/apply-card-storyboard';
import { Alert, Button, Input, NumberField, PillGroup, Select, type PillGroupItem, Textarea } from '../ui';
import { AppIcon } from './AppIcon';
import { StoryboardEditor } from './motion-storyboard/StoryboardEditor';
import type { StoryboardCueOption } from './motion-storyboard/CuePicker';
import {
  ImageCardForm,
  type ImageProviderOption,
} from './media-card/ImageCardForm';
import {
  VideoCardForm,
  type VideoProviderOption,
} from './media-card/VideoCardForm';
import styles from './AICardInspector.module.css';

interface AICardInspectorProps {
  card: AICard | null;
  errorMessage?: string | null;
  isRegenerating?: boolean;
  previewWidth?: number;
  previewHeight?: number;
  showCancel?: boolean;
  onCancel?: () => void;
  onDelete?: () => void;
  onRegenerate: (
    updates: Partial<AICard>,
    options?: { refineExistingMotion?: boolean },
  ) => Promise<AICard | null>;
  onGenerateAnimationDirection?: (card: AICard) => Promise<string>;
  onSave: (cardId: string, updates: Partial<AICard>) => void;
  storyboardCueOptions?: StoryboardCueOption[];
  onOpenAssetCenter?: (assetId?: string) => void;
}

// PillGroup 需要受控的非空值，用哨兵值表示「跟随项目 / 全局」（实际持久化为 undefined）。
const STYLE_INHERIT = '__inherit__';
const STYLE_PRESET_ITEMS: Array<PillGroupItem<string>> = [
  { value: STYLE_INHERIT, label: '跟随项目 / 全局' },
  ...listStylePresets().map((p) => ({ value: p.id, label: p.name })),
];

const DISPLAY_MODES: Array<PillGroupItem<'fullscreen' | 'pip'>> = [
  { value: 'fullscreen' as const, label: '全屏' },
  { value: 'pip' as const, label: '画中画' },
];

const QUALITY_LABEL: Record<MotionCardProductionReport['status'], string> = {
  pass: '质检通过',
  acceptable: '可接受',
  risk: '有风险',
  fallback: '保底稿',
  failed: '生成失败',
};

function productionIssues(report: MotionCardProductionReport): MotionCardProductionIssue[] {
  return [
    ...report.lintIssues,
    ...report.layoutIssues,
    ...report.reviewIssues,
    ...(report.assetIssues ?? []),
  ];
}

function issueSourceLabel(source: MotionCardProductionIssue['source']): string {
  if (source === 'lint') return '静态检查';
  if (source === 'layout') return '布局探针';
  if (source === 'render') return '渲染';
  if (source === 'review') return '审查';
  if (source === 'storyboard') return '分镜';
  if (source === 'visual-review') return '视觉审查';
  if (source === 'asset') return '资产检查';
  return '视觉审片';
}

export function AICardInspector({
  card,
  errorMessage = null,
  isRegenerating = false,
  previewWidth = 1_920,
  previewHeight = 1_080,
  showCancel = false,
  onCancel,
  onDelete,
  onRegenerate,
  onGenerateAnimationDirection,
  onSave,
  storyboardCueOptions,
  onOpenAssetCenter,
}: AICardInspectorProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [cardPrompt, setCardPrompt] = useState('');
  const [isGeneratingDirection, setIsGeneratingDirection] = useState(false);
  const [isSculpting, setIsSculpting] = useState(false);
  const [showStoryboardJson, setShowStoryboardJson] = useState(false);
  // 分镜编辑态：草稿只存内存，唯一出口是「生成动画」；取消 / 切卡直接丢弃。
  const [storyboardEditing, setStoryboardEditing] = useState(false);
  const [storyboardDraft, setStoryboardDraft] = useState('');
  const [storyboardApplyError, setStoryboardApplyError] = useState<string | null>(null);
  const [stylePresetId, setStylePresetId] = useState<string | undefined>(undefined);
  const [displayMode, setDisplayMode] = useState<'fullscreen' | 'pip'>('fullscreen');
  const [displayDurationMs, setDisplayDurationMs] = useState(5_000);
  const [motionAssets, setMotionAssets] = useState<AssetRecord[]>([]);
  const currentProjectDir = useAIStore((state) => state.currentProjectDir);
  const projectStylePresetId = useAIStore((state) => state.projectStylePresetId);

  useEffect(() => {
    if (!card) {
      return;
    }

    setTitle(card.title);
    setContent(
      typeof card.content === 'string' ? card.content : JSON.stringify(card.content, null, 2),
    );
    setCardPrompt(card.cardPrompt ?? '');
    setStoryboardEditing(false);
    setStoryboardDraft('');
    setStoryboardApplyError(null);
    setShowStoryboardJson(false);
    setStylePresetId(card.stylePresetId);
    setDisplayMode(card.displayMode);
    setDisplayDurationMs(card.displayDurationMs);
  }, [card]);

  useEffect(() => {
    if (!card?.assetBindings?.length || !window.electronAPI?.getAssetLibraryState) {
      setMotionAssets([]);
      return;
    }
    let cancelled = false;
    void window.electronAPI.getAssetLibraryState(currentProjectDir).then((state) => {
      if (!cancelled) setMotionAssets(state.library.assets.filter((asset) => asset.kind === 'image'));
    }).catch(() => {
      if (!cancelled) setMotionAssets([]);
    });
    return () => {
      cancelled = true;
    };
  }, [card?.assetBindings, currentProjectDir]);

  if (!card) {
    return null;
  }

  if (card.type === 'image') {
    return (
      <ImageCardFormHost
        card={card}
        onClose={onCancel ?? (() => undefined)}
        onSave={onSave}
      />
    );
  }

  if (card.type === 'video') {
    return (
      <VideoCardFormHost
        card={card}
        onClose={onCancel ?? (() => undefined)}
        onSave={onSave}
      />
    );
  }

  // 内容原本是结构化对象（如 DataContent）时尝试按 JSON 解析用户编辑结果，失败则保留原值。
  const parsedContent =
    typeof card.content === 'object'
      ? (() => {
          try {
            return JSON.parse(content);
          } catch {
            return card.content;
          }
        })()
      : content;

  // 持久化态分镜（只读展示与资产重生依据）；分镜草稿只在编辑态存在。
  const persistedStoryboard =
    card.motionCard?.storyboard ?? parseStoryboard(card.animationDirection ?? '');
  const persistedDirection =
    card.animationDirection ??
    (persistedStoryboard ? JSON.stringify(persistedStoryboard, null, 2) : '');

  const draftStoryboard = storyboardEditing ? parseStoryboard(storyboardDraft) : null;
  const draftValidation = draftStoryboard
    ? validateStoryboard(draftStoryboard, { cueCount: storyboardCueOptions?.length ?? 0 })
    : null;
  const canApplyStoryboard = Boolean(draftValidation?.ok);
  const recompilable = canRecompileFromStoryboard(card);

  // 通用「保存」只负责文字内容 / 风格 / 展示设置，不触碰分镜与动画。
  const draftUpdates: Partial<AICard> = {
    title,
    content: parsedContent,
    stylePresetId,
    displayMode,
    displayDurationMs,
    cardPrompt: cardPrompt.trim() || undefined,
  };

  const motion = card.motionCard;
  const hasCompiledMotion = Boolean(motion?.tsx?.trim());
  const storyboardHistory = motion?.storyboardHistory ?? [];
  const productionReport = motion?.productionReport;
  const productionReportIssues = productionReport ? productionIssues(productionReport) : [];
  const previewCardPosition = getAICardOverlayPosition(displayMode, previewWidth, previewHeight);
  const previewFrameStyle =
    displayMode === 'fullscreen'
      ? undefined
      : {
          left: `${(previewCardPosition.x / Math.max(1, previewWidth)) * 100}%`,
          top: `${(previewCardPosition.y / Math.max(1, previewHeight)) * 100}%`,
          width: `${(previewCardPosition.width / Math.max(1, previewWidth)) * 100}%`,
        };

  const handleRegenerateClick = async () => {
    await onRegenerate(draftUpdates);
  };

  const handleSculptClick = async () => {
    setIsSculpting(true);
    try {
      await onRegenerate(draftUpdates, { refineExistingMotion: true });
    } finally {
      setIsSculpting(false);
    }
  };

  const handleEnterStoryboardEdit = () => {
    setStoryboardDraft(persistedDirection);
    setStoryboardApplyError(null);
    setStoryboardEditing(true);
  };

  const handleCancelStoryboardEdit = () => {
    setStoryboardEditing(false);
    setStoryboardDraft('');
    setStoryboardApplyError(null);
  };

  // 生成分镜（LLM）：产出进入编辑态草稿，由用户确认后再「生成动画」。
  const handleGenerateDirection = async () => {
    if (!card || !onGenerateAnimationDirection) return;
    setIsGeneratingDirection(true);
    try {
      const text = await onGenerateAnimationDirection(card);
      setStoryboardDraft(text);
      setStoryboardApplyError(null);
      setStoryboardEditing(true);
    } finally {
      setIsGeneratingDirection(false);
    }
  };

  // 唯一出口：模板卡确定性重编译（即时生效）；精雕卡落盘草案后走精雕管线。
  const handleApplyStoryboard = async () => {
    if (!draftStoryboard) {
      setStoryboardApplyError('分镜 JSON 解析失败，无法生成动画');
      return;
    }
    try {
      const result = applyStoryboardToCard(card, draftStoryboard, stylePresetId ?? projectStylePresetId);
      setStoryboardEditing(false);
      setStoryboardDraft('');
      setStoryboardApplyError(null);
      if (result.mode === 'recompiled') {
        onSave(card.id, result.updates);
        return;
      }
      onSave(card.id, result.updates);
      setIsSculpting(true);
      try {
        await onRegenerate(result.updates, { refineExistingMotion: true });
      } finally {
        setIsSculpting(false);
      }
    } catch (error) {
      setStoryboardApplyError(error instanceof Error ? error.message : '生成动画失败');
    }
  };

  const handleRestoreStoryboard = () => {
    const last = storyboardHistory[storyboardHistory.length - 1];
    if (!last || !card.motionCard) return;
    const restoredDirection = last.storyboard
      ? JSON.stringify(last.storyboard, null, 2)
      : persistedDirection;
    const restoredMotionCard = {
      ...card.motionCard,
      ...(last.tsx ? { tsx: last.tsx } : {}),
      ...(last.storyboard ? { storyboard: last.storyboard } : {}),
      storyboardHistory: storyboardHistory.slice(0, -1),
    };
    onSave(card.id, {
      animationDirection: restoredDirection,
      motionCard: restoredMotionCard,
    });
  };

  const replaceAssetBinding = (binding: CardAssetBinding, assetId: string) => {
    const asset = motionAssets.find((item) => item.id === assetId);
    if (!asset) return;
    const bindings = (card.assetBindings ?? []).map((item) => item.slot === binding.slot
      ? {
          ...item,
          assetId: asset.id,
          filePath: asset.files.processed || asset.files.thumbnail || asset.files.original,
          treatment: asset.treatment,
          metadata: {
            width: asset.metadata.width,
            height: asset.metadata.height,
            hasAlpha: asset.metadata.hasAlpha,
            processedAt: asset.metadata.processedAt,
            processedColorKey: asset.metadata.processedColorKey,
          },
        }
      : item);
    onSave(card.id, { assetBindings: bindings });
  };

  const regenerateAssetBinding = async (binding: CardAssetBinding) => {
    if (!persistedStoryboard?.assets?.length) return;
    const storyboard = {
      ...persistedStoryboard,
      assets: persistedStoryboard.assets.map((request) => request.slot === binding.slot
        ? { ...request, reusePolicy: 'always-generate' as const }
        : request),
    };
    await onRegenerate({
      ...draftUpdates,
      animationDirection: JSON.stringify(storyboard, null, 2),
      motionCard: card.motionCard ? { ...card.motionCard, storyboard } : undefined,
    });
  };

  return (
    <div className={styles.root}>
      {errorMessage ? <Alert variant="error" description={errorMessage} /> : null}

      <div className={styles.section} data-ai-card-section="text-content">
        <span className={styles.sectionTitle}>文字内容</span>

        <label className={styles.fieldStack}>
          <span className={styles.fieldLabel}>卡片风格</span>
          <PillGroup
            items={STYLE_PRESET_ITEMS}
            value={stylePresetId ?? STYLE_INHERIT}
            onChange={(value) => setStylePresetId(value === STYLE_INHERIT ? undefined : value)}
            size="sm"
            className={styles.pillRow}
            itemClassName={styles.pillItem}
          />
        </label>

        <label className={styles.fieldStack}>
          <span className={styles.fieldLabel}>标题</span>
          <Input
            size="sm"
            value={title}
            className={styles.textInput}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label className={styles.fieldStack}>
          <span className={styles.fieldLabel}>内容</span>
          <Textarea
            size="sm"
            value={content}
            rows={5}
            resize="none"
            className={styles.textArea}
            onChange={(event) => setContent(event.target.value)}
          />
        </label>

        <label className={styles.fieldStack}>
          <span className={styles.fieldLabel}>追加提示词</span>
          <Textarea
            size="sm"
            value={cardPrompt}
            rows={3}
            resize="none"
            className={styles.promptArea}
            placeholder="输入额外的生成指导…"
            onChange={(event) => setCardPrompt(event.target.value)}
          />
        </label>

      </div>

      <div className={styles.section} data-ai-card-section="storyboard">
        <div className={styles.sectionHeaderRow}>
          <span className={styles.sectionTitle}>分镜</span>
          {!storyboardEditing ? (
            <div className={styles.sectionHeaderActions}>
              {storyboardHistory.length > 0 ? (
                <Button
                  variant="ghost"
                  size="xs"
                  leftIcon={<AppIcon name="refresh-cw" size={12} />}
                  onClick={handleRestoreStoryboard}
                >
                  回退上一版
                </Button>
              ) : null}
              <Button
                variant="secondary"
                size="xs"
                leftIcon={<AppIcon name="sparkles" size={12} />}
                disabled={isGeneratingDirection}
                onClick={() => {
                  void handleGenerateDirection();
                }}
              >
                {isGeneratingDirection ? '生成分镜中…' : '生成分镜'}
              </Button>
              <Button
                variant="secondary"
                size="xs"
                leftIcon={<AppIcon name="pencil-line" size={12} />}
                onClick={handleEnterStoryboardEdit}
              >
                编辑分镜
              </Button>
            </div>
          ) : null}
        </div>

        {!storyboardEditing ? (
          persistedStoryboard ? (
            <div className={styles.storyboardSummary} data-storyboard-view="summary">
              <div className={styles.summaryMetaRow}>
                <span className={styles.summaryCarrier}>
                  {CARRIER_META[persistedStoryboard.carrier]?.label ?? persistedStoryboard.carrier}
                </span>
                <span className={styles.summaryMeta}>{persistedStoryboard.carrier}</span>
                {persistedStoryboard.focus?.emphasis ? (
                  <span className={styles.summaryMeta}>
                    强调 {EMPHASIS_LABELS[persistedStoryboard.focus.emphasis]}
                  </span>
                ) : null}
              </div>
              {persistedStoryboard.claim ? (
                <p className={styles.summaryClaim}>{persistedStoryboard.claim}</p>
              ) : null}
              {persistedStoryboard.scene ? (
                <p className={styles.summaryScene}>{persistedStoryboard.scene}</p>
              ) : null}
              <div className={styles.summaryBeats}>
                {persistedStoryboard.beats.map((beat, index) => (
                  <div className={styles.summaryBeat} key={index}>
                    <span className={styles.summaryBeatIndex}>#{index}</span>
                    <span className={styles.summaryBeatRole}>
                      {beat.role ? BEAT_ROLE_LABELS[beat.role] : '—'}
                    </span>
                    <span className={styles.summaryBeatText}>{beat.adds || beat.motion || '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className={styles.summaryEmpty}>
              尚未生成分镜；可先「生成分镜」，或「编辑分镜」手动编写。
            </p>
          )
        ) : (
          <>
            <StoryboardEditor
              value={storyboardDraft}
              cueCount={storyboardCueOptions?.length}
              cueOptions={storyboardCueOptions}
              onChange={setStoryboardDraft}
            />

            <div className={styles.jsonSource}>
              <Button
                variant="ghost"
                size="xs"
                className={styles.jsonToggle}
                leftIcon={<AppIcon name={showStoryboardJson ? 'chevron-down' : 'chevron-right'} size={12} />}
                onClick={() => setShowStoryboardJson((open) => !open)}
              >
                JSON 源码
              </Button>
              {showStoryboardJson ? (
                <Textarea
                  size="sm"
                  value={storyboardDraft}
                  rows={8}
                  resize="vertical"
                  className={styles.promptArea}
                  placeholder="分镜 JSON；一般通过上方结构化编辑器修改，仅调试时直接编辑。"
                  onChange={(event) => setStoryboardDraft(event.target.value)}
                />
              ) : null}
            </div>

            {storyboardApplyError ? (
              <Alert variant="error" description={storyboardApplyError} />
            ) : null}

            <div className={styles.actions}>
              <Button
                variant="primary"
                size="sm"
                className={styles.actionBtn}
                leftIcon={<AppIcon name="sparkles" size={12} />}
                disabled={!canApplyStoryboard || isSculpting || isRegenerating}
                title={
                  recompilable
                    ? '按当前分镜确定性重编译动画，立即生效'
                    : '此卡动画经过精雕，将按新分镜重新精雕（耗时较长）'
                }
                onClick={() => {
                  void handleApplyStoryboard();
                }}
              >
                {isSculpting ? '正在生成…' : recompilable ? '生成动画' : '生成并精雕'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className={styles.actionBtn}
                onClick={handleCancelStoryboardEdit}
              >
                取消
              </Button>
            </div>
          </>
        )}
      </div>

      <div className={styles.section} data-ai-card-section="display-settings">
        <span className={styles.sectionTitle}>展示设置</span>

        <PillGroup
          items={DISPLAY_MODES}
          value={displayMode}
          onChange={setDisplayMode}
          size="sm"
          fullWidth
          className={styles.pillRow}
          itemClassName={styles.pillItem}
        />

        <div className={styles.inlineFieldRow}>
          <span className={styles.fieldLabel}>时长</span>
          <span className={styles.inlineSpacer} />
          <NumberField
            value={displayDurationMs / 1_000}
            min={1}
            step={0.5}
            unit="秒"
            className={styles.durationField}
            onChange={(value) => setDisplayDurationMs(value * 1_000)}
          />
        </div>
      </div>

      {card.assetBindings?.length ? (
        <div className={styles.section} data-ai-card-section="external-assets">
          <div className={styles.sectionHeaderRow}>
            <span className={styles.sectionTitle}>外部资产</span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onOpenAssetCenter?.(card.assetBindings?.[0]?.assetId)}
            >
              资产中心
            </Button>
          </div>
          <div className={styles.assetBindingList}>
            {card.assetBindings.map((binding) => (
              <div key={binding.slot} className={styles.assetBindingRow}>
                <div className={styles.assetBindingHeader}>
                  <span className={styles.assetBindingName}>
                    {binding.request?.query ?? binding.slot}
                  </span>
                  <span className={styles.assetBindingMeta}>
                    {binding.placement.depth ?? 'midground'} · {binding.treatment.profile}
                  </span>
                </div>
                <Select
                  value={binding.assetId}
                  aria-label={`替换${binding.request?.query ?? binding.slot}`}
                  onChange={(event) => replaceAssetBinding(binding, event.target.value)}
                  options={motionAssets.map((asset) => ({ value: asset.id, label: asset.name }))}
                />
                <div className={styles.assetBindingActions}>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => onOpenAssetCenter?.(binding.assetId)}
                  >
                    查看
                  </Button>
                  <Button
                    variant="secondary"
                    size="xs"
                    disabled={isRegenerating}
                    onClick={() => void regenerateAssetBinding(binding)}
                  >
                    重生资产
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className={styles.section} data-ai-card-section="preview">
        <span className={styles.sectionTitle}>Motion 卡片状态</span>

        <div className={styles.previewFrameShell} data-ai-card-preview-frame="true">
          <div
            className={styles.previewStage}
            style={{ aspectRatio: `${Math.max(1, previewWidth)} / ${Math.max(1, previewHeight)}` }}
          >
            <div className={styles.previewCanvas} />
            <div
              className={[
                styles.previewFrame,
                displayMode === 'fullscreen'
                  ? styles.previewFrameFullscreen
                  : styles.previewFramePip,
              ].join(' ')}
              style={previewFrameStyle}
            >
              <div className={styles.previewPlaceholder}>
                <AppIcon name="eye" size={20} className={styles.previewIcon} />
                <span className={styles.previewHint}>
                  {hasCompiledMotion ? 'Motion 卡片已就绪' : '尚未生成 Remotion 动画'}
                </span>
                <span className={styles.previewBadge}>
                  {displayMode === 'fullscreen' ? '全屏模式' : '画中画模式'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {productionReport ? (
          <div
            className={styles.productionReport}
            data-ai-card-production-report="true"
            data-quality-status={productionReport.status}
          >
            <div className={styles.productionReportHeader}>
              <span className={styles.productionStatus}>
                {QUALITY_LABEL[productionReport.status]}
              </span>
              <span className={styles.productionMeta}>
                修复 {productionReport.fixRounds} 轮 · 审查 {productionReport.reviewRounds} 轮
              </span>
            </div>
            <div className={styles.productionMeta}>
              关键帧 {productionReport.framesChecked.length} 个
              {productionReport.fallbackUsed ? ' · 已使用确定性保底卡' : ''}
              {productionReport.visualReviewAvailable === false ? ' · 视觉审片暂未启用' : ''}
            </div>
            {productionReport.contactSheetPath || productionReport.contactSheetError ? (
              <div className={styles.productionMeta}>
                {productionReport.contactSheetPath
                  ? `缩略审片图已生成${productionReport.contactSheetCached ? '（缓存）' : ''}`
                  : `缩略审片图生成失败：${productionReport.contactSheetError}`}
              </div>
            ) : null}
            {productionReport.unavailableReason ? (
              <div className={styles.productionMeta}>{productionReport.unavailableReason}</div>
            ) : null}
            {productionReportIssues.length > 0 ? (
              <div className={styles.productionIssueList}>
                {productionReportIssues.slice(0, 3).map((issue, index) => (
                  <div
                    key={`${issue.source}-${issue.code ?? issue.rule ?? index}`}
                    className={styles.productionIssue}
                    data-severity={issue.severity}
                  >
                    <span className={styles.productionIssueSource}>
                      {issueSourceLabel(issue.source)}
                    </span>
                    <span className={styles.productionIssueText}>{issue.message}</span>
                  </div>
                ))}
                {productionReportIssues.length > 3 ? (
                  <span className={styles.productionMeta}>
                    另有 {productionReportIssues.length - 3} 条问题未展开
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className={styles.actions}>
          {showCancel && onCancel ? (
            <Button variant="secondary" size="sm" className={styles.actionBtn} onClick={onCancel}>
              取消
            </Button>
          ) : null}

          <Button
            variant="secondary"
            size="sm"
            className={styles.actionBtn}
            leftIcon={
              <AppIcon
                name="refresh-cw"
                size={12}
                className={isRegenerating ? styles.spin : undefined}
              />
            }
            onClick={() => {
              void handleRegenerateClick();
            }}
            disabled={isRegenerating}
          >
            {isRegenerating ? '重新生成中…' : '重新生成动画'}
          </Button>

          {hasCompiledMotion ? (
            <Button
              variant="secondary"
              size="sm"
              className={styles.actionBtn}
              leftIcon={<AppIcon name="sparkles" size={12} />}
              title="按当前分镜重雕现有动画（雕刻→质检→审查）"
              onClick={() => {
                void handleSculptClick();
              }}
              disabled={isSculpting || isRegenerating}
            >
              {isSculpting ? '正在提交…' : '精雕动画'}
            </Button>
          ) : null}

          <Button
            variant="primary"
            size="sm"
            className={styles.actionBtn}
            leftIcon={<AppIcon name="save" size={12} />}
            onClick={() => {
              onSave(card.id, draftUpdates);
            }}
          >
            保存
          </Button>
        </div>
      </div>

      <div className={styles.section} data-ai-card-section="danger">
        <span className={styles.dangerTitle}>危险操作</span>
        <Button
          variant="destructive"
          size="sm"
          fullWidth
          leftIcon={<AppIcon name="trash-2" size={13} />}
          onClick={() => onDelete?.()}
        >
          删除此卡片
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 私有派发宿主：image / video 媒体卡 Inspector
// ---------------------------------------------------------------------------

function getMediaContent(card: AICard): MediaCardContent | null {
  return card.content && typeof card.content === 'object' && 'mediaType' in card.content
    ? (card.content as MediaCardContent)
    : null;
}

function buildPreviewSrc(
  card: AICard,
  currentProjectDir: string | null,
  pathKey: 'assetPath' | 'posterPath',
): string | null {
  const media = getMediaContent(card);
  if (!media) return null;
  const value =
    pathKey === 'assetPath'
      ? media.assetPath
      : (media.posterPath ?? media.assetPath ?? null);
  if (!value) return null;
  // 已是绝对 URL
  if (value.startsWith('file://') || value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }
  if (!currentProjectDir) return null;
  const abs = `${currentProjectDir.replace(/\/$/, '')}/${value.replace(/^\//, '')}`;
  return toFileSrc(abs);
}

function buildPreviewSrcForPath(value: string | null | undefined, currentProjectDir: string | null): string | null {
  if (!value) return null;
  if (value.startsWith('file://') || value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }
  if (!currentProjectDir) return null;
  const abs = `${currentProjectDir.replace(/\/$/, '')}/${value.replace(/^\//, '')}`;
  return toFileSrc(abs);
}

interface MediaCardFormHostProps {
  card: AICard;
  onClose: () => void;
  onSave: (cardId: string, updates: Partial<AICard>) => void;
}

function ImageCardFormHost({ card, onClose, onSave }: MediaCardFormHostProps) {
  const currentProjectDir = useAIStore((s) => s.currentProjectDir);
  const taskEntry = useAIStore((s) => s.cardMediaTasks[card.id]);
  const updateCard = useAIStore((s) => s.updateCard);
  const regenerateCardMedia = useAIStore((s) => s.regenerateCardMedia);
  const cancelCardMediaGeneration = useAIStore((s) => s.cancelCardMediaGeneration);

  const [imageProviders, setImageProviders] = useState<ImageProviderOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await loadAISettings();
        if (cancelled || !settings) return;
        const opts: ImageProviderOption[] = (settings.imageProviders ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          models: p.models ?? [],
        }));
        setImageProviders(opts);
      } catch {
        // 忽略：保持空数组
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const previewSrc = useMemo(
    () => buildPreviewSrc(card, currentProjectDir, 'assetPath'),
    [card, currentProjectDir],
  );
  const mediaContent = getMediaContent(card);
  const originalPreviewSrc = useMemo(
    () => buildPreviewSrcForPath(mediaContent?.originalAssetPath, currentProjectDir),
    [mediaContent?.originalAssetPath, currentProjectDir],
  );
  const cutoutPreviewSrc = useMemo(
    () => buildPreviewSrcForPath(mediaContent?.cutoutAssetPath, currentProjectDir),
    [mediaContent?.cutoutAssetPath, currentProjectDir],
  );

  return (
    <ImageCardForm
      card={card}
      percent={taskEntry?.percent}
      previewSrc={previewSrc}
      originalPreviewSrc={originalPreviewSrc}
      cutoutPreviewSrc={cutoutPreviewSrc}
      imageProviders={imageProviders}
      onGenerate={(updates) => {
        const contentOverrides = updates.content as MediaCardContent;
        updateCard(card.id, updates);
        void regenerateCardMedia(card.id, contentOverrides);
      }}
      onCancel={() => {
        void cancelCardMediaGeneration(card.id);
      }}
      onClose={onClose}
      onSave={onSave}
    />
  );
}

function getDurationOptionsForProvider(provider: VideoProvider): number[] {
  // 优先：provider.extras.durationOptions（用户在 Settings 里覆写）
  const fromExtras = (provider.extras as Record<string, unknown> | undefined)?.durationOptions;
  if (Array.isArray(fromExtras) && fromExtras.every((v) => typeof v === 'number' && v > 0)) {
    return fromExtras as number[];
  }
  // 次选：从 video-gen 注册表取 capabilities.durationOptions
  try {
    const p = getVideoProvider(provider.type);
    return p.capabilities.durationOptions;
  } catch {
    return [4, 6, 8];
  }
}

function VideoCardFormHost({ card, onClose, onSave }: MediaCardFormHostProps) {
  const currentProjectDir = useAIStore((s) => s.currentProjectDir);
  const taskEntry = useAIStore((s) => s.cardMediaTasks[card.id]);
  const updateCard = useAIStore((s) => s.updateCard);
  const regenerateCardMedia = useAIStore((s) => s.regenerateCardMedia);
  const cancelCardMediaGeneration = useAIStore((s) => s.cancelCardMediaGeneration);

  const [videoProviders, setVideoProviders] = useState<VideoProviderOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await loadAISettings();
        if (cancelled || !settings) return;
        const opts: VideoProviderOption[] = (settings.videoProviders ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          models: p.models ?? [],
          durationOptions: getDurationOptionsForProvider(p),
        }));
        setVideoProviders(opts);
      } catch {
        // 忽略：保持空数组
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const initialDuration = useMemo(() => {
    const media = getMediaContent(card);
    const fromExtras = media?.extraParams?.durationSeconds;
    if (typeof fromExtras === 'number' && fromExtras > 0) return fromExtras;
    if (typeof media?.mediaDurationMs === 'number' && media.mediaDurationMs > 0) {
      return Math.round(media.mediaDurationMs / 1000);
    }
    return 6;
  }, [card]);

  const [durationSeconds, setDurationSeconds] = useState<number>(initialDuration);

  // card 切换或外部 duration 变化时同步
  useEffect(() => {
    setDurationSeconds(initialDuration);
  }, [initialDuration]);

  const previewSrc = useMemo(() => {
    // video 卡 ready 时优先视频本体；其次 poster 兜底（form 内部 video 标签）
    return buildPreviewSrc(card, currentProjectDir, 'assetPath');
  }, [card, currentProjectDir]);

  return (
    <VideoCardForm
      card={card}
      percent={taskEntry?.percent}
      previewSrc={previewSrc}
      videoProviders={videoProviders}
      durationSeconds={durationSeconds}
      onDurationSecondsChange={setDurationSeconds}
      onGenerate={(updates) => {
        const contentOverrides = updates.content as MediaCardContent;
        updateCard(card.id, updates);
        void regenerateCardMedia(card.id, contentOverrides);
      }}
      onCancel={() => {
        void cancelCardMediaGeneration(card.id);
      }}
      onClose={onClose}
      onSave={onSave}
    />
  );
}
