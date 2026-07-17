import { ArrowUpToLine, Clapperboard, Film, Image as ImageIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useAIStore } from '../store/ai';
import { useTimelineStore } from '../store/timeline';
import { buildAICardTimelineDraft, type AICard } from '../types/ai';
import { Badge, Button } from '../ui';
import styles from './EditorShotNavigator.module.css';

interface EditorShotNavigatorProps {
  compact: boolean;
  railHeight?: number;
  inspectedCardId?: string | null;
  onOpenDirector?: () => void;
  onSelectCard: (cardId: string, startMs: number) => void;
}

const EMPTY_CARDS: AICard[] = [];

export function EditorShotNavigator({
  compact,
  railHeight,
  inspectedCardId = null,
  onOpenDirector,
  onSelectCard,
}: EditorShotNavigatorProps) {
  const { sortedCards, placedCardIds, placeUnplacedCards } = useShotNavigationData();
  const unplacedCount = useMemo(
    () => sortedCards.filter((card) => card.enabled && !placedCardIds.has(card.id)).length,
    [placedCardIds, sortedCards],
  );

  return (
    <section
      className={styles.root}
      data-compact={compact ? 'true' : 'false'}
      data-testid="editor-shot-navigator"
      style={compact && railHeight ? { height: railHeight } : undefined}
    >
      <NavigatorHeader
        count={sortedCards.length}
        unplacedCount={unplacedCount}
        onOpenDirector={onOpenDirector}
        onPlaceUnplaced={placeUnplacedCards}
      />
      <NavigatorContent
        cards={sortedCards}
        inspectedCardId={inspectedCardId}
        placedCardIds={placedCardIds}
        onOpenDirector={onOpenDirector}
        onSelectCard={onSelectCard}
      />
    </section>
  );
}

function useShotNavigationData() {
  const cards = useAIStore((state) => state.analysisResult?.cards ?? EMPTY_CARDS);
  const motionBible = useAIStore((state) => state.analysisResult?.motionBible);
  const overlays = useTimelineStore((state) => state.timeline.overlays);
  const addAICardsToTimeline = useTimelineStore((state) => state.addAICardsToTimeline);
  const placedCardIds = useMemo(
    () => new Set((overlays ?? []).flatMap((overlay) => {
      const cardId = overlay.overlayType === 'ai-card' ? overlay.aiCardData?.sourceCardId : null;
      return cardId ? [cardId] : [];
    })),
    [overlays],
  );
  const sortedCards = useMemo(
    () => [...cards].sort((left, right) => left.startMs - right.startMs),
    [cards],
  );
  const placeUnplacedCards = useCallback(() => {
    const drafts = cards
      .filter((card) => card.enabled && !placedCardIds.has(card.id))
      .map((card) => buildAICardTimelineDraft(card, motionBible));
    if (drafts.length > 0) addAICardsToTimeline(drafts);
  }, [addAICardsToTimeline, cards, motionBible, placedCardIds]);
  return { placedCardIds, sortedCards, placeUnplacedCards };
}

function NavigatorHeader({ count, unplacedCount, onOpenDirector, onPlaceUnplaced }: {
  count: number;
  unplacedCount: number;
  onOpenDirector?: () => void;
  onPlaceUnplaced: () => void;
}) {
  return (
    <header className={styles.header}>
      <div className={styles.heading}>
        <Film size={14} />
        <strong>镜头导航</strong>
        <Badge variant="secondary" size="sm">{count}</Badge>
      </div>
      <div className={styles.actions}>
        {unplacedCount > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={onPlaceUnplaced}
            title="把未排布的启用镜头放入时间线"
            data-testid="shot-navigator-place-all"
          >
            <ArrowUpToLine size={13} />
            排布 {unplacedCount}
          </Button>
        ) : null}
        {onOpenDirector ? (
          <Button variant="ghost" size="sm" onClick={onOpenDirector}>
            <Clapperboard size={13} />
            导演台
          </Button>
        ) : null}
      </div>
    </header>
  );
}

function NavigatorContent({
  cards,
  inspectedCardId,
  placedCardIds,
  onOpenDirector,
  onSelectCard,
}: {
  cards: AICard[];
  inspectedCardId: string | null;
  placedCardIds: Set<string>;
  onOpenDirector?: () => void;
  onSelectCard: (cardId: string, startMs: number) => void;
}) {
  if (cards.length === 0) return <NavigatorEmpty onOpenDirector={onOpenDirector} />;
  return (
    <nav className={styles.list} aria-label="镜头列表">
      {cards.map((card, index) => (
        <ShotRow
          key={card.id}
          card={card}
          index={index}
          active={card.id === inspectedCardId}
          placed={placedCardIds.has(card.id)}
          onSelect={onSelectCard}
        />
      ))}
    </nav>
  );
}

function NavigatorEmpty({ onOpenDirector }: { onOpenDirector?: () => void }) {
  return (
    <div className={styles.empty}>
      <Film size={18} />
      <span>尚无可导航镜头</span>
      {onOpenDirector ? (
        <Button variant="secondary" size="sm" onClick={onOpenDirector}>打开导演台</Button>
      ) : null}
    </div>
  );
}

function ShotRow({
  card,
  index,
  active,
  placed,
  onSelect,
}: {
  card: AICard;
  index: number;
  active: boolean;
  placed: boolean;
  onSelect: (cardId: string, startMs: number) => void;
}) {
  return (
    <button
      type="button"
      className={styles.shot}
      data-active={active ? 'true' : 'false'}
      data-enabled={card.enabled ? 'true' : 'false'}
      onClick={() => onSelect(card.id, card.startMs)}
      aria-current={active ? 'true' : undefined}
    >
      <span className={styles.index}>{String(index + 1).padStart(2, '0')}</span>
      <span className={styles.shotBody}>
        <strong>{card.title || `镜头 ${index + 1}`}</strong>
        <span className={styles.meta}>
          {formatTime(card.startMs)} - {formatTime(card.endMs)}
        </span>
      </span>
      <span className={styles.state} title={placed ? '已在时间线' : '尚未加入时间线'}>
        {card.type === 'image' ? <ImageIcon size={13} /> : <Film size={13} />}
        <span>{placed ? '已排布' : '未排布'}</span>
      </span>
    </button>
  );
}

function formatTime(valueMs: number): string {
  const seconds = Math.max(0, Math.floor(valueMs / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
