/**
 * 声呐「待创作箱」持久化（设计文档第 6 节）。
 *
 * 扩展经 /sonar/enqueue 推入的转录稿+元数据落地于此，欢迎页「待创作箱」消费。
 * 纯模块：文件路径 / now / newId 均可注入，便于单测；按 awemeId 幂等去重。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const SONAR_INBOX_FILE = join(homedir(), '.lingji', 'sonar-inbox.json');

export interface SonarTranscriptSegment {
  text: string;
  startMs: number;
  endMs: number;
}

export interface SonarTranscript {
  fullText: string;
  srtText: string;
  segments: SonarTranscriptSegment[];
}

/** 爆款拆解报告（工作流流水线产出，随转录稿一并送入待创作箱）。 */
export interface SonarInsight {
  angle: string;
  hook: string;
  structure: string[];
  highlights: string[];
  dataPoints: string[];
  remixSuggestions: string[];
}

/** 扩展推送的入队负载（/sonar/enqueue body）。 */
export interface SonarEnqueueInput {
  source: string;
  awemeId: string;
  creatorId: string;
  creatorName: string;
  title: string;
  url: string;
  coverUrl?: string;
  publishedAt: number;
  durationMs?: number;
  transcript: SonarTranscript;
  /** 可选：爆款拆解报告。 */
  insight?: SonarInsight;
}

export type SonarInboxStatus = 'pending' | 'creating' | 'drafted' | 'failed';

export interface SonarInboxItem extends SonarEnqueueInput {
  id: string;
  status: SonarInboxStatus;
  projectPath?: string;
  error?: string;
  receivedAt: number;
  updatedAt: number;
}

export interface SonarStatusPatch {
  projectPath?: string;
  error?: string;
}

export interface SonarEnqueueResult {
  item: SonarInboxItem;
  duplicate: boolean;
  /** refresh 模式下命中已有项并被覆盖刷新（重置为 pending）。 */
  refreshed?: boolean;
}

export interface SonarEnqueueOptions {
  /** 命中已有 awemeId 时：true=覆盖刷新并重置为 pending（手动推送）；false/缺省=去重（自动监听）。 */
  refresh?: boolean;
}

export interface SonarInboxStore {
  enqueue(input: SonarEnqueueInput, opts?: SonarEnqueueOptions): Promise<SonarEnqueueResult>;
  list(): Promise<SonarInboxItem[]>;
  get(id: string): Promise<SonarInboxItem | null>;
  getByAweme(awemeId: string): Promise<SonarInboxItem | null>;
  markStatus(
    id: string,
    status: SonarInboxStatus,
    patch?: SonarStatusPatch,
  ): Promise<SonarInboxItem | null>;
  remove(id: string): Promise<boolean>;
  /** 清空全部收件项，返回删除条数。 */
  clear(): Promise<number>;
}

export interface SonarInboxStoreDeps {
  file?: string;
  now?: () => number;
  newId?: () => string;
}

interface InboxFile {
  items: SonarInboxItem[];
}

export function createSonarInboxStore(deps: SonarInboxStoreDeps = {}): SonarInboxStore {
  const file = deps.file ?? SONAR_INBOX_FILE;
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => randomUUID());

  let items: SonarInboxItem[] | null = null;

  async function ensureLoaded(): Promise<SonarInboxItem[]> {
    if (items) return items;
    try {
      const raw = await readFile(file, 'utf-8');
      const parsed = JSON.parse(raw) as InboxFile;
      items = Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
      // 文件不存在或损坏 → 空列表（不抛，避免单条坏数据阻断整条链路）。
      items = [];
    }
    return items;
  }

  async function persist(): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ items: items ?? [] } satisfies InboxFile, null, 2), 'utf-8');
  }

  return {
    async enqueue(input, opts) {
      const all = await ensureLoaded();
      const idx = all.findIndex((i) => i.awemeId === input.awemeId);
      if (idx >= 0) {
        // 去重（自动监听）：保留原项。
        if (!opts?.refresh) return { item: all[idx]!, duplicate: true };
        // 刷新（手动推送）：覆盖元数据/转录，保留 id 与 receivedAt，重置为 pending。
        const t = now();
        const refreshed: SonarInboxItem = {
          ...all[idx]!,
          ...input,
          id: all[idx]!.id,
          status: 'pending',
          projectPath: undefined,
          error: undefined,
          receivedAt: all[idx]!.receivedAt,
          updatedAt: t,
        };
        all[idx] = refreshed;
        await persist();
        return { item: refreshed, duplicate: false, refreshed: true };
      }
      const t = now();
      const item: SonarInboxItem = {
        ...input,
        id: newId(),
        status: 'pending',
        receivedAt: t,
        updatedAt: t,
      };
      all.push(item);
      await persist();
      return { item, duplicate: false };
    },

    async list() {
      const all = await ensureLoaded();
      // 按视频发布时间倒序（缺失回退推送时间，同刻再按推送时间）。
      return [...all].sort(
        (a, b) =>
          (b.publishedAt || b.receivedAt) - (a.publishedAt || a.receivedAt) ||
          b.receivedAt - a.receivedAt,
      );
    },

    async get(id) {
      const all = await ensureLoaded();
      return all.find((i) => i.id === id) ?? null;
    },

    async getByAweme(awemeId) {
      const all = await ensureLoaded();
      return all.find((i) => i.awemeId === awemeId) ?? null;
    },

    async markStatus(id, status, patch) {
      const all = await ensureLoaded();
      const item = all.find((i) => i.id === id);
      if (!item) return null;
      item.status = status;
      item.updatedAt = now();
      if (patch?.projectPath !== undefined) item.projectPath = patch.projectPath;
      if (patch?.error !== undefined) item.error = patch.error;
      await persist();
      return item;
    },

    async remove(id) {
      const all = await ensureLoaded();
      const idx = all.findIndex((i) => i.id === id);
      if (idx === -1) return false;
      all.splice(idx, 1);
      await persist();
      return true;
    },

    async clear() {
      const all = await ensureLoaded();
      const n = all.length;
      all.length = 0;
      await persist();
      return n;
    },
  };
}
