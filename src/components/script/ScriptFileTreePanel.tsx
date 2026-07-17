import type { ReactNode } from 'react';
import type { FileEntry } from '../../lib/electron-api';
import { isVideoImportPreviewFile } from '../../lib/video-import-preview';
import { useScriptStore } from '../../store/script';
import { useProjectTreeStore } from '../../store/project-tree';
import { DirectoryTreePanel } from '../directory-tree/DirectoryTreePanel';
import { FileTreeTabs } from './FileTreeTabs';
import { ScriptResourceView } from './ScriptResourceView';
import treeStyles from '../directory-tree/DirectoryTreePanel.module.css';

interface ScriptFileTreePanelProps {
  projectDir: string | null;
  fileEntries: FileEntry[];
  openedFile: string | null;
  fileDirtyMap: Record<string, boolean>;
  fileConflictMap: Record<string, boolean>;
  onSelectProjectDir: () => void;
  onOpenFile: (file: string) => void;
}

/**
 * 把以旧路径为键的值迁移到新路径（文件重命名 / 目录重命名）。
 * - key === oldRelative -> newRelative
 * - key 以 `${oldRelative}/` 开头 -> `${newRelative}/...`
 * - 否则保持不变
 */
function remapKey(key: string, oldRelative: string, newRelative: string): string {
  if (key === oldRelative) return newRelative;
  const prefix = `${oldRelative}/`;
  if (key.startsWith(prefix)) return `${newRelative}/${key.slice(prefix.length)}`;
  return key;
}

function remapBooleanMap(
  map: Record<string, boolean>,
  oldRelative: string,
  newRelative: string,
): Record<string, boolean> {
  let changed = false;
  const next: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k === oldRelative || k.startsWith(`${oldRelative}/`)) {
      next[remapKey(k, oldRelative, newRelative)] = v;
      changed = true;
    } else {
      next[k] = v;
    }
  }
  return changed ? next : map;
}

function remapStringMap(
  map: Record<string, string>,
  oldRelative: string,
  newRelative: string,
): Record<string, string> {
  let changed = false;
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k === oldRelative || k.startsWith(`${oldRelative}/`)) {
      next[remapKey(k, oldRelative, newRelative)] = v;
      changed = true;
    } else {
      next[k] = v;
    }
  }
  return changed ? next : map;
}

function dropKeysMatching(
  map: Record<string, unknown>,
  relativePath: string,
): { next: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k === relativePath || k.startsWith(`${relativePath}/`)) {
      changed = true;
      continue;
    }
    next[k] = v;
  }
  return { next, changed };
}

export function ScriptFileTreePanel({
  projectDir,
  fileEntries,
  openedFile,
  fileDirtyMap,
  fileConflictMap,
  onSelectProjectDir,
  onOpenFile,
}: ScriptFileTreePanelProps) {
  const fileTreeView = useScriptStore((s) => s.fileTreeView);
  const setFileTreeView = useScriptStore((s) => s.setFileTreeView);

  const renderFileMeta = (entry: FileEntry, relativePath: string): ReactNode => {
    const previewFile = isVideoImportPreviewFile(relativePath);
    const dirty = Boolean(fileDirtyMap[relativePath]);
    const conflict = Boolean(fileConflictMap[relativePath]);
    if (!previewFile && !dirty && !conflict) return null;
    return (
      <>
        {previewFile ? <span style={{ fontSize: 10, opacity: 0.7 }}>预览</span> : null}
        {dirty ? <span className={treeStyles.dirtyDot} /> : null}
        {conflict ? <span className={treeStyles.conflictMark}>⚠</span> : null}
      </>
    );
  };

  /** 重命名后迁移 script store 中以旧路径为键的状态 */
  const handlePathRenamed = (oldRelative: string, newRelative: string) => {
    const st = useScriptStore.getState();
    const newOpened = st.openedFile
      ? remapKey(st.openedFile, oldRelative, newRelative)
      : st.openedFile;
    useScriptStore.setState({
      openedFile: newOpened,
      fileDirtyMap: remapBooleanMap(st.fileDirtyMap, oldRelative, newRelative),
      fileConflictMap: remapBooleanMap(st.fileConflictMap, oldRelative, newRelative),
      extraFileContents: remapStringMap(st.extraFileContents, oldRelative, newRelative),
      stashedContent: remapStringMap(st.stashedContent, oldRelative, newRelative),
    });
    void useProjectTreeStore.getState().refresh();
  };

  /** 删除后清理 script store 中以该路径为键的状态 */
  const handlePathDeleted = (relativePath: string) => {
    const st = useScriptStore.getState();
    const dirty = dropKeysMatching(st.fileDirtyMap, relativePath);
    const conflict = dropKeysMatching(st.fileConflictMap, relativePath);
    const extra = dropKeysMatching(st.extraFileContents, relativePath);
    const stash = dropKeysMatching(st.stashedContent, relativePath);
    const openedMatches =
      st.openedFile === relativePath || st.openedFile?.startsWith(`${relativePath}/`);
    useScriptStore.setState({
      openedFile: openedMatches ? null : st.openedFile,
      fileDirtyMap: dirty.next as Record<string, boolean>,
      fileConflictMap: conflict.next as Record<string, boolean>,
      extraFileContents: extra.next as Record<string, string>,
      stashedContent: stash.next as Record<string, string>,
    });
    void useProjectTreeStore.getState().refresh();
  };

  return (
    <DirectoryTreePanel
      projectDir={projectDir}
      fileEntries={fileEntries}
      openedFile={openedFile}
      onSelectProjectDir={onSelectProjectDir}
      onOpenFile={onOpenFile}
      panelTitle="工作文件"
      renderFileMeta={renderFileMeta}
      enableCrud
      onAfterCrud={() => void useProjectTreeStore.getState().refresh()}
      onPathRenamed={handlePathRenamed}
      onPathDeleted={handlePathDeleted}
      renderBody={(tree) => (
        <FileTreeTabs
          value={fileTreeView}
          onValueChange={setFileTreeView}
          allSlot={tree}
          resourcesSlot={
            <ScriptResourceView
              projectDir={projectDir}
              fileEntries={fileEntries}
              openedFile={openedFile}
              fileDirtyMap={fileDirtyMap}
              fileConflictMap={fileConflictMap}
              onOpenFile={onOpenFile}
            />
          }
        />
      )}
    />
  );
}
