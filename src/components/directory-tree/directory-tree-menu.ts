import type { DirectoryTreeMenuEvent } from '../../lib/electron-api';

/**
 * 右键菜单动作归属管理。
 *
 * 4 个 tab 常驻挂载，每个 tab 的 DirectoryTreePanel 都会渲染。原生右键菜单一次只能弹出
 * 一个，其选中的动作经全局 `directory-tree-menu-action` 事件回传。为避免所有 panel 都响应，
 * 采用「认领」机制：触发右键的 panel 在弹菜单前 claim 一次自己的 handler，全局订阅只把
 * 事件派发给当前 owner 并随即清空。全局订阅惰性创建一次。
 */
type MenuActionHandler = (event: DirectoryTreeMenuEvent) => void;

let currentOwner: MenuActionHandler | null = null;
let globalUnsub: (() => void) | null = null;

function ensureGlobalSubscription(): void {
  if (globalUnsub || typeof window === 'undefined' || !window.electronAPI?.onDirectoryTreeMenuAction) {
    return;
  }
  globalUnsub = window.electronAPI.onDirectoryTreeMenuAction((event) => {
    const owner = currentOwner;
    currentOwner = null;
    owner?.(event);
  });
}

/**
 * 由触发右键的 panel 调用：登记自己为本次菜单动作的接收方。
 * handler 通常是闭包，捕获了当前 panel 的回调与状态。
 */
export function claimDirectoryTreeMenu(handler: MenuActionHandler): void {
  ensureGlobalSubscription();
  currentOwner = handler;
}
