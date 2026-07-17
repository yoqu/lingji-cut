import path from 'node:path';
import crypto from 'node:crypto';
import { getImageProvider } from '../src/lib/image-gen/registry';
import { getVideoProvider } from '../src/lib/video-gen/registry';
import { resolvePromptBinding } from '../src/lib/llm/binding-resolver';
import {
  ensureCardAssetDir,
  writeCardImage,
  writeCardMeta,
  writeCardVideo,
  writeCardPoster,
} from './ai-card-assets';
import { keyGreenScreenPngBuffer } from './green-screen-keyer';
import type {
  AISettings,
  MediaCardContent,
  PromptBindingMap,
  ImageAspectRatio,
  VideoAspectRatio,
} from '../src/types/ai';
import type {
  ImageGenerationContext,
  ImageGenerationProgressUpdate,
} from '../src/lib/image-gen/types';
import type {
  VideoGenerationContext,
  VideoGenerationProgressUpdate,
} from '../src/lib/video-gen/types';
import { resolveFfmpegPath, resolveFfprobePath } from './runtime-binaries';
import {
  importGeneratedMediaAsset,
  resolveReusableMediaAssetForProject,
} from './asset-library';
import { buildMediaReuseKey } from '../src/lib/media-asset-resolution';
import type { MediaAssetRequest } from '../src/types/production';

export interface GenerateCardImageArgs {
  projectDir: string;
  cardId: string;
  prompt: string;
  negativePrompt?: string;
  backgroundRemoval?: 'none' | 'green-screen';
  aspectRatio: ImageAspectRatio;
  providerId?: string | null;
  model?: string | null;
  extraParams?: Record<string, unknown>;
}

export interface CardMediaHandlerCtx {
  settings: AISettings;
  projectBindings: PromptBindingMap | null;
  onProgress: (u: ImageGenerationProgressUpdate) => void;
  signal?: AbortSignal;
}

export async function handleGenerateCardImage(
  args: GenerateCardImageArgs,
  ctx: CardMediaHandlerCtx,
): Promise<MediaCardContent> {
  // 优先使用调用方显式指定的 providerId / model；否则走 card.image binding 回退
  let providerId = args.providerId ?? null;
  let model = args.model ?? null;

  if (!providerId || !model) {
    try {
      const binding = resolvePromptBinding('card.image', ctx.settings, ctx.projectBindings);
      if (!providerId) providerId = binding.imageProvider?.id ?? null;
      if (!model) model = binding.imageModel ?? null;
    } catch (err) {
      // resolvePromptBinding 在缺 LLM provider 时也会抛——card.image 实际只关心 image binding，
      // 因此只把 image binding missing 作为致命错误向上抛。
      throw err;
    }
  }

  const provider = providerId
    ? ctx.settings.imageProviders.find((p) => p.id === providerId) ?? null
    : null;
  if (!provider) {
    throw new Error('card.image 未绑定 ImageProvider');
  }
  if (!model) {
    throw new Error('card.image 未指定模型');
  }

  await ensureCardAssetDir(args.projectDir, args.cardId);

  const adapter = getImageProvider(provider.type);
  const signal = ctx.signal ?? new AbortController().signal;
  const igCtx: ImageGenerationContext = {
    taskId: `card-image-${args.cardId}`,
    signal,
    onProgress: ctx.onProgress,
  };
  const generationPrompt = [
    args.prompt.trim(),
    args.backgroundRemoval === 'green-screen'
      ? '主体完整、边缘清晰，使用均匀纯绿色背景，背景不要出现阴影或其他物体。'
      : '',
    args.negativePrompt?.trim() ? `避免出现：${args.negativePrompt.trim()}` : '',
  ].filter(Boolean).join('\n');
  const result = await adapter.generate(
    {
      prompt: generationPrompt,
      model,
      aspectRatio: args.aspectRatio,
      n: 1,
      extraParams: args.extraParams,
    },
    { baseUrl: provider.baseUrl, apiKey: provider.apiKey, extras: provider.extras },
    igCtx,
  );

  const img = result.images[0];
  if (!img) throw new Error('image provider 未返回图片');
  const buf = await imageToBuffer(img);
  const png = await normalizeImagePng(buf, img.mimeType);
  ctx.onProgress({ percent: 95, phase: 'downloading', message: '保存图片…' });
  const originalAssetPath = await writeCardImage(args.projectDir, args.cardId, png);
  let assetPath = originalAssetPath;
  let cutoutAssetPath: string | null = null;
  let cutoutStatus: MediaCardContent['cutoutStatus'] = 'not-requested';
  let cutoutMessage: string | undefined;
  if (args.backgroundRemoval === 'green-screen') {
    try {
      ctx.onProgress({ percent: 97, phase: 'postprocessing', message: '移除绿幕背景…' });
      const cutoutAbs = path.join(args.projectDir, 'ai-cards', args.cardId, 'image-cutout.png');
      const keyed = await keyGreenScreenPngBuffer(png, cutoutAbs);
      if (keyed.ok && keyed.outputPath) {
        cutoutAssetPath = path.relative(args.projectDir, keyed.outputPath);
        assetPath = cutoutAssetPath;
        cutoutStatus = 'ready';
      } else {
        cutoutStatus = 'unavailable';
        cutoutMessage = keyed.reason ?? '没有检测到可移除的绿幕背景，已保留原图。';
      }
    } catch (error) {
      cutoutStatus = 'failed';
      cutoutMessage = error instanceof Error ? error.message : '背景移除失败，已保留原图。';
    }
  }
  const generatedAt = Date.now();
  await writeCardMeta(args.projectDir, args.cardId, {
    cardId: args.cardId,
    mediaType: 'image',
    prompt: args.prompt,
    negativePrompt: args.negativePrompt,
    providerId: provider.id,
    model,
    aspectRatio: args.aspectRatio,
    generatedAt,
    extras: {
      ...(args.extraParams ?? {}),
      originalAssetPath,
      cutoutAssetPath,
      backgroundRemoval: args.backgroundRemoval ?? 'none',
      cutoutStatus,
      autoCutout: cutoutStatus === 'ready',
    },
  });
  ctx.onProgress({ percent: 100, phase: 'rendering', message: '完成' });

  return {
    mediaType: 'image',
    assetPath,
    aspectRatio: args.aspectRatio,
    prompt: args.prompt,
    negativePrompt: args.negativePrompt,
    providerId: provider.id,
    model,
    generationStatus: 'ready',
    generatedAt,
    extraParams: args.extraParams,
    backgroundRemoval: args.backgroundRemoval ?? 'none',
    originalAssetPath,
    cutoutAssetPath,
    cutoutStatus,
    cutoutMessage,
  };
}

async function normalizeImagePng(buf: Buffer, mimeType?: string): Promise<Buffer> {
  if (!mimeType || mimeType.toLowerCase().includes('png')) return buf;
  const { nativeImage } = await import('electron');
  const image = nativeImage.createFromBuffer(buf);
  if (image.isEmpty()) throw new Error(`无法解码生成图片（${mimeType}）`);
  return image.toPNG();
}

async function imageToBuffer(img: {
  url?: string;
  base64?: string;
  mimeType?: string;
}): Promise<Buffer> {
  if (img.base64) return Buffer.from(img.base64, 'base64');
  if (img.url) {
    const res = await fetch(img.url);
    if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('image 既没有 base64 也没有 url');
}

export interface GenerateCardVideoArgs {
  projectDir: string;
  cardId: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio: VideoAspectRatio;
  durationSeconds: number;
  providerId?: string | null;
  model?: string | null;
  extraParams?: Record<string, unknown>;
}

export interface CardVideoHandlerCtx {
  settings: AISettings;
  projectBindings: PromptBindingMap | null;
  onProgress: (u: VideoGenerationProgressUpdate) => void;
  signal?: AbortSignal;
}

export async function handleGenerateCardVideo(
  args: GenerateCardVideoArgs,
  ctx: CardVideoHandlerCtx,
): Promise<MediaCardContent> {
  const requestBase = {
    kind: 'video' as const,
    role: 'broll',
    query: args.prompt,
    reusePolicy: 'prefer-library' as const,
    constraints: {
      aspectRatio: args.aspectRatio,
      durationRangeMs: [
        Math.max(0, args.durationSeconds * 1_000 - 1_000),
        args.durationSeconds * 1_000 + 1_000,
      ] as [number, number],
    },
  };
  const request: MediaAssetRequest = {
    id: `card-video-${args.cardId}`,
    ...requestBase,
    reuseKey: buildMediaReuseKey(requestBase),
  };
  const reused = await resolveReusableMediaAssetForProject({
    projectDir: args.projectDir,
    request,
    sourceCardId: args.cardId,
  });
  if (reused) {
    const generatedAt = Date.now();
    const assetPath = reused.asset.files.processed || reused.asset.files.original;
    ctx.onProgress({ percent: 100, phase: 'rendering', message: '已复用本地视频素材' });
    await writeCardMeta(args.projectDir, args.cardId, {
      cardId: args.cardId,
      mediaType: 'video',
      prompt: args.prompt,
      negativePrompt: args.negativePrompt,
      providerId: reused.asset.metadata.provenance?.provider ?? null,
      model: reused.asset.metadata.provenance?.model ?? null,
      aspectRatio: args.aspectRatio,
      durationSeconds: args.durationSeconds,
      mediaDurationMs: reused.asset.metadata.durationMs ?? args.durationSeconds * 1_000,
      width: reused.asset.metadata.width ?? undefined,
      height: reused.asset.metadata.height ?? undefined,
      generatedAt,
      extras: {
        ...(args.extraParams ?? {}),
        reusedAssetId: reused.asset.id,
        reuseScore: reused.score,
        reuseReasons: reused.reasons,
      },
    });
    return {
      mediaType: 'video',
      assetPath,
      posterPath: reused.asset.files.thumbnail ?? null,
      mediaDurationMs: reused.asset.metadata.durationMs ?? args.durationSeconds * 1_000,
      aspectRatio: args.aspectRatio,
      prompt: args.prompt,
      negativePrompt: args.negativePrompt,
      providerId: reused.asset.metadata.provenance?.provider ?? null,
      model: reused.asset.metadata.provenance?.model ?? null,
      generationStatus: 'ready',
      generatedAt,
      extraParams: {
        ...(args.extraParams ?? {}),
        reusedAssetId: reused.asset.id,
        reuseScore: reused.score,
        reuseReasons: reused.reasons,
      },
    };
  }

  let providerId = args.providerId ?? null;
  let model = args.model ?? null;

  if (!providerId || !model) {
    const binding = resolvePromptBinding('card.video', ctx.settings, ctx.projectBindings);
    if (!providerId) providerId = binding.videoProvider?.id ?? null;
    if (!model) model = binding.videoModel ?? null;
  }

  const provider = providerId
    ? ctx.settings.videoProviders.find((p) => p.id === providerId) ?? null
    : null;
  if (!provider) {
    throw new Error('card.video 未绑定 VideoProvider');
  }
  if (!model) {
    throw new Error('card.video 未指定模型');
  }

  await ensureCardAssetDir(args.projectDir, args.cardId);

  const adapter = getVideoProvider(provider.type);
  const signal = ctx.signal ?? new AbortController().signal;
  const vgCtx: VideoGenerationContext = {
    taskId: `card-video-${args.cardId}`,
    signal,
    onProgress: ctx.onProgress,
  };
  const result = await adapter.generate(
    {
      prompt: args.prompt,
      negativePrompt: args.negativePrompt,
      model,
      aspectRatio: args.aspectRatio,
      durationSeconds: args.durationSeconds,
      extraParams: args.extraParams,
    },
    { baseUrl: provider.baseUrl, apiKey: provider.apiKey, extras: provider.extras },
    vgCtx,
  );

  ctx.onProgress({ percent: 92, phase: 'downloading', message: '下载视频…' });
  const videoRes = await fetch(result.videoUrl);
  if (!videoRes.ok) {
    throw new Error(`下载视频失败 HTTP ${videoRes.status}`);
  }
  const videoBuf = Buffer.from(await videoRes.arrayBuffer());
  const assetPath = await writeCardVideo(args.projectDir, args.cardId, videoBuf);

  let posterPath: string | undefined;
  if (result.posterUrl) {
    try {
      const posterRes = await fetch(result.posterUrl);
      if (posterRes.ok) {
        const posterBuf = Buffer.from(await posterRes.arrayBuffer());
        posterPath = await writeCardPoster(args.projectDir, args.cardId, posterBuf);
      }
    } catch {
      // 海报下载失败不影响主流程，回退到 ffmpeg 抽帧
      posterPath = undefined;
    }
  }
  if (!posterPath) {
    ctx.onProgress({ percent: 96, phase: 'postprocessing', message: '抽取首帧…' });
    posterPath = await extractPosterWithFfmpeg(args.projectDir, args.cardId);
  }

  const generatedAt = Date.now();
  await writeCardMeta(args.projectDir, args.cardId, {
    cardId: args.cardId,
    mediaType: 'video',
    prompt: args.prompt,
    negativePrompt: args.negativePrompt,
    providerId: provider.id,
    model,
    aspectRatio: args.aspectRatio,
    durationSeconds: args.durationSeconds,
    mediaDurationMs: result.durationMs,
    width: result.width,
    height: result.height,
    generatedAt,
    extras: args.extraParams,
  });
  ctx.onProgress({ percent: 98, phase: 'postprocessing', message: '沉淀到全局素材库…' });
  const binaryOptions = {
    appPath: process.defaultApp ? process.cwd() : path.resolve(__dirname, '..'),
    resourcesPath: process.resourcesPath ?? '',
    cwd: process.cwd(),
    moduleDir: __dirname,
  };
  await importGeneratedMediaAsset({
    filePath: path.resolve(args.projectDir, assetPath),
    projectDir: args.projectDir,
    name: args.prompt.slice(0, 64),
    role: 'broll',
    reuseKey: request.reuseKey,
    semantic: { tags: [args.prompt], usableAs: ['broll'] },
    licenseNote: 'AI 视频生成；商业使用权由当前视频 Provider 条款决定。',
    provenance: {
      provider: provider.id,
      model,
      taskId: vgCtx.taskId,
      promptHash: crypto.createHash('sha256').update(args.prompt).digest('hex'),
      requestHash: crypto.createHash('sha256').update(request.reuseKey).digest('hex'),
      generatedAt: new Date(generatedAt).toISOString(),
    },
    video: {
      aspectRatio: args.aspectRatio,
      motionIntensity: 2,
      shotType: 'broll',
    },
  }, resolveFfprobePath(binaryOptions), resolveFfmpegPath(binaryOptions));
  ctx.onProgress({ percent: 100, phase: 'rendering', message: '完成' });

  return {
    mediaType: 'video',
    assetPath,
    posterPath: posterPath ?? null,
    mediaDurationMs: result.durationMs,
    aspectRatio: args.aspectRatio,
    prompt: args.prompt,
    negativePrompt: args.negativePrompt,
    providerId: provider.id,
    model,
    generationStatus: 'ready',
    generatedAt,
    extraParams: args.extraParams,
  };
}

async function extractPosterWithFfmpeg(
  projectDir: string,
  cardId: string,
): Promise<string | undefined> {
  try {
    const { spawn } = await import('node:child_process');
    const ffmpegPath = resolveFfmpegPath({
      appPath: process.defaultApp ? process.cwd() : path.resolve(__dirname, '..'),
      resourcesPath: process.resourcesPath ?? '',
      cwd: process.cwd(),
      moduleDir: __dirname,
    }) ?? 'ffmpeg';
    const inFile = path.join(projectDir, 'ai-cards', cardId, 'video.mp4');
    const outFile = path.join(projectDir, 'ai-cards', cardId, 'poster.jpg');
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath as string, [
        '-y',
        '-i',
        inFile,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        outFile,
      ]);
      proc.on('error', reject);
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
    });
    return path.relative(projectDir, outFile);
  } catch {
    return undefined;
  }
}
