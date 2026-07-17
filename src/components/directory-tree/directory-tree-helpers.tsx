import type { CSSProperties, ReactNode } from 'react';
import {
  FileText,
  Film,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Music,
  Settings2,
} from 'lucide-react';
import type { FileEntry } from '../../lib/electron-api';
import { isAudioFile, isImageFile } from '../../lib/workbench-file-kind';

/** 拼接相对路径（前缀为空时即文件名本身） */
export function buildRelativePath(pathPrefix: string, name: string): string {
  return pathPrefix ? `${pathPrefix}/${name}` : name;
}

/** 取项目目录的末段作为显示名 */
export function getProjectName(projectDir: string): string {
  const parts = projectDir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? projectDir;
}

/** 真正无法在工作台打开的二进制文件（图片 / 音频已单独支持媒体预览，故不在此列）。 */
const BINARY_EXT = /\.(avi|mov|mkv|webm|mp4|zip|tar|gz|rar|7z|pdf|doc[x]?|xls[x]?|ppt[x]?|exe|dll|so|dylib|woff2?|ttf|eot)$/i;

/** 默认可打开性判断：排除状态文件与二进制文件，图片 / 音频以媒体预览方式打开。 */
export function defaultIsFileOpenable(relativePath: string): boolean {
  if (relativePath === 'script-state.json') return false;
  if (isImageFile(relativePath) || isAudioFile(relativePath)) return true;
  return !BINARY_EXT.test(relativePath);
}

/** 默认文件图标：按文件名 / 扩展名匹配。 */
export function defaultGetFileIcon(entry: FileEntry): ReactNode {
  if (entry.name === 'script-state.json') {
    return <Settings2 size={14} strokeWidth={1.8} />;
  }
  if (entry.name === 'preview.json') {
    return <Film size={14} strokeWidth={1.8} />;
  }
  if (isImageFile(entry.name)) {
    return <ImageIcon size={14} strokeWidth={1.8} />;
  }
  if (isAudioFile(entry.name)) {
    return <Music size={14} strokeWidth={1.8} />;
  }
  return <FileText size={14} strokeWidth={1.8} />;
}

/** 默认目录图标（展开 / 收起）。 */
export function defaultGetDirectoryIcon(expanded: boolean): ReactNode {
  return expanded ? <FolderOpen size={14} strokeWidth={1.8} /> : <Folder size={14} strokeWidth={1.8} />;
}

export function getIndentStyle(depth: number): CSSProperties {
  return { '--tree-depth': depth } as CSSProperties;
}

/** 递归收集所有目录的相对路径（用于展开态对账）。 */
export function collectDirectoryPaths(fileEntries: FileEntry[], pathPrefix = ''): string[] {
  const paths: string[] = [];

  for (const entry of fileEntries) {
    if (entry.type !== 'directory') {
      continue;
    }

    const relativePath = buildRelativePath(pathPrefix, entry.name);
    paths.push(relativePath);

    if (entry.children?.length) {
      paths.push(...collectDirectoryPaths(entry.children, relativePath));
    }
  }

  return paths;
}

/** 用新树结构对账旧的展开态：仅保留仍存在的目录。 */
export function reconcileExpandedDirectories(
  fileEntries: FileEntry[],
  previous: Record<string, boolean>,
): Record<string, boolean> {
  return collectDirectoryPaths(fileEntries).reduce<Record<string, boolean>>((next, path) => {
    next[path] = previous[path] ?? false;
    return next;
  }, {});
}

/** 取某文件路径的所有祖先目录相对路径（用于自动展开定位）。 */
export function getAncestorDirectoryPaths(filePath: string): string[] {
  const parts = filePath.split('/').filter(Boolean);
  if (parts.length <= 1) {
    return [];
  }

  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

/** 展开某文件的所有祖先目录（用于打开文件时自动 reveal）。 */
export function revealPathInExpandedDirectories(
  previous: Record<string, boolean>,
  filePath: string | null,
): Record<string, boolean> {
  if (!filePath) {
    return previous;
  }

  let changed = false;
  const next = { ...previous };
  for (const path of getAncestorDirectoryPaths(filePath)) {
    if (next[path] !== true) {
      next[path] = true;
      changed = true;
    }
  }
  return changed ? next : previous;
}

/** 取某相对路径的父目录相对路径（根级文件返回 ''）。 */
export function getParentDirectory(relativePath: string): string {
  const idx = relativePath.lastIndexOf('/');
  return idx === -1 ? '' : relativePath.slice(0, idx);
}
