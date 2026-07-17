import { create } from 'zustand';
import type { FileEntry } from '../lib/electron-api';

/**
 * 项目目录树共享数据层。
 *
 * 旧实现里 fileEntries 存在 useScriptStore，由 ScriptWorkbench 加载并监听
 * file-tree-changed 刷新。为了在「视频编辑器 / 资产 / 发布」等 tab 复用同一份目录
 * 结构数据，把 fileEntries 抽到这个独立 store，加载与刷新统一由
 * {@link useProjectTreeSync} 在 App 层接管（订阅 script store 的 projectDir 变化 +
 * onFileTreeChanged），各 tab 只读不写。
 *
 * projectDir 仍以 useScriptStore.projectDir 为权威来源（App 与 ScriptWorkbench 都会
 * 更新它，且持久化在共享 localStorage key），本 store 只做镜像 + 加载，避免引入第二个
 * 项目目录真相源。
 */
interface ProjectTreeState {
  /** 当前镜像的项目目录（来自 script store） */
  projectDir: string | null;
  /** 目录树条目（readDirectory 返回的递归结构，深度 ≤ 3） */
  fileEntries: FileEntry[];
  /** 是否正在加载 */
  isLoading: boolean;
  /** 最近一次加载错误（null 表示无错误） */
  error: string | null;
  setProjectDir: (dir: string | null) => void;
  setFileEntries: (entries: FileEntry[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  /**
   * 重新读取 projectDir 下的目录树并写入 fileEntries。
   * projectDir 为空时清空。返回读取到的 entries（便于调用方做派生判断，例如工作区
   * 文件存在性检查）。
   */
  refresh: () => Promise<FileEntry[]>;
}

export const useProjectTreeStore = create<ProjectTreeState>((set, get) => ({
  projectDir: null,
  fileEntries: [],
  isLoading: false,
  error: null,

  setProjectDir: (dir) => set({ projectDir: dir }),
  setFileEntries: (entries) => set({ fileEntries: entries }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),

  refresh: async () => {
    const { projectDir } = get();
    if (!projectDir || typeof window === 'undefined' || !window.electronAPI?.readDirectory) {
      set({ fileEntries: [], isLoading: false, error: null });
      return [];
    }

    set({ isLoading: true, error: null });
    try {
      const entries = await window.electronAPI.readDirectory(projectDir);
      set({ fileEntries: entries, isLoading: false, error: null });
      return entries;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ isLoading: false, error: message });
      return [];
    }
  },
}));
