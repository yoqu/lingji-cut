// 自由发布页（欢迎页入口，无项目）：任意视频路径 + 手写主题 →
// AI 生成标题/简介/标签/封面 → 一键发布到所有已登录平台。
// 状态持久化于 userData/publish/standalone/state.json（publish:standalone-* IPC）。

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, FolderOpen, Loader2, Sparkles, X } from 'lucide-react';
import { Button, Field } from '../ui';
import { loadAISettings } from '../store/ai';
import { useTaskProgressStore } from '../store/task-progress';
import {
  PUBLISH_HISTORY_MAX,
  type PublishHistoryEntry,
} from '../lib/project-persistence';
import type { PublishMetadata } from '../lib/publish-metadata';
import { emptyPublishDraft, type PublishDraft } from '../lib/publish/draft';
import {
  buildStandaloneCoverSource,
  parseStandaloneState,
  type StandalonePublishState,
} from '../lib/publish/standalone-state';
import { PublishComposer } from '../components/publish/core/PublishComposer';
import { useStandaloneCoverStudio } from '../components/publish/core/useStandaloneCoverStudio';
import { failCoverTask, startCoverTask } from '../components/publish/useCoverStudio';

const TEXTAREA_STYLE: CSSProperties = {
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
};

export function FreePublish({ onBack }: { onBack: () => void }) {
  const [draft, setDraft] = useState<PublishDraft>(emptyPublishDraft());
  const [topic, setTopic] = useState('');
  // 封面生图提示词：AI 按主题生成后回显于此，可手动编辑，随 standalone 状态持久化
  const [coverPrompt, setCoverPrompt] = useState('');
  const [isGeneratingCoverPrompt, setIsGeneratingCoverPrompt] = useState(false);
  const [coverPromptError, setCoverPromptError] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<PublishHistoryEntry[]>([]);
  const [publishedPlatforms, setPublishedPlatforms] = useState<Record<string, number>>({});
  const [root, setRoot] = useState<string | null>(null);
  const [coversDir, setCoversDir] = useState<string | null>(null);
  // hydrate 完成前禁止 autosave，避免用空态覆盖磁盘上的已存状态
  const hydratedRef = useRef(false);

  const updateDraft = useCallback(
    (patch: Partial<PublishDraft>) => setDraft((prev) => ({ ...prev, ...patch })),
    [],
  );

  // ── 加载持久化状态（草稿 / 主题 / 历史）──
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await window.publishAPI.loadStandaloneState();
        if (cancelled) return;
        setRoot(loaded.root);
        setCoversDir(loaded.coversDir);
        const state = parseStandaloneState(loaded.state);
        setDraft(state.draft);
        setTopic(state.topic);
        setCoverPrompt(state.coverPrompt);
        setHistoryEntries(state.history);
        setPublishedPlatforms(state.publishedPlatforms);
      } catch {
        // 加载失败按空态使用；保存能力可能同样不可用，但不阻塞发布
      } finally {
        if (!cancelled) hydratedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── 防抖持久化 ──
  useEffect(() => {
    if (!hydratedRef.current) return;
    const state: StandalonePublishState = {
      draft,
      topic,
      coverPrompt,
      history: historyEntries,
      publishedPlatforms,
    };
    const timer = setTimeout(() => {
      window.publishAPI.saveStandaloneState(state).catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [draft, topic, coverPrompt, historyEntries, publishedPlatforms]);

  // ── 封面提示词生成：主题/标题作素材，经 cover.regeneration 模板（设置界面可编辑）──
  const generateCoverPrompt = useCallback(async (): Promise<string> => {
    const source = buildStandaloneCoverSource(topic, draft.title);
    if (!source) throw new Error('请先填写视频主题或标题');
    const settings = await loadAISettings();
    if (!settings) throw new Error('请先在「设置 → AI」完成大模型配置');
    const prompts = await window.electronAPI.regenerateCoverPrompt({
      entries: [{ index: 1, startMs: 0, endMs: 0, text: source }],
      settings,
      currentPrompt: coverPrompt.trim() || undefined,
      standalone: true,
      workTitle: draft.title.trim() || undefined,
    });
    const prompt = prompts[0]?.trim();
    if (!prompt) throw new Error('LLM 未返回有效的封面提示词');
    setCoverPrompt(prompt);
    return prompt;
  }, [topic, draft.title, coverPrompt]);

  // 显式入口（按钮）：busy / 错误 / 底部进度条
  const handleGenerateCoverPrompt = useCallback(async () => {
    if (isGeneratingCoverPrompt) return;
    setCoverPromptError(null);
    const taskId = startCoverTask('生成封面提示词', '按视频主题生成生图提示词');
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

  // 兜底：提示词为空时点「生成封面」先自动生成一次提示词（同样回显到输入框）
  const ensureCoverPrompt = useCallback(async (): Promise<string> => {
    const existing = coverPrompt.trim();
    if (existing) return existing;
    return generateCoverPrompt();
  }, [coverPrompt, generateCoverPrompt]);

  const coverStudio = useStandaloneCoverStudio({
    root,
    coversDir,
    coverPrompt,
    ensurePrompt: ensureCoverPrompt,
  });

  // ── AI 适配：素材来自手写主题，提示词绑定走全局 ──
  const generateMeta = useCallback(
    async (current: PublishDraft): Promise<PublishMetadata> => {
      const settings = await loadAISettings();
      if (!settings) throw new Error('请先在「设置 → AI」完成大模型配置');
      if (!topic.trim()) throw new Error('请先填写视频主题');
      return window.electronAPI.generatePublishMetadata({
        settings,
        sourceText: `视频主题与内容简介：\n${topic.trim()}`,
        currentTitle: current.title.trim() || undefined,
      });
    },
    [topic],
  );

  const recommendPartition = useCallback(
    async (current: PublishDraft): Promise<{ tid: number }> => {
      const settings = await loadAISettings();
      if (!settings) throw new Error('请先在「设置 → AI」完成大模型配置');
      let fallbackSource: string | undefined;
      if (!current.title.trim() && !current.desc.trim()) {
        if (!topic.trim()) throw new Error('请先填写视频主题或标题 / 描述');
        fallbackSource = `视频主题与内容简介：\n${topic.trim()}`;
      }
      return window.electronAPI.recommendBilibiliPartition({
        settings,
        title: current.title.trim(),
        desc: current.desc.trim(),
        fallbackSource,
      });
    },
    [topic],
  );

  const handlePublished = useCallback((entry: PublishHistoryEntry) => {
    setHistoryEntries((prev) => [entry, ...prev].slice(0, PUBLISH_HISTORY_MAX));
    const succeeded = entry.targets.filter(
      (t) => entry.results[t.accountId]?.state === 'success',
    );
    if (succeeded.length > 0) {
      setPublishedPlatforms((prev) => {
        const next = { ...prev };
        for (const t of succeeded) next[t.platform] = entry.publishedAt;
        return next;
      });
    }
  }, []);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* 顶栏：返回欢迎页 + 页面标题 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 24px',
          borderBottom: '1px solid var(--color-border-subtle, rgba(0,0,0,0.08))',
          flexShrink: 0,
        }}
      >
        <Button variant="ghost" size="sm" onClick={onBack} leftIcon={<ArrowLeft size={14} />}>
          返回
        </Button>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>
            自由发布
          </h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            选择任意视频，写清主题，AI 生成封面与文案，一键发布到所有平台
          </p>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <PublishComposer
          draft={draft}
          onDraftChange={updateDraft}
          coverStudio={coverStudio}
          hideHeader
          extraFields={
            <Field
              label="视频主题"
              required
              hint="写清楚这期视频讲什么；AI 据此生成标题、简介、标签与封面"
            >
              <textarea
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="例如：拆解 2026 年新能源车企半年报，聊聊谁在赚钱谁在烧钱…"
                rows={3}
                style={TEXTAREA_STYLE}
              />
            </Field>
          }
          coverExtra={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                  封面提示词
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleGenerateCoverPrompt()}
                  disabled={isGeneratingCoverPrompt}
                  style={{ flexShrink: 0 }}
                >
                  {isGeneratingCoverPrompt ? (
                    <>
                      <Loader2 size={13} style={{ animation: 'spin 1s linear infinite', marginRight: 5 }} />
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
                  <span style={{ fontSize: 12, color: 'var(--color-error, #ef4444)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <X size={12} />
                    {coverPromptError}
                  </span>
                )}
              </div>
              <textarea
                value={coverPrompt}
                onChange={(e) => setCoverPrompt(e.target.value)}
                placeholder="点「AI 生成提示词」按视频主题生成（遵循设置中的封面提示词模板），也可手动编辑后再生成封面"
                rows={4}
                style={TEXTAREA_STYLE}
              />
              {coversDir && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span
                    title={coversDir}
                    style={{
                      fontSize: 11,
                      color: 'var(--color-text-tertiary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0,
                    }}
                  >
                    生成的封面保存于：{coversDir}
                  </span>
                  <button
                    type="button"
                    onClick={() => void window.electronAPI.openPath(coversDir)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 11,
                      color: 'var(--color-system-blue)',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                      flexShrink: 0,
                    }}
                  >
                    <FolderOpen size={12} />
                    打开目录
                  </button>
                </div>
              )}
            </div>
          }
          coverEmptyHint="暂无封面提示词；请先点击上方「AI 生成提示词」（需先填写视频主题或标题），或手动填写后再生成封面。"
          generateMeta={generateMeta}
          recommendPartition={recommendPartition}
          historyEntries={historyEntries}
          publishedPlatforms={publishedPlatforms}
          onPublished={handlePublished}
          historyEmptyText={
            root
              ? `还没有发布记录；发布完成后会列在这里，支持一键重新发布。数据保存于 ${root}/state.json`
              : '还没有发布记录；发布完成后会列在这里，支持一键重新发布。'
          }
        />
      </div>
    </div>
  );
}
