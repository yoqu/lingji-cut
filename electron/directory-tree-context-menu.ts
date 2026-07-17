import type { MenuItemConstructorOptions } from 'electron';
import type { DirectoryTreeMenuAction } from '../src/lib/electron-api';

interface CreateDirectoryTreeContextMenuTemplateOptions {
  /** 被右键节点的相对路径（根目录为 ''） */
  relativePath: string;
  type: 'file' | 'directory';
  /** 是否为项目根目录（根目录禁用重命名 / 删除） */
  isRoot: boolean;
  platform?: NodeJS.Platform | string;
  onAction: (action: DirectoryTreeMenuAction, relativePath: string) => void;
}

/**
 * 目录树右键菜单模板（纯函数，便于测试）。
 * 菜单项：新建文件夹 / 重命名 / 删除 / 复制路径 / 在文件管理器中显示。
 * 实际的 fs 操作与行内编辑态由 renderer 接到 `directory-tree-menu-action` 事件后执行，
 * 主进程只负责弹菜单 + 回传选中的动作。
 */
export function createDirectoryTreeContextMenuTemplate({
  relativePath,
  type,
  isRoot,
  platform = process.platform,
  onAction,
}: CreateDirectoryTreeContextMenuTemplateOptions): MenuItemConstructorOptions[] {
  const revealLabel = platform === 'darwin' ? '在 Finder 中显示' : '在资源管理器中显示';
  const canModify = !isRoot;
  // 新建文件夹：在目录内新建；若右键的是文件，则在其父级新建（renderer 据此处理）。
  const canCreateInside = type === 'directory';

  return [
    {
      label: '新建文件夹',
      enabled: canCreateInside,
      click: () => onAction('create-directory', relativePath),
    },
    { type: 'separator' },
    {
      label: '重命名',
      enabled: canModify,
      click: () => onAction('rename', relativePath),
    },
    {
      label: '删除',
      enabled: canModify,
      click: () => onAction('delete', relativePath),
    },
    { type: 'separator' },
    {
      label: '复制路径',
      enabled: !isRoot,
      click: () => onAction('copy-path', relativePath),
    },
    {
      label: revealLabel,
      enabled: !isRoot,
      click: () => onAction('reveal', relativePath),
    },
  ];
}
