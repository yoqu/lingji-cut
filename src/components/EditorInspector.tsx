import { Button, EmptyState } from '../ui';
import { AgentFeedView } from './agent-feed/AgentFeedView';
import { AICardInspector } from './AICardInspector';
import { AppIcon } from './AppIcon';
import { OverlayInspector } from './OverlayInspector';
import { ProjectOverviewPanel, type ProjectOverviewMeta } from './ProjectOverviewPanel';
import { SubtitleInspector } from './SubtitleInspector';
import { useAICardInspector } from '../hooks/useAICardInspector';
import { useTimelineStore } from '../store/timeline';
import styles from './EditorInspector.module.css';

export type InspectorSelection =
  | { type: 'empty' }
  | { type: 'ai-card'; cardId: string }
  | { type: 'overlay'; overlayId: string }
  | { type: 'subtitle-style' }
  | { type: 'agent-feed' };

interface EditorInspectorProps {
  assetCount?: number;
  isProjectMetaLoading?: boolean;
  overlayCount?: number;
  projectDir?: string;
  projectMeta?: ProjectOverviewMeta | null;
  selection: InspectorSelection;
  timelineWidth: number;
  timelineHeight: number;
  timelineFps?: number;
  onClose: () => void;
  onOpenAssetCenter?: (assetId?: string) => void;
}

export function EditorInspector({
  assetCount = 0,
  isProjectMetaLoading = false,
  selection,
  overlayCount = 0,
  projectDir = '',
  projectMeta = null,
  timelineHeight,
  timelineFps = 30,
  timelineWidth,
  onClose,
  onOpenAssetCenter,
}: EditorInspectorProps) {
  const {
    card,
    cardSequenceLabel,
    deleteCard,
    errorMessage,
    generateAnimationDirection,
    isRegeneratingCard,
    regenerateCard,
    saveCard,
    storyboardCueOptions,
  } = useAICardInspector(selection.type === 'ai-card' ? selection.cardId : null);
  const timeline = useTimelineStore((state) => state.timeline);

  const selectedOverlay =
    selection.type === 'overlay'
      ? timeline.overlays.find((item) => item.id === selection.overlayId) ?? null
      : null;
  const headerTitle =
    selection.type === 'agent-feed'
      ? '生成观测'
      : selection.type === 'subtitle-style'
      ? '字幕样式'
      : selection.type === 'ai-card'
      ? 'AI 卡片'
      : selection.type === 'overlay'
      ? selectedOverlay?.type === 'audio'
        ? '音频'
        : selectedOverlay?.type === 'text'
        ? '文字'
        : '素材图层'
      : '项目概览';

  const indexLabel = selection.type === 'ai-card' ? cardSequenceLabel : null;

  const renderBody = () => {
    if (selection.type === 'agent-feed') {
      // AgentFeedView 根节点是 flex（内部自滚动），block 滚动容器 .body 内需撑满高度
      return (
        <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
          <AgentFeedView />
        </div>
      );
    }

    if (selection.type === 'subtitle-style') {
      return <SubtitleInspector />;
    }

    if (selection.type === 'ai-card') {
      if (!card) {
        return (
          <div className={styles.emptyWrap}>
            <EmptyState
              title="卡片不存在"
              description="当前 AI 卡片可能已被删除，请重新从左侧卡片列表或时间轴中选择。"
            />
          </div>
        );
      }

      return (
        <AICardInspector
          card={card}
          errorMessage={errorMessage}
          isRegenerating={isRegeneratingCard}
          previewWidth={timelineWidth}
          previewHeight={timelineHeight}
          onDelete={() => {
            deleteCard();
            onClose();
          }}
          onRegenerate={regenerateCard}
          onGenerateAnimationDirection={generateAnimationDirection}
          onSave={saveCard}
          onOpenAssetCenter={onOpenAssetCenter}
          storyboardCueOptions={storyboardCueOptions}
        />
      );
    }

    if (selection.type === 'overlay') {
      return (
        <OverlayInspector
          overlayId={selection.overlayId}
          onDelete={() => {
            useTimelineStore.getState().removeOverlay(selection.overlayId);
            onClose();
          }}
        />
      );
    }

    return (
      <ProjectOverviewPanel
        assetCount={assetCount}
        isProjectMetaLoading={isProjectMetaLoading}
        overlayCount={overlayCount}
        projectDir={projectDir}
        projectMeta={projectMeta}
        timelineFps={timelineFps}
        timelineHeight={timelineHeight}
        timelineWidth={timelineWidth}
      />
    );
  };

  return (
    <div
      className={styles.shell}
      data-editor-region="inspector-shell"
    >
      <div className={styles.header}>
        <span className={styles.headerTitle}>{headerTitle}</span>
        <div className={styles.headerRight}>
          {indexLabel ? (
            <span className={styles.indexLabel}>{indexLabel}</span>
          ) : null}
          {selection.type !== 'empty' ? (
            <Button.Icon
              variant="ghost"
              aria-label="关闭右侧配置区"
              title="关闭右侧配置区"
              onClick={onClose}
              className={styles.closeButton}
            >
              <AppIcon name="x" size={14} />
            </Button.Icon>
          ) : null}
        </div>
      </div>

      <div className={styles.body}>{renderBody()}</div>
    </div>
  );
}
