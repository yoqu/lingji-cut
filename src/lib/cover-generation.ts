import { v4 as uuid } from 'uuid';
import type { CoverCandidate, ImageAspectRatio, ImageProvider } from '../types/ai';
import { createNoopContext, toDataUrl } from './image-gen/progress';
import { getImageProvider } from './image-gen/registry';
import type { ImageGenerationContext } from './image-gen/types';

/** 封面批量生成选项；缺省保持旧行为（16:9、每条 prompt 4 张候选）。 */
export interface CoverCandidateOptions {
  aspectRatio?: ImageAspectRatio;
  /** 每条 prompt 生成的候选数量 */
  n?: number;
}

/**
 * 批量生成封面候选。每个 prompt 一次调用，结果落盘到 coversDir。
 * 容错：单个 prompt 失败不阻断其他，失败项以 error 字段记录。
 */
export async function generateCoverCandidates(
  prompts: string[],
  provider: ImageProvider,
  model: string,
  coversDir: string,
  ctx?: ImageGenerationContext,
  options: CoverCandidateOptions = {},
): Promise<CoverCandidate[]> {
  const aspectRatio: ImageAspectRatio = options.aspectRatio ?? '16:9';
  const n = options.n ?? 4;
  const path = await import('node:path');
  const adapter = getImageProvider(provider.type);
  const config = {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    extras: provider.extras,
  };
  const candidates: CoverCandidate[] = [];
  const total = prompts.length;
  const effectiveCtx = ctx ?? createNoopContext();

  for (let i = 0; i < total; i++) {
    const prompt = prompts[i];
    const baseProgress = total > 0 ? Math.floor((i / total) * 100) : 0;
    effectiveCtx.onProgress({
      percent: baseProgress,
      phase: 'rendering',
      message: `生成第 ${i + 1}/${total} 张封面…`,
    });

    try {
      const result = await adapter.generate(
        { prompt, model, aspectRatio, n },
        config,
        effectiveCtx,
      );
      for (const image of result.images) {
        const id = uuid();
        const outputPath = path.join(coversDir, `cover-${id}.png`);
        const remoteUrl = image.url ?? toDataUrl(image);
        if (!remoteUrl) {
          candidates.push({ id, prompt, imageUrl: '', selected: false, aspectRatio, error: '未获取到图片地址' });
          continue;
        }
        try {
          if (remoteUrl.startsWith('data:')) {
            await writeDataUrl(remoteUrl, outputPath);
          } else {
            await downloadToFile(remoteUrl, outputPath);
          }
          candidates.push({ id, prompt, imageUrl: outputPath, selected: false, aspectRatio, createdAt: Date.now() });
        } catch (dlError) {
          candidates.push({
            id,
            prompt,
            imageUrl: '',
            selected: false,
            aspectRatio,
            error: dlError instanceof Error ? dlError.message : '下载封面失败',
          });
        }
      }
    } catch (error) {
      candidates.push({
        id: uuid(),
        prompt,
        imageUrl: '',
        selected: false,
        aspectRatio,
        error: error instanceof Error ? error.message : '封面生成失败',
      });
    }
  }

  // 第一个成功下载的候选设为默认选中
  const firstSuccess = candidates.find((c) => c.imageUrl);
  if (firstSuccess) firstSuccess.selected = true;

  effectiveCtx.onProgress({ percent: 100, phase: 'rendering', message: '全部封面生成完毕' });
  return candidates;
}

async function downloadToFile(imageUrl: string, outputPath: string): Promise<void> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`下载图片失败: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer);
}

async function writeDataUrl(dataUrl: string, outputPath: string): Promise<void> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error('无法解析 data URL');
  const buffer = Buffer.from(match[2], 'base64');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer);
}
