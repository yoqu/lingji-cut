import { useEffect, useState } from 'react';
import type { CoverCandidate } from '../types/ai';
import { toFileSrc } from '../lib/utils';
import { Button, Textarea } from '../ui';
import { AppIcon } from './AppIcon';
import styles from './AICoverPanel.module.css';

interface AICoverPanelProps {
  coverPrompts: string[];
  candidates: CoverCandidate[];
  isGenerating: boolean;
  isRegeneratingPrompt: boolean;
  selectedCandidateId?: string;
  onGenerateCovers: (prompts: string[]) => void | Promise<unknown>;
  onSavePrompt: (prompts: string[]) => void | Promise<unknown>;
  onRegeneratePrompt: () => void;
  onSelectCover: (candidateId: string) => void;
  onAddToTimeline: (candidateId: string) => void;
  onEditCover: (candidateId: string) => void;
}

export function AICoverPanel({
  coverPrompts,
  candidates,
  isGenerating,
  isRegeneratingPrompt,
  selectedCandidateId,
  onGenerateCovers,
  onSavePrompt,
  onRegeneratePrompt,
  onSelectCover,
  onAddToTimeline,
  onEditCover,
}: AICoverPanelProps) {
  const [editablePrompt, setEditablePrompt] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isSavingPrompt, setIsSavingPrompt] = useState(false);
  const selectedCandidate =
    candidates.find((candidate) => candidate.id === selectedCandidateId) ??
    candidates.find((candidate) => candidate.selected) ??
    null;

  useEffect(() => {
    if (!isEditing) {
      setEditablePrompt(coverPrompts[0] ?? '');
    }
  }, [coverPrompts, isEditing]);

  if (coverPrompts.length === 0 && candidates.length === 0) {
    return (
      <div className={styles.emptyState} data-ai-cover-root="true">
        <div className={styles.emptyTitle}>还没有封面提示词</div>
        <div className={styles.emptyText}>先在「内容卡片」tab 中分析 SRT，AI 会自动生成封面提示词。</div>
      </div>
    );
  }

  const prompt = isEditing ? editablePrompt : coverPrompts[0] ?? '';
  const prompts = prompt.trim() ? [prompt.trim()] : [];
  const savedPrompt = coverPrompts[0]?.trim() ?? '';
  const editedPrompt = editablePrompt.trim();
  const hasPromptChanges = editedPrompt !== savedPrompt;
  const isBusy = isGenerating || isRegeneratingPrompt || isSavingPrompt;

  const handleSavePrompt = async () => {
    if (prompts.length === 0) {
      return;
    }

    setIsSavingPrompt(true);
    try {
      await onSavePrompt(prompts);
      setIsEditing(false);
    } catch {
      // 父级已负责展示错误；这里保留编辑态，方便继续修改。
    } finally {
      setIsSavingPrompt(false);
    }
  };

  const handleGenerateCoversClick = async () => {
    if (prompts.length === 0) {
      return;
    }

    await onGenerateCovers(prompts);
    setIsEditing(false);
  };

  return (
    <div className={styles.root} data-ai-cover-root="true">
      <section className={styles.promptSection} data-ai-cover-prompt="true">
        <div className={styles.promptHeader}>
          <div className={styles.promptTitle}>提示词</div>
          <Button.Icon
            variant="ghost"
            className={styles.headerAction}
            onClick={() => setIsEditing((current) => !current)}
            aria-label={isEditing ? '完成提示词编辑' : '编辑提示词'}
            title={isEditing ? '完成提示词编辑' : '编辑提示词'}
          >
            <AppIcon name="pencil-line" size={14} />
          </Button.Icon>
        </div>

        <div className={styles.promptCard}>
          {isEditing ? (
            <>
              <Textarea
                value={editablePrompt}
                onChange={(event) => setEditablePrompt(event.target.value)}
                rows={4}
                size="sm"
                resize="vertical"
                className={styles.promptTextarea}
                placeholder="描述你想生成的封面氛围和构图方向…"
              />
              <div className={styles.editActions}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditablePrompt(coverPrompts[0] ?? '');
                    setIsEditing(false);
                  }}
                  disabled={isBusy}
                >
                  取消
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleSavePrompt}
                  disabled={isBusy || prompts.length === 0 || !hasPromptChanges}
                  loading={isSavingPrompt}
                  loadingText="保存中"
                >
                  <AppIcon name="save" size={12} />
                  保存提示词
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className={styles.promptText}>{prompt}</div>
              <div className={styles.promptActions}>
                <Button
                  variant="link"
                  size="sm"
                  className={styles.inlineAction}
                  onClick={onRegeneratePrompt}
                  disabled={isRegeneratingPrompt || isGenerating || isSavingPrompt}
                  aria-label="AI 重新生成提示词"
                  title="AI 重新生成提示词"
                >
                  <AppIcon name="sparkles" size={12} />
                  {isRegeneratingPrompt ? '生成中...' : 'AI 重写提示词'}
                </Button>
              </div>
            </>
          )}
        </div>
      </section>

      <Button
        variant="primary"
        size="sm"
        className={styles.generateButton}
        onClick={() => void handleGenerateCoversClick()}
        disabled={isBusy || prompts.length === 0}
      >
        <AppIcon name="image" size={14} />
        <span>{isGenerating ? '生成中...' : '生成封面图'}</span>
      </Button>

      {candidates.length > 0 ? (
        <>
          <section className={styles.candidateSection}>
            <div className={styles.candidateHeader}>
              <div className={styles.candidateTitle}>候选封面</div>
              <div className={styles.candidateHint}>可直接拖到时间轴，也可以一键设为整期背景。</div>
            </div>

            <div className={styles.grid} data-ai-cover-grid="true">
              {candidates.map((candidate) => {
                const isSelected = candidate.id === selectedCandidate?.id;

                return (
                  <div
                    key={candidate.id}
                    draggable={Boolean(candidate.imageUrl)}
                    onClick={() => onSelectCover(candidate.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelectCover(candidate.id);
                      }
                    }}
                    onDragStart={(event) => {
                      if (!candidate.imageUrl) {
                        event.preventDefault();
                        return;
                      }

                      event.dataTransfer.effectAllowed = 'copy';
                      event.dataTransfer.setData(
                        'application/json',
                        JSON.stringify({
                          path: candidate.imageUrl,
                          type: 'image',
                          durationMs: 0,
                          overlayRole: 'default-background',
                        }),
                      );
                    }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    className={joinClassNames(
                      styles.candidateCard,
                      isSelected ? styles.candidateSelected : '',
                    )}
                    data-ai-cover-selected={isSelected ? 'true' : undefined}
                    data-draggable={Boolean(candidate.imageUrl)}
                  >
                    {candidate.imageUrl ? (
                      <>
                        <img
                          src={buildCandidateImageSrc(candidate.imageUrl, candidate.createdAt)}
                          alt=""
                          className={styles.candidateImage}
                        />
                        <Button.Icon
                          variant="secondary"
                          className={styles.editButton}
                          onClick={(e) => {
                            e.stopPropagation();
                            onEditCover(candidate.id);
                          }}
                          aria-label="编辑此封面"
                          title="编辑此封面"
                        >
                          <AppIcon name="pencil-line" size={12} />
                        </Button.Icon>
                      </>
                    ) : (
                      <div className={styles.candidateFallback}>
                        <AppIcon name="alert-circle" size={16} />
                        <span>{candidate.error ?? '生成失败'}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {selectedCandidate?.imageUrl ? (
            <Button
              variant="primary"
              size="sm"
              className={styles.footerButton}
              onClick={() => onAddToTimeline(selectedCandidate.id)}
            >
              <AppIcon name="send-horizontal" size={14} />
              <span>设为整期背景</span>
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function joinClassNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

/**
 * 构造封面缩略图 src：toFileSrc 会编码路径里的 ?（避免用户文件名含 ? 时的路径错误），
 * 这会把 cache-bust 查询串 ?v=... 破坏。因此把纯路径过 toFileSrc 后再拼查询串，
 * 既能让浏览器忽略 query 正确定位 file://，又能通过 query 变化强制刷新 <img> 缓存。
 */
function buildCandidateImageSrc(imageUrl: string, createdAt?: number): string {
  const base = toFileSrc(imageUrl);
  return createdAt ? `${base}?v=${createdAt}` : base;
}
