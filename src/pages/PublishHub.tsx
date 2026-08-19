import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, FolderOpen, Loader2, RefreshCw, Send, Sparkles, X } from 'lucide-react';
import { Button, ConfirmDialog } from '../ui';
import { loadAISettings } from '../store/ai';
import { useTaskProgressStore } from '../store/task-progress';
import { getFileNameFromPath, toFileSrc } from '../lib/utils';
import { PLATFORM_LABEL } from '../lib/publish/platform-labels';
import {
  buildHubCoverSource,
  emptyHubJobState,
  hubJobHasDraft,
  type HubJobState,
  type HubJobSummary,
} from '../lib/publish/hub-state';
import { emptyPublishDraft, type PublishDraft } from '../lib/publish/draft';
import type { PublishHistoryEntry } from '../lib/project-persistence';
import type { PublishMetadata } from '../lib/publish-metadata';
import { PublishComposer } from '../components/publish/core/PublishComposer';
import { useWorkdirCoverStudio } from '../components/publish/core/useWorkdirCoverStudio';
import { IngestTracePanel } from '../components/publish/IngestTracePanel';
import { IngestModelSelector } from '../components/publish/IngestModelSelector';
import { failCoverTask, startCoverTask } from '../components/publish/useCoverStudio';
import {
  applyIngestTraceEvent,
  emptyIngestTrace,
  ingestToolLabel,
  type IngestTraceState,
} from '../lib/publish/ingest-trace';
import styles from './PublishHub.module.css';

function formatWhen(ts: number | null): string {
  if (!ts) return '尚未发布';
  return new Date(ts).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function PublishHub({ onBack }: { onBack: () => void }) {
  const [jobs, setJobs] = useState<HubJobSummary[]>([]);
  const [activeDir, setActiveDir] = useState<string | null>(null);
  const [state, setState] = useState<HubJobState>(emptyHubJobState());
  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [coverPromptError, setCoverPromptError] = useState<string | null>(null);
  const [isGeneratingCoverPrompt, setIsGeneratingCoverPrompt] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<HubJobSummary | null>(null);
  const [trace, setTrace] = useState<IngestTraceState>(emptyIngestTrace());
  const hydratedRef = useRef(false);
  const ingestTaskRef = useRef<string | null>(null);

  const draft = state.draft;
  const updateDraft = useCallback((patch: Partial<PublishDraft>) => {
    setState((prev) => ({ ...prev, draft: { ...prev.draft, ...patch } }));
  }, []);

  const refreshList = useCallback(async () => {
    const list = await window.publishAPI.listHubJobs();
    setJobs(list);
  }, []);

  useEffect(() => {
    void refreshList().catch(() => undefined);
  }, [refreshList]);

  useEffect(() => {
    if (!activeDir || !hydratedRef.current) return;
    const timer = setTimeout(() => {
      window.publishAPI.saveHubJob(activeDir, state).then((summary) => {
        setJobs((prev) => {
          const rest = prev.filter((job) => job.workDir !== summary.workDir);
          return [summary, ...rest];
        });
      }).catch(() => undefined);
    }, 600);
    return () => clearTimeout(timer);
  }, [activeDir, state]);

  const runIngest = useCallback(async (workDir: string) => {
    const settings = await loadAISettings();
    if (!settings) throw new Error('请先在「设置 → AI」完成大模型配置');
    const taskId = `publish-ingest-${Date.now()}`;
    ingestTaskRef.current = taskId;
    useTaskProgressStore.getState().startTask({
      id: taskId,
      category: 'publish',
      label: '识别工作目录',
      mode: 'determinate',
      progress: 0,
      phase: '正在查看目录…',
      level: 0,
      canCancel: true,
      onCancel: () => {
        void window.publishAPI.cancelIngest();
      },
    });
    const offProgress = window.publishAPI.onIngestProgress((payload) => {
      if (payload.taskId !== taskId) return;
      useTaskProgressStore.getState().updateTask(taskId, {
        progress: payload.percent,
        phase: payload.toolName ? ingestToolLabel(payload.toolName) : '识别中…',
      });
    });
    const offTrace = window.publishAPI.onIngestEvent((payload) => {
      if (payload.taskId !== taskId) return;
      setTrace((prev) => applyIngestTraceEvent(prev, payload.event));
    });
    setIngesting(true);
    setIngestError(null);
    setTrace(emptyIngestTrace());
    try {
      const next = await window.publishAPI.startIngest({
        taskId,
        workDir,
        settings,
        projectBindings: null,
        telemetryRunId: taskId,
      });
      setState(next);
      useTaskProgressStore.getState().completeTask(taskId);
      await refreshList();
    } catch (error) {
      const message = error instanceof Error ? error.message : '识别工作目录失败';
      setIngestError(message);
      setTrace((prev) => applyIngestTraceEvent(prev, { type: 'error', message }));
      useTaskProgressStore.getState().failTask(taskId, message);
      throw error;
    } finally {
      offProgress();
      offTrace();
      setIngesting(false);
      ingestTaskRef.current = null;
      hydratedRef.current = true;
    }
  }, [refreshList]);

  const openWorkDir = useCallback(async (workDir: string, forceIngest = false) => {
    hydratedRef.current = false;
    setActiveDir(workDir);
    setIngestError(null);
    await window.publishAPI.addHubJob(workDir);
    const loaded = await window.publishAPI.loadHubJob(workDir);
    setState(loaded);
    await refreshList();
    const needsIngest = forceIngest || !hubJobHasDraft(loaded);
    if (needsIngest) {
      await runIngest(workDir);
    } else {
      hydratedRef.current = true;
    }
  }, [refreshList, runIngest]);

  const handlePickDirectory = useCallback(async () => {
    const dir = await window.electronAPI.selectProjectDirectory();
    if (!dir) return;
    await openWorkDir(dir);
  }, [openWorkDir]);

  const handleBackToList = useCallback(() => {
    setActiveDir(null);
    setState(emptyHubJobState());
    hydratedRef.current = false;
    setIngestError(null);
    setTrace(emptyIngestTrace());
    void refreshList();
  }, [refreshList]);

  const generateCoverPrompt = useCallback(async (): Promise<string> => {
    const source = buildHubCoverSource(draft.title, draft.desc);
    if (!source) throw new Error('请先填写标题或简介');
    const settings = await loadAISettings();
    if (!settings) throw new Error('请先在「设置 → AI」完成大模型配置');
    const prompts = await window.electronAPI.regenerateCoverPrompt({
      entries: [{ index: 1, startMs: 0, endMs: 0, text: source }],
      settings,
      currentPrompt: state.coverPrompt.trim() || undefined,
      skipDirectorGate: true,
      workTitle: draft.title.trim() || undefined,
    });
    const prompt = prompts[0]?.trim();
    if (!prompt) throw new Error('LLM 未返回有效的封面提示词');
    setState((prev) => ({ ...prev, coverPrompt: prompt }));
    return prompt;
  }, [draft.title, draft.desc, state.coverPrompt]);

  const handleGenerateCoverPrompt = useCallback(async () => {
    if (isGeneratingCoverPrompt) return;
    setCoverPromptError(null);
    const taskId = startCoverTask('生成封面提示词', '按标题与简介生成生图提示词');
    setIsGeneratingCoverPrompt(true);
    try {
      await generateCoverPrompt();
      useTaskProgressStore.getState().completeTask(taskId);
    } catch (e) {
      setCoverPromptError(failCoverTask(taskId, e));
    } finally {
      setIsGeneratingCoverPrompt(false);
    }
  }, [generateCoverPrompt, isGeneratingCoverPrompt]);

  const ensureCoverPrompt = useCallback(async (): Promise<string> => {
    const existing = state.coverPrompt.trim();
    if (existing) return existing;
    return generateCoverPrompt();
  }, [state.coverPrompt, generateCoverPrompt]);

  const coverStudio = useWorkdirCoverStudio({
    workDir: activeDir,
    coverPrompt: state.coverPrompt,
    selectedCovers: draft.covers,
    ensurePrompt: ensureCoverPrompt,
  });

  const generateMeta = useCallback(
    async (current: PublishDraft): Promise<PublishMetadata> => {
      const settings = await loadAISettings();
      if (!settings) throw new Error('请先在「设置 → AI」完成大模型配置');
      const source = current.desc.trim() || current.title.trim() || state.notes.trim();
      if (!source) throw new Error('请先填写标题或简介，或重新识别工作目录');
      return window.electronAPI.generatePublishMetadata({
        settings,
        sourceText: source,
        currentTitle: current.title.trim() || undefined,
      });
    },
    [state.notes],
  );

  const recommendPartition = useCallback(async (current: PublishDraft) => {
    const settings = await loadAISettings();
    if (!settings) throw new Error('请先在「设置 → AI」完成大模型配置');
    return window.electronAPI.recommendBilibiliPartition({
      settings,
      title: current.title.trim(),
      desc: current.desc.trim(),
      fallbackSource: state.notes.trim() || undefined,
    });
  }, [state.notes]);

  const handlePublished = useCallback((entry: PublishHistoryEntry) => {
    setState((prev) => {
      const publishedPlatforms = { ...prev.publishedPlatforms };
      for (const target of entry.targets) {
        if (entry.results[target.accountId]?.state === 'success') {
          publishedPlatforms[target.platform] = entry.publishedAt;
        }
      }
      return {
        ...prev,
        history: [entry, ...prev.history].slice(0, 20),
        publishedPlatforms,
      };
    });
  }, []);

  if (!activeDir) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <Button variant="ghost" size="sm" onClick={onBack} leftIcon={<ArrowLeft size={14} />}>
            返回
          </Button>
          <div className={styles.headerCopy}>
            <h2>发布中心</h2>
            <p>打开工作目录，识别成片与文案后一键发布到所有平台</p>
          </div>
          <div className={styles.headerActions}>
            <IngestModelSelector />
            <Button variant="primary" size="sm" onClick={() => void handlePickDirectory()} leftIcon={<FolderOpen size={14} />}>
              打开工作目录
            </Button>
          </div>
        </div>
        <div className={styles.body}>
          {jobs.length === 0 ? (
            <div className={styles.empty} data-testid="publish-hub-empty">
              <Send size={28} strokeWidth={1.5} />
              <p>把做好的成片目录打开进来，会自动填好标题、封面和成片，核对后即可全渠道发布。</p>
              <Button variant="primary" onClick={() => void handlePickDirectory()} leftIcon={<FolderOpen size={14} />}>
                打开工作目录
              </Button>
            </div>
          ) : (
            <div className={styles.grid} data-testid="publish-hub-list">
              {jobs.map((job) => (
                <div
                  key={job.workDir}
                  className={styles.card}
                  role="button"
                  tabIndex={0}
                  onClick={() => void openWorkDir(job.workDir)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      void openWorkDir(job.workDir);
                    }
                  }}
                >
                  {job.thumbnail ? (
                    <img className={styles.thumb} src={toFileSrc(job.thumbnail)} alt="" />
                  ) : (
                    <div className={styles.thumbFallback}>
                      <Send size={22} />
                    </div>
                  )}
                  <div className={styles.info}>
                    <div className={styles.title}>{job.title || getFileNameFromPath(job.workDir)}</div>
                    <div className={styles.meta} title={job.workDir}>
                      {getFileNameFromPath(job.workDir)} · {formatWhen(job.lastPublishedAt)}
                    </div>
                    {Object.keys(job.publishedPlatforms).length > 0 && (
                      <div className={styles.platforms}>
                        {Object.keys(job.publishedPlatforms).map((platform) => (
                          <span key={platform} className={styles.badge}>
                            {PLATFORM_LABEL[platform] ?? platform}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <Button.Icon
                    size="xs"
                    variant="ghost"
                    className={styles.remove}
                    aria-label="从列表移除"
                    onClick={(event) => {
                      event.stopPropagation();
                      setRemoveTarget(job);
                    }}
                  >
                    <X size={12} />
                  </Button.Icon>
                </div>
              ))}
            </div>
          )}
        </div>
        <ConfirmDialog
          open={!!removeTarget}
          onOpenChange={(open) => {
            if (!open) setRemoveTarget(null);
          }}
          title="从发布中心移除？"
          description="只从列表拿掉，不会删除磁盘上的工作目录。"
          confirmText="移除"
          onConfirm={() => {
            if (!removeTarget) return;
            void window.publishAPI.removeHubJob(removeTarget.workDir).then(setJobs);
            setRemoveTarget(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <Button variant="ghost" size="sm" onClick={handleBackToList} leftIcon={<ArrowLeft size={14} />}>
          发布列表
        </Button>
        <div className={styles.headerCopy}>
          <h2>{draft.title || getFileNameFromPath(activeDir)}</h2>
          <p title={activeDir}>{activeDir}</p>
        </div>
        <div className={styles.headerActions}>
          <IngestModelSelector disabled={ingesting} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void window.electronAPI.openPath(activeDir)}
            leftIcon={<FolderOpen size={14} />}
          >
            打开目录
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={ingesting}
            onClick={() => void runIngest(activeDir)}
            leftIcon={ingesting ? <Loader2 size={14} /> : <RefreshCw size={14} />}
          >
            重新识别
          </Button>
        </div>
      </div>
      {ingestError && <div className={`${styles.banner} ${styles.errorBanner}`}>{ingestError}</div>}
      <div className={styles.detail}>
        {(ingesting || trace.scanSummary || trace.blocks.length > 0) && (
          <IngestTracePanel trace={trace} ingesting={ingesting} />
        )}
        <div className={styles.composer}>
        <PublishComposer
          key={activeDir}
          draft={draft.filePath || draft.title ? draft : emptyPublishDraft()}
          onDraftChange={updateDraft}
          coverStudio={coverStudio}
          hideHeader
          defaultSelectValidAccounts
          generateMeta={generateMeta}
          recommendPartition={recommendPartition}
          historyEntries={state.history}
          publishedPlatforms={state.publishedPlatforms}
          onPublished={handlePublished}
          historyEmptyText="还没有发布记录；发布完成后会列在这里，支持一键重新发布。"
          coverEmptyHint="识别完成后可在此生成或更换封面；也可直接选用本地图片。"
          coverExtra={
            <div className={styles.promptRow}>
              {state.notes ? <p className={styles.notes}>{state.notes}</p> : null}
              <div className={styles.promptLabel}>
                封面提示词
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleGenerateCoverPrompt()}
                  disabled={isGeneratingCoverPrompt}
                >
                  {isGeneratingCoverPrompt ? (
                    <>
                      <Loader2 size={13} style={{ marginRight: 5 }} />
                      生成中…
                    </>
                  ) : (
                    <>
                      <Sparkles size={13} style={{ marginRight: 5 }} />
                      AI 生成提示词
                    </>
                  )}
                </Button>
                {coverPromptError && (
                  <span style={{ fontSize: 12, color: 'var(--color-error, #ef4444)' }}>{coverPromptError}</span>
                )}
              </div>
              <textarea
                className={styles.textarea}
                value={state.coverPrompt}
                onChange={(event) => setState((prev) => ({ ...prev, coverPrompt: event.target.value }))}
                placeholder="可手动编辑封面提示词，或让 AI 按标题与简介生成"
                rows={3}
              />
            </div>
          }
        />
        </div>
      </div>
    </div>
  );
}
