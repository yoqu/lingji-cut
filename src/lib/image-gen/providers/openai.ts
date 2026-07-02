import type { ImageProviderCapabilities } from '../../../types/ai';
import { INSUFFICIENT_CREDITS_MESSAGE } from '../../llm/credits-error';
import { ImageGenerationError, httpStatusToErrorCode } from '../errors';
import type {
  ImageAspectRatio,
  ImageGenerationContext,
  ImageGenerationProvider,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageProviderConfig,
} from '../types';

const CAPABILITIES: ImageProviderCapabilities = {
  aspectRatios: ['1:1', '16:9', '9:16'],
  maxN: 10,
  supportsImageToImage: false,
  isAsync: false,
  defaultModels: ['gpt-image-1', 'gpt-image-2', 'dall-e-3'],
};

const DEFAULT_BASE_URL = 'https://api.openai.com';

interface OpenAIApiResponse {
  data?: Array<{ b64_json?: string | null; url?: string | null } | null> | null;
  error?: { code?: string | null; message?: string | null } | null;
}

/** 将 provider 返回的 url 解析为可下载的绝对地址：相对路径按 baseUrl 拼接 */
function resolveImageUrl(url: string | null | undefined, baseUrl: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

function aspectRatioToSize(ar: ImageAspectRatio | undefined): string {
  switch (ar) {
    case '16:9':
      return '1792x1024';
    case '9:16':
      return '1024x1792';
    case '1:1':
    default:
      return '1024x1024';
  }
}

export const openaiImageProvider: ImageGenerationProvider = {
  type: 'openai_image',
  capabilities: CAPABILITIES,
  async generate(
    req: ImageGenerationRequest,
    config: ImageProviderConfig,
    ctx: ImageGenerationContext,
  ): Promise<ImageGenerationResult> {
    const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = `${baseUrl}/v1/images/generations`;

    const body: Record<string, unknown> = {
      model: req.model?.trim() || 'gpt-image-1',
      prompt: req.prompt,
      n: req.n ?? 1,
      size: aspectRatioToSize(req.aspectRatio),
      response_format: 'b64_json',
    };

    // extraParams 透传：quality、style（仅当显式传入时）
    if (req.extraParams) {
      if (req.extraParams['quality'] !== undefined) {
        body['quality'] = req.extraParams['quality'];
      }
      if (req.extraParams['style'] !== undefined) {
        body['style'] = req.extraParams['style'];
      }
    }

    ctx.onProgress({ percent: 10, phase: 'submitting', message: '提交 OpenAI 生图请求…' });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
    } catch (err) {
      if (ctx.signal.aborted) {
        throw new ImageGenerationError('cancelled', 'openai_image', '任务已取消', err);
      }
      throw new ImageGenerationError('network', 'openai_image', '网络错误，无法连接 OpenAI', err);
    }

    ctx.onProgress({ percent: 80, phase: 'rendering', message: '解析返回结果…' });

    if (!response.ok) {
      let raw: unknown;
      let errorCode = httpStatusToErrorCode(response.status);

      try {
        raw = await response.json();
        const errorBody = raw as OpenAIApiResponse;
        if (errorBody?.error?.code === 'content_policy_violation') {
          errorCode = 'content_policy';
        }
      } catch {
        raw = await response.text().catch(() => '');
      }

      throw new ImageGenerationError(
        errorCode,
        'openai_image',
        errorCode === 'quota' ? INSUFFICIENT_CREDITS_MESSAGE : `OpenAI API 错误 ${response.status}`,
        undefined,
        raw,
      );
    }

    const payload = (await response.json()) as OpenAIApiResponse;
    const items = payload.data ?? [];

    if (items.length === 0) {
      throw new ImageGenerationError(
        'server',
        'openai_image',
        'OpenAI API 未返回图片数据',
        undefined,
        payload,
      );
    }

    ctx.onProgress({ percent: 100, phase: 'rendering', message: '生成完成' });

    return {
      images: items
        .filter((item): item is NonNullable<typeof item> => item != null)
        .map((item) => {
          if (item.b64_json) {
            return { base64: item.b64_json, mimeType: 'image/png' };
          }
          return { url: resolveImageUrl(item.url, baseUrl) };
        }),
      raw: payload,
    };
  },
};
