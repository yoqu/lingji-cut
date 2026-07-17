import { staticFile } from 'remotion';
import { toFileSrc } from '../lib/utils';

/**
 * 解析素材路径为 Remotion 可加载的 src。
 * - 远程 / file:// 原样返回
 * - 绝对文件路径（预览：项目目录内素材）→ file://
 * - 相对路径（导出：materialize 到 bundle public 后的 assets/...）→ staticFile
 */
export function resolveAssetSrc(p: string, mediaRevision?: number): string {
  if (!p) return p;
  let src = p;
  if (!/^https?:\/\//.test(p) && !p.startsWith('file://')) {
    const normalized = p.replace(/\\/g, '/');
    src = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
      ? toFileSrc(p)
      : staticFile(p);
  }

  if (mediaRevision === undefined) {
    return src;
  }

  try {
    const url = new URL(src);
    url.searchParams.set('lingjiMediaRevision', String(mediaRevision));
    return url.toString();
  } catch {
    const hashIndex = src.indexOf('#');
    const base = hashIndex >= 0 ? src.slice(0, hashIndex) : src;
    const hash = hashIndex >= 0 ? src.slice(hashIndex) : '';
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}lingjiMediaRevision=${mediaRevision}${hash}`;
  }
}
