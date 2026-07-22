// 自由发布封面工作台：CoverStudio 的无项目实现。
// 候选保存在本地 state（跨重启由磁盘扫描兜底）。生图提示词由页面持有
// （可见可编辑，经 cover.regeneration 模板 AI 生成）；为空时生图前经
// ensurePrompt 自动生成一次。产物写 userData/publish/standalone/covers/。

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CoverCandidate, ImageAspectRatio } from '../../../types/ai';
import { coverAspectRatio } from '../../../types/ai';
import { loadAISettings } from '../../../store/ai';
import { useTaskProgressStore } from '../../../store/task-progress';
import {
  appendCoverGenerationHistory,
  buildRatioPrompt,
  classifyRatio,
  failCoverTask,
  groupCoverCandidatesByRatio,
  startCoverTask,
  PUBLISH_RATIOS,
  type CoverStudio,
  type DiskCover,
} from '../useCoverStudio';

const RATIO_VALUES = PUBLISH_RATIOS.map((r) => r.ratio);
const RATIO_BATCH = 2;

export function useStandaloneCoverStudio(args: {
  /** standalone 根目录（scanCoverImages 会扫描其 covers/ 子目录）；加载前为 null。 */
  root: string | null;
  /** 文生图输出目录（root/covers）。 */
  coversDir: string | null;
  /** 页面持有的封面提示词（可见可编辑，持久化于 standalone 状态）。 */
  coverPrompt: string;
  /** 提示词为空时的兜底生成（页面实现：AI 生成并回写可见输入框）。 */
  ensurePrompt: () => Promise<string>;
}): CoverStudio {
  const { root, coversDir, coverPrompt, ensurePrompt } = args;
  const [candidates, setCandidates] = useState<CoverCandidate[]>([]);
  const [busyRatios, setBusyRatios] = useState<ImageAspectRatio[]>([]);
  const [busyCandidateIds, setBusyCandidateIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [diskCovers, setDiskCovers] = useState<DiskCover[]>([]);

  const basePrompt = coverPrompt.trim() || null;

  const scanDisk = useCallback(async () => {
    if (!root || typeof window.electronAPI?.scanCoverImages !== 'function') {
      setDiskCovers([]);
      return;
    }
    try {
      const found = await window.electronAPI.scanCoverImages(root);
      const mapped: DiskCover[] = [];
      for (const f of found) {
        const ratio = classifyRatio(f.width, f.height);
        if (ratio) mapped.push({ path: f.path, ratio, mtimeMs: f.mtimeMs });
      }
      setDiskCovers(mapped);
    } catch {
      setDiskCovers([]);
    }
  }, [root]);

  useEffect(() => {
    void scanDisk();
  }, [scanDisk]);

  const groups = useMemo(
    () => groupCoverCandidatesByRatio(candidates, diskCovers, basePrompt),
    [candidates, diskCovers, basePrompt],
  );

  const missingRatios = useMemo(
    () => RATIO_VALUES.filter((r) => (groups[r]?.length ?? 0) === 0),
    [groups],
  );

  const runGeneration = useCallback(
    async (ratio: ImageAspectRatio, n: number): Promise<CoverCandidate[]> => {
      if (!coversDir) throw new Error('自由发布目录尚未就绪，请稍后重试');
      const settings = await loadAISettings();
      const hasImageProvider =
        !!settings && settings.imageProviders.length > 0 && !!settings.defaultImageProviderId;
      if (!settings || !hasImageProvider) {
        throw new Error('请先在「设置 → AI」中配置至少一个图像生成服务');
      }
      const prompt = basePrompt ?? (await ensurePrompt());
      const generated = await window.electronAPI.generateCoverImages({
        prompts: [buildRatioPrompt(prompt, ratio)],
        settings,
        outputDir: coversDir,
        aspectRatio: ratio,
        n,
      });
      return generated.map((c) => ({ ...c, selected: false }));
    },
    [coversDir, basePrompt, ensurePrompt],
  );

  const regenerateRatio = useCallback(
    async (ratio: ImageAspectRatio) => {
      const taskId = startCoverTask(`生成 ${ratio} 发布封面`, '生成封面候选');
      setError(null);
      setBusyRatios((prev) => (prev.includes(ratio) ? prev : [...prev, ratio]));
      try {
        const fresh = await runGeneration(ratio, RATIO_BATCH);
        setCandidates((prev) => appendCoverGenerationHistory(prev, fresh));
        useTaskProgressStore.getState().completeTask(taskId);
      } catch (e) {
        setError(failCoverTask(taskId, e));
      } finally {
        setBusyRatios((prev) => prev.filter((r) => r !== ratio));
        void scanDisk();
      }
    },
    [runGeneration, scanDisk],
  );

  const regenerateOne = useCallback(
    async (candidateId: string) => {
      setError(null);
      const target = candidates.find((c) => c.id === candidateId);
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
        setCandidates((prev) => appendCoverGenerationHistory(prev, [next]));
        useTaskProgressStore.getState().completeTask(taskId);
      } catch (e) {
        setError(failCoverTask(taskId, e));
      } finally {
        setBusyCandidateIds((prev) => prev.filter((id) => id !== candidateId));
        void scanDisk();
      }
    },
    [candidates, diskCovers, runGeneration, scanDisk],
  );

  const fillMissing = useCallback(async () => {
    setError(null);
    const targets = RATIO_VALUES.filter((r) => (groups[r]?.length ?? 0) === 0);
    if (targets.length === 0) return;
    const taskId = startCoverTask('补全发布封面比例', `生成 ${targets.length} 种比例`);
    setBusyRatios((prev) => Array.from(new Set([...prev, ...targets])));
    try {
      for (const ratio of targets) {
        const fresh = await runGeneration(ratio, RATIO_BATCH);
        setCandidates((prev) => [...prev, ...fresh]);
      }
      useTaskProgressStore.getState().completeTask(taskId);
    } catch (e) {
      setError(failCoverTask(taskId, e));
    } finally {
      setBusyRatios((prev) => prev.filter((r) => !targets.includes(r)));
      void scanDisk();
    }
  }, [groups, runGeneration, scanDisk]);

  const regenerateAll = useCallback(async () => {
    const taskId = startCoverTask('重新生成全部发布封面', '生成多比例封面');
    setError(null);
    setBusyRatios(RATIO_VALUES.slice());
    try {
      for (const ratio of RATIO_VALUES) {
        const fresh = await runGeneration(ratio, RATIO_BATCH);
        setCandidates((prev) => appendCoverGenerationHistory(prev, fresh));
      }
      useTaskProgressStore.getState().completeTask(taskId);
    } catch (e) {
      setError(failCoverTask(taskId, e));
    } finally {
      setBusyRatios([]);
      void scanDisk();
    }
  }, [runGeneration, scanDisk]);

  return {
    basePrompt,
    groups,
    busyRatios,
    busyCandidateIds,
    error,
    scanUnavailable: false,
    missingRatios,
    regenerateRatio,
    regenerateOne,
    fillMissing,
    regenerateAll,
  };
}
