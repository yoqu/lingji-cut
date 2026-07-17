import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  decodePng,
  encodePng,
  chromaKeyPngBuffer,
  keyGreenScreenPngBuffer,
  keyGreenScreenPng,
  type PngImage,
} from '../electron/green-screen-keyer';

let tempDir = '';

function pixelOffset(image: PngImage, x: number, y: number): number {
  return (y * image.width + x) * 4;
}

function setPixel(image: PngImage, x: number, y: number, rgba: [number, number, number, number]) {
  const offset = pixelOffset(image, x, y);
  image.rgba[offset] = rgba[0];
  image.rgba[offset + 1] = rgba[1];
  image.rgba[offset + 2] = rgba[2];
  image.rgba[offset + 3] = rgba[3];
}

describe('green-screen-keyer', () => {
  afterEach(async () => {
    if (!tempDir) return;
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('将 AI 绿幕 PNG 抠成透明裁剪图', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'green-key-'));
    const sourcePath = path.join(tempDir, 'source.png');
    const outputPath = path.join(tempDir, 'cutout.png');
    const image: PngImage = {
      width: 12,
      height: 10,
      rgba: Buffer.alloc(12 * 10 * 4),
    };

    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        setPixel(image, x, y, [0, 220, 0, 255]);
      }
    }
    for (let y = 3; y <= 6; y += 1) {
      for (let x = 4; x <= 7; x += 1) {
        setPixel(image, x, y, [190, 40, 45, 255]);
      }
    }

    await writeFile(sourcePath, encodePng(image));
    const result = await keyGreenScreenPng(sourcePath, outputPath);
    const output = decodePng(await readFile(outputPath));
    const firstPixelAlpha = output.rgba[3];
    const centerAlpha = output.rgba[pixelOffset(output, Math.floor(output.width / 2), Math.floor(output.height / 2)) + 3];

    expect(result).toMatchObject({ ok: true, outputPath });
    expect(output.width).toBeLessThan(image.width);
    expect(output.height).toBeLessThan(image.height);
    expect(firstPixelAlpha).toBeLessThanOrEqual(8);
    expect(centerAlpha).toBeGreaterThan(200);
  });

  it('支持从 PNG Buffer 直接抠绿，方便入库前统一转码', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'green-key-buffer-'));
    const outputPath = path.join(tempDir, 'cutout.png');
    const image: PngImage = {
      width: 8,
      height: 8,
      rgba: Buffer.alloc(8 * 8 * 4),
    };

    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        setPixel(image, x, y, [0, 210, 0, 255]);
      }
    }
    for (let y = 2; y <= 5; y += 1) {
      for (let x = 2; x <= 5; x += 1) {
        setPixel(image, x, y, [40, 50, 190, 255]);
      }
    }

    const result = await keyGreenScreenPngBuffer(encodePng(image), outputPath);
    const output = decodePng(await readFile(outputPath));

    expect(result.ok).toBe(true);
    expect(output.rgba[3]).toBeLessThanOrEqual(8);
    expect(output.rgba[pixelOffset(output, Math.floor(output.width / 2), Math.floor(output.height / 2)) + 3]).toBeGreaterThan(200);
  });

  it('支持指定非绿色背景进行抠图', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'blue-key-buffer-'));
    const outputPath = path.join(tempDir, 'cutout.png');
    const image: PngImage = {
      width: 9,
      height: 9,
      rgba: Buffer.alloc(9 * 9 * 4),
    };

    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        setPixel(image, x, y, [18, 86, 230, 255]);
      }
    }
    for (let y = 3; y <= 5; y += 1) {
      for (let x = 3; x <= 5; x += 1) {
        setPixel(image, x, y, [210, 70, 40, 255]);
      }
    }

    const result = await chromaKeyPngBuffer(encodePng(image), outputPath, {
      r: 18,
      g: 86,
      b: 230,
    });
    const output = decodePng(await readFile(outputPath));

    expect(result.ok).toBe(true);
    expect(output.width).toBeLessThan(image.width);
    expect(output.rgba[3]).toBeLessThanOrEqual(8);
    expect(output.rgba[pixelOffset(output, Math.floor(output.width / 2), Math.floor(output.height / 2)) + 3]).toBeGreaterThan(200);
  });
});
