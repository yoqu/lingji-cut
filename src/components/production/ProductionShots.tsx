import { useEffect, useState } from 'react';
import type { AICard, MediaCardContent } from '../../types/ai';
import type { MotionProductionPlan, VisualShot } from '../../types/production';
import { Button, Textarea } from '../../ui';
import { formatTime, toFileSrc } from '../../lib/utils';
import styles from './ProductionContent.module.css';

function ShotRow({
  shot,
  card,
  projectDir,
  onOpen,
  onPromptChange,
}: {
  shot: VisualShot;
  card?: AICard;
  projectDir: string;
  onOpen?: (cardId: string) => void;
  onPromptChange: (requestId: string, query: string) => void;
}) {
  const media = mediaContent(card);
  const status = shotStatus(card, shot);
  const preview = mediaPreview(media, projectDir);
  return (
    <article className={styles.shotRow}>
      <div className={styles.shotHeader}>
        <div>
          <strong>{card?.title || shot.id}</strong>
          <span>{formatTime(shot.startMs)}–{formatTime(shot.endMs)}</span>
        </div>
        <Button variant="ghost" size="xs" disabled={!card} onClick={() => card && onOpen?.(card.id)}>镜头详情</Button>
      </div>
      <div className={styles.shotMeta}>
        <span>{shot.purpose}</span><span>{shot.carrier}</span><span>强度 {shot.intensity}</span>
        <span className={status.ready ? styles.readyStatus : styles.missingStatus}>{status.label}</span>
      </div>
      {preview ? <img className={styles.shotPreview} src={preview} alt="" /> : null}
      <ol className={styles.beatList}>
        {shot.beats.map((beat, index) => (
          <li key={`${beat.role}-${index}`}>
            <span>{beat.role}</span><span>{beat.description}</span>
          </li>
        ))}
      </ol>
      {shot.assetRequests.map((request) => (
        <PromptEditor
          key={request.id}
          label={`${request.kind} · ${request.role}`}
          value={request.query}
          onCommit={(query) => onPromptChange(request.id, query)}
        />
      ))}
      {card?.motionCard?.prompt ? (
        <details className={styles.promptDetails}>
          <summary>查看卡片生成提示词</summary>
          <pre>{card.motionCard.prompt}</pre>
        </details>
      ) : null}
    </article>
  );
}

function mediaContent(card?: AICard): MediaCardContent | null {
  const content = card?.content;
  return content && typeof content === 'object' && 'mediaType' in content
    ? content as MediaCardContent
    : null;
}

function shotStatus(card: AICard | undefined, shot: VisualShot): { ready: boolean; label: string } {
  if (!card) return { ready: false, label: '镜头数据缺失' };
  const media = mediaContent(card);
  if (media) {
    if (media.generationStatus === 'ready' && media.assetPath) return { ready: true, label: '素材已就绪' };
    if (media.generationStatus === 'failed') return { ready: false, label: '素材生成失败' };
    return { ready: false, label: media.generationStatus === 'generating' ? '素材生成中' : '待生成素材' };
  }
  if (shot.assetRequests.length > 0 && !(card.assetBindings?.length)) return { ready: false, label: '待解析素材' };
  if (card.motionCard?.productionReport?.status === 'failed') return { ready: false, label: '镜头质检失败' };
  return { ready: true, label: card.motionCard?.productionReport?.status === 'risk' ? '镜头需复核' : '镜头已就绪' };
}

function mediaPreview(media: MediaCardContent | null, projectDir: string): string | null {
  const value = media?.mediaType === 'video' ? media.posterPath ?? media.assetPath : media?.assetPath;
  if (!value) return null;
  if (/^(file|https?):\/\//u.test(value)) return value;
  return toFileSrc(`${projectDir.replace(/\/$/u, '')}/${value.replace(/^\//u, '')}`);
}

function PromptEditor({ label, value, onCommit }: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className={styles.promptEditor}>
      <span>{label} 提示词</span>
      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => draft.trim() && draft !== value && onCommit(draft.trim())}
        rows={3}
        size="sm"
        resize="vertical"
      />
    </label>
  );
}

export function ProductionShots({
  plan,
  cards,
  projectDir,
  onOpenCardInspector,
  onPromptChange,
}: {
  plan: MotionProductionPlan;
  cards: AICard[];
  projectDir: string;
  onOpenCardInspector?: (cardId: string) => void;
  onPromptChange: (shotId: string, requestId: string, query: string) => void;
}) {
  const cardMap = new Map(cards.map((card) => [card.id, card]));
  return (
    <div className={styles.view}>
      <div className={styles.viewIntro}>
        <strong>{plan.shots.length} 个视觉镜头</strong>
        <span>每个镜头独立检查节奏、素材 prompt 和卡片生成 prompt</span>
      </div>
      <div className={styles.shotList}>
        {plan.shots.map((shot) => (
          <ShotRow
            key={shot.id}
            shot={shot}
            card={cardMap.get(shot.id)}
            projectDir={projectDir}
            onOpen={onOpenCardInspector}
            onPromptChange={(requestId, query) => onPromptChange(shot.id, requestId, query)}
          />
        ))}
      </div>
    </div>
  );
}
