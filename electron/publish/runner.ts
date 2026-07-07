import type { PublishJob } from './types';
import { getPlatform } from './platforms';
import { parseAccountId } from './account-id';
import { AccountStore } from './accounts';
import { LoginExpiredError } from './errors';

export interface PublishProgressPayload {
  jobId: string;
  accountId: string;
  state: string;
  percent?: number;
  message?: string;
}

export type PublishTargetResult = { state: 'success' | 'failed' | 'login-expired' | 'skipped'; message?: string };

/** 逐 target 上传；进度经 send 回调外发（renderer IPC 或 pipeline task 均可挂接） */
export async function runPublishJob(
  job: PublishJob,
  store: AccountStore,
  send: (payload: PublishProgressPayload) => void,
  isCancelled: () => boolean,
  headless: boolean,
): Promise<Record<string, PublishTargetResult>> {
  const results: Record<string, PublishTargetResult> = {};
  for (const target of job.targets) {
    if (isCancelled()) break;
    const acc = store.list().find((a) => a.id === target.accountId);
    if (!acc) {
      results[target.accountId] = { state: 'skipped', message: '账号不存在' };
      continue;
    }
    const emit = (state: string, percent?: number, message?: string) =>
      send({ jobId: job.id, accountId: target.accountId, state, percent, message });
    emit('running', 0);
    try {
      const { platform } = parseAccountId(target.accountId);
      await getPlatform(platform).uploadVideo({
        storageStatePath: acc.storageStatePath,
        filePath: job.filePath,
        title: target.overrides?.title ?? job.shared.title,
        desc: target.overrides?.desc ?? job.shared.desc,
        tags: target.overrides?.tags ?? job.shared.tags,
        thumbnail: job.shared.thumbnail,
        covers: job.shared.covers,
        scheduleAt: job.shared.scheduleAt,
        headless,
        tid: target.bilibili?.tid,
        onProgress: (p, m) => emit('running', p, m),
      });
      emit('success', 100);
      results[target.accountId] = { state: 'success' };
    } catch (err) {
      // 登录态失效单独标记 'login-expired'：Renderer 据此弹窗重登并自动续发，
      // 区别于不可恢复的普通失败。
      const state = err instanceof LoginExpiredError ? 'login-expired' : 'failed';
      const message = err instanceof Error ? err.message : String(err);
      emit(state, undefined, message);
      results[target.accountId] = { state, message };
    }
  }
  return results;
}
