import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FilePenLine } from 'lucide-react';
import { structuredPatch } from 'diff';
import { RollingNumber } from './RollingNumber';
import styles from './AgentTranscript.module.css';

export interface FileChangedBlockData {
  type: 'file_changed';
  path: string;
  before: string | null;
  after: string;
  diff?: string;
  operation?: 'edit' | 'create' | 'delete';
}

interface DiffLine {
  kind: 'same' | 'add' | 'remove';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

function fileActionLabel(file: FileChangedBlockData): string {
  if (file.operation === 'create') return '新增';
  if (file.operation === 'delete') return '删除';
  return '编辑';
}

function splitTextLines(text: string): string[] {
  if (!text) return [];
  const withoutTerminalNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  return withoutTerminalNewline.split('\n');
}

export function changedLineCount(file: FileChangedBlockData): { added: number; removed: number } {
  const fromDiff = file.diff ? diffLineCount(file.diff) : null;
  if (fromDiff) return fromDiff;

  if (file.before === null) {
    return { added: splitTextLines(file.after).length, removed: 0 };
  }

  // 走真正的行级 LCS，避免按下标对位时"开头加一行 → 后续全部错位标 -+"。
  return countFromStructuredPatch(file.path, file.before, file.after);
}

function countFromStructuredPatch(path: string, before: string, after: string): { added: number; removed: number } {
  const patch = structuredPatch(path, path, before, after, '', '', { context: 0 });
  let added = 0;
  let removed = 0;
  for (const hunk of patch.hunks) {
    for (const raw of hunk.lines) {
      if (raw.startsWith('\\')) continue;
      if (raw.startsWith('+')) added += 1;
      else if (raw.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}

function diffLineCount(diff: string): { added: number; removed: number } | null {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    if (line.startsWith('-')) removed += 1;
  }
  return added || removed ? { added, removed } : null;
}

function simpleDiff(file: FileChangedBlockData): DiffLine[] {
  if (file.diff) {
    const parsed = parseUnifiedDiff(file.diff);
    if (parsed.length > 0) return parsed.slice(0, 120);
  }

  // before/after 直接拿到时也走 structuredPatch：和 tool-call-descriptor 那条路径一致，
  // 避免"开头插一行后续全错位"的视觉灾难。
  if (file.before === null) {
    return splitTextLines(file.after).map((text, index) => ({
      kind: 'add' as const,
      oldLine: null,
      newLine: index + 1,
      text,
    })).slice(0, 80);
  }
  const patch = structuredPatch(file.path, file.path, file.before, file.after, '', '', { context: 3 });
  const lines: DiffLine[] = [];
  for (const hunk of patch.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const raw of hunk.lines) {
      if (raw.startsWith('\\')) continue;
      const marker = raw[0];
      const text = raw.slice(1);
      if (marker === '+') {
        lines.push({ kind: 'add', oldLine: null, newLine, text });
        newLine += 1;
      } else if (marker === '-') {
        lines.push({ kind: 'remove', oldLine, newLine: null, text });
        oldLine += 1;
      } else if (marker === ' ') {
        lines.push({ kind: 'same', oldLine, newLine, text });
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return lines.slice(0, 80);
}

function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (rawLine.startsWith('+++') || rawLine.startsWith('---') || rawLine.startsWith('diff ')) {
      continue;
    }
    if (!rawLine) continue;

    const marker = rawLine[0];
    const text = rawLine.slice(1);
    if (marker === '+') {
      lines.push({ kind: 'add', oldLine: null, newLine: newLine || null, text });
      if (newLine) newLine += 1;
      continue;
    }
    if (marker === '-') {
      lines.push({ kind: 'remove', oldLine: oldLine || null, newLine: null, text });
      if (oldLine) oldLine += 1;
      continue;
    }
    if (marker === ' ') {
      lines.push({ kind: 'same', oldLine: oldLine || null, newLine: newLine || null, text });
      if (oldLine) oldLine += 1;
      if (newLine) newLine += 1;
    }
  }

  return lines;
}

function DiffPreview({ file }: { file: FileChangedBlockData }) {
  const diff = useMemo(() => simpleDiff(file), [file]);

  return (
    <div className={styles.diffCard}>
      {diff.length === 0 ? (
        <div className={styles.emptyDiff}>文件内容无可展示差异</div>
      ) : (
        <table className={styles.diffTable}>
          <tbody>
            {diff.map((line, index) => {
              const isAdd = line.kind === 'add';
              const isRemove = line.kind === 'remove';
              return (
                <tr
                  key={`${line.kind}-${line.oldLine ?? line.newLine ?? index}-${index}`}
                  className={isAdd ? styles.diffRowAdd : isRemove ? styles.diffRowRemove : ''}
                >
                  <td
                    className={`${styles.lineNo} ${
                      isAdd ? styles.lineNoAdd : isRemove ? styles.lineNoRemove : ''
                    }`}
                  >
                    {line.oldLine ?? line.newLine ?? ''}
                  </td>
                  <td className={styles.lineCode}>{line.text || ' '}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FileSummaryRow({ file }: { file: FileChangedBlockData }) {
  const [expanded, setExpanded] = useState(false);
  const count = changedLineCount(file);

  return (
    <li className={styles.fileSummaryItem}>
      <button
        type="button"
        className={styles.fileSummaryButton}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className={styles.fileSummaryAction}>{fileActionLabel(file)}</span>
        <span className={styles.fileSummaryPath} title={file.path}>{file.path}</span>
        {count.added > 0 ? (
          <span className={styles.plus}>+<RollingNumber value={count.added} prefix="+" /></span>
        ) : null}
        {count.removed > 0 ? (
          <span className={styles.minus}>-<RollingNumber value={count.removed} prefix="-" /></span>
        ) : null}
        <span className={styles.fileSummaryChevron} aria-hidden>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      {expanded ? (
        <div className={styles.fileSummaryDetail}>
          <DiffPreview file={file} />
        </div>
      ) : null}
    </li>
  );
}

export function FileChangedBlock({ files }: { files: FileChangedBlockData[] }) {
  // 默认收起：用户大多数时候只关心"改了几行"，不需要默认就把 diff 全展示。
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;
  const operations = new Set(files.map((file) => file.operation ?? 'edit'));
  const actionLabel =
    operations.size === 1 && operations.has('create')
      ? '新增了'
      : operations.size === 1 && operations.has('delete')
        ? '删除了'
        : operations.size === 1 && operations.has('edit')
          ? '编辑了'
          : '变更了';

  const total = files.reduce(
    (acc, file) => {
      const count = changedLineCount(file);
      return { added: acc.added + count.added, removed: acc.removed + count.removed };
    },
    { added: 0, removed: 0 },
  );

  return (
    <div className={styles.event}>
      <button
        type="button"
        className={`${styles.eventHeader} ${styles.eventHeaderInteractive}`}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className={styles.eventIcon}>
          <FilePenLine size={15} strokeWidth={1.8} />
        </span>
        <span className={styles.eventLabel}>{actionLabel} {files.length} 个文件</span>
        {total.added > 0 ? (
          <span className={styles.plus}>+<RollingNumber value={total.added} prefix="+" /></span>
        ) : null}
        {total.removed > 0 ? (
          <span className={styles.minus}>-<RollingNumber value={total.removed} prefix="-" /></span>
        ) : null}
        <span className={styles.eventChevron} aria-hidden>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      {expanded ? (
        <div className={styles.fileGroupBody}>
          <ul className={styles.fileSummaryList}>
            {files.map((file) => (
              <FileSummaryRow key={file.path} file={file} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
