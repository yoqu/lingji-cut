import { AudioLines, ImageIcon, ListVideo, RefreshCw, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { createPersistedAIState } from '../../lib/ai-persistence';
import type { DirectorProductionProgress } from '../../lib/director-production-client';
import { canResumeProduction } from '../../lib/director-workflow';
import { registerProductionSaveGuard } from '../../lib/production-save-guard';
import { toFileSrc } from '../../lib/utils';
import { useAIStore } from '../../store/ai';
import { useTimelineStore } from '../../store/timeline';
import type { ProjectProductionState } from '../../types/director';
import { Alert, Button, PillGroup, Spinner, Textarea } from '../../ui';
import { AICardList } from '../AICardList';
import { ProductionPanel } from '../production/ProductionPanel';
import styles from './DirectorExecutionPanel.module.css';
import { useDirectorCoverControls } from './useDirectorCoverControls';

type ExecutionView = 'cards' | 'cover' | 'audio' | 'quality';

export function DirectorExecutionPanel({
  projectDir,
  production,
  working,
  progress,
  onResume,
  onOpenEditor,
}: {
  projectDir: string;
  production: ProjectProductionState;
  working: boolean;
  progress: Partial<Record<DirectorProductionProgress['track'] | 'director', DirectorProductionProgress>>;
  onResume: () => void;
  onOpenEditor: () => void;
}) {
  const [view, setView] = useState<ExecutionView>('cards');
  const deleteCard = useAIStore((state) => state.deleteCard);
  const cover = useDirectorCoverControls(projectDir, production);
  const { analysisResult, coverCandidates } = cover;
  const cards = analysisResult?.cards ?? [];
  const cardErrors = analysisResult?.cardErrors ?? [];
  const productionGuard = production.approvedPlan
    ? { expectedDirectorRevision: production.approvedPlan.revision }
    : {};
  const removeCard = async (cardId: string) => {
    const releaseGuard = registerProductionSaveGuard(productionGuard);
    try {
      await deleteCard(cardId);
      const ai = useAIStore.getState();
      useTimelineStore.getState().removeAICardOverlaysBySourceIds([cardId]);
      await window.electronAPI.saveProjectSection(
        projectDir,
        'aiAnalysis',
        JSON.stringify(createPersistedAIState(ai.analysisResult, ai.coverCandidates)),
        productionGuard,
      );
    } finally {
      releaseGuard();
    }
  };

  return (
    <section className={styles.root} aria-label="制作执行">
      <div className={styles.header}>
        <div><span>制作执行</span><strong>导演方案 v{production.approvedPlan?.revision}</strong></div>
        <div className={styles.headerActions}>
          {!working && canResumeProduction(production) ? (
            <Button variant="primary" size="sm" onClick={onResume} title="补生成失败镜头并重排时间线">继续制作</Button>
          ) : null}
          {production.workflow.stage === 'animatic-review' ? (
            <Button variant="primary" size="sm" onClick={onOpenEditor}>进入编辑器审查</Button>
          ) : null}
        </div>
      </div>

      {working ? <div className={styles.progressGrid}>
        {(['cards', 'cover', 'highlights', 'audio', 'timeline'] as const).map((track) => (
          <div key={track} className={styles.progressItem}>
            <span>{TRACK_LABELS[track]}</span>
            <div><i style={{ width: `${progress[track]?.percent ?? 0}%` }} /></div>
            <small>{progress[track]?.message ?? '等待开始'}</small>
          </div>
        ))}
      </div> : null}

      <PillGroup
        fullWidth
        wrap={false}
        value={view}
        onChange={setView}
        items={[
          { value: 'cards', label: <><ListVideo size={13} />画面</> },
          { value: 'cover', label: <><ImageIcon size={13} />封面</> },
          { value: 'audio', label: <><AudioLines size={13} />声音</> },
          { value: 'quality', label: <><ShieldCheck size={13} />质检</> },
        ]}
      />

      <div className={styles.content}>
        {view === 'cards' ? (
          <>
            {cardErrors.length > 0 ? (
              <section className={styles.failedPanel} data-testid="director-failed-shots">
                <div className={styles.failedHeader}>
                  <span>失败镜头 {cardErrors.length}（时间线已暂停排布）</span>
                  <Button
                    variant="accent"
                    size="xs"
                    onClick={onResume}
                    disabled={working}
                    title="增量补生成失败镜头；全部通过后自动重排时间线"
                  >
                    <RefreshCw size={12} />重试失败镜头
                  </Button>
                </div>
                <ul className={styles.failedList}>
                  {cardErrors.map((error) => (
                    <li key={error.segmentId}>
                      <strong>
                        {typeof error.segmentIndex === 'number' ? `第 ${error.segmentIndex + 1} 段 · ` : ''}
                        {error.segmentTitle ?? error.segmentId}
                      </strong>
                      <span>{error.message}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {cards.length > 0 ? <AICardList
              cards={cards}
              onToggleEnabled={(cardId) => useAIStore.getState().toggleCardEnabled(cardId)}
              onDeleteCard={(cardId) => void removeCard(cardId)}
              onEditCard={onOpenEditor}
              onSelect={onOpenEditor}
            /> : <Empty text={working ? '正在按导演方案生成画面' : '尚未生成画面'} />}
          </>
        ) : null}
        {view === 'cover' ? <div className={styles.coverWorkspace}>
          <div className={styles.coverActions}>
            <Button variant="secondary" size="sm" onClick={() => void cover.rewritePrompt()} disabled={Boolean(cover.busy) || !analysisResult || cover.entries.length === 0}>
              {cover.busy === 'prompt' ? <Spinner size={13} /> : <RefreshCw size={13} />}重写描述
            </Button>
            <Button variant="primary" size="sm" onClick={() => void cover.generateCovers()} disabled={Boolean(cover.busy) || !analysisResult?.coverPrompts.some((prompt) => prompt.trim())}>
              {cover.busy === 'images' ? <Spinner size={13} /> : <ImageIcon size={13} />}{coverCandidates.length > 0 ? '重新生成封面' : '生成封面'}
            </Button>
          </div>
          {cover.error ? <Alert variant="destructive">{cover.error}</Alert> : null}
          <label className={styles.promptField}>
            <span>封面生成描述</span>
            <Textarea
              defaultValue={analysisResult?.coverPrompts[0] ?? production.approvedPlan?.coverDirection.prompt ?? ''}
              rows={4}
              resize="vertical"
              onBlur={(event) => void cover.savePrompt(event.target.value)}
            />
          </label>
          {coverCandidates.length > 0 ? <div className={styles.coverGrid}>
            {coverCandidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className={styles.coverButton}
                data-selected={candidate.selected}
                aria-pressed={candidate.selected}
                aria-label={`选择封面候选：${candidate.prompt || candidate.id}`}
                onClick={() => void cover.selectCover(candidate.id)}
              >
                {candidate.imageUrl ? <img src={coverSrc(candidate.imageUrl)} alt={candidate.prompt || '封面候选'} /> : <span>{candidate.error ?? '生成失败'}</span>}
              </button>
            ))}
          </div> : <Empty text={working ? '正在生成封面候选' : '尚未生成封面'} />}
        </div> : null}
        {view === 'audio' ? <ProductionPanel projectDir={projectDir} compact={false} fixedView="audio" /> : null}
        {view === 'quality' ? <ProductionPanel projectDir={projectDir} compact={false} fixedView="quality" /> : null}
      </div>
    </section>
  );
}

const TRACK_LABELS = { cards: '画面', cover: '封面', highlights: '高亮', audio: '声音', timeline: '排布' } as const;

function Empty({ text }: { text: string }) {
  return <div className={styles.empty}>{text}</div>;
}

function coverSrc(value: string): string {
  return /^(file|https?):\/\//u.test(value) ? value : toFileSrc(value);
}
