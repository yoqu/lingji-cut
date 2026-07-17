import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

export interface PngImage {
  width: number;
  height: number;
  rgba: Buffer<ArrayBufferLike>;
}

export interface ChromaKeyColor {
  r: number;
  g: number;
  b: number;
}

const DEFAULT_GREEN_SCREEN: ChromaKeyColor = { r: 0, g: 255, b: 0 };
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 8 + data.length);
  return out;
}

function unfilterScanline(
  filter: number,
  scanline: Buffer,
  previous: Buffer,
  bytesPerPixel: number,
): Buffer {
  const out = Buffer.alloc(scanline.length);
  for (let i = 0; i < scanline.length; i += 1) {
    const left = i >= bytesPerPixel ? out[i - bytesPerPixel] : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] ?? 0 : 0;
    let predictor = 0;
    if (filter === 1) predictor = left;
    else if (filter === 2) predictor = up;
    else if (filter === 3) predictor = Math.floor((left + up) / 2);
    else if (filter === 4) {
      const p = left + up - upLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upLeft);
      predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
    } else if (filter !== 0) {
      throw new Error(`不支持的 PNG filter: ${filter}`);
    }
    out[i] = (scanline[i] + predictor) & 0xff;
  }
  return out;
}

export function decodePng(buf: Buffer): PngImage {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('不是 PNG 文件');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`仅支持 8-bit RGB/RGBA PNG，收到 bitDepth=${bitDepth}, colorType=${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  let inOffset = 0;
  let prev: Buffer<ArrayBufferLike> = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[inOffset];
    const scanline = raw.subarray(inOffset + 1, inOffset + 1 + stride);
    const line = unfilterScanline(filter, scanline, prev, channels);
    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      rgba[dst] = line[src];
      rgba[dst + 1] = line[src + 1];
      rgba[dst + 2] = line[src + 2];
      rgba[dst + 3] = channels === 4 ? line[src + 3] : 255;
    }
    prev = line;
    inOffset += 1 + stride;
  }
  return { width, height, rgba };
}

export function encodePng(image: PngImage): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    image.rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return Math.min(diff, 360 - diff);
}

function chromaKeyAlpha(
  r: number,
  g: number,
  b: number,
  keyColor: ChromaKeyColor,
): number {
  const keyHsv = rgbToHsv(keyColor.r, keyColor.g, keyColor.b);
  if (keyHsv.s < 0.16) {
    const distance = Math.hypot(r - keyColor.r, g - keyColor.g, b - keyColor.b);
    if (distance <= 30) return 0;
    if (distance >= 92) return 255;
    return Math.round(255 * ((distance - 30) / 62));
  }

  const hsv = rgbToHsv(r, g, b);
  if (hsv.s < 0.18 || hsv.v < 0.08) return 255;
  const hueScore = hueDistance(hsv.h, keyHsv.h) / 36;
  const saturationPenalty = Math.max(0, keyHsv.s * 0.4 - hsv.s) * 1.35;
  const valuePenalty = Math.max(0, keyHsv.v * 0.18 - hsv.v);
  const score = hueScore + saturationPenalty + valuePenalty;
  if (score <= 0.28) return 0;
  if (score >= 1) return 255;
  return Math.round(255 * ((score - 0.28) / 0.72));
}

async function keyPngDecoded(
  decoded: PngImage,
  outputPath: string,
  keyColor: ChromaKeyColor,
): Promise<{
  ok: boolean;
  outputPath?: string;
  reason?: string;
  width?: number;
  height?: number;
}> {
  let transparentPixels = 0;
  for (let i = 0; i < decoded.rgba.length; i += 4) {
    const alpha = chromaKeyAlpha(
      decoded.rgba[i],
      decoded.rgba[i + 1],
      decoded.rgba[i + 2],
      keyColor,
    );
    if (alpha < decoded.rgba[i + 3]) decoded.rgba[i + 3] = alpha;
    if (decoded.rgba[i + 3] <= 8) transparentPixels += 1;
    if (alpha < 255) {
      decoded.rgba[i] = Math.round(decoded.rgba[i] * 0.96);
      decoded.rgba[i + 1] = Math.round(decoded.rgba[i + 1] * 0.72);
      decoded.rgba[i + 2] = Math.round(decoded.rgba[i + 2] * 0.96);
    }
  }
  const transparentRatio = transparentPixels / (decoded.width * decoded.height);
  if (transparentRatio < 0.08) {
    return { ok: false, reason: '未检测到足够可抠背景' };
  }
  const cropped = cropTransparent(decoded);
  if (!cropped) return { ok: false, reason: '抠图后无有效主体' };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, encodePng(cropped));
  return { ok: true, outputPath, width: cropped.width, height: cropped.height };
}

function cropTransparent(image: PngImage): PngImage | null {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = image.rgba[(y * image.width + x) * 4 + 3];
      if (alpha <= 8) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return null;
  const pad = Math.max(2, Math.round(Math.min(image.width, image.height) * 0.025));
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(image.width - 1, maxX + pad);
  maxY = Math.min(image.height - 1, maxY + pad);

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const srcStart = ((minY + y) * image.width + minX) * 4;
    const srcEnd = srcStart + width * 4;
    image.rgba.copy(rgba, y * width * 4, srcStart, srcEnd);
  }
  return { width, height, rgba };
}

export async function keyGreenScreenPng(inputPath: string, outputPath: string): Promise<{
  ok: boolean;
  outputPath?: string;
  reason?: string;
  width?: number;
  height?: number;
}> {
  try {
    return await keyPngDecoded(decodePng(await fs.readFile(inputPath)), outputPath, DEFAULT_GREEN_SCREEN);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function keyGreenScreenPngBuffer(input: Buffer, outputPath: string): Promise<{
  ok: boolean;
  outputPath?: string;
  reason?: string;
  width?: number;
  height?: number;
}> {
  try {
    return await keyPngDecoded(decodePng(input), outputPath, DEFAULT_GREEN_SCREEN);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function chromaKeyPngBuffer(
  input: Buffer,
  outputPath: string,
  keyColor: ChromaKeyColor = DEFAULT_GREEN_SCREEN,
): Promise<{
  ok: boolean;
  outputPath?: string;
  reason?: string;
  width?: number;
  height?: number;
}> {
  try {
    return await keyPngDecoded(decodePng(input), outputPath, keyColor);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
