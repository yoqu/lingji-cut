import { hashScriptForPodcast } from '../../lib/script-hash';
import { serializeSrtEntries } from '../../lib/srt-parser';
import { getProjectDir, useTimelineStore } from '../../store/timeline';
import { patchWorkflowMeta } from './workflow-meta';

interface PodcastMediaResult {
  audioPath: string;
  srtPath: string;
  durationMs: number;
}

async function persistResegmentedSrt(srtPath: string, projectDir: string): Promise<void> {
  const state = useTimelineStore.getState();
  if (state.srtEntries.length === state.originalSrtEntries.length) return;
  const content = serializeSrtEntries(state.srtEntries);
  const fileName = srtPath.split(/[\\/]/).pop() ?? 'podcast-subtitles.srt';
  try {
    await window.electronAPI.saveScriptFile(projectDir, fileName, content);
  } catch (error) {
    console.warn('[subtitle] 切分后写回 SRT 失败，磁盘保留原始版本', error);
  }
}

async function resolvePodcastDuration(result: PodcastMediaResult): Promise<number> {
  const actual = result.audioPath
    ? await window.electronAPI.getAudioDuration(result.audioPath).catch(() => 0)
    : 0;
  return actual > 0 ? actual : result.durationMs;
}

export async function persistGeneratedPodcastMedia(
  result: PodcastMediaResult,
  projectDir: string,
  scriptText: string,
): Promise<void> {
  const { entries } = await window.electronAPI.parseSrtFile(result.srtPath);
  const durationMs = await resolvePodcastDuration(result);
  useTimelineStore.getState().setSrtEntries(entries);
  await persistResegmentedSrt(result.srtPath, projectDir);
  useTimelineStore.getState().setPodcast(
    result.audioPath,
    result.srtPath,
    durationMs,
  );
  void patchWorkflowMeta(projectDir, {
    lastPodcastScriptHash: hashScriptForPodcast(scriptText),
  });
}

export async function hydrateReusablePodcastMedia(): Promise<void> {
  const state = useTimelineStore.getState();
  const audioPath = state.timeline.podcast.audioPath?.trim() ?? '';
  const srtPath = state.timeline.podcast.srtPath?.trim() ?? '';
  if (!srtPath) throw new Error('未找到可复用的字幕文件，请重新生成音频与字幕');
  if (state.srtEntries.length > 0 && state.timeline.podcast.durationMs > 0) return;
  const { entries, durationMs } = await window.electronAPI.parseSrtFile(srtPath);
  const fallbackDurationMs = state.timeline.podcast.durationMs > 0
    ? state.timeline.podcast.durationMs
    : durationMs;
  const actualDurationMs = await resolvePodcastDuration({
    audioPath, srtPath, durationMs: fallbackDurationMs,
  });
  state.setSrtEntries(entries);
  const projectDir = getProjectDir();
  if (projectDir) await persistResegmentedSrt(srtPath, projectDir);
  state.setPodcast(audioPath, srtPath, actualDurationMs);
}
