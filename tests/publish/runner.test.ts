import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../electron/publish/platforms', () => ({ getPlatform: vi.fn() }));

import { getPlatform } from '../../electron/publish/platforms';
import { runPublishJob, type PublishProgressPayload } from '../../electron/publish/runner';
import { LoginExpiredError } from '../../electron/publish/errors';
import type { AccountStore } from '../../electron/publish/accounts';
import type { PublishJob } from '../../electron/publish/types';

const mockedGetPlatform = vi.mocked(getPlatform);

function makeStore(ids: string[]): AccountStore {
  return {
    list: () =>
      ids.map((id) => ({
        id,
        platform: id.split('_')[0],
        accountName: id.split('_')[1],
        storageStatePath: `/state/${id}.json`,
        status: 'valid',
      })),
  } as unknown as AccountStore;
}

function makeJob(accountIds: string[]): PublishJob {
  return {
    id: 'job-1',
    filePath: '/v.mp4',
    shared: { title: 'T', desc: 'D', tags: ['a'] },
    targets: accountIds.map((accountId) => ({ accountId })),
    results: {},
  };
}

beforeEach(() => {
  mockedGetPlatform.mockReset();
});

describe('runPublishJob（回调解耦版）', () => {
  it('成功路径：进度经 send 回调外发并返回 success 结果', async () => {
    const uploadVideo = vi.fn(async (opts: { onProgress?: (p: number, m: string) => void }) => {
      opts.onProgress?.(50, '上传中');
    });
    mockedGetPlatform.mockReturnValue({ uploadVideo } as never);

    const events: PublishProgressPayload[] = [];
    const results = await runPublishJob(
      makeJob(['douyin_a']),
      makeStore(['douyin_a']),
      (p) => events.push(p),
      () => false,
      true,
    );

    expect(results).toEqual({ douyin_a: { state: 'success' } });
    expect(events.map((e) => e.state)).toEqual(['running', 'running', 'success']);
    expect(uploadVideo.mock.calls[0][0]).toMatchObject({ filePath: '/v.mp4', title: 'T', headless: true });
  });

  it('登录失效 → login-expired；普通异常 → failed；账号缺失 → skipped', async () => {
    const uploadVideo = vi
      .fn()
      .mockRejectedValueOnce(new LoginExpiredError('会话过期'))
      .mockRejectedValueOnce(new Error('网络炸了'));
    mockedGetPlatform.mockReturnValue({ uploadVideo } as never);

    const results = await runPublishJob(
      makeJob(['douyin_a', 'bilibili_b', 'kuaishou_missing']),
      makeStore(['douyin_a', 'bilibili_b']),
      () => {},
      () => false,
      true,
    );

    expect(results.douyin_a.state).toBe('login-expired');
    expect(results.bilibili_b).toEqual({ state: 'failed', message: '网络炸了' });
    expect(results.kuaishou_missing.state).toBe('skipped');
  });

  it('取消导致的 in-flight 失败标记为「已取消」', async () => {
    let cancelled = false;
    const uploadVideo = vi.fn(async () => {
      cancelled = true;
      throw new Error('Target closed');
    });
    mockedGetPlatform.mockReturnValue({ uploadVideo } as never);

    const results = await runPublishJob(
      makeJob(['douyin_a']),
      makeStore(['douyin_a']),
      () => {},
      () => cancelled,
      true,
    );

    expect(results.douyin_a).toEqual({ state: 'failed', message: '已取消' });
  });

  it('isCancelled 为 true 时跳过剩余 target', async () => {
    const uploadVideo = vi.fn(async () => {});
    mockedGetPlatform.mockReturnValue({ uploadVideo } as never);

    let calls = 0;
    const results = await runPublishJob(
      makeJob(['douyin_a', 'bilibili_b']),
      makeStore(['douyin_a', 'bilibili_b']),
      () => {},
      () => calls++ > 0,
      true,
    );

    expect(Object.keys(results)).toEqual(['douyin_a']);
    expect(uploadVideo).toHaveBeenCalledTimes(1);
  });
});
