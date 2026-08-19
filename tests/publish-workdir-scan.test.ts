import { mkdtempSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyCoverRatio,
  scanWorkdirMedia,
} from '../electron/publish-agent/workdir-scan';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'workdir-scan-'));
  tempDirs.push(dir);
  return dir;
}

function pngHeader(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  png[0] = 0x89;
  png[1] = 0x50;
  png[2] = 0x4e;
  png[3] = 0x47;
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

describe('workdir media scan', () => {
  it('按像素比选封面、按体积选成片，不看文件名', async () => {
    const workDir = tempDir();
    writeFileSync(path.join(workDir, 'small.mp4'), 'tiny');
    writeFileSync(path.join(workDir, 'large.mp4'), 'x'.repeat(4000));
    writeFileSync(path.join(workDir, 'wide.png'), pngHeader(1920, 1080));
    writeFileSync(path.join(workDir, 'portrait.png'), pngHeader(1080, 1440));
    writeFileSync(path.join(workDir, 'square.png'), pngHeader(800, 800));
    writeFileSync(path.join(workDir, 'icon.png'), pngHeader(64, 64));
    writeFileSync(path.join(workDir, 'notes.md'), '标题：智驾还能卖吗');
    const scan = await scanWorkdirMedia(workDir);
    expect(scan.video?.relativePath).toBe('large.mp4');
    expect(scan.covers['16:9']?.relativePath).toBe('wide.png');
    expect(scan.covers['3:4']?.relativePath).toBe('portrait.png');
    expect(scan.covers['4:3']).toBeUndefined();
    expect(scan.excerpts.some((item) => item.text.includes('智驾还能卖吗'))).toBe(true);
  });

  it('像素分类只认发布比例', () => {
    expect(classifyCoverRatio(1920, 1080)).toBe('16:9');
    expect(classifyCoverRatio(1440, 1080)).toBe('4:3');
    expect(classifyCoverRatio(1080, 1440)).toBe('3:4');
    expect(classifyCoverRatio(1000, 1000)).toBeNull();
  });

  it('扫描实现不含文件名硬规则', async () => {
    const src = await fs.readFile(
      new URL('../electron/publish-agent/workdir-scan.ts', import.meta.url),
      'utf-8',
    );
    expect(src).not.toContain('cover_16-9');
    expect(src).not.toContain('_final');
    expect(src).not.toContain('发布物料.md');
  });
});
