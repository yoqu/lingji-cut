import { useEffect } from 'react';
import { useScriptStore } from '../store/script';
import { useProjectTreeStore } from '../store/project-tree';

/**
 * 在 App 屄调用一次，统一管理项目目录树数据的加载与刷新。
 *
 * - 镜像 useScriptStore.projectDir 到 useProjectTreeStore（script store 仍是项目目录的
 *   权威来源：App 的 currentProjectDir 同步进去，ScriptWorkbench 的「更换目录」也写它）。
 * - projectDir 变化时触发一次 refresh。
 * - 订阅 onFileTreeChanged（chokidar 推送的增删事件）触发 refresh，保证树实时新鲜。
 *
 * 各 tab 只需读 useProjectTreeStore.fileEntries，不再各自加载 / 监听。
 */
export function useProjectTreeSync(): void {
  useEffect(() => {
    const tree = useProjectTreeStore.getState();

    // 初始同步：挂载时把当前 projectDir 镜像过来并加载一次。
    const initialDir = useScriptStore.getState().projectDir;
    if (initialDir !== tree.projectDir) {
      tree.setProjectDir(initialDir);
    }
    void useProjectTreeStore.getState().refresh();

    // projectDir 变化时同步 + 刷新。
    // 用 (state, prevState) 形式订阅，手动比较 projectDir，避免依赖 selector 重载差异。
    const unsubscribeDir = useScriptStore.subscribe((state, prevState) => {
      if (state.projectDir === prevState.projectDir) return;
      const next = useProjectTreeStore.getState();
      // 若树端已经指向同一目录（例如 ScriptWorkbench hydrate 提前 setProjectDir），
      // 跳过重复刷新，避免双加载。
      if (next.projectDir === state.projectDir) return;
      next.setProjectDir(state.projectDir);
      void next.refresh();
    });

    // 文件树增删 -> 刷新。
    const unsubscribeTree =
      window.electronAPI?.onFileTreeChanged?.(() => {
        void useProjectTreeStore.getState().refresh();
      }) ?? (() => {});

    return () => {
      unsubscribeDir();
      unsubscribeTree();
    };
  }, []);
}
