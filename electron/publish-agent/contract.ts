import path from 'node:path';
import type { PublishDraft } from '../../src/lib/publish/draft';

export const PUBLISH_INGEST_COVER_RATIOS = ['16:9', '4:3', '3:4'] as const;
export type PublishIngestCoverRatio = (typeof PUBLISH_INGEST_COVER_RATIOS)[number];

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v']);

export interface PublishIngestDraft {
  filePath: string;
  title: string;
  desc?: string;
  tags?: string[];
  covers?: Partial<Record<PublishIngestCoverRatio, string>>;
  thumbnail?: string;
  bilibiliTid?: string;
  coverPrompt?: string;
  notes?: string;
}

export interface PublishIngestIssue {
  code: string;
  path: string;
  message: string;
}

export function isPathInside(filePath: string, dir: string): boolean {
  if (!filePath || !dir) return false;
  const resolvedFile = path.resolve(filePath);
  const resolvedDir = path.resolve(dir);
  const rel = path.relative(resolvedDir, resolvedFile);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function parseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const cleaned = item.trim().replace(/^#+/, '').trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    tags.push(cleaned);
  }
  return tags.slice(0, 12);
}

function parseCovers(raw: unknown): Partial<Record<PublishIngestCoverRatio, string>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<PublishIngestCoverRatio, string>> = {};
  for (const ratio of PUBLISH_INGEST_COVER_RATIOS) {
    const value = str((raw as Record<string, unknown>)[ratio]);
    if (value) out[ratio] = value;
  }
  return out;
}

export function coercePublishIngestDraft(raw: unknown): PublishIngestDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const filePath = str(r.filePath);
  const title = str(r.title);
  if (!filePath && !title) return null;
  return {
    filePath,
    title,
    desc: str(r.desc) || undefined,
    tags: parseTags(r.tags),
    covers: parseCovers(r.covers),
    thumbnail: str(r.thumbnail) || undefined,
    bilibiliTid: str(r.bilibiliTid) || undefined,
    coverPrompt: str(r.coverPrompt) || undefined,
    notes: str(r.notes) || undefined,
  };
}

/**
 * 只校验存在性与类型，不规定文件名。
 * fileExists 由调用方注入，便于单测。
 */
export function validatePublishIngestDraft(
  raw: unknown,
  workDir: string,
  fileExists: (absPath: string) => boolean,
): { ok: true; draft: PublishIngestDraft } | { ok: false; issues: PublishIngestIssue[] } {
  const issues: PublishIngestIssue[] = [];
  const draft = coercePublishIngestDraft(raw);
  if (!draft) {
    return {
      ok: false,
      issues: [{ code: 'draft_invalid', path: '', message: '提交内容不是有效的发布草案' }],
    };
  }
  if (!draft.filePath) {
    issues.push({ code: 'file_required', path: 'filePath', message: '必须指定成片视频路径' });
  } else {
    const abs = path.isAbsolute(draft.filePath) ? draft.filePath : path.join(workDir, draft.filePath);
    draft.filePath = abs;
    if (!isPathInside(abs, workDir)) {
      issues.push({ code: 'file_outside', path: 'filePath', message: '成片路径必须位于工作目录内' });
    } else if (!VIDEO_EXTS.has(path.extname(abs).toLowerCase())) {
      issues.push({ code: 'file_not_video', path: 'filePath', message: '成片必须是视频文件' });
    } else if (!fileExists(abs)) {
      issues.push({ code: 'file_missing', path: 'filePath', message: '成片文件不存在' });
    }
  }
  if (!draft.title) {
    issues.push({ code: 'title_required', path: 'title', message: '标题不能为空' });
  }
  const covers = draft.covers ?? {};
  for (const ratio of PUBLISH_INGEST_COVER_RATIOS) {
    const coverPath = covers[ratio];
    if (!coverPath) continue;
    const abs = path.isAbsolute(coverPath) ? coverPath : path.join(workDir, coverPath);
    covers[ratio] = abs;
    if (!isPathInside(abs, workDir)) {
      issues.push({ code: 'cover_outside', path: `covers.${ratio}`, message: `${ratio} 封面必须位于工作目录内` });
    } else if (!fileExists(abs)) {
      issues.push({ code: 'cover_missing', path: `covers.${ratio}`, message: `${ratio} 封面文件不存在` });
    }
  }
  draft.covers = covers;
  if (draft.thumbnail) {
    const abs = path.isAbsolute(draft.thumbnail) ? draft.thumbnail : path.join(workDir, draft.thumbnail);
    draft.thumbnail = abs;
    if (!isPathInside(abs, workDir)) {
      issues.push({ code: 'thumb_outside', path: 'thumbnail', message: '封面缩略图必须位于工作目录内' });
    } else if (!fileExists(abs)) {
      issues.push({ code: 'thumb_missing', path: 'thumbnail', message: '封面缩略图文件不存在' });
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, draft };
}

export function ingestDraftToPublishDraft(draft: PublishIngestDraft): PublishDraft {
  const covers: Record<string, string> = {};
  for (const ratio of PUBLISH_INGEST_COVER_RATIOS) {
    const p = draft.covers?.[ratio];
    if (p) covers[ratio] = p;
  }
  return {
    filePath: draft.filePath,
    title: draft.title,
    desc: draft.desc ?? '',
    tagsInput: (draft.tags ?? []).join(', '),
    thumbnail: draft.thumbnail || covers['3:4'] || covers['16:9'] || covers['4:3'] || '',
    covers,
    bilibiliTid: draft.bilibiliTid ?? '',
  };
}
