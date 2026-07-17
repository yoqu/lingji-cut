import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import type { FileEntry } from '../../lib/electron-api';
import {
  buildRelativePath,
  defaultGetDirectoryIcon,
  defaultGetFileIcon,
  defaultIsFileOpenable,
  getIndentStyle,
} from './directory-tree-helpers';
import styles from './DirectoryTreePanel.module.css';

/** 行内编辑态：重命名某节点，或在某目录下新建文件夹 */
export interface DirectoryTreeEditing {
  kind: 'rename' | 'new-folder';
  /** rename: 被重命名节点的相对路径；new-folder: 目标父目录的相对路径（根目录为 ''） */
  relativePath: string;
}

export interface DirectoryTreeProps {
  fileEntries: FileEntry[];
  projectDir: string | null;
  expandedDirectories: Record<string, boolean>;
  openedFile?: string | null;
  onToggleDirectory: (path: string) => void;
  onOpenFile?: (file: string) => void;
  onSelectFile?: (file: string) => void;
  // 展示逻辑可定制点
  renderFileIcon?: (entry: FileEntry, relativePath: string) => ReactNode;
  renderFileMeta?: (entry: FileEntry, relativePath: string) => ReactNode;
  isFileOpenable?: (entry: FileEntry, relativePath: string) => boolean;
  filterEntry?: (entry: FileEntry, relativePath: string) => boolean;
  dragDataType?: string;
  // CRUD
  enableCrud?: boolean;
  onContextMenu?: (entry: FileEntry | null, relativePath: string, type: 'file' | 'directory') => void;
  editing?: DirectoryTreeEditing | null;
  onCommitEdit?: (
    kind: 'rename' | 'new-folder',
    relativePath: string,
    newName: string,
  ) => void;
  onCancelEdit?: () => void;
  treeRef?: RefObject<HTMLDivElement | null>;
}

interface TreeNodeProps extends Omit<DirectoryTreeProps, 'fileEntries' | 'treeRef'> {
  entry: FileEntry;
  pathPrefix: string;
  depth: number;
}

function InlineEditInput({
  defaultValue,
  onCommit,
  onCancel,
}: {
  defaultValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className={styles.editInput}
      defaultValue={defaultValue}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit((e.target as HTMLInputElement).value.trim());
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={(e) => {
        const value = e.target.value.trim();
        if (value && value !== defaultValue) {
          onCommit(value);
        } else {
          onCancel();
        }
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

function TreeNode({
  entry,
  pathPrefix,
  depth,
  projectDir,
  expandedDirectories,
  openedFile,
  onToggleDirectory,
  onOpenFile,
  onSelectFile,
  renderFileIcon,
  renderFileMeta,
  isFileOpenable,
  filterEntry,
  dragDataType,
  enableCrud,
  onContextMenu,
  editing,
  onCommitEdit,
  onCancelEdit,
}: TreeNodeProps) {
  const relativePath = buildRelativePath(pathPrefix, entry.name);
  const openableFn = isFileOpenable ?? ((e) => defaultIsFileOpenable(buildRelativePath(pathPrefix, e.name)));

  if (entry.type === 'directory') {
    const expanded = expandedDirectories[relativePath] ?? false;
    const isRenaming = editing?.kind === 'rename' && editing.relativePath === relativePath;
    const isCreatingChild = editing?.kind === 'new-folder' && editing.relativePath === relativePath && expanded;

    const visibleChildren = (entry.children ?? []).filter((child) => {
      if (!filterEntry) return true;
      return filterEntry(child, buildRelativePath(relativePath, child.name));
    });

    return (
      <div className={styles.treeBranch}>
        <button
          type="button"
          role="treeitem"
          aria-expanded={expanded}
          className={`${styles.treeRow} ${styles.treeRowDirectory}`}
          style={getIndentStyle(depth)}
          onClick={() => onToggleDirectory(relativePath)}
          onContextMenu={
            enableCrud
              ? (e) => {
                  e.preventDefault();
                  onContextMenu?.(entry, relativePath, 'directory');
                }
              : undefined
          }
          title={relativePath}
          data-tree-path={relativePath}
        >
          <span className={styles.chevronSlot} aria-hidden="true">
            {expanded ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}
          </span>
          <span className={styles.iconSlot} aria-hidden="true">
            {defaultGetDirectoryIcon(expanded)}
          </span>
          {isRenaming ? (
            <InlineEditInput
              defaultValue={entry.name}
              onCommit={(name) => onCommitEdit?.('rename', relativePath, name)}
              onCancel={() => onCancelEdit?.()}
            />
          ) : (
            <span className={styles.treeLabel}>{entry.name}</span>
          )}
          <span className={styles.metaSlot} aria-hidden="true" />
        </button>

        {expanded ? (
          <>
            {isCreatingChild ? (
              <div className={styles.treeBranch} style={getIndentStyle(depth + 1)}>
                <div className={`${styles.treeRow} ${styles.treeRowDirectory}`} style={getIndentStyle(depth + 1)}>
                  <span className={styles.chevronSlot} aria-hidden="true" />
                  <span className={styles.iconSlot} aria-hidden="true">
                    {defaultGetDirectoryIcon(false)}
                  </span>
                  <InlineEditInput
                    defaultValue=""
                    onCommit={(name) => onCommitEdit?.('new-folder', relativePath, name)}
                    onCancel={() => onCancelEdit?.()}
                  />
                  <span className={styles.metaSlot} aria-hidden="true" />
                </div>
              </div>
            ) : null}
            {visibleChildren.map((child) => (
              <TreeNode
                key={`${relativePath}/${child.name}`}
                entry={child}
                pathPrefix={relativePath}
                depth={depth + 1}
                projectDir={projectDir}
                expandedDirectories={expandedDirectories}
                openedFile={openedFile}
                onToggleDirectory={onToggleDirectory}
                onOpenFile={onOpenFile}
                onSelectFile={onSelectFile}
                renderFileIcon={renderFileIcon}
                renderFileMeta={renderFileMeta}
                isFileOpenable={isFileOpenable}
                filterEntry={filterEntry}
                dragDataType={dragDataType}
                enableCrud={enableCrud}
                onContextMenu={onContextMenu}
                editing={editing}
                onCommitEdit={onCommitEdit}
                onCancelEdit={onCancelEdit}
              />
            ))}
          </>
        ) : null}
      </div>
    );
  }

  // 文件节点
  const active = openedFile === relativePath;
  const openable = openableFn(entry, relativePath);
  const isRenaming = editing?.kind === 'rename' && editing.relativePath === relativePath;
  const className = [
    styles.treeRow,
    styles.treeRowFile,
    active ? styles.treeRowActive : '',
    openable ? styles.treeRowInteractive : styles.treeRowDisabled,
  ]
    .filter(Boolean)
    .join(' ');

  const handleDragStart = (e: React.DragEvent) => {
    if (!openable) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData(dragDataType ?? 'application/x-directory-tree-file', relativePath);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={active}
      aria-disabled={!openable}
      disabled={!openable}
      className={className}
      style={getIndentStyle(depth)}
      onClick={() => {
        if (openable) onOpenFile?.(relativePath);
        onSelectFile?.(relativePath);
      }}
      onContextMenu={
        enableCrud
          ? (e) => {
              e.preventDefault();
              onContextMenu?.(entry, relativePath, 'file');
            }
          : undefined
      }
      title={relativePath}
      data-file-path={relativePath}
      draggable={openable}
      onDragStart={handleDragStart}
    >
      <span className={styles.chevronSlot} aria-hidden="true" />
      <span className={styles.iconSlot} aria-hidden="true">
        {renderFileIcon ? renderFileIcon(entry, relativePath) : defaultGetFileIcon(entry)}
      </span>
      {isRenaming ? (
        <InlineEditInput
          defaultValue={entry.name}
          onCommit={(name) => onCommitEdit?.('rename', relativePath, name)}
          onCancel={() => onCancelEdit?.()}
        />
      ) : (
        <span className={styles.treeLabel}>{entry.name}</span>
      )}
      <span className={styles.metaSlot} aria-hidden="true">
        {renderFileMeta ? renderFileMeta(entry, relativePath) : null}
      </span>
    </button>
  );
}

export function DirectoryTree({
  fileEntries,
  projectDir,
  expandedDirectories,
  openedFile,
  onToggleDirectory,
  onOpenFile,
  onSelectFile,
  renderFileIcon,
  renderFileMeta,
  isFileOpenable,
  filterEntry,
  dragDataType,
  enableCrud,
  onContextMenu,
  editing,
  onCommitEdit,
  onCancelEdit,
  treeRef,
}: DirectoryTreeProps) {
  const visibleEntries = fileEntries.filter((entry) => {
    if (!filterEntry) return true;
    return filterEntry(entry, entry.name);
  });

  return (
    <div className={styles.treeList} role="tree" aria-label="项目文件树" ref={treeRef}>
      {/* 根级新建文件夹（target 为项目根 ''） */}
      {editing?.kind === 'new-folder' && editing.relativePath === '' ? (
        <div className={styles.treeBranch}>
          <div className={`${styles.treeRow} ${styles.treeRowDirectory}`} style={getIndentStyle(0)}>
            <span className={styles.chevronSlot} aria-hidden="true" />
            <span className={styles.iconSlot} aria-hidden="true">
              {defaultGetDirectoryIcon(false)}
            </span>
            <InlineEditInput
              defaultValue=""
              onCommit={(name) => onCommitEdit?.('new-folder', '', name)}
              onCancel={() => onCancelEdit?.()}
            />
            <span className={styles.metaSlot} aria-hidden="true" />
          </div>
        </div>
      ) : null}
      {visibleEntries.map((entry) => (
        <TreeNode
          key={entry.name}
          entry={entry}
          pathPrefix=""
          depth={0}
          projectDir={projectDir}
          expandedDirectories={expandedDirectories}
          openedFile={openedFile}
          onToggleDirectory={onToggleDirectory}
          onOpenFile={onOpenFile}
          onSelectFile={onSelectFile}
          renderFileIcon={renderFileIcon}
          renderFileMeta={renderFileMeta}
          isFileOpenable={isFileOpenable}
          filterEntry={filterEntry}
          dragDataType={dragDataType}
          enableCrud={enableCrud}
          onContextMenu={onContextMenu}
          editing={editing}
          onCommitEdit={onCommitEdit}
          onCancelEdit={onCancelEdit}
        />
      ))}
    </div>
  );
}

// 重新导出以便外部（脚本包装层）复用纯工具函数
export {
  buildRelativePath,
  defaultIsFileOpenable,
  defaultGetFileIcon,
  defaultGetDirectoryIcon,
} from './directory-tree-helpers';
