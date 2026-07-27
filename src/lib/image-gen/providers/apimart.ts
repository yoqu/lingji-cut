import type { ImageProviderCapabilities } from '../../../types/ai';
import { ImageGenerationError, httpStatusToErrorCode } from '../errors';
import { pollUntilDone } from '../async-poller';
import type {
  ImageAspectRatio,
  ImageGenerationContext,
  ImageGenerationImage,
  ImageGenerationProvider,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageProviderConfig,
} from '../types';

/**
 * Apimart 平台（https://docs.apimart.ai）
 * - 当前内置默认模型：gpt-image-2
 * - 调用模式：POST /v1/images/generations 提交 → GET /v1/tasks/{task_id} 轮询
 * - 平台 n 仅支持 1；aspect ratio 直接作为 size 字段传递
 */

const DEFAULT_BASE_URL = 'https://api.apimart.ai';
const DEFAULT_MODEL = 'gpt-image-2';
const DEFAULT_RESOLUTION = '2k';

const CAPABILITIES: ImageProviderCapabilities = {
  aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  maxN: 1,
  supportsImageToImage: true,
  isAsync: true,
  defaultModels: [DEFAULT_MODEL],
};

const INTERVAL_MS = 3000;
const TIMEOUT_MS = 240_000;
/** 单次 HTTP 请求超时：防止 TLS 挂起导致轮询永久卡住（整体超时无法兜底 await 中的 fetch） */
const REQUEST_TIMEOUT_MS = 30_000;

/** 合并外部取消信号与单次请求超时；超时在 catch 中归为 network（可重试），用户取消仍是 cancelled */
function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}

interface ApimartSubmitResponse {
  code?: number;
  data?: Array<{ task_id?: string; status?: string } | null> | null;
  error?: { code?: number; message?: string; type?: string };
}

interface ApimartTaskImage {
  url?: string[] | string | null;
  expires_at?: number;
}

interface ApimartTaskResult {
  images?: ApimartTaskImage[];
}

interface ApimartStatusResponse {
  code?: number;
  data?: {
    id?: string;
    status?: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | string;
    progress?: number;
    result?: ApimartTaskResult;
    error?: { code?: number; message?: string; type?: string };
  } | null;
  error?: { code?: number; message?: string; type?: string };
}

function aspectToSize(ar: ImageAspectRatio | undefined): string {
  // Apimart size 字段与公共集一致，直接透传
  return ar ?? '1:1';
}

function extractImageUrls(result: ApimartTaskResult | undefined): string[] {
  const items = result?.images ?? [];
  const urls: string[] = [];
  for (const item of items) {
    if (!item) continue;
    if (Array.isArray(item.url)) {
      for (const u of item.url) {
        if (typeof u === 'string' && u) urls.push(u);
      }
    } else if (typeof item.url === 'string' && item.url) {
      urls.push(item.url);
    }
  }
  return urls;
}

export const apimartImageProvider: ImageGenerationProvider = {
  type: 'apimart',
  capabilities: CAPABILITIES,

  async generate(
    req: ImageGenerationRequest,
    config: ImageProviderConfig,
    ctx: ImageGenerationContext,
  ): Promise<ImageGenerationResult> {
    const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const submitUrl = `${baseUrl}/v1/images/generations`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    };

    const extras = (req.extraParams ?? {}) as {
      resolution?: string;
      image_urls?: unknown;
      official_fallback?: boolean;
    };
    const resolution =
      typeof extras.resolution === 'string' && extras.resolution
        ? extras.resolution
        : DEFAULT_RESOLUTION;
    const imageUrls = Array.isArray(extras.image_urls) ? extras.image_urls : undefined;

    const body: Record<string, unknown> = {
      model: req.model?.trim() || DEFAULT_MODEL,
      prompt: req.prompt,
      n: 1, // Apimart 目前仅支持 1
      size: aspectToSize(req.aspectRatio),
      resolution,
    };
    if (imageUrls && imageUrls.length > 0) {
      body.image_urls = imageUrls;
    }
    if (typeof extras.official_fallback === 'boolean') {
      body.official_fallback = extras.official_fallback;
    }

    const result = await pollUntilDone<{ images: ImageGenerationImage[] }>({
      submit: async () => {
        let response: Response;
        try {
          response = await fetch(submitUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: requestSignal(ctx.signal),
          });
        } catch (err) {
          if (ctx.signal.aborted) {
            throw new ImageGenerationError('cancelled', 'apimart', '任务已取消', err);
          }
          throw new ImageGenerationError('network', 'apimart', '网络错误，无法连接 Apimart', err);
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new ImageGenerationError(
            httpStatusToErrorCode(response.status),
            'apimart',
            `Apimart API 错误 ${response.status}: ${errorText.slice(0, 200)}`,
            undefined,
            errorText,
          );
        }

        const payload = (await response.json()) as ApimartSubmitResponse;
        const first = payload.data?.[0];
        const taskId = first?.task_id;
        if (!taskId) {
          throw new ImageGenerationError(
            'server',
            'apimart',
            'Apimart API 未返回 task_id',
            undefined,
            payload,
          );
        }
        return { taskId };
      },

      fetchStatus: async (taskId: string) => {
        const statusUrl = `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}?language=zh`;
        let response: Response;
        try {
          response = await fetch(statusUrl, {
            method: 'GET',
            headers: { Authorization: `Bearer ${config.apiKey}` },
            signal: requestSignal(ctx.signal),
          });
        } catch (err) {
          if (ctx.signal.aborted) {
            throw new ImageGenerationError('cancelled', 'apimart', '任务已取消', err);
          }
          throw new ImageGenerationError('network', 'apimart', '轮询任务状态失败', err);
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new ImageGenerationError(
            httpStatusToErrorCode(response.status),
            'apimart',
            `Apimart 查询任务失败 ${response.status}: ${errorText.slice(0, 200)}`,
            undefined,
            errorText,
          );
        }

        const payload = (await response.json()) as ApimartStatusResponse;
        const data = payload.data ?? undefined;
        const status = data?.status;

        if (status === 'completed') {
          const urls = extractImageUrls(data?.result);
          if (urls.length === 0) {
            return {
              status: 'failed',
              error: { code: 'server', message: 'Apimart 任务完成但未返回图片 URL' },
            };
          }
          const images: ImageGenerationImage[] = urls.map((url) => ({
            url,
            mimeType: 'image/png',
          }));
          return { status: 'succeeded', result: { images } };
        }

        if (status === 'failed' || status === 'cancelled') {
          const errType = data?.error?.type;
          const errCode =
            errType === 'authentication_error'
              ? 'auth'
              : errType === 'payment_required'
                ? 'quota'
                : errType === 'rate_limit_error'
                  ? 'rate_limited'
                  : errType === 'invalid_request_error'
                    ? 'invalid_request'
                    : 'server';
          return {
            status: 'failed',
            error: {
              code: errCode,
              message: data?.error?.message ?? `Apimart 任务${status === 'cancelled' ? '被取消' : '失败'}`,
            },
          };
        }

        // pending | processing → 继续轮询，透传服务端进度
        const percent = typeof data?.progress === 'number' ? data.progress : undefined;
        return { status: 'running', percent };
      },

      intervalMs: INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
      onProgress: ctx.onProgress,
      signal: ctx.signal,
      providerType: 'apimart',
    });

    return { images: result.images };
  },
};
