// 项目发布 tab：PublishComposer 的项目适配层。
// 只负责项目特有职责：project.json publish/meta 段回填与防抖持久化（meta.title 双写镜像）、
// covers/ 扫描（useCoverStudio）、AI 分析结果作文案素材、发布历史写回。
// 表单 / 账号 / 发布 / 重登等通用交互在 core/PublishComposer。

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePublishStore } from '../../store/publish';
import { loadAISettings, useAIStore } from '../../store/ai';
import { useTimelineStore } from '../../store/timeline';
import {
  extractMetaSection,
  extractPublishSection,
  resolvePublishedPlatforms,
  PUBLISH_HISTORY_MAX,
  type ProjectData,
  type ProjectPublishMeta,
  type PublishHistoryEntry,
} from '../../lib/project-persistence';
import { buildMetadataSource, type PublishMetadata } from '../../lib/publish-metadata';
import { autoFillCovers, useCoverStudio } from './useCoverStudio';
import { isInsideDir } from '../../lib/publish/resolve-video-file';
import { emptyPublishDraft, type PublishDraft } from '../../lib/publish/draft';
import { PublishComposer } from './core/PublishComposer';

export function PublishWorkbench({ projectDir }: { projectDir: string | null }) {
  const lastExportPath = usePublishStore((s) => s.lastExportPath);

  const [draft, setDraft] = useState<PublishDraft>(emptyPublishDraft());
  const updateDraft = useCallback(
    (patch: Partial<PublishDraft>) => setDraft((prev) => ({ ...prev, ...patch })),
    [],
  );

  // 文案/封面回填完成标记（状态版，驱动封面自动预填 effect）
  const [hydrated, setHydrated] = useState(false);
  // 文案持久化：hydrate 完成前禁止 autosave，避免用空值覆盖磁盘上的已存文案
  const hydratedRef = useRef(false);

  // 发布历史（随项目持久化，新→旧）
  const [historyEntries, setHistoryEntries] = useState<PublishHistoryEntry[]>([]);
  // 已成功发布的平台 → 最近成功时间戳（随项目持久化，累积不淘汰）
  const [publishedPlatforms, setPublishedPlatforms] = useState<Record<string, number>>({});

  // 封面工作台（父级持有，单一数据源）：扫描 covers/ + AI 候选，按比例分组
  const coverStudio = useCoverStudio(projectDir);

  // ── 联动编辑器：同会话刚导出且属于当前项目时，立即反映到视频文件输入 ──
  // lastExportPath 为全局态、跨项目不清空，必须按当前 projectDir 过滤，避免串用上一个项目的成片。
  useEffect(() => {
    if (lastExportPath && projectDir && isInsideDir(lastExportPath, projectDir)) {
      setDraft((prev) => (prev.filePath ? prev : { ...prev, filePath: lastExportPath }));
    }
  }, [lastExportPath, projectDir]);

  // ── 切换项目：重置并从「当前项目目录」解析视频文件（避免沿用上一个项目的路径） ──
  useEffect(() => {
    if (!projectDir) {
      setDraft((prev) => ({ ...prev, filePath: '' }));
      return;
    }
    let cancelled = false;
    void (async () => {
      // 视频文件：仅当 lastExportPath 属于当前项目才直接用；否则扫描本项目目录最新成片。
      const last = usePublishStore.getState().lastExportPath;
      let resolved = last && isInsideDir(last, projectDir) ? last : null;
      if (!resolved) {
        resolved = await window.electronAPI.findLatestExport(projectDir).catch(() => null);
      }
      // 切项目即重置（resolved 为空则清空输入），不再 `prev ||` 保留旧项目路径。
      if (!cancelled) setDraft((prev) => ({ ...prev, filePath: resolved ?? '' }));
      // 封面：默认取编辑器选定的封面候选（必须属于当前项目，防 AI store 切换时序串项目）
      const selectedCover = useAIStore
        .getState()
        .coverCandidates.find(
          (c) => c.selected && c.imageUrl && isInsideDir(c.imageUrl, projectDir),
        );
      if (selectedCover && !cancelled) {
        setDraft((prev) => ({
          ...prev,
          thumbnail: prev.thumbnail || selectedCover.imageUrl,
          // 编辑器选定封面为 16:9 整期封面 → 预填 16:9 槽
          covers: prev.covers['16:9']
            ? prev.covers
            : { ...prev.covers, '16:9': selectedCover.imageUrl },
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  // ── 文案持久化：项目切换时从 project.json 回填已存的标题/描述/标签/封面/覆盖 ──
  useEffect(() => {
    hydratedRef.current = false;
    setHydrated(false);
    setHistoryEntries([]);
    setPublishedPlatforms({});
    // 切项目即清空文案/封面本地态：后续回填的 prev|| 合并语义会把上一个项目的值带进新项目并写盘
    setDraft((prev) => ({ ...emptyPublishDraft(), filePath: prev.filePath }));
    if (!projectDir) {
      hydratedRef.current = true;
      setHydrated(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      let saved: ProjectPublishMeta | null = null;
      let savedMetaTitle = '';
      try {
        const raw = await window.electronAPI.loadProject(projectDir);
        const data = JSON.parse(raw) as ProjectData;
        saved = extractPublishSection(data);
        savedMetaTitle = extractMetaSection(data).title;
      } catch {
        saved = null;
      }
      if (cancelled) return;
      if (saved) {
        const s = saved;
        // 已存文案优先于派生预填（派生预填仍用 prev|| 兜底空值）；标题以 meta 真源优先
        const savedTitle = savedMetaTitle || s.title;
        // 封面路径必须属于当前项目：治愈历史串项目污染写入 project.json 的外部路径
        const ownCovers = Object.fromEntries(
          Object.entries(s.covers ?? {}).filter(
            ([, p]) => typeof p === 'string' && p && isInsideDir(p, projectDir),
          ),
        ) as Record<string, string>;
        setDraft((prev) => ({
          ...prev,
          title: prev.title || savedTitle,
          desc: prev.desc || s.desc,
          tagsInput: prev.tagsInput || s.tagsInput,
          thumbnail:
            prev.thumbnail || (s.thumbnail && isInsideDir(s.thumbnail, projectDir) ? s.thumbnail : ''),
          covers: Object.keys(ownCovers).length ? { ...ownCovers, ...prev.covers } : prev.covers,
          bilibiliTid: prev.bilibiliTid || (s.bilibiliTid ?? ''),
        }));
        if (s.history?.length) setHistoryEntries(s.history);
        // 显式字段 + 旧工程历史回推（含惰性迁移：下次防抖写回即落盘）
        setPublishedPlatforms(resolvePublishedPlatforms({ publish: s }));
      }
      hydratedRef.current = true;
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  // ── 封面按比例自动预填：扫描/生成出的 4:3 / 3:4 等比例图自动选中，无需手动点选。 ──
  //    仅填补空槽（已选或已回填的比例保持不变），并在 hydration 完成后才运行，避免覆盖已存选择。
  useEffect(() => {
    if (!hydrated) return;
    setDraft((prev) => {
      const next = autoFillCovers(coverStudio.groups, prev.covers);
      return next === prev.covers ? prev : { ...prev, covers: next };
    });
  }, [hydrated, coverStudio.groups]);

  // ── 文案持久化：标题/描述/标签/封面/覆盖变更时防抖写回 project.json ──
  useEffect(() => {
    if (!projectDir || !hydratedRef.current) return;
    const meta: ProjectPublishMeta = {
      title: draft.title,
      desc: draft.desc,
      tagsInput: draft.tagsInput,
      thumbnail: draft.thumbnail,
      covers: draft.covers,
      bilibiliTid: draft.bilibiliTid,
      history: historyEntries,
      publishedPlatforms,
    };
    const timer = setTimeout(() => {
      window.electronAPI
        .saveProjectSection(projectDir, 'publish', JSON.stringify(meta))
        .catch(() => {});
      // 镜像写回 meta 真源（publish.title 保持同步，平台上传链路无需改动）
      window.electronAPI
        .saveProjectSection(projectDir, 'meta', JSON.stringify({ title: draft.title }))
        .catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [projectDir, draft, historyEntries, publishedPlatforms]);

  // ── 后台（工作流/流水线）生成标题后回灌本地态，避免防抖写回用空标题覆盖新值。 ──
  useEffect(() => {
    if (!projectDir || !window.electronAPI?.onProjectUpdated) return;
    return window.electronAPI.onProjectUpdated((payload) => {
      if (payload.projectPath !== projectDir) return;
      if (!payload.sections.includes('meta') && !payload.sections.includes('publish')) return;
      void (async () => {
        try {
          const raw = await window.electronAPI.loadProject(projectDir);
          const data = JSON.parse(raw) as ProjectData;
          const metaTitle = extractMetaSection(data).title;
          const saved = extractPublishSection(data);
          setDraft((prev) => ({
            ...prev,
            title: prev.title || metaTitle,
            desc: prev.desc || saved.desc,
            tagsInput: prev.tagsInput || saved.tagsInput,
          }));
        } catch {
          // 刷新失败忽略，下次打开自然回填
        }
      })();
    });
  }, [projectDir]);

  // ── AI 适配：素材来自 AI 分析结果 / 字幕，提示词绑定走项目级 ──
  const generateMeta = useCallback(
    async (current: PublishDraft): Promise<PublishMetadata> => {
      const settings = await loadAISettings();
      if (!settings) throw new Error('请先在「设置 → AI」完成大模型配置');
      const analysis = useAIStore.getState().analysisResult;
      const srtText = useTimelineStore
        .getState()
        .srtEntries.map((e) => e.text)
        .join(' ');
      const sourceText = buildMetadataSource(analysis, srtText);
      if (!sourceText.trim()) throw new Error('暂无内容可供生成，请先完成 AI 分析或导入字幕');
      const projectBindings = projectDir
        ? await window.electronAPI.readPromptBindings('project', projectDir).catch(() => null)
        : null;
      return window.electronAPI.generatePublishMetadata({
        settings,
        sourceText,
        currentTitle: current.title.trim() || undefined,
        projectDir: projectDir || undefined,
        projectBindings,
      });
    },
    [projectDir],
  );

  const recommendPartition = useCallback(
    async (current: PublishDraft): Promise<{ tid: number }> => {
      const settings = await loadAISettings();
      if (!settings) throw new Error('请先在「设置 → AI」完成大模型配置');
      // 标题 / 描述均空时，回退用 AI 分析摘要 / 字幕作为依据
      let fallbackSource: string | undefined;
      if (!current.title.trim() && !current.desc.trim()) {
        const analysis = useAIStore.getState().analysisResult;
        const srtText = useTimelineStore
          .getState()
          .srtEntries.map((e) => e.text)
          .join(' ');
        fallbackSource = buildMetadataSource(analysis, srtText);
        if (!fallbackSource.trim()) throw new Error('请先填写或生成标题 / 描述');
      }
      const projectBindings = projectDir
        ? await window.electronAPI.readPromptBindings('project', projectDir).catch(() => null)
        : null;
      return window.electronAPI.recommendBilibiliPartition({
        settings,
        title: current.title.trim(),
        desc: current.desc.trim(),
        fallbackSource,
        projectDir: projectDir || undefined,
        projectBindings,
      });
    },
    [projectDir],
  );

  // 扫描当前项目目录最新成片（用户手动触发；自动解析失败或导出后可一键刷新）。
  const handleScanVideo = useCallback(
    () =>
      projectDir
        ? window.electronAPI.findLatestExport(projectDir).catch(() => null)
        : Promise.resolve(null),
    [projectDir],
  );

  // 发布完成：落历史 + 成功平台打「已发布」标记（累积，欢迎页 / 账号列表据此展示）
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
    <PublishComposer
      draft={draft}
      onDraftChange={updateDraft}
      coverStudio={coverStudio}
      subtitle={projectDir}
      onScanVideo={projectDir ? handleScanVideo : null}
      scanEmptyMessage="当前项目目录未找到可发布的 MP4 成片，请先在编辑器导出，或手动选择文件"
      generateMeta={generateMeta}
      recommendPartition={recommendPartition}
      historyEntries={historyEntries}
      publishedPlatforms={publishedPlatforms}
      onPublished={handlePublished}
    />
  );
}
