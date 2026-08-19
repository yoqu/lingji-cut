import fs from 'node:fs/promises';

/** 与 CardAssetBinding 既有格式保持一致，避免同一素材出现两套指纹语义。 */
export async function readLocalFileFingerprint(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return `stat:${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}
