import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { ReactNode } from 'react';
import type { FileEntry } from '../../lib/electron-api';
import { useProjectTreeStore } from '../../store/project-tree';
import { Button, EmptyState, PanelHeader } from '../../ui';
import { DirectoryTree, type DirectoryTreeEditing } from './DirectoryTree';
import { claimDirectoryTreeMenu } from './directory-tree-menu';
import {
  buildRelativePath,
  getParentDirectory,
  getProjectName,
  reconcileExpandedDirectories,
  revealPathInExpandedDirectories,
} from './directory-tree-helpers';
import styles from './DirectoryTreePanel.module.css';

export interface DirectoryTreePanelProps {
  projectDir: string | null;
  fileEntries: FileEntry[];
  openedFile?: string | null;
  onSelectProjectDir?: () => void;
  onOpenFile?: (file: string) => void;
  onSelectFile?: (file: string) => void;
  // 展示逻辑可定制点
  panelTitle?: string;
  renderFileIcon?: (entry: FileEntry, relativePath: string) => ReactNode;
  renderFileMeta?: (entry: FileEntry, relativePath: string) => ReactNode;
  isFileOpenable?: (entry: FileEntry, relativePath: string) => boolean;
  filterEntry?: (entry: FileEntry, relativePath: string) => boolean;
  dragDataType?: string;
  /** 项目根与树之间插入的额外内容（如脚本工作台的 全部/资源 切换） */
  headerSlot?: ReactNode;
  /** 用内置已接线的 DirectoryTree 做进一步包装（如脚本工作台套一层 Tabs 切换全部/资源）。
   *  优先级高于 bodySlot。 */
  renderBody?: (tree: ReactNode) => ReactNode;
  /** 覆盖默认树体（如脚本工作台的资源视图）；不传则渲染内置 DirectoryTree */
  bodySlot?: ReactNode;
  emptyState?: { title: string; description: string; actionLabel?: string };
  enableCrud?: boolean;
  /** CRUD 完成后的回调（默认刷新 useProjectTreeStore） */
  onAfterCrud?: () => void;
  /** 重命名成功后通知（调用方可据此迁移以旧路径为键的状态，如已打开文件） */
  onPathRenamed?: (oldRelative: string, newRelative: string) => void;
  /** 删除成功后通知 */
  onPathDeleted?: (relativePath: string) => void;
}

export function DirectoryTreePanel({
  projectDir,
  fileEntries,
  openedFile,
  onSelectProjectDir,
  onOpenFile,
  onSelectFile,
  panelTitle = '工作文件',
  renderFileIcon,
  renderFileMeta,
  isFileOpenable,
  filterEntry,
  dragDataType,
  headerSlot,
  renderBody,
  bodySlot,
  emptyState,
  enableCrud = false,
  onAfterCrud,
  onPathRenamed,
  onPathDeleted,
}: DirectoryTreePanelProps) {
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [expandedDirectories, setExpandedDirectories] = useState<Record<string, boolean>>(() =>
    reconcileExpandedDirectories(fileEntries, {}),
  );
  const [editing, setEditing] = useState<DirectoryTreeEditing | null>(null);

  useEffect(() => {
    setExpandedDirectories((previous) => reconcileExpandedDirectories(fileEntries, previous));
  }, [fileEntries]);

  useEffect(() => {
    setExpandedDirectories((previous) => revealPathInExpandedDirectories(previous, openedFile ?? null));
  }, [openedFile]);

  useEffect(() => {
    if (!openedFile || !treeRef.current) {
      return;
    }
    const selector = `[data-file-path="${openedFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
    const rafId = window.requestAnimationFrame(() => {
      const target = treeRef.current?.querySelector<HTMLElement>(selector);
      target?.scrollIntoView({ block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [openedFile, expandedDirectories]);

  const handleToggleDirectory = useCallback((path: string) => {
    setExpandedDirectories((previous) => ({
      ...previous,
      [path]: !(previous[path] ?? false),
    }));
  }, []);

  const refreshTree = useCallback(() => {
    if (onAfterCrud) {
      onAfterCrud();
    } else {
      void useProjectTreeStore.getState().refresh();
    }
  }, [onAfterCrud]);

  const handleCommitEdit = useCallback(
    async (kind: 'rename' | 'new-folder', relativePath: string, newName: string) => {
      setEditing(null);
      if (!projectDir || !newName) return;
      try {
        if (kind === 'rename') {
          const parent = getParentDirectory(relativePath);
          const newRelative = buildRelativePath(parent, newName);
          const res = await window.electronAPI.renamePath({
            projectDir,
            oldRelative: relativePath,
            newRelative,
          });
          if (!res.ok) {
            window.alert(`重命名失败：${res.message ?? res.code}`);
            return;
          }
          onPathRenamed?.(relativePath, newRelative);
        } else {
          const newRelative = buildRelativePath(relativePath, newName);
          const res = await window.electronAPI.createDirectory({ projectDir, relativePath: newRelative });
          if (!res.ok) {
            window.alert(`新建文件夹失败：${res.message ?? res.code}`);
            return;
          }
          // 展开父目录以显示新建项
          setExpandedDirectories((prev) => ({ ...prev, [relativePath]: true }));
        }
        refreshTree();
      } catch (error) {
        window.alert(`操作失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [projectDir, refreshTree],
  );

  const handleMenuAction = useCallback(
    (event: { action: string; relativePath: string; type: 'file' | 'directory' }) => {
      if (!projectDir) return;
      if (event.action === 'create-directory') {
        // 确保目标目录展开，行内输入框才能显示
        setExpandedDirectories((prev) => ({ ...prev, [event.relativePath]: true }));
        setEditing({ kind: 'new-folder', relativePath: event.relativePath });
        return;
      }
      if (event.action === 'rename') {
        setEditing({ kind: 'rename', relativePath: event.relativePath });
        return;
      }
      if (event.action === 'delete') {
        const label = event.type === 'directory' ? '文件夹及其所有内容' : '文件';
        if (!window.confirm(`确定删除该${label}？此操作不可撤销。\n${event.relativePath}`)) return;
        void (async () => {
          try {
            const res = await window.electronAPI.deletePath({
              projectDir,
              relativePath: event.relativePath,
              recursive: event.type === 'directory',
            });
            if (!res.ok) {
              window.alert(`删除失败：${res.message ?? res.code}`);
              return;
            }
            onPathDeleted?.(event.relativePath);
            refreshTree();
          } catch (error) {
            window.alert(`删除失败：${error instanceof Error ? error.message : String(error)}`);
          }
        })();
      }
    },
    [projectDir, refreshTree],
  );

  const handleContextMenu = useCallback(
    (_entry: FileEntry | null, relativePath: string, type: 'file' | 'directory') => {
      if (!projectDir || !window.electronAPI?.showDirectoryTreeContextMenu) return;
      // 认领本次菜单，动作回传时只由本 panel 处理
      claimDirectoryTreeMenu((event) => handleMenuAction({ ...event, type }));
      void window.electronAPI.showDirectoryTreeContextMenu({ relativePath, type, projectDir });
    },
    [projectDir, handleMenuAction],
  );

  const empty = emptyState ?? {
    title: '尚未选择工作目录',
    description: '选择项目目录后，这里会显示其中的文件结构。',
    actionLabel: '选择工作目录',
  };

  return (
    <aside className={styles.panel}>
      <div className={styles.header}>
        <PanelHeader
          title={panelTitle}
          actions={
            onSelectProjectDir ? (
              <Button.Ghost size="sm" onClick={onSelectProjectDir}>
                更换目录
              </Button.Ghost>
            ) : undefined
          }
        />
      </div>

      {projectDir ? (
        <>
          <div className={styles.projectRoot} title={projectDir}>
            <span className={styles.rootIcon} aria-hidden="true">
              <FolderOpen size={14} strokeWidth={1.8} />
            </span>
            <span className={styles.rootName}>{getProjectName(projectDir)}</span>
          </div>

          {headerSlot}

          {(() => {
            const tree = (
              <DirectoryTree
                fileEntries={fileEntries}
                projectDir={projectDir}
                expandedDirectories={expandedDirectories}
                openedFile={openedFile}
                onToggleDirectory={handleToggleDirectory}
                onOpenFile={onOpenFile}
                onSelectFile={onSelectFile}
                renderFileIcon={renderFileIcon}
                renderFileMeta={renderFileMeta}
                isFileOpenable={isFileOpenable}
                filterEntry={filterEntry}
                dragDataType={dragDataType}
                enableCrud={enableCrud}
                onContextMenu={enableCrud ? handleContextMenu : undefined}
                editing={editing}
                onCommitEdit={handleCommitEdit}
                onCancelEdit={() => setEditing(null)}
                treeRef={treeRef}
              />
            );
            if (renderBody) return renderBody(tree);
            return bodySlot ?? tree;
          })()}
        </>
      ) : (
        <div className={styles.empty}>
          <EmptyState
            title={empty.title}
            description={empty.description}
            actions={
              onSelectProjectDir && empty.actionLabel ? (
                <Button variant="primary" size="sm" onClick={onSelectProjectDir}>
                  {empty.actionLabel}
                </Button>
              ) : undefined
            }
          />
        </div>
      )}
    </aside>
  );
}
