// 发布草稿：项目无关的发布表单数据与纯逻辑。
// 项目发布 tab 与发布中心共用；持久化由各自适配层负责
// （project.json publish 段 / 工作目录 .lingji/publish.json）。

import type {
  PublishAccount,
  PublishShared,
  PublishTarget,
  PublishCoverRatio,
} from '../electron-api';
import type { PublishHistoryTarget } from '../project-persistence';

export interface PublishDraft {
  filePath: string;
  title: string;
  desc: string;
  tagsInput: string;
  thumbnail: string;
  /** 按比例各选一张封面（16:9 / 4:3 / 3:4）。 */
  covers: Record<string, string>;
  /** B站分区 tid（字符串态，与输入框一致）。 */
  bilibiliTid: string;
}

export function emptyPublishDraft(): PublishDraft {
  return {
    filePath: '',
    title: '',
    desc: '',
    tagsInput: '',
    thumbnail: '',
    covers: {},
    bilibiliTid: '',
  };
}

export function parseTags(tagsInput: string): string[] {
  return tagsInput
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

const COVER_RATIOS: PublishCoverRatio[] = ['16:9', '4:3', '3:4'];

/** 组装全平台共享文案：多比例封面仅收集已选比例，单图 thumbnail 兜底优先竖图。 */
export function buildPublishShared(draft: PublishDraft): PublishShared {
  const coversObj = COVER_RATIOS.reduce<Record<string, string>>((acc, r) => {
    if (draft.covers[r]) acc[r] = draft.covers[r];
    return acc;
  }, {});
  const primaryThumb =
    draft.covers['3:4'] || draft.covers['16:9'] || draft.covers['4:3'] || draft.thumbnail || undefined;
  return {
    title: draft.title,
    desc: draft.desc,
    tags: parseTags(draft.tagsInput),
    thumbnail: primaryThumb,
    covers: Object.keys(coversObj).length ? coversObj : undefined,
  };
}

export function parseBilibiliTid(draft: PublishDraft): number {
  return parseInt(draft.bilibiliTid.trim(), 10);
}

/** 发布前校验；返回错误文案或 null。B站账号额外要求 tid 与描述。 */
export function validatePublishDraft(
  draft: PublishDraft,
  opts: { hasBilibili: boolean; chromiumMissing: boolean },
): string | null {
  if (opts.chromiumMissing) return '发布前请先下载浏览器组件（Chromium）';
  if (opts.hasBilibili) {
    const tid = parseBilibiliTid(draft);
    if (!draft.bilibiliTid.trim() || isNaN(tid) || tid <= 0) return '发布到 B站需要先选择分区';
    if (!draft.desc.trim()) return '发布到 B站需要填写描述';
  }
  return null;
}

/** 由勾选账号构造发布目标与历史快照（B站附加 tid）。 */
export function buildPublishTargets(
  draft: PublishDraft,
  selectedAccountIds: string[],
  accounts: PublishAccount[],
): { targets: PublishTarget[]; historyTargets: PublishHistoryTarget[] } {
  const tid = parseBilibiliTid(draft);
  const targets: PublishTarget[] = selectedAccountIds.map((accountId) => {
    const acc = accounts.find((a) => a.id === accountId);
    const bilibiliExtra: PublishTarget['bilibili'] =
      acc?.platform === 'bilibili' && !isNaN(tid) ? { tid } : undefined;
    return { accountId, ...(bilibiliExtra ? { bilibili: bilibiliExtra } : {}) };
  });
  const historyTargets: PublishHistoryTarget[] = selectedAccountIds.map((accountId) => {
    const acc = accounts.find((a) => a.id === accountId);
    return {
      accountId,
      platform: acc?.platform ?? accountId.split('_')[0],
      accountName: acc?.accountName ?? accountId.split('_').slice(1).join('_'),
      ...(acc?.platform === 'bilibili' && !isNaN(tid) ? { bilibiliTid: tid } : {}),
    };
  });
  return { targets, historyTargets };
}
