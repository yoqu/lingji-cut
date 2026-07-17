import type { MediaCardContent } from '../../types/ai';
import styles from './MediaCardPreview.module.css';

interface Props {
  content: MediaCardContent;
  /** 实际可访问的本地预览 src（file:// 或 http(s):// 或 staticFile 解析后的路径） */
  previewSrc: string | null;
  percent?: number;
}

export function MediaCardPreview({ content, previewSrc, percent }: Props) {
  const mediaLabel = content.mediaType === 'image' ? '图片' : '视频';

  if (content.generationStatus === 'failed') {
    return (
      <div className={styles.errorBox} role="alert" data-testid="media-card-preview">
        <div className={styles.errorTitle}>生成失败</div>
        <div className={styles.stateMessage}>
          {content.errorMessage ?? `生成服务未返回可用的${mediaLabel}。`}
        </div>
        <div className={styles.stateAction}>检查生成描述、服务与模型设置，然后重新生成。</div>
      </div>
    );
  }

  if (content.generationStatus === 'generating' || content.generationStatus === 'pending') {
    return (
      <div
        className={styles.loading}
        role="status"
        aria-live="polite"
        data-testid="media-card-preview"
      >
        <div className={styles.spinner} />
        <div className={styles.loadingLabel}>
          正在生成{mediaLabel} {Math.max(0, Math.min(100, percent ?? 0))}%
        </div>
      </div>
    );
  }

  if (content.generationStatus === 'cancelled') {
    return (
      <div className={styles.placeholder} role="status" data-testid="media-card-preview">
        <div className={styles.stateTitle}>已取消</div>
        <div className={styles.stateMessage}>调整生成描述后，可以重新生成{mediaLabel}。</div>
      </div>
    );
  }

  if (content.generationStatus !== 'ready') {
    return (
      <div className={styles.placeholder} role="status" data-testid="media-card-preview">
        <div className={styles.stateTitle}>尚未生成{mediaLabel}</div>
        <div className={styles.stateMessage}>
          填写生成描述后，点击「生成{mediaLabel}」。
        </div>
      </div>
    );
  }

  if (!previewSrc) {
    return (
      <div className={styles.errorBox} role="alert" data-testid="media-card-preview">
        <div className={styles.errorTitle}>无法显示生成结果</div>
        <div className={styles.stateMessage}>结果文件可能已移动，请重新生成{mediaLabel}。</div>
      </div>
    );
  }

  if (content.mediaType === 'image') {
    return (
      <img
        className={styles.media}
        src={previewSrc}
        alt="图片生成结果"
        data-testid="media-card-preview"
      />
    );
  }

  return (
    <video
      className={styles.media}
      src={previewSrc}
      muted
      controls
      preload="metadata"
      aria-label="视频生成结果"
      data-testid="media-card-preview"
    />
  );
}
