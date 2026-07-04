import { appendAutoRunEvent } from './auto-run-logger';

/**
 * 把"主进程内部的耗时事件"统一以 runId 上报到 jsonl 日志。
 * 调用方（analyze-srt / generate-cover-images / generate-tts 等 IPC handler）拿到
 * renderer 传过来的 telemetryRunId 后，调用 makeMainTelemetry(runId) 即可得到一个
 * 满足 TelemetryHook 接口的钩子，再传给 lib 层的 analyzeSrt / generateSubtitleHighlights。
 * runId 为空 / 不传则得到 no-op，业务路径完全保持原样。
 */
export function makeMainTelemetry(runId?: string | null): { emit: (kind: string, extra?: Record<string, unknown>) => void } {
  if (!runId || typeof runId !== 'string' || !runId.trim()) {
    return { emit: () => undefined };
  }
  const id = runId.trim();
  return {
    emit: (kind, extra = {}) => {
      void appendAutoRunEvent({ runId: id, ts: Date.now(), kind, ...extra }).catch(() => undefined);
    },
  };
}
