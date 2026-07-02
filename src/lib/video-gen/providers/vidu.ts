import { INSUFFICIENT_CREDITS_MESSAGE } from '../../llm/credits-error';
import { VideoGenerationError, httpStatusToErrorCode } from '../errors';
import { pollVideoUntilDone } from '../async-poller';
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationResult,
  VideoProviderConfig,
  VideoGenerationContext,
} from '../types';

const SUPPORTED_DURATIONS = [4, 6, 8];

async function submitJob(
  req: VideoGenerationRequest,
  cfg: VideoProviderConfig,
): Promise<{ taskId: string }> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/ent/v2/text2video`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: req.model,
      prompt: req.prompt,
      negative_prompt: req.negativePrompt ?? '',
      aspect_ratio: req.aspectRatio,
      duration: req.durationSeconds,
      ...(req.extraParams ?? {}),
    }),
  });
  if (!res.ok) {
    const code = httpStatusToErrorCode(res.status);
    throw new VideoGenerationError(
      code,
      'vidu',
      code === 'quota' ? INSUFFICIENT_CREDITS_MESSAGE : `Vidu submit 失败 HTTP ${res.status}`,
      undefined,
      await safeText(res),
    );
  }
  const json = (await res.json()) as { task_id?: string };
  if (!json.task_id) {
    throw new VideoGenerationError('server', 'vidu', 'Vidu 响应缺少 task_id', undefined, json);
  }
  return { taskId: json.task_id };
}

interface ViduStatusResponse {
  state?: string;
  err_code?: string;
  creations?: Array<{
    url?: string;
    cover_url?: string;
    width?: number;
    height?: number;
    duration?: number;
  }>;
}

async function fetchStatus(
  taskId: string,
  cfg: VideoProviderConfig,
): Promise<{
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  percent?: number;
  result?: VideoGenerationResult;
  error?: { code: 'content_policy' | 'server'; message: string };
}> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/ent/v2/tasks/${taskId}/creations`, {
    headers: { Authorization: `Token ${cfg.apiKey}` },
  });
  if (!res.ok) {
    throw new VideoGenerationError(
      httpStatusToErrorCode(res.status),
      'vidu',
      `Vidu poll 失败 HTTP ${res.status}`,
    );
  }
  const json = (await res.json()) as ViduStatusResponse;
  if (json.state === 'success' && json.creations?.[0]?.url) {
    const c = json.creations[0];
    return {
      status: 'succeeded',
      result: {
        videoUrl: c.url!,
        posterUrl: c.cover_url,
        durationMs: Math.round((c.duration ?? 6) * 1000),
        width: c.width ?? 1920,
        height: c.height ?? 1080,
        raw: json,
      },
    };
  }
  if (json.state === 'failed') {
    return {
      status: 'failed',
      error: {
        code: json.err_code === 'content_policy' ? 'content_policy' : 'server',
        message: json.err_code ?? '生成失败',
      },
    };
  }
  return { status: 'running' };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export const viduProvider: VideoGenerationProvider = {
  type: 'vidu',
  capabilities: {
    aspectRatios: ['16:9', '9:16', '1:1'],
    durationOptions: SUPPORTED_DURATIONS,
    maxResolution: '1080p',
    supportsImageToVideo: false,
    isAsync: true,
    defaultModels: ['vidu-2', 'vidu-1.5'],
  },
  async generate(req, cfg, ctx: VideoGenerationContext) {
    if (!SUPPORTED_DURATIONS.includes(req.durationSeconds)) {
      throw new VideoGenerationError(
        'invalid_request',
        'vidu',
        `Vidu 不支持 durationSeconds=${req.durationSeconds}，请选择 ${SUPPORTED_DURATIONS.join(' / ')}`,
      );
    }
    return pollVideoUntilDone<VideoGenerationResult>({
      providerType: 'vidu',
      onProgress: ctx.onProgress,
      signal: ctx.signal,
      submit: () => submitJob(req, cfg),
      fetchStatus: (taskId) => fetchStatus(taskId, cfg),
      intervalMs: 3000,
      timeoutMs: 300_000,
    });
  },
};
