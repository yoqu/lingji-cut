import { app, ipcMain } from 'electron';
import type { MenuContext } from '../src/lib/electron-api';
import {
  loadRecentProjects,
  addRecentProject,
  removeRecentProject as removeRecentProjectFromStore,
  refreshRecentProjects,
} from './recent-projects';

export interface RecentProjectsIpcContext {
  getMenuContext: () => MenuContext;
  refreshApplicationMenu: () => void;
}

export function registerRecentProjectsIpc(ctx: RecentProjectsIpcContext): void {
  const { getMenuContext, refreshApplicationMenu } = ctx;

  ipcMain.handle('load-recent-projects', async () => {
    const userDataPath = app.getPath('userData');
    return await loadRecentProjects(userDataPath);
  });

  ipcMain.handle('add-recent-project', async (_event, projectDir: string, projectName?: string) => {
    const userDataPath = app.getPath('userData');
    const projects = await addRecentProject(userDataPath, projectDir, projectName);
    // 更新菜单上下文
    getMenuContext().recentProjects = projects.map((p) => ({
      path: p.path,
      name: p.name,
    }));
    refreshApplicationMenu();
    return projects;
  });

  ipcMain.handle('remove-recent-project', async (_event, projectDir: string) => {
    const userDataPath = app.getPath('userData');
    const projects = await removeRecentProjectFromStore(userDataPath, projectDir);
    // 更新菜单上下文
    getMenuContext().recentProjects = projects.map((p) => ({
      path: p.path,
      name: p.name,
    }));
    refreshApplicationMenu();
    return projects;
  });

  ipcMain.handle('refresh-recent-projects', async () => {
    const userDataPath = app.getPath('userData');
    const projects = await refreshRecentProjects(userDataPath);
    // 更新菜单上下文
    getMenuContext().recentProjects = projects.map((p) => ({
      path: p.path,
      name: p.name,
    }));
    refreshApplicationMenu();
    return projects;
  });
}
