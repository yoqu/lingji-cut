// 自由发布（无项目）持久化状态：schema 由渲染层拥有，
// 主进程 publish:standalone-load/save 只做透明 JSON 读写。

import { emptyPublishDraft, type PublishDraft } from './draft';
import type { PublishHistoryEntry } from '../project-persistence';

export interface StandalonePublishState {
  draft: PublishDraft;
  /** 用户手写的视频主题，作为 AI 文案 / 封面生成素材。 */
  topic: string;
  /** 封面生图提示词（AI 按主题生成，可手动编辑）。 */
  coverPrompt: string;
  history: PublishHistoryEntry[];
  publishedPlatforms: Record<string, number>;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 宽松解析磁盘状态：字段缺失 / 类型不符时回退空值，坏文件不阻塞页面。 */
export function parseStandaloneState(raw: unknown): StandalonePublishState {
  const empty: StandalonePublishState = {
    draft: emptyPublishDraft(),
    topic: '',
    coverPrompt: '',
    history: [],
    publishedPlatforms: {},
  };
  if (!raw || typeof raw !== 'object') return empty;
  const r = raw as Record<string, unknown>;
  const d = (r.draft && typeof r.draft === 'object' ? r.draft : {}) as Partial<PublishDraft>;
  const covers =
    d.covers && typeof d.covers === 'object'
      ? Object.fromEntries(
          Object.entries(d.covers).filter(([, p]) => typeof p === 'string' && p),
        )
      : {};
  return {
    draft: {
      filePath: str(d.filePath),
      title: str(d.title),
      desc: str(d.desc),
      tagsInput: str(d.tagsInput),
      thumbnail: str(d.thumbnail),
      covers: covers as Record<string, string>,
      bilibiliTid: str(d.bilibiliTid),
    },
    topic: str(r.topic),
    coverPrompt: str(r.coverPrompt),
    history: Array.isArray(r.history) ? (r.history as PublishHistoryEntry[]) : [],
    publishedPlatforms:
      r.publishedPlatforms && typeof r.publishedPlatforms === 'object'
        ? (r.publishedPlatforms as Record<string, number>)
        : {},
  };
}

/** 由主题 + 标题拼装封面提示词生成的内容素材（喂给 cover.regeneration 模板的
 *  「字幕内容」位，由 LLM 产出真正的生图提示词）；两者皆空返回 null（禁用生成）。 */
export function buildStandaloneCoverSource(topic: string, title: string): string | null {
  const t = topic.trim();
  const h = title.trim();
  if (!t && !h) return null;
  const parts: string[] = [];
  if (h) parts.push(`视频标题：${h}`);
  if (t) parts.push(`视频主题与内容：${t}`);
  return parts.join('\n');
}
