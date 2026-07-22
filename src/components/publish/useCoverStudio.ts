import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CoverCandidate, ImageAspectRatio } from '../../types/ai';
import { coverAspectRatio } from '../../types/ai';
import { loadAISettings, useAIStore } from '../../store/ai';
import { useTaskProgressStore } from '../../store/task-progress';
import { getProjectDir } from '../../store/timeline';

export interface DiskCover {
  path: string;
  ratio: ImageAspectRatio;
  mtimeMs: number;
}

const RATIO_TARGETS: { ratio: ImageAspectRatio; value: number }[] = [
  { ratio: '16:9', value: 16 / 9 },
  { ratio: '4:3', value: 4 / 3 },
  { ratio: '3:4', value: 3 / 4 },
];

/** 把像素尺寸归类到 16:9 / 4:3 / 3:4；偏差超过容差（如 1:1、9:16）返回 null。 */
export function classifyRatio(width: number, height: number): ImageAspectRatio | null {
  if (!width || !height) return null;
  const r = width / height;
  let best: ImageAspectRatio | null = null;
  let bestErr = Infinity;
  for (const t of RATIO_TARGETS) {
    const err = Math.abs(r - t.value) / t.value;
    if (err < bestErr) {
      bestErr = err;
      best = t.ratio;
    }
  }
  return bestErr <= 0.06 ? best : null;
}

/** 按比例合并 store 候选与磁盘封面；旧候选缺少比例时以磁盘真实尺寸为准。 */
export function groupCoverCandidatesByRatio(
  coverCandidates: CoverCandidate[],
  diskCovers: DiskCover[],
  basePrompt: string | null,
): Record<string, CoverCandidate[]> {
  const out: Record<string, CoverCandidate[]> = { '16:9': [], '4:3': [], '3:4': [] };
  const diskByPath = new Map(diskCovers.map((cover) => [cover.path, cover]));
  const storePaths = new Set(coverCandidates.map((candidate) => candidate.imageUrl).filter(Boolean));

  for (const candidate of coverCandidates) {
    const ratio = candidate.aspectRatio ?? diskByPath.get(candidate.imageUrl)?.ratio ?? coverAspectRatio(candidate);
    if (out[ratio] && candidate.imageUrl) out[ratio].push(candidate);
  }
  for (const diskCover of diskCovers) {
    if (storePaths.has(diskCover.path)) continue;
    out[diskCover.ratio]?.push({
      id: `disk:${diskCover.path}`,
      imageUrl: diskCover.path,
      prompt: basePrompt ?? '',
      selected: false,
      aspectRatio: diskCover.ratio,
      createdAt: diskCover.mtimeMs,
    });
  }
  for (const ratio of Object.keys(out)) {
    out[ratio].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }
  return out;
}

export function resolveCoverStudioBasePrompt(
  analysisPrompt: string | null,
  candidates: CoverCandidate[],
): string | null {
  const selectedWidePrompt = candidates.find((candidate) => (
    candidate.selected
    && coverAspectRatio(candidate) === '16:9'
    && candidate.prompt.trim().length > 0
  ))?.prompt.trim();
  return selectedWidePrompt || analysisPrompt?.trim() || null;
}

export function appendCoverGenerationHistory(
  existing: CoverCandidate[],
  generated: CoverCandidate[],
): CoverCandidate[] {
  const generatedIds = new Set(generated.map((candidate) => candidate.id));
  return [...existing.filter((candidate) => !generatedIds.has(candidate.id)), ...generated];
}

/** 需自动预填的比例：16:9 由编辑器整期封面专属逻辑填充，此处只补抖音/视频号所需的横竖比例。 */
const AUTO_FILL_RATIOS: ImageAspectRatio[] = ['4:3', '3:4'];

/** 为尚未选中的比例自动挑该比例第一张可用封面（groups 已按 createdAt 降序）。
 *  只填补空槽，已选比例保持不变；无可填补时返回原引用（便于 setState 跳过更新）。 */
export function autoFillCovers(
  groups: Record<string, CoverCandidate[]>,
  current: Record<string, string>,
): Record<string, string> {
  let next = current;
  for (const ratio of AUTO_FILL_RATIOS) {
    if (next[ratio]) continue;
    const first = groups[ratio]?.find((c) => c.imageUrl)?.imageUrl;
    if (first) next = next === current ? { ...current, [ratio]: first } : { ...next, [ratio]: first };
  }
  return next;
}

/** 发布选项卡展示的三种封面比例（编辑器封面为 16:9）。 */
export const PUBLISH_RATIOS: { ratio: ImageAspectRatio; label: string; hint: string }[] = [
  { ratio: '16:9', label: '16:9 横版', hint: '视频号 / B站 / 横屏（编辑器封面）' },
  { ratio: '4:3', label: '4:3', hint: '通用横版' },
  { ratio: '3:4', label: '3:4 竖版', hint: '抖音 / 小红书 / 快手' },
];

const PUBLISH_RATIO_VALUES = PUBLISH_RATIOS.map((r) => r.ratio);
/** 每个比例一次生成的候选数 */
const RATIO_BATCH = 2;

export function startCoverTask(label: string, phase: string): string {
  const taskId = `publish-cover-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  useTaskProgressStore.getState().startTask({
    id: taskId,
    category: 'cover',
    label,
    mode: 'indeterminate',
    progress: 0,
    phase,
    level: 1,
    canCancel: false,
  });
  return taskId;
}

export function failCoverTask(taskId: string, error: unknown): string {
  const message = error instanceof Error ? error.message : '封面生成失败';
  useTaskProgressStore.getState().failTask(taskId, message);
  return message;
}

function ratioOrientationHint(ratio: ImageAspectRatio): string {
  switch (ratio) {
    case '3:4':
      return '画面为竖版 3:4 构图：主体垂直居中，上下预留安全区，文字标题适配竖屏封面，整体不要出现横版黑边。';
    case '4:3':
      return '画面为 4:3 构图：主体居中偏上，构图饱满，适配 4:3 封面。';
    default:
      return '';
  }
}

/** 在基础封面提示词上拼接比例方向提示，引导模型按目标画幅构图。 */
export function buildRatioPrompt(base: string, ratio: ImageAspectRatio): string {
  const hint = ratioOrientationHint(ratio);
  return hint ? `${base.trim()}\n${hint}` : base.trim();
}

/** 当前导演封面描述优先；仅旧项目缺少基础描述时回退候选生成时的历史提示词。 */
export function resolvePublishRatioPrompt(
  basePrompt: string | null,
  ratio: ImageAspectRatio,
  candidatePrompt = '',
): string {
  return basePrompt?.trim()
    ? buildRatioPrompt(basePrompt, ratio)
    : candidatePrompt.trim();
}

export interface CoverStudio {
  basePrompt: string | null;
  groups: Record<string, CoverCandidate[]>;
  /** 正在生成的比例集合 */
  busyRatios: ImageAspectRatio[];
  /** 单图重生中的候选 id 集合 */
  busyCandidateIds: string[];
  error: string | null;
  /** 主进程封面扫描能力是否缺失（旧实例未重启时为 true） */
  scanUnavailable: boolean;
  /** 缺失（无候选）的比例 */
  missingRatios: ImageAspectRatio[];
  regenerateRatio: (ratio: ImageAspectRatio) => Promise<void>;
  regenerateOne: (candidateId: string) => Promise<void>;
  fillMissing: () => Promise<void>;
  regenerateAll: () => Promise<void>;
}

export function useCoverStudio(projectDir?: string | null): CoverStudio {
  const coverCandidates = useAIStore((s) => s.coverCandidates);
  const analysisResult = useAIStore((s) => s.analysisResult);
  const currentProjectDir = useAIStore((s) => s.currentProjectDir);
  const [busyRatios, setBusyRatios] = useState<ImageAspectRatio[]>([]);
  const [busyCandidateIds, setBusyCandidateIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [diskCovers, setDiskCovers] = useState<DiskCover[]>([]);
  const [scanUnavailable, setScanUnavailable] = useState(false);

  const basePrompt = useMemo(() => resolveCoverStudioBasePrompt(
    analysisResult?.coverPrompts?.[0] ?? null,
    coverCandidates,
  ), [analysisResult?.coverPrompts, coverCandidates]);
  // 优先用调用方显式传入的 projectDir（发布选项卡的权威来源），回退到全局当前项目目录。
  const resolveDir = useCallback(
    () => projectDir || getProjectDir() || currentProjectDir || '',
    [projectDir, currentProjectDir],
  );

  // 扫描项目 covers/ 目录，按真实像素尺寸归类已存在的合适比例图片。
  const scanDisk = useCallback(async () => {
    const dir = resolveDir();
    // scanCoverImages 是新增的主进程能力；旧的运行实例（未重启）可能尚未注入。
    if (typeof window.electronAPI?.scanCoverImages !== 'function') {
      setScanUnavailable(true);
      setDiskCovers([]);
      return;
    }
    setScanUnavailable(false);
    if (!dir) {
      setDiskCovers([]);
      return;
    }
    try {
      const found = await window.electronAPI.scanCoverImages(dir);
      const mapped: DiskCover[] = [];
      for (const f of found) {
        const ratio = classifyRatio(f.width, f.height);
        if (ratio) mapped.push({ path: f.path, ratio, mtimeMs: f.mtimeMs });
      }
      setDiskCovers(mapped);
    } catch {
      setDiskCovers([]);
    }
  }, [resolveDir]);

  useEffect(() => {
    void scanDisk();
  }, [scanDisk]);

  const groups = useMemo(() => {
    return groupCoverCandidatesByRatio(coverCandidates, diskCovers, basePrompt);
  }, [coverCandidates, diskCovers, basePrompt]);

  const missingRatios = useMemo(
    () => PUBLISH_RATIO_VALUES.filter((r) => (groups[r]?.length ?? 0) === 0),
    [groups],
  );

  // 落盘由 store/ai.ts 订阅自动完成，这里只更新内存态。
  const persist = useCallback(async (nextCandidates: CoverCandidate[]) => {
    useAIStore.getState().setCoverCandidates(nextCandidates);
  }, []);

  const runGeneration = useCallback(
    async (ratio: ImageAspectRatio, n: number): Promise<CoverCandidate[]> => {
      const prompt = resolvePublishRatioPrompt(basePrompt, ratio);
      if (!prompt) throw new Error('缺少封面生成描述，请先在编辑器生成内容卡片');
      const settings = await loadAISettings();
      const hasImageProvider =
        !!settings && settings.imageProviders.length > 0 && !!settings.defaultImageProviderId;
      if (!settings || !hasImageProvider) {
        throw new Error('请先在「设置 → AI」中配置至少一个图像生成服务');
      }
      const dir = resolveDir();
      if (!dir) throw new Error('未找到项目目录');
      const generated = await window.electronAPI.generateCoverImages({
        prompts: [prompt],
        settings,
        projectDir: dir,
        projectBindings: useAIStore.getState().projectBindings,
        aspectRatio: ratio,
        n,
      });
      // 发布封面通过缩略图路径选用，不占用 store 的 selected 标记；
      // 否则会与编辑器选定的 16:9 整期封面冲突（出现多个 selected）。
      return generated.map((c) => ({ ...c, selected: false }));
    },
    [basePrompt, resolveDir],
  );

  const regenerateRatio = useCallback(
    async (ratio: ImageAspectRatio) => {
      const taskId = startCoverTask(`生成 ${ratio} 发布封面`, '生成封面候选');
      setError(null);
      setBusyRatios((prev) => (prev.includes(ratio) ? prev : [...prev, ratio]));
      try {
        const fresh = await runGeneration(ratio, RATIO_BATCH);
        const all = useAIStore.getState().coverCandidates;
        await persist(appendCoverGenerationHistory(all, fresh));
        useTaskProgressStore.getState().completeTask(taskId);
      } catch (e) {
        setError(failCoverTask(taskId, e));
      } finally {
        setBusyRatios((prev) => prev.filter((r) => r !== ratio));
        void scanDisk();
      }
    },
    [persist, runGeneration, scanDisk],
  );

  const regenerateOne = useCallback(
    async (candidateId: string) => {
      setError(null);
      const target = useAIStore.getState().coverCandidates.find((c) => c.id === candidateId);
      // 重生结果作为新候选追加，保留原候选的提示词和图片历史。
      const ratio = target
        ? coverAspectRatio(target)
        : diskCovers.find((d) => `disk:${d.path}` === candidateId)?.ratio;
      if (!ratio) return;
      const taskId = startCoverTask('重新生成发布封面', `生成 ${ratio} 封面`);
      setBusyCandidateIds((prev) => (prev.includes(candidateId) ? prev : [...prev, candidateId]));
      try {
        const fresh = (await runGeneration(ratio, 1)).find((c) => c.imageUrl);
        if (!fresh) throw new Error('未生成有效封面');
        const next = target ? { ...fresh, editedFrom: target.id } : fresh;
        await persist(appendCoverGenerationHistory(
          useAIStore.getState().coverCandidates,
          [next],
        ));
        useTaskProgressStore.getState().completeTask(taskId);
      } catch (e) {
        setError(failCoverTask(taskId, e));
      } finally {
        setBusyCandidateIds((prev) => prev.filter((id) => id !== candidateId));
        void scanDisk();
      }
    },
    [persist, runGeneration, diskCovers, scanDisk],
  );

  const fillMissing = useCallback(async () => {
    setError(null);
    // 缺失判定同时考虑 store 候选与磁盘已存在的合适比例图片
    const targets = PUBLISH_RATIO_VALUES.filter((r) => {
      const inStore = useAIStore.getState().coverCandidates.some(
        (c) => coverAspectRatio(c) === r && c.imageUrl,
      );
      const onDisk = diskCovers.some((d) => d.ratio === r);
      return !inStore && !onDisk;
    });
    if (targets.length === 0) return;
    const taskId = startCoverTask('补全发布封面比例', `生成 ${targets.length} 种比例`);
    setBusyRatios((prev) => Array.from(new Set([...prev, ...targets])));
    try {
      for (const ratio of targets) {
        const fresh = await runGeneration(ratio, RATIO_BATCH);
        const all = useAIStore.getState().coverCandidates;
        await persist([...all, ...fresh]);
      }
      useTaskProgressStore.getState().completeTask(taskId);
    } catch (e) {
      setError(failCoverTask(taskId, e));
    } finally {
      setBusyRatios((prev) => prev.filter((r) => !targets.includes(r)));
      void scanDisk();
    }
  }, [persist, runGeneration, diskCovers, scanDisk]);

  const regenerateAll = useCallback(async () => {
    const taskId = startCoverTask('重新生成全部发布封面', '生成多比例封面');
    setError(null);
    setBusyRatios(PUBLISH_RATIO_VALUES.slice());
    try {
      for (const ratio of PUBLISH_RATIO_VALUES) {
        const fresh = await runGeneration(ratio, RATIO_BATCH);
        const all = useAIStore.getState().coverCandidates;
        await persist(appendCoverGenerationHistory(all, fresh));
      }
      useTaskProgressStore.getState().completeTask(taskId);
    } catch (e) {
      setError(failCoverTask(taskId, e));
    } finally {
      setBusyRatios([]);
      void scanDisk();
    }
  }, [persist, runGeneration, scanDisk]);

  return {
    basePrompt,
    groups,
    busyRatios,
    busyCandidateIds,
    error,
    scanUnavailable,
    missingRatios,
    regenerateRatio,
    regenerateOne,
    fillMissing,
    regenerateAll,
  };
}
