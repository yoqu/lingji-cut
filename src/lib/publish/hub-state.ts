// 发布中心：工作目录为单元的草稿 / 列表摘要。
// 真源是 {workDir}/.lingji/publish.json；应用目录 jobs.json 只存列表摘要。

import { emptyPublishDraft, type PublishDraft } from './draft';
import type { PublishHistoryEntry } from '../project-persistence';

export interface HubJobSummary {
  workDir: string;
  title: string;
  thumbnail: string;
  updatedAt: number;
  lastPublishedAt: number | null;
  publishedPlatforms: Record<string, number>;
}

export interface HubJobState {
  draft: PublishDraft;
  coverPrompt: string;
  notes: string;
  history: PublishHistoryEntry[];
  publishedPlatforms: Record<string, number>;
  ingestedAt: number | null;
}

export interface HubJobsCatalog {
  jobs: HubJobSummary[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function emptyHubJobState(): HubJobState {
  return {
    draft: emptyPublishDraft(),
    coverPrompt: '',
    notes: '',
    history: [],
    publishedPlatforms: {},
    ingestedAt: null,
  };
}

function parseCovers(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value) out[key] = value;
  }
  return out;
}

function parsePublishedPlatforms(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** 宽松解析工作目录内 publish.json：坏文件不阻塞打开。 */
export function parseHubJobState(raw: unknown): HubJobState {
  const empty = emptyHubJobState();
  if (!raw || typeof raw !== 'object') return empty;
  const r = raw as Record<string, unknown>;
  const d = (r.draft && typeof r.draft === 'object' ? r.draft : {}) as Partial<PublishDraft>;
  return {
    draft: {
      filePath: str(d.filePath),
      title: str(d.title),
      desc: str(d.desc),
      tagsInput: str(d.tagsInput),
      thumbnail: str(d.thumbnail),
      covers: parseCovers(d.covers),
      bilibiliTid: str(d.bilibiliTid),
    },
    coverPrompt: str(r.coverPrompt),
    notes: str(r.notes),
    history: Array.isArray(r.history) ? (r.history as PublishHistoryEntry[]) : [],
    publishedPlatforms: parsePublishedPlatforms(r.publishedPlatforms),
    ingestedAt: num(r.ingestedAt),
  };
}

export function parseHubJobsCatalog(raw: unknown): HubJobsCatalog {
  if (!raw || typeof raw !== 'object') return { jobs: [] };
  const jobs = (raw as Record<string, unknown>).jobs;
  if (!Array.isArray(jobs)) return { jobs: [] };
  const parsed: HubJobSummary[] = [];
  for (const item of jobs) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const workDir = str(r.workDir);
    if (!workDir) continue;
    parsed.push({
      workDir,
      title: str(r.title),
      thumbnail: str(r.thumbnail),
      updatedAt: num(r.updatedAt) ?? 0,
      lastPublishedAt: num(r.lastPublishedAt),
      publishedPlatforms: parsePublishedPlatforms(r.publishedPlatforms),
    });
  }
  return { jobs: parsed };
}

export function resolveHubThumbnail(draft: PublishDraft): string {
  return draft.covers['3:4'] || draft.covers['16:9'] || draft.covers['4:3'] || draft.thumbnail || '';
}

export function summarizeHubJob(workDir: string, state: HubJobState): HubJobSummary {
  const platforms = state.publishedPlatforms;
  const lastPublishedAt = Object.values(platforms).reduce<number | null>((max, ts) => {
    if (max == null || ts > max) return ts;
    return max;
  }, null);
  return {
    workDir,
    title: state.draft.title.trim() || basename(workDir),
    thumbnail: resolveHubThumbnail(state.draft),
    updatedAt: Date.now(),
    lastPublishedAt,
    publishedPlatforms: platforms,
  };
}

export function hubJobHasDraft(state: HubJobState): boolean {
  return Boolean(state.draft.filePath.trim() && state.draft.title.trim());
}

function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

/** 由标题 + 简介拼装封面提示词素材；皆空返回 null。 */
export function buildHubCoverSource(title: string, desc: string): string | null {
  const h = title.trim();
  const d = desc.trim();
  if (!h && !d) return null;
  const parts: string[] = [];
  if (h) parts.push(`视频标题：${h}`);
  if (d) parts.push(`视频简介：${d}`);
  return parts.join('\n');
}

export function formatPublishMaterialsMarkdown(draft: PublishDraft): string {
  const title = draft.title.trim() || '未命名';
  const desc = draft.desc.trim();
  const tags = draft.tagsInput.trim();
  return [
    `# 《${title}》发布物料`,
    '',
    '## 标题',
    title,
    '',
    '## 简介',
    desc,
    '',
    '## 标签',
    tags,
    '',
  ].join('\n');
}
