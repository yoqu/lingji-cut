import { describe, expect, it } from 'vitest';
import {
  buildPublishShared,
  buildPublishTargets,
  emptyPublishDraft,
  parseTags,
  validatePublishDraft,
  type PublishDraft,
} from '../src/lib/publish/draft';
import type { PublishAccount } from '../src/lib/electron-api';

function draftWith(patch: Partial<PublishDraft>): PublishDraft {
  return { ...emptyPublishDraft(), ...patch };
}

const accounts: PublishAccount[] = [
  {
    id: 'bilibili_主号',
    platform: 'bilibili',
    accountName: '主号',
    storageStatePath: '/tmp/b.json',
    status: 'valid',
  },
  {
    id: 'douyin_小号',
    platform: 'douyin',
    accountName: '小号',
    storageStatePath: '/tmp/d.json',
    status: 'valid',
  },
];

describe('parseTags', () => {
  it('支持中英文逗号并去空', () => {
    expect(parseTags('财经, 新能源，, 深度 ')).toEqual(['财经', '新能源', '深度']);
  });
});

describe('buildPublishShared', () => {
  it('只收集已选比例，thumbnail 兜底优先竖图', () => {
    const shared = buildPublishShared(
      draftWith({
        title: 'T',
        desc: 'D',
        tagsInput: 'a,b',
        thumbnail: '/t.png',
        covers: { '16:9': '/w.png', '3:4': '/v.png' },
      }),
    );
    expect(shared.covers).toEqual({ '16:9': '/w.png', '3:4': '/v.png' });
    expect(shared.thumbnail).toBe('/v.png');
    expect(shared.tags).toEqual(['a', 'b']);
  });

  it('无封面时 covers 为 undefined、thumbnail 用单图', () => {
    const shared = buildPublishShared(draftWith({ thumbnail: '/t.png' }));
    expect(shared.covers).toBeUndefined();
    expect(shared.thumbnail).toBe('/t.png');
  });
});

describe('validatePublishDraft', () => {
  it('Chromium 缺失优先拦截', () => {
    expect(
      validatePublishDraft(draftWith({}), { hasBilibili: false, chromiumMissing: true }),
    ).toContain('Chromium');
  });

  it('B站需要 tid 与描述', () => {
    expect(
      validatePublishDraft(draftWith({}), { hasBilibili: true, chromiumMissing: false }),
    ).toContain('分区');
    expect(
      validatePublishDraft(draftWith({ bilibiliTid: '21' }), {
        hasBilibili: true,
        chromiumMissing: false,
      }),
    ).toContain('描述');
    expect(
      validatePublishDraft(draftWith({ bilibiliTid: '21', desc: 'd' }), {
        hasBilibili: true,
        chromiumMissing: false,
      }),
    ).toBeNull();
  });
});

describe('buildPublishTargets', () => {
  it('B站目标附加 tid，历史快照带平台与昵称', () => {
    const { targets, historyTargets } = buildPublishTargets(
      draftWith({ bilibiliTid: '21' }),
      ['bilibili_主号', 'douyin_小号'],
      accounts,
    );
    expect(targets).toEqual([
      { accountId: 'bilibili_主号', bilibili: { tid: 21 } },
      { accountId: 'douyin_小号' },
    ]);
    expect(historyTargets[0]).toMatchObject({
      platform: 'bilibili',
      accountName: '主号',
      bilibiliTid: 21,
    });
    expect(historyTargets[1]).toMatchObject({ platform: 'douyin', accountName: '小号' });
    expect(historyTargets[1].bilibiliTid).toBeUndefined();
  });

  it('未知账号从 accountId 回推平台与昵称', () => {
    const { historyTargets } = buildPublishTargets(draftWith({}), ['kuaishou_老号'], accounts);
    expect(historyTargets[0]).toMatchObject({ platform: 'kuaishou', accountName: '老号' });
  });
});
