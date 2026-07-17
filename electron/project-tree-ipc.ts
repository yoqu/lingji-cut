import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, Menu, clipboard, ipcMain, shell } from 'electron';
import { createDirectoryTreeContextMenuTemplate } from './directory-tree-context-menu';
import type {
  DirectoryTreeContextMenuRequest,
  ProjectTreeCrudResult,
} from '../src/lib/electron-api';

/**
 * 解析 projectDir 下的相对路径为绝对路径，并校验结果仍位于 projectDir 之内（防 `..` 穿越
 * 与绝对路径注入）。返回 null 表示非法 / 越界。
 *
 * 导出为纯函数以便单测覆盖：`..` 穿越、绝对路径、根目录等边界。
 */
export function resolveWithinProject(
  projectDir: string,
  relativePath: string,
): string | null {
  if (!projectDir) return null;
  const base = path.resolve(projectDir);
  // 空相对路径 -> 根目录本身。
  if (!relativePath) return base;
  const target = path.resolve(base, relativePath);
  if (target === base) return base;
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

interface CrudOk {
  ok: true;
}
type CrudResponse = CrudOk | { ok: false; code: string; message: string };

function fail(code: string, message: string): CrudResponse {
  return { ok: false, code, message };
}

function toResult(error: unknown): CrudResponse {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException)?.code ?? 'EUNKNOWN';
  return { ok: false, code, message };
}

interface RegisterProjectTreeIpcOptions {
  getMainWindow: () => BrowserWindow | null;
}

/**
 * 注册项目目录树 CRUD + 右键菜单 IPC：
 * - project-tree:create-directory / create-file / rename / delete
 * - project-tree:show-context-menu（弹出原生菜单，选中动作经
 *   `directory-tree-menu-action` 事件回传 renderer）
 *
 * 所有 fs 操作都经 resolveWithinProject 校验，禁止越出 projectDir。
 */
export function registerProjectTreeIpc({ getMainWindow }: RegisterProjectTreeIpcOptions): void {
  // ---- 创建文件夹 ----
  ipcMain.handle(
    'project-tree:create-directory',
    async (_event, args: { projectDir: string; relativePath: string }): Promise<CrudResponse> => {
      const target = resolveWithinProject(args.projectDir, args.relativePath);
      if (!target) return fail('EPERMISSION', '目标路径超出项目目录');
      try {
        await fs.mkdir(target, { recursive: false });
        return { ok: true };
      } catch (error) {
        return toResult(error);
      }
    },
  );

  // ---- 创建文件 ----
  ipcMain.handle(
    'project-tree:create-file',
    async (
      _event,
      args: { projectDir: string; relativePath: string; content?: string },
    ): Promise<CrudResponse> => {
      const target = resolveWithinProject(args.projectDir, args.relativePath);
      if (!target) return fail('EPERMISSION', '目标路径超出项目目录');
      try {
        await fs.writeFile(target, args.content ?? '', 'utf-8');
        return { ok: true };
      } catch (error) {
        return toResult(error);
      }
    },
  );

  // ---- 重命名 / 移动 ----
  ipcMain.handle(
    'project-tree:rename',
    async (
      _event,
      args: { projectDir: string; oldRelative: string; newRelative: string },
    ): Promise<CrudResponse> => {
      const src = resolveWithinProject(args.projectDir, args.oldRelative);
      const dest = resolveWithinProject(args.projectDir, args.newRelative);
      if (!src || !dest) return fail('EPERMISSION', '目标路径超出项目目录');
      if (src === path.resolve(args.projectDir)) {
        return fail('EPERMISSION', '不能重命名项目根目录');
      }
      try {
        await fs.rename(src, dest);
        return { ok: true };
      } catch (error) {
        return toResult(error);
      }
    },
  );

  // ---- 删除 ----
  ipcMain.handle(
    'project-tree:delete',
    async (
      _event,
      args: { projectDir: string; relativePath: string; recursive?: boolean },
    ): Promise<CrudResponse> => {
      const target = resolveWithinProject(args.projectDir, args.relativePath);
      if (!target) return fail('EPERMISSION', '目标路径超出项目目录');
      if (target === path.resolve(args.projectDir)) {
        return fail('EPERMISSION', '不能删除项目根目录');
      }
      try {
        await fs.rm(target, { recursive: Boolean(args.recursive), force: false });
        return { ok: true };
      } catch (error) {
        return toResult(error);
      }
    },
  );

  // ---- 右键菜单 ----
  ipcMain.handle(
    'project-tree:show-context-menu',
    async (event, request: DirectoryTreeContextMenuRequest) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
      if (!win) return;

      const isRoot = !request.relativePath;
      const menu = Menu.buildFromTemplate(
        createDirectoryTreeContextMenuTemplate({
          relativePath: request.relativePath,
          type: request.type,
          isRoot,
          onAction: (action, relativePath) => {
            // 复制路径 / 在文件管理器中显示：主进程直接执行；
            // 其余动作回传 renderer 由其处理（行内编辑 / 确认 / 调 CRUD）。
            if (action === 'copy-path') {
              const abs = resolveWithinProject(request.projectDir ?? '', relativePath);
              if (abs) clipboard.writeText(abs);
              return;
            }
            if (action === 'reveal') {
              const abs = resolveWithinProject(request.projectDir ?? '', relativePath);
              if (abs) shell.showItemInFolder(abs);
              return;
            }
            win.webContents.send('directory-tree-menu-action', {
              action,
              relativePath,
              type: request.type,
            });
          },
        }),
      );

      menu.popup({ window: win });
    },
  );
}

export type { CrudResponse, ProjectTreeCrudResult };
