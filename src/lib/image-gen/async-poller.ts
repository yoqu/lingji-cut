import type { ImageProviderType } from '../../types/ai';
import { ImageGenerationError, type ImageGenerationErrorCode } from './errors';
import type { ImageGenerationContext } from './types';

export interface PollerStatus<T> {
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  percent?: number;
  result?: T;
  error?: { code: ImageGenerationErrorCode; message: string };
}

export interface PollerOptions<T> {
  submit: () => Promise<{ taskId: string; estimatedSeconds?: number }>;
  fetchStatus: (taskId: string) => Promise<PollerStatus<T>>;
  intervalMs?: number;
  timeoutMs?: number;
  onProgress: ImageGenerationContext['onProgress'];
  signal: AbortSignal;
  providerType: ImageProviderType;
}

const FAKE_PERCENT_STEPS = [10, 25, 45, 60, 75, 85, 92, 95];
/** 轮询允许的最大连续网络失败次数；达到上限才视为真正失败，避免偶发 TLS 抖动杀掉已提交的任务 */
const MAX_CONSECUTIVE_NETWORK_FAILURES = 5;

export async function pollUntilDone<T>(opts: PollerOptions<T>): Promise<T> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const startedAt = Date.now();

  ensureNotAborted(opts.signal, opts.providerType);
  opts.onProgress({ percent: 5, phase: 'submitting', message: '提交任务中…' });

  const submission = await opts.submit();
  const { taskId } = submission;
  opts.onProgress({ percent: 8, phase: 'queued', message: '已入队，等待生成…' });

  let fakeStepIndex = 0;
  let consecutiveNetworkFailures = 0;

  while (true) {
    ensureNotAborted(opts.signal, opts.providerType);

    if (Date.now() - startedAt > timeoutMs) {
      throw new ImageGenerationError(
        'timeout',
        opts.providerType,
        `任务 ${taskId} 超过 ${Math.round(timeoutMs / 1000)}s 仍未完成`,
      );
    }

    let status: PollerStatus<T>;
    try {
      status = await opts.fetchStatus(taskId);
      consecutiveNetworkFailures = 0;
    } catch (err) {
      if (err instanceof ImageGenerationError && err.code === 'network') {
        consecutiveNetworkFailures++;
        if (consecutiveNetworkFailures < MAX_CONSECUTIVE_NETWORK_FAILURES) {
          await sleep(intervalMs, opts.signal, opts.providerType);
          continue;
        }
      }
      if (err instanceof ImageGenerationError) throw err;
      throw new ImageGenerationError('network', opts.providerType, '轮询任务状态失败', err);
    }

    if (status.status === 'succeeded') {
      if (status.result === undefined) {
        throw new ImageGenerationError(
          'server',
          opts.providerType,
          `任务 ${taskId} 标记 succeeded 但缺少结果`,
        );
      }
      opts.onProgress({ percent: 100, phase: 'rendering', message: '生成完成' });
      return status.result;
    }

    if (status.status === 'failed') {
      throw new ImageGenerationError(
        status.error?.code ?? 'server',
        opts.providerType,
        status.error?.message ?? `任务 ${taskId} 失败`,
      );
    }

    const percent =
      typeof status.percent === 'number'
        ? clamp(status.percent, 8, 95)
        : FAKE_PERCENT_STEPS[Math.min(fakeStepIndex, FAKE_PERCENT_STEPS.length - 1)];
    fakeStepIndex++;
    opts.onProgress({ percent, phase: 'rendering', message: '生成中…' });

    await sleep(intervalMs, opts.signal, opts.providerType);
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function ensureNotAborted(signal: AbortSignal, providerType: ImageProviderType): void {
  if (signal.aborted) {
    throw new ImageGenerationError('cancelled', providerType, '任务已取消');
  }
}

function sleep(ms: number, signal: AbortSignal, providerType: ImageProviderType): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new ImageGenerationError('cancelled', providerType, '任务已取消'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ImageGenerationError('cancelled', providerType, '任务已取消'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
