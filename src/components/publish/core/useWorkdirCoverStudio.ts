// 发布中心封面工作台：扫描 workDir/covers，并把 agent 选中的任意路径注入候选组。
// 生图产物写 {workDir}/covers/（generateCoverImages.outputDir 跳过导演门禁）。

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
  importLocalCovers,
  ratioFromFileName,
  startCoverTask,
  PUBLISH_RATIOS,
  type CoverStudio,
  type DiskCover,
} from '../useCoverStudio';

const RATIO_VALUES = PUBLISH_RATIOS.map((r) => r.ratio);
const RATIO_BATCH = 2;

function seedDiskCovers(covers: Record<string, string>): DiskCover[] {
  const now = Date.now();
  const mapped: DiskCover[] = [];
  for (const ratio of RATIO_VALUES) {
    const imageUrl = covers[ratio];
    if (!imageUrl) continue;
    mapped.push({ path: imageUrl, ratio, mtimeMs: now });
  }
  return mapped;
}

export function useWorkdirCoverStudio(args: {
  workDir: string | null;
  coverPrompt: string;
  selectedCovers: Record<string, string>;
  ensurePrompt: () => Promise<string>;
}): CoverStudio {
  const { workDir, coverPrompt, selectedCovers, ensurePrompt } = args;
  const [candidates, setCandidates] = useState<CoverCandidate[]>([]);
  const [busyRatios, setBusyRatios] = useState<ImageAspectRatio[]>([]);
  const [busyCandidateIds, setBusyCandidateIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [diskCovers, setDiskCovers] = useState<DiskCover[]>([]);

  const basePrompt = coverPrompt.trim() || null;
  const coversDir = workDir ? `${workDir.replace(/[\\/]+$/, '')}/covers` : null;

  const scanDisk = useCallback(async () => {
    const seeded = seedDiskCovers(selectedCovers);
    if (!workDir || typeof window.electronAPI?.scanCoverImages !== 'function') {
      setDiskCovers(seeded);
      return;
    }
    try {
      const found = await window.electronAPI.scanCoverImages(workDir);
      const mapped: DiskCover[] = [...seeded];
      const seen = new Set(seeded.map((item) => item.path));
      for (const file of found) {
        if (seen.has(file.path)) continue;
        const ratio = ratioFromFileName(file.path) ?? classifyRatio(file.width, file.height);
        if (ratio) mapped.push({ path: file.path, ratio, mtimeMs: file.mtimeMs });
      }
      setDiskCovers(mapped);
    } catch {
      setDiskCovers(seeded);
    }
  }, [workDir, selectedCovers]);

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
      if (!coversDir) throw new Error('工作目录尚未就绪，请稍后重试');
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

  const importLocal = useCallback(
    async (ratio: ImageAspectRatio): Promise<string | null> => {
      setError(null);
      if (!workDir) {
        setError('工作目录尚未就绪，请稍后重试');
        return null;
      }
      try {
        const imported = await importLocalCovers(workDir, ratio);
        if (imported.length === 0) return null;
        setCandidates((prev) => appendCoverGenerationHistory(prev, imported));
        return imported[0].imageUrl;
      } catch (e) {
        setError(e instanceof Error ? e.message : '导入本地图片失败');
        return null;
      } finally {
        void scanDisk();
      }
    },
    [workDir, scanDisk],
  );

  return {
    basePrompt,
    groups,
    busyRatios,
    busyCandidateIds,
    error,
    scanUnavailable: false,
    missingRatios,
    importLocal,
    regenerateRatio,
    regenerateOne,
    fillMissing,
    regenerateAll,
  };
}
