// 记忆「上次创建项目时选择的父目录」，供统一媒体导入弹窗的目录字段作默认值。
// 仅 Renderer 侧 localStorage，跨会话保留；与 export-settings 的 last-export-dir 同一思路。
const LAST_PROJECT_PARENT_DIR_KEY = 'video-web.last-project-parent-dir';

function hasBrowserStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function getLastProjectParentDir(): string {
  if (!hasBrowserStorage()) return '';
  return window.localStorage.getItem(LAST_PROJECT_PARENT_DIR_KEY) || '';
}

export function setLastProjectParentDir(dir: string): void {
  if (!hasBrowserStorage() || !dir) return;
  window.localStorage.setItem(LAST_PROJECT_PARENT_DIR_KEY, dir);
}
