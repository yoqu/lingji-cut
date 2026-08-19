import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Motion Agent 视频素材代表帧 ffmpeg 接线', () => {
  it.each([
    '../electron/ai-generation-ipc.ts',
    '../electron/pipeline/runs/analyze-run.ts',
    '../electron/pipeline/runs/card-run.ts',
  ])('%s 解析并传入 ffmpegPath', (relativePath) => {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    expect(source).toContain('resolveFfmpegPath');
    expect(source).toContain('ffmpegPath: resolveFfmpegPath({');
    expect(source).toContain('resourcesPath: process.resourcesPath');
  });
});
